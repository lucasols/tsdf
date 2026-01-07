export type FetchContext = {
  shouldAbort: () => boolean;
  getStartTime: () => number;
  signal: AbortSignal;
};

export type FetchType =
  | 'lowPriority'
  | 'mediumPriority'
  | 'highPriority'
  | 'realtimeUpdate';

export type RequestSchedulerEvents =
  | 'scheduled-fetch-started'
  | 'scheduled-rt-fetch-started'
  | 'medium-priority-fetch-started'
  | 'medium-priority-cancelled';

export type ScheduleFetchResults =
  | 'skipped'
  | 'started'
  | 'scheduled'
  | 'rt-scheduled'
  | 'triggered'
  | 'coalesced'
  | 'medium-scheduled';

// ============================================================================
// State Machine Types
// ============================================================================

type TimeoutId = ReturnType<typeof setTimeout>;

/** Primary scheduler phase - exactly one is active at a time */
type SchedulerPhase<T> =
  | { type: 'idle' }
  | {
      type: 'coalescing';
      timeoutId: TimeoutId;
      params: T;
      awaitCallbacks: (() => void)[];
    }
  | {
      type: 'fetching';
      fetchId: number;
      startTime: number;
      awaitCallbacks: (() => void)[];
      rtuCallback: (() => void) | null;
    };

/** Pending states that can coexist with any phase */
type PendingStates<T> = {
  scheduled: { params: T } | null;
  rtuDelayed: { timeoutId: TimeoutId; params: T } | null;
  mediumPriorityDelayed: { timeoutId: TimeoutId; params: T } | null;
  mutation: { id: number; onEnd: (() => void) | null } | null;
};

/** Timing data for throttling decisions */
type TimingState = {
  lastFetchStartTime: number;
  lastFetchDuration: number;
};

/** Abort tracking state */
type AbortState = {
  lastFetchId: number;
  lastMutationId: number;
  abortBoundary: number;
  controller: AbortController | null;
};

/** Complete scheduler state */
type SchedulerState<T> = {
  phase: SchedulerPhase<T>;
  pending: PendingStates<T>;
  timing: TimingState;
  abort: AbortState;
  lastFetchWasAborted: boolean;
};

// ============================================================================
// Options and Configuration
// ============================================================================

export type RequestSchedulerOptions<T> = {
  fetchFn: (fetchContext: FetchContext, params: T) => Promise<boolean>;
  on?: (event: RequestSchedulerEvents) => void;
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  mediumPriorityDelayMs?: number;
};

export type ScheduleFetchOptions = {
  mediumPriorityDelayMs?: number;
};

// ============================================================================
// ID Generation
// ============================================================================

let autoIncrementId = 0;
export function getAutoIncrementId(): number {
  return ++autoIncrementId;
}

// ============================================================================
// RequestScheduler Class
// ============================================================================

export class RequestScheduler<T> {
  private readonly fetchFn: (
    fetchContext: FetchContext,
    params: T,
  ) => Promise<boolean>;
  private readonly onEvent:
    | ((event: RequestSchedulerEvents) => void)
    | undefined;
  private readonly lowPriorityThrottleMs: number;
  private readonly baseCoalescingWindowMs: number;
  private readonly dynamicRealtimeThrottleMs:
    | ((lastFetchDuration: number) => number)
    | undefined;
  private readonly mediumPriorityDelayMs: number | undefined;

  private state: SchedulerState<T>;

  constructor(options: RequestSchedulerOptions<T>) {
    this.fetchFn = options.fetchFn;
    this.onEvent = options.on;
    this.lowPriorityThrottleMs = options.lowPriorityThrottleMs;
    this.baseCoalescingWindowMs = options.baseCoalescingWindowMs;
    this.dynamicRealtimeThrottleMs = options.dynamicRealtimeThrottleMs;
    this.mediumPriorityDelayMs = options.mediumPriorityDelayMs;

    this.state = this.createInitialState();
  }

  // ==========================================================================
  // State Factory
  // ==========================================================================

  private createInitialState(): SchedulerState<T> {
    return {
      phase: { type: 'idle' },
      pending: {
        scheduled: null,
        rtuDelayed: null,
        mediumPriorityDelayed: null,
        mutation: null,
      },
      timing: {
        lastFetchStartTime: 0,
        lastFetchDuration: 0,
      },
      abort: {
        lastFetchId: 0,
        lastMutationId: 0,
        abortBoundary: 0,
        controller: null,
      },
      lastFetchWasAborted: false,
    };
  }

  // ==========================================================================
  // Public Getters (maintain backward compatibility)
  // ==========================================================================

  get hasPendingFetch(): boolean {
    const { phase, pending } = this.state;
    return (
      phase.type !== 'idle'
      || pending.scheduled !== null
      || pending.rtuDelayed !== null
      || pending.mediumPriorityDelayed !== null
    );
  }

