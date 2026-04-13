type TimeoutId = ReturnType<typeof setTimeout>;

type StoreFocusLifecycle = {
  onTransportReconnect: () => void;
  reset: () => void;
  dispose: () => void;
};

/** @internal */
export function createStoreFocusLifecycle({
  revalidateOnWindowFocus,
  usesRealTimeUpdates,
  transportReconnectCooldownMs,
  getWindowIsFocused,
  onWindowFocus,
  onWindowFocusRevalidate,
  onTransportReconnectRevalidate,
}: {
  revalidateOnWindowFocus: boolean | (() => boolean) | undefined;
  usesRealTimeUpdates: boolean | undefined;
  transportReconnectCooldownMs: number;
  getWindowIsFocused: () => boolean;
  onWindowFocus: (handler: () => void) => () => void;
  onWindowFocusRevalidate: () => void;
  onTransportReconnectRevalidate: () => void;
}): StoreFocusLifecycle {
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

    if (!revalidateOnWindowFocus || usesRealTimeUpdates) return;

    cleanupFocusListener = onWindowFocus(() => {
      if (isFocusRevalidationEnabled()) {
        onWindowFocusRevalidate();
      }
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
