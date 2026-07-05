/**
 * Schedules a fire-and-forget cleanup callback during idle time.
 * Uses `requestIdleCallback` when available, falls back to `setTimeout(fn, 2000)`.
 */
export function scheduleIdleCleanup(callback: () => void): () => void {
  // eslint-disable-next-line @ls-stack/improved-no-unnecessary-condition -- allow runtime existence check
  if (typeof requestIdleCallback === 'function') {
    const idleCallbackId = requestIdleCallback(() => callback(), {
      timeout: 3000,
    });
    return () => cancelIdleCallback(idleCallbackId);
  } else {
    const timeoutId = setTimeout(callback, 2000);
    return () => clearTimeout(timeoutId);
  }
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
    cancelIdleCleanup = scheduleIdleCleanup(callback);
  }, INITIAL_MAINTENANCE_CLEANUP_DELAY_MS);

  return () => {
    clearTimeout(timeoutId);
    cancelIdleCleanup?.();
  };
}
