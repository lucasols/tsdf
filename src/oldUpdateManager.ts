import { getAutoIncrementId } from '../autoincrementId';
import { clampMax, clampMin } from '../clamp';
import { mapGetWithFallback } from '../mapGetWithFallback';
import { anyFunction } from '../typings';

// FIX: remove file

type FetchEndStatus = 'commit' | 'schedule' | 'abort';

type FetchController =
  | 'skipFetch'
  | { onSuccess: () => FetchEndStatus; onError: () => void };

type Fetch = {
  count: number;
  isInProgress: boolean;
  scheduled: (() => any) | null;
  backgroupFetchScheduled: (() => any) | false;
  realtimeFetchScheduled: NodeJS.Timeout | false;
  lastDuration: number;
  lastUpdateTimestamp: number;
};

export type UpdateType = 'fetch' | 'forceUpdate' | 'realtimeUpdate';

const singleFetchId = Symbol('singleFetchId');

type FetchId = string | typeof singleFetchId;

type BackGroundUpdateController = {
  isHidden: () => boolean;
  onIsVisible: (cb: anyFunction) => () => void;
  removeOnIsVisible: (cb: anyFunction) => void;
};

const pageVisibilityController: BackGroundUpdateController = {
  isHidden: () => document.visibilityState === 'hidden',
  onIsVisible: (callback) => {
    const isVisibleDecorator = () => {
      if (document.visibilityState === 'visible') {
        callback();
      }
    };

    document.addEventListener('visibilitychange', isVisibleDecorator);

    return isVisibleDecorator;
  },
  removeOnIsVisible: (callback) => {
    document.removeEventListener('visibilitychange', callback);
  },
};

export class ApiStoreUpdateManager {
  private lastMutation = 0;
  private mutationIsInProgress = false;
  private fetchs = new Map<FetchId, Fetch>();

  constructor(
    private skipBackgroundUpdates: boolean,
    private pageVisibility = pageVisibilityController,
  ) {}

  startMutation(): () => void {
    this.mutationIsInProgress = true;
    this.abortAllFetchs();

    const id = getAutoIncrementId();
    this.lastMutation = id;

    return () => this.endMutation(id);
  }

  private endMutation(mutationId: number) {
    if (this.lastMutation === mutationId) {
      this.mutationIsInProgress = false;

      this.flushScheduledFetchs();
    }
  }

  private abortAllFetchs() {
    for (const fetch of this.fetchs.values()) {
      fetch.isInProgress = false;
    }
  }

  private flushScheduledFetchs() {
    for (const fetch of this.fetchs.values()) {
      flushScheduled(fetch);
    }
  }

  startFetch({
    updateType,
    fetchId = singleFetchId,
    retry: performFetch,
  }: {
    updateType: UpdateType;
    fetchId?: FetchId;
    retry: () => any;
  }): FetchController {
    const fetch = mapGetWithFallback(
      this.fetchs,
      fetchId,
      (): Fetch => ({
        count: 0,
        isInProgress: false,
        scheduled: null,
        lastDuration: 0,
        lastUpdateTimestamp: 0,
        backgroupFetchScheduled: false,
        realtimeFetchScheduled: false,
      }),
    );

    if (this.shouldSkipFetch(fetch, updateType, performFetch)) {
      return 'skipFetch';
    }

    fetch.isInProgress = true;
    const count = fetch.count + 1;
    fetch.count = count;

    const fetchStartTimestamp = Date.now();

    return {
      onSuccess: () =>
        this.endFetch(fetch, performFetch, fetchStartTimestamp, count, false),
      onError: () =>
        this.endFetch(fetch, performFetch, fetchStartTimestamp, count, true),
    };
  }

  private endFetch(
    fetch: Fetch,
    performFetch: () => any,
    fetchStartTimestamp: number,
    run: number,
    isError: boolean,
  ): FetchEndStatus {
    if (!isError) {
      fetch.lastDuration = Date.now() - fetchStartTimestamp;
    }

    if (fetch.count !== run) {
      return 'abort';
    }

    if (!fetch.isInProgress) {
      scheduleFetch(fetch, performFetch);

      return 'schedule';
    }

    fetch.isInProgress = false;
    fetch.lastUpdateTimestamp = Date.now();

    flushScheduled(fetch);

    // clean previous scheduled fetchs if they exist
    if (fetch.backgroupFetchScheduled) {
      this.pageVisibility.removeOnIsVisible(fetch.backgroupFetchScheduled);
      fetch.backgroupFetchScheduled = false;
    }

    if (fetch.realtimeFetchScheduled) {
      clearTimeout(fetch.realtimeFetchScheduled);
      fetch.realtimeFetchScheduled = false;
    }

    return 'commit';
  }

  private shouldSkipFetch(
    fetch: Fetch,
    type: UpdateType,
    performFetch: () => any,
  ): boolean {
    if (type === 'realtimeUpdate' || type === 'fetch') {
      if (this.scheduleBackgroundUpdate(fetch, performFetch)) {
        return true;
      }
    }

    if (type === 'realtimeUpdate') {
      if (scheduleRealtimeUpdate(fetch, performFetch)) {
        return true;
      }
    }

    if (this.mutationIsInProgress || fetch.isInProgress) {
      if (type !== 'fetch') {
        scheduleFetch(fetch, performFetch);
      }

      return true;
    }

    return false;
  }

  private scheduleBackgroundUpdate(
    fetch: Fetch,
    performFetch: () => any,
  ): boolean {
    if (fetch.backgroupFetchScheduled) {
      return true;
    }

    if (this.skipBackgroundUpdates && this.pageVisibility.isHidden()) {
      fetch.backgroupFetchScheduled = this.pageVisibility.onIsVisible(() => {
        if (fetch.backgroupFetchScheduled) {
          this.pageVisibility.removeOnIsVisible(fetch.backgroupFetchScheduled);
          fetch.backgroupFetchScheduled = false;
        }

        performFetch();
      });

      return true;
    }
    else {
      return false;
    }
  }
}

function scheduleRealtimeUpdate(
  fetch: Fetch,
  performFetch: () => any,
): boolean {
  if (fetch.realtimeFetchScheduled) {
    return true;
  }

  const timeSinceLastUpdate = Date.now() - fetch.lastUpdateTimestamp;

  const minimumRealtimeInterval = getMinimumRealtimeInterval(fetch);

  if (timeSinceLastUpdate >= minimumRealtimeInterval) return false;

  const interval = minimumRealtimeInterval - timeSinceLastUpdate;

  fetch.realtimeFetchScheduled = setTimeout(() => {
    fetch.realtimeFetchScheduled = false;
    performFetch();
  }, interval);

  return true;
}

function scheduleFetch(fetch: Fetch, performFetch: () => any) {
  fetch.scheduled = performFetch;
}

function flushScheduled(fetch: Fetch) {
  if (fetch.scheduled) {
    setTimeout(() => {
      fetch.scheduled?.();
      fetch.scheduled = null;
    }, 10);
  }
}

// algo explanation https://github.com/Jestor-Tecnologia/main-front/issues/349#issuecomment-908752513
function getMinimumRealtimeInterval(fetch: Fetch): number {
  const t = fetch.lastDuration / 1000;
  const r = 0.4;
  const x = 2.6;

  return clampMax(clampMin(t - r, 0) ** x * 1000, 60_000);
}
