import type { OfflineNetworkModeConfig } from '../../src/persistentStorage/offline/types';

export function createOfflineNetworkMock(initialOnline = true) {
  let online = initialOnline;

  const config: OfflineNetworkModeConfig = {
    enabled: true,
    getIsOffline: () => !online,
  };

  return {
    config,
    install() {
      Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => online,
      });
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
