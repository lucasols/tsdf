import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { cleanup, renderHook } from '@testing-library/react';
import { rc_object, rc_string } from 'runcheck';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { DEFAULT_FETCH_DURATION_MS } from '../mocks/serverMock';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  createEnv as createListQueryEnv,
  rawItemPayload,
  setCachedItem as seedListItem,
  setCachedQuery as seedListQuery,
  storeItemKey,
} from '../persistent-storage/listQueryStorePersistenceTestShared';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';

const persistentStore = createLocalStoragePersistentTestStore();

const docSchema = rc_object({ value: rc_object({ text: rc_string }) });

type DocContent = { text: string };

function createDocEnv(storeName: string) {
  return createDocumentStoreTestEnv<DocContent>(
    { text: 'server' },
    {
      id: storeName,
      getSessionKey: () => 'session1',
      persistentStorage: { adapter: 'local-sync', schema: docSchema },
    },
  );
}

const noteSchema = rc_object({
  value: rc_object({ id: rc_string, text: rc_string }),
});

type Note = { id: string; text: string };

function createCollectionEnv(storeName: string) {
  return createCollectionStoreTestEnv<Note>(
    { a: { id: 'a', text: 'server a' }, b: { id: 'b', text: 'server b' } },
    {
      id: storeName,
      getSessionKey: () => 'session1',
      persistentStorage: {
        adapter: 'local-sync',
        schema: noteSchema,
        payloadSchema: rc_string,
      },
    },
  );
}

function seedNote(storeName: string, id: string, text: string) {
  persistentStore
    .scope(storeName, 'session1')
    .collection.seedItem(id, { value: { id, text } });
}

function seedDoc(storeName: string, text: string) {
  persistentStore
    .scope(storeName, 'session1')
    .document.seed({ value: { text } });
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  localStorage.clear();
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});