  get fetchIsInProgress(): boolean {
    return this.state.phase.type === 'fetching';
  }

  get mutationIsInProgress(): boolean {
    return this.state.pending.mutation !== null;
  }

  setLastFetchDuration(duration: number): void {
    this.state.timing.lastFetchDuration = duration;
  }

  setLastFetchStartTime(startTime: number): void {
    this.state.timing.lastFetchStartTime = startTime;
  }

  getFetchIsInProgress(): boolean {
    return this.state.phase.type === 'fetching';
  }

  // ==========================================================================
  // Core Public API
  // ==========================================================================

  scheduleFetch(
    fetchType: FetchType,
    params: T,
    options?: ScheduleFetchOptions,
  ): ScheduleFetchResults {
    const startTime = Date.now();

    // Handle medium priority scheduling
    if (fetchType === 'mediumPriority') {
      return this.handleMediumPriority(params, options?.mediumPriorityDelayMs);
    }

    // Handle realtime update scheduling
    if (this.dynamicRealtimeThrottleMs && fetchType === 'realtimeUpdate') {
      if (this.handleRealtimeUpdate(startTime, params)) {
        return 'rt-scheduled';
      }
    }

    // Check if we should skip (low priority throttling)
    if (this.shouldSkipFetch(fetchType, startTime)) {
      return 'skipped';
    }

    // Check if we should schedule (fetch/mutation in progress)
    if (this.shouldScheduleFetch(params)) return 'scheduled';

    // If coalescing, update params
    if (this.state.phase.type === 'coalescing') {
      this.state.phase.params = params;
      return 'coalesced';
    }

    // Start coalescing window
    this.transitionToCoalescing(params);
    return 'triggered';
  }

