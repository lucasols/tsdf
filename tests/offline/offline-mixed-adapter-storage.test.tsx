import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  getGlobalOfflineEntities,
  type GlobalOfflineEntity,
  useGlobalOfflineEntities,
} from '../../src/main';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { createStoreManager } from '../../src/storeManager';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import {
  flushAllTimers,
  pick,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import type { UpdateValueOperations } from './offlineReplayTestShared';
import { docMutationInputSchema, docSchema } from './offlineTestShared';

const mixedSessionKey = 'mixed-adapter-storage-session';
const localStoreName = 'mixed-local-doc';
const opfsStoreName = 'mixed-opfs-doc';
const localOptimisticValue = 2;
const opfsOptimisticValue = 3;

let network = createOfflineNetworkMock();
let didCreateOpfsPersistentStore = false;

function createSharedStoreManager(sessionKey: string) {
  return createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: network.config },
  });
}

function ensureOpfsPersistentStorageTestStore(): void {
  if (didCreateOpfsPersistentStore) return;

  createOpfsPersistentStorageTestStore();
  didCreateOpfsPersistentStore = true;
}

type MixedAdapter = 'local-sync' | typeof opfsPersistentStorage;

function createMixedOfflineDocumentEnv({
  adapter,
  initialValue,
  storeManager,
  sessionKey,
  storeName,
  testScenario,
}: {
  adapter: MixedAdapter;
  initialValue: number;
  storeManager: ReturnType<typeof createSharedStoreManager>;
  sessionKey: string;
  storeName: string;
  testScenario: 'idle' | 'loaded';
}) {
  if (adapter === opfsPersistentStorage) {
    ensureOpfsPersistentStorageTestStore();
  }

  const envRef: {
    current: ReturnType<
      typeof createDocumentStoreTestEnv<number, UpdateValueOperations>
    > | null;
  } = { current: null };

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(
    initialValue,
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager,
      testScenario,
      persistentStorage: {
        adapter,
        schema: docSchema,
        offline: {
          operations: {
            updateValue: {
              inputSchema: docMutationInputSchema,
              kind: 'update',
              execute: async ({ input }) => {
                await envRef.current?.serverMock.delayedSetData(input.value);
                return input;
              },
              onSuccessExecute: ({ input }) => {
                envRef.current?.apiStore.updateState((draft) => {
                  draft.value = input.value;
                });
              },
            },
          },
        },
      },
    },
  );

  envRef.current = env;

  return env;
}

async function seedMixedOfflineSession() {
  const storeManager = createSharedStoreManager(mixedSessionKey);

  // The first app run starts disconnected so both stores persist queued work
  // through their real offline storage adapters instead of reaching the server.
  network.setOffline();

  const localEnv = createMixedOfflineDocumentEnv({
    adapter: 'local-sync',
    initialValue: 1,
    storeManager,
    sessionKey: mixedSessionKey,
    storeName: localStoreName,
    testScenario: 'loaded',
  });
  const opfsEnv = createMixedOfflineDocumentEnv({
    adapter: opfsPersistentStorage,
    initialValue: 1,
    storeManager,
    sessionKey: mixedSessionKey,
    storeName: opfsStoreName,
    testScenario: 'loaded',
  });

  // The local-sync store queues its own optimistic document change.
  await resolveAfterAllTimers(
    localEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        localEnv.apiStore.updateState((draft) => {
          draft.value = localOptimisticValue;
        });
      },
      mutation: async () => {
        await localEnv.serverMock.delayedSetData(localOptimisticValue);
        return localOptimisticValue;
      },
      offline: {
        operation: 'updateValue',
        input: { value: localOptimisticValue },
      },
    }),
  );

  // The OPFS-backed store queues a different optimistic value so any leakage
  // between adapters becomes obvious in the hydrated UI.
  await resolveAfterAllTimers(
    opfsEnv.apiStore.performMutation({
      optimisticUpdate: () => {
        opfsEnv.apiStore.updateState((draft) => {
          draft.value = opfsOptimisticValue;
        });
      },
      mutation: async () => {
        await opfsEnv.serverMock.delayedSetData(opfsOptimisticValue);
        return opfsOptimisticValue;
      },
      offline: {
        operation: 'updateValue',
        input: { value: opfsOptimisticValue },
      },
    }),
  );

  await flushAllTimers();

  return { localEnv, opfsEnv };
}

function summarizeOfflineEntities(
  entities: readonly GlobalOfflineEntity[],
): Array<Record<string, unknown>> {
  return entities.map((entity) =>
    pick(entity, ['pendingMutations', 'sessionKey', 'storeName', 'syncState']),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  didCreateOpfsPersistentStore = false;
  resetSessionForTests({ clearStorage: true });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  didCreateOpfsPersistentStore = false;
  resetSessionForTests({ clearStorage: true });
});

