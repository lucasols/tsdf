import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import type { OffsetPaginationConfig } from '../../src/listQueryStore/types';
import {
  getManagedLocalStorageRootKeyForSingle,
  readManagedLocalStorageRoot,
  upsertManagedLocalStorageSingleEntry,
} from '../../src/persistentStorage/localStorageMetadata';
import { resetExpirationScanTracking } from '../../src/persistentStorage/persistentStorageManager';
import type {
  PersistentStorageSchema,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { startPersistentStorageOperationCapture } from '../utils/persistentStorageOptimizationTestUtils';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';

const wrappedDocumentSchema = rc_object({
  value: rc_object({ name: rc_string, value: rc_number }),
});

const wrappedCollectionItemSchema = rc_object({
  value: rc_object({ id: rc_string, name: rc_string }),
});

const rowSchema = __LEGIT_CAST__<PersistentStorageSchema<Row>, unknown>(
  rc_object({
    id: rc_number,
    name: rc_string,
    age: rc_number.optional(),
    email: rc_string.optional(),
  }),
);

const listQueryParamsSchema = rc_object({ tableId: rc_string });

const persistentStore = createLocalStoragePersistentTestStore();

function readManagedRoot(rootKey: string) {
  return readManagedLocalStorageRoot(rootKey);
}

async function waitForScheduledCleanup(delayMs = 2100): Promise<void> {
  await advanceTime(delayMs);
  await flushAllTimers();
}

async function settleStartupBackgroundScan(): Promise<void> {
  // Creating a local-sync persistence handle schedules the one-off global scan.
  // Drain it before capturing operation-specific traces so snapshots stay focused.
  await waitForScheduledCleanup();
}

function findCapturedOperations(
  operations: string[],
  fragments: string[],
): string[] {
  return operations.filter((operation) =>
    fragments.some((fragment) => operation.includes(fragment)),
  );
}

async function captureHookRemount<Result>(render: () => Result) {
  const firstMountCapture = startPersistentStorageOperationCapture();
  const firstHook = renderHook(render);
  await flushAllTimers();
  const firstMountOperations = firstMountCapture.finish();

  firstHook.unmount();

  const remountCapture = startPersistentStorageOperationCapture();
  const secondHook = renderHook(render);
  await flushAllTimers();
  const remountOperations = remountCapture.finish();

  return { secondHook, firstMountOperations, remountOperations };
}

type DocumentState = { name: string; value: number };

function setCachedDocumentData(
  storeName: string,
  sessionKey: string,
  data: DocumentState,
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .document.seed({ value: data });
}

function createDocumentEnv(options: {
  storeName: string;
  sessionKey?: string;
  serverData?: DocumentState;
}) {
  return createDocumentStoreTestEnv(
    options.serverData ?? { name: 'test', value: 42 },
    {
      getSessionKey: () => options.sessionKey ?? 'session1',
      persistentStorage: {
        storeName: options.storeName,
        adapter: 'local-sync',
        schema: wrappedDocumentSchema,
      },
    },
  );
}

type CollectionItemState = { id: string; name: string };

type PersistedCollectionItemState = { value: CollectionItemState };

function setCachedCollectionItem(
  storeName: string,
  sessionKey: string,
  payload: string,
  data: PersistedCollectionItemState,
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .collection.seedItem(payload, data);
}

function listStoredCollectionItemPayloads(
  storeName: string,
  sessionKey: string,
): string[] {
  const prefix = `tsdf.${sessionKey}.${storeName}.ci.`;
  const payloads: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;

    const rawEntry = localStorage.getItem(key);
    if (rawEntry === null) continue;

    const entry = __LEGIT_CAST__<
      StorageCacheEntry<{
        data: PersistedCollectionItemState;
        payload: string;
      }>,
      unknown
    >(JSON.parse(rawEntry));
    payloads.push(entry.data.payload);
  }

  return payloads;
}

function createCollectionEnv(options: {
  storeName: string;
  sessionKey?: string;
  maxItems?: number;
  serverData?: Record<string, CollectionItemState>;
}) {
  return createCollectionStoreTestEnv(options.serverData ?? {}, {
    getSessionKey: () => options.sessionKey ?? 'session1',
    persistentStorage: {
      storeName: options.storeName,
      adapter: 'local-sync',
      schema: wrappedCollectionItemSchema,
      payloadSchema: rc_string,
      maxItems: options.maxItems,
    },
  });
}

