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
  getWindowIsFocused: () => boolean,
  onWindowFocus: (handler: () => void) => () => void,
  onWindowFocusRevalidate: () => void,
  onTransportReconnectRevalidate: () => void,
  debug: FocusLifecycleDebugOptions | undefined,
): StoreFocusLifecycle {
  let cleanupFocusListener: (() => void) | null = null;
  let cleanupReconnectFocusListener: (() => void) | null = null;
  let reconnectCooldownTimeoutId: TimeoutId | null = null;
  let hasPendingReconnectRevalidateOnFocus = false;
  let lastTransportReconnectRevalidateAt = Number.NEGATIVE_INFINITY;

  function clearReconnectFocusListener(): void {
    cleanupReconnectFocusListener?.();
    cleanupReconnectFocusListener = null;
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

  function ensureReconnectFocusListener(): void {
    if (cleanupReconnectFocusListener) return;

    cleanupReconnectFocusListener = onWindowFocus(() => {
      clearReconnectFocusListener();

      if (!hasPendingReconnectRevalidateOnFocus) return;

      hasPendingReconnectRevalidateOnFocus = false;
      runTransportReconnectRevalidate();
    });
  }

  function flushTransportReconnectRevalidate(): void {
    clearReconnectCooldownTimeout();

    if (getWindowIsFocused()) {
      hasPendingReconnectRevalidateOnFocus = false;
      clearReconnectFocusListener();
      runTransportReconnectRevalidate();
      return;
    }

    hasPendingReconnectRevalidateOnFocus = true;
    ensureReconnectFocusListener();
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
    clearReconnectFocusListener();
    clearReconnectCooldownTimeout();
    hasPendingReconnectRevalidateOnFocus = false;
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
    clearReconnectFocusListener();
    clearReconnectCooldownTimeout();
    hasPendingReconnectRevalidateOnFocus = false;
    lastTransportReconnectRevalidateAt = Number.NEGATIVE_INFINITY;
  }

  function onTransportReconnect(): void {
    if (!usesRealTimeUpdates) return;

    if (transportReconnectCooldownMs <= 0) {
      flushTransportReconnectRevalidate();
      return;
    }

    if (hasPendingReconnectRevalidateOnFocus) return;

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
