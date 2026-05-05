import { act, renderHook } from '@testing-library/react';
import { rc_number, rc_object } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createStoreManager } from '../src/storeManager';
import {
  createFocusChangeCoordinator,
  getMessageKinds,
} from './browser-tabs/browser-tabs-test-helpers';
import {
  createInspectableInMemoryBrowserTabsTransportFactory,
  getNextStoreId,
} from './mocks/browserTabsTestUtils';
import { createCollectionStoreTestEnv } from './mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from './mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from './mocks/listQueryStoreTestEnv';
import { normalizeError, TEST_INITIAL_TIME } from './mocks/testEnvUtils';
import { flushAllTimers } from './utils/genericTestUtils';

const docSchema = rc_object({ value: rc_number });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  localStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  localStorage.clear();
});

test('getAllStoreIds returns the registered ids across mixed store types', () => {
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });

  createDocumentStoreTestEnv(1, { id: 'doc-store', storeManager });
  createCollectionStoreTestEnv(
    { '1': { title: 'Todo', completed: false } },
    { id: 'todos', storeManager },
  );
  createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    { id: 'users', storeManager },
  );

  expect(storeManager.getAllStoreIds()).toMatchInlineSnapshot(`
    ['doc-store', 'todos', 'users']
  `);
});

test('store defaults use built-in timing values and disabled window-close blocking', () => {
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });

  const { dynamicRealtimeThrottleMs, ...storeDefaults } =
    storeManager.storeDefaults;

  expect({
    ...storeDefaults,
    focusedRealtimeThrottleMs: dynamicRealtimeThrottleMs({
      lastFetchDuration: 800,
      windowIsNotFocused: false,
    }),
    backgroundRealtimeThrottleMs: dynamicRealtimeThrottleMs({
      lastFetchDuration: 800,
      windowIsNotFocused: true,
    }),
  }).toMatchInlineSnapshot(`
    backgroundCoalescingDelayMs: 3000
    backgroundRealtimeThrottleMs: 1000
    baseCoalescingWindowMs: 16
    blockWindowClose: null
    focusedRealtimeThrottleMs: 100
    lowPriorityThrottleMs: 2400000
  `);
});

test('store defaults can be configured on the store manager', () => {
  const blockWindowClose = vi.fn(() => ({ unblock: vi.fn() }));
  const dynamicRealtimeThrottleMs = vi.fn(() => 300);
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 25,
    baseCoalescingWindowMs: 50,
    backgroundCoalescingDelayMs: 750,
    dynamicRealtimeThrottleMs,
    blockWindowClose,
    revalidateOnWindowFocus: true,
  });

  expect({
    ...storeManager.storeDefaults,
    blockWindowClose:
      storeManager.storeDefaults.blockWindowClose === blockWindowClose,
    dynamicRealtimeThrottleMs:
      storeManager.storeDefaults.dynamicRealtimeThrottleMs ===
      dynamicRealtimeThrottleMs,
  }).toMatchInlineSnapshot(`
    backgroundCoalescingDelayMs: 750
    baseCoalescingWindowMs: 50
    blockWindowClose: '✅'
    dynamicRealtimeThrottleMs: '✅'
    lowPriorityThrottleMs: 25
    revalidateOnWindowFocus: '✅'
  `);
});

