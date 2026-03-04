import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  PersistedListQueryData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import {
  createInMemoryBrowserTabsTransportFactory,
  getNextStoreId,
} from '../mocks/browserTabsTestUtils';
import {
  createListQueryStoreTestEnv,
  createSharedListQueryServerTableState,
  type ListQueryParams,
  type Row,
} from '../mocks/listQueryStoreTestEnv';
import { setDefaultLowPriorityThrottleMs } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  createFocusChangeCoordinator,
  setupBrowserTabsTestLifecycle,
} from '../browser-tabs/browser-tabs-test-helpers';

const rowSchema = rc_object({ id: rc_number, name: rc_string });

function rawItemKey(tableId: string, id: number): string {
  return `${tableId}||${id}`;
}

function storeItemKey(tableId: string, id: number): string {
  return getCompositeKey(rawItemKey(tableId, id));
}

function queryKey(params: ListQueryParams): string {
  return getCompositeKey(params);
}

function readCachedListQueryData(
  storeName: string,
  sessionKey: string,
): PersistedListQueryData<Row> | null {
  const key = `tsdf.${sessionKey}.${storeName}`;
  const raw = localStorage.getItem(key);
  if (raw === null) return null;

  const entry = __LEGIT_CAST__<
    StorageCacheEntry<PersistedListQueryData<Row>>,
    unknown
  >(JSON.parse(raw));

  return entry.data;
}

function setCachedData(
  storeName: string,
  sessionKey: string,
  data: PersistedListQueryData<Row>,
  version = 1,
) {
  const key = `tsdf.${sessionKey}.${storeName}`;
  const entry: StorageCacheEntry<PersistedListQueryData<Row>> = {
    data,
    timestamp: Date.now(),
    version,
  };
  localStorage.setItem(key, JSON.stringify(entry));
}

setupBrowserTabsTestLifecycle();

beforeEach(() => {
  setDefaultLowPriorityThrottleMs(60_000);
});

afterEach(() => {
  setDefaultLowPriorityThrottleMs(200);
  localStorage.clear();
});

