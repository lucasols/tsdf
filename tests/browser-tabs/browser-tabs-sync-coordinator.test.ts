import { expect, test } from 'vitest';

import type { BrowserTabsTabStatusMessage } from '../../src/utils/browserTabsPriority';
import {
  createBrowserTabsCoordinator,
  type BrowserTabsMessageMeta,
  type BrowserTabsTransportFactory,
} from '../../src/utils/browserTabsSync';

function createControlledTransportFactory() {
  let onMessage: ((message: unknown) => void) | null = null;
  const postedMessages: unknown[] = [];

  const transportFactory: BrowserTabsTransportFactory = ({
    onMessage: next,
  }) => {
    onMessage = next;

    return {
      postMessage(message) {
        postedMessages.push(message);
      },
      close() {},
    };
  };

  return {
    transportFactory,
    deliver(message: unknown) {
      onMessage?.(message);
    },
    getPostedMessages() {
      return [...postedMessages];
    },
  };
}

type SyncTestMessage = BrowserTabsMessageMeta & BrowserTabsTabStatusMessage;

function createRemoteStatusMessage(
  seq: number,
  sessionKey = 'test-session',
): SyncTestMessage {
  return {
    kind: 'tab-status',
    protocolVersion: 1,
    storeType: 'document',
    sessionKey,
    tabId: 'remote-tab',
    seq,
    sentAt: seq,
    messageId: `remote-tab:${seq}`,
    isFocused: false,
    lastFocusedAt: 0,
    lastPresenceAt: seq,
  };
}

test('browser tabs coordinator ignores messages from a different session key', () => {
  const transport = createControlledTransportFactory();
  const receivedMessageIds: string[] = [];

  createBrowserTabsCoordinator<SyncTestMessage>({
    storeType: 'document',
    storeKey: 'coordinator-session-mismatch',
    getSessionKey: () => 'account-a',
    transportFactory: transport.transportFactory,
    onMessage(message) {
      receivedMessageIds.push(message.messageId);
    },
  });

  transport.deliver(createRemoteStatusMessage(1, 'account-b'));

  expect(receivedMessageIds).toEqual([]);
});

test('browser tabs coordinator disables publish and receive when session key is false', () => {
  const transport = createControlledTransportFactory();
  const receivedMessageIds: string[] = [];

  const coordinator = createBrowserTabsCoordinator<SyncTestMessage>({
    storeType: 'document',
    storeKey: 'coordinator-no-session',
    getSessionKey: () => false,
    transportFactory: transport.transportFactory,
    onMessage(message) {
      receivedMessageIds.push(message.messageId);
    },
  });

  const published = coordinator.publish({
    kind: 'tab-status',
    isFocused: false,
    lastFocusedAt: 0,
    lastPresenceAt: 0,
  });

  transport.deliver(createRemoteStatusMessage(1));

  expect(published).toBeNull();
  expect(receivedMessageIds).toEqual([]);
  expect(transport.getPostedMessages()).toEqual([]);
});

test('browser tabs coordinator clears duplicate suppression when the session key changes', () => {
  const transport = createControlledTransportFactory();
  const receivedMessageIds: string[] = [];
  let sessionKey: string | false = 'account-a';

  createBrowserTabsCoordinator<SyncTestMessage>({
    storeType: 'document',
    storeKey: 'coordinator-session-switch',
    getSessionKey: () => sessionKey,
    transportFactory: transport.transportFactory,
    onMessage(message) {
      receivedMessageIds.push(message.messageId);
    },
  });

  transport.deliver(createRemoteStatusMessage(1, 'account-a'));
  sessionKey = 'account-b';
  transport.deliver(createRemoteStatusMessage(1, 'account-b'));

  expect(receivedMessageIds).toEqual(['remote-tab:1', 'remote-tab:1']);
});

test('browser tabs coordinator keeps duplicate suppression bounded during long-lived status traffic', () => {
  const OriginalSet = globalThis.Set;
  const OriginalMap = globalThis.Map;

  const trackedSets: Array<{ maxSize: number; size: number }> = [];
  const trackedMaps: Array<{ maxSize: number; size: number }> = [];

  class TrackingSet<T> extends OriginalSet<T> {
    maxSize = this.size;

    constructor(values?: Iterable<T> | null) {
      super(values);
      trackedSets.push(this);
      this.maxSize = this.size;
    }

    override add(value: T): this {
      const result = super.add(value);
      this.maxSize = Math.max(this.maxSize, this.size);
      return result;
    }
  }

  class TrackingMap<K, V> extends OriginalMap<K, V> {
    maxSize = this.size;

    constructor(entries?: Iterable<readonly [K, V]> | null) {
      super(entries);
      trackedMaps.push(this);
      this.maxSize = this.size;
    }

    override set(key: K, value: V): this {
      const result = super.set(key, value);
      this.maxSize = Math.max(this.maxSize, this.size);
      return result;
    }
  }

  const transport = createControlledTransportFactory();
  const receivedMessageIds: string[] = [];
  let maxTrackedSize = 0;
  const TrackingSetCtor: SetConstructor = TrackingSet;
  const TrackingMapCtor: MapConstructor = TrackingMap;

  try {
    globalThis.Set = TrackingSetCtor;
    globalThis.Map = TrackingMapCtor;

    const coordinator = createBrowserTabsCoordinator<SyncTestMessage>({
      storeType: 'document',
      storeKey: 'coordinator-dedupe',
      getSessionKey: () => 'test-session',
      transportFactory: transport.transportFactory,
      onMessage(message) {
        receivedMessageIds.push(message.messageId);
      },
    });

    for (let seq = 1; seq <= 1_000; seq++) {
      transport.deliver(createRemoteStatusMessage(seq));
    }

    transport.deliver(createRemoteStatusMessage(1));
    transport.deliver(createRemoteStatusMessage(1_001));

    maxTrackedSize = Math.max(
      0,
      ...trackedSets.map((instance) => instance.maxSize),
      ...trackedMaps.map((instance) => instance.maxSize),
    );

    coordinator.close();
  } finally {
    globalThis.Set = OriginalSet;
    globalThis.Map = OriginalMap;
  }

  expect(receivedMessageIds).toHaveLength(1_001);
  expect(receivedMessageIds.at(-1)).toBe('remote-tab:1001');
  expect(maxTrackedSize).toBeLessThanOrEqual(8);
});
