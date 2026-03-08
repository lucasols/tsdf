import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
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
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';

const rowSchema = rc_object({ id: rc_number, name: rc_string });
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

    renderHook(() => tabB.apiStore.useListQuery({ tableId: 'users' }));

    expect(
      tabB.store.state.items[persisted.listQuery.itemKey('users', 1)]?.name,
    ).toBe('StaleAlice');

    tabA.scheduleFetch('highPriority', { tableId: 'users' });
    await flushAllTimers();
    await advanceTime(1100);

    expect(
      tabB.store.state.items[persisted.listQuery.itemKey('users', 1)]?.name,
    ).toBe('FreshAlice');
    expect(persisted.listQuery.readItemData<Row>('users', 1)?.name).toBe(
      'FreshAlice',
    );
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

    const nameQuery = renderHook(() =>
      tabB.apiStore.useListQuery(
        { tableId: 'users' },
        {
          fields: ['id', 'name'],
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        },
      ),
    );

    expect(nameQuery.result.current).toMatchObject({
      status: 'success',
      items: [{ id: 1, name: 'StaleAlice' }],
    });
    expect(tabB.serverTable.fetchHistory).toMatchInlineSnapshot(`[]`);

    // Tab A fetches a broader field set; tab B should learn those fields via snapshot.
    tabA.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'users' },
      1,
      { fields: ['id', 'name', 'age'] },
    );
    await flushAllTimers();
    await advanceTime(1100);

    expect(
      [
        ...(tabB.store.state.itemLoadedFields[
          persisted.listQuery.itemKey('users', 1)
        ] ?? []),
      ].sort(),
    ).toMatchInlineSnapshot(`
      ['age', 'id', 'name']
    `);

    const ageQuery = renderHook(() =>
      tabB.apiStore.useListQuery(
        { tableId: 'users' },
        {
          fields: ['age'],
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        },
      ),
    );

    expect(ageQuery.result.current).toMatchObject({
      status: 'success',
      items: [{ age: 30 }],
    });
    expect(tabB.serverTable.fetchHistory).toMatchInlineSnapshot(`[]`);
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
        storeName,
        backend: 'localStorage',
        schema: rowSchema,
      },
    });

    const query = renderHook(() =>
      env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true },
      ),
    );

    expect(query.result.current).toMatchObject({
      status: 'success',
      items: [{ id: 1, name: 'StaleAlice' }],
    });
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`[]`);

    act(() => {
      env.apiStore.onTransportReconnect();
    });
    await flushAllTimers();
    await advanceTime(1100);

    expect(query.result.current).toMatchObject({
      status: 'success',
      items: [{ id: 1, name: 'FreshAlice' }],
    });
    expect(persisted.listQuery.readItemData<Row>('users', 1)?.name).toBe(
      'FreshAlice',
    );
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
      backend: 'localStorage' as const,
      schema: docSchema,
    };

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

    renderHook(() => tabB.apiStore.useDocument());

    expect(tabB.store.state.data?.value).toBe(0);

    tabA.scheduleFetch('highPriority');
    await flushAllTimers();
    await advanceTime(1100);

    expect(tabB.store.state.data?.value).toBe(2);
    expect(persisted.document.readData<{ value: number }>()?.value).toBe(2);
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
      backend: 'localStorage' as const,
      schema: colSchema,
    };

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

    renderHook(() => tabB.apiStore.useItem('item1'));

    expect(tabB.store.state[getCompositeKey('item1')]?.data?.value.name).toBe(
      'Stale',
    );

    tabA.scheduleFetch('highPriority', 'item1');
    await flushAllTimers();
    await advanceTime(1100);

    expect(tabB.store.state[getCompositeKey('item1')]?.data?.value.name).toBe(
      'Fresh',
    );
    expect(
      persisted.collection.readItemData<{ value: { name: string } }>('item1')
        ?.value.name,
    ).toBe('Fresh');
  });
});
