import { cleanup, renderHook } from '@testing-library/react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAsyncStorageAdapter } from '../../src/async-storage';
import type {
  AsyncStorageDriver,
  RemovedStore,
  StorageAdapter,
} from '../../src/main';
import { OpfsAsyncStorageDriver } from '../../src/persistentStorage/opfsAsyncStorageAdapter';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { createStoreManager } from '../../src/storeManager';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type Row,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import type { UpdateValueOperations } from '../offline/offlineReplayTestShared';
import {
  docMutationInputSchema,
  docSchema,
} from '../offline/offlineTestShared';
import {
  advanceTime,
  flushAllTimers,
  range,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import {
  getLocalStorageTree,
  getOpfsDirTree,
  startPersistentStorageOperationCapture,
} from '../utils/persistentStorageOptimizationTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';

const settingsSchema = rc_object({
  value: rc_object({ name: rc_string, value: rc_number }),
});
const collectionItemSchema = rc_object({
  value: rc_object({ id: rc_string, name: rc_string }),
});
const rowSchema = rc_object({ id: rc_number, name: rc_string });
const usersQuery = { tableId: 'users' };

let network = createOfflineNetworkMock();
let opfsStore = createOpfsPersistentStorageTestStore();
let persistentStorageErrors: string[] = [];

/**
 * The app's store manager. `removedStores` lists the stores deleted in this
 * app version.
 */
function createAppStoreManager(
  sessionKey: string,
  removedStores: RemovedStore[] = [],
) {
  return createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: network.config },
    removedStores,
    onPersistentStorageError: (error) => {
      persistentStorageErrors.push(
        error instanceof Error ? error.message : String(error),
      );
    },
  });
}

type AppStoreManager = ReturnType<typeof createAppStoreManager>;

function createSettingsEnv(
  storeManager: AppStoreManager,
  adapter: StorageAdapter,
  storeName: string,
) {
  return createDocumentStoreTestEnv(
    { name: 'dark', value: 1 },
    {
      id: storeName,
      getSessionKey: storeManager.getSessionKey,
      storeManager,
      persistentStorage: { adapter, schema: settingsSchema },
    },
  );
}

function createUsersCollectionEnv(storeManager: AppStoreManager) {
  return createCollectionStoreTestEnv(
    { '1': { id: '1', name: 'Ana' }, '2': { id: '2', name: 'Bob' } },
    {
      id: 'users',
      getSessionKey: storeManager.getSessionKey,
      storeManager,
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionItemSchema,
        payloadSchema: rc_string,
      },
    },
  );
}

function createUsersListEnv(storeManager: AppStoreManager) {
  return createListQueryStoreTestEnv<Row>(
    {
      users: [
        { id: 1, name: 'Ana' },
        { id: 2, name: 'Bob' },
      ],
    },
    {
      id: 'users-list',
      getSessionKey: storeManager.getSessionKey,
      storeManager,
      persistentStorage: {
        adapter: 'local-sync',
        schema: rowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: rc_object({ tableId: rc_string }),
      },
    },
  );
}

/** Document store with one offline operation. */
function createOfflineCounterEnv(
  storeManager: AppStoreManager,
  adapter: StorageAdapter,
) {
  const envRef: {
    current: ReturnType<
      typeof createDocumentStoreTestEnv<number, UpdateValueOperations>
    > | null;
  } = { current: null };

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: 'counter',
    getSessionKey: storeManager.getSessionKey,
    storeManager,
    testScenario: 'loaded',
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
          },
        },
      },
    },
  });
  envRef.current = env;

  return env;
}

/** The user edits the counter while offline, so the mutation is queued. */
async function queueOfflineCounterEdit(
  counter: ReturnType<typeof createOfflineCounterEnv>,
) {
  await resolveAfterAllTimers(
    counter.apiStore.performMutation({
      optimisticUpdate: () => {
        counter.apiStore.updateState((draft) => {
          draft.value = 2;
        });
      },
      mutation: async () => {
        await counter.serverMock.delayedSetData(2);
        return 2;
      },
      offline: { operation: 'updateValue', input: { value: 2 } },
    }),
  );
  await flushAllTimers();
}

