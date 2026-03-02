import { onWindowFocus } from '@ls-stack/browser-utils/window';

export function createStoreFocusLifecycle({
  revalidateOnWindowFocus,
  usesRealTimeUpdates,
  getWindowIsFocused,
  onWindowFocusRevalidate,
  onTransportReconnectRevalidate,
}: {
  revalidateOnWindowFocus: boolean | (() => boolean) | undefined;
  usesRealTimeUpdates: boolean | undefined;
  getWindowIsFocused: () => boolean;
  onWindowFocusRevalidate: () => void;
  onTransportReconnectRevalidate: () => void;
}) {
  let cleanupFocusListener: (() => void) | null = null;
  let cleanupReconnectFocusListener: (() => void) | null = null;

  function clearReconnectFocusListener(): void {
    cleanupReconnectFocusListener?.();
    cleanupReconnectFocusListener = null;
  }

  function isFocusRevalidationEnabled(): boolean {
    if (typeof revalidateOnWindowFocus === 'function') {
      return revalidateOnWindowFocus();
    }

    return !!revalidateOnWindowFocus;
  }

  function reset(): void {
    cleanupFocusListener?.();
    cleanupFocusListener = null;
    clearReconnectFocusListener();

    if (!revalidateOnWindowFocus || usesRealTimeUpdates) return;

    cleanupFocusListener = onWindowFocus(() => {
      if (isFocusRevalidationEnabled()) {
        onWindowFocusRevalidate();
      }
    });
  }

  function onTransportReconnect(): void {
    if (!usesRealTimeUpdates) return;

    clearReconnectFocusListener();

    if (getWindowIsFocused()) {
      onTransportReconnectRevalidate();
      return;
    }

    cleanupReconnectFocusListener = onWindowFocus(() => {
      clearReconnectFocusListener();
      onTransportReconnectRevalidate();
    });
  }

  reset();

  return {
    onTransportReconnect,
    reset,
  };
}
