import { emitTSDFDebugLog, type TSDFDebugLogger } from '../debug';

type TimeoutId = ReturnType<typeof setTimeout>;

type StoreFocusLifecycle = {
  onTransportReconnect: () => void;
  /**
   * The store recovered from offline mode (the session is online, its queued
   * mutations finished replaying and the store has nothing left waiting for
   * a manual resolution): revalidates it. Real-time stores wait one transport
   * reconnect cooldown first, so a transport reconnect in that window runs a
   * single revalidation for both. Reconnect and focus revalidations are
   * dropped while offline, see below.
   */
  onOfflineRecovery: () => void;
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
  /** Revalidation run after a transport reconnect or an offline recovery. */
  onReconnectRevalidate: () => void,
  onWindowFocusReevaluateDelayedRTU: () => void,
  /**
   * Whether the manager's offline session is in offline mode (re-checking
   * connectivity while it is). Revalidations are dropped while it is: they
   * could only fail, and recovering from offline mode revalidates the store
   * anyway (`onOfflineRecovery`).
   */
  getIsOfflineMode: () => boolean,
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
    if (getIsOfflineMode()) return;

    lastTransportReconnectRevalidateAt = Date.now();
    onReconnectRevalidate();
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

    if (usesRealTimeUpdates) {
      if (revalidateOnWindowFocus) {
        logWindowFocusRevalidate?.('window focus revalidation skipped', {
          reason: 'real-time-updates',
          status: 'skipped',
        });
      }

      // Realtime stores skip focus revalidation, but a delayed realtime
      // update priced with the unfocused throttle must be re-evaluated on
      // focus so it fires at the focused cadence instead of keeping the tab
      // stale for the rest of the background window.
      cleanupFocusListener = onWindowFocus(onWindowFocusReevaluateDelayedRTU);
      return;
    }

    if (!revalidateOnWindowFocus) return;

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

      if (getIsOfflineMode()) {
        logWindowFocusRevalidate?.('window focus revalidation skipped', {
          reason: 'offline-mode',
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

  function onOfflineRecovery(): void {
    // Not gated by the last revalidation: whatever was revalidated before the
    // offline period / the replay is stale again. Unfocused tabs still wait
    // for focus.
    if (!usesRealTimeUpdates || transportReconnectCooldownMs <= 0) {
      flushTransportReconnectRevalidate();
      return;
    }

    if (hasPendingReconnectRevalidateOnFocus) return;

    // Real-time apps usually reconnect their transport right after the network
    // comes back, and that reconnect revalidates the store anyway (it has to,
    // updates sent while the transport was down are missed). Waiting one
    // cooldown lets that reconnect flush this revalidation instead of
    // revalidating twice; without a reconnect it runs when the cooldown ends.
    scheduleTrailingTransportReconnectRevalidate();
  }

  reset();

  return { onTransportReconnect, onOfflineRecovery, reset, dispose };
}
