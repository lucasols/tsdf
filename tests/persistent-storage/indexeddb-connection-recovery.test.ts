import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { cleanup, renderHook } from '@testing-library/react';
import { forceCloseDatabase } from 'fake-indexeddb';
import { act } from 'react';
import {
  rc_number,
  rc_object,
  rc_parse,
  rc_string,
  rc_unknown,
} from 'runcheck';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from 'vitest';
import { createIndexedDbPersistentStorageForTests } from '../../src/persistentStorage/indexedDbAsyncStorageAdapter';
import { createStoreManager } from '../../src/storeManager';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import type { UpdateValueOperations } from '../offline/offlineReplayTestShared';
import {
  docMutationInputSchema,
  docSchema,
} from '../offline/offlineTestShared';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { resetSessionForTests } from '../utils/resetSessionForTests';

const sessionKey = 'sess1';
const collectionItemSchema = rc_object({
  value: rc_object({ id: rc_string, name: rc_string }),
});
const documentSchema = rc_object({ value: rc_number });

/** Time without progress after which a stalled operation is given up. */
const STALL_CHECK_INTERVAL_MS = 15_000;

let network = createOfflineNetworkMock();
let databaseName = '';
type TestApp = { adapter: { resetForTests?: () => void }; dispose: () => void };

let apps: TestApp[] = [];
/** Connections the adapter under test opened, oldest first. */
let adapterConnections: IDBDatabase[] = [];
let isTestOwnedOpen = false;
/** Every `indexedDB.open` call, the adapter's and the test's own. */
let openDatabase: MockInstance<IDBFactory['open']>;
let persistentStorageErrors: string[] = [];

function onPersistentStorageError(error: unknown): void {
  persistentStorageErrors.push(
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
}

function getAdapterConnection(): IDBDatabase {
  const connection = adapterConnections.at(-1);
  if (connection === undefined) {
    throw new Error('The adapter has not opened a connection yet.');
  }
  return connection;
}

/** The browser dropping a connection on its own: `close` fires on it. */
function dropConnectionLikeTheBrowser(connection: IDBDatabase): void {
  forceCloseDatabase(
    // WORKAROUND: fake-indexeddb types this test-only helper against its own
    // FDBDatabase class, which is what the global IDBDatabase is in tests.
    __LEGIT_CAST__<Parameters<typeof forceCloseDatabase>[0], IDBDatabase>(
      connection,
    ),
  );
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('failed'));
  });
}

/** Name of the item in a row handed to IndexedDB. */
function getPersistedName(row: unknown): string {
  const parsed = rc_parse(
    row,
    rc_object({ d: rc_object({ value: rc_object({ name: rc_string }) }) }),
  ).unwrapOrNull();
  return parsed === null ? '(store bookkeeping row)' : parsed.d.value.name;
}

/** `storeName/entryKey` of a persisted row. */
function getEntryLabel(key: IDBValidKey): string {
  const [scopeId, entryKey] = Array.isArray(key) ? key : [];
  if (typeof scopeId !== 'string' || typeof entryKey !== 'string') {
    return JSON.stringify(key);
  }

  const scope: unknown = JSON.parse(scopeId);
  const storeName: unknown = Array.isArray(scope) ? scope[1] : undefined;
  return `${typeof storeName === 'string' ? storeName : scopeId}/${entryKey}`;
}

/**
 * Reads what is on disk through a separate connection, the way another tab
 * or a later page load would see it.
 */
async function readPersistedEntries(): Promise<Record<string, unknown>> {
  isTestOwnedOpen = true;
  const openRequest = indexedDB.open(databaseName);
  isTestOwnedOpen = false;

  return resolveAfterAllTimers(
    (async () => {
      const database = await requestResult(openRequest);
      const store = database
        .transaction('entries', 'readonly')
        .objectStore('entries');
      const [keys, rows]: [IDBValidKey[], unknown[]] = await Promise.all([
        requestResult(store.getAllKeys()),
        requestResult(store.getAll()),
      ]);
      database.close();

      return Object.fromEntries(
        keys.map((key, index) => [
          getEntryLabel(key),
          rc_parse(rows[index], rc_object({ d: rc_unknown })).unwrapOrNull()?.d,
        ]),
      );
    })(),
  );
}

