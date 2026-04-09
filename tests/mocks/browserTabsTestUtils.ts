import { klona } from 'klona/json';
import { afterEach } from 'vitest';
import type {
  BrowserTabsTransport,
  BrowserTabsTransportFactory,
} from '../../src/utils/browserTabsSync';

let storeIdCounter = 0;
const activeStoreKeys = new Set<string>();

export function getNextStoreId(prefix = 'browser-tabs-test'): string {
  storeIdCounter += 1;
  return `${prefix}-${storeIdCounter}`;
}

export function registerMockStoreInstance(args: {
  storeId: string;
  storeType: 'document' | 'collection' | 'listQuery';
  testBrowserTabId: string;
}): () => void {
  const registryKey = `${args.testBrowserTabId}::${args.storeType}::${args.storeId}`;

  if (activeStoreKeys.has(registryKey)) {
    throw new Error(
      `[tests] Duplicate ${args.storeType} store "${args.storeId}" created in the same test tab. Reuse the existing env, choose a different id, or bind each env to a different focus controller when simulating multiple tabs.`,
    );
  }

  activeStoreKeys.add(registryKey);
  return () => {
    activeStoreKeys.delete(registryKey);
  };
}

export function resetMockStoreInstanceRegistry(): void {
  activeStoreKeys.clear();
}

afterEach(() => {
  resetMockStoreInstanceRegistry();
});

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
    replayMessage(entry: BrowserTabsTransportAuditEntry): void {
      const listenersForChannel = listenersByChannel.get(entry.channelName);
      if (!listenersForChannel) return;

      for (const listener of listenersForChannel) {
        setTimeout(() => {
          listener(klona(entry.message));
        }, 0);
      }
    },
  };
}

export function createInMemoryBrowserTabsTransportFactory(): BrowserTabsTransportFactory {
  return createInMemoryBrowserTabsTransportFactoryBase().transportFactory;
}

export function createInspectableInMemoryBrowserTabsTransportFactory() {
  return createInMemoryBrowserTabsTransportFactoryBase();
}
