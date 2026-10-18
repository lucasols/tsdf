import { renderHook } from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';
import { createStoreManager } from '../../src/storeManager';
import {
  createInMemoryBrowserTabsTransportFactory,
  createInspectableInMemoryBrowserTabsTransportFactory,
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
import {
  normalizeError,
  setDefaultLowPriorityThrottleMs,
} from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import {
  countFetchHistoryEntries,
  createCollectionItems,
  createFocusChangeCoordinator,
  createOptimisticSortConfig,
  createUsersTable,
  getMessageKinds,
  getNonStatusMessages,
  getPublisherTabIds,
  setupBrowserTabsTestLifecycle,
} from './browser-tabs-test-helpers';

setupBrowserTabsTestLifecycle();

beforeEach(() => {
  setDefaultLowPriorityThrottleMs(60_000);
});

afterEach(() => {
  setDefaultLowPriorityThrottleMs(200);
});

test('collection snapshots do not re-broadcast after remote application', async () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-audit');
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });
  createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });
  createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });

  void envA.performClientUpdateAction(
    'item1',
    { name: 'Updated' },
    { withOptimisticUpdate: true, duration: 1_000 },
  );

  await flushAllTimers();

  const messages = getNonStatusMessages(transport.getMessages());
  expect(messages.length).toBeGreaterThan(0);
  expect(getPublisherTabIds(messages).size).toBe(1);
  expect(getMessageKinds(messages)).not.toContain('stale-marker');
});

// Item data holding a function can't go through the structured clone algorithm
// used by BroadcastChannel, so posting its snapshot throws a DataCloneError.
function createNonCloneableCollectionItems() {
  return { item1: { name: 'Item 1', format: () => 'Item 1' } };
}

test('collection fetches still complete and broadcast their success when the item data cannot be sent to other tabs', async () => {
  const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  onTestFinished(() => consoleWarn.mockRestore());
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const sharedServerTableState = createSharedServerTableState(
    createNonCloneableCollectionItems(),
  );

  const env = createCollectionStoreTestEnv(
    createNonCloneableCollectionItems(),
    {
      id: 'non-cloneable-collection',
      sharedServerTableState,
      browserTabsTransportFactory: transport.transportFactory,
    },
  );

  renderHook(() => {
    const item = env.apiStore.useItem('item1');
    env.trackItemUI('item1', item.data?.value.name);
  });

  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1  |
    0     | ···    | ui-initialized
    10ms  | ···    | 🔴 >fetch-started
    810ms | ···    | 🔴 <fetch-finished (value: {"name":"Item 1"})
    .     | Item 1 | ui-changed
    "
  `);
  // The item snapshot can't be posted, but the fetch itself succeeded, so the
  // fetch completion is still broadcast to the other tabs.
  expect(
    getMessageKinds(getNonStatusMessages(transport.getMessages())),
  ).toMatchInlineSnapshot(`['fetch-start', 'fetch-success']`);
  // The dropped snapshot is surfaced as a dev-only warning.
  expect(
    consoleWarn.mock.calls.map(([message]) => String(message)),
  ).toMatchInlineSnapshot(
    `- '[tsdf] Failed to sync a "collection-item-snapshot" message of the collection store "non-cloneable-collection" with other browser tabs'`,
  );
});

test('optimistic collection mutations still succeed when the item data cannot be sent to other tabs', async () => {
  const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  onTestFinished(() => consoleWarn.mockRestore());
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const sharedServerTableState = createSharedServerTableState(
    createNonCloneableCollectionItems(),
  );

  const env = createCollectionStoreTestEnv(
    createNonCloneableCollectionItems(),
    {
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      testScenario: 'loaded',
    },
  );

  renderHook(() => {
    const item = env.apiStore.useItem('item1');
    env.trackItemUI('item1', item.data?.value.name);
  });

  // The optimistic update publishes an item snapshot that can't be cloned.
  const mutation = env.performClientUpdateAction(
    'item1',
    { name: 'Updated', format: () => 'Updated' },
    { withOptimisticUpdate: true, duration: 1_000 },
  );

  await flushAllTimers();

  // Failing to sync with other tabs must not fail the local mutation.
  expect((await mutation).ok).toBe(true);
  expect(env.apiStore.getItemState('item1')?.data?.value.name).toBe('Updated');
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1              |
    0     | Item 1             | ui-initialized
    .     | {"name":"Updated"} | ⬜ optimistic-ui-commit
    .     | {"name":"Updated"} | ⬜ >mutation-started (value: {"name":"Updated"})
    .     | Updated            | ui-changed
    700ms | Updated            | ⬜ <mutation-data-persisted (value: {"name":"Updated"})
    "
  `);
  expect(consoleWarn).toHaveBeenCalled();
});

