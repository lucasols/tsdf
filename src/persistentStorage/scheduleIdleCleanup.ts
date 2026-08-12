const FALLBACK_IDLE_BUDGET_MS = 12;
const MIN_IDLE_TIME_REMAINING_MS = 1;

function getMonotonicNow(): number {
  return performance.now();
}

export type IdleCleanupDeadline = {
  readonly didTimeout: boolean;
  timeRemaining(): number;
};

/**
 * Timeout-fired idle callbacks and the timer fallback do not receive a usable
 * browser deadline. Give those ordinary tasks a small synthetic budget so
 * maintenance still yields instead of running to completion on a busy page.
 */
function normalizeIdleDeadline(
  deadline: IdleCleanupDeadline | undefined,
): IdleCleanupDeadline {
  if (deadline !== undefined && !deadline.didTimeout) return deadline;

  const startedAt = getMonotonicNow();
  return {
    didTimeout: true,
    timeRemaining: () =>
      Math.max(0, FALLBACK_IDLE_BUDGET_MS - (getMonotonicNow() - startedAt)),
  };
}

/**
 * Schedules a fire-and-forget cleanup callback during idle time.
 * Uses `requestIdleCallback` when available, falling back to a timer-backed
 * synthetic 12 ms deadline.
 */
export function scheduleIdleCleanup(
  callback: (deadline: IdleCleanupDeadline) => void,
): () => void {
  // eslint-disable-next-line @ls-stack/improved-no-unnecessary-condition -- allow runtime existence check
  if (typeof requestIdleCallback === 'function') {
    const idleCallbackId = requestIdleCallback(
      (deadline) => callback(normalizeIdleDeadline(deadline)),
      { timeout: 3000 },
    );
    return () => cancelIdleCallback(idleCallbackId);
  } else {
    const timeoutId = setTimeout(
      () => callback(normalizeIdleDeadline(undefined)),
      2000,
    );
    return () => clearTimeout(timeoutId);
  }
}

export type IdleCleanupContext = {
  cancel(): void;
  getContinuationCount(): number;
  isCanceled(): boolean;
  shouldYield(): boolean;
  yieldIfNeeded(): Promise<boolean>;
};

/**
 * Tracks the current idle deadline and schedules cancellable continuations
 * when a maintenance pass exhausts it.
 */
export function createIdleCleanupContext(
  initialDeadline: IdleCleanupDeadline,
): IdleCleanupContext {
  let currentDeadline = initialDeadline;
  let continuationCount = 0;
  let canceled = false;
  let cancelContinuation: (() => void) | null = null;
  let resolveContinuation:
    | ((deadline: IdleCleanupDeadline | null) => void)
    | null = null;

  return {
    cancel() {
      if (canceled) return;

      canceled = true;
      cancelContinuation?.();
      cancelContinuation = null;
      resolveContinuation?.(null);
      resolveContinuation = null;
    },
    getContinuationCount: () => continuationCount,
    isCanceled: () => canceled,
    shouldYield: () =>
      canceled || currentDeadline.timeRemaining() <= MIN_IDLE_TIME_REMAINING_MS,
    async yieldIfNeeded(): Promise<boolean> {
      if (canceled) return false;
      if (currentDeadline.timeRemaining() > MIN_IDLE_TIME_REMAINING_MS) {
        return true;
      }

      const nextDeadline = await new Promise<IdleCleanupDeadline | null>(
        (resolve) => {
          resolveContinuation = resolve;
          cancelContinuation = scheduleIdleCleanup(resolve);
        },
      );
      cancelContinuation = null;
      resolveContinuation = null;

      if (nextDeadline === null) return false;
      currentDeadline = nextDeadline;
      continuationCount++;
      return true;
    },
  };
}

export const INITIAL_MAINTENANCE_CLEANUP_DELAY_MS = 10_000;

/**
 * Gives startup maintenance a short grace period before using the regular
 * idle cleanup scheduling.
 */
export function scheduleInitialMaintenanceCleanup(
  callback: () => void,
): () => void {
  // eslint-disable-next-line @ls-stack/improved-no-unnecessary-condition -- allow runtime existence check
  if (typeof requestIdleCallback !== 'function') {
    const timeoutId = setTimeout(
      callback,
      INITIAL_MAINTENANCE_CLEANUP_DELAY_MS + 2000,
    );
    return () => clearTimeout(timeoutId);
  }

  let cancelIdleCleanup: (() => void) | null = null;
  const timeoutId = setTimeout(() => {
    cancelIdleCleanup = scheduleIdleCleanup(() => callback());
  }, INITIAL_MAINTENANCE_CLEANUP_DELAY_MS);

  return () => {
    clearTimeout(timeoutId);
    cancelIdleCleanup?.();
  };
}