describe('document store', () => {
  test('a document restored from storage is refreshed before reporting success', async () => {
    // The tab opens with an old snapshot of the document in storage
    seedDoc('doc-restored', 'stale');
    const env = createDocEnv('doc-restored');

    const renders = createLoggerStore();

    renderHook(() => {
      const { status, data } = env.apiStore.useDocument({
        requireFreshData: 'ifFromStorage',
      });
      renders.add({ status, text: data?.value.text ?? null });
    });

    await flushAllTimers();

    // The restored data stays available, but the hook only reports ready
    // after the server response replaced it
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ text: stale
      -> status: success ⋅ text: server
      "
    `);
    expect(env.serverMock.numOfFinishedFetches).toBe(1);
  });

  test('a document already refreshed in this tab keeps the normal cache behavior', async () => {
    seedDoc('doc-refreshed', 'stale');
    const env = createDocEnv('doc-refreshed');

    // A first editor refreshes the restored document, then closes
    const firstEditor = renderHook(() =>
      env.apiStore.useDocument({ requireFreshData: 'ifFromStorage' }),
    );
    await flushAllTimers();
    firstEditor.unmount();
    expect(env.serverMock.numOfFinishedFetches).toBe(1);

    const renders = createLoggerStore();

    // Reopening it right away serves the in-memory server data immediately
    renderHook(() => {
      const { status, data } = env.apiStore.useDocument({
        requireFreshData: 'ifFromStorage',
      });
      renders.add({ status, text: data?.value.text ?? null });
    });
    await flushAllTimers();

    // No loading state, and no forced request: the 🟠 fetch is the regular
    // low-priority mount revalidation, sent after the low-priority throttle
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ text: server
      "
    `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      10ms  | 🔴 >fetch-started
      810ms | 🔴 <fetch-finished (value: {"text":"server"})
      2.01s | 🟠 >fetch-started
      2.81s | 🟠 <fetch-finished (value: {"text":"server"})
      "
    `);
  });

  test('a document fetched in this tab is not treated as restored', async () => {
    // Nothing persisted: the first mount loads the document from the server
    const env = createDocEnv('doc-not-persisted');

    const renders = createLoggerStore();

    renderHook(() => {
      const { status, data } = env.apiStore.useDocument({
        requireFreshData: 'ifFromStorage',
      });
      renders.add({ status, text: data?.value.text ?? null });
    });
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ text: null
      -> status: success ⋅ text: server
      "
    `);
    expect(env.serverMock.numOfFinishedFetches).toBe(1);
  });

  test('several editors opening restored data send a single request', async () => {
    seedDoc('doc-many-mounts', 'stale');
    const env = createDocEnv('doc-many-mounts');

    const renders = createLoggerStore();

    // Two components require fresh data in the same render
    renderHook(() => {
      const first = env.apiStore.useDocument({
        requireFreshData: 'ifFromStorage',
      });
      const second = env.apiStore.useDocument({
        requireFreshData: 'ifFromStorage',
      });
      renders.add({ first: first.status, second: second.status });
    });

    // A third one opens while the refresh is in flight
    await advanceTime(DEFAULT_FETCH_DURATION_MS / 2);

    const lateRenders = createLoggerStore();
    renderHook(() => {
      const { status, data } = env.apiStore.useDocument({
        requireFreshData: 'ifFromStorage',
      });
      lateRenders.add({ status, text: data?.value.text ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> first: loading ⋅ second: loading
      -> first: success ⋅ second: success
      "
    `);
    // The late mount waits for the in-flight refresh instead of starting
    // another one
    expect(lateRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ text: stale
      -> status: success ⋅ text: server
      "
    `);
    expect(env.serverMock.numOfFinishedFetches).toBe(1);
  });

  test('a failed refresh of restored data reports the error and the next mount retries', async () => {
    seedDoc('doc-refresh-error', 'stale');
    const env = createDocEnv('doc-refresh-error');

    env.errorInNextFetch('server unavailable');

    const renders = createLoggerStore();

    const firstEditor = renderHook(() => {
      const { status, data, error } = env.apiStore.useDocument({
        requireFreshData: 'ifFromStorage',
      });
      renders.add({
        status,
        text: data?.value.text ?? null,
        error: error?.message ?? null,
      });
    });
    await flushAllTimers();
    firstEditor.unmount();

    renders.addMark('remount');

    // The document still holds the restored data, so a new mount retries
    renderHook(() => {
      const { status, data, error } = env.apiStore.useDocument({
        requireFreshData: 'ifFromStorage',
      });
      renders.add({
        status,
        text: data?.value.text ?? null,
        error: error?.message ?? null,
      });
    });
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ text: stale ⋅ error: null
      -> status: error ⋅ text: stale ⋅ error: server unavailable

      >>> remount

      -> status: loading ⋅ text: stale ⋅ error: server unavailable
      -> status: loading ⋅ text: stale ⋅ error: null
      -> status: success ⋅ text: server ⋅ error: null
      "
    `);
    expect(env.serverMock.numOfFinishedFetches).toBe(2);
  });
});

describe('document store with other setups', () => {
  test('a document restored by an async storage adapter is refreshed before reporting success', async () => {
    createOpfsPersistentStorageTestStore().setValue('tsdf.session1.doc-opfs', {
      data: { d: { value: { text: 'stale' } } },
      timestamp: Date.now(),
    });
    const env = createDocumentStoreTestEnv<DocContent>(
      { text: 'server' },
      {
        id: 'doc-opfs',
        getSessionKey: () => 'session1',
        persistentStorage: {
          adapter: opfsPersistentStorage,
          schema: docSchema,
        },
      },
    );

    const renders = createLoggerStore();

    renderHook(() => {
      const { status, data } = env.apiStore.useDocument({
        requireFreshData: 'ifFromStorage',
      });
      renders.add({ status, text: data?.value.text ?? null });
    });
    await flushAllTimers();

    // The restored document arrives after the mount, and the hook keeps
    // reporting `loading` until the server data replaces it
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ text: null
      -> status: loading ⋅ text: stale
      -> status: success ⋅ text: server
      "
    `);
    expect(env.serverMock.numOfFinishedFetches).toBe(1);
  });

  test('offline, restored data settles like requireFreshData true', async () => {
    const network = createOfflineNetworkMock();
    network.install();
    onTestFinished(() => network.uninstall());
    network.setOffline();

    seedDoc('doc-offline', 'stale');
    const getSessionKey = () => 'session1';
    const env = createDocumentStoreTestEnv<DocContent>(
      { text: 'server' },
      {
        id: 'doc-offline',
        getSessionKey,
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey,
          offlineSession: { network: network.config },
        }),
        persistentStorage: {
          adapter: 'local-sync',
          schema: docSchema,
          offline: { operations: {} },
        },
      },
    );

    const renders = createLoggerStore();

    renderHook(() => {
      const always = env.apiStore.useDocument({ requireFreshData: true });
      const ifFromStorage = env.apiStore.useDocument({
        requireFreshData: 'ifFromStorage',
      });
      renders.add({
        always: always.status,
        ifFromStorage: ifFromStorage.status,
        text: ifFromStorage.data?.value.text ?? null,
      });
    });
    await flushAllTimers();

    // The refresh can't reach the server, so both hooks settle with the
    // restored data instead of staying in `loading`
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> always: loading ⋅ ifFromStorage: loading ⋅ text: stale
      -> always: success ⋅ ifFromStorage: success ⋅ text: stale
      "
    `);
    expect(env.serverMock.numOfFinishedFetches).toBe(0);
  });
});

describe('collection store', () => {
  test('an item restored from storage is refreshed before reporting success', async () => {
    seedNote('notes-restored', 'a', 'stale a');
    const env = createCollectionEnv('notes-restored');

    const renders = createLoggerStore();

    renderHook(() => {
      const { status, data } = env.apiStore.useItem('a', {
        requireFreshData: 'ifFromStorage',
      });
      renders.add({ status, text: data?.value.text ?? null });
    });
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ text: stale a
      -> status: success ⋅ text: server a
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('switching the payload to a restored item waits for its refresh', async () => {
    // `a` is only on the server, `b` was persisted by a previous session
    seedNote('notes-switch', 'b', 'stale b');
    const env = createCollectionEnv('notes-switch');

    const renders = createLoggerStore();

    const editor = renderHook(
      ({ noteId }: { noteId: string }) => {
        const { status, data } = env.apiStore.useItem(noteId, {
          requireFreshData: 'ifFromStorage',
        });
        renders.add({ status, text: data?.value.text ?? null });
      },
      { initialProps: { noteId: 'a' } },
    );
    await flushAllTimers();

    renders.addMark('open note b');

    // The same editor switches to the restored note
    editor.rerender({ noteId: 'b' });
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ text: null
      -> status: success ⋅ text: server a

      >>> open note b

      -> status: loading ⋅ text: stale b
      -> status: success ⋅ text: server b
      "
    `);
  });

  test('an item already fetched by another component is served from the cache', async () => {
    seedNote('notes-fetched', 'a', 'stale a');
    const env = createCollectionEnv('notes-fetched');

    // A list row loads the note with the default options first, which
    // refreshes the restored data
    renderHook(() => env.apiStore.useItem('a'));
    await flushAllTimers();

    const renders = createLoggerStore();

    renderHook(() => {
      const { status, data } = env.apiStore.useItem('a', {
        requireFreshData: 'ifFromStorage',
      });
      renders.add({ status, text: data?.value.text ?? null });
    });
    // Less than the low-priority throttle: no mount revalidation either
    await advanceTime(100);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ text: server a
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });
});