/**
 * Simulates closing the tab and opening the next deployed app version:
 * in-memory stores and session runtime are gone, persisted storage stays.
 */
function restartApp(...envs: Array<{ apiStore: { dispose: () => void } }>) {
  cleanup();

  // A closed tab never runs `dispose()`. It is only called here so the previous
  // store instances stop reacting to the next ones, and whatever it writes is
  // rolled back to what the closed tab actually left in localStorage.
  const entriesLeftByClosedTab = range(0, localStorage.length - 1).flatMap(
    (index): Array<[key: string, value: string]> => {
      const key = localStorage.key(index);
      const value = key === null ? null : localStorage.getItem(key);
      return key === null || value === null ? [] : [[key, value]];
    },
  );
  for (const env of envs) {
    env.apiStore.dispose();
  }
  resetSessionForTests();
  localStorage.clear();
  for (const [key, value] of entriesLeftByClosedTab) {
    localStorage.setItem(key, value);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  persistentStorageErrors = [];
  resetSessionForTests({ clearStorage: true });
  opfsStore = createOpfsPersistentStorageTestStore();
});

afterEach(async () => {
  vi.restoreAllMocks();
  cleanup();
  // Drain background maintenance so it cannot write into the next test.
  await flushAllTimers();
  vi.useRealTimers();
  resetSessionForTests({ clearStorage: true });
});

