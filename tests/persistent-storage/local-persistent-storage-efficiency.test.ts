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
import { localPersistentStorage } from '../../src/persistentStorage/storageAdapter';
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
import { startPersistentStorageReadCapture } from '../utils/persistentStorageOptimizationTestUtils';
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
      adapter: localPersistentStorage,
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
      adapter: localPersistentStorage,
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

    const startupReadCapture = startPersistentStorageReadCapture();
    createDocumentStoreTestEnv(
      { name: 'fresh', value: 2 },
      {
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'fresh-doc',
          adapter: localPersistentStorage,
          schema: wrappedDocumentSchema,
        },
      },
    );
    const startupReadBreakdown = startupReadCapture.finish();

    expect(startupReadBreakdown).toMatchInlineSnapshot(`
      metadataKeys: []
      otherKeys: []
      payloadKeys: []
    `);

    const readCapture = startPersistentStorageReadCapture();
    await waitForScheduledCleanup();
    const readBreakdown = readCapture.finish();

    expect(localStorage.getItem(expiredDoc.document.storageKey())).toBeNull();
    expect(localStorage.getItem(freshDoc.document.storageKey())).not.toBeNull();
    expect(readBreakdown).toMatchInlineSnapshot(`
      metadataKeys:
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.s:sess1.expired-doc.m (root, single, manifest)'
        - '✅ tsdf._m.r.s:sess1.fresh-doc.m (root, single, manifest)'
      otherKeys: []
      payloadKeys: []
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
          adapter: localPersistentStorage,
          schema: wrappedDocumentSchema,
        },
      },
    );

    const readCapture = startPersistentStorageReadCapture();
    await waitForScheduledCleanup();
    const readBreakdown = readCapture.finish();

    expect(localStorage.getItem('tsdf.sess1.corrupted')).not.toBeNull();
    expect(readBreakdown).toMatchInlineSnapshot(`
      metadataKeys:
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.s:sess1.corrupted.m (root, single, manifest)'
        - '✅ tsdf._m.r.s:sess1.trigger.m (root, single, manifest)'
      otherKeys: []
      payloadKeys: []
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
          adapter: localPersistentStorage,
          schema: wrappedDocumentSchema,
        },
      },
    );

    const readCapture = startPersistentStorageReadCapture();
    await waitForScheduledCleanup();
    const readBreakdown = readCapture.finish();

    expect({
      protectedEntryExists:
        localStorage.getItem(protectedDoc.document.storageKey()) !== null,
      unprotectedEntryExists:
        localStorage.getItem(unprotectedDoc.document.storageKey()) !== null,
      protectedRootSession:
        readManagedLocalStorageRoot(protectedRootKey)?.sessionKey,
    }).toMatchInlineSnapshot(`
      protectedEntryExists: '✅'
      protectedRootSession: 'user@example.com'
      unprotectedEntryExists: '❌'
    `);
    expect(readBreakdown).toMatchInlineSnapshot(`
      metadataKeys:
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.s:user@example.com.protected-doc.m (root, single, manifest)'
        - '✅ tsdf._m.r.s:user@example.com.unprotected-doc.m (root, single, manifest)'
        - '✅ tsdf._m.r.s:sess-trigger.trigger-doc.m (root, single, manifest)'
      otherKeys: []
      payloadKeys: []
    `);
  });
});

describe('collection store', () => {
  test('maxItems cleanup snapshots the full metadata read history', async () => {
    setCachedCollectionItem('col-max-items-metadata', 'sess1', 'a', {
      value: { id: 'a', name: 'Oldest cached' },
    });
    await advanceTime(100);
    setCachedCollectionItem('col-max-items-metadata', 'sess1', 'b', {
      value: { id: 'b', name: 'Newer cached' },
    });

    const env = createCollectionEnv({
      storeName: 'col-max-items-metadata',
      sessionKey: 'sess1',
      maxItems: 2,
    });

    const readCapture = startPersistentStorageReadCapture();
    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'Fresh' } });
    await advanceTime(1100);
    await flushAllTimers();
    const readBreakdown = readCapture.finish();

    expect(
      listStoredCollectionItemPayloads(
        'col-max-items-metadata',
        'sess1',
      ).sort(),
    ).toEqual(['b', 'c']);
    expect(readBreakdown).toMatchInlineSnapshot(`
      metadataKeys:
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.col-max-items-metadata.collection.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.col-max-items-metadata.collection.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.col-max-items-metadata.collection.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.col-max-items-metadata.collection.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.col-max-items-metadata.collection.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.col-max-items-metadata.collection.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
      otherKeys: []
      payloadKeys: []
    `);
  });
});

describe('list query store', () => {
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

    const readCapture = startPersistentStorageReadCapture();
    env.scheduleFetch('highPriority', thirdQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    const readBreakdown = readCapture.finish();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.listQuery.query.`),
    ).toMatchInlineSnapshot(`['{tableId:"second"}', '{tableId:"third"}']`);
    expect(readBreakdown).toMatchInlineSnapshot(`
      metadataKeys:
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-query-metadata.listQuery.query..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-query-metadata.listQuery.query..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-query-metadata.listQuery.query..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '❌ tsdf._m.r.n:sess1.lq-query-metadata.listQuery.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-query-metadata.listQuery.query..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-query-metadata.listQuery.query..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-query-metadata.listQuery.query..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-query-metadata.listQuery.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.r.n:sess1.lq-query-metadata.listQuery.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
      otherKeys: []
      payloadKeys: []
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

    const readCapture = startPersistentStorageReadCapture();
    env.apiStore.addItemToState(rawItemPayload('users', 3), {
      id: 3,
      name: 'Fresh',
    });
    await advanceTime(1100);
    await flushAllTimers();
    const readBreakdown = readCapture.finish();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.listQuery.item.`),
    ).toMatchInlineSnapshot(`['"users||3']`);
    expect(readBreakdown).toMatchInlineSnapshot(`
      metadataKeys:
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.query..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.query..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.query..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.query..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.query..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.query..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.item..m (root, namespace, manifest)'
        - '✅ tsdf._m.c (catalog)'
        - '✅ tsdf._m.r.n:sess1.lq-item-metadata.listQuery.item..m (root, namespace, manifest)'
      otherKeys: []
      payloadKeys:
        - '✅ tsdf.sess1.lq-item-metadata.listQuery.query.{tableId:"users"} (payload)'
        - '✅ tsdf.sess1.lq-item-metadata.listQuery.item."users||1 (payload)'
        - '✅ tsdf.sess1.lq-item-metadata.listQuery.item."users||2 (payload)'
        - '❌ tsdf.sess1.lq-item-metadata.listQuery.item."users||1 (payload)'
        - '❌ tsdf.sess1.lq-item-metadata.listQuery.item."users||2 (payload)'
    `);
  });
});