describe('list query store', () => {
  const usersQuery = { tableId: 'users' };
  const serverData = {
    users: [
      { id: 1, name: 'Fresh 1' },
      { id: 2, name: 'Fresh 2' },
    ],
  };

  test('a query restored from storage is refreshed before reporting success', async () => {
    seedListItem('lq-restored', 'session1', 'users', 1, {
      id: 1,
      name: 'Stale 1',
    });
    seedListQuery('lq-restored', 'session1', usersQuery, [
      storeItemKey('users', 1),
    ]);
    const env = createListQueryEnv({ storeName: 'lq-restored', serverData });

    const renders = createLoggerStore();

    renderHook(() => {
      const { status, items } = env.apiStore.useListQuery(usersQuery, {
        requireFreshData: 'ifFromStorage',
      });
      renders.add({ status, names: items.map((item) => item.name) });
    });
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ names: [Stale 1]
      -> status: success ⋅ names: [Fresh 1, Fresh 2]
      "
    `);
    expect(env.serverTable.getRequestHistory('all')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 2
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });

  test('rows refreshed by a query fetch are not treated as restored', async () => {
    seedListItem('lq-rows', 'session1', 'users', 1, { id: 1, name: 'Stale 1' });
    seedListQuery('lq-rows', 'session1', usersQuery, [
      storeItemKey('users', 1),
    ]);
    const env = createListQueryEnv({ storeName: 'lq-rows', serverData });

    // The list refreshes the restored query and its rows
    renderHook(() =>
      env.apiStore.useListQuery(usersQuery, {
        requireFreshData: 'ifFromStorage',
      }),
    );
    await flushAllTimers();

    const renders = createLoggerStore();

    // Opening a row in an editor serves the refreshed row immediately
    renderHook(() => {
      const { status, data } = env.apiStore.useItem(
        rawItemPayload('users', 1),
        { requireFreshData: 'ifFromStorage' },
      );
      renders.add({ status, name: data?.name ?? null });
    });
    await advanceTime(100);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: Fresh 1
      "
    `);
    // Only the query request, no item request
    expect(env.serverTable.getRequestHistory('all')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 2
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });

  test('an item restored from storage is refreshed before reporting success', async () => {
    seedListItem('lq-item', 'session1', 'users', 2, { id: 2, name: 'Stale 2' });
    const env = createListQueryEnv({ storeName: 'lq-item', serverData });

    const renders = createLoggerStore();

    renderHook(() => {
      const { status, data } = env.apiStore.useItem(
        rawItemPayload('users', 2),
        { requireFreshData: 'ifFromStorage' },
      );
      renders.add({ status, name: data?.name ?? null });
    });
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ name: Stale 2
      -> status: success ⋅ name: Fresh 2
      "
    `);
    expect(env.serverTable.getRequestHistory('all')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload: { itemId: 'users||2' }
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });
});