function rawItemPayload(tableId: string, id: number): string {
  return `${tableId}||${id}`;
}

function storeItemKey(tableId: string, id: number): string {
  return getCompositeKey(rawItemPayload(tableId, id));
}

function setCachedItem(
  storeName: string,
  sessionKey: string,
  tableId: string,
  id: number,
  data: Row,
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .listQuery.seedItem(tableId, id, data).storageKey;
}

function setCachedQuery(
  storeName: string,
  sessionKey: string,
  params: ListQueryParams,
  items: string[],
  hasMore = false,
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .listQuery.seedQuery(params, items, { hasMore });
}

function listStoredKeys(prefix: string): string[] {
  const keys: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) {
      keys.push(key.slice(prefix.length));
    }
  }

  return keys;
}

function createListQueryEnv(options: {
  storeName: string;
  sessionKey?: string;
  maxItems?: number;
  maxQueries?: number;
  maxQuerySize?: number;
  serverData?: Tables<Row>;
  offsetPagination?: OffsetPaginationConfig;
  defaultQuerySize?: number;
}) {
  return createListQueryStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey ?? 'session1',
    offsetPagination: options.offsetPagination,
    defaultQuerySize: options.defaultQuerySize,
    persistentStorage: {
      storeName: options.storeName,
      adapter: 'local-sync',
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryParamsSchema,
      maxItems: options.maxItems,
      maxQueries: options.maxQueries,
      maxQuerySize: options.maxQuerySize,
    },
  });
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  resetExpirationScanTracking();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
});

