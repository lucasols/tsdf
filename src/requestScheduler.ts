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
  | 'rt-scheduled';

type InProgressState = {
  startTime: number;
  onEnd: (() => void)[];
  rtuOnEnd: (() => void) | null;
};

type ScheduledState<T> = {
  params: T;
};

type RealtimeScheduledState = {
  timeoutId: ReturnType<typeof setTimeout>;
};

type FetchState<T> = {
  inProgress: InProgressState | null;
  scheduled: ScheduledState<T> | null;
  realtimeScheduled: RealtimeScheduledState | null;
};

export type RequestSchedulerOptions<T> = {
  fetchFn: (fetchContext: FetchContext, params: T) => Promise<boolean>;
  on?: (event: RequestSchedulerEvents) => void;
  lowPriorityThrottleMs?: number;
  mediumPriorityThrottleMs?: number;
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
  private readonly mediumPriorityThrottleMs: number;
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
    this.lowPriorityThrottleMs = options.lowPriorityThrottleMs ?? 200;
    this.mediumPriorityThrottleMs = options.mediumPriorityThrottleMs ?? 10;
    this.dynamicRealtimeThrottleMs = options.dynamicRealtimeThrottleMs;

    this.fetchState = {
      inProgress: null,
      scheduled: null,
      realtimeScheduled: null,
    };
  }

  get hasPendingFetch(): boolean {
    return (
      this.fetchState.inProgress !== null ||
      this.fetchState.scheduled !== null ||
      this.fetchState.realtimeScheduled !== null
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

  scheduleFetch(fetchType: FetchType, params: T): ScheduleFetchResults {
    const startTime = Date.now();

    const fetchTypeToUse =
      this.lastFetchStartTime === 0 ? 'highPriority' : fetchType;

    if (
      this.dynamicRealtimeThrottleMs &&
      fetchTypeToUse === 'realtimeUpdate'
    ) {
      if (this.scheduleRTU(startTime, params)) {
        return 'rt-scheduled';
      }
    }

    if (this.shouldSkipFetch(fetchTypeToUse, startTime)) {
      return 'skipped';
    }

    if (this.shouldScheduleFetch(fetchTypeToUse, params)) {
      return 'scheduled';
    }

    this.startFetch(params, startTime);

    return 'started';
  }

  async awaitFetch(params: T): Promise<boolean> {
    this.scheduleFetch('highPriority', params);

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

    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }

    const id = getAutoIncrementId();
    this.lastMutationIdStarted = id;

    return () => this.endMutation(id);
  }

  reset(): void {
    this.fetchState.inProgress = null;
    this.fetchState.scheduled = null;
    this.fetchState.realtimeScheduled = null;
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
      this.startFetch(params, Date.now());
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

    const shouldAbort = (): boolean => {
      const abort =
        id !== this.lastFetchIdStarted ||
        this.mutationInProgress ||
        id <= this.abortFetchesBeforeOrEqual;

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

    if (!this.fetchState.inProgress) {
      this.lastFetchStartTime = prevFetchStartTime;
      return false;
    }

    if (success) {
      this.lastFetchDuration = Date.now() - startTime;
    }

    const rtScheduled: RealtimeScheduledState | null =
      this.fetchState.realtimeScheduled;
    if (rtScheduled) {
      clearTimeout(rtScheduled.timeoutId);
      this.fetchState.realtimeScheduled = null;
    }

    const inProgress = this.fetchState.inProgress;
    const onEnd = inProgress.onEnd;
    const rtuOnEnd = inProgress.rtuOnEnd;

    this.fetchState.inProgress = null;

    if (onEnd.length > 0) {
      onEnd.forEach((cb) => cb());
    }

    if (rtuOnEnd) {
      rtuOnEnd();
    }

    this.flushScheduledFetch();

    return true;
  }

  private shouldSkipFetch(fetchType: FetchType, startTime: number): boolean {
    if (fetchType === 'highPriority') {
      if (this.fetchState.inProgress) {
        const timeSinceLastFetch =
          startTime - this.fetchState.inProgress.startTime;

        if (timeSinceLastFetch < this.mediumPriorityThrottleMs) {
          return true;
        }
      }
    }

    if (fetchType === 'lowPriority') {
      if (
        this.fetchState.inProgress ||
        this.fetchState.scheduled ||
        this.mutationInProgress
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
      if (priority === 'lowPriority') {
        return false;
      }

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
        this.startFetch(params, Date.now());
      }, delay),
    };

    return true;
  }

  private scheduleRTU(startTime: number, params: T): boolean {
    if (
      !this.lastFetchDuration ||
      !this.lastFetchStartTime ||
      !this.dynamicRealtimeThrottleMs
    ) {
      return false;
    }

    if (this.fetchState.realtimeScheduled) {
      return true;
    }

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
      if (!this.addDelayedRTU(startTime, params)) {
        return false;
      }
    }

    return true;
  }

  private addOnFetchEnd(cb: () => void): void {
    if (this.fetchState.inProgress) {
      this.fetchState.inProgress.onEnd.push(cb);
    }
  }
}
