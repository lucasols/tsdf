import { act } from 'react';
import { expect, test, vi } from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createInMemoryBrowserTabsTransportFactory,
  getNextStoreId,
} from '../mocks/browserTabsTestUtils';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import {
  createCollectionItems,
  createUsersTable,
  setupBrowserTabsTestLifecycle,
  wait,
} from './browser-tabs-test-helpers';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

vi.mock('@ls-stack/browser-utils/window', () => ({
  onWindowFocus: (handler: () => void) => {
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  },
  isWindowFocused: () => !document.hidden,
}));

setupBrowserTabsTestLifecycle();

test('document updateState changes are applied to background tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-update-state');

  const envA = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });

  envA.apiStore.updateState((draft) => {
    draft.value = 2;
  });
  await advanceTime(0);

  expect(envB.store.state.data?.value).toBe(2);
});

test('document state changes emitted during an in-flight mutation sync immediately to background tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-update-state-in-mutation');

  const envA = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });

  let mutationPromise!: ReturnType<typeof envA.apiStore.performMutation>;
  act(() => {
    mutationPromise = envA.apiStore.performMutation({
      mutation: async () => {
        await wait(200);
        return { value: 0 };
      },
    });
  });

  await advanceTime(10);
  envA.apiStore.updateState((draft) => {
    draft.value = 3;
  });
  await advanceTime(0);

  expect(envB.store.state.data?.value).toBe(3);

  await flushAllTimers();
  await mutationPromise;
});

test('collection state methods are applied to background tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-state-methods');

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });

  envA.apiStore.updateItemState('item1', (draft) => {
    draft.value = { name: 'Updated' };
  });
  envA.apiStore.addItemToState('item3', {
    value: { name: 'Item 3' },
  });
  envA.apiStore.deleteItemState('item2');
  await advanceTime(0);

  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Updated' },
  });
  expect(envB.apiStore.getItemState('item3')?.data).toEqual({
    value: { name: 'Item 3' },
  });
  expect(envB.apiStore.getItemState('item2')).toBeNull();
});

test('collection state changes emitted during an in-flight mutation sync immediately to background tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-state-methods-in-mutation');

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });

  let mutationPromise!: ReturnType<typeof envA.apiStore.performMutation>;
  act(() => {
    mutationPromise = envA.apiStore.performMutation('item1', {
      mutation: async () => {
        await wait(200);
        return { value: { name: 'Item 1' } };
      },
    });
  });

  await advanceTime(10);
  envA.apiStore.updateItemState('item1', (draft) => {
    draft.value = { name: 'During mutation' };
  });
  await advanceTime(0);

  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'During mutation' },
  });

  await flushAllTimers();
  await mutationPromise;
});

test('list query state methods are applied to background tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-state-methods');

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });

  envA.apiStore.updateItemState('users||1', (draft) => {
    draft.name = 'Zoe';
  });
  envA.apiStore.addItemToState(
    'users||3',
    {
      id: 3,
      name: 'Cara',
    },
    {
      addItemToQueries: {
        queries: { tableId: 'users' },
        appendTo: 'end',
      },
    },
  );
  envA.apiStore.deleteItemState('users||2');
  await advanceTime(0);

  const queryKey = envB.getQueryKey({ tableId: 'users' });
  expect(
    envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')],
  ).toEqual({
    id: 1,
    name: 'Zoe',
  });
  expect(
    envB.store.state.items[envB.getStoreItemKeyFromRaw('users||3')],
  ).toEqual({
    id: 3,
    name: 'Cara',
  });
  expect(envB.store.state.items[envB.getStoreItemKeyFromRaw('users||2')]).toBe(
    null,
  );
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    envB.getStoreItemKeyFromRaw('users||1'),
    envB.getStoreItemKeyFromRaw('users||3'),
  ]);
});

test('list query state changes emitted during an in-flight mutation sync immediately to background tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-state-methods-in-mutation');

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });

  let mutationPromise!: ReturnType<typeof envA.apiStore.performMutation>;
  act(() => {
    mutationPromise = envA.apiStore.performMutation('users||1', {
      mutation: async () => {
        await wait(200);
        return { id: 1, name: 'Alice' };
      },
      getRelatedQueries: (query) => query.tableId === 'users',
    });
  });

  await advanceTime(10);
  envA.apiStore.updateItemState('users||1', (draft) => {
    draft.name = 'During mutation';
  });
  await advanceTime(0);

  expect(
    envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')],
  ).toEqual({
    id: 1,
    name: 'During mutation',
  });

  await flushAllTimers();
  await mutationPromise;
});
