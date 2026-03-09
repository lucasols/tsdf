import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SessionOfflineCoordinator } from '../../src/persistentStorage/offline/sessionCoordinator';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';

const publishedMessages: unknown[] = [];

function isOfflineSessionSnapshotMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    Reflect.get(message, 'kind') === 'offline-session-snapshot'
  );
}

type MessageListener = (event: { data: unknown }) => void;

class FakeBroadcastChannel {
  static instancesByChannel = new Map<string, Set<FakeBroadcastChannel>>();

  readonly name: string;
  private readonly listeners = new Set<MessageListener>();

  constructor(name: string) {
    this.name = name;
    const instances =
      FakeBroadcastChannel.instancesByChannel.get(name) ?? new Set();
    instances.add(this);
    FakeBroadcastChannel.instancesByChannel.set(name, instances);
  }

  addEventListener(_type: string, listener: MessageListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: MessageListener): void {
    this.listeners.delete(listener);
  }

  postMessage(message: unknown): void {
    publishedMessages.push(message);

    for (const instance of FakeBroadcastChannel.instancesByChannel.get(
      this.name,
    ) ?? []) {
      if (instance === this) continue;

      for (const listener of instance.listeners) {
        listener({ data: message });
      }
    }
  }

  close(): void {
    FakeBroadcastChannel.instancesByChannel.get(this.name)?.delete(this);
    this.listeners.clear();
  }

  static reset(): void {
    FakeBroadcastChannel.instancesByChannel.clear();
  }
}

describe('offline session coordinator browser tabs sync', () => {
  const originalBroadcastChannel = Reflect.get(globalThis, 'BroadcastChannel');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_INITIAL_TIME);
    localStorage.clear();
    publishedMessages.length = 0;
    FakeBroadcastChannel.reset();
    Reflect.set(globalThis, 'BroadcastChannel', FakeBroadcastChannel);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    localStorage.clear();
    publishedMessages.length = 0;
    FakeBroadcastChannel.reset();
    Reflect.set(globalThis, 'BroadcastChannel', originalBroadcastChannel);
  });

  test('remote offline session snapshots do not echo back to the sender tab', async () => {
    const sessionKey = 'offline-session-echo';
    const firstCoordinator = new SessionOfflineCoordinator({
      sessionKey,
      backend: 'localStorage',
      config: { operations: {} },
    });
    const secondCoordinator = new SessionOfflineCoordinator({
      sessionKey,
      backend: 'localStorage',
      config: { operations: {} },
    });

    publishedMessages.length = 0;

    firstCoordinator.syncStoreData('echo-doc-store', {
      entities: [
        {
          id: `${sessionKey}:echo-doc-store:document`,
          sessionKey,
          storeName: 'echo-doc-store',
          storeType: 'document',
          entityKey: 'document',
          entityKind: 'document',
          pendingMutations: 1,
          syncState: 'pending',
          hasConflict: false,
          createdAt: TEST_INITIAL_TIME,
          updatedAt: TEST_INITIAL_TIME,
        },
      ],
      conflicts: [],
      protectedKeys: [],
    });

    await Promise.resolve();

    expect(
      publishedMessages.filter(isOfflineSessionSnapshotMessage),
    ).toHaveLength(1);
    expect(secondCoordinator.getEntities()).toMatchObject([
      {
        entityKey: 'document',
        pendingMutations: 1,
        storeName: 'echo-doc-store',
      },
    ]);

    firstCoordinator.dispose();
    secondCoordinator.dispose();
  });
});
