export type FetchContext = {
  shouldAbort: () => boolean;
  getStartTime: () => number;
  signal: AbortSignal;
};

export type RequestSchedulerEvents =
  | 'scheduled-fetch-started'
  | 'scheduled-rt-fetch-started'
  | 'medium-priority-fetch-started'
  | 'medium-priority-cancelled'
  | 'batch-size-triggered';

export type ScheduleFetchResults =
  | 'skipped'
  | 'started'
  | 'scheduled'
  | 'rt-scheduled'
  | 'triggered'
  | 'coalesced'
  | 'medium-scheduled'
  | 'added-to-batch'
  | 'batch-triggered';

// ============================================================================
// State Machine Types
// ============================================================================

type TimeoutId = ReturnType<typeof setTimeout>;

export type FetchType =
  | 'lowPriority'
  | 'mediumPriority'
  | 'highPriority'
  | 'realtimeUpdate';

/** Per-request pending state for batch coalescing */
export type PendingRequest<T> = {
  payload: T;
  priority: FetchType;
  addedAt: number;
  awaitCallbacks: Array<(wasAborted: boolean) => void>;
};

/** Request with ID for batch fetching */
export type BatchRequest<T> = {
  requestId: string;
  payload: T;
};

/** Primary scheduler phase - exactly one is active at a time */
type SchedulerPhase<T> =
  | { type: 'idle' }
  | {
      type: 'coalescing';
      timeoutId: TimeoutId;
      pendingRequests: Map<string, PendingRequest<T>>;
    }
  | {
      type: 'fetching';
      fetchId: number;
      startTime: number;
      /** Requests being fetched with their await callbacks */
      fetchingRequests: Map<string, { awaitCallbacks: Array<(wasAborted: boolean) => void> }>;
      rtuCallback: (() => void) | null;
    };

/** Pending states that can coexist with any phase */
type PendingStates<T> = {
  /** Requests scheduled for after current fetch completes */
  scheduledRequests: Map<string, PendingRequest<T>>;
  rtuDelayed: { timeoutId: TimeoutId; requestId: string; payload: T } | null;
  mediumPriorityDelayed: { timeoutId: TimeoutId; requestId: string; payload: T } | null;
  /** Request IDs with active mutations (value = count of active mutations) */
  mutationsInProgress: Map<string, number>;
};

/** Timing data for throttling decisions */
type TimingState = {
  lastFetchStartTime: number;
  lastFetchDuration: number;
  /** Per-request timing for low priority throttling */
  lastFetchStartTimePerRequest: Map<string, number>;
};

/** Abort tracking state */
type AbortState = {
  lastFetchId: number;
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
  /** Per-request abort tracking */
  lastAbortedRequests: Set<string>;
};

// ============================================================================
// Options and Configuration
// ============================================================================

