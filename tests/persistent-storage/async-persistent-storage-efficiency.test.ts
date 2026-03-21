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
import type { PersistentStorageSchema } from '../../src/persistentStorage/types';
import {
  clearSessionProtectedKeysSnapshot,
  setSessionProtectedKeysSnapshot,
} from '../../src/persistentStorage/offline/sessionProtectionRegistry';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { createMockOpfsStorageAdapter } from '../mocks/mockOpfsStorageAdapter';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { startOpfsPersistentStorageOperationCapture } from '../utils/persistentStorageOptimizationTestUtils';

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

type DocumentData = { name: string; value: number };

function createDocumentEnv(options: {
  storeName: string;
  sessionKey: string;
  storageAdapter: ReturnType<typeof createMockOpfsStorageAdapter>['adapter'];
  serverData?: DocumentData;
}) {
  return createDocumentStoreTestEnv(
    options.serverData ?? { name: 'fresh', value: 1 },
    {
      getSessionKey: () => options.sessionKey,
      storageAdapter: options.storageAdapter,
      persistentStorage: {
        storeName: options.storeName,
        adapter: opfsPersistentStorage,
        schema: wrappedDocumentSchema,
      },
    },
  );
}

type CollectionItemState = { id: string; name: string };

function createCollectionEnv(options: {
  storeName: string;
  sessionKey: string;
  storageAdapter: ReturnType<typeof createMockOpfsStorageAdapter>['adapter'];
  serverData?: Record<string, CollectionItemState>;
  maxItems?: number;
}) {
  return createCollectionStoreTestEnv(options.serverData ?? {}, {
    getSessionKey: () => options.sessionKey,
    storageAdapter: options.storageAdapter,
    persistentStorage: {
      storeName: options.storeName,
      adapter: opfsPersistentStorage,
      schema: wrappedCollectionItemSchema,
      payloadSchema: rc_string,
      maxItems: options.maxItems,
    },
  });
}

function createListQueryEnv(options: {
  storeName: string;
  sessionKey: string;
  storageAdapter: ReturnType<typeof createMockOpfsStorageAdapter>['adapter'];
  serverData?: Tables<Row>;
  maxItems?: number;
  maxQueries?: number;
}) {
  return createListQueryStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey,
    storageAdapter: options.storageAdapter,
    persistentStorage: {
      storeName: options.storeName,
      adapter: opfsPersistentStorage,
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryParamsSchema,
      maxItems: options.maxItems,
      maxQueries: options.maxQueries,
    },
  });
}

function documentStorageKey(storeName: string, sessionKey: string): string {
  return `tsdf.${sessionKey}.${storeName}`;
}

function collectionStorageKey(
  storeName: string,
  sessionKey: string,
  payload: string,
): string {
  return `tsdf.${sessionKey}.${storeName}.ci.${getCompositeKey(payload)}`;
}

function listQueryItemStorageKey(
  storeName: string,
  sessionKey: string,
  tableId: string,
  id: number,
): string {
  return `tsdf.${sessionKey}.${storeName}.li.${getCompositeKey(`${tableId}||${id}`)}`;
}

function listQueryStorageKey(
  storeName: string,
  sessionKey: string,
  params: ListQueryParams,
): string {
  return `tsdf.${sessionKey}.${storeName}.lq.${getCompositeKey(params)}`;
}

async function settleStartupCleanup(
  mockAdapter: ReturnType<typeof createMockOpfsStorageAdapter>,
): Promise<void> {
  await advanceTime(3000);
  await flushAllTimers();
  mockAdapter.clearInstrumentation();
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
  clearSessionProtectedKeysSnapshot('sess1');
  clearSessionProtectedKeysSnapshot('session1');
});

