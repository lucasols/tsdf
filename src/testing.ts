import type { OfflineNetworkModeConfig } from './persistentStorage/offline/types';

/**
 * Deterministic replacement for the browser network status read by an offline
 * session. Created by {@link createOfflineNetworkMock}.
 */
export type OfflineNetworkMock = {
  /**
   * Ready-to-use `offlineSession.network` config that reads the mocked status
   * (`{ enabled: true, getIsOffline }`). Optional: sessions that use the
   * default browser detection only need {@link OfflineNetworkMock.install}.
   */
  config: OfflineNetworkModeConfig;
  /**
   * Makes `navigator.onLine` report the mocked status, so the default network
   * detection and any app code reading it see the same value. Requires a DOM
   * test environment (`happy-dom`, `jsdom` or a real browser).
   */
  install: () => void;
  /** Restores the `navigator.onLine` that was in place before `install()`. */
  uninstall: () => void;
  /** Whether the mocked network is currently online. */
  isOnline: () => boolean;
  /** Whether the mocked network is currently offline. */
  isOffline: () => boolean;
  /**
   * Sets the status to online without notifying anyone, like a connection
   * change the browser did not report. Use it to prepare the status before the
   * app boots; the session picks it up on its next network check.
   */
  setOnline: () => void;
  /** Same as `setOnline()`, but sets the status to offline. */
  setOffline: () => void;
  /**
   * Goes online and dispatches the window `online` event, like a real
   * reconnect: the offline session recovers and replays queued work.
   */
  goOnline: () => void;
  /**
   * Goes offline and dispatches the window `offline` event, like a real
   * connection loss.
   */
  goOffline: () => void;
};

/**
 * Creates a mock of the network status an offline session reads, so tests can
 * deterministically go offline and back online.
 *
 * It has no dependency on a test runner. Call `install()` before the code
 * under test reads the network status (e.g. in `beforeEach`) and `uninstall()`
 * when the test is done.
 *
 * @param initialOnline - Initial status. Defaults to online.
 *
 * @example
 * const network = createOfflineNetworkMock();
 *
 * beforeEach(() => network.install());
 * afterEach(() => network.uninstall());
 *
 * test('queues the edit while offline', async () => {
 *   network.goOffline();
 *   // ...perform the mutation, assert it was queued
 *   network.goOnline();
 *   // ...assert it was replayed
 * });
 */
export function createOfflineNetworkMock(
  initialOnline = true,
): OfflineNetworkMock {
  let online = initialOnline;
  let isInstalled = false;
  let previousOnLineDescriptor: PropertyDescriptor | undefined;

  return {
    config: { enabled: true, getIsOffline: () => !online },
    install() {
      if (!isInstalled) {
        isInstalled = true;
        previousOnLineDescriptor = Object.getOwnPropertyDescriptor(
          window.navigator,
          'onLine',
        );
      }

      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => online,
      });
    },
    uninstall() {
      if (!isInstalled) return;
      isInstalled = false;

      if (previousOnLineDescriptor) {
        Object.defineProperty(
          window.navigator,
          'onLine',
          previousOnLineDescriptor,
        );
      } else {
        // `onLine` normally lives on the Navigator prototype, so removing the
        // own property brings the real value back.
        Reflect.deleteProperty(window.navigator, 'onLine');
      }
    },
    isOnline() {
      return online;
    },
    isOffline() {
      return !online;
    },
    setOnline() {
      online = true;
    },
    setOffline() {
      online = false;
    },
    goOnline() {
      online = true;
      window.dispatchEvent(new Event('online'));
    },
    goOffline() {
      online = false;
      window.dispatchEvent(new Event('offline'));
    },
  };
}
