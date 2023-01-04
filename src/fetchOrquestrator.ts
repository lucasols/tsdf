import { clampMax, clampMin } from './utils/math';

export type ShouldAbortFetch = () => boolean;

export type FetchType = 'lowPriority' | 'highPriority' | 'realtimeUpdate';

type Events = 'scheduled-fetch-started' | 'scheduled-rt-fetch-started';

export function createFetchOrquestrator<T>({
  fetchFn,
  on,
  mediumPriorityThrottleMs = 10,
  lowPriorityThrottleMs = 200,
  disableRealtimeDynamicThrottling,
  getDynamicRealtimeThrottleMs,
}: {
  fetchFn: (shouldAbort: ShouldAbortFetch, params: T) => Promise<boolean>;
  on?: (event: Events) => void;
  lowPriorityThrottleMs?: number;
  mediumPriorityThrottleMs?: number;
  disableRealtimeDynamicThrottling?: boolean;
  getDynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
}) {
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

    fetchs.inProgress = { startTime, onEnd: [] };
    lastFetchStartTime = startTime;

    function shouldAbort() {
      return mutationIsInProgress;
    }

    const success = await fetchFn(shouldAbort, params);

    if (success) {
      lastFetchDuration = Date.now() - startTime;
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

  function fetch(
    fetchType: FetchType,
    params: T,
  ): 'skipped' | 'started' | 'scheduled' | 'rt-scheduled' {
    const startTime = Date.now();

    if (!disableRealtimeDynamicThrottling && fetchType === 'realtimeUpdate') {
      if (scheduleRTU(startTime, params)) {
        return 'rt-scheduled';
      }
    }

    if (shouldSkipFetch(fetchType, startTime)) {
      return 'skipped';
    }

    if (scheduleFetch(fetchType, params)) {
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

  function scheduleFetch(priority: FetchType, params: T): boolean {
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
          fetch('highPriority', params);
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

  return {
    fetch,
    startMutation,
    get hasPendingFetch() {
      return (
        fetchs.inProgress || !!fetchs.scheduled || !!fetchs.realtimeScheduled
      );
    },
    get mutationIsInProgress() {
      return mutationIsInProgress;
    },
  };
}

let autoIncrementId = 0;
export function getAutoIncrementId() {
  return ++autoIncrementId;
}
