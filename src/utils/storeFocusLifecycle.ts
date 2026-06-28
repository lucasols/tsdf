import { emitTSDFDebugLog, type TSDFDebugLogger } from '../debug';

type TimeoutId = ReturnType<typeof setTimeout>;

type StoreFocusLifecycle = {
  onTransportReconnect: () => void;
  reset: () => void;
  dispose: () => void;
};

type FocusLifecycleStoreType = 'collection' | 'document' | 'listQuery';

type FocusLifecycleDebugOptions = {
  debugLogger: TSDFDebugLogger | undefined;
  storeId: string;
  storeType: FocusLifecycleStoreType;
};

/** @internal */
export function createStoreFocusLifecycle(
  revalidateOnWindowFocus: boolean | (() => boolean) | undefined,
  usesRealTimeUpdates: boolean | undefined,
  transportReconnectCooldownMs: number,
  getWindowCanRunRevalidation: () => boolean,
  onWindowFocus: (handler: () => void) => () => void,
  onWindowCanRunRevalidation: (handler: () => void) => () => void,
  onWindowFocusRevalidate: () => void,
  onTransportReconnectRevalidate: () => void,
  debug: FocusLifecycleDebugOptions | undefined,
): StoreFocusLifecycle {
  let cleanupFocusListener: (() => void) | null = null;
  let cleanupReconnectRevalidationListener: (() => void) | null = null;
  let reconnectCooldownTimeoutId: TimeoutId | null = null;
  let hasPendingReconnectRevalidate = false;
  let lastTransportReconnectRevalidateAt = Number.NEGATIVE_INFINITY;

  function clearReconnectRevalidationListener(): void {
    cleanupReconnectRevalidationListener?.();
    cleanupReconnectRevalidationListener = null;
  }

  function clearReconnectCooldownTimeout(): void {
    if (reconnectCooldownTimeoutId !== null) {
      clearTimeout(reconnectCooldownTimeoutId);
      reconnectCooldownTimeoutId = null;
    }
  }

  function isFocusRevalidationEnabled(): boolean {
    if (typeof revalidateOnWindowFocus === 'function') {
      return revalidateOnWindowFocus();
    }

    return !!revalidateOnWindowFocus;
  }

  const logWindowFocusRevalidate =
    import.meta.env.DEV && debug?.debugLogger
      ? (message: string, details: Readonly<Record<string, unknown>>): void => {
          emitTSDFDebugLog(debug.debugLogger, {
            area: 'focus',
            level: 'log',
            message,
            operation: 'window-focus-revalidate',
            details: {
              storeId: debug.storeId,
              storeType: debug.storeType,
              ...details,
            },
          });
        }
      : undefined;

  function runTransportReconnectRevalidate(): void {
    lastTransportReconnectRevalidateAt = Date.now();
    onTransportReconnectRevalidate();
  }

  function ensureReconnectRevalidationListener(): void {
    if (cleanupReconnectRevalidationListener) return;

    cleanupReconnectRevalidationListener = onWindowCanRunRevalidation(() => {
      if (!getWindowCanRunRevalidation()) return;

      clearReconnectRevalidationListener();

      if (!hasPendingReconnectRevalidate) return;

      hasPendingReconnectRevalidate = false;
      runTransportReconnectRevalidate();
    });
  }

  function flushTransportReconnectRevalidate(): void {
    clearReconnectCooldownTimeout();

    if (getWindowCanRunRevalidation()) {
      hasPendingReconnectRevalidate = false;
      clearReconnectRevalidationListener();
      runTransportReconnectRevalidate();
      return;
    }

    hasPendingReconnectRevalidate = true;
    ensureReconnectRevalidationListener();
  }

  function scheduleTrailingTransportReconnectRevalidate(): void {
    clearReconnectCooldownTimeout();

    reconnectCooldownTimeoutId = setTimeout(() => {
      reconnectCooldownTimeoutId = null;
      flushTransportReconnectRevalidate();
    }, transportReconnectCooldownMs);
  }

  function reset(): void {
    cleanupFocusListener?.();
    cleanupFocusListener = null;
    clearReconnectRevalidationListener();
    clearReconnectCooldownTimeout();
    hasPendingReconnectRevalidate = false;
    lastTransportReconnectRevalidateAt = Number.NEGATIVE_INFINITY;

    if (!revalidateOnWindowFocus) return;

    if (usesRealTimeUpdates) {
      logWindowFocusRevalidate?.('window focus revalidation skipped', {
        reason: 'real-time-updates',
        status: 'skipped',
      });
      return;
    }

    cleanupFocusListener = onWindowFocus(() => {
      const enabled = isFocusRevalidationEnabled();

      if (!enabled) {
        logWindowFocusRevalidate?.('window focus revalidation skipped', {
          policy: 'dynamic',
          reason: 'dynamic-disabled',
          status: 'skipped',
        });
        return;
      }

      logWindowFocusRevalidate?.('window focus revalidation triggered', {
        policy:
          typeof revalidateOnWindowFocus === 'function' ? 'dynamic' : 'enabled',
        status: 'triggered',
      });
      onWindowFocusRevalidate();
    });
  }

  function dispose(): void {
    cleanupFocusListener?.();
    cleanupFocusListener = null;
    clearReconnectRevalidationListener();
    clearReconnectCooldownTimeout();
    hasPendingReconnectRevalidate = false;
    lastTransportReconnectRevalidateAt = Number.NEGATIVE_INFINITY;
  }

  function onTransportReconnect(): void {
    if (!usesRealTimeUpdates) return;

    if (transportReconnectCooldownMs <= 0) {
      flushTransportReconnectRevalidate();
      return;
    }

    if (hasPendingReconnectRevalidate) return;

    const now = Date.now();
    const elapsedSinceLastRevalidate = now - lastTransportReconnectRevalidateAt;

    if (elapsedSinceLastRevalidate >= transportReconnectCooldownMs) {
      flushTransportReconnectRevalidate();
      return;
    }

    scheduleTrailingTransportReconnectRevalidate();
  }

  reset();

  return { onTransportReconnect, reset, dispose };
}