function createAdapter() {
  return createIndexedDbPersistentStorageForTests({ databaseName }).adapter;
}

function createDocumentApp(
  storeName: string,
  serverValue: number,
  adapter = createAdapter(),
) {
  const env = createDocumentStoreTestEnv(serverValue, {
    id: storeName,
    getSessionKey: () => sessionKey,
    persistentStorage: {
      adapter,
      schema: documentSchema,
      onPersistentStorageError,
    },
  });
  apps.push({ adapter, dispose: () => env.apiStore.dispose() });
  return { adapter, env };
}

function createOfflineDocumentApp(
  storeName: string,
  testScenario: 'idle' | 'loaded',
) {
  const adapter = createAdapter();
  const envRef: {
    current: ReturnType<
      typeof createDocumentStoreTestEnv<number, UpdateValueOperations>
    > | null;
  } = { current: null };

  const env = createDocumentStoreTestEnv<number, UpdateValueOperations>(1, {
    id: storeName,
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config },
      onPersistentStorageError,
    }),
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
  apps.push({ adapter, dispose: () => env.apiStore.dispose() });
  return { adapter, env };
}

function queueOfflineUpdate(
  env: ReturnType<typeof createOfflineDocumentApp>['env'],
  value: number,
) {
  return env.apiStore.performMutation({
    optimisticUpdate: () => {
      env.apiStore.updateState((draft) => {
        draft.value = value;
      });
    },
    mutation: async () => {
      await env.serverMock.delayedSetData(value);
      return value;
    },
    offline: { operation: 'updateValue', input: { value } },
  });
}

function getPendingOfflineEntities(
  env: ReturnType<typeof createOfflineDocumentApp>['env'],
) {
  return env.apiStore
    .getOfflineEntities()
    .map(({ entityKey, pendingMutations, syncState }) => ({
      entityKey,
      pendingMutations,
      syncState,
    }));
}

/** A page reload: every in-memory store, session and connection is gone. */
function closeApps(): void {
  cleanup();
  for (const app of apps.splice(0)) {
    app.dispose();
  }
  for (const connection of adapterConnections.splice(0)) {
    connection.close();
  }
  resetSessionForTests();
}

function editDocument(
  env: ReturnType<typeof createDocumentApp>['env'],
  value: number,
): void {
  act(() => {
    env.apiStore.updateState((draft) => {
      draft.value = value;
    });
  });
}

/**
 * The browser's storage backend stops answering: requests, transactions and
 * opens stay pending and no IndexedDB event is delivered. fake-indexeddb runs
 * all of its work through `setImmediate`, so holding those tasks back is the
 * same thing seen from the page.
 */