test('mixed stores share one manager-level browser-tab presence channel', () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const tabs = createFocusChangeCoordinator(['app'], 'app');
  const bindFocusController = tabs.bind('app');
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });
  const idPrefix = getNextStoreId('manager-presence');

  const documentEnv = createDocumentStoreTestEnv(1, {
    id: `${idPrefix}-document`,
    storeManager,
    browserTabsTransportFactory: transport.transportFactory,
    bindFocusController,
  });
  const collectionEnv = createCollectionStoreTestEnv(
    { '1': { title: 'Todo', completed: false } },
    {
      id: `${idPrefix}-collection`,
      storeManager,
      browserTabsTransportFactory: transport.transportFactory,
      bindFocusController,
    },
  );
  const listQueryEnv = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: `${idPrefix}-list`,
      storeManager,
      browserTabsTransportFactory: transport.transportFactory,
      bindFocusController,
    },
  );

  const initialStatusMessages = transport.getMessages().filter((entry) => {
    return getMessageKinds([entry])[0] === 'tab-status';
  });

  expect(initialStatusMessages).toHaveLength(1);
  expect(
    Array.from(
      new Set(initialStatusMessages.map(({ channelName }) => channelName)),
    ),
  ).toMatchInlineSnapshot(`['tsdf:presence:manager']`);

  vi.advanceTimersByTime(2_500);

  const statusMessagesAfterQuietPeriod = transport
    .getMessages()
    .filter((entry) => {
      return getMessageKinds([entry])[0] === 'tab-status';
    });

  expect(statusMessagesAfterQuietPeriod).toHaveLength(1);
  expect(
    Array.from(
      new Set(
        statusMessagesAfterQuietPeriod.map(({ channelName }) => channelName),
      ),
    ),
  ).toMatchInlineSnapshot(`['tsdf:presence:manager']`);

  documentEnv.apiStore.dispose();
  collectionEnv.apiStore.dispose();
  listQueryEnv.apiStore.dispose();
});

test('browser-tab presence stays alive until the last store is disposed', async () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const tabs = createFocusChangeCoordinator(['app'], 'app');
  const bindFocusController = tabs.bind('app');
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });
  const idPrefix = getNextStoreId('manager-presence-lifetime');

  const documentEnv = createDocumentStoreTestEnv(1, {
    id: `${idPrefix}-document`,
    storeManager,
    browserTabsTransportFactory: transport.transportFactory,
    bindFocusController,
  });
  const collectionEnv = createCollectionStoreTestEnv(
    { '1': { title: 'Todo', completed: false } },
    {
      id: `${idPrefix}-collection`,
      storeManager,
      browserTabsTransportFactory: transport.transportFactory,
      bindFocusController,
    },
  );

  documentEnv.apiStore.dispose();
  await tabs.blur();

  expect(
    transport.getMessages().filter((entry) => {
      return getMessageKinds([entry])[0] === 'tab-status';
    }),
  ).toHaveLength(2);

  collectionEnv.apiStore.dispose();
  await tabs.focusTab('app');

  expect(
    transport.getMessages().filter((entry) => {
      return getMessageKinds([entry])[0] === 'tab-status';
    }),
  ).toHaveLength(2);
});

test('manager-level browser-tab presence does not poll while focused or backgrounded', async () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const tabs = createFocusChangeCoordinator(['app'], 'app');
  const bindFocusController = tabs.bind('app');
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });

  const documentEnv = createDocumentStoreTestEnv(1, {
    id: getNextStoreId('background-presence-doc'),
    storeManager,
    browserTabsTransportFactory: transport.transportFactory,
    bindFocusController,
  });
  const collectionEnv = createCollectionStoreTestEnv(
    { '1': { title: 'Todo', completed: false } },
    {
      id: getNextStoreId('background-presence-collection'),
      storeManager,
      browserTabsTransportFactory: transport.transportFactory,
      bindFocusController,
    },
  );

  const initialStatusMessages = transport.getMessages().filter((entry) => {
    return getMessageKinds([entry])[0] === 'tab-status';
  });

  expect(initialStatusMessages).toHaveLength(1);

  vi.advanceTimersByTime(2_500);

  expect(
    transport.getMessages().filter((entry) => {
      return getMessageKinds([entry])[0] === 'tab-status';
    }),
  ).toHaveLength(initialStatusMessages.length);

  await tabs.blur();
  const statusMessagesAfterBlur = transport.getMessages().filter((entry) => {
    return getMessageKinds([entry])[0] === 'tab-status';
  });

  expect(statusMessagesAfterBlur).toHaveLength(2);

  vi.advanceTimersByTime(2_500);

  expect(
    transport.getMessages().filter((entry) => {
      return getMessageKinds([entry])[0] === 'tab-status';
    }),
  ).toHaveLength(statusMessagesAfterBlur.length);

  documentEnv.apiStore.dispose();
  collectionEnv.apiStore.dispose();
});

