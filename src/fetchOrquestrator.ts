export type ShouldAbortFetch = () => boolean;

export type FetchType = 'low' | 'medium' | 'high';

export function createFetchOrquestrator<T>({
  fetchFn,
  on,
  mediumPriorityThrottleMs = 10,
  lowPriorityThrottleMs = 200,
}: {
  fetchFn: (shouldAbort: ShouldAbortFetch, params: T) => Promise<boolean>;
  on?: (event: 'scheduled-fetch-started') => void;
  lowPriorityThrottleMs?: number;
  mediumPriorityThrottleMs?: number;
}) {
  const fetchs: {
    inProgress: { startTime: number } | false;
    scheduled: { params: T } | null;
  } = {
    inProgress: false,
    scheduled: null,
  };
  let lastMutation = 0;
  let mutationIsInProgress = false;
  let lastFetchStartTime = 0;

  function flushScheduledFetch() {
    if (fetchs.scheduled) {
      on?.('scheduled-fetch-started');
      startFetch(fetchs.scheduled.params, Date.now());
      fetchs.scheduled = null;
    }
  }

  function startMutation() {
    mutationIsInProgress = true;
    const id = getAutoIncrementId();
    lastMutation = id;

    return () => endMutation(id);
  }

  function endMutation(id: number) {
    if (id === lastMutation) {
      mutationIsInProgress = false;

      flushScheduledFetch();
    }
  }

  async function startFetch(params: T, startTime: number) {
    fetchs.inProgress = { startTime };
    lastFetchStartTime = startTime;

    function shouldAbort() {
      return mutationIsInProgress;
    }

    await fetchFn(shouldAbort, params);

    fetchs.inProgress = false;
    flushScheduledFetch();
  }

  function scheduleFetch(
    priority: FetchType,
    params: T,
  ): 'skipped' | 'started' | 'scheduled' {
    const startTime = Date.now();

    if (shouldSkipFetch(priority, startTime)) {
      return 'skipped';
    }

    if (shoudScheduleFetch(priority)) {
      fetchs.scheduled = { params };

      return 'scheduled';
    }

    startFetch(params, startTime);

    return 'started';
  }

  function shouldSkipFetch(
    priority: FetchType,
    startTime: number,
  ): boolean {
    if (priority === 'medium') {
      if (fetchs.inProgress) {
        const timeSinceLastFetch = startTime - fetchs.inProgress.startTime;

        if (timeSinceLastFetch < mediumPriorityThrottleMs) {
          return true;
        }
      }
    }

    if (priority === 'low') {
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

  function shoudScheduleFetch(priority: FetchType): boolean {
    if (priority === 'low') {
      return false;
    }

    return !!fetchs.inProgress || !!mutationIsInProgress;
  }

  return {
    scheduleFetch,
    startMutation,
    get hasPendingFetch() {
      return fetchs.inProgress || !!fetchs.scheduled;
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
