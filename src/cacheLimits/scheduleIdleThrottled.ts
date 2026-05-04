import { scheduleIdleCleanup } from '../persistentStorage/scheduleIdleCleanup';

/** @internal */
export const CACHE_LIMIT_ENFORCEMENT_THROTTLE_MS: number = 60 * 60 * 1000;

type IdleThrottledScheduler = { schedule(): void; cancel(): void };

/** @internal */
export function createIdleThrottledScheduler(
  throttleMs: number,
  run: () => void,
): IdleThrottledScheduler {
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelIdleRun: (() => void) | null = null;
  let isScheduled = false;
  let lastRunAt = 0;
  let scheduleId = 0;

  function schedule(): void {
    if (isScheduled) return;

    isScheduled = true;
    const currentScheduleId = ++scheduleId;
    const delay = Math.max(0, lastRunAt + throttleMs - Date.now());

    function queueIdleRun(): void {
      cancelIdleRun = scheduleIdleCleanup(() => {
        cancelIdleRun = null;
        if (currentScheduleId !== scheduleId) return;

        isScheduled = false;
        lastRunAt = Date.now();
        run();
      });
    }

    if (delay > 0) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        queueIdleRun();
      }, delay);
      return;
    }

    queueIdleRun();
  }

  function cancel(): void {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (cancelIdleRun) {
      cancelIdleRun();
      cancelIdleRun = null;
    }

    scheduleId++;
    isScheduled = false;
  }

  return { schedule, cancel };
}
