import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import {
  createFocusChangeCoordinator,
  setupBrowserTabsTestLifecycle,
} from '../browser-tabs/browser-tabs-test-helpers';
import {
  createInMemoryBrowserTabsTransportFactory,
  getNextStoreId,
} from '../mocks/browserTabsTestUtils';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  createSharedListQueryServerTableState,
  type Row,
} from '../mocks/listQueryStoreTestEnv';
import { createSharedServerMockState } from '../mocks/serverMock';
import { createSharedServerTableState } from '../mocks/serverTableMock';
import { setDefaultLowPriorityThrottleMs } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';

const rowSchema = rc_object({ id: rc_number, name: rc_string });
const listQueryParamsSchema = rc_object({ tableId: rc_string });
const docSchema = rc_object({ value: rc_number });
const colSchema = rc_object({ value: rc_object({ name: rc_string }) });
const partialResourcesConfig: PartialResourcesConfig<Row> = {
  mergeItems: (prev, fetched) => {
    if (!prev) return fetched;
    return { ...prev, ...fetched };
  },
  selectFields: (fields, item) => {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in item) {
        result[field] = item[field];
      }
    }
    return __LEGIT_CAST__<Row, Record<string, unknown>>(result);
  },
  inferFields: (item) =>
    Object.entries(item)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field),
};
const persistentStore = createLocalStoragePersistentTestStore();

setupBrowserTabsTestLifecycle();

beforeEach(() => {
  setDefaultLowPriorityThrottleMs(60_000);
});

afterEach(() => {
  setDefaultLowPriorityThrottleMs(200);
  localStorage.clear();
});