test('stores inherit manager dynamic realtime throttling unless they override it', async () => {
  const managerDynamicRealtimeThrottleMs = vi.fn(() => 300);
  const storeDynamicRealtimeThrottleMs = vi.fn(() => 700);
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
    dynamicRealtimeThrottleMs: managerDynamicRealtimeThrottleMs,
  });

  const inheritedEnv = createDocumentStoreTestEnv(1, {
    id: 'manager-rtu-throttle-doc',
    storeManager,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });
  const overrideEnv = createDocumentStoreTestEnv(1, {
    id: 'store-rtu-throttle-doc',
    storeManager,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: storeDynamicRealtimeThrottleMs,
  });

  renderHook(() => inheritedEnv.apiStore.useDocument().data?.value);
  renderHook(() => overrideEnv.apiStore.useDocument().data?.value);
  await flushAllTimers();

  // Seed a real-time fetch duration so the next RTU has a previous fetch cost to
  // feed into the adaptive throttle callback.
  inheritedEnv.emulateExternalRTU(2);
  overrideEnv.emulateExternalRTU(2);
  await flushAllTimers();

  managerDynamicRealtimeThrottleMs.mockClear();
  storeDynamicRealtimeThrottleMs.mockClear();

  inheritedEnv.emulateExternalRTU(3);
  overrideEnv.emulateExternalRTU(3);

  expect(managerDynamicRealtimeThrottleMs).toHaveBeenCalledOnce();
  expect(managerDynamicRealtimeThrottleMs.mock.calls).toMatchInlineSnapshot(`
    - - { lastFetchDuration: 800, windowIsNotFocused: '❌' }
  `);
  expect(storeDynamicRealtimeThrottleMs).toHaveBeenCalledOnce();
  expect(storeDynamicRealtimeThrottleMs.mock.calls).toMatchInlineSnapshot(`
    - - { lastFetchDuration: 800, windowIsNotFocused: '❌' }
  `);
});

test('duplicate ids are rejected within the same store manager', () => {
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });

  createDocumentStoreTestEnv(1, { id: 'shared-doc', storeManager });

  expect(() => {
    createDocumentStoreTestEnv(2, { id: 'shared-doc', storeManager });
  }).toThrow(
    '[tsdf] Duplicate store id "shared-doc" created in the same storeManager. Store ids must be unique per manager so global operations like resetAll(...) stay unambiguous.',
  );
});

test('dispose unregisters stores and allows recreating the same id', () => {
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });

  const documentEnv = createDocumentStoreTestEnv(1, {
    id: 'doc-store',
    storeManager,
  });
  const collectionEnv = createCollectionStoreTestEnv(
    { '1': { title: 'Todo', completed: false } },
    { id: 'todos', storeManager },
  );
  const listQueryEnv = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    { id: 'users', storeManager },
  );

  documentEnv.apiStore.dispose();
  documentEnv.apiStore.dispose();
  collectionEnv.apiStore.dispose();

  expect(storeManager.getAllStoreIds()).toMatchInlineSnapshot(`
    ['users']
  `);

  createDocumentStoreTestEnv(2, { id: 'doc-store', storeManager });

  listQueryEnv.apiStore.dispose();

  expect(storeManager.getAllStoreIds()).toMatchInlineSnapshot(`
    ['doc-store']
  `);
});

test('resetAll resets every registered store except ignored ids', async () => {
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });

  const documentEnv = createDocumentStoreTestEnv(1, {
    id: 'doc-store',
    storeManager,
    testScenario: 'loaded',
  });
  const collectionEnv = createCollectionStoreTestEnv(
    { '1': { title: 'Todo', completed: false } },
    { id: 'collection-store', storeManager, testScenario: 'loaded' },
  );
  const listQueryEnv = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    { id: 'list-store', storeManager },
  );

  listQueryEnv.scheduleFetch('highPriority', { tableId: 'users' });
  await flushAllTimers();

  storeManager.resetAll(['collection-store']);

  expect(documentEnv.store.state).toMatchInlineSnapshot(`
    data: null
    error: null
    refetchOnMount: 'lowPriority'
    status: 'idle'
  `);
  expect(collectionEnv.store.state).toMatchInlineSnapshot(`
    "1:
      data:
        value: { completed: '❌', title: 'Todo' }
      error: null
      payload: '1'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
  `);
  expect(listQueryEnv.store.state).toMatchInlineSnapshot(`
    itemFieldInvalidationFields: {}

    itemLoadedFields: {}

    itemQueries: {}

    items: {}

    queries: {}
  `);
});