describe('stores deleted from the app', () => {
  test('cached data of removed stores is removed from localStorage in every session, other stores are untouched', async () => {
    // Previous app version: two accounts used the app on this device. Each
    // cached a document, a collection and a list query, plus a profile
    // document that the next version keeps.
    const previousEnvs = [];
    for (const sessionKey of ['sess1', 'sess2']) {
      const storeManager = createAppStoreManager(sessionKey);
      const settings = createSettingsEnv(
        storeManager,
        'local-sync',
        'settings',
      );
      const profile = createSettingsEnv(
        storeManager,
        'local-sync',
        'settings-profile',
      );
      const users = createUsersCollectionEnv(storeManager);
      const usersList = createUsersListEnv(storeManager);
      renderHook(() => settings.apiStore.useDocument());
      renderHook(() => profile.apiStore.useDocument());
      renderHook(() => users.apiStore.useMultipleItems([{ payload: '1' }]));
      renderHook(() => usersList.apiStore.useListQuery(usersQuery));
      await flushAllTimers();
      previousEnvs.push(settings, profile, users, usersList);
    }

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (2.65 kb)
      ├ _m (1.17 kb)
      │ ├ g (0.04 kb)
      │ └ r (1.13 kb)
      │   ├ n:sess1 (0.38 kb)
      │   │ ├ users.ci.m (0.11 kb)
      │   │ └ users-list.li.m (0.25 kb)
      │   ├ n:sess2 (0.38 kb)
      │   │ ├ users.ci.m (0.11 kb)
      │   │ └ users-list.li.m (0.25 kb)
      │   ├ s:sess1 (0.19 kb)
      │   │ ├ settings.m (0.08 kb)
      │   │ └ settings-profile.m (0.09 kb)
      │   └ s:sess2 (0.19 kb)
      │     ├ settings.m (0.08 kb)
      │     └ settings-profile.m (0.09 kb)
      ├ sess1 (0.73 kb)
      │ ├ settings (0.10 kb)
      │ ├ settings-profile (0.11 kb)
      │ ├ users.ci."1 (0.11 kb)
      │ └ users-list (0.41 kb)
      │   ├ li (0.20 kb)
      │   │ ├ "users||1 (0.10 kb)
      │   │ └ "users||2 (0.10 kb)
      │   └ lq.{tableId:"users"} (0.18 kb)
      └ sess2 (0.73 kb)
        ├ settings (0.10 kb)
        ├ settings-profile (0.11 kb)
        ├ users.ci."1 (0.11 kb)
        └ users-list (0.41 kb)
          ├ li (0.20 kb)
          │ ├ "users||1 (0.10 kb)
          │ └ "users||2 (0.10 kb)
          └ lq.{tableId:"users"} (0.18 kb)"
    `);

    // Next app version: `settings`, `users` and `users-list` were deleted
    // from the code and declared as removed. `settings-profile` shares the
    // `settings` name prefix to prove only exact ids are matched.
    restartApp(...previousEnvs);
    const storeManager = createAppStoreManager('sess1', [
      { id: 'settings', adapter: 'local-sync' },
      { id: 'users', adapter: 'local-sync' },
      { id: 'users-list', adapter: 'local-sync' },
    ]);
    const profile = createSettingsEnv(
      storeManager,
      'local-sync',
      'settings-profile',
    );
    const profileHook = renderHook(() => profile.apiStore.useDocument());
    await flushAllTimers();

    // Only the kept profile documents of both accounts remain, next to the
    // maintenance bookkeeping (`_m.g`) and the marker listing the removed
    // stores already cleaned (`_m.rs`).
    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.61 kb)
      ├ _m (0.36 kb)
      │ ├ g (0.04 kb)
      │ ├ r (0.22 kb)
      │ │ ├ s:sess1.settings-profile.m (0.11 kb)
      │ │ └ s:sess2.settings-profile.m (0.11 kb)
      │ └ rs (0.10 kb)
      ├ sess1.settings-profile (0.12 kb)
      └ sess2.settings-profile (0.12 kb)"
    `);
    expect(profileHook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'dark', value: 1 }`,
    );
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });

  test('a removed store is cleaned from an async adapter that no remaining store uses', async () => {
    // Previous app version: `settings` was the only store persisting to OPFS.
    const previousStoreManager = createAppStoreManager('sess1');
    const previousSettings = createSettingsEnv(
      previousStoreManager,
      opfsPersistentStorage,
      'settings',
    );
    renderHook(() => previousSettings.apiStore.useDocument());
    await flushAllTimers();

    expect(getOpfsDirTree(opfsStore)).toMatchInlineSnapshot(`
      "tsdf (0.27 kb)
      ├ sess1 (0.20 kb)
      │ └ settings (0.19 kb)
      │   ├ d._i.r.json (0.08 kb)
      │   └ d.e.p.json (0.09 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);

    // Next app version: the store was deleted, and every remaining store uses
    // localStorage, so nothing else opens OPFS.
    restartApp(previousSettings);
    const storeManager = createAppStoreManager('sess1', [
      { id: 'settings', adapter: opfsPersistentStorage },
    ]);
    const profile = createSettingsEnv(
      storeManager,
      'local-sync',
      'settings-profile',
    );
    renderHook(() => profile.apiStore.useDocument());
    await flushAllTimers();

    expect(getOpfsDirTree(opfsStore)).toMatchInlineSnapshot(`
      "tsdf (0.07 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });

  test('queued offline mutations of a removed store are deleted and reported once', async () => {
    // Queue entry ids embed a random suffix; pin it for stable snapshots.
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);

    // Previous app version: the user edits the counter while offline and
    // closes the tab before the mutation is sent.
    network.setOffline();
    const previousCounter = createOfflineCounterEnv(
      createAppStoreManager('sess1'),
      'local-sync',
    );
    await queueOfflineCounterEdit(previousCounter);

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (1.16 kb)
      ├ _m (0.49 kb)
      │ ├ g (0.04 kb)
      │ └ r (0.44 kb)
      │   ├ n:sess1.counter (0.26 kb)
      │   │ ├ oe.m (0.09 kb)
      │   │ └ oq.m (0.14 kb)
      │   └ s:sess1 (0.18 kb)
      │     ├ _o_.s.m (0.07 kb)
      │     └ counter.m (0.09 kb)
      └ sess1 (0.67 kb)
        ├ _o_.s (0.09 kb)
        └ counter (0.57 kb)
          ├ oe.document (0.18 kb)
          └ oq.counter:1735689600000:4fzzzxjy (0.34 kb)"
    `);

    // Next app version deleted the counter store. Its queued edit can never be
    // replayed, so it is removed with the rest of the store's data and the app
    // is told what was lost.
    restartApp(previousCounter);
    const storeManager = createAppStoreManager('sess1', [
      { id: 'counter', adapter: 'local-sync' },
    ]);
    const profile = createSettingsEnv(
      storeManager,
      'local-sync',
      'settings-profile',
    );
    renderHook(() => profile.apiStore.useDocument());
    await flushAllTimers();

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.50 kb)
      ├ _m (0.28 kb)
      │ ├ g (0.04 kb)
      │ ├ r.s:sess1 (0.18 kb)
      │ │ ├ _o_.s.m (0.07 kb)
      │ │ └ settings-profile.m (0.09 kb)
      │ └ rs (0.05 kb)
      └ sess1 (0.21 kb)
        ├ _o_.s (0.09 kb)
        └ settings-profile (0.11 kb)"
    `);
    expect(persistentStorageErrors).toMatchInlineSnapshot(
      `- '[tsdf] Removed store "counter" still had 1 unsent offline record(s) (queued mutations or pending resolutions). They were deleted with the rest of its persisted data: no store can replay them anymore.'`,
    );

    // The next start has nothing left to clean or report.
    restartApp(profile);
    persistentStorageErrors.length = 0;
    const restartedStoreManager = createAppStoreManager('sess1', [
      { id: 'counter', adapter: 'local-sync' },
    ]);
    const restartedProfile = createSettingsEnv(
      restartedStoreManager,
      'local-sync',
      'settings-profile',
    );
    renderHook(() => restartedProfile.apiStore.useDocument());
    await flushAllTimers();

    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });

  test('queued offline mutations of a store removed from an async adapter are deleted and reported', async () => {
    // Queue entry ids embed a random suffix; pin it for stable snapshots.
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);

    // Previous app version: the counter persisted to OPFS and the user queued
    // an edit while offline.
    network.setOffline();
    const previousCounter = createOfflineCounterEnv(
      createAppStoreManager('sess1'),
      opfsPersistentStorage,
    );
    await queueOfflineCounterEdit(previousCounter);

    // The store's cached document, queued edit (`oq`) and derived entity
    // record (`oe`) are in OPFS.
    expect(getOpfsDirTree(opfsStore)).toMatchInlineSnapshot(`
      "tsdf (1.06 kb)
      ├ sess1 (0.99 kb)
      │ └ counter (0.98 kb)
      │   ├ d._i.r.json (0.10 kb)
      │   ├ d.e.p.json (0.04 kb)
      │   ├ oe._i.r.json (0.11 kb)
      │   ├ oe.document.p.json (0.20 kb)
      │   ├ oq._i.r.json (0.16 kb)
      │   └ oq.counter%3A1735689600003%3A4fzzzxjy.p.json (0.37 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);

    // Next app version deleted the counter store.
    restartApp(previousCounter);
    const storeManager = createAppStoreManager('sess1', [
      { id: 'counter', adapter: opfsPersistentStorage },
    ]);
    const profile = createSettingsEnv(
      storeManager,
      'local-sync',
      'settings-profile',
    );
    renderHook(() => profile.apiStore.useDocument());
    await flushAllTimers();

    expect(getOpfsDirTree(opfsStore)).toMatchInlineSnapshot(`
      "tsdf (0.07 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
    expect(persistentStorageErrors).toMatchInlineSnapshot(
      `- '[tsdf] Removed store "counter" still had 1 unsent offline record(s) (queued mutations or pending resolutions). They were deleted with the rest of its persisted data: no store can replay them anymore.'`,
    );
  });

  test('adding the adapter a removed store also used cleans that adapter too', async () => {
    // Older app version: `settings` persisted to localStorage, in an account
    // that has not opened the app since.
    const oldestSettings = createSettingsEnv(
      createAppStoreManager('sess2'),
      'local-sync',
      'settings',
    );
    renderHook(() => oldestSettings.apiStore.useDocument());
    await flushAllTimers();

    // Previous app version: `settings` moved to OPFS and another account used
    // it there.
    restartApp(oldestSettings);
    const previousSettings = createSettingsEnv(
      createAppStoreManager('sess1'),
      opfsPersistentStorage,
      'settings',
    );
    renderHook(() => previousSettings.apiStore.useDocument());
    await flushAllTimers();

    // The store is deleted, but only its localStorage data is declared.
    restartApp(previousSettings);
    createAppStoreManager('sess1', [{ id: 'settings', adapter: 'local-sync' }]);
    await flushAllTimers();

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.16 kb)
      ├ _am.g (0.05 kb)
      └ _m (0.10 kb)
        ├ g (0.04 kb)
        └ rs (0.06 kb)"
    `);
    // The OPFS data is still there, since that adapter was not declared.
    expect(getOpfsDirTree(opfsStore)).toMatchInlineSnapshot(`
      "tsdf (0.27 kb)
      ├ sess1 (0.20 kb)
      │ └ settings (0.19 kb)
      │   ├ d._i.r.json (0.08 kb)
      │   └ d.e.p.json (0.09 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);

    // A later version also declares OPFS for the same id: the cleanup runs for
    // the new adapter even though `settings` was already cleaned from
    // localStorage.
    restartApp();
    createAppStoreManager('sess1', [
      { id: 'settings', adapter: 'local-sync' },
      { id: 'settings', adapter: opfsPersistentStorage },
    ]);
    await flushAllTimers();

    expect(getOpfsDirTree(opfsStore)).toMatchInlineSnapshot(`
      "tsdf (0.07 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });

  test('an adapter that fails is retried on the next start, without holding back the others', async () => {
    // Queue entry ids embed a random suffix; pin it for stable snapshots.
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);

    // Previous app version: the counter persisted to localStorage, where the
    // user queued an edit while offline, and `settings` persisted to OPFS.
    network.setOffline();
    const previousStoreManager = createAppStoreManager('sess1');
    const previousCounter = createOfflineCounterEnv(
      previousStoreManager,
      'local-sync',
    );
    const previousSettings = createSettingsEnv(
      previousStoreManager,
      opfsPersistentStorage,
      'settings',
    );
    renderHook(() => previousSettings.apiStore.useDocument());
    await queueOfflineCounterEdit(previousCounter);

    // Both stores are deleted. The browser fails to delete one of the OPFS
    // files of `settings` on the first start.
    restartApp(previousCounter, previousSettings);
    opfsStore.mockBrowserOpfs.failRemoveEntry(
      'tsdf/sess1/settings/d.e.p.json',
      1,
    );
    const removedStores: RemovedStore[] = [
      { id: 'counter', adapter: 'local-sync' },
      { id: 'settings', adapter: opfsPersistentStorage },
    ];
    createAppStoreManager('sess1', removedStores);
    await flushAllTimers();

    // localStorage is cleaned and marked as done, and the lost queued edit is
    // reported. The OPFS failure is reported too, and `settings` is left
    // unmarked so the next start retries it.
    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.35 kb)
      ├ _am.g (0.05 kb)
      ├ _m (0.19 kb)
      │ ├ g (0.04 kb)
      │ ├ r.s:sess1._o_.s.m (0.09 kb)
      │ └ rs (0.05 kb)
      └ sess1._o_.s (0.10 kb)"
    `);
    expect(getOpfsDirTree(opfsStore)).toMatchInlineSnapshot(`
      "tsdf (0.18 kb)
      ├ sess1 (0.11 kb)
      │ └ settings (0.10 kb)
      │   └ d.e.p.json (0.09 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
    expect(persistentStorageErrors).toMatchInlineSnapshot(`
      - '[tsdf] Removed store "counter" still had 1 unsent offline record(s) (queued mutations or pending resolutions). They were deleted with the rest of its persisted data: no store can replay them anymore.'
      - '[tsdf] Some persisted data of removed store(s) "settings" could not be deleted. The cleanup retries on the next page load.'
    `);

    // Next start: only OPFS is cleaned again, and nothing is reported twice.
    restartApp();
    persistentStorageErrors.length = 0;
    createAppStoreManager('sess1', removedStores);
    await flushAllTimers();

    expect(getOpfsDirTree(opfsStore)).toMatchInlineSnapshot(`
      "tsdf (0.07 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.38 kb)
      ├ _am.g (0.05 kb)
      ├ _m (0.23 kb)
      │ ├ g (0.04 kb)
      │ ├ r.s:sess1._o_.s.m (0.09 kb)
      │ └ rs (0.09 kb)
      └ sess1._o_.s (0.10 kb)"
    `);
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });

  test('a removed store on a custom adapter without storageId is reported until the adapter gets one', async () => {
    // Previous app version: `settings` persisted through the app's own async
    // adapter. Its driver stores everything in OPFS but, like any custom
    // driver written before `storageId` existed, does not declare one.
    const opfsDriver = new OpfsAsyncStorageDriver();
    const customDriver: AsyncStorageDriver = {
      get: (...args) => opfsDriver.get(...args),
      set: (...args) => opfsDriver.set(...args),
      remove: (...args) => opfsDriver.remove(...args),
      listKeys: (...args) => opfsDriver.listKeys(...args),
      clear: (...args) => opfsDriver.clear(...args),
      listScopes: (...args) => opfsDriver.listScopes(...args),
      listScopesWithKnownRecordKeys: (...args) =>
        opfsDriver.listScopesWithKnownRecordKeys(...args),
      getMany: (...args) => opfsDriver.getMany(...args),
      setMany: (...args) => opfsDriver.setMany(...args),
      removeMany: (...args) => opfsDriver.removeMany(...args),
    };
    const previousSettings = createSettingsEnv(
      createAppStoreManager('sess1'),
      createAsyncStorageAdapter(customDriver),
      'settings',
    );
    renderHook(() => previousSettings.apiStore.useDocument());
    await flushAllTimers();

    // The store is deleted. Without a storageId TSDF could not remember that
    // the cleanup ran, so it reports the entry instead and removes nothing.
    restartApp(previousSettings);
    createAppStoreManager('sess1', [
      { id: 'settings', adapter: createAsyncStorageAdapter(customDriver) },
    ]);
    await flushAllTimers();

    expect(persistentStorageErrors).toMatchInlineSnapshot(
      `- '[tsdf] Removed store(s) "settings" use an async adapter TSDF cannot clean: it must be created with createAsyncStorageAdapter from a driver that has a storageId.'`,
    );
    expect(getOpfsDirTree(opfsStore)).toMatchInlineSnapshot(`
      "tsdf (0.27 kb)
      ├ sess1 (0.20 kb)
      │ └ settings (0.19 kb)
      │   ├ d._i.r.json (0.08 kb)
      │   └ d.e.p.json (0.09 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);

    // The next version gives the driver a storageId: the data is removed.
    restartApp();
    persistentStorageErrors.length = 0;
    createAppStoreManager('sess1', [
      {
        id: 'settings',
        adapter: createAsyncStorageAdapter({
          ...customDriver,
          storageId: 'app-custom-storage',
        }),
      },
    ]);
    await flushAllTimers();

    expect(getOpfsDirTree(opfsStore)).toMatchInlineSnapshot(`
      "tsdf (0.07 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });

  test('a store cannot use an id listed in removedStores', () => {
    const storeManager = createAppStoreManager('sess1', [
      { id: 'settings', adapter: 'local-sync' },
    ]);

    // Creating it would have its persisted data wiped by the cleanup.
    expect(() => createSettingsEnv(storeManager, 'local-sync', 'settings'))
      .toThrowErrorMatchingInlineSnapshot(`
      Error#:
        message: "[tsdf] Store id \\"settings\\" is listed in the storeManager's removedStores, which removes its persisted data. Remove it from removedStores to use the id again."
        name: 'Error'
    `);
  });
});

describe('localStorage cost of removedStores', () => {
  test('once cleaned, later startups only read the cleanup marker', async () => {
    const previousStoreManager = createAppStoreManager('sess1');
    const previousSettings = createSettingsEnv(
      previousStoreManager,
      'local-sync',
      'settings',
    );
    renderHook(() => previousSettings.apiStore.useDocument());
    await flushAllTimers();

    // First start of the version that removed the store: the cleanup runs.
    restartApp(previousSettings);
    const removedStores: RemovedStore[] = [
      { id: 'settings', adapter: 'local-sync' },
    ];
    createAppStoreManager('sess1', removedStores);
    await flushAllTimers();

    // Every later start reads the marker once, during idle time after the
    // initial maintenance delay, and stops there.
    restartApp();
    const capture = startPersistentStorageOperationCapture();
    createAppStoreManager('sess1', removedStores);
    await advanceTime(15_000);

    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      12s  | 📖 #1 ✅ tsdf._m.rs (entry data) | 0.05 kb
      "
    `);
  });
});
