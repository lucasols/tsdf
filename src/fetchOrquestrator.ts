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

export type FetchOrquestrator<T> = ReturnType<
  typeof createFetchOrquestrator<T>
>;

export type CreateFetchOrquestratorOptions<T> = {
  fetchFn: (fetchContext: FetchContext, params: T) => Promise<boolean>;
  on?: (event: Events) => void;
  lowPriorityThrottleMs?: number;
  mediumPriorityThrottleMs?: number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
};

export function createFetchOrquestrator<T>({
  fetchFn,
  on,
  mediumPriorityThrottleMs = 10,
  lowPriorityThrottleMs = 200,
  dynamicRealtimeThrottleMs,
}: CreateFetchOrquestratorOptions<T>) {
  const fetchs: {
    inProgress_: { startTime: number; onEnd: (() => void)[] } | null;
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
  let onMutationEnd: (() => void)[] = [];
  let lastFetchWasAborted = false;
  let abortFetchsBeforeOrEqual = 0;

  function setLastFetchDurantion(duration: number) {
    lastFetchDuration = duration;
  }

  function setLastFetchStartTime(startTime: number) {
    lastFetchStartTime = startTime;
  }

  function flushScheduledFetch() {
    if (fetchs.scheduled_) {
      on?.('scheduled-fetch-started');
      const params = fetchs.scheduled_.params;
      fetchs.scheduled_ = null;
      startFetch(params, Date.now());
    }
  }

  function startMutation() {
    mutationIsInProgress = true;
    abortFetchsBeforeOrEqual = lastFetchIdStarted;
    fetchs.inProgress_ = null;

    const id = getAutoIncrementId();
    lastMutationIdStarted = id;

    return () => endMutation(id);
  }

  function endMutation(id: number): boolean {
    if (id === lastMutationIdStarted) {
      mutationIsInProgress = false;

      if (onMutationEnd.length > 0) {
        onMutationEnd.forEach((cb) => cb());
        onMutationEnd = [];
      }

      flushScheduledFetch();
      return true;
    }

    return false;
  }

  function getFetchs() {
    return fetchs;
  }

  async function startFetch(params: T, startTime: number): Promise<boolean> {
    if (fetchs.inProgress_) {
      throw new Error('[tsdf] Fetch already in progress');
    }

    const id = getAutoIncrementId();
    lastFetchIdStarted = id;

    lastFetchWasAborted = false;
    fetchs.inProgress_ = { startTime, onEnd: [] };
    const prevFetchStartTime = lastFetchStartTime;
    lastFetchStartTime = startTime;

    function shouldAbort() {
      const abort =
        id !== lastFetchIdStarted ||
        mutationIsInProgress ||
        id <= abortFetchsBeforeOrEqual;

      lastFetchWasAborted = abort;

      return abort;
    }

    const success = await fetchFn(
      {
        shouldAbort,
        getStartTime: () => startTime,
      },
      params,
    );

    const currentFetchs = getFetchs();

    if (!currentFetchs.inProgress_) {
      lastFetchStartTime = prevFetchStartTime;
      return false;
    }

    if (success) {
      lastFetchDuration = Date.now() - startTime;
    }

    if (currentFetchs.realtimeScheduled_) {
      clearTimeout(currentFetchs.realtimeScheduled_.timeoutId);
      fetchs.realtimeScheduled_ = null;
    }

    const onEnd = currentFetchs.inProgress_.onEnd;

    currentFetchs.inProgress_ = null;

    if (onEnd.length > 0) {
      onEnd.forEach((cb) => cb());
    }

    flushScheduledFetch();

    return true;
  }

  function scheduleFetch(
    fetchType: FetchType,
    params: T,
  ): ScheduleFetchResults {
    const startTime = Date.now();

    if (dynamicRealtimeThrottleMs && fetchType === 'realtimeUpdate') {
      if (scheduleRTU(startTime, params)) {
        return 'rt-scheduled';
      }
    }

    if (shouldSkipFetch(fetchType, startTime)) {
      return 'skipped';
    }

    if (shouldScheduleFetch(fetchType, params)) {
      return 'scheduled';
    }

    startFetch(params, startTime);

    return 'started';
  }

  function shouldSkipFetch(fetchType: FetchType, startTime: number): boolean {
    if (fetchType === 'highPriority') {
      if (fetchs.inProgress_) {
        const timeSinceLastFetch = startTime - fetchs.inProgress_.startTime;

        if (timeSinceLastFetch < mediumPriorityThrottleMs) {
          return true;
        }
      }
    }

    if (fetchType === 'lowPriority') {
      if (fetchs.inProgress_ || fetchs.scheduled_ || mutationIsInProgress) {
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

      return !!fetchs.inProgress_ || !!mutationIsInProgress;
    })();

    if (shouldSchedule) {
      fetchs.scheduled_ = { params };
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

    fetchs.realtimeScheduled_ = {
      timeoutId: window.setTimeout(() => {
        fetchs.realtimeScheduled_ = null;
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

    if (fetchs.realtimeScheduled_) {
      return true;
    }

    if (fetchs.inProgress_) {
      fetchs.inProgress_.onEnd.push(() => {
        addDelayedRTU(Date.now(), params);
      });

      return true;
    } else if (mutationIsInProgress) {
      onMutationEnd.push(() => {
        const added = addDelayedRTU(Date.now(), params);

        if (!added) {
          on?.('scheduled-rt-fetch-started');
          scheduleFetch('highPriority', params);
        }
      });

      return true;
    } else {
      if (!addDelayedRTU(startTime, params)) {
        return false;
      }
    }

    return true;
  }

  function addOnFetchEnd(cb: () => void) {
    if (fetchs.inProgress_) {
      fetchs.inProgress_.onEnd.push(cb);
    }
  }

  async function awaitFetch(params: T): Promise<boolean> {
    scheduleFetch('highPriority', params);

    if (fetchs.inProgress_) {
      await new Promise<true>((resolve) => {
        addOnFetchEnd(() => resolve(true));
      });
    }

    return lastFetchWasAborted;
  }

  return {
    scheduleFetch,
    awaitFetch,
    startMutation,
    get hasPendingFetch() {
      return (
        !!fetchs.inProgress_ || !!fetchs.scheduled_ || !!fetchs.realtimeScheduled_
      );
    },
    get fetchIsInProgress() {
      return !!fetchs.inProgress_;
    },
    get mutationIsInProgress() {
      return mutationIsInProgress;
    },
    setLastFetchDurantion,
    setLastFetchStartTime,
  };
}

let autoIncrementId = 0;
export function getAutoIncrementId() {
  return ++autoIncrementId;
}