describe('persistence + browser tabs sync integration', () => {
  test('list-query tabs sync works after the stale tab performs a read', async () => {
    const storeName = getNextStoreId('persist-sync-lq');
    const sessionKey = 'test-session';
    const persisted = persistentStore.scope(storeName, sessionKey);
    const transportFactory = createInMemoryBrowserTabsTransportFactory();
    const tabs = createFocusChangeCoordinator(['tabA', 'tabB'], 'tabA');
    const freshServerData = {
      users: [
        { id: 1, name: 'FreshAlice' },
        { id: 2, name: 'Bob' },
      ],
    };
    const sharedServerTableState =
      createSharedListQueryServerTableState(freshServerData);

    persisted.listQuery.seedItem('users', 1, { id: 1, name: 'StaleAlice' });
    persisted.listQuery.seedQuery({ tableId: 'users' }, [
      { tableId: 'users', id: 1 },
    ]);

    const persistenceConfig = {
      storeName,
      adapter: 'local-sync',
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryParamsSchema,
    } as const;

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

    const tabBRenders = createLoggerStore({ arrays: 'all' });

    // Hydrate tab B from the stale persisted query before tab A revalidates.
    renderHook(() => {
      const { items, status } = tabB.apiStore.useListQuery({
        tableId: 'users',
      });

      tabBRenders.add({ status, names: items.map((item) => item.name) });
    });

    expect(
      tabB.store.state.items[persisted.listQuery.itemKey('users', 1)]?.name,
    ).toBe('StaleAlice');

    // Tab B has already consumed the stale cache, so the next visible update
    // must come from tab A's confirmed cross-tab snapshot, not a local refetch.
    tabA.scheduleFetch('highPriority', { tableId: 'users' });
    await flushAllTimers();
    await advanceTime(1100);

    expect(tabBRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [StaleAlice]
      -> status: success ⋅ names: [FreshAlice, Bob]
      "
    `);
    expect(
      tabB.store.state.items[persisted.listQuery.itemKey('users', 1)]?.name,
    ).toBe('FreshAlice');
    expect(persisted.listQuery.readItemData<Row>('users', 1)?.name).toBe(
      'FreshAlice',
    );
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

  test('list-query partial-resource tabs sync updates a persisted stale tab without a local refetch', async () => {
    const storeName = getNextStoreId('persist-sync-lq-partial');
    const sessionKey = 'test-session';
    const persisted = persistentStore.scope(storeName, sessionKey);
    const transportFactory = createInMemoryBrowserTabsTransportFactory();
    const tabs = createFocusChangeCoordinator(['tabA', 'tabB'], 'tabA');
    const serverData: Record<string, Row[]> = {
      users: [{ id: 1, name: 'FreshAlice', age: 30 }],
    };
    const sharedServerTableState =
      createSharedListQueryServerTableState(serverData);

    persisted.listQuery.seedItem(
      'users',
      1,
      { id: 1, name: 'StaleAlice' },
      { loadedFields: ['id', 'name'] },
    );
    persisted.listQuery.seedQuery({ tableId: 'users' }, [
      { tableId: 'users', id: 1 },
    ]);

    const persistenceConfig = {
      storeName,
      adapter: 'local-sync',
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryParamsSchema,
    } as const;

    const tabA = createListQueryStoreTestEnv(serverData, {
      id: storeName,
      getSessionKey: () => sessionKey,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('tabA'),
      persistentStorage: persistenceConfig,
      partialResources: partialResourcesConfig,
    });
    const tabB = createListQueryStoreTestEnv(serverData, {
      id: storeName,
      getSessionKey: () => sessionKey,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('tabB'),
      persistentStorage: persistenceConfig,
      partialResources: partialResourcesConfig,
    });

    const nameQueryRenders = createLoggerStore({ arrays: 'all' });
    const nameQuery = renderHook(() => {
      const result = tabB.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name'], returnRefetchingStatus: true },
      );

      nameQueryRenders.add({ status: result.status, items: result.items });

      return result;
    });

    expect(pick(nameQuery.result.current, ['status', 'items']))
      .toMatchInlineSnapshot(`
        items:
          - { id: 1, name: 'StaleAlice' }
        status: 'success'
      `);
    expect(tabB.serverTable.getRequestHistory('all')).toMatchInlineSnapshot(
      `[]`,
    );

    // Tab A fetches a broader field set; tab B should learn those fields via snapshot.
    tabA.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'users' },
      1,
      { fields: ['id', 'name', 'age'] },
    );
    await flushAllTimers();
    await advanceTime(1100);

    expect(nameQueryRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ items: [{id:1, name:StaleAlice}]
      -> status: success ⋅ items: [{id:1, name:FreshAlice}]
      "
    `);
    expect(
      [
        ...(tabB.store.state.itemLoadedFields[
          persisted.listQuery.itemKey('users', 1)
        ] ?? []),
      ].sort(),
    ).toMatchInlineSnapshot(`
      ['age', 'id', 'name']
    `);

    const ageQueryRenders = createLoggerStore({ arrays: 'all' });

    // After the snapshot, tab B should already have the extra fields and avoid a local refetch.
    const ageQuery = renderHook(() => {
      const result = tabB.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['age'], returnRefetchingStatus: true },
      );

      ageQueryRenders.add({ status: result.status, items: result.items });

      return result;
    });

    expect(pick(ageQuery.result.current, ['status', 'items']))
      .toMatchInlineSnapshot(`
        items:
          - age: 30
        status: 'success'
      `);
    expect(ageQueryRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ items: [{age:30}]
      "
    `);
    expect(tabB.serverTable.getRequestHistory('all')).toMatchInlineSnapshot(
      `[]`,
    );
    expect(tabA.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      10ms  | 🔴 >list-fetch-started
      810ms | 🔴 <list-fetch-finished (value: {"count":1})
      "
    `);
    expect(tabB.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":1})
      "
    `);
  });

  test('list-query realtime reconnect revalidates persisted stale data', async () => {
    const storeName = getNextStoreId('persist-rtu-lq');
    const sessionKey = 'test-session';
    const persisted = persistentStore.scope(storeName, sessionKey);
    const tabs = createFocusChangeCoordinator(['tabA'], 'tabA');
    const serverData = { users: [{ id: 1, name: 'FreshAlice' }] };

    persisted.listQuery.seedItem('users', 1, { id: 1, name: 'StaleAlice' });
    persisted.listQuery.seedQuery({ tableId: 'users' }, [
      { tableId: 'users', id: 1 },
    ]);

    const env = createListQueryStoreTestEnv(serverData, {
      id: storeName,
      getSessionKey: () => sessionKey,
      bindFocusController: tabs.bind('tabA'),
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 300,
      persistentStorage: {
        adapter: 'local-sync',
        schema: rowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryParamsSchema,
      },
    });

    const queryRenders = createLoggerStore({ arrays: 'all' });
    const query = renderHook(() => {
      const result = env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true },
      );

      queryRenders.add({ status: result.status, items: result.items });

      return result;
    });

    expect(pick(query.result.current, ['status', 'items']))
      .toMatchInlineSnapshot(`
        items:
          - { id: 1, name: 'StaleAlice' }
        status: 'success'
      `);
    expect(env.serverTable.getRequestHistory('all')).toMatchInlineSnapshot(
      `[]`,
    );

    // A reconnect should revalidate the persisted snapshot instead of trusting it indefinitely.
    act(() => {
      env.apiStore.onTransportReconnect();
    });
    await flushAllTimers();
    await advanceTime(1100);

    expect(queryRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ items: [{id:1, name:StaleAlice}]
      -> status: refetching ⋅ items: [{id:1, name:StaleAlice}]
      -> status: success ⋅ items: [{id:1, name:FreshAlice}]
      "
    `);
    expect(pick(query.result.current, ['status', 'items']))
      .toMatchInlineSnapshot(`
        items:
          - { id: 1, name: 'FreshAlice' }
        status: 'success'
      `);
    expect(persisted.listQuery.readItemData<Row>('users', 1)?.name).toBe(
      'FreshAlice',
    );
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      10ms  | 🔴 >list-fetch-started
      810ms | 🔴 <list-fetch-finished (value: {"count":1})
      "
    `);
  });

  test('document tabs sync works after the stale tab performs a read', async () => {
    const storeName = getNextStoreId('persist-sync-doc');
    const sessionKey = 'test-session';
    const persisted = persistentStore.scope(storeName, sessionKey);
    const transportFactory = createInMemoryBrowserTabsTransportFactory();
    const tabs = createFocusChangeCoordinator(['tabA', 'tabB'], 'tabA');
    const sharedServerState = createSharedServerMockState(2);

    persisted.document.seed({ value: 0 });

    const persistenceConfig = {
      storeName,
      adapter: 'local-sync',
      schema: docSchema,
    } as const;

    const tabA = createDocumentStoreTestEnv(2, {
      id: storeName,
      getSessionKey: () => sessionKey,
      sharedServerState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('tabA'),
      persistentStorage: persistenceConfig,
    });
    const tabB = createDocumentStoreTestEnv(2, {
      id: storeName,
      getSessionKey: () => sessionKey,
      sharedServerState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('tabB'),
      persistentStorage: persistenceConfig,
    });

    const tabBRenders = createLoggerStore();

    // Tab B must read the stale persisted document once so the later sync has an active subscriber.
    renderHook(() => {
      const { data, status } = tabB.apiStore.useDocument({
        returnRefetchingStatus: true,
      });

      tabBRenders.add({ status, value: data?.value ?? null });
    });

    expect(tabB.store.state.data?.value).toBe(0);

    // Revalidate in tab A and confirm tab B updates from the broadcast snapshot.
    tabA.scheduleFetch('highPriority');
    await flushAllTimers();
    await advanceTime(1100);

    expect(tabBRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ value: 0
      -> status: success ⋅ value: 2
      "
    `);
    expect(tabB.store.state.data?.value).toBe(2);
    expect(persisted.document.readData<{ value: number }>()?.value).toBe(2);
    expect(tabA.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | scheduled-fetch-triggered
      10ms  | 🔴 >fetch-started
      810ms | 🔴 <fetch-finished (value: 2)
      "
    `);
    expect(tabB.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | <confirmed-snapshot-received (value: 2)
      "
    `);
  });

  test('collection tabs sync works after the stale tab performs a read', async () => {
    const storeName = getNextStoreId('persist-sync-col');
    const sessionKey = 'test-session';
    const persisted = persistentStore.scope(storeName, sessionKey);
    const transportFactory = createInMemoryBrowserTabsTransportFactory();
    const tabs = createFocusChangeCoordinator(['tabA', 'tabB'], 'tabA');
    const sharedServerTableState = createSharedServerTableState({
      item1: { name: 'Fresh' },
    });

    persisted.collection.seedItem('item1', { value: { name: 'Stale' } });

    const persistenceConfig = {
      storeName,
      adapter: 'local-sync',
      schema: colSchema,
      payloadSchema: rc_string,
    } as const;

    const tabA = createCollectionStoreTestEnv(
      { item1: { name: 'Fresh' } },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        sharedServerTableState,
        browserTabsTransportFactory: transportFactory,
        bindFocusController: tabs.bind('tabA'),
        persistentStorage: persistenceConfig,
      },
    );
    const tabB = createCollectionStoreTestEnv(
      { item1: { name: 'Fresh' } },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        sharedServerTableState,
        browserTabsTransportFactory: transportFactory,
        bindFocusController: tabs.bind('tabB'),
        persistentStorage: persistenceConfig,
      },
    );

    const tabBRenders = createLoggerStore();

    // Tab B must read the stale persisted item once so the later sync has an active subscriber.
    renderHook(() => {
      const { data, status } = tabB.apiStore.useItem('item1');

      tabBRenders.add({ status, value: data?.value.name ?? null });
    });

    expect(tabB.store.state[getCompositeKey('item1')]?.data?.value.name).toBe(
      'Stale',
    );

    // Revalidate in tab A and confirm tab B updates from the broadcast snapshot.
    tabA.scheduleFetch('highPriority', 'item1');
    await flushAllTimers();
    await advanceTime(1100);

    expect(tabBRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ value: Stale
      -> status: success ⋅ value: Fresh
      "
    `);
    expect(tabB.store.state[getCompositeKey('item1')]?.data?.value.name).toBe(
      'Fresh',
    );
    expect(
      persisted.collection.readItemData<{ value: { name: string } }>('item1')
        ?.value.name,
    ).toBe('Fresh');
    expect(tabA.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | scheduled-fetch-triggered
      10ms  | 🔴 >fetch-started
      810ms | 🔴 <fetch-finished (value: {"name":"Fresh"})
      "
    `);
    expect(tabB.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | <confirmed-snapshot-received (value: {"name":"Fresh"})
      "
    `);
  });
});
