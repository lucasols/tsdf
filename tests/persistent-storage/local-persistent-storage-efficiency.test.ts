import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
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
  const prefix = `tsdf.${sessionKey}.${storeName}.collection.item.`;
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
      - '📖 ✅ tsdf._m.c (catalog) | 0.94 kb'
      - '📖 ✅ tsdf._m.r.s:sess1.expired-doc.m (root, single, manifest) | 0.14 kb'
      - '🗑️ ✅->❌ tsdf.sess1.expired-doc (payload)'
      - '🗑️ ✅->❌ tsdf._m.r.s:sess1.expired-doc.m (root, single, manifest)'
      - '📖 ✅ tsdf._m.r.s:sess1.fresh-doc.m (root, single, manifest) | 0.14 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 0.94 kb -> 0.98 kb'
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
      - '📖 ✅ tsdf._m.c (catalog) | 0.93 kb'
      - '📖 ✅ tsdf._m.r.s:sess1.corrupted.m (root, single, manifest) | 0.14 kb'
      - '📖 ✅ tsdf._m.r.s:sess1.trigger.m (root, single, manifest) | 0.14 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 0.93 kb -> 0.96 kb'
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
      - '📖 ✅ tsdf._m.c (catalog) | 2.19 kb'
      - '📖 ✅ tsdf._m.r.s:user@example.com.protected-doc.m (root, single, manifest) | 0.14 kb'
      - '📖 ✅ tsdf._m.r.s:user@example.com.unprotected-doc.m (root, single, manifest) | 0.14 kb'
      - '🗑️ ✅->❌ tsdf.user@example.com.unprotected-doc (payload)'
      - '🗑️ ✅->❌ tsdf._m.r.s:user@example.com.unprotected-doc.m (root, single, manifest)'
      - '📖 ✅ tsdf._m.r.s:sess-trigger.trigger-doc.m (root, single, manifest) | 0.14 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 2.19 kb -> 2.26 kb'
    `);
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
      freshItemExists: localStorage.getItem(freshItemKey) !== null,
    }).toMatchInlineSnapshot(`
      expiredItemExists: '❌'
      freshItemExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf._m.c (catalog) | 0.58 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.collection-expiration.ci.m (root, namespace, manifest) | 0.40 kb'
      - '🗑️ ✅->❌ tsdf.sess1.collection-expiration.collection.item."expired-user (payload)'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.collection-expiration.ci.m (root, namespace, manifest) | 0.40 kb -> 0.22 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 0.58 kb -> 0.59 kb'
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
      - '📖 ✅ tsdf._m.c (catalog) | 0.58 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m (root, namespace, manifest) | 0.33 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.58 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m (root, namespace, manifest) | 0.33 kb'
      - '✍️ ❌->✅ tsdf.sess1.col-max-items-metadata.collection.item."c (payload) | ❌ -> 0.21 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.58 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 0.58 kb -> 0.58 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m (root, namespace, manifest) | 0.33 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m (root, namespace, manifest) | 0.33 kb -> 0.46 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.58 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.58 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 0.58 kb -> 0.58 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.58 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m (root, namespace, manifest) | 0.46 kb'
      - '🗑️ ✅->❌ tsdf.sess1.col-max-items-metadata.collection.item."a (payload)'
      - '📖 ✅ tsdf._m.c (catalog) | 0.58 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m (root, namespace, manifest) | 0.46 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m (root, namespace, manifest) | 0.46 kb -> 0.33 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 0.58 kb -> 0.60 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.60 kb'
    `);
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
      - '📖 ✅ tsdf._m.c (catalog) | 1.11 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.list-query-expiration.li.m (root, namespace, manifest) | 0.44 kb'
      - '🗑️ ✅->❌ tsdf.sess1.list-query-expiration.listQuery.item."expired-users||1 (payload)'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.list-query-expiration.li.m (root, namespace, manifest) | 0.44 kb -> 0.24 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.list-query-expiration.lq.m (root, namespace, manifest) | 0.69 kb'
      - '🗑️ ✅->❌ tsdf.sess1.list-query-expiration.listQuery.query.{tableId:"expired-users"} (payload)'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.list-query-expiration.lq.m (root, namespace, manifest) | 0.69 kb -> 0.36 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 1.11 kb -> 1.14 kb'
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

    const readCapture = startPersistentStorageOperationCapture();
    env.scheduleFetch('highPriority', thirdQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.listQuery.query.`),
    ).toMatchInlineSnapshot(`['{tableId:"second"}', '{tableId:"third"}']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf._m.c (catalog) | 0.56 kb'
      - '🔑[0] ✅ tsdf.sess1.lq-query-metadata.listQuery.query.{tableId:"first"} (payload)'
      - '🔑[1] ✅ tsdf._m.c (catalog)'
      - '🔑[2] ✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest)'
      - '🔑[3] ✅ tsdf.sess1.lq-query-metadata.listQuery.query.{tableId:"second"} (payload)'
      - '📖 ✅ tsdf._m.c (catalog) | 0.56 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.56 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.56 kb'
      - '🔑[0] ✅ tsdf.sess1.lq-query-metadata.listQuery.query.{tableId:"first"} (payload)'
      - '🔑[1] ✅ tsdf._m.c (catalog)'
      - '🔑[2] ✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest)'
      - '🔑[3] ✅ tsdf.sess1.lq-query-metadata.listQuery.query.{tableId:"second"} (payload)'
      - '📖 ✅ tsdf._m.c (catalog) | 0.56 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.56 kb'
      - '✍️ ❌->✅ tsdf.sess1.lq-query-metadata.listQuery.query.{tableId:"third"} (payload) | ❌ -> 0.23 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.56 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 0.56 kb -> 0.56 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.56 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.56 kb -> 0.84 kb'
      - '✍️ ❌->✅ tsdf.sess1.lq-query-metadata.listQuery.item."third||1 (payload) | ❌ -> 0.20 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 0.56 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 0.56 kb -> 1.07 kb'
      - '📖 ❌ tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest)'
      - '✍️ ❌->✅ tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest) | ❌ -> 0.21 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 1.07 kb -> 1.07 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 1.07 kb -> 1.07 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.84 kb'
      - '🗑️ ✅->❌ tsdf.sess1.lq-query-metadata.listQuery.query.{tableId:"first"} (payload)'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.84 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.84 kb -> 0.58 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest) | 0.21 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 1.07 kb -> 1.11 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.11 kb'
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

    const readCapture = startPersistentStorageOperationCapture();
    env.apiStore.addItemToState(rawItemPayload('users', 3), {
      id: 3,
      name: 'Fresh',
    });
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.listQuery.item.`),
    ).toMatchInlineSnapshot(`['"users||3']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.38 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.lq.m (root, namespace, manifest) | 0.35 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.lq.m (root, namespace, manifest) | 0.35 kb'
      - '📖 ✅ tsdf.sess1.lq-item-metadata.listQuery.query.{tableId:"users"} (payload) | 0.25 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.38 kb'
      - '📖 ✅ tsdf.sess1.lq-item-metadata.listQuery.item."users||1 (payload) | 0.21 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.38 kb'
      - '📖 ✅ tsdf.sess1.lq-item-metadata.listQuery.item."users||2 (payload) | 0.21 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.38 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.lq.m (root, namespace, manifest) | 0.35 kb'
      - '✍️ ✅->✅ tsdf.sess1.lq-item-metadata.listQuery.query.{tableId:"users"} (payload) | 0.25 kb -> 0.21 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 1.07 kb -> 1.07 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.lq.m (root, namespace, manifest) | 0.35 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.lq-item-metadata.lq.m (root, namespace, manifest) | 0.35 kb -> 0.30 kb'
      - '✍️ ❌->✅ tsdf.sess1.lq-item-metadata.listQuery.item."users||3 (payload) | ❌ -> 0.20 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 1.07 kb -> 1.07 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.38 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.38 kb -> 0.55 kb'
      - '🗑️ ✅->❌ tsdf.sess1.lq-item-metadata.listQuery.item."users||1 (payload)'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.55 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.55 kb -> 0.38 kb'
      - '🗑️ ✅->❌ tsdf.sess1.lq-item-metadata.listQuery.item."users||2 (payload)'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.38 kb'
      - '✍️ ✅->✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.38 kb -> 0.21 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 1.07 kb -> 1.07 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 1.07 kb -> 1.07 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.07 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.21 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.lq.m (root, namespace, manifest) | 0.30 kb'
      - '✍️ ✅->✅ tsdf._m.c (catalog) | 1.07 kb -> 1.10 kb'
      - '📖 ✅ tsdf._m.c (catalog) | 1.10 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.21 kb'
      - '📖 ❌ tsdf.sess1.lq-item-metadata.listQuery.item."users||1 (payload)'
      - '📖 ✅ tsdf._m.c (catalog) | 1.10 kb'
      - '📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.21 kb'
      - '📖 ❌ tsdf.sess1.lq-item-metadata.listQuery.item."users||2 (payload)'
    `);
  });
});