describe('persistent storage efficiency', () => {
  test('expiration cleanup reads only metadata and shows the full read history', async () => {
    const oneWeekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const expiredDoc = persistentStore.scope('expired-doc', 'sess1');
    const freshDoc = persistentStore.scope('fresh-doc', 'sess1');

    // Seed one expired entry and one fresh entry so the cleanup pass has work to do.
    expiredDoc.document.seed(
      { value: { name: 'old', value: 1 } },
      { timestamp: oneWeekAgo },
    );
    freshDoc.document.seed({ value: { name: 'fresh', value: 2 } });

    const startupReadCapture = startPersistentStorageOperationCapture();
    createDocumentStoreTestEnv(
      { name: 'fresh', value: 2 },
      {
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'fresh-doc',
          adapter: 'local-sync',
          schema: wrappedDocumentSchema,
        },
      },
    );
    const startupOperationsBreakdown = startupReadCapture.finish();

    expect(startupOperationsBreakdown).toMatchInlineSnapshot(`[]`);

    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish();

    expect(localStorage.getItem(expiredDoc.document.storageKey())).toBeNull();
    expect(localStorage.getItem(freshDoc.document.storageKey())).not.toBeNull();
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf._m.c (catalog) | 0.85 kb'
      - '📖 ✅ tsdf._m.r.s:sess1.expired-doc.m (root, single, manifest) | 0.14 kb'
      - '🗑️ ✅->❌ tsdf.sess1.expired-doc (entry)'
      - '🗑️ ✅->❌ tsdf._m.r.s:sess1.expired-doc.m (root, single, manifest)'
      - '📖 ✅ tsdf._m.r.s:sess1.fresh-doc.m (root, single, manifest) | 0.14 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 0.85 kb -> 0.88 kb'
    `);
  });

  test('expiration cleanup leaves malformed payload blobs untouched and still shows the full metadata read history', async () => {
    const triggerDoc = persistentStore.scope('trigger', 'sess1');

    // Seed malformed payload data plus managed metadata so cleanup can see the entry without opening the blob.
    localStorage.setItem(
      'tsdf.sess1.corrupted',
      JSON.stringify({ data: 'bad', version: 1 }),
    );
    upsertManagedLocalStorageSingleEntry({
      sessionKey: 'sess1',
      storeName: 'corrupted',
      storageKey: 'tsdf.sess1.corrupted',
      maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    });
    triggerDoc.document.seed({ value: { name: 'ok', value: 1 } });

    createDocumentStoreTestEnv(
      { name: 'ok', value: 1 },
      {
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'trigger',
          adapter: 'local-sync',
          schema: wrappedDocumentSchema,
        },
      },
    );

    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish();

    expect(localStorage.getItem('tsdf.sess1.corrupted')).not.toBeNull();
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf._m.c (catalog) | 0.83 kb'
      - '📖 ✅ tsdf._m.r.s:sess1.corrupted.m (root, single, manifest) | 0.14 kb'
      - '📖 ✅ tsdf._m.r.s:sess1.trigger.m (root, single, manifest) | 0.14 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 0.83 kb -> 0.87 kb'
    `);
  });

  test('protected dotted-session cleanup keeps the protected entry and snapshots the full metadata history', async () => {
    const staleTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const dottedSessionKey = 'user@example.com';
    const protectedDoc = persistentStore.scope(
      'protected-doc',
      dottedSessionKey,
    );
    const unprotectedDoc = persistentStore.scope(
      'unprotected-doc',
      dottedSessionKey,
    );
    const triggerDoc = persistentStore.scope('trigger-doc', 'sess-trigger');
    const protectedKeysStorageKey = `tsdf.${dottedSessionKey}.__offline__.protected`;
    const protectedRootKey = getManagedLocalStorageRootKeyForSingle(
      protectedKeysStorageKey,
    );

    protectedDoc.document.seed(
      { value: { name: 'protected', value: 1 } },
      { timestamp: staleTimestamp },
    );
    unprotectedDoc.document.seed(
      { value: { name: 'unprotected', value: 2 } },
      { timestamp: staleTimestamp },
    );
    persistentStore.storage.writeValue(protectedKeysStorageKey, {
      data: { keys: [protectedDoc.document.storageKey()] },
      timestamp: Date.now(),
      version: 1,
    });
    triggerDoc.document.seed({ value: { name: 'trigger', value: 3 } });

    createDocumentStoreTestEnv(
      { name: 'trigger', value: 3 },
      {
        getSessionKey: () => 'sess-trigger',
        persistentStorage: {
          storeName: 'trigger-doc',
          adapter: 'local-sync',
          schema: wrappedDocumentSchema,
        },
      },
    );

    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish();

    expect({
      protectedEntryExists:
        localStorage.getItem(protectedDoc.document.storageKey()) !== null,
      unprotectedEntryExists:
        localStorage.getItem(unprotectedDoc.document.storageKey()) !== null,
      protectedRootSession: readManagedRoot(protectedRootKey)?.sessionKey,
    }).toMatchInlineSnapshot(`
      protectedEntryExists: '✅'
      protectedRootSession: 'user@example.com'
      unprotectedEntryExists: '❌'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf._m.c (catalog) | 1.99 kb'
      - '📖 ✅ tsdf._m.r.s:user@example.com.protected-doc.m (root, single, manifest) | 0.14 kb'
      - '📖 ✅ tsdf._m.r.s:user@example.com.unprotected-doc.m (root, single, manifest) | 0.14 kb'
      - '🗑️ ✅->❌ tsdf.user@example.com.unprotected-doc (entry)'
      - '🗑️ ✅->❌ tsdf._m.r.s:user@example.com.unprotected-doc.m (root, single, manifest)'
      - '📖 ✅ tsdf._m.r.s:sess-trigger.trigger-doc.m (root, single, manifest) | 0.14 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 1.99 kb -> 2.06 kb'
    `);
  });
});

