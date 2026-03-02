import { expect, test } from 'vitest';
import {
  createBrowserTabsCoordinator,
  type BrowserTabsMessageMeta,
  type BrowserTabsTransportFactory,
} from '../../src/utils/browserTabsSync';
import type { BrowserTabsTabStatusMessage } from '../../src/utils/browserTabsPriority';

function createControlledTransportFactory() {
  let onMessage: ((message: unknown) => void) | null = null;

  const transportFactory: BrowserTabsTransportFactory = ({
    onMessage: next,
  }) => {
    onMessage = next;

    return {
      postMessage() {},
      close() {},
    };
  };

  return {
    transportFactory,
    deliver(message: unknown) {
      onMessage?.(message);
    },
  };
}

type SyncTestMessage = BrowserTabsMessageMeta & BrowserTabsTabStatusMessage;

function createRemoteStatusMessage(seq: number): SyncTestMessage {
  return {
    kind: 'tab-status',
    protocolVersion: 1,
    storeType: 'document',
    tabId: 'remote-tab',
    seq,
    sentAt: seq,
    messageId: `remote-tab:${seq}`,
    isFocused: false,
    lastFocusedAt: 0,
    lastPresenceAt: seq,
  };
}

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