test('onTransportReconnect broadcasts reconnect revalidation to registered realtime stores', async () => {
  const tabs = createFocusChangeCoordinator(['app'], 'app');
  const bindFocusController = tabs.bind('app');
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });

  const documentEnv = createDocumentStoreTestEnv(1, {
    id: 'realtime-doc-store',
    storeManager,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    bindFocusController,
  });
  const nonRealtimeDocumentEnv = createDocumentStoreTestEnv(2, {
    id: 'non-realtime-doc-store',
    storeManager,
    testScenario: 'loaded',
    bindFocusController,
  });
  const collectionEnv = createCollectionStoreTestEnv(
    { '1': { title: 'Todo', completed: false } },
    {
      id: 'realtime-collection-store',
      storeManager,
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 300,
      bindFocusController,
    },
  );
  const listQueryEnv = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: 'realtime-list-store',
      storeManager,
      testScenario: { loaded: { tables: ['users'] } },
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 300,
      bindFocusController,
    },
  );

  renderHook(() => documentEnv.apiStore.useDocument().data?.value);
  renderHook(() => nonRealtimeDocumentEnv.apiStore.useDocument().data?.value);
  renderHook(() => collectionEnv.apiStore.useItem('1'));
  renderHook(() => listQueryEnv.apiStore.useListQuery({ tableId: 'users' }));
  renderHook(() => listQueryEnv.apiStore.useItem('users||1'));

  await flushAllTimers();

  const documentFetchesBeforeReconnect =
    documentEnv.serverMock.numOfStartedFetches;
  const nonRealtimeDocumentFetchesBeforeReconnect =
    nonRealtimeDocumentEnv.serverMock.numOfStartedFetches;
  collectionEnv.serverTable.fetchHistory.length = 0;
  listQueryEnv.serverTable.fetchHistory.length = 0;

  // A transport reconnect is an app-level event. The manager should fan it out
  // to every attached realtime store while non-realtime stores stay untouched.
  act(() => {
    storeManager.onTransportReconnect();
  });

  await flushAllTimers();

  expect(documentEnv.serverMock.numOfStartedFetches).toBe(
    documentFetchesBeforeReconnect + 1,
  );
  expect(nonRealtimeDocumentEnv.serverMock.numOfStartedFetches).toBe(
    nonRealtimeDocumentFetchesBeforeReconnect,
  );

  expect(
    collectionEnv.serverTable.getRequestHistory('item', { includeTime: false }),
  ).toMatchInlineSnapshot(`
    - _type: 'item'
      payload: { itemId: '1' }
  `);

  expect(
    listQueryEnv.serverTable.getRequestHistory('all', { includeTime: false }),
  ).toMatchInlineSnapshot(`
    - _type: 'list'
      payload:
        fields: '*'
        pos: { limit: 50, offset: 0 }
      returned_items: 1
    - _type: 'item'
      payload: { itemId: 'users||1' }
  `);
});

test('onTransportReconnect does not notify disposed stores', async () => {
  const tabs = createFocusChangeCoordinator(['app'], 'app');
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });
  const documentEnv = createDocumentStoreTestEnv(1, {
    id: 'disposed-realtime-doc-store',
    storeManager,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    bindFocusController: tabs.bind('app'),
  });

  renderHook(() => documentEnv.apiStore.useDocument().data?.value);

  await flushAllTimers();

  const fetchesBeforeDispose = documentEnv.serverMock.numOfStartedFetches;

  documentEnv.apiStore.dispose();

  act(() => {
    storeManager.onTransportReconnect();
  });

  await flushAllTimers();

  expect(documentEnv.serverMock.numOfStartedFetches).toBe(fetchesBeforeDispose);
});