describe('persistence + browser tabs sync integration', () => {
  test('tab with stale cache receives fresh sync and persists the updated data', async () => {
    // Tab B hydrates stale data from cache. Tab A fetches fresh data from
    // the server and syncs it to Tab B via BroadcastChannel. The debounced
    // persistence save should capture the fresh synced state, not the stale
    // cache data — confirming no stale-data overwrite occurs.
    const storeName = getNextStoreId('persist-sync');
    const sessionKey = 'test-session';
    const transportFactory = createInMemoryBrowserTabsTransportFactory();

    const ik1 = storeItemKey('users', 1);
    const qk = queryKey({ tableId: 'users' });

    // Pre-populate cache with stale data
    setCachedData(storeName, sessionKey, {
      items: {
        [ik1]: { id: 1, name: 'StaleAlice' },
      },
      queries: {
        [qk]: {
          payload: { tableId: 'users' },
          items: [ik1],
          hasMore: false,
        },
      },
      itemPayloads: {
        [ik1]: rawItemKey('users', 1),
      },
    });

    const freshServerData = {
      users: [
        { id: 1, name: 'FreshAlice' },
        { id: 2, name: 'Bob' },
      ],
    };
    const sharedServerTableState =
      createSharedListQueryServerTableState(freshServerData);
    const tabs = createFocusChangeCoordinator(['tabA', 'tabB'], 'tabA');

    const persistenceConfig = {
      storeName,
      backend: 'localStorage' as const,
      schema: rowSchema,
    };

    const tabA = createListQueryStoreTestEnv(freshServerData, {
      id: storeName,
      getSessionKey: () => sessionKey,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('tabA'),
      persistentStorage: persistenceConfig,
    });

    // Tab B hydrates from the stale cache (same store ID, same cache key)
    const tabB = createListQueryStoreTestEnv(freshServerData, {
      id: storeName,
      getSessionKey: () => sessionKey,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('tabB'),
      persistentStorage: persistenceConfig,
    });

    // Tab B starts with stale cached data
    expect(tabB.store.state.items[ik1]?.name).toBe('StaleAlice');

    // Tab A fetches fresh data from server — syncs to Tab B
    tabA.scheduleFetch('highPriority', { tableId: 'users' });
    await flushAllTimers();

    // Tab B now has fresh data from the sync
    expect(tabB.store.state.items[ik1]?.name).toBe('FreshAlice');

    // Wait for debounced persistence save (1s)
    await advanceTime(1100);

    // Persisted data should be the fresh synced state
    const cached = readCachedListQueryData(storeName, sessionKey);
    expect(cached?.items[ik1]).toMatchInlineSnapshot(`
      id: 1
      name: 'FreshAlice'
    `);

    // Both timelines confirm the sync flow
    expect(tabA.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | scheduled-fetch-triggered
      10ms  | 🔴 >list-fetch-started
      810ms | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);
    expect(tabB.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
      "
    `);
  });

  test('debounced save captures latest state even when sync arrives after schedule', async () => {
    // Tab A fetches data and its persistence save is scheduled. Before the
    // debounce fires, Tab A receives a sync from Tab B with additional data.
    // The getData() callback reads store.state at fire time, so the save
    // should capture the merged state from both fetches.
    const storeName = getNextStoreId('persist-sync-debounce');
    const sessionKey = 'test-session';
    const transportFactory = createInMemoryBrowserTabsTransportFactory();

    const ik1 = storeItemKey('users', 1);
    const qk = queryKey({ tableId: 'users' });

    // Both tabs start with the same cached data so sync can apply
    setCachedData(storeName, sessionKey, {
      items: {
        [ik1]: { id: 1, name: 'CachedAlice' },
      },
      queries: {
        [qk]: {
          payload: { tableId: 'users' },
          items: [ik1],
          hasMore: false,
        },
      },
      itemPayloads: {
        [ik1]: rawItemKey('users', 1),
      },
    });

    const freshServerData = {
      users: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
    };
    const sharedServerTableState =
      createSharedListQueryServerTableState(freshServerData);
    const tabs = createFocusChangeCoordinator(['tabA', 'tabB'], 'tabA');

    const persistenceConfig = {
      storeName,
      backend: 'localStorage' as const,
      schema: rowSchema,
    };

    const tabA = createListQueryStoreTestEnv(freshServerData, {
      id: storeName,
      getSessionKey: () => sessionKey,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('tabA'),
      persistentStorage: persistenceConfig,
    });

    const tabB = createListQueryStoreTestEnv(freshServerData, {
      id: storeName,
      getSessionKey: () => sessionKey,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('tabB'),
      persistentStorage: persistenceConfig,
    });

    // Tab A fetches first — this schedules a debounced save on Tab A
    tabA.scheduleFetch('highPriority', { tableId: 'users' });
    await flushAllTimers();

    // Tab B also received the sync from Tab A.
    // Now Tab B refetches (as focused tab) — this triggers a new sync to Tab A
    // BEFORE Tab A's debounce fires (debounce = 1s, this happens in < 1s).
    // Simulate server-side data change
    tabB.serverTable.updateItem('users||1', { id: 1, name: 'UpdatedAlice' });
    await tabs.focusTab('tabB');
    tabB.scheduleFetch('highPriority', { tableId: 'users' });
    await flushAllTimers();

    // Tab A received the sync with UpdatedAlice — its state is now current
    expect(tabA.store.state.items[ik1]?.name).toBe('UpdatedAlice');

    // Wait for debounced save to fire
    await advanceTime(1100);

    // The persisted data should reflect the LATEST state (UpdatedAlice),
    // not the state at the time the save was originally scheduled (Alice)
    const cached = readCachedListQueryData(storeName, sessionKey);
    expect(cached?.items[ik1]).toMatchInlineSnapshot(`
      id: 1
      name: 'UpdatedAlice'
    `);
  });

  test('rapid fetch-sync cycles result in only the final state being persisted', async () => {
    // Tab A has cached data. Three rapid fetch cycles with server changes
    // between each. Tab B receives synced state each time. After all cycles
    // complete and debounced saves fire, the persisted data should contain
    // only the final version — not any intermediate state.
    const storeName = getNextStoreId('persist-sync-rapid');
    const sessionKey = 'test-session';
    const transportFactory = createInMemoryBrowserTabsTransportFactory();

    const ik1 = storeItemKey('users', 1);
    const qk = queryKey({ tableId: 'users' });

    setCachedData(storeName, sessionKey, {
      items: {
        [ik1]: { id: 1, name: 'V0' },
      },
      queries: {
        [qk]: {
          payload: { tableId: 'users' },
          items: [ik1],
          hasMore: false,
        },
      },
      itemPayloads: {
        [ik1]: rawItemKey('users', 1),
      },
    });

    const serverData = {
      users: [{ id: 1, name: 'V1' }],
    };
    const sharedServerTableState =
      createSharedListQueryServerTableState(serverData);
    const tabs = createFocusChangeCoordinator(['tabA', 'tabB'], 'tabA');

    const persistenceConfig = {
      storeName,
      backend: 'localStorage' as const,
      schema: rowSchema,
    };

    const tabA = createListQueryStoreTestEnv(serverData, {
      id: storeName,
      getSessionKey: () => sessionKey,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('tabA'),
      persistentStorage: persistenceConfig,
    });

    const tabB = createListQueryStoreTestEnv(serverData, {
      id: storeName,
      getSessionKey: () => sessionKey,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('tabB'),
      persistentStorage: persistenceConfig,
    });

    // Three rapid fetch-sync cycles: V1 → V2 → V3
    // Each cycle: Tab A fetches, Tab B receives sync via BroadcastChannel
    tabA.scheduleFetch('highPriority', { tableId: 'users' });
    await flushAllTimers();
    expect(tabB.store.state.items[ik1]?.name).toBe('V1');

    tabA.serverTable.updateItem('users||1', { id: 1, name: 'V2' });
    tabA.scheduleFetch('highPriority', { tableId: 'users' });
    await flushAllTimers();
    expect(tabB.store.state.items[ik1]?.name).toBe('V2');

    tabA.serverTable.updateItem('users||1', { id: 1, name: 'V3' });
    tabA.scheduleFetch('highPriority', { tableId: 'users' });
    await flushAllTimers();
    expect(tabB.store.state.items[ik1]?.name).toBe('V3');

    // After all timer cycles, the final persisted state should be V3
    const cached = readCachedListQueryData(storeName, sessionKey);
    expect(cached?.items[ik1]).toMatchInlineSnapshot(`
      id: 1
      name: 'V3'
    `);
  });

  test('server update via focused tab syncs and persists across both tabs', async () => {
    // Both tabs start from the same cache. Tab A fetches and gets fresh data.
    // Tab A then triggers a server update and refetches. All state transitions
    // flow to Tab B via sync, and the final persisted state reflects the
    // latest server data.
    const storeName = getNextStoreId('persist-sync-update');
    const sessionKey = 'test-session';
    const transportFactory = createInMemoryBrowserTabsTransportFactory();

    const ik1 = storeItemKey('users', 1);
    const ik2 = storeItemKey('users', 2);
    const qk = queryKey({ tableId: 'users' });

    setCachedData(storeName, sessionKey, {
      items: {
        [ik1]: { id: 1, name: 'CachedAlice' },
        [ik2]: { id: 2, name: 'CachedBob' },
      },
      queries: {
        [qk]: {
          payload: { tableId: 'users' },
          items: [ik1, ik2],
          hasMore: false,
        },
      },
      itemPayloads: {
        [ik1]: rawItemKey('users', 1),
        [ik2]: rawItemKey('users', 2),
      },
    });

    const initialServerData = {
      users: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
    };
    const sharedServerTableState =
      createSharedListQueryServerTableState(initialServerData);
    const tabs = createFocusChangeCoordinator(['tabA', 'tabB'], 'tabA');

    const persistenceConfig = {
      storeName,
      backend: 'localStorage' as const,
      schema: rowSchema,
    };

    const tabA = createListQueryStoreTestEnv(initialServerData, {
      id: storeName,
      getSessionKey: () => sessionKey,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('tabA'),
      persistentStorage: persistenceConfig,
    });

    const tabB = createListQueryStoreTestEnv(initialServerData, {
      id: storeName,
      getSessionKey: () => sessionKey,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('tabB'),
      persistentStorage: persistenceConfig,
    });

    // Both tabs start with cached data
    expect(tabA.store.state.items[ik1]?.name).toBe('CachedAlice');
    expect(tabB.store.state.items[ik1]?.name).toBe('CachedAlice');

    // Tab A fetches fresh data from server
    tabA.scheduleFetch('highPriority', { tableId: 'users' });
    await flushAllTimers();

    // Both tabs now have fresh data
    expect(tabA.store.state.items[ik1]?.name).toBe('Alice');
    expect(tabB.store.state.items[ik1]?.name).toBe('Alice');

    // Server data changes, Tab A refetches
    tabA.serverTable.updateItem('users||1', { id: 1, name: 'AliceUpdated' });
    tabA.scheduleFetch('highPriority', { tableId: 'users' });
    await flushAllTimers();

    // Both tabs should have the latest update via sync
    expect(tabA.store.state.items[ik1]?.name).toBe('AliceUpdated');
    expect(tabB.store.state.items[ik1]?.name).toBe('AliceUpdated');

    // Wait for debounced save
    await advanceTime(1100);

    // Persisted data should be the final state
    const cached = readCachedListQueryData(storeName, sessionKey);
    expect(cached?.items[ik1]).toMatchInlineSnapshot(`
      id: 1
      name: 'AliceUpdated'
    `);
    expect(cached?.items[ik2]).toMatchInlineSnapshot(`
      id: 2
      name: 'Bob'
    `);

    // Both timelines show the full flow
    expect(tabA.timelineString).toMatchInlineSnapshot(`
      "
      time  | users||1 |
      0     | -        | scheduled-fetch-triggered
      10ms  | -        | 🔴 >list-fetch-started
      810ms | -        | 🔴 <list-fetch-finished (value: {"count":2})
      1.81s | -        | server-data-changed (value: {"id":1,"name":"AliceUpdated"})
      .     | -        | scheduled-fetch-triggered
      1.82s | -        | 🟠 >list-fetch-started
      2.62s | -        | 🟠 <list-fetch-finished (value: {"count":2})
      "
    `);
    expect(tabB.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
      2.62s | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
      "
    `);
  });
});