test('collection resets stay local to the tab that triggered them', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-reset');
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

  envA.apiStore.reset();
  await advanceTime(0);

  expect(envA.store.state).toMatchInlineSnapshot(`{}`);
  expect(envA.apiStore.getItemState('item1')).toBeUndefined();
  expect(
    pick(envB.apiStore.getItemState('item1'), [
      'data',
      'status',
      'refetchOnMount',
    ]),
  ).toMatchInlineSnapshot(`
    data:
      value: { name: 'Item 1' }

    refetchOnMount: '❌'
    status: 'success'
  `);
});

test('a fresh collection tab reuses the sibling snapshot without a first local fetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-snapshot-before-first-subscribe');
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
    lowPriorityThrottleMs: 10_000,
    useBatchFetch: true,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'idle',
    lowPriorityThrottleMs: 10_000,
    useBatchFetch: true,
  });

  envA.serverTable.setItem('item1', { name: 'Updated' });

  envA.scheduleFetch('highPriority', 'item1');
  await flushAllTimers();

  renderHook(() => {
    const item = envB.apiStore.useItem('item1');
    envB.trackItemUI('item1', item.data?.value.name);
  });
  await flushAllTimers();

  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    0,
  );
  expect(pick(envB.apiStore.getItemState('item1'), ['data', 'status']))
    .toMatchInlineSnapshot(`
      data:
        value: { name: 'Updated' }

      status: 'success'
    `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    810ms | -       | <confirmed-snapshot-received (value: {"name":"Updated"})
    .     | Updated | ui-initialized
    "
  `);
});

test('tabs on different app versions fetch independently instead of applying sibling snapshots', async () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-app-version-isolation');
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  // Both releases use the same account and logical store id. Only the build
  // version distinguishes their otherwise incompatible browser-tab state.
  const previousReleaseManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    getAppVersion: () => '920.0.0',
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 10_000,
  });
  const currentReleaseManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    getAppVersion: () => '921.0.0',
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 10_000,
  });
  const previousReleaseTab = createCollectionStoreTestEnv(
    createCollectionItems(),
    {
      id,
      storeManager: previousReleaseManager,
      sharedServerTableState,
      browserTabsTransportFactory: transport.transportFactory,
      testScenario: 'loaded',
      useBatchFetch: true,
    },
  );
  const currentReleaseTab = createCollectionStoreTestEnv(
    createCollectionItems(),
    {
      id,
      storeManager: currentReleaseManager,
      sharedServerTableState,
      browserTabsTransportFactory: transport.transportFactory,
      testScenario: 'idle',
      useBatchFetch: true,
    },
  );

  // The old bundle publishes a newer snapshot. A current bundle must never
  // ingest it because its runtime type contract may have changed.
  previousReleaseTab.serverTable.setItem('item1', { name: 'Updated' });
  previousReleaseTab.scheduleFetch('highPriority', 'item1');
  await flushAllTimers();

  // Opening the item in the new bundle must perform its own fetch instead of
  // treating the incompatible sibling snapshot as its initial data.
  renderHook(() => {
    const item = currentReleaseTab.apiStore.useItem('item1');
    currentReleaseTab.trackItemUI('item1', item.data?.value.name);
  });
  await flushAllTimers();

  // Both versions fetched from their own runtime, proving the prior release's
  // snapshot did not become the current release's initial data.
  expect({
    currentRelease: currentReleaseTab.serverTable.getRequestHistory('all'),
    previousRelease: previousReleaseTab.serverTable.getRequestHistory('all'),
  }).toMatchInlineSnapshot(`
    currentRelease:
      - _type: 'item'
        payload: { itemId: 'item1' }
        time: '820ms -> 1.62s | duration: 800ms'
    previousRelease:
      - _type: 'item'
        payload: { itemId: 'item1' }
        time: '10ms -> 810ms | duration: 800ms'
  `);
  expect(currentReleaseTab.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    810ms | ···     | ui-initialized
    820ms | ···     | 🔴 >fetch-started
    1.62s | ···     | 🔴 <fetch-finished (value: {"name":"Updated"})
    .     | Updated | ui-changed
    "
  `);
  expect(previousReleaseTab.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    0     | server-data-changed (value: {"name":"Updated"})
    .     | scheduled-fetch-triggered
    10ms  | 🔴 >fetch-started
    810ms | 🔴 <fetch-finished (value: {"name":"Updated"})
    "
  `);

  // Presence and collection traffic are both namespaced, so future message
  // kinds added to either channel inherit the same cross-release isolation.
  expect(
    Array.from(
      new Set(
        transport
          .getMessages()
          .map(({ channelName }) => channelName.replace(id, '<store-id>')),
      ),
    ).sort(),
  ).toMatchInlineSnapshot(`
    - 'tsdf:app:920.0.0:collection:<store-id>'
    - 'tsdf:app:920.0.0:presence:manager'
    - 'tsdf:app:921.0.0:collection:<store-id>'
    - 'tsdf:app:921.0.0:presence:manager'
  `);
});

test('confirmed collection snapshots do not overwrite a local in-flight mutation, and the tabs re-sync once it ends', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-conflict');
  const sharedServerTableState = createSharedServerTableState({
    item1: { name: 'Initial' },
  });

  const envA = createCollectionStoreTestEnv(
    { item1: { name: 'Initial' } },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      testScenario: 'loaded',
    },
  );
  const envB = createCollectionStoreTestEnv(
    { item1: { name: 'Initial' } },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      testScenario: 'loaded',
    },
  );

  renderHook(() => {
    const item = envB.apiStore.useItem('item1');
    envB.trackItemUI('item1', item.data?.value.name);
  });

  void envB.performClientUpdateAction(
    'item1',
    { name: 'Local' },
    { withOptimisticUpdate: true, duration: 1_000 },
  );
  await advanceTime(0);
  await advanceTime(1);

  envA.apiStore.updateItemState('item1', (draft) => {
    draft.value = { name: 'Remote' };
  });
  await advanceTime(0);

  // The confirmed sibling snapshot must not clobber B's in-flight optimistic
  // value.
  expect(pick(envB.apiStore.getItemState('item1'), ['data', 'refetchOnMount']))
    .toMatchInlineSnapshot(`
      data:
        value: { name: 'Local' }

      refetchOnMount: '❌'
    `);

  await flushAllTimers();

  // B ignored a confirmed snapshot during its mutation, so it can't assume it
  // still matches A. It revalidates once the mutation ends and broadcasts the
  // server value, so both tabs converge instead of A keeping 'Remote'.
  expect(envB.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Local' }`,
  );
  expect(envA.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Local' }`,
  );
  expect(envB.serverTable.getRequestHistory('all')).toMatchInlineSnapshot(`
    - _type: 'item'
      payload: { itemId: 'item1' }
      time: '1.01s -> 1.81s | duration: 800ms'
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1            |
    0     | Initial          | ui-initialized
    .     | {"name":"Local"} | ⬜ optimistic-ui-commit
    .     | {"name":"Local"} | ⬜ >mutation-started (value: {"name":"Local"})
    .     | Local            | ui-changed
    700ms | Local            | ⬜ <mutation-data-persisted (value: {"name":"Local"})
    1.01s | Local            | 🔴 >fetch-started
    1.81s | Local            | 🔴 <fetch-finished (value: {"name":"Local"})
    "
  `);
});

