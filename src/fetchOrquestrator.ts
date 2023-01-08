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
  disableRealtimeDynamicThrottling?: boolean;
  getDynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
};

export function createFetchOrquestrator<T>({
  fetchFn,
  on,
  mediumPriorityThrottleMs = 10,
  lowPriorityThrottleMs = 200,
  disableRealtimeDynamicThrottling,
  getDynamicRealtimeThrottleMs,
}: CreateFetchOrquestratorOptions<T>) {
  const fetchs: {
    inProgress: { startTime: number; onEnd: (() => void)[] } | false;
    scheduled: { params: T } | null;
    realtimeScheduled: { timeoutId: number } | null;
  } = {
    inProgress: false,
    scheduled: null,
    realtimeScheduled: null,
  };
  let lastMutationStarted = 0;
  let mutationIsInProgress = false;
  let lastFetchStartTime = 0;
  let lastFetchDuration = 0;
  let onMutationEnd: (() => void)[] = [];
  let lastFetchWasAborted = false;

  function setLastFetchDurantion(duration: number) {
    lastFetchDuration = duration;
  }

  function setLastFetchStartTime(startTime: number) {
    lastFetchStartTime = startTime;
  }

  function flushScheduledFetch() {
    if (fetchs.scheduled) {
      on?.('scheduled-fetch-started');
      const params = fetchs.scheduled.params;
      fetchs.scheduled = null;
      startFetch(params, Date.now());
    }
  }

  function startMutation() {
    mutationIsInProgress = true;
    const id = getAutoIncrementId();
    lastMutationStarted = id;

    return () => endMutation(id);
  }

  function endMutation(id: number): boolean {
    if (id === lastMutationStarted) {
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

  async function startFetch(params: T, startTime: number) {
    if (fetchs.inProgress) {
      console.error('fetch already in progress');
      return;
    }

    lastFetchWasAborted = false;
    fetchs.inProgress = { startTime, onEnd: [] };
    const prevFetchStartTime = lastFetchStartTime;
    lastFetchStartTime = startTime;

    function shouldAbort() {
      lastFetchWasAborted = mutationIsInProgress;

      return mutationIsInProgress;
    }

    const success = await fetchFn(
      {
        shouldAbort,
        getStartTime: () => startTime,
      },
      params,
    );

    if (success) {
      // FIX: test: if the fetch has error or was aborted it should not considered in the throttling, consider possible concurrent problems
      lastFetchDuration = Date.now() - startTime;
    } else {
      lastFetchStartTime = prevFetchStartTime;
    }

    if (fetchs.realtimeScheduled) {
      clearTimeout(fetchs.realtimeScheduled.timeoutId);
      fetchs.realtimeScheduled = null;
    }

    const onEnd = fetchs.inProgress.onEnd;

    fetchs.inProgress = false;

    if (onEnd.length > 0) {
      onEnd.forEach((cb) => cb());
    }

    flushScheduledFetch();
  }

  function scheduleFetch(
    fetchType: FetchType,
    params: T,
  ): ScheduleFetchResults {
    const startTime = Date.now();

    if (!disableRealtimeDynamicThrottling && fetchType === 'realtimeUpdate') {
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
      if (fetchs.inProgress) {
        const timeSinceLastFetch = startTime - fetchs.inProgress.startTime;

        if (timeSinceLastFetch < mediumPriorityThrottleMs) {
          return true;
        }
      }
    }

    if (fetchType === 'lowPriority') {
      if (fetchs.inProgress || fetchs.scheduled || mutationIsInProgress) {
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

      return !!fetchs.inProgress || !!mutationIsInProgress;
    })();

    if (shouldSchedule) {
      fetchs.scheduled = { params };
    }

    return shouldSchedule;
  }

  function addDelayedRTU(startTime: number, params: T): boolean {
    if (!getDynamicRealtimeThrottleMs) return false;

    const timeSinceLastFetch =
      startTime - (lastFetchStartTime + lastFetchDuration);

    const minimumRealtimeInterval =
      getDynamicRealtimeThrottleMs(lastFetchDuration);

    if (timeSinceLastFetch >= minimumRealtimeInterval) return false;

    const delay = minimumRealtimeInterval - timeSinceLastFetch;

    fetchs.realtimeScheduled = {
      timeoutId: window.setTimeout(() => {
        fetchs.realtimeScheduled = null;
        startFetch(params, startTime);
        on?.('scheduled-rt-fetch-started');
      }, delay),
    };

    return true;
  }

  function scheduleRTU(startTime: number, params: T): boolean {
    if (
      !lastFetchDuration ||
      !lastFetchStartTime ||
      !getDynamicRealtimeThrottleMs
    ) {
      return false;
    }

    if (fetchs.realtimeScheduled) {
      return true;
    }

    if (fetchs.inProgress) {
      fetchs.inProgress.onEnd.push(() => {
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
    if (fetchs.inProgress) {
      fetchs.inProgress.onEnd.push(cb);
    }
  }

  async function awaitFetch(params: T): Promise<boolean> {
    scheduleFetch('highPriority', params);

    if (fetchs.inProgress) {
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
        !!fetchs.inProgress || !!fetchs.scheduled || !!fetchs.realtimeScheduled
      );
    },
    get fetchIsInProgress() {
      return !!fetchs.inProgress;
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
