import { cleanup, renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
  pick,
  range,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import {
  getLocalStorageTree,
  getOpfsDirTree,
  getParsedLocalStorageValue,
  startPersistentStorageOperationCapture,
} from '../utils/persistentStorageOptimizationTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';

const sessionKey = 'sess1';

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

type Adapter = 'local-sync' | typeof opfsPersistentStorage;

function createSettingsEnv(adapter: Adapter, storeName: string) {
  return createDocumentStoreTestEnv(
    { name: 'dark', value: 1 },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      persistentStorage: { adapter, schema: settingsSchema },
    },
  );
}

function createUsersCollectionEnv(adapter: Adapter, storeName: string) {
  return createCollectionStoreTestEnv(
    { '1': { id: '1', name: 'Ana' }, '2': { id: '2', name: 'Bob' } },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      persistentStorage: {
        adapter,
        schema: collectionItemSchema,
        payloadSchema: rc_string,
      },
    },
  );
}

function createUsersListEnv(adapter: Adapter, storeName: string) {
  return createListQueryStoreTestEnv<Row>(
    {
      users: [
        { id: 1, name: 'Ana' },
        { id: 2, name: 'Bob' },
      ],
    },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      persistentStorage: {
        adapter,
        schema: rowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: rc_object({ tableId: rc_string }),
      },
    },
  );
}

/**
 * Document store with one offline operation, attached to a session that can
 * queue mutations while the browser is offline.
 */
function createOfflineCounterEnv(
  adapter: Adapter,
  persistentStorageErrors: string[],
  testScenario: 'idle' | 'loaded' = 'idle',
) {
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: network.config },
    onPersistentStorageError: (error) => {
      persistentStorageErrors.push(
        error instanceof Error ? error.message : String(error),
      );
    },
  });
  const envRef: {
    current: ReturnType<
      typeof createDocumentStoreTestEnv<number, UpdateValueOperations>
    > | null;
  } = { current: null };

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: 'counter',
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
  });
  envRef.current = env;

  return env;
}

/**
 * Simulates closing the tab and opening the next deployed app version:
 * in-memory stores and session runtime are gone, persisted storage stays.
 */