describe('document store', () => {
  test('document hook remount stays fully in memory after the cached document is loaded at startup', async () => {
    const storeName = 'doc-remount-flow';
    const sessionKey = 'sess1';

    setCachedDocumentData(storeName, sessionKey, {
      name: 'Cached document',
      value: 7,
    });

    const env = createDocumentEnv({ storeName, sessionKey });

    // Drain the startup scan so this capture focuses only on hook mount behavior.
    await settleStartupBackgroundScan();

    // Document local-sync hydration happens during store initialization, so mount should not hit storage.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useDocument({
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        }),
      );

    expect(secondHook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Cached document', value: 7 }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf._m.c (catalog) | 0.49 kb'
      - '📖 ✅ tsdf._m.r.s:sess1.doc-remount-flow.m (root, single, manifest) | 0.14 kb'
      - '📖 ✅ tsdf.sess1.doc-remount-flow (entry) | 0.20 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.49 kb'
      - '📖 ✅ tsdf._m.r.s:sess1.doc-remount-flow.m (root, single, manifest) | 0.14 kb'
      - '✍️ ✅->✅ tsdf._m.r.s:sess1.doc-remount-flow.m (root, single, manifest) | 0.14 kb -> 0.14 kb'
    `);
    expect(remountOperations).toMatchInlineSnapshot(`[]`);
  });
});

describe('collection store', () => {
  test('expiration cleanup removes expired items through namespace metadata only', async () => {
    const expiredTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const storeName = 'collection-expiration';
    const sessionKey = 'sess1';
    const collectionScope = persistentStore.scope(storeName, sessionKey);

    // Seed one expired item and one fresh item so cleanup has a meaningful choice.
    const expiredItemKey = collectionScope.collection.seedItem(
      'expired-user',
      { value: { id: 'expired-user', name: 'Expired User' } },
      { timestamp: expiredTimestamp },
    );
    const expiredItemKey2 = collectionScope.collection.seedItem(
      'expired-user-2',
      { value: { id: 'expired-user-2', name: 'Expired User 2' } },
      { timestamp: expiredTimestamp },
    );
    const freshItemKey = collectionScope.collection.seedItem('fresh-user', {
      value: { id: 'fresh-user', name: 'Fresh User' },
    });

    const startupOperationCapture = startPersistentStorageOperationCapture();
    createCollectionEnv({ storeName, sessionKey });
    const startupOperationBreakdown = startupOperationCapture.finish();

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`[]`);

    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish();

    expect({
      expiredItemExists: localStorage.getItem(expiredItemKey) !== null,
      expiredItem2Exists: localStorage.getItem(expiredItemKey2) !== null,
      freshItemExists: localStorage.getItem(freshItemKey) !== null,
    }).toMatchInlineSnapshot(`
      expiredItem2Exists: '❌'
      expiredItemExists: '❌'
      freshItemExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf._m.c (catalog) | 0.50 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.collection-expiration.ci.m (root, namespace, manifest) | 0.59 kb'
      - '🗑️ ✅->❌ tsdf.sess1.collection-expiration.ci."expired-user (entry)'
      - '🗑️ ✅->❌ tsdf.sess1.collection-expiration.ci."expired-user-2 (entry)'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.collection-expiration.ci.m (root, namespace, manifest) | 0.59 kb -> 0.22 kb'
    `);
  });

  test('maxItems cleanup snapshots the full metadata read history', async () => {
    setCachedCollectionItem('col-max-items-metadata', 'sess1', 'a', {
      value: { id: 'a', name: 'Oldest cached' },
    });
    await advanceTime(100);
    setCachedCollectionItem('col-max-items-metadata', 'sess1', 'b', {
      value: { id: 'b', name: 'Newer cached' },
    });

    const startupOperationCapture = startPersistentStorageOperationCapture();
    const env = createCollectionEnv({
      storeName: 'col-max-items-metadata',
      sessionKey: 'sess1',
      maxItems: 2,
    });
    const startupOperationBreakdown = startupOperationCapture.finish();

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`[]`);

    // Drain the startup-scheduled global scan before capturing the maxItems flush.
    await settleStartupBackgroundScan();

    const readCapture = startPersistentStorageOperationCapture();
    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'Fresh' } });
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish();

    expect(
      listStoredCollectionItemPayloads(
        'col-max-items-metadata',
        'sess1',
      ).sort(),
    ).toEqual(['b', 'c']);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf._m.c (catalog) | 0.51 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m (root, namespace, manifest) | 0.33 kb'
      - '✍️ ❌->✅ tsdf.sess1.col-max-items-metadata.ci."c (entry) | ❌ -> 0.21 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m (root, namespace, manifest) | 0.33 kb -> 0.46 kb'
      - '🗑️ ✅->❌ tsdf.sess1.col-max-items-metadata.ci."a (entry)'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m (root, namespace, manifest) | 0.46 kb -> 0.33 kb'
    `);
  });

  test('direct getItemState reads the cached collection item once and promotes it into state', async () => {
    const storeName = 'col-direct-get-item-state';
    const sessionKey = 'sess1';

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so this capture only measures the direct read path.
    await settleStartupBackgroundScan();

    const readCapture = startPersistentStorageOperationCapture();

    // The first direct read should hydrate from storage and the second one should reuse state.
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Cached user' }
    `);
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Cached user' }
    `);

    const operationsBreakdown = readCapture.finish();

    expect(env.store.state[getCompositeKey('1')]?.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Cached user' }
    `);
    expect(
      operationsBreakdown.filter((operation) =>
        operation.includes(`tsdf.${sessionKey}.${storeName}.ci."1 (entry)`),
      ),
    ).toMatchInlineSnapshot(`
      ['📖 ✅ tsdf.sess1.col-direct-get-item-state.ci."1 (entry) | 0.22 kb']
    `);
  });

  test('hook remount reuses hydrated collection state without touching localStorage again', async () => {
    const storeName = 'col-remount-flow';
    const sessionKey = 'sess1';

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the UI mount path only.
    await settleStartupBackgroundScan();

    // The first mount must hydrate the cold cached item from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useItem('1', {
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        }),
      );

    expect(secondHook.result.current.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Cached user' }
    `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf._m.c (catalog) | 0.48 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.col-remount-flow.ci.m (root, namespace, manifest) | 0.19 kb'
      - '📖 ✅ tsdf.sess1.col-remount-flow.ci."1 (entry) | 0.22 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.48 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.col-remount-flow.ci.m (root, namespace, manifest) | 0.19 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.48 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.col-remount-flow.ci.m (root, namespace, manifest) | 0.19 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.col-remount-flow.ci.m (root, namespace, manifest) | 0.19 kb -> 0.19 kb'
    `);
    expect(remountOperations).toMatchInlineSnapshot(`[]`);
  });

  test('useMultipleItems remount reuses hydrated collection items without touching localStorage again', async () => {
    const storeName = 'col-multi-remount-flow';
    const sessionKey = 'sess1';

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user 1' },
    });
    setCachedCollectionItem(storeName, sessionKey, '2', {
      value: { id: '2', name: 'Cached user 2' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the hook mount path only.
    await settleStartupBackgroundScan();

    // The first mount must hydrate both cold cached items from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useMultipleItems([{ payload: '1' }, { payload: '2' }], {
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        }),
      );

    expect(secondHook.result.current.map((item) => item.data?.value))
      .toMatchInlineSnapshot(`
        - { id: '1', name: 'Cached user 1' }
        - { id: '2', name: 'Cached user 2' }
      `);
    expect(
      findCapturedOperations(firstMountOperations, [
        `tsdf.${sessionKey}.${storeName}.ci."1 (entry)`,
        `tsdf.${sessionKey}.${storeName}.ci."2 (entry)`,
      ]),
    ).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf.sess1.col-multi-remount-flow.ci."1 (entry) | 0.22 kb'
      - '📖 ✅ tsdf.sess1.col-multi-remount-flow.ci."2 (entry) | 0.22 kb'
    `);
    expect(remountOperations).toMatchInlineSnapshot(`[]`);
  });

  test('getItemState stays in memory after a hook has already hydrated the collection item', async () => {
    const storeName = 'col-get-item-state-flow';
    const sessionKey = 'sess1';

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Hydrate the item through a realistic UI mount first.
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await flushAllTimers();
    hook.unmount();

    // Direct imperative reads should now hit the materialized store state only.
    const getItemStateCapture = startPersistentStorageOperationCapture();
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Cached user' }
    `);
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Cached user' }
    `);
    const getItemStateOperations = getItemStateCapture.finish();

    expect(getItemStateOperations).toMatchInlineSnapshot(`[]`);
  });
});

describe('list query store', () => {
  test('expiration cleanup removes expired queries and items through namespace metadata only', async () => {
    const expiredTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const storeName = 'list-query-expiration';
    const sessionKey = 'sess1';
    const expiredQueryParams: ListQueryParams = { tableId: 'expired-users' };
    const freshQueryParams: ListQueryParams = { tableId: 'fresh-users' };
    const listQueryScope = persistentStore.scope(storeName, sessionKey);

    // Seed one stale query+item pair and one fresh pair to verify cleanup across both roots.
    const expiredItem = listQueryScope.listQuery.seedItem(
      'expired-users',
      1,
      { id: 1, name: 'Expired Item' },
      { timestamp: expiredTimestamp },
    );
    const expiredQueryKey = listQueryScope.listQuery.seedQuery(
      expiredQueryParams,
      [expiredItem.itemKey],
      { timestamp: expiredTimestamp },
    );

    const freshItem = listQueryScope.listQuery.seedItem('fresh-users', 2, {
      id: 2,
      name: 'Fresh Item',
    });
    const freshQueryKey = listQueryScope.listQuery.seedQuery(freshQueryParams, [
      freshItem.itemKey,
    ]);

    const startupOperationCapture = startPersistentStorageOperationCapture();
    createListQueryEnv({ storeName, sessionKey });
    const startupOperationBreakdown = startupOperationCapture.finish();

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`[]`);

    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish();

    expect({
      expiredItemExists: localStorage.getItem(expiredItem.storageKey) !== null,
      expiredQueryExists: localStorage.getItem(expiredQueryKey) !== null,
      freshItemExists: localStorage.getItem(freshItem.storageKey) !== null,
      freshQueryExists: localStorage.getItem(freshQueryKey) !== null,
    }).toMatchInlineSnapshot(`
      expiredItemExists: '❌'
      expiredQueryExists: '❌'
      freshItemExists: '✅'
      freshQueryExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf._m.c (catalog) | 0.96 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.list-query-expiration.li.m (root, namespace, manifest) | 0.44 kb'
      - '🗑️ ✅->❌ tsdf.sess1.list-query-expiration.li."expired-users||1 (entry)'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.list-query-expiration.li.m (root, namespace, manifest) | 0.44 kb -> 0.24 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.list-query-expiration.lq.m (root, namespace, manifest) | 0.69 kb'
      - '🗑️ ✅->❌ tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (entry)'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.list-query-expiration.lq.m (root, namespace, manifest) | 0.69 kb -> 0.36 kb'
    `);
  });

  test('maxQueries cleanup snapshots the full metadata read history', async () => {
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const storeName = 'lq-query-metadata';
    const sessionKey = 'sess1';

    setCachedQuery(storeName, sessionKey, firstQuery, []);
    await advanceTime(100);
    setCachedQuery(storeName, sessionKey, secondQuery, []);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      maxQueries: 2,
      serverData: { third: [{ id: 1, name: 'Third' }] },
    });

    // Drain the startup-scheduled global scan before capturing the query fetch/eviction flow.
    await settleStartupBackgroundScan();

    const readCapture = startPersistentStorageOperationCapture();
    env.scheduleFetch('highPriority', thirdQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.lq.`),
    ).toMatchInlineSnapshot(`['{tableId:"second"}', '{tableId:"third"}']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf._m.c (catalog) | 0.49 kb'
      - '🔑[0] ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (entry)'
      - '🔑[1] ✅ tsdf._m.c (catalog)'
      - '🔑[2] ✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest)'
      - '🔑[3] ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"second"} (entry)'
      - '✍️ ❌->✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (entry) | ❌ -> 0.23 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.49 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.56 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.56 kb -> 0.84 kb'
      - '📖 ❌ tsdf.sess1.lq-query-metadata.li."third||1 (entry)'
      - '✍️ ❌->✅ tsdf.sess1.lq-query-metadata.li."third||1 (entry) | ❌ -> 0.20 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 0.49 kb -> 0.93 kb'
      - '📖 ❌ tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest)'
      - '✍️ ❌->✅ tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest) | ❌ -> 0.21 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.93 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.84 kb'
      - '🗑️ ✅->❌ tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (entry)'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.84 kb -> 0.58 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest) | 0.21 kb'
    `);
  });

  test('maxItems cleanup snapshots the full metadata read history', async () => {
    const storeName = 'lq-item-metadata';
    const sessionKey = 'sess1';

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Oldest cached',
    });
    await advanceTime(100);
    setCachedItem(storeName, sessionKey, 'users', 2, {
      id: 2,
      name: 'Newer cached',
    });
    setCachedQuery(storeName, sessionKey, { tableId: 'users' }, [
      storeItemKey('users', 1),
      storeItemKey('users', 2),
    ]);

    const env = createListQueryEnv({ storeName, sessionKey, maxItems: 2 });

    // Drain the startup-scheduled global scan before capturing the maxItems flush.
    await settleStartupBackgroundScan();

    const readCapture = startPersistentStorageOperationCapture();
    env.apiStore.addItemToState(rawItemPayload('users', 3), {
      id: 3,
      name: 'Fresh',
    });
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf._m.c (catalog) | 0.92 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.38 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.92 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.38 kb'
      - '📖 ❌ tsdf.sess1.lq-item-metadata.li."users||3 (entry)'
      - '✍️ ❌->✅ tsdf.sess1.lq-item-metadata.li."users||3 (entry) | ❌ -> 0.20 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.92 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.38 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.38 kb -> 0.55 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.92 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.55 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.lq.m (root, namespace, manifest) | 0.35 kb'
      - '🗑️ ✅->❌ tsdf.sess1.lq-item-metadata.li."users||3 (entry)'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.55 kb -> 0.38 kb'
    `);
  });

  test('direct getQueryState hydrates the cached list query once and leaves its items in memory for later reads', async () => {
    const storeName = 'lq-direct-get-query-state';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so this capture only measures the direct read-through path.
    await settleStartupBackgroundScan();

    const readCapture = startPersistentStorageOperationCapture();

    // Reading the query should pull both the query and its referenced item into state.
    expect(env.apiStore.getQueryState(usersQuery)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1']
      payload: { tableId: 'users' }
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);
    expect(env.apiStore.getItemState(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached user'
      `);

    const operationsBreakdown = readCapture.finish();

    expect(env.store.state.queries[getCompositeKey(usersQuery)])
      .toMatchInlineSnapshot(`
        error: null
        hasMore: '❌'
        items: ['"users||1']
        payload: { tableId: 'users' }
        refetchOnMount: 'lowPriority'
        status: 'success'
        wasLoaded: '✅'
      `);
    expect(env.store.state.items[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached user'
      `);
    expect(
      operationsBreakdown.filter((operation) =>
        operation.includes(
          `tsdf.${sessionKey}.${storeName}.lq.{tableId:"users"} (entry)`,
        ),
      ),
    ).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf.sess1.lq-direct-get-query-state.lq.{tableId:"users"} (entry) | 0.23 kb'
    `);
    expect(
      operationsBreakdown.filter((operation) =>
        operation.includes(
          `tsdf.${sessionKey}.${storeName}.li."users||1 (entry)`,
        ),
      ),
    ).toMatchInlineSnapshot(
      `['📖 ✅ tsdf.sess1.lq-direct-get-query-state.li."users||1 (entry) | 0.21 kb']`,
    );
  });

  test('query hook remount reuses hydrated list-query state without touching localStorage again', async () => {
    const storeName = 'lq-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted query flow.
    await settleStartupBackgroundScan();

    // The first mount hydrates the cold query and its item from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useListQuery(usersQuery, {
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        }),
      );

    expect(secondHook.result.current.items).toMatchInlineSnapshot(`
      - { id: 1, name: 'Cached user' }
    `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf._m.c (catalog) | 1.44 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-remount-flow.lq.m (root, namespace, manifest) | 0.33 kb'
      - '📖 ✅ tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (entry) | 0.23 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.44 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-remount-flow.li.m (root, namespace, manifest) | 0.21 kb'
      - '📖 ✅ tsdf.sess1.lq-remount-flow.li."users||1 (entry) | 0.21 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.44 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-remount-flow.li.m (root, namespace, manifest) | 0.21 kb'
      - '📖 ✅ tsdf.sess1.lq-remount-flow.li."users||1 (entry) | 0.21 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.44 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-remount-flow.li.m (root, namespace, manifest) | 0.21 kb'
      - '✍️ ✅->✅ tsdf.sess1.lq-remount-flow.li."users||1 (entry) | 0.21 kb -> 0.29 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.44 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-remount-flow.li.m (root, namespace, manifest) | 0.21 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.lq-remount-flow.li.m (root, namespace, manifest) | 0.21 kb -> 0.21 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.44 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-remount-flow.lq.m (root, namespace, manifest) | 0.33 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.lq-remount-flow.lq.m (root, namespace, manifest) | 0.33 kb -> 0.33 kb'
    `);
    expect(remountOperations).toMatchInlineSnapshot(`[]`);
  });

  test('item hook remount reuses hydrated standalone list-query items without touching localStorage again', async () => {
    const storeName = 'lq-item-remount-flow';
    const sessionKey = 'sess1';

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted item flow.
    await settleStartupBackgroundScan();

    // The first mount must hydrate the cold cached item from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useItem(rawItemPayload('users', 1), {
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        }),
      );

    expect(secondHook.result.current.data).toMatchInlineSnapshot(`
      id: 1
      name: 'Cached user'
    `);
    expect(
      findCapturedOperations(firstMountOperations, [
        `tsdf.${sessionKey}.${storeName}.li."users||1 (entry)`,
      ]),
    ).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf.sess1.lq-item-remount-flow.li."users||1 (entry) | 0.21 kb'
      - '✍️ ✅->✅ tsdf.sess1.lq-item-remount-flow.li."users||1 (entry) | 0.21 kb -> 0.29 kb'
    `);
    expect(remountOperations).toMatchInlineSnapshot(`[]`);
  });

  test('useMultipleItems remount reuses hydrated standalone list-query items without touching localStorage again', async () => {
    const storeName = 'lq-multi-item-remount-flow';
    const sessionKey = 'sess1';

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user 1',
    });
    setCachedItem(storeName, sessionKey, 'users', 2, {
      id: 2,
      name: 'Cached user 2',
    });

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted item flow.
    await settleStartupBackgroundScan();

    // The first mount must hydrate both cold cached items from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useMultipleItems(
          [
            { payload: rawItemPayload('users', 1) },
            { payload: rawItemPayload('users', 2) },
          ],
          { disableRefetchOnMount: true, returnRefetchingStatus: true },
        ),
      );

    expect(secondHook.result.current.map((item) => item.data))
      .toMatchInlineSnapshot(`
        - { id: 1, name: 'Cached user 1' }
        - { id: 2, name: 'Cached user 2' }
      `);
    expect(
      findCapturedOperations(firstMountOperations, [
        `tsdf.${sessionKey}.${storeName}.li."users||1 (entry)`,
        `tsdf.${sessionKey}.${storeName}.li."users||2 (entry)`,
      ]),
    ).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (entry) | 0.21 kb'
      - '📖 ✅ tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (entry) | 0.21 kb'
      - '✍️ ✅->✅ tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (entry) | 0.21 kb -> 0.29 kb'
      - '✍️ ✅->✅ tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (entry) | 0.21 kb -> 0.29 kb'
    `);
    expect(remountOperations).toMatchInlineSnapshot(`[]`);
  });

  test('useMultipleListQueries remount reuses hydrated queries without touching localStorage again', async () => {
    const storeName = 'lq-multi-query-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedItem(storeName, sessionKey, 'projects', 1, {
      id: 1,
      name: 'Cached project',
    });
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);
    setCachedQuery(storeName, sessionKey, projectsQuery, [
      storeItemKey('projects', 1),
    ]);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted query flow.
    await settleStartupBackgroundScan();

    // The first mount must hydrate both cold cached queries and their items from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useMultipleListQueries(
          [{ payload: usersQuery }, { payload: projectsQuery }],
          { disableRefetchOnMount: true, returnRefetchingStatus: true },
        ),
      );

    expect(
      secondHook.result.current.map((query) =>
        query.items.map((item) => item.name),
      ),
    ).toMatchInlineSnapshot(`
      - ['Cached user']
      - ['Cached project']
    `);
    expect(
      findCapturedOperations(firstMountOperations, [
        `tsdf.${sessionKey}.${storeName}.lq.{tableId:"users"} (entry)`,
        `tsdf.${sessionKey}.${storeName}.lq.{tableId:"projects"} (entry)`,
        `tsdf.${sessionKey}.${storeName}.li."users||1 (entry)`,
        `tsdf.${sessionKey}.${storeName}.li."projects||1 (entry)`,
      ]),
    ).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (entry) | 0.23 kb'
      - '📖 ✅ tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (entry) | 0.21 kb'
      - '📖 ✅ tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (entry) | 0.21 kb'
      - '📖 ✅ tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (entry) | 0.24 kb'
      - '📖 ✅ tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (entry) | 0.22 kb'
      - '📖 ✅ tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (entry) | 0.22 kb'
      - '✍️ ✅->✅ tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (entry) | 0.21 kb -> 0.29 kb'
      - '✍️ ✅->✅ tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (entry) | 0.22 kb -> 0.30 kb'
    `);
    expect(remountOperations).toMatchInlineSnapshot(`[]`);
  });

  test('updating a hydrated list-query item writes the mutation without rereading cached entries', async () => {
    const storeName = 'lq-mutation-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Hydrate the cached query through a normal mounted component first.
    await settleStartupBackgroundScan();
    renderHook(() =>
      env.apiStore.useListQuery(usersQuery, { disableRefetchOnMount: true }),
    );
    await flushAllTimers();

    // Mutating the already-hydrated item should only need manifest reads plus writes.
    const mutationCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.apiStore.updateItemState(rawItemPayload('users', 1), (draft) => {
        draft.name = 'Edited user';
      });
    });
    await advanceTime(1100);
    await flushAllTimers();
    const mutationOperations = mutationCapture.finish();

    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readItemData<Row>('users', 1),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Edited user'
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      - '✍️ ✅->✅ tsdf.sess1.lq-mutation-flow.li."users||1 (entry) | 0.29 kb -> 0.29 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.92 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-mutation-flow.li.m (root, namespace, manifest) | 0.21 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.lq-mutation-flow.li.m (root, namespace, manifest) | 0.21 kb -> 0.21 kb'
    `);
  });
});
