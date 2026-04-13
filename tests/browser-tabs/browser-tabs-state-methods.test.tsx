import { act } from 'react';
import { rc_object, rc_parse, rc_string } from 'runcheck';
import { expect, test } from 'vitest';
import {
  type BrowserTabsTransportAuditEntry,
  createInspectableInMemoryBrowserTabsTransportFactory,
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
  createUsersTable,
  setupBrowserTabsTestLifecycle,
  wait,
} from './browser-tabs-test-helpers';

setupBrowserTabsTestLifecycle();

const collectionSnapshotWithNameSchema = rc_object({
  kind: rc_string,
  item: rc_object({
    data: rc_object({ value: rc_object({ name: rc_string }) }),
  }),
});

const listItemSnapshotWithNameSchema = rc_object({
  kind: rc_string,
  item: rc_object({ name: rc_string }),
});

function isCollectionSnapshotWithName(
  entry: BrowserTabsTransportAuditEntry,
  expectedName: string,
): boolean {
  const result = rc_parse(entry.message, collectionSnapshotWithNameSchema);
  return (
    result.ok &&
    result.value.kind === 'collection-item-snapshot' &&
    result.value.item.data.value.name === expectedName
  );
}

function isListItemSnapshotWithName(
  entry: BrowserTabsTransportAuditEntry,
  expectedName: string,
): boolean {
  const result = rc_parse(entry.message, listItemSnapshotWithNameSchema);
  return (
    result.ok &&
    result.value.kind === 'list-item-snapshot' &&
    result.value.item.name === expectedName
  );
}

test('document updateState changes are applied to background tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-update-state');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
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
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
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
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });

  envA.apiStore.updateItemState('item1', (draft) => {
    draft.value = { name: 'Updated' };
  });
  envA.apiStore.addItemToState('item3', { value: { name: 'Item 3' } });
  envA.apiStore.deleteItemState('item2');
  await advanceTime(0);

  expect(envB.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Updated' }`,
  );
  expect(envB.apiStore.getItemState('item3')?.data).toMatchInlineSnapshot(
    `value: { name: 'Item 3' }`,
  );
  expect(envB.apiStore.getItemState('item2')).toBeNull();
});

test('collection state changes emitted during an in-flight mutation sync immediately to background tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-state-methods-in-mutation');
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
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

  expect(envB.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'During mutation' }`,
  );

  await flushAllTimers();
  await mutationPromise;
});

test('list query state methods are applied to background tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-state-methods');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });

  envA.apiStore.updateItemState('users||1', (draft) => {
    draft.name = 'Zoe';
  });
  envA.apiStore.addItemToState(
    'users||3',
    { id: 3, name: 'Cara' },
    { addItemToQueries: { queries: { tableId: 'users' }, appendTo: 'end' } },
  );
  envA.apiStore.deleteItemState('users||2');
  await advanceTime(0);

  const queryKey = envB.getQueryKey({ tableId: 'users' });
  expect(envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')])
    .toMatchInlineSnapshot(`
      id: 1
      name: 'Zoe'
    `);
  expect(envB.store.state.items[envB.getStoreItemKeyFromRaw('users||3')])
    .toMatchInlineSnapshot(`
      id: 3
      name: 'Cara'
    `);
  expect(envB.store.state.items[envB.getStoreItemKeyFromRaw('users||2')]).toBe(
    null,
  );
  expect(envB.store.state.queries[queryKey]?.items).toMatchInlineSnapshot(
    `['"users||1', '"users||3']`,
  );
});

test('list query state changes emitted during an in-flight mutation sync immediately to background tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-state-methods-in-mutation');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
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
    });
  });

  await advanceTime(10);
  envA.apiStore.updateItemState('users||1', (draft) => {
    draft.name = 'During mutation';
  });
  await advanceTime(0);

  expect(envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')])
    .toMatchInlineSnapshot(`
      id: 1
      name: 'During mutation'
    `);

  await flushAllTimers();
  await mutationPromise;
});

test('local collection eviction does not broadcast deletion-like snapshots to background tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-local-eviction');
  const sharedServerTableState = createSharedServerTableState({
    item1: { name: 'Item 1' },
    item2: { name: 'Item 2' },
  });

  const envA = createCollectionStoreTestEnv(
    { item1: { name: 'Item 1' }, item2: { name: 'Item 2' } },
    {
      id,
      maxItems: 1,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      testScenario: { loadedWithStaleData: { item1: { name: 'Item 1' } } },
    },
  );
  const envB = createCollectionStoreTestEnv(
    { item1: { name: 'Item 1' }, item2: { name: 'Item 2' } },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      testScenario: { loadedWithStaleData: { item1: { name: 'Item 1' } } },
    },
  );

  envA.scheduleFetch('highPriority', 'item2');
  await flushAllTimers();
  await advanceTime(0);

  expect(envA.apiStore.getItemState('item1')).toBeUndefined();
  expect(envB.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Item 1' }`,
  );
  expect(envB.apiStore.getItemState('item2')?.data).toMatchInlineSnapshot(
    `value: { name: 'Item 2' }`,
  );
});