test('mixed adapters persist independent offline document state in one shared session', async () => {
  const { localEnv, opfsEnv } = await seedMixedOfflineSession();

  // Each document screen should keep showing only its own optimistic value
  // while the shared session aggregate reports both pending documents.
  const localHook = renderHook(() =>
    localEnv.apiStore.useDocument({ returnRefetchingStatus: true }),
  );
  const opfsHook = renderHook(() =>
    opfsEnv.apiStore.useDocument({ returnRefetchingStatus: true }),
  );

  await flushAllTimers();

  // The local-sync store must retain its own queued value and pending-sync UI.
  expect(pick(localHook.result.current, ['data', 'pendingSync', 'status']))
    .toMatchInlineSnapshot(`
      data: { value: 2 }
      pendingSync: '✅'
      status: 'success'
    `);

  // The OPFS-backed store must retain its own queued value independently.
  expect(pick(opfsHook.result.current, ['data', 'pendingSync', 'status']))
    .toMatchInlineSnapshot(`
      data: { value: 3 }
      pendingSync: '✅'
      status: 'success'
    `);

  // The session-level offline tray should aggregate one pending document from
  // each adapter without exposing any storage-format details.
  expect(summarizeOfflineEntities(getGlobalOfflineEntities(mixedSessionKey)))
    .toMatchInlineSnapshot(`
      - pendingMutations: 1
        sessionKey: 'mixed-adapter-storage-session'
        storeName: 'mixed-local-doc'
        syncState: 'pending'
      - pendingMutations: 1
        sessionKey: 'mixed-adapter-storage-session'
        storeName: 'mixed-opfs-doc'
        syncState: 'pending'
    `);

  localHook.unmount();
  opfsHook.unmount();
});

test('mixed persisted session keeps global offline entities empty until stores remount', async () => {
  await seedMixedOfflineSession();

  // Simulate a fresh app boot that only has persisted offline state available.
  resetSessionForTests();

  // Shared global entity aggregates are rebuilt by real stores as they hydrate.
  // A passive global hook should not fabricate duplicated persisted entities
  // before any individual store screen mounts again.
  const globalHook = renderHook(() =>
    useGlobalOfflineEntities(mixedSessionKey),
  );

  await flushAllTimers();

  expect(
    summarizeOfflineEntities(globalHook.result.current),
  ).toMatchInlineSnapshot(`[]`);
  expect(getGlobalOfflineEntities(mixedSessionKey)).toEqual(
    globalHook.result.current,
  );

  globalHook.unmount();
});

test('mixed adapters rehydrate cached values from their own backends and replay on reconnect after restart', async () => {
  await seedMixedOfflineSession();

  // Simulate the next browser session starting from persisted storage only.
  resetSessionForTests();

  const restartedStoreManager = createSharedStoreManager(mixedSessionKey);
  const restartedLocalEnv = createMixedOfflineDocumentEnv({
    adapter: 'local-sync',
    initialValue: 1,
    storeManager: restartedStoreManager,
    sessionKey: mixedSessionKey,
    storeName: localStoreName,
    testScenario: 'idle',
  });
  const restartedOpfsEnv = createMixedOfflineDocumentEnv({
    adapter: opfsPersistentStorage,
    initialValue: 1,
    storeManager: restartedStoreManager,
    sessionKey: mixedSessionKey,
    storeName: opfsStoreName,
    testScenario: 'idle',
  });

  // Each restarted document screen should hydrate from its own adapter-backed
  // cache while still reflecting that replay has not happened yet.
  const localHook = renderHook(() =>
    restartedLocalEnv.apiStore.useDocument({ returnRefetchingStatus: true }),
  );
  const opfsHook = renderHook(() =>
    restartedOpfsEnv.apiStore.useDocument({ returnRefetchingStatus: true }),
  );
  const globalHook = renderHook(() =>
    useGlobalOfflineEntities(mixedSessionKey),
  );

  await flushAllTimers();

  // The local-sync store should rehydrate only the local queued value.
  expect(pick(localHook.result.current, ['data', 'pendingSync', 'status']))
    .toMatchInlineSnapshot(`
      data: { value: 2 }
      pendingSync: '✅'
      status: 'success'
    `);

  // The OPFS-backed store should independently rehydrate the OPFS value.
  expect(pick(opfsHook.result.current, ['data', 'pendingSync', 'status']))
    .toMatchInlineSnapshot(`
      data: { value: 3 }
      pendingSync: '✅'
      status: 'success'
    `);

  expect(summarizeOfflineEntities(globalHook.result.current))
    .toMatchInlineSnapshot(`
      - pendingMutations: 1
        sessionKey: 'mixed-adapter-storage-session'
        storeName: 'mixed-local-doc'
        syncState: 'pending'
      - pendingMutations: 1
        sessionKey: 'mixed-adapter-storage-session'
        storeName: 'mixed-opfs-doc'
        syncState: 'pending'
    `);

  // Connectivity returns and both persisted queues should replay to their own
  // servers before the shared session aggregate is cleared.
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(pick(localHook.result.current, ['data', 'pendingSync', 'status']))
    .toMatchInlineSnapshot(`
      data: { value: 2 }
      pendingSync: '❌'
      status: 'success'
    `);
  expect(pick(opfsHook.result.current, ['data', 'pendingSync', 'status']))
    .toMatchInlineSnapshot(`
      data: { value: 3 }
      pendingSync: '❌'
      status: 'success'
    `);
  expect(globalHook.result.current).toMatchInlineSnapshot(`[]`);
  expect(getGlobalOfflineEntities(mixedSessionKey)).toMatchInlineSnapshot(`[]`);

  localHook.unmount();
  opfsHook.unmount();
  globalHook.unmount();
});
