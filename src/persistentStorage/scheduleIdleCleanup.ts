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
