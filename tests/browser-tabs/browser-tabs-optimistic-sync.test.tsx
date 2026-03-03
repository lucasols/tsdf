import { renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import {
  createInMemoryBrowserTabsTransportFactory,
  getNextStoreId,
} from '../mocks/browserTabsTestUtils';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  createSharedListQueryServerTableState,
} from '../mocks/listQueryStoreTestEnv';
import { createSharedServerMockState } from '../mocks/serverMock';
import { createSharedServerTableState } from '../mocks/serverTableMock';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  createCollectionItems,
  createFocusChangeCoordinator,
  createOptimisticSortConfig,
  createUsersTable,
  setupBrowserTabsTestLifecycle,
} from './browser-tabs-test-helpers';

setupBrowserTabsTestLifecycle();

test('document optimistic updates propagate to another tab without a remote refetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-shared');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
    lowPriorityThrottleMs: 60_000,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    lowPriorityThrottleMs: 60_000,
  });

  renderHook(() => {
    const doc = envA.apiStore.useDocument();
    envA.trackUIChanges(doc.data?.value);
  });
  renderHook(() => {
    const doc = envB.apiStore.useDocument();
    envB.trackUIChanges(doc.data?.value);
  });

  await advanceTime(10);

  void envA.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    duration: 1_000,
  });

  await advanceTime(0);

  expect(envB.store.state.data?.value).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);

  await flushAllTimers();

  expect(envB.store.state.data?.value).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    10ms  | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    710ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time | ui |
    0    | 0  | ui-initialized
    10ms | 0  | <optimistic-snapshot-received (value: 1)
    .    | 1  | ui-changed
    "
  `);
});

test('document failed optimistic mutations revert the synced background state', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-optimistic-error');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
  });

  renderHook(() => envA.apiStore.useDocument());

  let mutationPromise!: ReturnType<typeof envA.apiStore.performMutation>;
  act(() => {
    mutationPromise = envA.apiStore.performMutation({
      optimisticUpdate: () => {
        envA.apiStore.updateState((draft) => {
          draft.value = 1;
        });
      },
      mutation: async () => {
        await wait(100);
        throw new Error('Mutation failed');
      },
    });
  });

  await advanceTime(0);

  expect(envB.store.state.data?.value).toBe(1);

  await flushAllTimers();
  const result = await mutationPromise;

  expect(result.ok).toBe(false);
  expect(envA.serverMock.numOfStartedFetches).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  expect(envB.store.state.data?.value).toBe(0);
});

test('collection optimistic updates propagate across tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-shared');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
  });

  void envA.performClientUpdateAction(
    'item1',
    { name: 'Updated' },
    {
      withOptimisticUpdate: true,
      duration: 1_000,
    },
  );

  await advanceTime(0);

  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Updated' },
  });
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
});

test('collection failed optimistic mutations revert the synced background state', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-optimistic-error');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
  });

  renderHook(() => envA.apiStore.useItem('item1'));

  let mutationPromise!: ReturnType<typeof envA.apiStore.performMutation>;
  act(() => {
    mutationPromise = envA.apiStore.performMutation('item1', {
      optimisticUpdate: () => {
        envA.apiStore.updateItemState('item1', (draft) => {
          draft.value = { name: 'Updated' };
        });
      },
      mutation: async () => {
        await wait(100);
        throw new Error('Mutation failed');
      },
    });
  });

  await advanceTime(0);

  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Updated' },
  });

  await flushAllTimers();
  const result = await mutationPromise;

  expect(result.ok).toBe(false);
  expect(envA.serverTable.fetchHistory).toHaveLength(1);
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Item 1' },
  });
});

test('list query optimistic sorting propagates to other tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-sort');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: { loaded: { tables: ['users'] } },
    optimisticListUpdates: createOptimisticSortConfig(),
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { loaded: { tables: ['users'] } },
    optimisticListUpdates: createOptimisticSortConfig(),
  });

  void envA.performClientItemUpdateAction(
    'users||1',
    { name: 'Zoe' },
    {
      withOptimisticUpdate: true,
      duration: 1_000,
    },
  );

  await advanceTime(0);

  const queryKey = envB.getQueryKey({ tableId: 'users' });
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    envB.getStoreItemKeyFromRaw('users||2'),
    envB.getStoreItemKeyFromRaw('users||1'),
  ]);
});

test('list query failed optimistic mutations revert the synced background state', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-optimistic-error');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: { loaded: { tables: ['users'] } },
    optimisticListUpdates: createOptimisticSortConfig(),
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { loaded: { tables: ['users'] } },
    optimisticListUpdates: createOptimisticSortConfig(),
  });

  renderHook(() => envA.apiStore.useListQuery({ tableId: 'users' }));

  let mutationPromise!: ReturnType<typeof envA.apiStore.performMutation>;
  act(() => {
    mutationPromise = envA.apiStore.performMutation('users||1', {
      optimisticUpdate: (itemPayload) => {
        envA.apiStore.updateItemState(itemPayload, (draft) => {
          draft.name = 'Zoe';
        });
      },
      mutation: async () => {
        await wait(100);
        throw new Error('Mutation failed');
      },
      getRelatedQueries: (query) => query.tableId === 'users',
    });
  });

  await advanceTime(0);

  const itemKey = envB.getStoreItemKeyFromRaw('users||1');
  const secondItemKey = envB.getStoreItemKeyFromRaw('users||2');
  const queryKey = envB.getQueryKey({ tableId: 'users' });

  expect(envB.store.state.items[itemKey]?.name).toBe('Zoe');
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    secondItemKey,
    itemKey,
  ]);

  await flushAllTimers();
  const result = await mutationPromise;

  expect(result.ok).toBe(false);
  expect(envB.store.state.items[itemKey]?.name).toBe('Alice');
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    itemKey,
    secondItemKey,
  ]);
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
});