  async awaitFetch(
    params: T,
    options: { timeoutMs?: number } = {},
  ): Promise<boolean | 'timeout'> {
    const { timeoutMs = 30_000 } = options;

    this.scheduleFetch('highPriority', params);

    const fetchPromise = this.waitForCurrentFetch();

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs);
    });

    return Promise.race([fetchPromise, timeoutPromise]);
  }

  private async waitForCurrentFetch(): Promise<boolean> {
    // Wait for coalescing window to complete first
    if (this.state.phase.type === 'coalescing') {
      await new Promise<void>((resolve) => {
        if (this.state.phase.type === 'coalescing') {
          this.state.phase.awaitCallbacks.push(resolve);
        }
      });
    }

    // Then wait for the fetch to complete
    if (this.state.phase.type === 'fetching') {
      await new Promise<void>((resolve) => {
        if (this.state.phase.type === 'fetching') {
          this.state.phase.awaitCallbacks.push(resolve);
        }
      });
    }

    return this.state.lastFetchWasAborted;
  }

  startMutation(): () => boolean {
    const { phase, pending, abort } = this.state;

    // Set mutation state
    const mutationId = getAutoIncrementId();
    pending.mutation = { id: mutationId, onEnd: null };

    // Set abort boundary to current fetch id
    abort.abortBoundary = abort.lastFetchId;

    // Abort current fetch if in progress
    if (abort.controller) {
      abort.controller.abort();
      abort.controller = null;
    }

    // Clear coalescing phase (but not medium priority - it survives mutations)
    if (phase.type === 'coalescing') {
      clearTimeout(phase.timeoutId);
      this.state.phase = { type: 'idle' };
    } else if (phase.type === 'fetching') {
      // Clear fetching phase without calling callbacks (fetch was aborted)
      this.state.phase = { type: 'idle' };
    }

    return () => this.endMutation(mutationId);
  }

  reset(): void {
    const { phase, pending, abort } = this.state;

    // Clear all timeouts
    if (phase.type === 'coalescing') {
      clearTimeout(phase.timeoutId);
    }
    if (pending.rtuDelayed) {
      clearTimeout(pending.rtuDelayed.timeoutId);
    }
    if (pending.mediumPriorityDelayed) {
      clearTimeout(pending.mediumPriorityDelayed.timeoutId);
    }

    // Abort any in-progress fetch
    if (abort.controller) {
      abort.controller.abort();
    }

    // Reset to initial state
    this.state = this.createInitialState();
  }

  // ==========================================================================
  // Phase Transitions
  // ==========================================================================

  private transitionToCoalescing(params: T): void {
    this.assertPhase('idle', 'transitionToCoalescing');

    const timeoutId = setTimeout(() => {
      this.onCoalescingTimeout();
    }, this.baseCoalescingWindowMs);

    this.state.phase = {
      type: 'coalescing',
      timeoutId,
      params,
      awaitCallbacks: [],
    };
  }

  private onCoalescingTimeout(): void {
    const { phase, pending } = this.state;

    if (phase.type !== 'coalescing') return;

    const { params, awaitCallbacks } = phase;

    // Transition to idle first
    this.state.phase = { type: 'idle' };

    // Fire coalescing callbacks
    for (const cb of awaitCallbacks) {
      cb();
    }

    // If mutation in progress or scheduled fetch exists that should take priority
    if (pending.mutation !== null) {
      pending.scheduled = { params };
      return;
    }

    // Start the fetch
    void this.transitionToFetching(params, Date.now());
  }

  private async transitionToFetching(
    params: T,
    startTime: number,
  ): Promise<boolean> {
    this.assertPhase('idle', 'transitionToFetching');

    const fetchId = getAutoIncrementId();
    const abortController = new AbortController();

    // Update state atomically
    this.state.abort.lastFetchId = fetchId;
    this.state.abort.controller = abortController;
    this.state.lastFetchWasAborted = false;

    const prevFetchStartTime = this.state.timing.lastFetchStartTime;
    this.state.timing.lastFetchStartTime = startTime;

    this.state.phase = {
      type: 'fetching',
      fetchId,
      startTime,
      awaitCallbacks: [],
      rtuCallback: null,
    };

    // Clear RTU delayed if any (new fetch supersedes)
    this.clearRtuDelayed();

    // Cancel medium priority when fetch starts
    this.cancelMediumPriority();

    // Create shouldAbort function that checks current state
    const shouldAbort = function shouldAbort(
      this: RequestScheduler<T>,
    ): boolean {
      const { abort, pending } = this.state;
      const shouldAbortFetch =
        fetchId !== abort.lastFetchId
        || pending.mutation !== null
        || fetchId <= abort.abortBoundary;

      this.state.lastFetchWasAborted = shouldAbortFetch;

      if (shouldAbortFetch) {
        abortController.abort();
      }

      return shouldAbortFetch;
    }.bind(this);

    // Execute the fetch
    const success = await this.fetchFn(
      {
        shouldAbort,
        getStartTime: () => startTime,
        signal: abortController.signal,
      },
      params,
    );

    // Clear abort controller
    this.state.abort.controller = null;

    // Check if we're still the current fetch phase (phase may have changed during await)
    if (!this.isCurrentFetch(fetchId)) {
      // Fetch was superseded, restore previous timing
      this.state.timing.lastFetchStartTime = prevFetchStartTime;
      return false;
    }

    // Update timing on success
    if (success) {
      this.state.timing.lastFetchDuration = Date.now() - startTime;
    }

    // Get callbacks before clearing phase
    const { awaitCallbacks, rtuCallback } = this.state.phase;

    // Clear any pending RTU delayed (could have been scheduled during fetch)
    this.clearRtuDelayed();

    // Transition to idle
    this.state.phase = { type: 'idle' };

    // Fire callbacks
    for (const cb of awaitCallbacks) {
      cb();
    }

    if (rtuCallback) {
      rtuCallback();
    }

    // Flush any scheduled fetch
    this.flushScheduledFetch();

    return true;
  }

  // ==========================================================================
  // Mutation Handling
  // ==========================================================================

  private endMutation(mutationId: number): boolean {
    const { pending } = this.state;

    if (pending.mutation?.id !== mutationId) return false;

    const onEnd = pending.mutation.onEnd;
    pending.mutation = null;

    // Fire mutation end callback
    if (onEnd) {
      onEnd();
    }

    // Flush scheduled fetch
    this.flushScheduledFetch();

    return true;
  }

  // ==========================================================================
  // Scheduled Fetch Handling
  // ==========================================================================

  private flushScheduledFetch(): void {
    const { pending, phase } = this.state;

    if (!pending.scheduled) return;

    this.onEvent?.('scheduled-fetch-started');

    const { params } = pending.scheduled;
    pending.scheduled = null;

    // Clear any active coalescing window
    if (phase.type === 'coalescing') {
      clearTimeout(phase.timeoutId);
      this.state.phase = { type: 'idle' };
    }

    // Start coalescing window to allow subsequent calls to coalesce
    this.transitionToCoalescing(params);
  }

  // ==========================================================================
  // Low Priority Throttling
  // ==========================================================================

  private shouldSkipFetch(fetchType: FetchType, startTime: number): boolean {
    if (fetchType !== 'lowPriority') return false;

    const { phase, pending, timing } = this.state;

    // Skip if fetch/coalescing in progress or scheduled
    // Note: mutation check is handled by shouldScheduleFetch, not here
    if (
      phase.type === 'fetching'
      || phase.type === 'coalescing'
      || pending.scheduled !== null
    ) {
      return true;
    }

    // Skip if within throttle window
    if (timing.lastFetchStartTime) {
      const timeSinceLastFetch = startTime - timing.lastFetchStartTime;
      if (timeSinceLastFetch < this.lowPriorityThrottleMs) {
        return true;
      }
    }

    return false;
  }

  private shouldScheduleFetch(params: T): boolean {
    const { phase, pending } = this.state;

    if (phase.type === 'fetching' || pending.mutation !== null) {
      pending.scheduled = { params };
      return true;
    }

    return false;
  }

  // ==========================================================================
  // Realtime Update Handling
  // ==========================================================================

  private clearRtuDelayed(): void {
    const rtu = this.state.pending.rtuDelayed;
    if (rtu) {
      clearTimeout(rtu.timeoutId);
      this.state.pending.rtuDelayed = null;
    }
  }

  private handleRealtimeUpdate(startTime: number, params: T): boolean {
    const { timing, phase, pending } = this.state;

    if (
      !timing.lastFetchDuration
      || !timing.lastFetchStartTime
      || !this.dynamicRealtimeThrottleMs
    ) {
      return false;
    }

    // If RTU is already scheduled, just return true
    if (pending.rtuDelayed) return true;

    // If fetching, register callback for when fetch completes
    if (phase.type === 'fetching') {
      phase.rtuCallback = () => {
        this.scheduleDelayedRTU(Date.now(), params);
      };
      return true;
    }

    // If mutation in progress, register callback for when mutation ends
    if (pending.mutation !== null) {
      pending.mutation.onEnd = () => {
        const added = this.scheduleDelayedRTU(Date.now(), params);
        if (!added) {
          this.onEvent?.('scheduled-rt-fetch-started');
          this.scheduleFetch('highPriority', params);
        }
      };
      return true;
    }

    // Try to schedule delayed RTU
    return this.scheduleDelayedRTU(startTime, params);
  }

  private scheduleDelayedRTU(startTime: number, params: T): boolean {
    if (!this.dynamicRealtimeThrottleMs) return false;

    const { timing } = this.state;
    const timeSinceLastFetch =
      startTime - (timing.lastFetchStartTime + timing.lastFetchDuration);

    const minimumRealtimeInterval = this.dynamicRealtimeThrottleMs(
      timing.lastFetchDuration,
    );

    if (timeSinceLastFetch >= minimumRealtimeInterval) {
      return false;
    }

    const delay = minimumRealtimeInterval - timeSinceLastFetch;

    this.state.pending.rtuDelayed = {
      timeoutId: setTimeout(() => {
        this.state.pending.rtuDelayed = null;
        this.onEvent?.('scheduled-rt-fetch-started');
        this.scheduleFetch('highPriority', params);
      }, delay),
      params,
    };

    return true;
  }

  // ==========================================================================
  // Medium Priority Handling
  // ==========================================================================

  private handleMediumPriority(
    params: T,
    customDelayMs?: number,
  ): ScheduleFetchResults {
    const delayMs = customDelayMs ?? this.mediumPriorityDelayMs;

    if (delayMs === undefined) {
      throw new Error(
        '[tsdf] mediumPriorityDelayMs must be configured to use mediumPriority fetch type',
      );
    }

    // Cancel existing medium priority
    if (this.state.pending.mediumPriorityDelayed) {
      clearTimeout(this.state.pending.mediumPriorityDelayed.timeoutId);
    }

    this.state.pending.mediumPriorityDelayed = {
      timeoutId: setTimeout(() => {
        this.executeMediumPriorityFetch(params);
      }, delayMs),
      params,
    };

    return 'medium-scheduled';
  }

  private executeMediumPriorityFetch(params: T): void {
    this.state.pending.mediumPriorityDelayed = null;

    this.onEvent?.('medium-priority-fetch-started');

    const { phase, pending } = this.state;

    // If busy, schedule for later
    if (phase.type !== 'idle' || pending.mutation !== null) {
      pending.scheduled = { params };
      return;
    }

    // Behave like high priority
    this.scheduleFetch('highPriority', params);
  }

  private cancelMediumPriority(): void {
    if (this.state.pending.mediumPriorityDelayed) {
      clearTimeout(this.state.pending.mediumPriorityDelayed.timeoutId);
      this.state.pending.mediumPriorityDelayed = null;
      this.onEvent?.('medium-priority-cancelled');
    }
  }

  // ==========================================================================
  // State Checks
  // ==========================================================================

  /** Check if the given fetchId matches the current in-progress fetch */
  private isCurrentFetch(fetchId: number): boolean {
    const { phase } = this.state;
    return phase.type === 'fetching' && phase.fetchId === fetchId;
  }

  // ==========================================================================
  // Invariant Assertions
  // ==========================================================================

  private assertPhase(
    expected: SchedulerPhase<T>['type'],
    operation: string,
  ): void {
    if (this.state.phase.type !== expected) {
      throw new Error(
        `[tsdf] Invalid phase for ${operation}: expected '${expected}', got '${this.state.phase.type}'`,
      );
    }
  }
}
