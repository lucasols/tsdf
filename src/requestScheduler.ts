export type FetchContext = {
  shouldAbort: () => boolean;
  getStartTime: () => number;
  signal: AbortSignal;
};

export type FetchType = 'lowPriority' | 'highPriority' | 'realtimeUpdate';

export type RequestSchedulerEvents =
  | 'scheduled-fetch-started'
  | 'scheduled-rt-fetch-started';

export type ScheduleFetchResults =
  | 'skipped'
  | 'started'
  | 'scheduled'
  | 'rt-scheduled'
  | 'triggered'
  | 'coalesced';

type ScheduledState<T> = {
  params: T;
};

type RealtimeScheduledState = {
  timeoutId: ReturnType<typeof setTimeout>;
};

type CoalescingState<T> = {
  timeoutId: ReturnType<typeof setTimeout>;
  params: T;
  onEnd: (() => void)[];
};

type InProgressState = {
  startTime: number;
  onEnd: (() => void)[];
  rtuOnEnd: (() => void) | null;
};

type FetchState<T> = {
  inProgress: InProgressState | null;
  scheduled: ScheduledState<T> | null;
  realtimeScheduled: RealtimeScheduledState | null;
  coalescing: CoalescingState<T> | null;
};

export type RequestSchedulerOptions<T> = {
  fetchFn: (fetchContext: FetchContext, params: T) => Promise<boolean>;
  on?: (event: RequestSchedulerEvents) => void;
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
};

