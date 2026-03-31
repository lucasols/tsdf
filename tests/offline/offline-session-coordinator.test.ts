import { afterEach, beforeEach, expect, test, vi } from 'vitest';

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
  readonly #listeners = new Set<MessageListener>();

  constructor(name: string) {
    this.name = name;
    const instances =
      FakeBroadcastChannel.instancesByChannel.get(name) ?? new Set();
    instances.add(this);
    FakeBroadcastChannel.instancesByChannel.set(name, instances);
  }

  addEventListener(_type: string, listener: MessageListener): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: string, listener: MessageListener): void {
    this.#listeners.delete(listener);
  }

  postMessage(message: unknown): void {
    publishedMessages.push(message);

    for (const instance of FakeBroadcastChannel.instancesByChannel.get(
      this.name,
    ) ?? []) {
      if (instance === this) continue;

      for (const listener of instance.#listeners) {
        listener({ data: message });
      }
    }
  }

  close(): void {
    FakeBroadcastChannel.instancesByChannel.get(this.name)?.delete(this);
    this.#listeners.clear();
  }

  static reset(): void {
    FakeBroadcastChannel.instancesByChannel.clear();
  }
}

const originalBroadcastChannel = Reflect.get(globalThis, 'BroadcastChannel');

async function flushMicrotasks(turns = 2): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve();
  }
}

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
    adapter: 'local-sync',
    config: { operations: {} },
  });
  const secondCoordinator = new SessionOfflineCoordinator({
    sessionKey,
    adapter: 'local-sync',
    config: { operations: {} },
  });

  publishedMessages.length = 0;

  // Publish a local store update and let the broadcast reach the other tab.
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
        requiresResolution: false,
        blockedByResolutionIds: [],
        childResolutionIds: [],
        blockedResolutionCount: 0,
        childResolutionCount: 0,
        createdAt: TEST_INITIAL_TIME,
        updatedAt: TEST_INITIAL_TIME,
      },
    ],
    resolutions: [],
    protectedKeys: [],
  });

  await flushMicrotasks();

  const [broadcastMessage] = publishedMessages.filter(
    isOfflineSessionSnapshotMessage,
  );
  expect(publishedMessages).toHaveLength(1);
  expect(broadcastMessage).toBeDefined();
  expect(broadcastMessage).toMatchObject({
    kind: 'offline-session-snapshot',
    protocolVersion: 1,
    sessionKey,
    sentAt: TEST_INITIAL_TIME,
    storeType: 'offline',
  });
  expect(secondCoordinator.getEntities()).toMatchObject([
    { entityKey: 'document', pendingMutations: 1, storeName: 'echo-doc-store' },
  ]);

  firstCoordinator.dispose();
  secondCoordinator.dispose();
});

test('the latest async network check wins when an earlier request settles later', async () => {
  const resolvers: Array<(result: boolean) => void> = [];
  const coordinator = new SessionOfflineCoordinator({
    sessionKey: 'offline-session-network-race',
    adapter: 'local-sync',
    config: {
      network: {
        enabled: true,
        listenToBrowserEvents: false,
        getIsOffline: () =>
          new Promise<boolean>((resolve) => {
            resolvers.push(resolve);
          }),
      },
      operations: {},
    },
  });

  // Resolve the bootstrap probe so the test can isolate the explicit race below.
  for (const resolve of resolvers.splice(0)) {
    resolve(false);
  }
  await flushMicrotasks();

  const firstRefresh = coordinator.refreshNetworkState();
  const secondRefresh = coordinator.refreshNetworkState();
  const [resolveFirst, resolveSecond] = resolvers.splice(0, 2);
  if (!resolveFirst || !resolveSecond) {
    throw new Error('Expected both refresh probes to be pending');
  }

  // The newer probe settles first and establishes the final state.
  resolveSecond(false);
  await flushMicrotasks();

  expect(coordinator.getStatus()).toMatchObject({
    effectiveOffline: false,
    network: { active: false, enabled: true },
  });

  // The stale probe resolves later, but it should not be able to overwrite the newer result.
  resolveFirst(true);
  await expect(secondRefresh).resolves.toBe(false);
  await expect(firstRefresh).resolves.toBe(false);

  expect(coordinator.getStatus()).toMatchObject({
    effectiveOffline: false,
    network: { active: false, enabled: true },
  });

  coordinator.dispose();
});

test('recovery probes continue after recoveryCheck rejects', async () => {
  const recoveryCheck = vi
    .fn<({ sessionKey }: { sessionKey: string }) => Promise<boolean>>()
    .mockRejectedValueOnce(new Error('probe failed'))
    .mockResolvedValueOnce(true);
  const coordinator = new SessionOfflineCoordinator({
    sessionKey: 'offline-session-recovery-retry',
    adapter: 'local-sync',
    config: {
      outage: {
        enabled: true,
        classifyFailure: () => 'outage',
        recoveryCheck,
        recoveryProbe: {
          intervalMs: 50,
          maxIntervalMs: 50,
          backoffMultiplier: 1,
          jitterRatio: 0,
        },
      },
      operations: {},
    },
  });
  const unregister = coordinator.registerStore({
    storeName: 'offline-session-recovery-doc',
  });

  // A failed probe should still mark the outage as active and keep retrying.
  coordinator.setOutageActive(true);
  await vi.advanceTimersByTimeAsync(60);
  await flushMicrotasks();

  expect(recoveryCheck).toHaveBeenCalledTimes(1);
  expect(coordinator.getStatus().outage.active).toBe(true);

  await vi.advanceTimersByTimeAsync(60);
  await flushMicrotasks();

  expect(recoveryCheck).toHaveBeenCalledTimes(2);
  expect(coordinator.getStatus().outage.active).toBe(false);

  unregister();
  coordinator.dispose();
});

test('recovery probes stop once the last store unregisters', async () => {
  const recoveryCheck = vi
    .fn<({ sessionKey }: { sessionKey: string }) => boolean>()
    .mockReturnValue(false);
  const coordinator = new SessionOfflineCoordinator({
    sessionKey: 'offline-session-probe-cleanup',
    adapter: 'local-sync',
    config: {
      outage: {
        enabled: true,
        classifyFailure: () => 'outage',
        recoveryCheck,
        recoveryProbe: {
          intervalMs: 50,
          maxIntervalMs: 50,
          backoffMultiplier: 1,
          jitterRatio: 0,
        },
      },
      operations: {},
    },
  });
  const unregister = coordinator.registerStore({
    storeName: 'offline-session-probe-cleanup-doc',
  });

  // Start recovery probing while the store is registered.
  coordinator.setOutageActive(true);
  await vi.advanceTimersByTimeAsync(60);
  await flushMicrotasks();

  const firstRecoveryCheckAt = coordinator.getStatus().lastRecoveryCheckAt;
  expect(recoveryCheck).toHaveBeenCalledTimes(1);
  expect(firstRecoveryCheckAt).not.toBeNull();

  // Once the last store unregisters, the coordinator should stop scheduling retries.
  unregister();
  await vi.advanceTimersByTimeAsync(200);
  await flushMicrotasks();

  expect(recoveryCheck).toHaveBeenCalledTimes(1);
  expect(coordinator.getStatus()).toMatchObject({
    outage: { active: true, enabled: true },
    lastRecoveryCheckAt: firstRecoveryCheckAt,
  });

  coordinator.dispose();
});