function restartApp(...envs: Array<{ apiStore: { dispose: () => void } }>) {
  cleanup();

  // A closed tab never runs `dispose()`. It is only called here so the previous
  // store instances stop reacting to the next ones, and whatever it writes
  // (disposing a store releases its offline protection) is rolled back to what
  // the closed tab actually left in localStorage.
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

describe('store moves from local-sync to an async adapter', () => {
  test('cached document left in localStorage is removed, other local-sync stores are untouched', async () => {
    // Previous app version: both documents persist to localStorage.
    const previousSettings = createSettingsEnv('local-sync', 'settings');
    const previousProfile = createSettingsEnv('local-sync', 'settings-profile');
    renderHook(() => previousSettings.apiStore.useDocument());
    renderHook(() => previousProfile.apiStore.useDocument());
    await flushAllTimers();

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.46 kb)
      ├ _m (0.23 kb)
      │ ├ g (0.04 kb)
      │ └ r.s:sess1 (0.19 kb)
      │   ├ settings.m (0.08 kb)
      │   └ settings-profile.m (0.09 kb)
      └ sess1 (0.22 kb)
        ├ settings (0.10 kb)
        └ settings-profile (0.11 kb)"
    `);

    // Next app version: only `settings` moved to the async adapter. The
    // sibling store shares the same name prefix to prove the cleanup is scoped
    // to exactly one store.
    restartApp(previousSettings, previousProfile);
    const settings = createSettingsEnv(opfsPersistentStorage, 'settings');
    const profile = createSettingsEnv('local-sync', 'settings-profile');
    const settingsHook = renderHook(() => settings.apiStore.useDocument());
    const profileHook = renderHook(() => profile.apiStore.useDocument());
    await flushAllTimers();

    // The moved store no longer owns anything in localStorage (`_am.g` is the
    // async adapter's own maintenance bookkeeping).
    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.33 kb)
      ├ _am.g (0.05 kb)
      ├ _m (0.16 kb)
      │ ├ g (0.04 kb)
      │ └ r.s:sess1.settings-profile.m (0.11 kb)
      └ sess1.settings-profile (0.12 kb)"
    `);

    // Both screens still work: the moved store refetched and now persists
    // through the async adapter.
    expect({
      profile: profileHook.result.current.data,
      settings: settingsHook.result.current.data,
    }).toMatchInlineSnapshot(`
      profile:
        value: { name: 'dark', value: 1 }

      settings:
        value: { name: 'dark', value: 1 }
    `);
    expect(getOpfsDirTree(opfsStore)).toMatchInlineSnapshot(`
      "tsdf (0.27 kb)
      ├ sess1 (0.20 kb)
      │ └ settings (0.19 kb)
      │   ├ d._i.r.json (0.08 kb)
      │   └ d.e.p.json (0.09 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
  });

  test('cached collection items left in localStorage are removed', async () => {
    // Previous app version caches two users in localStorage.
    const previousUsers = createUsersCollectionEnv('local-sync', 'users');
    renderHook(() =>
      previousUsers.apiStore.useMultipleItems([
        { payload: '1' },
        { payload: '2' },
      ]),
    );
    await flushAllTimers();

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.47 kb)
      ├ _m (0.25 kb)
      │ ├ g (0.04 kb)
      │ └ r.n:sess1.users.ci.m (0.21 kb)
      └ sess1.users.ci (0.21 kb)
        ├ "1 (0.10 kb)
        └ "2 (0.10 kb)"
    `);

    // Next app version persists the same collection through the async adapter.
    restartApp(previousUsers);
    const users = createUsersCollectionEnv(opfsPersistentStorage, 'users');
    const usersHook = renderHook(() =>
      users.apiStore.useMultipleItems([{ payload: '1' }, { payload: '2' }]),
    );
    await flushAllTimers();

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.10 kb)
      ├ _am.g (0.05 kb)
      └ _m.g (0.05 kb)"
    `);
    expect(usersHook.result.current.map((item) => item.data))
      .toMatchInlineSnapshot(`
        - value: { id: '1', name: 'Ana' }
        - value: { id: '2', name: 'Bob' }
      `);
  });

  test('cached list queries and their items left in localStorage are removed', async () => {
    // Previous app version caches one query and its two rows in localStorage.
    // Query entries are stored without a manifest, so they need their own
    // removal path.
    const previousUsers = createUsersListEnv('local-sync', 'users-list');
    renderHook(() => previousUsers.apiStore.useListQuery(usersQuery));
    await flushAllTimers();

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.74 kb)
      ├ _m (0.32 kb)
      │ ├ g (0.04 kb)
      │ └ r.n:sess1.users-list.li.m (0.27 kb)
      └ sess1.users-list (0.42 kb)
        ├ li (0.20 kb)
        │ ├ "users||1 (0.10 kb)
        │ └ "users||2 (0.10 kb)
        └ lq.{tableId:"users"} (0.18 kb)"
    `);

    // Next app version persists the same list through the async adapter.
    restartApp(previousUsers);
    const users = createUsersListEnv(opfsPersistentStorage, 'users-list');
    const usersHook = renderHook(() => users.apiStore.useListQuery(usersQuery));
    await flushAllTimers();

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.10 kb)
      ├ _am.g (0.05 kb)
      └ _m.g (0.05 kb)"
    `);
    expect(
      usersHook.result.current.items.map((item) => item.name),
    ).toMatchInlineSnapshot(`['Ana', 'Bob']`);
  });

  test('queued offline mutations are kept and reported instead of being removed, then cleaned once replayed', async () => {
    // Queue entry ids embed a random suffix; pin it for stable snapshots.
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    const persistentStorageErrors: string[] = [];

    // Previous app version: the user edits the counter while offline, so the
    // mutation is queued in localStorage (`oq`) next to its derived entity
    // record (`oe`).
    network.setOffline();
    const previousCounter = createOfflineCounterEnv(
      'local-sync',
      persistentStorageErrors,
      'loaded',
    );
    await resolveAfterAllTimers(
      previousCounter.apiStore.performMutation({
        optimisticUpdate: () => {
          previousCounter.apiStore.updateState((draft) => {
            draft.value = 2;
          });
        },
        mutation: async () => {
          await previousCounter.serverMock.delayedSetData(2);
          return 2;
        },
        offline: { operation: 'updateValue', input: { value: 2 } },
      }),
    );
    await flushAllTimers();

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
    // The cached optimistic value is offline-protected (`o`), which exempts it
    // from the weekly expiry for as long as nothing releases the protection.
    expect(getParsedLocalStorageValue('tsdf._m.r.s:sess1.counter.m'))
      .toMatchInlineSnapshot(`
        e:
          d: { a: 1735689601000, o: '✅' }
      `);

    // Next app version moves the store to the async adapter while the queued
    // mutation was never sent.
    restartApp(previousCounter);
    const movedCounter = createOfflineCounterEnv(
      opfsPersistentStorage,
      persistentStorageErrors,
    );
    const movedHook = renderHook(() => movedCounter.apiStore.useDocument());
    await flushAllTimers();

    // Deleting the leftovers would silently drop the unsent edit, so every
    // entry of the store is still in localStorage (only `_am.g`, the async
    // adapter's maintenance bookkeeping, is new) and the app is told about it.
    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (1.21 kb)
      ├ _am.g (0.05 kb)
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
    expect(persistentStorageErrors).toMatchInlineSnapshot(
      `- "[tsdf] Store \\"counter\\" now uses an async persistentStorage adapter, but localStorage still holds 1 unsent offline record(s) (queued mutations or pending resolutions) it wrote through 'local-sync'. They were kept, but they are only replayed while the store uses 'local-sync': roll the store back to 'local-sync' to replay them. This is reported on every page load until then."`,
    );
    // The moved store cannot see the queued edit: this is the stranded work
    // the report above is about. It has no cache in the new adapter and the
    // browser is still offline, so its first fetch fails.
    expect(pick(movedHook.result.current, ['data', 'pendingSync', 'status']))
      .toMatchInlineSnapshot(`
        data: null
        pendingSync: '❌'
        status: 'error'
      `);

    // The app rolls the store back to local-sync: the queued edit is still
    // there and reaches the server once the browser is online again.
    restartApp(movedCounter);
    persistentStorageErrors.length = 0;
    const rolledBackCounter = createOfflineCounterEnv(
      'local-sync',
      persistentStorageErrors,
    );
    const rolledBackHook = renderHook(() =>
      rolledBackCounter.apiStore.useDocument(),
    );
    await flushAllTimers();

    expect(pick(rolledBackHook.result.current, ['data', 'pendingSync']))
      .toMatchInlineSnapshot(`
        data: { value: 2 }
        pendingSync: '✅'
      `);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect({
      ...pick(rolledBackHook.result.current, ['data', 'pendingSync']),
      serverValue: rolledBackCounter.serverMock.current,
    }).toMatchInlineSnapshot(`
      data: { value: 2 }
      pendingSync: '❌'
      serverValue: 2
    `);

    // With nothing left to replay, moving to the async adapter again removes
    // every localStorage entry of the store. Only the session offline status
    // (always kept in localStorage) remains.
    restartApp(rolledBackCounter);
    const counter = createOfflineCounterEnv(
      opfsPersistentStorage,
      persistentStorageErrors,
    );
    renderHook(() => counter.apiStore.useDocument());
    await flushAllTimers();

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.28 kb)
      ├ _am.g (0.05 kb)
      ├ _m (0.13 kb)
      │ ├ g (0.04 kb)
      │ └ r.s:sess1._o_.s.m (0.09 kb)
      └ sess1._o_.s (0.09 kb)"
    `);
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });

  test('a tab still running the previous version keeps working while the new version cleans up', async () => {
    // Old tab: previous app version on local-sync, left open during a deploy.
    const oldTab = createSettingsEnv('local-sync', 'settings');
    const oldTabHook = renderHook(() => oldTab.apiStore.useDocument());
    await flushAllTimers();

    // New tab: the next app version starts with the async adapter and removes
    // the store's localStorage entries under the old tab's feet.
    const newTab = createSettingsEnv(opfsPersistentStorage, 'settings');
    renderHook(() => newTab.apiStore.useDocument());
    await flushAllTimers();

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.10 kb)
      ├ _am.g (0.05 kb)
      └ _m.g (0.05 kb)"
    `);

    // The old tab still shows its in-memory data, and its next refetch works
    // and persists to localStorage again.
    expect(oldTabHook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'dark', value: 1 }`,
    );
    act(() => {
      oldTab.setServerData({ name: 'light', value: 2 });
      oldTab.apiStore.invalidateData('highPriority');
    });
    await flushAllTimers();

    expect(oldTabHook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'light', value: 2 }`,
    );
    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.30 kb)
      ├ _am.g (0.05 kb)
      ├ _m (0.14 kb)
      │ ├ g (0.04 kb)
      │ └ r.s:sess1.settings.m (0.09 kb)
      └ sess1.settings (0.11 kb)"
    `);

    // Once the old tab is gone, the next start of the new version removes
    // what it wrote in the meantime.
    restartApp(oldTab, newTab);
    const restartedNewTab = createSettingsEnv(
      opfsPersistentStorage,
      'settings',
    );
    renderHook(() => restartedNewTab.apiStore.useDocument());
    await flushAllTimers();

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.10 kb)
      ├ _am.g (0.05 kb)
      └ _m.g (0.05 kb)"
    `);
  });

  test('a store on an async adapter still starts when the browser blocks localStorage', async () => {
    // Blocking site data makes every `localStorage` read throw.
    const getItemSpy = vi
      .spyOn(localStorage, 'getItem')
      .mockImplementation(() => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      });

    // Looking for leftovers must not stop the store from being created, and
    // the store keeps loading and persisting through its own adapter.
    const settings = createSettingsEnv(opfsPersistentStorage, 'settings');
    const settingsHook = renderHook(() => settings.apiStore.useDocument());
    await flushAllTimers();

    expect(settingsHook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'dark', value: 1 }`,
    );
    // The tree helper reads localStorage too, so unblock it to inspect OPFS.
    getItemSpy.mockRestore();
    expect(getOpfsDirTree(opfsStore)).toMatchInlineSnapshot(`
      "tsdf (0.20 kb)
      └ sess1 (0.20 kb)
        └ settings (0.19 kb)
          ├ d._i.r.json (0.08 kb)
          └ d.e.p.json (0.09 kb)"
    `);
  });
});