test('document snapshots do not re-broadcast after remote application', async () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-audit');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });
  createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });
  createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });

  void envA.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    duration: 1_000,
  });

  await flushAllTimers();

  const messages = getNonStatusMessages(transport.getMessages());
  expect(messages).toHaveLength(1);
  expect(getPublisherTabIds(messages).size).toBe(1);
  expect(getMessageKinds(messages)).not.toContain('stale-marker');
});

test('document resets stay local to the tab that triggered them', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-reset');
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

  envA.apiStore.reset();
  await advanceTime(0);

  expect(pick(envA.store.state, ['data', 'status', 'refetchOnMount']))
    .toMatchInlineSnapshot(`
      data: null
      refetchOnMount: 'lowPriority'
      status: 'idle'
    `);
  expect(pick(envB.store.state, ['data', 'status', 'refetchOnMount']))
    .toMatchInlineSnapshot(`
      data: { value: 0 }
      refetchOnMount: '❌'
      status: 'success'
    `);
});

test('a fresh document tab still performs its first fetch after a sibling tab fetched earlier', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-first-fetch-after-sibling');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
    lowPriorityThrottleMs: 10_000,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'idle',
    lowPriorityThrottleMs: 10_000,
  });

  envA.setServerData(7);

  envA.scheduleFetch('highPriority');
  await flushAllTimers();

  renderHook(() => {
    const doc = envB.apiStore.useDocument();
    envB.trackUIChanges(doc.data?.value);
  });
  await flushAllTimers();

  expect(envB.serverMock.fetchHistory).toHaveLength(1);
  expect(pick(envB.store.state, ['data', 'status'])).toMatchInlineSnapshot(`
    data: { value: 7 }
    status: 'success'
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    810ms | -  | <confirmed-snapshot-received (value: 7)
    820ms | -  | 🔴 >fetch-started
    1.62s | -  | 🔴 <fetch-finished (value: 7)
    .     | 7  | ui-initialized
    "
  `);
});