test('collection delete tombstones still reject delayed older snapshots', async () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-delete-stale-snapshot');
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });

  envB.apiStore.updateItemState('item1', (draft) => {
    draft.value.name = 'Older remote value';
  });
  await advanceTime(0);

  const oldSnapshot = transport
    .getMessages()
    .find((entry) => isCollectionSnapshotWithName(entry, 'Older remote value'));

  expect(oldSnapshot).toBeDefined();

  envA.apiStore.deleteItemState('item1');
  await advanceTime(0);

  transport.replayMessage(oldSnapshot!);
  await advanceTime(0);

  expect(envA.apiStore.getItemState('item1')).toBeNull();
});

test('list-item delete tombstones still reject delayed older snapshots', async () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-item-delete-stale-snapshot');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });

  envB.apiStore.updateItemState('users||1', (draft) => {
    draft.name = 'Older remote value';
  });
  await advanceTime(0);

  const oldSnapshot = transport
    .getMessages()
    .find((entry) => isListItemSnapshotWithName(entry, 'Older remote value'));

  expect(oldSnapshot).toBeDefined();

  envA.apiStore.deleteItemState('users||1');
  await advanceTime(0);

  transport.replayMessage(oldSnapshot!);
  await advanceTime(0);

  expect(envA.apiStore.getItemState('users||1')).toBeNull();
});

test('document state updates do not sync to tabs without an active session key', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-state-no-session');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    getSessionKey: () => 'account-a',
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    getSessionKey: () => false,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });

  envA.apiStore.updateState((draft) => {
    draft.value = 2;
  });
  await advanceTime(0);

  expect(envB.store.state.data?.value).toBe(0);
});

test('document state sync starts only after tabs share the same session key', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-state-session-switch');
  const sharedServerState = createSharedServerMockState(0);
  let tabBSessionKey: string | false = 'account-b';

  const envA = createDocumentStoreTestEnv(0, {
    id,
    getSessionKey: () => 'account-a',
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    getSessionKey: () => tabBSessionKey,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });

  envA.apiStore.updateState((draft) => {
    draft.value = 2;
  });
  await advanceTime(0);

  expect(envB.store.state.data?.value).toBe(0);

  tabBSessionKey = 'account-a';
  envA.apiStore.updateState((draft) => {
    draft.value = 3;
  });
  await advanceTime(0);

  expect(envB.store.state.data?.value).toBe(3);
});

test('collection state updates do not sync to tabs without an active session key', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-state-no-session');
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    getSessionKey: () => 'account-a',
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    getSessionKey: () => false,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });

  envA.apiStore.updateItemState('item1', (draft) => {
    draft.value = { name: 'Updated' };
  });
  await advanceTime(0);

  expect(envB.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Item 1' }`,
  );
});

test('collection state sync starts only after tabs share the same session key', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-state-session-switch');
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );
  let tabBSessionKey: string | false = 'account-b';

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    getSessionKey: () => 'account-a',
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    getSessionKey: () => tabBSessionKey,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });

  envA.apiStore.updateItemState('item1', (draft) => {
    draft.value = { name: 'First update' };
  });
  await advanceTime(0);

  expect(envB.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Item 1' }`,
  );

  tabBSessionKey = 'account-a';
  envA.apiStore.updateItemState('item1', (draft) => {
    draft.value = { name: 'Second update' };
  });
  await advanceTime(0);

  expect(envB.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Second update' }`,
  );
});

test('list query state updates do not sync to tabs without an active session key', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-state-no-session');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    getSessionKey: () => 'account-a',
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    getSessionKey: () => false,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });

  envA.apiStore.updateItemState('users||1', (draft) => {
    draft.name = 'Zoe';
  });
  await advanceTime(0);

  expect(envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')])
    .toMatchInlineSnapshot(`
      id: 1
      name: 'Alice'
    `);
});

test('list query state sync starts only after tabs share the same session key', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-state-session-switch');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());
  let tabBSessionKey: string | false = 'account-b';

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    getSessionKey: () => 'account-a',
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    getSessionKey: () => tabBSessionKey,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });

  envA.apiStore.updateItemState('users||1', (draft) => {
    draft.name = 'First update';
  });
  await advanceTime(0);

  expect(envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')])
    .toMatchInlineSnapshot(`
      id: 1
      name: 'Alice'
    `);

  tabBSessionKey = 'account-a';
  envA.apiStore.updateItemState('users||1', (draft) => {
    draft.name = 'Second update';
  });
  await advanceTime(0);

  expect(envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')])
    .toMatchInlineSnapshot(`
      id: 1
      name: 'Second update'
    `);
});