test('store with persistentStorage.offline throws when storeManager has no offlineSession', () => {
  // Manager is intentionally missing the offlineSession option, so any store
  // that opts into offline persistence must fail fast with a clear message.
  const storeManager = createStoreManager({
    getSessionKey: () => 'manager-session',
    errorNormalizer: normalizeError,
  });

  expect(() => {
    createDocumentStoreTestEnv(1, {
      id: 'offline-doc-without-session',
      storeManager,
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {},
      },
    });
  }).toThrow(
    '[tsdf] Store "offline-doc-without-session" has persistentStorage.offline configured but storeManager was created without offlineSession',
  );
});

test('inline offline session config inherits session scoping from the store manager', () => {
  const storeManager = createStoreManager({
    getSessionKey: () => 'manager-session',
    errorNormalizer: normalizeError,
    offlineSession: { network: { enabled: true } },
  });
  const offlineSession = storeManager;

  createDocumentStoreTestEnv(1, {
    id: 'manager-bound-offline-doc',
    storeManager,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {},
    },
  });

  expect(offlineSession.getSessionKey()).toBe('manager-session');
});

test('offline uploads config is attached through the manager-owned session', () => {
  const upload = vi.fn(({ id }: { id: string }) => Promise.resolve({ id }));
  const adapter = {
    save: vi.fn(() => Promise.resolve()),
    load: vi.fn(() => Promise.resolve(null)),
    list: vi.fn(() => Promise.resolve([])),
    remove: vi.fn(() => Promise.resolve()),
    clearSession: vi.fn(() => Promise.resolve()),
  };
  const storeManager = createStoreManager({
    getSessionKey: () => 'manager-session',
    errorNormalizer: normalizeError,
    offlineSession: {
      network: { enabled: true },
      uploads: { adapter, upload },
    },
  });

  const uploadsConfig = storeManager.getOfflineConfig()!.uploads!;

  expect(uploadsConfig.adapter).toBe(adapter);
  expect(uploadsConfig.upload).toBe(upload);
});

test('offline manager api returns empty defaults when offline is not configured', async () => {
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });
  const offlineHook = renderHook(() => ({
    entities: storeManager.useOfflineEntities(),
    resolutions: storeManager.useOfflineResolutions(),
    status: storeManager.useOfflineStatus(),
    uploads: storeManager.useOfflineUploads(),
  }));

  (
    await storeManager.saveOfflineUpload({
      id: 'avatar',
      file: new File(['body'], 'avatar.txt', { type: 'text/plain' }),
    })
  ).unwrap();
  (
    await storeManager.replaceOfflineUpload({
      id: 'avatar',
      file: new File(['next body'], 'avatar.txt', { type: 'text/plain' }),
    })
  ).unwrap();

  expect(storeManager.getOfflineConfig()).toBeUndefined();
  expect(storeManager.getOfflineRuntimeConfig()).toMatchInlineSnapshot(`
    mutationQueueing: { network: 'allow', outage: 'allow' }
    network: { enabled: '❌' }
    outage: { enabled: '❌' }
  `);
  expect(storeManager.getOfflineStatus()).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '❌'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '❌' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'shared-session'
    updatedAt: 1735689600000
  `);
  expect((await storeManager.loadOfflineUpload('avatar')).unwrap()).toBeNull();
  (await storeManager.deleteOfflineUpload('avatar')).unwrap();
  expect(storeManager.getOfflineUploads()).toMatchInlineSnapshot(`[]`);
  expect(offlineHook.result.current).toMatchInlineSnapshot(`
    entities: []
    resolutions: []

    status:
      isLeader: '✅'
      isOfflineMode: '❌'
      lastFailureAt: null
      lastRecoveryCheckAt: null
      network: { active: '❌', enabled: '❌' }
      outage: { active: '❌', enabled: '❌' }
      sessionKey: 'shared-session'
      updatedAt: 1735689600000

    uploads: []
  `);
});