function freezeStorage() {
  const heldTasks: Array<() => void> = [];
  vi.stubGlobal('setImmediate', (task: () => void) => {
    heldTasks.push(task);
    return 0;
  });

  return {
    /** Lets the backend do one more piece of work. */
    runNextTask(): boolean {
      const task = heldTasks.shift();
      task?.();
      return task !== undefined;
    },
    /** The backend answers again, starting with what it was holding back. */
    resume(): void {
      vi.unstubAllGlobals();
      for (const task of heldTasks.splice(0)) {
        task();
      }
    },
    /** New work is answered again; what was asked while frozen is lost. */
    recoverLosingPendingWork(): void {
      vi.unstubAllGlobals();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  resetSessionForTests({ clearStorage: true });
  databaseName = `tsdf-connection-recovery-${Math.random().toString(36).slice(2, 10)}`;
  apps = [];
  adapterConnections = [];
  persistentStorageErrors = [];

  // Observe the connections the adapter opens, at the IndexedDB boundary.
  const open = indexedDB.open.bind(indexedDB);
  openDatabase = vi.spyOn(indexedDB, 'open');
  openDatabase.mockImplementation((name, version) => {
    const request = open(name, version);
    if (!isTestOwnedOpen) {
      request.addEventListener('success', () => {
        adapterConnections.push(request.result);
      });
    }
    return request;
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const adapters = apps.map((app) => app.adapter);
  closeApps();
  await flushAllTimers();
  for (const adapter of adapters) {
    adapter.resetForTests?.();
  }
  await flushAllTimers();
  resetSessionForTests({ clearStorage: true });
  vi.useRealTimers();
});

describe('opening the database', () => {
  test('a failed open is not remembered: the app is told once and later saves work', async () => {
    // The first operation finds the IndexedDB backend broken, including the
    // immediate second attempt the adapter makes on its own.
    openDatabase
      .mockImplementationOnce(() => {
        throw new DOMException('Backing store is unavailable', 'UnknownError');
      })
      .mockImplementationOnce(() => {
        throw new DOMException('Backing store is unavailable', 'UnknownError');
      });

    const { env } = createDocumentApp('doc-open-fails', 5);
    const hook = renderHook(() => env.apiStore.useDocument());
    await flushAllTimers();

    // The cache read failed, so the store fell back to the server, and the
    // failure reached the app instead of being swallowed.
    expect(hook.result.current.data).toMatchInlineSnapshot(`value: 5`);
    expect(persistentStorageErrors).toMatchInlineSnapshot(
      `['UnknownError: Backing store is unavailable']`,
    );

    // The backend works again: nothing kept the earlier failure around, so the
    // fetched document was saved without a page reload.
    expect(await readPersistedEntries()).toMatchInlineSnapshot(
      `doc-open-fails/d: { value: 5 }`,
    );
  });

  test('an open that never settles is abandoned and retried', async () => {
    // Old Safari: the first open of a page stays pending forever, with no
    // success, error or blocked event.
    openDatabase.mockImplementationOnce(() => new IDBOpenDBRequest());

    const { env } = createDocumentApp('doc-open-hangs', 5);
    const hook = renderHook(() => env.apiStore.useDocument());

    // One check without progress is not enough to give up.
    await advanceTime(STALL_CHECK_INTERVAL_MS);
    expect(openDatabase).toHaveBeenCalledTimes(1);

    // The second one is: the adapter opens again and carries on.
    await advanceTime(STALL_CHECK_INTERVAL_MS);
    await flushAllTimers();

    expect(hook.result.current.data).toMatchInlineSnapshot(`value: 5`);
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
    expect(await readPersistedEntries()).toMatchInlineSnapshot(
      `doc-open-hangs/d: { value: 5 }`,
    );
  });
});

describe('losing the connection between operations', () => {
  test('after the browser closes the connection the next save and the next read use a new one', async () => {
    // A previous page load left a second document on disk.
    const previousLoad = createDocumentApp('doc-other', 70);
    renderHook(() => previousLoad.env.apiStore.useDocument());
    await flushAllTimers();
    closeApps();

    const { adapter, env } = createDocumentApp('doc-closed', 1);
    renderHook(() => env.apiStore.useDocument());
    await flushAllTimers();

    // The browser drops the connection while the tab sits idle.
    dropConnectionLikeTheBrowser(getAdapterConnection());

    // Next save.
    editDocument(env, 2);
    await flushAllTimers();

    // Next read: a store that was not loaded yet hydrates from disk.
    const other = createDocumentApp('doc-other', 71, adapter);
    const otherHook = renderHook(() => other.env.apiStore.useDocument());
    // Sooner than the server could answer, so 70 can only come from disk.
    await advanceTime(50);

    expect(otherHook.result.current.data).toMatchInlineSnapshot(`value: 70`);
    await flushAllTimers();
    expect(await readPersistedEntries()).toMatchInlineSnapshot(`
      doc-closed/d: { value: 2 }
      doc-other/d: { value: 71 }
    `);
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });

  test('a connection that closed without telling the page is replaced when the next save hits it', async () => {
    const { env } = createDocumentApp('doc-silent-close', 1);
    renderHook(() => env.apiStore.useDocument());
    await flushAllTimers();

    // Reported for Safari: the connection is gone but no `close` event fired,
    // so the adapter only finds out when `transaction()` throws.
    getAdapterConnection().close();

    editDocument(env, 2);
    await flushAllTimers();

    expect(await readPersistedEntries()).toMatchInlineSnapshot(
      `doc-silent-close/d: { value: 2 }`,
    );
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });
});

describe('losing the connection in the middle of an operation', () => {
  test('a batch interrupted by a lost connection is written again in full, once', async () => {
    const adapter = createAdapter();
    const env = createCollectionStoreTestEnv(
      {
        a: { id: 'a', name: 'Ada' },
        b: { id: 'b', name: 'Grace' },
        c: { id: 'c', name: 'Linus' },
      },
      {
        id: 'col-interrupted',
        getSessionKey: () => sessionKey,
        persistentStorage: {
          adapter,
          payloadSchema: rc_string,
          schema: collectionItemSchema,
          onPersistentStorageError,
        },
      },
    );
    apps.push({ adapter, dispose: () => env.apiStore.dispose() });

    // Observe every row handed to IndexedDB.
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');

    // Three items are fetched together and saved as one batch. Storage answers
    // one step at a time until the batch has started writing its items...
    const storage = freezeStorage();
    renderHook(() => [
      env.apiStore.useItem('a'),
      env.apiStore.useItem('b'),
      env.apiStore.useItem('c'),
    ]);
    while (put.mock.calls.length === 0) {
      storage.runNextTask();
      await advanceTime(100);
    }

    // ...and right then the connection dies: the transaction of the batch is
    // aborted before it could commit, and the connection is closing.
    const store = put.mock.contexts[0];
    if (!(store instanceof IDBObjectStore)) {
      throw new Error('No item was handed to IndexedDB.');
    }
    store.transaction.abort();
    store.transaction.db.close();
    storage.resume();
    await flushAllTimers();

    // The interrupted attempt got as far as its first item. After one
    // reconnect the whole batch was handed over again.
    expect(
      put.mock.calls.map(([value]) => getPersistedName(value)),
    ).toMatchInlineSnapshot(
      `['Ada', 'Ada', 'Grace', 'Linus', '(store bookkeeping row)']`,
    );
    expect(openDatabase).toHaveBeenCalledTimes(2);
    // Nothing of the aborted attempt is left half-written, every item is there
    // exactly once, and the app saw no error.
    expect(await readPersistedEntries()).toMatchInlineSnapshot(`
      col-interrupted/"a:
        value: { id: 'a', name: 'Ada' }

      col-interrupted/"b:
        value: { id: 'b', name: 'Grace' }

      col-interrupted/"c:
        value: { id: 'c', name: 'Linus' }
    `);
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });
});

describe('another tab changing the database', () => {
  test('another tab can delete the database, and this tab starts over on its next save', async () => {
    const { env } = createDocumentApp('doc-deleted-elsewhere', 1);
    renderHook(() => env.apiStore.useDocument());
    await flushAllTimers();

    // Another tab deletes the database. It can only finish if this tab lets go
    // of its connection when asked to.
    let deletedByOtherTab = false;
    indexedDB.deleteDatabase(databaseName).onsuccess = () => {
      deletedByOtherTab = true;
    };
    await flushAllTimers();
    expect(deletedByOtherTab).toBe(true);

    // This tab keeps working: the next save recreates the database.
    editDocument(env, 2);
    await flushAllTimers();

    expect(await readPersistedEntries()).toMatchInlineSnapshot(
      `doc-deleted-elsewhere/d: { value: 2 }`,
    );
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });

  test('a newer version of the app in another tab is not blocked from upgrading the database', async () => {
    const { env } = createDocumentApp('doc-upgraded-elsewhere', 1);
    renderHook(() => env.apiStore.useDocument());
    await flushAllTimers();

    // Another tab runs a newer app that needs a schema upgrade.
    isTestOwnedOpen = true;
    const upgradeRequest = indexedDB.open(databaseName, 2);
    isTestOwnedOpen = false;
    let upgradedByOtherTab = false;
    upgradeRequest.onsuccess = () => {
      upgradedByOtherTab = true;
      upgradeRequest.result.close();
    };
    await flushAllTimers();
    expect(upgradedByOtherTab).toBe(true);

    // This tab cannot use the newer schema, and says so instead of hanging.
    editDocument(env, 2);
    await flushAllTimers();

    expect(persistentStorageErrors).toMatchInlineSnapshot(
      `- 'VersionError: An attempt was made to open a database using a lower version than the existing version.'`,
    );
  });
});

describe('operations that stop making progress', () => {
  test('a save that hangs is given up after two checks without progress and written again', async () => {
    const { env } = createDocumentApp('doc-hung-save', 1);
    renderHook(() => env.apiStore.useDocument());
    await flushAllTimers();

    const storage = freezeStorage();
    editDocument(env, 2);
    // The debounced save starts and gets no answer. One check without
    // progress is not enough to give up on it.
    await advanceTime(2000 + STALL_CHECK_INTERVAL_MS);
    expect(openDatabase).toHaveBeenCalledTimes(1);

    // Storage works again for new connections, the old one stays dead. The
    // second check drops it and the save runs again on a new connection.
    storage.recoverLosingPendingWork();
    await advanceTime(STALL_CHECK_INTERVAL_MS);
    await flushAllTimers();

    expect(openDatabase).toHaveBeenCalledTimes(2);
    expect(await readPersistedEntries()).toMatchInlineSnapshot(
      `doc-hung-save/d: { value: 2 }`,
    );
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });

  test('a save that hangs while the tab is in the background is not given up until the tab is visible again', async () => {
    const { env } = createDocumentApp('doc-hung-hidden', 1);
    renderHook(() => env.apiStore.useDocument());
    await flushAllTimers();

    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    const storage = freezeStorage();
    editDocument(env, 2);

    // Browsers may pause storage for background tabs, so however long the tab
    // stays hidden the pending save is left alone: no second attempt is made.
    await advanceTime(10 * 60_000);
    expect(openDatabase).toHaveBeenCalledTimes(1);

    // Back in the foreground the save still gets two full checks before it is
    // considered stuck, so a save that completes on resume is never failed.
    visibility.mockReturnValue('visible');
    storage.recoverLosingPendingWork();
    await advanceTime(STALL_CHECK_INTERVAL_MS);
    expect(openDatabase).toHaveBeenCalledTimes(1);

    await advanceTime(STALL_CHECK_INTERVAL_MS);
    await flushAllTimers();

    expect(openDatabase).toHaveBeenCalledTimes(2);
    expect(await readPersistedEntries()).toMatchInlineSnapshot(
      `doc-hung-hidden/d: { value: 2 }`,
    );
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });

  test('a save left pending while the device sleeps is not given up the moment it wakes', async () => {
    const { env } = createDocumentApp('doc-hung-asleep', 1);
    renderHook(() => env.apiStore.useDocument());
    await flushAllTimers();

    const storage = freezeStorage();
    editDocument(env, 2);
    // The save is already one check behind when the lid is closed.
    await advanceTime(2000 + STALL_CHECK_INTERVAL_MS);

    // An hour later the device wakes up. Nothing ran meanwhile, so the next
    // check is long overdue, and it does not count against the save.
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await advanceTime(STALL_CHECK_INTERVAL_MS);
    expect(openDatabase).toHaveBeenCalledTimes(1);

    // Storage answers shortly after waking up: the original save completes on
    // the original connection, without a second attempt.
    storage.resume();
    await flushAllTimers();

    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(await readPersistedEntries()).toMatchInlineSnapshot(
      `doc-hung-asleep/d: { value: 2 }`,
    );
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });

  test('a save that hangs again after the retry is reported, and later saves still work', async () => {
    const { env } = createDocumentApp('doc-hung-twice', 1);
    renderHook(() => env.apiStore.useDocument());
    await flushAllTimers();

    const storage = freezeStorage();
    editDocument(env, 2);
    // Two checks give up on the save, two more on the reconnect that follows.
    await advanceTime(2000 + 4 * STALL_CHECK_INTERVAL_MS);

    // The app is told, instead of the save staying pending forever with every
    // later save of the session queued behind it.
    expect(persistentStorageErrors).toMatchInlineSnapshot(
      `- 'TimeoutError: IndexedDB operation made no progress; treating the connection as lost.'`,
    );

    storage.recoverLosingPendingWork();
    editDocument(env, 3);
    await flushAllTimers();

    expect(await readPersistedEntries()).toMatchInlineSnapshot(
      `doc-hung-twice/d: { value: 3 }`,
    );
  });

  test('a slow batch that keeps making progress is never interrupted, however long it takes', async () => {
    const adapter = createAdapter();
    const env = createCollectionStoreTestEnv(
      {
        a: { id: 'a', name: 'Ada' },
        b: { id: 'b', name: 'Grace' },
        c: { id: 'c', name: 'Linus' },
        d: { id: 'd', name: 'Margaret' },
        e: { id: 'e', name: 'Barbara' },
        f: { id: 'f', name: 'Edsger' },
      },
      {
        id: 'col-slow',
        getSessionKey: () => sessionKey,
        persistentStorage: {
          adapter,
          payloadSchema: rc_string,
          schema: collectionItemSchema,
          onPersistentStorageError,
        },
      },
    );
    apps.push({ adapter, dispose: () => env.apiStore.dispose() });

    // The app is up and its connection is open.
    renderHook(() => env.apiStore.useItem('a'));
    await flushAllTimers();

    // Measure how long each transaction stays open from here on.
    const connection = getAdapterConnection();
    const openTransaction = connection.transaction.bind(connection);
    const transactionDurations: number[] = [];
    vi.spyOn(connection, 'transaction').mockImplementation(
      (storeNames, mode, options) => {
        const transaction = openTransaction(storeNames, mode, options);
        const startedAt = Date.now();
        transaction.addEventListener('complete', () => {
          transactionDurations.push(Date.now() - startedAt);
        });
        return transaction;
      },
    );

    // A very slow device: storage needs 4s for every single step of work.
    const storage = freezeStorage();
    renderHook(() => [
      env.apiStore.useItem('b'),
      env.apiStore.useItem('c'),
      env.apiStore.useItem('d'),
      env.apiStore.useItem('e'),
      env.apiStore.useItem('f'),
    ]);

    let idleSteps = 0;
    while (idleSteps < 5) {
      idleSteps = storage.runNextTask() ? 0 : idleSteps + 1;
      await advanceTime(4000);
    }
    storage.recoverLosingPendingWork();

    // Saving the batch was one transaction that ran for longer than the 45s a
    // stalled operation gets at most, yet nothing was abandoned or retried.
    expect(Math.max(...transactionDurations)).toBeGreaterThan(
      3 * STALL_CHECK_INTERVAL_MS,
    );
    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(Object.keys(await readPersistedEntries())).toMatchInlineSnapshot(`
      - 'col-slow/"a'
      - 'col-slow/"b'
      - 'col-slow/"c'
      - 'col-slow/"d'
      - 'col-slow/"e'
      - 'col-slow/"f'
    `);
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);
  });
});

describe('queued offline mutations', () => {
  test('a mutation queued right after the connection was lost is still queued after a reload', async () => {
    network.setOffline();

    const { env } = createOfflineDocumentApp('doc-offline-recovered', 'loaded');
    await flushAllTimers();

    // A backgrounded mobile tab comes back with a dead connection, and the
    // user edits while still offline.
    getAdapterConnection().close();
    const result = await resolveAfterAllTimers(queueOfflineUpdate(env, 2));
    await flushAllTimers();

    expect(result.ok ? result.value : result.error).toMatchInlineSnapshot(
      `kind: 'queued'`,
    );
    expect(persistentStorageErrors).toMatchInlineSnapshot(`[]`);

    // The page is reloaded while still offline: the queue comes from disk.
    closeApps();
    const reloaded = createOfflineDocumentApp('doc-offline-recovered', 'idle');
    const hook = renderHook(() =>
      reloaded.env.apiStore.useDocument({ returnRefetchingStatus: true }),
    );
    await flushAllTimers();

    expect(hook.result.current).toMatchInlineSnapshot(`
      data: { value: 2 }
      error: null
      isLoading: '❌'
      pendingSync: '✅'
      status: 'success'
    `);
    expect(getPendingOfflineEntities(reloaded.env)).toMatchInlineSnapshot(
      `- { entityKey: 'document', pendingMutations: 1, syncState: 'pending' }`,
    );
  });

  test('when the queue cannot be saved at all the app is told, and the mutation is only kept until the page reloads', async () => {
    network.setOffline();

    const { env } = createOfflineDocumentApp('doc-offline-unsaved', 'loaded');
    await flushAllTimers();

    // Storage is gone for good: the connection is dead and cannot be reopened.
    getAdapterConnection().close();
    openDatabase.mockImplementation(() => {
      throw new DOMException(
        'Connection to Indexed Database server lost. Refresh the page to try again',
        'UnknownError',
      );
    });
    const result = await resolveAfterAllTimers(queueOfflineUpdate(env, 2));
    await flushAllTimers();

    // What the app sees: the mutation promise still resolves as queued and the
    // optimistic value stays, but every failed write is reported.
    expect(result.ok ? result.value : result.error).toMatchInlineSnapshot(
      `kind: 'queued'`,
    );
    expect(env.apiStore.store.state.data).toMatchInlineSnapshot(`value: 2`);
    expect(getPendingOfflineEntities(env)).toMatchInlineSnapshot(
      `- { entityKey: 'document', pendingMutations: 1, syncState: 'pending' }`,
    );
    expect([...new Set(persistentStorageErrors)]).toMatchInlineSnapshot(
      `- 'UnknownError: Connection to Indexed Database server lost. Refresh the page to try again'`,
    );

    // Nothing reached the disk, so a reload loses the queued mutation.
    openDatabase.mockRestore();
    closeApps();
    const reloaded = createOfflineDocumentApp('doc-offline-unsaved', 'idle');
    renderHook(() => reloaded.env.apiStore.useDocument());
    await flushAllTimers();

    expect(getPendingOfflineEntities(reloaded.env)).toMatchInlineSnapshot(`[]`);
  });

  test('a mutation whose queue write failed is still sent when the network comes back before a reload', async () => {
    network.setOffline();

    const { env } = createOfflineDocumentApp('doc-offline-replayed', 'loaded');
    await flushAllTimers();

    // Storage is gone for good, so the queued mutation only lives in memory.
    getAdapterConnection().close();
    openDatabase.mockImplementation(() => {
      throw new DOMException(
        'Connection to Indexed Database server lost. Refresh the page to try again',
        'UnknownError',
      );
    });
    await resolveAfterAllTimers(queueOfflineUpdate(env, 2));
    await flushAllTimers();
    expect(env.serverMock.history).toMatchInlineSnapshot(`[1]`);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // The server received the queued value and nothing is pending anymore.
    expect(env.serverMock.history).toMatchInlineSnapshot(`[1, 2]`);
    expect(getPendingOfflineEntities(env)).toMatchInlineSnapshot(`[]`);
  });
});
