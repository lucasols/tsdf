export type FetchContext = {
  shouldAbort: () => boolean;
  getStartTime: () => number;
  signal: AbortSignal;
};

export type RequestSchedulerEvents =
  | 'scheduled-fetch-started'
  | 'rt-fetch-scheduled'
  | 'rt-fetch-cancelled'
  | 'scheduled-rt-fetch-started'
  | 'medium-priority-scheduled'
  | 'medium-priority-fetch-started'
  | 'medium-priority-cancelled'
  | 'batch-size-triggered';

export type RequestSchedulerEventData = {
  /** Delay in ms for scheduled events (medium-priority-scheduled, rt-fetch-scheduled) */
  delayMs?: number;
};

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
  remoteStartCancelable: boolean;
};

/** Request with ID for batch fetching */
export type BatchRequest<T> = { requestId: string; payload: T };

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
      fetchingRequests: Map<
        string,
        { awaitCallbacks: Array<(wasAborted: boolean) => void> }
      >;
      rtuCallback: (() => void) | null;
    };

type DelayedRequest<T> = {
  timeoutId: TimeoutId;
  requestId: string;
  payload: T;
  remoteStartCancelable: boolean;
};

/** Pending states that can coexist with any phase */
type PendingStates<T> = {
  /** Requests scheduled for after current fetch completes */
  scheduledRequests: Map<string, PendingRequest<T>>;
  rtuDelayed: DelayedRequest<T> | null;
  mediumPriorityDelayed: DelayedRequest<T> | null;
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

export type RequestSchedulerOptions<T> = {
  /** Fetch function receives array of requests (even for single request) */
  fetchFn: (
    requests: BatchRequest<T>[],
    fetchContext: FetchContext,
  ) => Promise<Map<string, boolean>>;
  on?: (
    event: RequestSchedulerEvents,
    data?: RequestSchedulerEventData,
  ) => void;
  lowPriorityThrottleMs: number;
  getCoalescingWindowMs: () => number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  mediumPriorityDelayMs?: number;
  /** Max batch size - triggers immediate fetch when reached */
  maxBatchSize?: number;
  /** Initial last fetch start time for throttling (e.g., from a query that already loaded this item) */
  initialLastFetchStartTime?: number;
  /** Coalesce payloads when the same requestId is scheduled multiple times.
   * Called with (existing, incoming) and should return the merged payload. */
  coalescePayload?: (existing: T, incoming: T) => T;
  /** for validation of realtimeUpdate fetch type */
  usesRealTimeUpdates: boolean;
};

export type ScheduleFetchOptions = { mediumPriorityDelayMs?: number };

let autoIncrementId = 0;
export function getAutoIncrementId(): number {
  return ++autoIncrementId;
}

export class RequestScheduler<T> {
  private readonly fetchFn: (
    requests: BatchRequest<T>[],
    fetchContext: FetchContext,
  ) => Promise<Map<string, boolean>>;
  private readonly onEvent:
    | ((
        event: RequestSchedulerEvents,
        data?: RequestSchedulerEventData,
      ) => void)
    | undefined;
  private readonly lowPriorityThrottleMs: number;
  private readonly getCoalescingWindowMs: () => number;
  private readonly dynamicRealtimeThrottleMs:
    | ((lastFetchDuration: number) => number)
    | undefined;
  private readonly mediumPriorityDelayMs: number | undefined;
  private readonly maxBatchSize: number | undefined;
  private readonly coalescePayload:
    | ((existing: T, incoming: T) => T)
    | undefined;
  private readonly usesRealTimeUpdates: boolean;

  private state: SchedulerState<T>;

  constructor(options: RequestSchedulerOptions<T>) {
    this.fetchFn = options.fetchFn;
    this.onEvent = options.on;
    this.lowPriorityThrottleMs = options.lowPriorityThrottleMs;
    this.getCoalescingWindowMs = options.getCoalescingWindowMs;
    this.dynamicRealtimeThrottleMs = options.dynamicRealtimeThrottleMs;
    this.mediumPriorityDelayMs = options.mediumPriorityDelayMs;
    this.maxBatchSize = options.maxBatchSize;
    this.coalescePayload = options.coalescePayload;
    this.usesRealTimeUpdates = options.usesRealTimeUpdates;

    this.state = this.createInitialState();

    if (options.initialLastFetchStartTime !== undefined) {
      this.state.timing.lastFetchStartTime = options.initialLastFetchStartTime;
    }
  }

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
      abort: { lastFetchId: 0, abortBoundary: 0, controller: null },
      lastFetchWasAborted: false,
      lastAbortedRequests: new Set(),
    };
  }

  get hasPendingFetch(): boolean {
    const { phase, pending } = this.state;
    return (
      phase.type !== 'idle' ||
      pending.scheduledRequests.size > 0 ||
      pending.rtuDelayed !== null ||
      pending.mediumPriorityDelayed !== null
    );
  }

  get fetchIsInProgress(): boolean {
    return this.state.phase.type === 'fetching';
  }

  get mutationIsInProgress(): boolean {
    for (const count of this.state.pending.mutationsInProgress.values()) {
      if (count > 0) return true;
    }
    return false;
  }

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

  setLastFetchStartTimeForRequest(requestId: string, startTime: number): void {
    const currentStartTime =
      this.state.timing.lastFetchStartTimePerRequest.get(requestId);

    if (currentStartTime === undefined || startTime > currentStartTime) {
      this.state.timing.lastFetchStartTimePerRequest.set(requestId, startTime);
    }

    if (startTime > this.state.timing.lastFetchStartTime) {
      this.state.timing.lastFetchStartTime = startTime;
    }
  }

  syncExternalFetchStart(requestIds: string[], startedAt: number): void {
    for (const requestId of requestIds) {
      this.setLastFetchStartTimeForRequest(requestId, startedAt);
    }
  }

  syncExternalFetchSuccess(
    requestIds: string[],
    startedAt: number,
    duration: number,
  ): void {
    const previousStartTime = this.state.timing.lastFetchStartTime;
    this.syncExternalFetchStart(requestIds, startedAt);

    if (startedAt > previousStartTime) {
      this.state.timing.lastFetchStartTime = startedAt;
      this.state.timing.lastFetchDuration = duration;
      return;
    }

    if (startedAt === this.state.timing.lastFetchStartTime) {
      this.state.timing.lastFetchDuration = Math.max(
        this.state.timing.lastFetchDuration,
        duration,
      );
    }
  }

  getFetchIsInProgress(): boolean {
    return this.state.phase.type === 'fetching';
  }

  getCurrentBatchSize(): number {
    const { phase } = this.state;
    if (phase.type === 'coalescing') {
      return phase.pendingRequests.size;
    }
    return 0;
  }

  scheduleFetch(
    requestId: string,
    fetchType: FetchType,
    payload: T,
    options?: ScheduleFetchOptions,
  ): ScheduleFetchResults {
    return this.scheduleRequest(
      requestId,
      fetchType,
      payload,
      options,
      this.hasKnownRequest(requestId),
    );
  }

  async awaitFetch(
    requestId: string,
    payload: T,
    options: { timeoutMs?: number } = {},
  ): Promise<boolean | 'timeout'> {
    const { timeoutMs = 30_000 } = options;

    this.scheduleRequest(requestId, 'highPriority', payload, undefined, false);

    const fetchPromise = this.waitForRequest(requestId);

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs);
    });

    return Promise.race([fetchPromise, timeoutPromise]);
  }

  private async waitForRequest(requestId: string): Promise<boolean> {
    const { phase, pending } = this.state;

    const scheduledRequest = pending.scheduledRequests.get(requestId);
    if (scheduledRequest) {
      await new Promise<void>((resolve) => {
        scheduledRequest.awaitCallbacks.push(() => resolve());
      });
    }

    if (phase.type === 'coalescing') {
      const request = phase.pendingRequests.get(requestId);
      if (request) {
        await new Promise<void>((resolve) => {
          request.awaitCallbacks.push(() => resolve());
        });
      }
    }

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

    const currentCount = pending.mutationsInProgress.get(requestId) ?? 0;
    pending.mutationsInProgress.set(requestId, currentCount + 1);

    abort.abortBoundary = abort.lastFetchId;

    if (phase.type === 'coalescing') {
      const request = phase.pendingRequests.get(requestId);
      if (request) {
        phase.pendingRequests.delete(requestId);
        this.state.pending.scheduledRequests.set(requestId, request);
      }

      if (phase.pendingRequests.size === 0) {
        clearTimeout(phase.timeoutId);
        this.state.phase = { type: 'idle' };
      }
    }

    if (phase.type === 'fetching') {
      if (phase.fetchingRequests.has(requestId) && abort.controller) {
        abort.controller.abort();
        abort.controller = null;
      }
    }

    return () => this.endMutation(requestId);
  }

  reset(): void {
    const { phase, pending, abort } = this.state;

    if (phase.type === 'coalescing') {
      clearTimeout(phase.timeoutId);
    }
    if (pending.rtuDelayed) {
      clearTimeout(pending.rtuDelayed.timeoutId);
    }
    if (pending.mediumPriorityDelayed) {
      clearTimeout(pending.mediumPriorityDelayed.timeoutId);
    }

    if (abort.controller) {
      abort.controller.abort();
    }

    this.state = this.createInitialState();
  }

  cancelCoalescingRequests(requestIds: string[]): boolean {
    if (requestIds.length === 0) return false;

    let wasCancelled = false;

    if (this.state.phase.type !== 'coalescing') return false;

    for (const requestId of requestIds) {
      const request = this.state.phase.pendingRequests.get(requestId);
      if (!request || !this.isRemoteStartCancelable(request)) continue;

      this.state.phase.pendingRequests.delete(requestId);
      this.finalizePendingRequestCallbacks(request, true);
      wasCancelled = true;
    }

    if (this.state.phase.pendingRequests.size === 0) {
      clearTimeout(this.state.phase.timeoutId);
      this.state.phase = { type: 'idle' };
    }

    return wasCancelled;
  }

  private scheduleRequest(
    requestId: string,
    fetchType: FetchType,
    payload: T,
    options: ScheduleFetchOptions | undefined,
    remoteStartCancelable: boolean,
  ): ScheduleFetchResults {
    if (fetchType === 'realtimeUpdate' && !this.usesRealTimeUpdates) {
      throw new Error(
        'realtimeUpdate fetch type cannot be used if usesRealTimeUpdates is not enabled',
      );
    }

    const startTime = Date.now();

    if (fetchType === 'mediumPriority') {
      return this.handleMediumPriority(
        requestId,
        payload,
        options?.mediumPriorityDelayMs,
        remoteStartCancelable,
      );
    }

    if (this.dynamicRealtimeThrottleMs && fetchType === 'realtimeUpdate') {
      if (
        this.handleRealtimeUpdate(
          startTime,
          requestId,
          payload,
          remoteStartCancelable,
        )
      ) {
        return 'rt-scheduled';
      }
    }

    if (
      remoteStartCancelable &&
      this.shouldSkipFetch(requestId, fetchType, startTime)
    ) {
      return 'skipped';
    }

    if (this.state.pending.mutationsInProgress.has(requestId)) {
      this.addToScheduledRequests(
        requestId,
        payload,
        fetchType,
        startTime,
        remoteStartCancelable,
      );
      return 'scheduled';
    }

    if (this.state.phase.type === 'fetching') {
      const shouldAbortCurrentFetch = this.shouldCurrentFetchBeAborted();

      if (shouldAbortCurrentFetch) {
        this.forceAbortCurrentFetch();
      } else {
        this.addToScheduledRequests(
          requestId,
          payload,
          fetchType,
          startTime,
          remoteStartCancelable,
        );
        return 'scheduled';
      }
    }

    if (this.state.phase.type === 'coalescing') {
      return this.addToCoalescingBatch(
        requestId,
        payload,
        fetchType,
        startTime,
        remoteStartCancelable,
      );
    }

    this.transitionToCoalescing(
      requestId,
      payload,
      fetchType,
      startTime,
      remoteStartCancelable,
    );
    return 'triggered';
  }

  private transitionToCoalescing(
    requestId: string,
    payload: T,
    priority: FetchType,
    addedAt: number,
    remoteStartCancelable: boolean,
  ): void {
    this.assertPhase('idle', 'transitionToCoalescing');

    const pendingRequests = new Map<string, PendingRequest<T>>();
    pendingRequests.set(requestId, {
      payload,
      priority,
      addedAt,
      awaitCallbacks: [],
      remoteStartCancelable,
    });

    const timeoutId = setTimeout(() => {
      this.onCoalescingTimeout();
    }, this.getCoalescingWindowMs());

    this.state.phase = { type: 'coalescing', timeoutId, pendingRequests };
  }

  private addToCoalescingBatch(
    requestId: string,
    payload: T,
    priority: FetchType,
    addedAt: number,
    remoteStartCancelable: boolean,
  ): ScheduleFetchResults {
    const phase = this.state.phase;
    if (phase.type !== 'coalescing') {
      throw new Error('[tsdf] Expected coalescing phase');
    }

    const existing = phase.pendingRequests.get(requestId);
    if (existing) {
      existing.payload = this.coalescePayload
        ? this.coalescePayload(existing.payload, payload)
        : payload;
      existing.priority = priority;
      existing.remoteStartCancelable =
        existing.remoteStartCancelable && remoteStartCancelable;
      return 'coalesced';
    }

    phase.pendingRequests.set(requestId, {
      payload,
      priority,
      addedAt,
      awaitCallbacks: [],
      remoteStartCancelable,
    });

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
    remoteStartCancelable: boolean,
  ): void {
    const existing = this.state.pending.scheduledRequests.get(requestId);
    if (existing) {
      existing.payload = this.coalescePayload
        ? this.coalescePayload(existing.payload, payload)
        : payload;
      existing.priority = priority;
      existing.remoteStartCancelable =
        existing.remoteStartCancelable && remoteStartCancelable;
      return;
    }

    this.state.pending.scheduledRequests.set(requestId, {
      payload,
      priority,
      addedAt,
      awaitCallbacks: [],
      remoteStartCancelable,
    });
  }

  private onCoalescingTimeout(): void {
    const { phase, pending } = this.state;

    if (phase.type !== 'coalescing') return;

    const { pendingRequests } = phase;

    const requestsToFetch = new Map<string, PendingRequest<T>>();
    for (const [requestId, request] of pendingRequests) {
      if (pending.mutationsInProgress.has(requestId)) {
        pending.scheduledRequests.set(requestId, request);
      } else {
        requestsToFetch.set(requestId, request);
      }
    }

    this.state.phase = { type: 'idle' };

    for (const [requestId, request] of pendingRequests) {
      if (!requestsToFetch.has(requestId)) {
        this.finalizePendingRequestCallbacks(request, true);
      }
    }

    if (requestsToFetch.size === 0) return;

    void this.transitionToFetching(requestsToFetch, Date.now());
  }

  private async transitionToFetching(
    requests: Map<string, PendingRequest<T>>,
    startTime: number,
  ): Promise<boolean> {
    this.assertPhase('idle', 'transitionToFetching');

    const fetchId = getAutoIncrementId();
    const abortController = new AbortController();

    this.state.abort.lastFetchId = fetchId;
    this.state.abort.controller = abortController;
    this.state.lastFetchWasAborted = false;
    this.state.lastAbortedRequests.clear();

    const prevFetchStartTime = this.state.timing.lastFetchStartTime;
    this.state.timing.lastFetchStartTime = startTime;

    for (const requestId of requests.keys()) {
      this.setLastFetchStartTimeForRequest(requestId, startTime);
    }

    const fetchingRequests = new Map<
      string,
      { awaitCallbacks: Array<(wasAborted: boolean) => void> }
    >();
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

    this.clearRtuDelayed();
    this.cancelMediumPriority();

    const shouldAbort = function shouldAbort(
      this: RequestScheduler<T>,
    ): boolean {
      const { abort, pending } = this.state;
      const shouldAbortFetch =
        fetchId !== abort.lastFetchId || fetchId <= abort.abortBoundary;

      const anyMutation = Array.from(requests.keys()).some((reqId) =>
        pending.mutationsInProgress.has(reqId),
      );

      const shouldAbortNow = shouldAbortFetch || anyMutation;

      if (shouldAbortNow) {
        this.state.lastFetchWasAborted = true;
        for (const requestId of requests.keys()) {
          this.state.lastAbortedRequests.add(requestId);
        }
        abortController.abort();
      }

      return shouldAbortNow;
    }.bind(this);

    const batchRequests: BatchRequest<T>[] = Array.from(requests.entries()).map(
      ([requestId, request]) => ({ requestId, payload: request.payload }),
    );

    let results: Map<string, boolean>;
    try {
      results = await this.fetchFn(batchRequests, {
        shouldAbort,
        getStartTime: () => startTime,
        signal: abortController.signal,
      });
    } catch {
      results = new Map();
      for (const requestId of requests.keys()) {
        results.set(requestId, false);
      }
    }

    this.state.abort.controller = null;

    if (!this.isCurrentFetch(fetchId)) {
      this.state.timing.lastFetchStartTime = prevFetchStartTime;
      return false;
    }

    const anySuccess = Array.from(results.values()).some((value) => value);
    if (anySuccess) {
      this.state.timing.lastFetchDuration = Date.now() - startTime;
    }

    const { fetchingRequests: callbacks, rtuCallback } = this.state.phase;

    this.clearRtuDelayed();
    this.state.phase = { type: 'idle' };

    for (const [requestId, { awaitCallbacks }] of callbacks) {
      const wasAborted = this.state.lastAbortedRequests.has(requestId);
      for (const callback of awaitCallbacks) {
        callback(wasAborted);
      }
    }

    if (rtuCallback) {
      rtuCallback();
    }

    this.flushScheduledRequests();

    return true;
  }

  private endMutation(requestId: string): boolean {
    const currentCount = this.state.pending.mutationsInProgress.get(requestId);
    if (!currentCount) return false;

    if (currentCount <= 1) {
      this.state.pending.mutationsInProgress.delete(requestId);
    } else {
      this.state.pending.mutationsInProgress.set(requestId, currentCount - 1);
    }

    if (!this.state.pending.mutationsInProgress.has(requestId)) {
      this.flushScheduledRequests();
    }

    return true;
  }

  private flushScheduledRequests(): void {
    const { pending, phase } = this.state;

    if (pending.scheduledRequests.size === 0) return;

    if (phase.type === 'fetching') return;

    const requestsToFlush = new Map<string, PendingRequest<T>>();
    const rtuRequestsToFlush: Array<{
      requestId: string;
      payload: T;
      remoteStartCancelable: boolean;
    }> = [];

    for (const [requestId, request] of pending.scheduledRequests) {
      if (!pending.mutationsInProgress.has(requestId)) {
        pending.scheduledRequests.delete(requestId);

        if (this.wasSupersededAfterBeingScheduled(requestId, request)) {
          this.finalizePendingRequestCallbacks(request, true);
          continue;
        }

        if (
          request.priority === 'realtimeUpdate' &&
          this.dynamicRealtimeThrottleMs
        ) {
          rtuRequestsToFlush.push({
            requestId,
            payload: request.payload,
            remoteStartCancelable: request.remoteStartCancelable,
          });
        } else {
          requestsToFlush.set(requestId, request);
        }
      }
    }

    for (const request of rtuRequestsToFlush) {
      const wasDelayed = this.scheduleDelayedRTU(
        Date.now(),
        request.requestId,
        request.payload,
        request.remoteStartCancelable,
      );
      if (!wasDelayed) {
        this.onEvent?.('scheduled-rt-fetch-started');
        requestsToFlush.set(request.requestId, {
          payload: request.payload,
          priority: 'highPriority',
          addedAt: Date.now(),
          awaitCallbacks: [],
          remoteStartCancelable: request.remoteStartCancelable,
        });
      }
    }

    if (requestsToFlush.size === 0) return;

    this.onEvent?.('scheduled-fetch-started');

    if (this.state.phase.type === 'coalescing') {
      for (const [requestId, request] of requestsToFlush) {
        const existing = this.state.phase.pendingRequests.get(requestId);
        if (existing) {
          existing.payload = this.coalescePayload
            ? this.coalescePayload(existing.payload, request.payload)
            : request.payload;
          existing.priority = request.priority;
          existing.remoteStartCancelable =
            existing.remoteStartCancelable && request.remoteStartCancelable;
          existing.awaitCallbacks.push(...request.awaitCallbacks);
        } else {
          this.state.phase.pendingRequests.set(requestId, request);
        }
      }
      return;
    }

    const timeoutId = setTimeout(() => {
      this.onCoalescingTimeout();
    }, this.getCoalescingWindowMs());

    this.state.phase = {
      type: 'coalescing',
      timeoutId,
      pendingRequests: requestsToFlush,
    };
  }

  private shouldSkipFetch(
    requestId: string,
    fetchType: FetchType,
    startTime: number,
  ): boolean {
    if (fetchType !== 'lowPriority') return false;

    const { phase, pending } = this.state;

    if (phase.type === 'fetching') return true;

    if (phase.type === 'coalescing') {
      return !phase.pendingRequests.has(requestId);
    }

    if (pending.scheduledRequests.size > 0) {
      return !pending.scheduledRequests.has(requestId);
    }

    const isWithinThrottleWindow = this.isWithinThrottleWindow(
      requestId,
      startTime,
    );

    if (pending.mutationsInProgress.has(requestId)) {
      return isWithinThrottleWindow;
    }

    return isWithinThrottleWindow;
  }

  private isWithinThrottleWindow(
    requestId: string,
    startTime: number,
  ): boolean {
    const lastFetchTime =
      this.state.timing.lastFetchStartTimePerRequest.get(requestId);
    if (lastFetchTime !== undefined) {
      const timeSinceLastFetch = startTime - lastFetchTime;
      if (timeSinceLastFetch < this.lowPriorityThrottleMs) {
        return true;
      }
    }

    if (this.state.timing.lastFetchStartTime) {
      const timeSinceLastFetch =
        startTime - this.state.timing.lastFetchStartTime;
      if (timeSinceLastFetch < this.lowPriorityThrottleMs) {
        return true;
      }
    }

    return false;
  }

  private clearRtuDelayed(): void {
    const rtu = this.state.pending.rtuDelayed;
    if (rtu) {
      clearTimeout(rtu.timeoutId);
      this.state.pending.rtuDelayed = null;
      this.onEvent?.('rt-fetch-cancelled');
    }
  }

  private handleRealtimeUpdate(
    startTime: number,
    requestId: string,
    payload: T,
    remoteStartCancelable: boolean,
  ): boolean {
    const { timing, phase, pending } = this.state;

    if (
      !timing.lastFetchDuration ||
      !timing.lastFetchStartTime ||
      !this.dynamicRealtimeThrottleMs
    ) {
      return false;
    }

    if (pending.rtuDelayed && pending.rtuDelayed.requestId === requestId) {
      pending.rtuDelayed.payload = this.coalescePayload
        ? this.coalescePayload(pending.rtuDelayed.payload, payload)
        : payload;
      pending.rtuDelayed.remoteStartCancelable =
        pending.rtuDelayed.remoteStartCancelable && remoteStartCancelable;
      return true;
    }

    if (phase.type === 'fetching') {
      phase.rtuCallback = () => {
        this.scheduleDelayedRTU(
          Date.now(),
          requestId,
          payload,
          remoteStartCancelable,
        );
      };
      return true;
    }

    if (pending.mutationsInProgress.has(requestId)) {
      this.addToScheduledRequests(
        requestId,
        payload,
        'realtimeUpdate',
        startTime,
        remoteStartCancelable,
      );
      return true;
    }

    return this.scheduleDelayedRTU(
      startTime,
      requestId,
      payload,
      remoteStartCancelable,
    );
  }

  private scheduleDelayedRTU(
    startTime: number,
    requestId: string,
    payload: T,
    remoteStartCancelable: boolean,
  ): boolean {
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
        this.scheduleRequest(
          requestId,
          'highPriority',
          payload,
          undefined,
          remoteStartCancelable,
        );
      }, delay),
      requestId,
      payload,
      remoteStartCancelable,
    };

    this.onEvent?.('rt-fetch-scheduled', { delayMs: delay });

    return true;
  }

  private handleMediumPriority(
    requestId: string,
    payload: T,
    customDelayMs: number | undefined,
    remoteStartCancelable: boolean,
  ): ScheduleFetchResults {
    const delayMs = customDelayMs ?? this.mediumPriorityDelayMs;

    if (delayMs === undefined) {
      throw new Error(
        '[tsdf] mediumPriorityDelayMs must be configured to use mediumPriority fetch type',
      );
    }

    if (!this.state.timing.lastFetchStartTime) {
      return this.scheduleRequest(
        requestId,
        'highPriority',
        payload,
        undefined,
        remoteStartCancelable,
      );
    }

    if (this.state.pending.mediumPriorityDelayed) {
      clearTimeout(this.state.pending.mediumPriorityDelayed.timeoutId);
    }

    this.state.pending.mediumPriorityDelayed = {
      timeoutId: setTimeout(() => {
        this.executeMediumPriorityFetch(requestId);
      }, delayMs),
      requestId,
      payload,
      remoteStartCancelable,
    };

    this.onEvent?.('medium-priority-scheduled', { delayMs });

    return 'medium-scheduled';
  }

  private executeMediumPriorityFetch(requestId: string): void {
    const delayedRequest = this.state.pending.mediumPriorityDelayed;
    if (!delayedRequest || delayedRequest.requestId !== requestId) return;

    this.state.pending.mediumPriorityDelayed = null;

    this.onEvent?.('medium-priority-fetch-started');

    const { phase, pending } = this.state;

    if (phase.type !== 'idle' || pending.mutationsInProgress.has(requestId)) {
      this.addToScheduledRequests(
        requestId,
        delayedRequest.payload,
        'mediumPriority',
        Date.now(),
        delayedRequest.remoteStartCancelable,
      );
      return;
    }

    this.scheduleRequest(
      requestId,
      'highPriority',
      delayedRequest.payload,
      undefined,
      delayedRequest.remoteStartCancelable,
    );
  }

  private cancelMediumPriority(): void {
    if (this.state.pending.mediumPriorityDelayed) {
      clearTimeout(this.state.pending.mediumPriorityDelayed.timeoutId);
      this.state.pending.mediumPriorityDelayed = null;
      this.onEvent?.('medium-priority-cancelled');
    }
  }

  private isRemoteStartCancelable(request: PendingRequest<T>): boolean {
    return request.remoteStartCancelable;
  }

  private wasSupersededAfterBeingScheduled(
    requestId: string,
    request: PendingRequest<T>,
  ): boolean {
    if (!request.remoteStartCancelable) return false;

    const lastFetchStartTime =
      this.state.timing.lastFetchStartTimePerRequest.get(requestId);

    return (
      lastFetchStartTime !== undefined && lastFetchStartTime > request.addedAt
    );
  }

  private hasKnownRequest(requestId: string): boolean {
    return this.state.timing.lastFetchStartTimePerRequest.has(requestId);
  }

  private finalizePendingRequestCallbacks(
    request: PendingRequest<T>,
    wasAborted: boolean,
  ): void {
    for (const callback of request.awaitCallbacks) {
      callback(wasAborted);
    }
    request.awaitCallbacks.length = 0;
  }

  private isCurrentFetch(fetchId: number): boolean {
    const { phase } = this.state;
    return phase.type === 'fetching' && phase.fetchId === fetchId;
  }

  private shouldCurrentFetchBeAborted(): boolean {
    const { phase, abort, pending } = this.state;

    if (phase.type !== 'fetching') return false;

    if (phase.fetchId <= abort.abortBoundary) return true;

    for (const requestId of phase.fetchingRequests.keys()) {
      if (pending.mutationsInProgress.has(requestId)) return true;
    }

    return false;
  }

  private forceAbortCurrentFetch(): void {
    const { phase, abort } = this.state;

    if (phase.type !== 'fetching') return;

    if (abort.controller) {
      abort.controller.abort();
      abort.controller = null;
    }

    this.state.lastFetchWasAborted = true;
    for (const requestId of phase.fetchingRequests.keys()) {
      this.state.lastAbortedRequests.add(requestId);
    }

    for (const [, { awaitCallbacks }] of phase.fetchingRequests) {
      for (const callback of awaitCallbacks) {
        callback(true);
      }
    }

    this.state.phase = { type: 'idle' };
  }

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