export type RequestSchedulerOptions<T> = {
  /** Fetch function receives array of requests (even for single request) */
  fetchFn: (
    requests: BatchRequest<T>[],
    fetchContext: FetchContext,
  ) => Promise<Map<string, boolean>>;
  on?: (event: RequestSchedulerEvents) => void;
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  mediumPriorityDelayMs?: number;
  /** Max batch size - triggers immediate fetch when reached */
  maxBatchSize?: number;
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
    requests: BatchRequest<T>[],
    fetchContext: FetchContext,
  ) => Promise<Map<string, boolean>>;
  private readonly onEvent:
    | ((event: RequestSchedulerEvents) => void)
    | undefined;
  private readonly lowPriorityThrottleMs: number;
  private readonly baseCoalescingWindowMs: number;
  private readonly dynamicRealtimeThrottleMs:
    | ((lastFetchDuration: number) => number)
    | undefined;
  private readonly mediumPriorityDelayMs: number | undefined;
  private readonly maxBatchSize: number | undefined;

  private state: SchedulerState<T>;

  constructor(options: RequestSchedulerOptions<T>) {
    this.fetchFn = options.fetchFn;
    this.onEvent = options.on;
    this.lowPriorityThrottleMs = options.lowPriorityThrottleMs;
    this.baseCoalescingWindowMs = options.baseCoalescingWindowMs;
    this.dynamicRealtimeThrottleMs = options.dynamicRealtimeThrottleMs;
    this.mediumPriorityDelayMs = options.mediumPriorityDelayMs;
    this.maxBatchSize = options.maxBatchSize;

    this.state = this.createInitialState();
  }

  // ==========================================================================
  // State Factory
  // ==========================================================================

  private createInitialState(): SchedulerState<T> {
    return {
      phase: { type: 'idle' },
      pending: {
        scheduledRequests: new Map(),
        rtuDelayed: null,
        mediumPriorityDelayed: null,
        mutationsInProgress: new Map(),
      },
      timing: {
        lastFetchStartTime: 0,
        lastFetchDuration: 0,
        lastFetchStartTimePerRequest: new Map(),
      },
      abort: {
        lastFetchId: 0,
        abortBoundary: 0,
        controller: null,
      },
      lastFetchWasAborted: false,
      lastAbortedRequests: new Set(),
    };
  }

  // ==========================================================================
  // Public Getters (maintain backward compatibility)
  // ==========================================================================

  get hasPendingFetch(): boolean {
    const { phase, pending } = this.state;
    return (
      phase.type !== 'idle'
      || pending.scheduledRequests.size > 0
      || pending.rtuDelayed !== null
      || pending.mediumPriorityDelayed !== null
    );
  }

  get fetchIsInProgress(): boolean {
    return this.state.phase.type === 'fetching';
  }

  get mutationIsInProgress(): boolean {
    // Check if any request has active mutations
    for (const count of this.state.pending.mutationsInProgress.values()) {
      if (count > 0) return true;
    }
    return false;
  }

  /** Check if a specific request has mutation in progress */
  isMutationInProgress(requestId: string): boolean {
    const count = this.state.pending.mutationsInProgress.get(requestId);
    return count !== undefined && count > 0;
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

  /** Get current batch size in coalescing window */
  getCurrentBatchSize(): number {
    const { phase } = this.state;
    if (phase.type === 'coalescing') {
      return phase.pendingRequests.size;
    }
    return 0;
  }

  // ==========================================================================
  // Core Public API
  // ==========================================================================

  scheduleFetch(
    requestId: string,
    fetchType: FetchType,
    payload: T,
    options?: ScheduleFetchOptions,
  ): ScheduleFetchResults {
    const startTime = Date.now();

    // Handle medium priority scheduling
    if (fetchType === 'mediumPriority') {
      return this.handleMediumPriority(requestId, payload, options?.mediumPriorityDelayMs);
    }

    // Handle realtime update scheduling
    if (this.dynamicRealtimeThrottleMs && fetchType === 'realtimeUpdate') {
      if (this.handleRealtimeUpdate(startTime, requestId, payload)) {
        return 'rt-scheduled';
      }
    }

    // Check if we should skip (low priority throttling) - must be checked BEFORE mutation
    if (this.shouldSkipFetch(requestId, fetchType, startTime)) {
      return 'skipped';
    }

    // Check if request is under mutation - schedule for after mutation
    if (this.state.pending.mutationsInProgress.has(requestId)) {
      this.addToScheduledRequests(requestId, payload, fetchType, startTime);
      return 'scheduled';
    }

    // If fetch in progress, check if it should be aborted
    if (this.state.phase.type === 'fetching') {
      const shouldAbortCurrentFetch = this.shouldCurrentFetchBeAborted();

      if (shouldAbortCurrentFetch) {
        // Force abort and transition to idle - new fetch can start immediately
        this.forceAbortCurrentFetch();
      } else {
        // Fetch is valid, schedule for after
        this.addToScheduledRequests(requestId, payload, fetchType, startTime);
        return 'scheduled';
      }
    }

    // If coalescing, add to batch
    if (this.state.phase.type === 'coalescing') {
      return this.addToCoalescingBatch(requestId, payload, fetchType, startTime);
    }

    // Start coalescing window with this request
    this.transitionToCoalescing(requestId, payload, fetchType, startTime);
    return 'triggered';
  }

  async awaitFetch(
    requestId: string,
    payload: T,
    options: { timeoutMs?: number } = {},
  ): Promise<boolean | 'timeout'> {
    const { timeoutMs = 30_000 } = options;

    this.scheduleFetch(requestId, 'highPriority', payload);

    const fetchPromise = this.waitForRequest(requestId);

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs);
    });

    return Promise.race([fetchPromise, timeoutPromise]);
  }

  private async waitForRequest(requestId: string): Promise<boolean> {
    const { phase } = this.state;

    // Check if request is in coalescing phase
    if (phase.type === 'coalescing') {
      const request = phase.pendingRequests.get(requestId);
      if (request) {
        await new Promise<void>((resolve) => {
          request.awaitCallbacks.push(() => resolve());
        });
      }
    }

    // Check if request is in fetching phase
    if (this.state.phase.type === 'fetching') {
      const fetchingRequest = this.state.phase.fetchingRequests.get(requestId);
      if (fetchingRequest) {
        await new Promise<void>((resolve) => {
          fetchingRequest.awaitCallbacks.push(() => resolve());
        });
      }
    }

    return this.state.lastAbortedRequests.has(requestId);
  }

  startMutation(requestId: string): () => boolean {
    const { phase, pending, abort } = this.state;

    // Increment mutation count for this request
    const currentCount = pending.mutationsInProgress.get(requestId) ?? 0;
    pending.mutationsInProgress.set(requestId, currentCount + 1);

    // Set abort boundary to current fetch id
    abort.abortBoundary = abort.lastFetchId;

    // If request is in coalescing phase, move to scheduled
    if (phase.type === 'coalescing') {
      const request = phase.pendingRequests.get(requestId);
      if (request) {
        phase.pendingRequests.delete(requestId);
        this.state.pending.scheduledRequests.set(requestId, request);
      }

      // If coalescing is now empty, clear it
      if (phase.pendingRequests.size === 0) {
        clearTimeout(phase.timeoutId);
        this.state.phase = { type: 'idle' };
      }
    }

    // If request is in fetching phase, mark for abort
    if (phase.type === 'fetching') {
      // Abort current fetch if this request is part of it
      if (phase.fetchingRequests.has(requestId) && abort.controller) {
        abort.controller.abort();
        abort.controller = null;
      }
    }

    return () => this.endMutation(requestId);
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

  private transitionToCoalescing(
    requestId: string,
    payload: T,
    priority: FetchType,
    addedAt: number,
  ): void {
    this.assertPhase('idle', 'transitionToCoalescing');

    const pendingRequests = new Map<string, PendingRequest<T>>();
    pendingRequests.set(requestId, {
      payload,
      priority,
      addedAt,
      awaitCallbacks: [],
    });

    const timeoutId = setTimeout(() => {
      this.onCoalescingTimeout();
    }, this.baseCoalescingWindowMs);

    this.state.phase = {
      type: 'coalescing',
      timeoutId,
      pendingRequests,
    };
  }

  private addToCoalescingBatch(
    requestId: string,
    payload: T,
    priority: FetchType,
    addedAt: number,
  ): ScheduleFetchResults {
    const phase = this.state.phase;
    if (phase.type !== 'coalescing') {
      throw new Error('[tsdf] Expected coalescing phase');
    }

    const existing = phase.pendingRequests.get(requestId);
    if (existing) {
      // Update existing request with new payload/priority
      existing.payload = payload;
      existing.priority = priority;
      return 'coalesced';
    }

    // Add new request to batch
    phase.pendingRequests.set(requestId, {
      payload,
      priority,
      addedAt,
      awaitCallbacks: [],
    });

    // Check if max batch size reached
    if (this.maxBatchSize && phase.pendingRequests.size >= this.maxBatchSize) {
      this.onEvent?.('batch-size-triggered');
      clearTimeout(phase.timeoutId);
      this.onCoalescingTimeout();
      return 'batch-triggered';
    }

    return 'added-to-batch';
  }

  private addToScheduledRequests(
    requestId: string,
    payload: T,
    priority: FetchType,
    addedAt: number,
  ): void {
    const existing = this.state.pending.scheduledRequests.get(requestId);
    if (existing) {
      // Update existing with higher priority if needed
      existing.payload = payload;
      existing.priority = priority;
    } else {
      this.state.pending.scheduledRequests.set(requestId, {
        payload,
        priority,
        addedAt,
        awaitCallbacks: [],
      });
    }
  }

  private onCoalescingTimeout(): void {
    const { phase, pending } = this.state;

    if (phase.type !== 'coalescing') return;

    const { pendingRequests } = phase;

    // Filter out requests under mutation
    const requestsToFetch = new Map<string, PendingRequest<T>>();
    for (const [requestId, request] of pendingRequests) {
      if (pending.mutationsInProgress.has(requestId)) {
        // Move to scheduled instead
        pending.scheduledRequests.set(requestId, request);
      } else {
        requestsToFetch.set(requestId, request);
      }
    }

    // Transition to idle first
    this.state.phase = { type: 'idle' };

    // Fire coalescing callbacks for requests NOT being fetched (moved to scheduled)
    for (const [requestId, request] of pendingRequests) {
      if (!requestsToFetch.has(requestId)) {
        for (const cb of request.awaitCallbacks) {
          cb(true); // aborted
        }
      }
    }

    // If no requests to fetch, we're done
    if (requestsToFetch.size === 0) return;

    // Start the fetch
    void this.transitionToFetching(requestsToFetch, Date.now());
  }

  private async transitionToFetching(
    requests: Map<string, PendingRequest<T>>,
    startTime: number,
  ): Promise<boolean> {
    this.assertPhase('idle', 'transitionToFetching');

    const fetchId = getAutoIncrementId();
    const abortController = new AbortController();

    // Update state atomically
    this.state.abort.lastFetchId = fetchId;
    this.state.abort.controller = abortController;
    this.state.lastFetchWasAborted = false;
    this.state.lastAbortedRequests.clear();

    const prevFetchStartTime = this.state.timing.lastFetchStartTime;
    this.state.timing.lastFetchStartTime = startTime;

    // Update per-request timing
    for (const requestId of requests.keys()) {
      this.state.timing.lastFetchStartTimePerRequest.set(requestId, startTime);
    }

    // Build fetchingRequests map with await callbacks
    const fetchingRequests = new Map<string, { awaitCallbacks: Array<(wasAborted: boolean) => void> }>();
    for (const [requestId, request] of requests) {
      fetchingRequests.set(requestId, {
        awaitCallbacks: [...request.awaitCallbacks],
      });
    }

    this.state.phase = {
      type: 'fetching',
      fetchId,
      startTime,
      fetchingRequests,
      rtuCallback: null,
    };

    // Clear RTU delayed if any (new fetch supersedes)
    this.clearRtuDelayed();

    // Cancel medium priority when fetch starts
    this.cancelMediumPriority();

    // Create shouldAbort function that checks current state
    const shouldAbort = function shouldAbort(this: RequestScheduler<T>): boolean {
      const { abort, pending } = this.state;
      const shouldAbortFetch =
        fetchId !== abort.lastFetchId
        || fetchId <= abort.abortBoundary;

      // Check if any request in this batch has mutation started
      const anyMutation = Array.from(requests.keys()).some(
        (reqId) => pending.mutationsInProgress.has(reqId),
      );

      const abort_ = shouldAbortFetch || anyMutation;

      if (abort_) {
        this.state.lastFetchWasAborted = true;
        for (const requestId of requests.keys()) {
          this.state.lastAbortedRequests.add(requestId);
        }
        abortController.abort();
      }

      return abort_;
    }.bind(this);

    // Build batch requests array
    const batchRequests: BatchRequest<T>[] = Array.from(requests.entries()).map(
      ([requestId, request]) => ({
        requestId,
        payload: request.payload,
      }),
    );

    // Execute the fetch
    let results: Map<string, boolean>;
    try {
      results = await this.fetchFn(batchRequests, {
        shouldAbort,
        getStartTime: () => startTime,
        signal: abortController.signal,
      });
    } catch {
      // On error, mark all as failed
      results = new Map();
      for (const requestId of requests.keys()) {
        results.set(requestId, false);
      }
    }

    // Clear abort controller
    this.state.abort.controller = null;

    // Check if we're still the current fetch phase (phase may have changed during await)
    if (!this.isCurrentFetch(fetchId)) {
      // Fetch was superseded, restore previous timing
      this.state.timing.lastFetchStartTime = prevFetchStartTime;
      return false;
    }

    // Update timing on success (if any succeeded)
    const anySuccess = Array.from(results.values()).some((v) => v);
    if (anySuccess) {
      this.state.timing.lastFetchDuration = Date.now() - startTime;
    }

    // Get callbacks before clearing phase
    const { fetchingRequests: callbacks, rtuCallback } = this.state.phase;

    // Clear any pending RTU delayed (could have been scheduled during fetch)
    this.clearRtuDelayed();

    // Transition to idle
    this.state.phase = { type: 'idle' };

    // Fire callbacks per request
    for (const [requestId, { awaitCallbacks }] of callbacks) {
      const wasAborted = this.state.lastAbortedRequests.has(requestId);
      for (const cb of awaitCallbacks) {
        cb(wasAborted);
      }
    }

    if (rtuCallback) {
      rtuCallback();
    }

    // Flush any scheduled requests
    this.flushScheduledRequests();

    return true;
  }

  // ==========================================================================
  // Mutation Handling
  // ==========================================================================

  private endMutation(requestId: string): boolean {
    const { pending } = this.state;

    const currentCount = pending.mutationsInProgress.get(requestId);
    if (!currentCount) return false;

    // Decrement mutation count
    if (currentCount <= 1) {
      pending.mutationsInProgress.delete(requestId);
    } else {
      pending.mutationsInProgress.set(requestId, currentCount - 1);
    }

    // Only flush scheduled requests if no more mutations in progress for this request
    if (!pending.mutationsInProgress.has(requestId)) {
      this.flushScheduledRequests();
    }

    return true;
  }

  // ==========================================================================
  // Scheduled Fetch Handling
  // ==========================================================================

  private flushScheduledRequests(): void {
    const { pending, phase } = this.state;

    if (pending.scheduledRequests.size === 0) return;

    // Don't flush if fetch in progress
    if (phase.type === 'fetching') return;

    // Filter out requests still under mutation
    const requestsToFlush = new Map<string, PendingRequest<T>>();
    const rtuRequestsToFlush: Array<{ requestId: string; payload: T }> = [];

    for (const [requestId, request] of pending.scheduledRequests) {
      if (!pending.mutationsInProgress.has(requestId)) {
        pending.scheduledRequests.delete(requestId);

        // If this was an RTU request and dynamic throttle is configured,
        // route through the RTU delay mechanism
        if (request.priority === 'realtimeUpdate' && this.dynamicRealtimeThrottleMs) {
          rtuRequestsToFlush.push({ requestId, payload: request.payload });
        } else {
          requestsToFlush.set(requestId, request);
        }
      }
    }

    // Handle RTU requests through delay mechanism
    for (const { requestId, payload } of rtuRequestsToFlush) {
      // Try to schedule delayed RTU
      const wasDelayed = this.scheduleDelayedRTU(Date.now(), requestId, payload);
      if (!wasDelayed) {
        // If no delay needed, emit event and schedule immediately
        this.onEvent?.('scheduled-rt-fetch-started');
        // Add to regular requests to flush
        requestsToFlush.set(requestId, {
          payload,
          priority: 'highPriority',
          addedAt: Date.now(),
          awaitCallbacks: [],
        });
      }
    }

    if (requestsToFlush.size === 0) return;

    this.onEvent?.('scheduled-fetch-started');

    // Clear any active coalescing window
    if (this.state.phase.type === 'coalescing') {
      // Merge scheduled requests into coalescing
      for (const [requestId, request] of requestsToFlush) {
        this.state.phase.pendingRequests.set(requestId, request);
      }
      return;
    }

    // Start coalescing window with scheduled requests
    const timeoutId = setTimeout(() => {
      this.onCoalescingTimeout();
    }, this.baseCoalescingWindowMs);

    this.state.phase = {
      type: 'coalescing',
      timeoutId,
      pendingRequests: requestsToFlush,
    };
  }

  // ==========================================================================
  // Low Priority Throttling
  // ==========================================================================

  private shouldSkipFetch(requestId: string, fetchType: FetchType, startTime: number): boolean {
    if (fetchType !== 'lowPriority') return false;

    const { phase, pending } = this.state;

    // Skip if fetch/coalescing in progress or scheduled
    if (
      phase.type === 'fetching'
      || phase.type === 'coalescing'
      || pending.scheduledRequests.size > 0
    ) {
      return true;
    }

    // Check if within throttle window
    const isWithinThrottleWindow = this.isWithinThrottleWindow(requestId, startTime);

    // If mutation in progress, only skip if also within throttle window
    if (pending.mutationsInProgress.has(requestId)) {
      return isWithinThrottleWindow;
    }

    return isWithinThrottleWindow;
  }

  private isWithinThrottleWindow(requestId: string, startTime: number): boolean {
    const { timing } = this.state;

    // Check per-request timing
    const lastFetchTime = timing.lastFetchStartTimePerRequest.get(requestId);
    if (lastFetchTime) {
      const timeSinceLastFetch = startTime - lastFetchTime;
      if (timeSinceLastFetch < this.lowPriorityThrottleMs) {
        return true;
      }
    }

    // Also check global timing
    if (timing.lastFetchStartTime) {
      const timeSinceLastFetch = startTime - timing.lastFetchStartTime;
      if (timeSinceLastFetch < this.lowPriorityThrottleMs) {
        return true;
      }
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

  private handleRealtimeUpdate(startTime: number, requestId: string, payload: T): boolean {
    const { timing, phase, pending } = this.state;

    if (
      !timing.lastFetchDuration
      || !timing.lastFetchStartTime
      || !this.dynamicRealtimeThrottleMs
    ) {
      return false;
    }

    // If RTU is already scheduled for this request, just return true
    if (pending.rtuDelayed && pending.rtuDelayed.requestId === requestId) return true;

    // If fetching, register callback for when fetch completes
    if (phase.type === 'fetching') {
      phase.rtuCallback = () => {
        this.scheduleDelayedRTU(Date.now(), requestId, payload);
      };
      return true;
    }

    // If mutation in progress for this request, schedule for after
    if (pending.mutationsInProgress.has(requestId)) {
      this.addToScheduledRequests(requestId, payload, 'realtimeUpdate', startTime);
      return true;
    }

    // Try to schedule delayed RTU
    return this.scheduleDelayedRTU(startTime, requestId, payload);
  }

  private scheduleDelayedRTU(startTime: number, requestId: string, payload: T): boolean {
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
        this.scheduleFetch(requestId, 'highPriority', payload);
      }, delay),
      requestId,
      payload,
    };

    return true;
  }

  // ==========================================================================
  // Medium Priority Handling
  // ==========================================================================

  private handleMediumPriority(
    requestId: string,
    payload: T,
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
        this.executeMediumPriorityFetch(requestId, payload);
      }, delayMs),
      requestId,
      payload,
    };

    return 'medium-scheduled';
  }

  private executeMediumPriorityFetch(requestId: string, payload: T): void {
    this.state.pending.mediumPriorityDelayed = null;

    this.onEvent?.('medium-priority-fetch-started');

    const { phase, pending } = this.state;

    // If busy or mutation in progress for this request, schedule for later
    if (
      phase.type !== 'idle'
      || pending.mutationsInProgress.has(requestId)
    ) {
      this.addToScheduledRequests(requestId, payload, 'mediumPriority', Date.now());
      return;
    }

    // Behave like high priority
    this.scheduleFetch(requestId, 'highPriority', payload);
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

  /** Check if the current in-progress fetch should be aborted */
  private shouldCurrentFetchBeAborted(): boolean {
    const { phase, abort, pending } = this.state;

    if (phase.type !== 'fetching') return false;

    // Check if fetch is past abort boundary
    if (phase.fetchId <= abort.abortBoundary) return true;

    // Check if any request in the fetch has mutation in progress
    for (const requestId of phase.fetchingRequests.keys()) {
      if (pending.mutationsInProgress.has(requestId)) return true;
    }

    return false;
  }

  /** Force abort the current fetch and transition to idle */
  private forceAbortCurrentFetch(): void {
    const { phase, abort } = this.state;

    if (phase.type !== 'fetching') return;

    // Abort the controller
    if (abort.controller) {
      abort.controller.abort();
      abort.controller = null;
    }

    // Mark as aborted
    this.state.lastFetchWasAborted = true;
    for (const requestId of phase.fetchingRequests.keys()) {
      this.state.lastAbortedRequests.add(requestId);
    }

    // Fire callbacks with aborted=true
    for (const [, { awaitCallbacks }] of phase.fetchingRequests) {
      for (const cb of awaitCallbacks) {
        cb(true);
      }
    }

    // Transition to idle
    this.state.phase = { type: 'idle' };
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