test('confirmed document snapshots do not overwrite a local in-flight mutation, and the tabs re-sync once it ends', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-conflict');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
  });

  renderHook(() => {
    const doc = envB.apiStore.useDocument();
    envB.trackUIChanges(doc.data?.value);
  });

  void envB.performClientUpdateAction(10, {
    withOptimisticUpdate: true,
    duration: 1_000,
  });
  await advanceTime(0);
  await advanceTime(1);

  envA.setServerData(20);
  envA.setNextFetchDurations(100);
  envA.scheduleFetch('highPriority');
  await advanceTime(200);

  // A's confirmed fetch result (20) must not clobber B's in-flight optimistic
  // value.
  expect(envB.store.state.data?.value).toBe(10);

  await flushAllTimers();

  // B's write lands after A's fetch, so the server ends with 10. B ignored a
  // confirmed snapshot during its mutation, so it revalidates once the
  // mutation ends and broadcasts the result: A converges instead of keeping
  // its stale 20.
  expect(envA.serverMock.current).toBe(10);
  expect(envB.store.state.data?.value).toBe(10);
  expect(envA.store.state.data?.value).toBe(10);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    0     | <optimistic-snapshot-received (value: 10)
    1ms   | server-data-changed (value: 20)
    .     | scheduled-fetch-triggered
    11ms  | 🔴 >fetch-started
    111ms | 🔴 <fetch-finished (value: 20)
    4.81s | <confirmed-snapshot-received (value: 10)
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 10 | ⬜ optimistic-ui-commit
    .     | 10 | ⬜ >mutation-started (value: 10)
    700ms | 10 | ⬜ <mutation-data-persisted (value: 10)
    4.01s | 10 | 🔴 >fetch-started
    4.81s | 10 | 🔴 <fetch-finished (value: 10)
    "
  `);
});

test('a document tab does not refetch after its mutation when the ignored sibling snapshot already matches it', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-matching-ignored-snapshot');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
  });

  renderHook(() => {
    const doc = envB.apiStore.useDocument();
    envB.trackUIChanges(doc.data?.value);
  });

  void envB.performClientUpdateAction(10, {
    withOptimisticUpdate: true,
    duration: 1_000,
  });

  // A refetches after B's server write (700ms) but before B's mutation
  // resolves (1000ms), so B ignores A's confirmed snapshot even though it
  // already carries B's value.
  await advanceTime(750);
  envA.setNextFetchDurations(100);
  envA.scheduleFetch('highPriority');

  await flushAllTimers();

  // The ignored snapshot matches B's final state, so the tabs already agree
  // and B skips the re-sync fetch.
  expect(envA.store.state.data?.value).toBe(10);
  expect(envB.store.state.data?.value).toBe(10);
  expect(envB.serverMock.fetchHistory).toHaveLength(0);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 10 | ⬜ optimistic-ui-commit
    .     | 10 | ⬜ >mutation-started (value: 10)
    700ms | 10 | ⬜ <mutation-data-persisted (value: 10)
    "
  `);
});