let autoIncrementId = 0;
export function getAutoIncrementId(): number {
  return ++autoIncrementId;
}

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

  private fetchState: FetchState<T>;
  private lastMutationIdStarted: number = 0;
  private lastFetchIdStarted: number = 0;
  private mutationInProgress: boolean = false;
  private lastFetchStartTime: number = 0;
  private lastFetchDuration: number = 0;
  private onMutationEnd: (() => void) | null = null;
  private lastFetchWasAborted: boolean = false;
  private abortFetchesBeforeOrEqual: number = 0;
  private currentAbortController: AbortController | null = null;

  constructor(options: RequestSchedulerOptions<T>) {
    this.fetchFn = options.fetchFn;
    this.onEvent = options.on;
    this.lowPriorityThrottleMs = options.lowPriorityThrottleMs;
    this.baseCoalescingWindowMs = options.baseCoalescingWindowMs;
    this.dynamicRealtimeThrottleMs = options.dynamicRealtimeThrottleMs;

    this.fetchState = {
      inProgress: null,
      scheduled: null,
      realtimeScheduled: null,
      coalescing: null,
    };
  }

  get hasPendingFetch(): boolean {
    return (
      this.fetchState.inProgress !== null
      || this.fetchState.scheduled !== null
      || this.fetchState.realtimeScheduled !== null
      || this.fetchState.coalescing !== null
    );
  }

  get fetchIsInProgress(): boolean {
    return this.fetchState.inProgress !== null;
  }

  get mutationIsInProgress(): boolean {
    return this.mutationInProgress;
  }

  setLastFetchDuration(duration: number): void {
    this.lastFetchDuration = duration;
  }

  setLastFetchStartTime(startTime: number): void {
    this.lastFetchStartTime = startTime;
  }

  private getFetchState(): FetchState<T> {
    return this.fetchState;
  }

  scheduleFetch(fetchType: FetchType, params: T): ScheduleFetchResults {
    const startTime = Date.now();

    if (this.dynamicRealtimeThrottleMs && fetchType === 'realtimeUpdate') {
      if (this.scheduleRTU(startTime, params)) return 'rt-scheduled';
    }

    if (this.shouldSkipFetch(fetchType, startTime)) {
      return 'skipped';
    }

    if (this.shouldScheduleFetch(fetchType, params)) {
      return 'scheduled';
    }

    // If coalescing window is active, update params and coalesce
    if (this.fetchState.coalescing) {
      this.fetchState.coalescing.params = params;
      return 'coalesced';
    }

    // Start coalescing window
    this.startCoalescingWindow(params);

    return 'triggered';
  }

  private startCoalescingWindow(params: T): void {
    this.fetchState.coalescing = {
      timeoutId: setTimeout(() => {
        const coalescing = this.fetchState.coalescing;
        if (!coalescing) return;

        const coalescedParams = coalescing.params;
        const onEnd = coalescing.onEnd;
        this.fetchState.coalescing = null;

        // Call all onEnd callbacks
        for (const cb of onEnd) cb();

        // If a fetch is already in progress (e.g., from RTU) or mutation in progress, schedule instead
        if (this.fetchState.inProgress || this.mutationInProgress) {
          this.fetchState.scheduled = { params: coalescedParams };
          return;
        }

        void this.startFetch(coalescedParams, Date.now());
      }, this.baseCoalescingWindowMs),
      params,
      onEnd: [],
    };
  }

  private addOnCoalescingEnd(cb: () => void): void {
    if (this.fetchState.coalescing) {
      this.fetchState.coalescing.onEnd.push(cb);
    }
  }

  async awaitFetch(params: T): Promise<boolean> {
    this.scheduleFetch('highPriority', params);

    // Wait for coalescing window to complete first
    if (this.fetchState.coalescing) {
      await new Promise<true>((resolve) => {
        this.addOnCoalescingEnd(() => resolve(true));
      });
    }

    // Then wait for the fetch to complete
    if (this.fetchState.inProgress) {
      await new Promise<true>((resolve) => {
        this.addOnFetchEnd(() => resolve(true));
      });
    }

    return this.lastFetchWasAborted;
  }

  startMutation(): () => boolean {
    this.mutationInProgress = true;
    this.abortFetchesBeforeOrEqual = this.lastFetchIdStarted;
    this.fetchState.inProgress = null;

    // Clear coalescing state when mutation starts
    if (this.fetchState.coalescing) {
      clearTimeout(this.fetchState.coalescing.timeoutId);
      this.fetchState.coalescing = null;
    }

    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }

    const id = getAutoIncrementId();
    this.lastMutationIdStarted = id;

    return () => this.endMutation(id);
  }

  reset(): void {
    if (this.fetchState.coalescing) {
      clearTimeout(this.fetchState.coalescing.timeoutId);
    }
    this.fetchState.inProgress = null;
    this.fetchState.scheduled = null;
    this.fetchState.realtimeScheduled = null;
    this.fetchState.coalescing = null;
    this.lastFetchStartTime = 0;
    this.lastFetchDuration = 0;
    this.lastFetchIdStarted = 0;
    this.lastMutationIdStarted = 0;
    this.mutationInProgress = false;
    this.lastFetchWasAborted = false;
    this.abortFetchesBeforeOrEqual = 0;
    this.currentAbortController = null;
  }

  private flushScheduledFetch(): void {
    if (this.fetchState.scheduled) {
      this.onEvent?.('scheduled-fetch-started');
      const params = this.fetchState.scheduled.params;
      this.fetchState.scheduled = null;

      // Clear any active coalescing window to prevent it from
      // scheduling another fetch while this one is in progress
      if (this.fetchState.coalescing) {
        clearTimeout(this.fetchState.coalescing.timeoutId);
        this.fetchState.coalescing = null;
      }

      // Use coalescing window instead of starting fetch directly
      // This allows subsequent scheduleFetch calls to coalesce
      this.startCoalescingWindow(params);
    }
  }

  private endMutation(id: number): boolean {
    if (id === this.lastMutationIdStarted) {
      this.mutationInProgress = false;

      if (this.onMutationEnd) {
        this.onMutationEnd();
        this.onMutationEnd = null;
      }

      this.flushScheduledFetch();
      return true;
    }

    return false;
  }

  getFetchIsInProgress(): boolean {
    return this.fetchState.inProgress !== null;
  }

  private async startFetch(params: T, startTime: number): Promise<boolean> {
    if (this.fetchState.inProgress) {
      throw new Error('[tsdf] Fetch already in progress');
    }

    const id = getAutoIncrementId();
    this.lastFetchIdStarted = id;

    this.lastFetchWasAborted = false;
    this.fetchState.inProgress = { startTime, onEnd: [], rtuOnEnd: null };
    const prevFetchStartTime = this.lastFetchStartTime;
    this.lastFetchStartTime = startTime;

    const abortController = new AbortController();
    this.currentAbortController = abortController;

    const shouldAbort: () => boolean = () => {
      const abort =
        id !== this.lastFetchIdStarted
        || this.mutationInProgress
        || id <= this.abortFetchesBeforeOrEqual;

      this.lastFetchWasAborted = abort;

      if (abort) {
        abortController.abort();
      }

      return abort;
    };

    if (this.fetchState.realtimeScheduled) {
      clearTimeout(this.fetchState.realtimeScheduled.timeoutId);
      this.fetchState.realtimeScheduled = null;
    }

    const success = await this.fetchFn(
      {
        shouldAbort,
        getStartTime: () => startTime,
        signal: abortController.signal,
      },
      params,
    );

    this.currentAbortController = null;

    if (!this.getFetchIsInProgress()) {
      this.lastFetchStartTime = prevFetchStartTime;
      return false;
    }

    if (success) {
      this.lastFetchDuration = Date.now() - startTime;
    }

    const fetchState = this.getFetchState();
    const { realtimeScheduled, inProgress } = fetchState;

    if (realtimeScheduled) {
      clearTimeout(realtimeScheduled.timeoutId);
      fetchState.realtimeScheduled = null;
    }

    if (!inProgress) return false;

    const onEnd = inProgress.onEnd;
    const rtuOnEnd = inProgress.rtuOnEnd;

    fetchState.inProgress = null;

    if (onEnd.length > 0) {
      for (const cb of onEnd) cb();
    }

    if (rtuOnEnd) {
      rtuOnEnd();
    }

    this.flushScheduledFetch();

    return true;
  }

  private shouldSkipFetch(fetchType: FetchType, startTime: number): boolean {
    if (fetchType === 'lowPriority') {
      if (
        this.fetchState.inProgress
        || this.fetchState.scheduled
        || this.fetchState.coalescing
        || this.mutationInProgress
      ) {
        return true;
      }

      if (this.lastFetchStartTime) {
        const timeSinceLastFetch = startTime - this.lastFetchStartTime;

        if (timeSinceLastFetch < this.lowPriorityThrottleMs) {
          return true;
        }
      }
    }

    return false;
  }

  private shouldScheduleFetch(priority: FetchType, params: T): boolean {
    const shouldSchedule = (() => {
      if (priority === 'lowPriority') return false;

      return this.fetchState.inProgress !== null || this.mutationInProgress;
    })();

    if (shouldSchedule) {
      this.fetchState.scheduled = { params };
    }

    return shouldSchedule;
  }

  private addDelayedRTU(startTime: number, params: T): boolean {
    if (!this.dynamicRealtimeThrottleMs) return false;

    const timeSinceLastFetch =
      startTime - (this.lastFetchStartTime + this.lastFetchDuration);

    const minimumRealtimeInterval = this.dynamicRealtimeThrottleMs(
      this.lastFetchDuration,
    );

    if (timeSinceLastFetch >= minimumRealtimeInterval) return false;

    const delay = minimumRealtimeInterval - timeSinceLastFetch;

    this.fetchState.realtimeScheduled = {
      timeoutId: setTimeout(() => {
        this.fetchState.realtimeScheduled = null;
        this.onEvent?.('scheduled-rt-fetch-started');
        this.scheduleFetch('highPriority', params);
      }, delay),
    };

    return true;
  }

  private scheduleRTU(startTime: number, params: T): boolean {
    if (
      !this.lastFetchDuration
      || !this.lastFetchStartTime
      || !this.dynamicRealtimeThrottleMs
    ) {
      return false;
    }

    if (this.fetchState.realtimeScheduled) return true;

    if (this.fetchState.inProgress) {
      this.fetchState.inProgress.rtuOnEnd = () => {
        this.addDelayedRTU(Date.now(), params);
      };

      return true;
    } else if (this.mutationInProgress) {
      this.onMutationEnd = () => {
        const added = this.addDelayedRTU(Date.now(), params);

        if (!added) {
          this.onEvent?.('scheduled-rt-fetch-started');
          this.scheduleFetch('highPriority', params);
        }
      };

      return true;
    } else {
      if (!this.addDelayedRTU(startTime, params)) return false;
    }

    return true;
  }

  private addOnFetchEnd(cb: () => void): void {
    if (this.fetchState.inProgress) {
      this.fetchState.inProgress.onEnd.push(cb);
    }
  }
}