describe('localStorage cost of detecting a moved store', () => {
  test('stores that never used localStorage pay one missing-key read per persistence handle', async () => {
    // First run already on the async adapter: none of these stores has
    // anything in localStorage, which is the path every regular startup takes.
    const capture = startPersistentStorageOperationCapture();
    const settings = createSettingsEnv(opfsPersistentStorage, 'settings');
    const users = createUsersCollectionEnv(opfsPersistentStorage, 'users');
    const usersList = createUsersListEnv(opfsPersistentStorage, 'users-list');
    renderHook(() => settings.apiStore.useDocument());
    renderHook(() => users.apiStore.useMultipleItems([{ payload: '1' }]));
    renderHook(() => usersList.apiStore.useListQuery(usersQuery));
    // Covers store creation, hydration, fetch, the debounced save and the
    // idle slot where a cleanup would run.
    await advanceTime(4000);

    // One `getItem` per handle when it is created. A list-query store only
    // probes its items index: its query entries have no index to look for.
    // No key scans, no writes and nothing scheduled.
    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 ❌ tsdf._m.r.s:sess1.settings.m (namespace index)
      .    | 📖 #2 ❌ tsdf._m.r.n:sess1.users.ci.m (namespace index)
      .    | 📖 #3 ❌ tsdf._m.r.n:sess1.users-list.li.m (items index)
      "
    `);
  });

  test('a store that moved adapters reads and removes only its own keys', async () => {
    const previousSettings = createSettingsEnv('local-sync', 'settings');
    renderHook(() => previousSettings.apiStore.useDocument());
    await flushAllTimers();
    restartApp(previousSettings);

    const capture = startPersistentStorageOperationCapture();
    const settings = createSettingsEnv(opfsPersistentStorage, 'settings');
    renderHook(() => settings.apiStore.useDocument());
    await advanceTime(4000);

    // The startup read finds the old manifest, so a cleanup runs once in idle
    // time (2s timer fallback): it checks that no offline work is queued
    // (`oq`, `oc`), removes the store's entries, and ends with the only key
    // scan of the flow, looking for manifest-less list-query entries.
    expect(capture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 ✅ tsdf._m.r.s:sess1.settings.m (namespace index) | 0.06 kb
           ·
      2s   | 📖 #2 ❌ tsdf._m.r.n:sess1.settings.oq.m (namespace index)
      .    | 📖 #3 ❌ tsdf._m.r.n:sess1.settings.oc.m (namespace index)
      .    | 📖 #1 ✅ tsdf._m.r.s:sess1.settings.m (namespace index) | 0.06 kb
      .    | 🗑️ #4 ✅->❌ tsdf.sess1.settings (entry data)
      .    | 🗑️ #1 ✅->❌ tsdf._m.r.s:sess1.settings.m (namespace index)
      .    | 📖 #5 ❌ tsdf._m.r.n:sess1.settings.ci.m (namespace index)
      .    | 📖 #6 ❌ tsdf._m.r.n:sess1.settings.li.m (items index)
      .    | 📖 #7 ❌ tsdf._m.r.n:sess1.settings.oe.m (namespace index)
      .    | 🔑[0] #8 ✅ tsdf._m.g (global maintenance)
      "
    `);
  });
});