test('two tabs mutating the same document concurrently converge on the server value', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-missed-confirmed-snapshot');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
  });

  renderHook(() => {
    const doc = envA.apiStore.useDocument();
    envA.trackUIChanges(doc.data?.value);
  });
  renderHook(() => {
    const doc = envB.apiStore.useDocument();
    envB.trackUIChanges(doc.data?.value);
  });

  // Tab B starts a slow optimistic mutation: its server write lands at 1400ms
  // and the mutation only resolves at 2000ms.
  const mutationB = envB.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    duration: 2_000,
  });

  await advanceTime(1_100);

  // While B's mutation is still in flight, tab A saves a newer value (server
  // write at 1450ms) and revalidates. A's revalidation fetch broadcasts the
  // confirmed value while B is still mutation-locked, so B has to ignore it.
  envA.setNextFetchDurations(200);
  const mutationA = envA.performClientUpdateAction(2, {
    duration: 500,
    withRevalidation: true,
  });

  await flushAllTimers();

  expect((await mutationA).ok).toBe(true);
  expect((await mutationB).ok).toBe(true);

  // The server keeps A's later write. Both tabs must converge on it instead of
  // B keeping its optimistic value forever: B revalidates once its mutation
  // ends (the fetch starts later because B is a background tab).
  expect(envA.serverMock.current).toBe(2);
  expect(envA.store.state.data?.value).toBe(2);
  expect(envB.store.state.data?.value).toBe(2);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | <optimistic-snapshot-received (value: 1)
    .     | 1  | ui-changed
    1.1s  | 1  | ⬜ >mutation-started (value: 2)
    1.45s | 1  | ⬜ <mutation-data-persisted (value: 2)
    1.61s | 1  | 🔴 >fetch-started
    1.81s | 1  | 🔴 <fetch-finished (value: 2)
    .     | 2  | ui-changed
    5.81s | 2  | <confirmed-snapshot-received (value: 2)
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    1.4s  | 1  | ⬜ <mutation-data-persisted (value: 1)
    5.01s | 1  | 🔴 >fetch-started
    5.81s | 1  | 🔴 <fetch-finished (value: 2)
    .     | 2  | ui-changed
    "
  `);
});

test('a sibling fetch ignored during a mutation does not cancel the retry of the fetch the mutation interrupted', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-mutation-retry');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'b');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
  });

  // Tab B loads the document, so its later refetches can be satisfied by
  // sibling fetches
  envB.scheduleFetch('highPriority');
  await flushAllTimers();

  // Tab B starts a refetch, and a mutation interrupts it
  envB.setNextFetchDurations(800);
  envB.scheduleFetch('highPriority');
  await advanceTime(100);
  void envB.performClientUpdateAction(10, {
    withOptimisticUpdate: true,
    duration: 1_000,
  });

  // Tab A fetches while tab B's mutation holds the lock, so tab B ignores
  // its confirmed snapshot (and its fetch start)
  await advanceTime(100);
  await tabs.focusTab('a');
  envA.setNextFetchDurations(100);
  envA.scheduleFetch('highPriority');
  await flushAllTimers();

  // Tab B still retries the interrupted fetch once the mutation ends instead
  // of staying `refetching` with no fetch pending
  expect(pick(envB.store.state, ['status', 'data'])).toMatchInlineSnapshot(`
    data: { value: 10 }
    status: 'success'
  `);
  // The 🟡 fetch after the mutation is the retry; tab B is in the background
  // by then, so it waits for the background scheduling delay
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | -  | scheduled-fetch-triggered
    10ms  | -  | 🔴 >fetch-started
    810ms | -  | 🔴 <fetch-finished (value: 0)
    .     | -  | scheduled-fetch-triggered
    820ms | -  | 🟠 >fetch-started
    910ms | -  | 🟠 <fetch-aborted 🚫
    .     | 10 | ⬜ optimistic-ui-commit
    .     | 10 | ⬜ >mutation-started (value: 10)
    1.01s | 10 | 🔕 window-blurred
    1.61s | 10 | ⬜ <mutation-data-persisted (value: 10)
    4.92s | 10 | 🟡 >fetch-started
    5.72s | 10 | 🟡 <fetch-finished (value: 10)
    "
  `);
  // Tab A's fetch ran while tab B held the lock
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time   |
    810ms  | <confirmed-snapshot-received (value: 0)
    910ms  | <optimistic-snapshot-received (value: 10)
    1.015s | 👁 window-focused
    1.02s  | scheduled-fetch-triggered
    1.03s  | 🔴 >fetch-started
    1.13s  | 🔴 <fetch-finished (value: 0)
    5.72s  | <confirmed-snapshot-received (value: 10)
    "
  `);
});

test('a sibling fetch that fails after a mutation does not leave the retried fetch stuck', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-mutation-retry-failed-sibling');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'b');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
  });

  envB.scheduleFetch('highPriority');
  await flushAllTimers();

  // Tab B starts a refetch, and a mutation interrupts it
  envB.setNextFetchDurations(800);
  envB.scheduleFetch('highPriority');
  await advanceTime(100);
  void envB.performClientUpdateAction(10, {
    withOptimisticUpdate: true,
    duration: 1_000,
  });

  // Tab B goes to the background, so after the mutation ends its retry waits
  // for the background scheduling delay
  await advanceTime(100);
  await tabs.focusTab('a');
  await advanceTime(1_000);

  // Tab A fetches while tab B's retry is waiting, and its fetch fails, so it
  // publishes no confirmed snapshot for tab B
  envA.errorInNextFetch();
  envA.setNextFetchDurations(100);
  envA.scheduleFetch('highPriority');
  await flushAllTimers();

  // Tab B still runs its retry instead of staying `refetching` with no fetch
  // pending
  expect(pick(envB.store.state, ['status', 'data'])).toMatchInlineSnapshot(`
    data: { value: 10 }
    status: 'success'
  `);
});

test('list query snapshots do not re-broadcast after remote application', async () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-audit');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const createEnv = () =>
    createListQueryStoreTestEnv(createUsersTable(), {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transport.transportFactory,
      testScenario: { loaded: { tables: ['users'] } },
      optimisticListUpdates: createOptimisticSortConfig(),
    });

  const envA = createEnv();
  createEnv();
  createEnv();

  void envA.performClientItemUpdateAction(
    'users||1',
    { name: 'Zoe' },
    { withOptimisticUpdate: true, duration: 1_000 },
  );

  await flushAllTimers();

  const messages = getNonStatusMessages(transport.getMessages());
  expect(messages.length).toBeGreaterThan(0);
  expect(getPublisherTabIds(messages).size).toBe(1);
  expect(getMessageKinds(messages)).toEqual(
    expect.arrayContaining(['list-item-snapshot', 'list-query-snapshot']),
  );
  expect(getMessageKinds(messages)).not.toContain('stale-marker');
});

test('list query resets stay local to the tab that triggered them', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-reset');
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

  envA.apiStore.reset();
  await advanceTime(0);

  expect(envA.store.state).toMatchInlineSnapshot(`
    itemFieldInvalidationFields: {}

    itemLoadedFields: {}

    itemQueries: {}

    items: {}

    queries: {}
  `);

  const queryKey = envB.getQueryKey({ tableId: 'users' });
  expect(envB.store.state.queries[queryKey]?.items).toMatchInlineSnapshot(
    `['"users||1', '"users||2']`,
  );
});

test('a fresh list-query tab still performs its first fetch after a sibling tab fetched earlier', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-first-fetch-after-sibling');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
    lowPriorityThrottleMs: 10_000,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'idle',
    lowPriorityThrottleMs: 10_000,
  });

  envA.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' });
  await flushAllTimers();

  renderHook(() => {
    const query = envB.apiStore.useListQuery({ tableId: 'users' });
    envB.trackItemUI('users||1', query.items[0]?.name);
  });
  await flushAllTimers();

  const queryKey = envB.getQueryKey({ tableId: 'users' });
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    1,
  );
  expect(envB.store.state.queries[queryKey]?.items).toMatchInlineSnapshot(
    `['"users||1', '"users||2']`,
  );
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    10ms  | 🔴 >list-fetch-started
    810ms | 🔴 <list-fetch-finished (value: {"count":2})
    1.62s | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    810ms | ···      | ui-initialized
    820ms | ···      | 🔴 >list-fetch-started
    1.62s | ···      | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Alice    | ui-changed
    "
  `);
});