describe('async persistent storage efficiency', () => {
  test('namespace commits coalesce and pending writes flush before reads', async () => {
    const mockAdapter = createMockOpfsStorageAdapter({
      storeName: 'coalesced-opfs',
      sessionKey: 'sess1',
    });
    const namespace = mockAdapter.adapter.openNamespace<
      { value: string },
      Record<string, never>
    >({ sessionKey: 'sess1', storeName: 'coalesced-opfs', kind: 'document' });

    const firstCommit = namespace.commit({
      upserts: [{ key: 'document', value: { value: 'first' }, version: 1 }],
    });
    const secondCommit = namespace.commit({
      upserts: [{ key: 'document', value: { value: 'second' }, version: 1 }],
    });

    await advanceTime(39);
    expect(
      mockAdapter.operations.filter(
        (operation) => operation.type === 'setMany',
      ),
    ).toMatchInlineSnapshot(`[]`);

    const readPromise = namespace.get('document', { touch: 'never' });
    const entry = await readPromise;
    await Promise.all([firstCommit, secondCommit]);

    expect(entry?.value).toMatchInlineSnapshot(`
      value: 'second'
    `);
    expect(
      mockAdapter.operations
        .filter((operation) => operation.type === 'setMany')
        .map((operation) => ({
          scope: operation.scope,
          records: operation.records.map((record) => ({
            key: record.key,
            kind: record.recordKind,
          })),
        })),
    ).toMatchInlineSnapshot(`
      - records:
          - { key: '__tsdf_payload__:document', kind: 'payload' }
          - { key: '__tsdf_meta__:document', kind: 'metadata' }
        scope: { kind: 'document', sessionKey: 'sess1', storeName: 'coalesced-opfs' }
    `);
  });

  test('live async reads suppress redundant touch commits in the same recency bucket', async () => {
    const mockAdapter = createMockOpfsStorageAdapter({
      storeName: 'touch-guard-opfs',
      sessionKey: 'sess1',
    });
    const namespace = mockAdapter.adapter.openNamespace<
      { value: string },
      Record<string, never>
    >({ sessionKey: 'sess1', storeName: 'touch-guard-opfs', kind: 'document' });

    const seedCommit = namespace.commit({
      upserts: [{ key: 'document', value: { value: 'cached' }, version: 1 }],
    });
    await advanceTime(40);
    await seedCommit;
    mockAdapter.clearInstrumentation();
    await advanceTime(6 * 60 * 60 * 1000);

    const firstReadPromise = namespace.get('document', { touch: 'coarse' });
    await advanceTime(40);
    const firstRead = await firstReadPromise;
    const secondRead = await namespace.get('document', { touch: 'coarse' });

    expect(firstRead?.value).toMatchInlineSnapshot(`
      value: 'cached'
    `);
    expect(secondRead?.value).toMatchInlineSnapshot(`
      value: 'cached'
    `);
    expect(
      mockAdapter.operations
        .filter((operation) => operation.type === 'setMany')
        .map((operation) => ({
          scope: operation.scope,
          records: operation.records.map((record) => ({
            key: record.key,
            kind: record.recordKind,
          })),
        })),
    ).toMatchInlineSnapshot(`
      - records:
          - { key: '__tsdf_meta__:document', kind: 'metadata' }
        scope: { kind: 'document', sessionKey: 'sess1', storeName: 'touch-guard-opfs' }
    `);
  });

  test('document preload performs one targeted payload read without metadata scans', async () => {
    const storeName = 'doc-opfs-efficiency';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 50,
      storeName,
      sessionKey,
      initialState: {
        document: { data: { value: { name: 'cached', value: 1 } } },
      },
    });
    const env = createDocumentEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

    await settleStartupCleanup(mockAdapter);
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    const preloadPromise = env.apiStore.preloadPersistentStorage();
    await advanceTime(50);
    await preloadPromise;

    expect(readCapture.finish()).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['document metadata']
        metadataReads: ['document metadata']
        payloadBatchReads:
          - ['document payload']
        scopedPayloadReads: ['document payload']

      operations:
        - '📚 sess1/doc-opfs-efficiency/document hits=2/2 ["document payload","document metadata"]'
    `);

    expect(mockAdapter.has(documentStorageKey(storeName, sessionKey))).toBe(
      true,
    );
  });

  test('collection preload reads only the requested item payload', async () => {
    const storeName = 'collection-opfs-efficiency';
    const sessionKey = 'sess1';
    const hotPayload = '1';
    const coldPayload = '2';
    const hotKey = collectionStorageKey(storeName, sessionKey, hotPayload);
    const coldKey = collectionStorageKey(storeName, sessionKey, coldPayload);
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 50,
      storeName,
      sessionKey,
      initialState: {
        collection: [
          {
            payload: hotPayload,
            data: { value: { id: hotPayload, name: 'Hot' } },
          },
          {
            payload: coldPayload,
            data: { value: { id: coldPayload, name: 'Cold' } },
          },
        ],
      },
    });
    const env = createCollectionEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

    await settleStartupCleanup(mockAdapter);
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    const preloadPromise = env.apiStore.preloadItemFromStorage(hotPayload);
    await advanceTime(50);
    await preloadPromise;

    expect(readCapture.finish()).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['ci."1 (metadata)']
        metadataReads: ['ci."1 (metadata)']
        payloadBatchReads:
          - ['ci."1 (payload)']
        scopedPayloadReads: ['ci."1 (payload)']

      operations:
        - '📚 sess1/collection-opfs-efficiency/collection.item hits=2/2 ["ci.\\"1 (payload)","ci.\\"1 (metadata)"]'
    `);

    expect(mockAdapter.payloadGetManyRequests.flat()).toContain(hotKey);
    expect(mockAdapter.payloadGetManyRequests.flat()).not.toContain(coldKey);
  });

  test('collection maxItems eviction uses metadata scans without reading stored item payloads', async () => {
    const storeName = 'collection-opfs-eviction-efficiency';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });
    const env = createCollectionEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      maxItems: 2,
    });

    await settleStartupCleanup(mockAdapter);

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'One' } });
    env.apiStore.addItemToState('2', { value: { id: '2', name: 'Two' } });
    await advanceTime(1100);
    await flushAllTimers();
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    env.apiStore.addItemToState('3', { value: { id: '3', name: 'Three' } });
    await advanceTime(1100);
    await flushAllTimers();

    expect(readCapture.finish()).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: ['tsdf.sess1._o_.p (protected registry payload)']
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/collection-opfs-eviction-efficiency/collection.item'
          - 'sess1/collection-opfs-eviction-efficiency/collection.item'
        metadataBatchReads:
          - ['ci."3 (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['ci."1 (metadata)', 'ci."2 (metadata)', 'ci."3 (metadata)']
        metadataReads:
          - 'ci."3 (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'ci."1 (metadata)'
          - 'ci."2 (metadata)'
          - 'ci."3 (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '📚 sess1/collection-opfs-eviction-efficiency/collection.item hits=0/1 ["ci.\\"3 (metadata)"]'
        - '✍️ sess1/collection-opfs-eviction-efficiency/collection.item ["ci.\\"3 (payload)","ci.\\"3 (metadata)"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/collection-opfs-eviction-efficiency/collection.item keys=["__tsdf_meta__:\\"1","__tsdf_meta__:\\"2","__tsdf_meta__:\\"3","__tsdf_payload__:\\"1","__tsdf_payload__:\\"2","__tsdf_payload__:\\"3"]'
        - '📚 sess1/collection-opfs-eviction-efficiency/collection.item hits=3/3 ["ci.\\"1 (metadata)","ci.\\"2 (metadata)","ci.\\"3 (metadata)"]'
        - '🗑️ sess1/collection-opfs-eviction-efficiency/collection.item ["ci.\\"2 (payload)","ci.\\"2 (metadata)"]'
        - '🗂️ sess1/collection-opfs-eviction-efficiency/collection.item keys=["__tsdf_meta__:\\"1","__tsdf_meta__:\\"3","__tsdf_payload__:\\"1","__tsdf_payload__:\\"3"]'
    `);
  });

  test('protected snapshot reuse avoids rereading the async protected registry during eviction', async () => {
    const storeName = 'collection-opfs-protected-snapshot';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });
    const env = createCollectionEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      maxItems: 2,
    });

    await settleStartupCleanup(mockAdapter);
    setSessionProtectedKeysSnapshot(sessionKey, [
      collectionStorageKey(storeName, sessionKey, '1'),
    ]);

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'One' } });
    env.apiStore.addItemToState('2', { value: { id: '2', name: 'Two' } });
    await advanceTime(1100);
    await flushAllTimers();
    mockAdapter.clearInstrumentation();

    env.apiStore.addItemToState('3', { value: { id: '3', name: 'Three' } });
    await advanceTime(1100);
    await flushAllTimers();

    expect(mockAdapter.payloadGetRequests).toMatchInlineSnapshot(`[]`);
    expect(mockAdapter.listKeysRequests).toMatchInlineSnapshot(`
      - kind: 'collection.item'
        sessionKey: 'sess1'
        storeName: 'collection-opfs-protected-snapshot'
      - kind: 'collection.item'
        sessionKey: 'sess1'
        storeName: 'collection-opfs-protected-snapshot'
    `);
  });

  test('list query preload reads only the requested query and its referenced items', async () => {
    const storeName = 'list-query-opfs-efficiency';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const usersItemKey = listQueryItemStorageKey(
      storeName,
      sessionKey,
      'users',
      1,
    );
    const projectsItemKey = listQueryItemStorageKey(
      storeName,
      sessionKey,
      'projects',
      1,
    );
    const usersQueryKey = listQueryStorageKey(
      storeName,
      sessionKey,
      usersQuery,
    );
    const projectsQueryKey = listQueryStorageKey(
      storeName,
      sessionKey,
      projectsQuery,
    );
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 50,
      storeName,
      sessionKey,
      initialState: {
        listQuery: {
          items: [
            { tableId: 'users', id: 1, data: { id: 1, name: 'User 1' } },
            { tableId: 'projects', id: 1, data: { id: 1, name: 'Project 1' } },
          ],
          queries: [
            { params: usersQuery, items: [{ tableId: 'users', id: 1 }] },
            { params: projectsQuery, items: [{ tableId: 'projects', id: 1 }] },
          ],
        },
      },
    });
    const env = createListQueryEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

    await settleStartupCleanup(mockAdapter);
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await advanceTime(100);
    await preloadPromise;

    expect(readCapture.finish()).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['lq.{tableId:"users"} (metadata)']
          - ['li."users||1 (metadata)']
        metadataReads: ['lq.{tableId:"users"} (metadata)', 'li."users||1 (metadata)']
        payloadBatchReads:
          - ['lq.{tableId:"users"} (payload)']
          - ['li."users||1 (payload)']
        scopedPayloadReads: ['lq.{tableId:"users"} (payload)', 'li."users||1 (payload)']

      operations:
        - '📚 sess1/list-query-opfs-efficiency/listQuery.query hits=2/2 ["lq.{tableId:\\"users\\"} (payload)","lq.{tableId:\\"users\\"} (metadata)"]'
        - '📚 sess1/list-query-opfs-efficiency/listQuery.item hits=2/2 ["li.\\"users||1 (payload)","li.\\"users||1 (metadata)"]'
    `);

    expect(mockAdapter.payloadGetManyRequests.flat()).toContain(usersQueryKey);
    expect(mockAdapter.payloadGetManyRequests.flat()).toContain(usersItemKey);
    expect(mockAdapter.payloadGetManyRequests.flat()).not.toContain(
      projectsQueryKey,
    );
    expect(mockAdapter.payloadGetManyRequests.flat()).not.toContain(
      projectsItemKey,
    );
  });

  test('list query eviction uses metadata scans without reading stored query or item payloads', async () => {
    const storeName = 'list-query-opfs-eviction-efficiency';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const tasksQuery = { tableId: 'tasks' };
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });
    const env = createListQueryEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      maxItems: 2,
      maxQueries: 2,
      serverData: {
        users: [{ id: 1, name: 'User 1' }],
        projects: [{ id: 1, name: 'Project 1' }],
        tasks: [{ id: 1, name: 'Task 1' }],
      },
    });

    await settleStartupCleanup(mockAdapter);

    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    env.scheduleFetch('highPriority', projectsQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    env.scheduleFetch('highPriority', tasksQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(readCapture.finish()).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads:
          - 'tsdf.sess1._o_.p (protected registry payload)'
          - 'tsdf.sess1._o_.p (protected registry payload)'
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/list-query-opfs-eviction-efficiency/listQuery.query'
          - 'sess1/list-query-opfs-eviction-efficiency/listQuery.query'
          - 'sess1/list-query-opfs-eviction-efficiency/listQuery.item'
          - 'sess1/list-query-opfs-eviction-efficiency/listQuery.item'
        metadataBatchReads:
          - ['lq.{tableId:"tasks"} (metadata)']
          - ['li."projects||1 (metadata)', 'li."tasks||1 (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - - 'lq.{tableId:"projects"} (metadata)'
            - 'lq.{tableId:"tasks"} (metadata)'
            - 'lq.{tableId:"users"} (metadata)'
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - - 'li."projects||1 (metadata)'
            - 'li."tasks||1 (metadata)'
            - 'li."users||1 (metadata)'
        metadataReads:
          - 'lq.{tableId:"tasks"} (metadata)'
          - 'li."projects||1 (metadata)'
          - 'li."tasks||1 (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'lq.{tableId:"projects"} (metadata)'
          - 'lq.{tableId:"tasks"} (metadata)'
          - 'lq.{tableId:"users"} (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'li."projects||1 (metadata)'
          - 'li."tasks||1 (metadata)'
          - 'li."users||1 (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '📚 sess1/list-query-opfs-eviction-efficiency/listQuery.query hits=0/1 ["lq.{tableId:\\"tasks\\"} (metadata)"]'
        - '✍️ sess1/list-query-opfs-eviction-efficiency/listQuery.query ["lq.{tableId:\\"tasks\\"} (payload)","lq.{tableId:\\"tasks\\"} (metadata)"]'
        - '📚 sess1/list-query-opfs-eviction-efficiency/listQuery.item hits=1/2 ["li.\\"projects||1 (metadata)","li.\\"tasks||1 (metadata)"]'
        - '✍️ sess1/list-query-opfs-eviction-efficiency/listQuery.item ["li.\\"projects||1 (payload)","li.\\"projects||1 (metadata)","li.\\"tasks||1 (payload)","li.\\"tasks||1 (metadata)"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/list-query-opfs-eviction-efficiency/listQuery.query keys=["__tsdf_meta__:{tableId:\\"projects\\"}","__tsdf_meta__:{tableId:\\"tasks\\"}","__tsdf_meta__:{tableId:\\"users\\"}","__tsdf_payload__:{tableId:\\"projects\\"}","__tsdf_payload__:{tableId:\\"tasks\\"}","__tsdf_payload__:{tableId:\\"users\\"}"]'
        - '📚 sess1/list-query-opfs-eviction-efficiency/listQuery.query hits=3/3 ["lq.{tableId:\\"projects\\"} (metadata)","lq.{tableId:\\"tasks\\"} (metadata)","lq.{tableId:\\"users\\"} (metadata)"]'
        - '🗑️ sess1/list-query-opfs-eviction-efficiency/listQuery.query ["lq.{tableId:\\"users\\"} (payload)","lq.{tableId:\\"users\\"} (metadata)"]'
        - '🗂️ sess1/list-query-opfs-eviction-efficiency/listQuery.query keys=["__tsdf_meta__:{tableId:\\"projects\\"}","__tsdf_meta__:{tableId:\\"tasks\\"}","__tsdf_payload__:{tableId:\\"projects\\"}","__tsdf_payload__:{tableId:\\"tasks\\"}"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/list-query-opfs-eviction-efficiency/listQuery.item keys=["__tsdf_meta__:\\"projects||1","__tsdf_meta__:\\"tasks||1","__tsdf_meta__:\\"users||1","__tsdf_payload__:\\"projects||1","__tsdf_payload__:\\"tasks||1","__tsdf_payload__:\\"users||1"]'
        - '📚 sess1/list-query-opfs-eviction-efficiency/listQuery.item hits=3/3 ["li.\\"projects||1 (metadata)","li.\\"tasks||1 (metadata)","li.\\"users||1 (metadata)"]'
        - '🗑️ sess1/list-query-opfs-eviction-efficiency/listQuery.item ["li.\\"users||1 (payload)","li.\\"users||1 (metadata)"]'
        - '🗂️ sess1/list-query-opfs-eviction-efficiency/listQuery.item keys=["__tsdf_meta__:\\"projects||1","__tsdf_meta__:\\"tasks||1","__tsdf_payload__:\\"projects||1","__tsdf_payload__:\\"tasks||1"]'
    `);
  });
});
