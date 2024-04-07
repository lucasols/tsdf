export type FetchContext = {
  shouldAbort: () => boolean;
  getStartTime: () => number;
};

export type FetchType = 'lowPriority' | 'highPriority' | 'realtimeUpdate';

type Events = 'scheduled-fetch-started' | 'scheduled-rt-fetch-started';

export type ScheduleFetchResults =
  | 'skipped'
  | 'started'
  | 'scheduled'
  | 'rt-scheduled';

export type FetchOrchestrator<T> = ReturnType<
  typeof createFetchOrchestrator<T>
>;

export type CreateFetchOrchestratorOptions<T> = {
  fetchFn: (fetchContext: FetchContext, params: T) => Promise<boolean>;
  on?: (event: Events) => void;
  lowPriorityThrottleMs?: number;
  mediumPriorityThrottleMs?: number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
};

export function createFetchOrchestrator<T>({
  fetchFn,
  on,
  mediumPriorityThrottleMs = 10,
  lowPriorityThrottleMs = 200,
  dynamicRealtimeThrottleMs,
}: CreateFetchOrchestratorOptions<T>) {
  const fetches: {
    inProgress_: {
      startTime: number;
      onEnd: (() => void)[];
      rtuOnEnd: (() => void) | null;
    } | null;
    scheduled_: { params: T } | null;
    realtimeScheduled_: { timeoutId: number } | null;
  } = {
    inProgress_: null,
    scheduled_: null,
    realtimeScheduled_: null,
  };
  let lastMutationIdStarted = 0;
  let lastFetchIdStarted = 0;
  let mutationIsInProgress = false;
  let lastFetchStartTime = 0;
  let lastFetchDuration = 0;
  let onMutationEnd: (() => void) | null = null;
  let lastFetchWasAborted = false;
  let abortFetchesBeforeOrEqual = 0;

  function setLastFetchDuration(duration: number) {
    lastFetchDuration = duration;
  }

  function setLastFetchStartTime(startTime: number) {
    lastFetchStartTime = startTime;
  }

  function flushScheduledFetch() {
    if (fetches.scheduled_) {
      on?.('scheduled-fetch-started');
      const params = fetches.scheduled_.params;
      fetches.scheduled_ = null;
      startFetch(params, Date.now());
    }
  }

  function startMutation() {
    mutationIsInProgress = true;
    abortFetchesBeforeOrEqual = lastFetchIdStarted;
    fetches.inProgress_ = null;

    const id = getAutoIncrementId();
    lastMutationIdStarted = id;

    return () => endMutation(id);
  }

  function endMutation(id: number): boolean {
    if (id === lastMutationIdStarted) {
      mutationIsInProgress = false;

      if (onMutationEnd) {
        onMutationEnd();
        onMutationEnd = null;
      }

      flushScheduledFetch();
      return true;
    }

    return false;
  }

  function getFetches() {
    return fetches;
  }

  async function startFetch(params: T, startTime: number): Promise<boolean> {
    if (fetches.inProgress_) {
      throw new Error('[tsdf] Fetch already in progress');
    }

    const id = getAutoIncrementId();
    lastFetchIdStarted = id;

    lastFetchWasAborted = false;
    fetches.inProgress_ = { startTime, onEnd: [], rtuOnEnd: null };
    const prevFetchStartTime = lastFetchStartTime;
    lastFetchStartTime = startTime;

    function shouldAbort() {
      const abort =
        id !== lastFetchIdStarted ||
        mutationIsInProgress ||
        id <= abortFetchesBeforeOrEqual;

      lastFetchWasAborted = abort;

      return abort;
    }

    if (fetches.realtimeScheduled_) {
      clearTimeout(fetches.realtimeScheduled_.timeoutId);
      fetches.realtimeScheduled_ = null;
    }

    const success = await fetchFn(
      {
        shouldAbort,
        getStartTime: () => startTime,
      },
      params,
    );

    const currentFetches = getFetches();

    if (!currentFetches.inProgress_) {
      lastFetchStartTime = prevFetchStartTime;
      return false;
    }

    if (success) {
      lastFetchDuration = Date.now() - startTime;
    }

    const rtScheduled = fetches.realtimeScheduled_ as {
      timeoutId: number;
    } | null;

    if (rtScheduled) {
      clearTimeout(rtScheduled.timeoutId);
      fetches.realtimeScheduled_ = null;
    }

    const onEnd = currentFetches.inProgress_.onEnd;
    const rtuOnEnd = currentFetches.inProgress_.rtuOnEnd;

    currentFetches.inProgress_ = null;

    if (onEnd.length > 0) {
      onEnd.forEach((cb) => cb());
    }

    if (rtuOnEnd) {
      rtuOnEnd();
    }

    flushScheduledFetch();

    return true;
  }

  function scheduleFetch(
    fetchType: FetchType,
    params: T,
  ): ScheduleFetchResults {
    const startTime = Date.now();

    const fetchTypeToUse = !lastFetchStartTime ? 'highPriority' : fetchType;

    if (dynamicRealtimeThrottleMs && fetchTypeToUse === 'realtimeUpdate') {
      if (scheduleRTU(startTime, params)) {
        return 'rt-scheduled';
      }
    }

    if (shouldSkipFetch(fetchTypeToUse, startTime)) {
      return 'skipped';
    }

    if (shouldScheduleFetch(fetchTypeToUse, params)) {
      return 'scheduled';
    }

    startFetch(params, startTime);

    return 'started';
  }

  function shouldSkipFetch(fetchType: FetchType, startTime: number): boolean {
    if (fetchType === 'highPriority') {
      if (fetches.inProgress_) {
        const timeSinceLastFetch = startTime - fetches.inProgress_.startTime;

        if (timeSinceLastFetch < mediumPriorityThrottleMs) {
          return true;
        }
      }
    }

    if (fetchType === 'lowPriority') {
      if (fetches.inProgress_ || fetches.scheduled_ || mutationIsInProgress) {
        return true;
      }

      if (lastFetchStartTime) {
        const timeSinceLastFetch = startTime - lastFetchStartTime;

        if (timeSinceLastFetch < lowPriorityThrottleMs) {
          return true;
        }
      }
    }

    return false;
  }

  function shouldScheduleFetch(priority: FetchType, params: T): boolean {
    const shouldSchedule = (() => {
      if (priority === 'lowPriority') {
        return false;
      }

      return !!fetches.inProgress_ || !!mutationIsInProgress;
    })();

    if (shouldSchedule) {
      fetches.scheduled_ = { params };
    }

    return shouldSchedule;
  }

  function addDelayedRTU(startTime: number, params: T): boolean {
    if (!dynamicRealtimeThrottleMs) return false;

    const timeSinceLastFetch =
      startTime - (lastFetchStartTime + lastFetchDuration);

    const minimumRealtimeInterval =
      dynamicRealtimeThrottleMs(lastFetchDuration);

    if (timeSinceLastFetch >= minimumRealtimeInterval) return false;

    const delay = minimumRealtimeInterval - timeSinceLastFetch;

    fetches.realtimeScheduled_ = {
      timeoutId: window.setTimeout(() => {
        fetches.realtimeScheduled_ = null;
        on?.('scheduled-rt-fetch-started');
        startFetch(params, Date.now());
      }, delay),
    };

    return true;
  }

  function scheduleRTU(startTime: number, params: T): boolean {
    if (
      !lastFetchDuration ||
      !lastFetchStartTime ||
      !dynamicRealtimeThrottleMs
    ) {
      return false;
    }

    if (fetches.realtimeScheduled_) {
      return true;
    }

    if (fetches.inProgress_) {
      fetches.inProgress_.rtuOnEnd = () => {
        addDelayedRTU(Date.now(), params);
      };

      return true;
    } else if (mutationIsInProgress) {
      onMutationEnd = () => {
        const added = addDelayedRTU(Date.now(), params);

        if (!added) {
          on?.('scheduled-rt-fetch-started');
          scheduleFetch('highPriority', params);
        }
      };

      return true;
    } else {
      if (!addDelayedRTU(startTime, params)) {
        return false;
      }
    }

    return true;
  }

  function addOnFetchEnd(cb: () => void) {
    if (fetches.inProgress_) {
      fetches.inProgress_.onEnd.push(cb);
    }
  }

  async function awaitFetch(params: T): Promise<boolean> {
    scheduleFetch('highPriority', params);

    if (fetches.inProgress_) {
      await new Promise<true>((resolve) => {
        addOnFetchEnd(() => resolve(true));
      });
    }

    return lastFetchWasAborted;
  }

  function reset() {
    fetches.inProgress_ = null;
    fetches.scheduled_ = null;
    fetches.realtimeScheduled_ = null;
    lastFetchStartTime = 0;
    lastFetchDuration = 0;
    lastFetchIdStarted = 0;
    lastMutationIdStarted = 0;
    mutationIsInProgress = false;
    lastFetchWasAborted = false;
    abortFetchesBeforeOrEqual = 0;
  }

  return {
    reset,
    scheduleFetch,
    awaitFetch,
    startMutation,
    get hasPendingFetch() {
      return (
        !!fetches.inProgress_ ||
        !!fetches.scheduled_ ||
        !!fetches.realtimeScheduled_
      );
    },
    get fetchIsInProgress() {
      return !!fetches.inProgress_;
    },
    get mutationIsInProgress() {
      return mutationIsInProgress;
    },
    setLastFetchDuration,
    setLastFetchStartTime,
  };
}

let autoIncrementId = 0;
export function getAutoIncrementId() {
  return ++autoIncrementId;
}