test('confirmed list query snapshots do not overwrite a local in-flight mutation, and the tabs re-sync once it ends', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-conflict');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: { loaded: { tables: ['users'] } },
    optimisticListUpdates: createOptimisticSortConfig(),
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: { loaded: { tables: ['users'] } },
    optimisticListUpdates: createOptimisticSortConfig(),
  });

  renderHook(() => {
    const item = envB.apiStore.useItem('users||1');
    envB.trackItemUI('users||1', item.data?.name);
  });
  renderHook(() => {
    envB.apiStore.useListQuery({ tableId: 'users' });
  });

  void envB.performClientItemUpdateAction(
    'users||1',
    { name: 'Zoe' },
    { withOptimisticUpdate: true, duration: 1_000 },
  );
  await advanceTime(0);
  await advanceTime(1);

  const itemKey = envB.getStoreItemKeyFromRaw('users||1');
  const queryKey = envB.getQueryKey({ tableId: 'users' });

  // B's optimistic rename re-sorts the list locally.
  expect(envB.store.state.items[itemKey]?.name).toBe('Zoe');
  expect(envB.store.state.queries[queryKey]?.items).toMatchInlineSnapshot(
    `['"users||2', '"users||1']`,
  );

  envA.serverTable.setItem('users||1', { id: 1, name: 'Aaron' });
  envA.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' });
  await advanceTime(900);

  // A's confirmed list snapshot must not clobber B's in-flight optimistic
  // state.
  expect(envB.store.state.items[itemKey]?.name).toBe('Zoe');
  expect(envB.store.state.queries[queryKey]?.items).toMatchInlineSnapshot(
    `['"users||2', '"users||1']`,
  );

  await flushAllTimers();

  // A's snapshot (server order) differs from B's optimistically sorted list,
  // so B revalidates the query once its mutation ends and both tabs converge
  // on the server result instead of keeping different orders.
  expect(envB.store.state.items[itemKey]?.name).toBe('Zoe');
  expect(envA.store.state.items[itemKey]?.name).toBe('Zoe');
  expect(envB.store.state.queries[queryKey]?.items).toEqual(
    envA.store.state.queries[queryKey]?.items,
  );
  expect(envB.store.state.queries[queryKey]?.items).toMatchInlineSnapshot(
    `['"users||1', '"users||2']`,
  );
  expect(envB.serverTable.getRequestHistory('all')).toMatchInlineSnapshot(`
    - _type: 'list'
      payload:
        fields: '*'
        pos: { limit: 50, offset: 0 }
      returned_items: 2
      time: '4.01s -> 4.81s | duration: 800ms'
  `);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    0     | <optimistic-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    .     | <optimistic-item-snapshot-received (value: {"id":1,"name":"Zoe"})
    .     | <optimistic-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    1ms   | server-data-changed (value: {"id":1,"name":"Aaron"})
    11ms  | 🔴 >list-fetch-started
    811ms | 🔴 <list-fetch-finished (value: {"count":2})
    4.81s | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1              |
    0     | Alice                 | ui-initialized
    .     | {"id":1,"name":"Zoe"} | ⬜ optimistic-ui-commit
    .     | {"id":1,"name":"Zoe"} | ⬜ >mutation-started (value: {"id":1,"name":"Zoe"})
    .     | Zoe                   | ui-changed
    700ms | Zoe                   | ⬜ <mutation-data-persisted (value: {"id":1,"name":"Zoe"})
    4.01s | Zoe                   | 🔴 >list-fetch-started
    4.81s | Zoe                   | 🔴 <list-fetch-finished (value: {"count":2})
    "
  `);
});

test('confirmed sibling item fetches do not overwrite a local optimistic list item mutation', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-stale-item-fetch');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: { loaded: { tables: ['users'] } },
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: { loaded: { tables: ['users'] } },
  });

  renderHook(() => {
    const item = envB.apiStore.useItem('users||1');
    envB.trackItemUI('users||1', item.data?.name);
  });

  void envB.performClientItemUpdateAction(
    'users||1',
    { name: 'Jane' },
    { withOptimisticUpdate: true, duration: 1_000 },
  );
  await advanceTime(0);

  const itemKey = envB.getStoreItemKeyFromRaw('users||1');
  expect(envB.store.state.items[itemKey]?.name).toBe('Jane');

  envA.apiStore.scheduleItemFetch('highPriority', 'users||1');
  await advanceTime(900);

  expect(envA.serverTable.fetchHistory).toMatchInlineSnapshot(`
    - duration: 800
      itemId: 'users||1'
      result: { id: 1, name: 'Jane' }
      startedAt: 10
      type: 'fetch'
  `);
  expect(envB.store.state.items[itemKey]?.name).toBe('Jane');

  await flushAllTimers();

  expect(envB.store.state.items[itemKey]?.name).toBe('Jane');
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    0,
  );
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    0     | <optimistic-item-snapshot-received (value: {"id":1,"name":"Jane"})
    .     | <optimistic-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    10ms  | 🔴 >fetch-started
    810ms | 🔴 <fetch-finished (value: {"id":1,"name":"Jane"})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1               |
    0     | Alice                  | ui-initialized
    .     | {"id":1,"name":"Jane"} | ⬜ optimistic-ui-commit
    .     | {"id":1,"name":"Jane"} | ⬜ >mutation-started (value: {"id":1,"name":"Jane"})
    .     | Jane                   | ui-changed
    700ms | Jane                   | ⬜ <mutation-data-persisted (value: {"id":1,"name":"Jane"})
    "
  `);
});
