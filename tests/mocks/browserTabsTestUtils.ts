import { klona } from 'klona/json';
import type {
  BrowserTabsTransport,
  BrowserTabsTransportFactory,
} from '../../src/utils/browserTabsSync';

let storeIdCounter = 0;

export function getNextStoreId(prefix = 'browser-tabs-test'): string {
  storeIdCounter += 1;
  return `${prefix}-${storeIdCounter}`;
}

export type BrowserTabsTransportAuditEntry = {
  channelName: string;
  message: unknown;
};

function createInMemoryBrowserTabsTransportFactoryBase() {
  const listenersByChannel = new Map<string, Set<(message: unknown) => void>>();
  const auditLog: BrowserTabsTransportAuditEntry[] = [];

  const transportFactory: BrowserTabsTransportFactory = ({
    channelName,
    onMessage,
  }): BrowserTabsTransport => {
    const listeners = listenersByChannel.get(channelName) ?? new Set();
    listeners.add(onMessage);
    listenersByChannel.set(channelName, listeners);

    return {
      postMessage(message) {
        auditLog.push({ channelName, message: klona(message) });

        const listenersForChannel = listenersByChannel.get(channelName);
        if (!listenersForChannel) return;

        for (const listener of listenersForChannel) {
          // Real BroadcastChannel does not deliver messages to the sender
          if (listener === onMessage) continue;

          setTimeout(() => {
            listener(klona(message));
          }, 0);
        }
      },
      close() {
        const listenersForChannel = listenersByChannel.get(channelName);
        if (!listenersForChannel) return;

        listenersForChannel.delete(onMessage);
        if (listenersForChannel.size === 0) {
          listenersByChannel.delete(channelName);
        }
      },
    };
  };

  return {
    transportFactory,
    getMessages(channelName?: string): BrowserTabsTransportAuditEntry[] {
      if (!channelName) {
        return [...auditLog];
      }

      return auditLog.filter((entry) => entry.channelName === channelName);
    },
  };
}

export function createInMemoryBrowserTabsTransportFactory(): BrowserTabsTransportFactory {
  return createInMemoryBrowserTabsTransportFactoryBase().transportFactory;
}

export function createInspectableInMemoryBrowserTabsTransportFactory() {
  return createInMemoryBrowserTabsTransportFactoryBase();
}
