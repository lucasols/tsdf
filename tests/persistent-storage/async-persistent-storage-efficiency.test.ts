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
});

describe('async persistent storage efficiency', () => {
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
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: ['document payload']

      operations: ['📖 ✅ document payload | touch=coarse']
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
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: ['ci."1 (payload)']

      operations: ['📖 ✅ ci."1 (payload) | touch=coarse']
    `);

    expect(mockAdapter.payloadGetRequests).toContain(hotKey);
    expect(mockAdapter.payloadGetRequests).not.toContain(coldKey);
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
        metadataReads:
          - 'sess1/collection-opfs-eviction-efficiency/collection.item (metadata order=lru-desc cursor=null limit=100)'
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '✍️ sess1/collection-opfs-eviction-efficiency/collection.item upserts=["collection.item.\\"3 (payload)"] removes=[] touches=[]'
        - '📖 ❌ tsdf.sess1._o_.p (protected registry payload) | touch=never'
        - '📇 sess1/collection-opfs-eviction-efficiency/collection.item (metadata order=lru-desc cursor=null limit=100 resultCount=3 nextCursor=null)'
        - '✍️ sess1/collection-opfs-eviction-efficiency/collection.item upserts=[] removes=["collection.item.\\"2 (payload)"] touches=[]'
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
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: ['lq.{tableId:"users"} (payload)', 'li."users||1 (payload)']

      operations:
        - '📖 ✅ lq.{tableId:"users"} (payload) | touch=coarse'
        - '📖 ✅ li."users||1 (payload) | touch=coarse'
    `);

    expect(mockAdapter.payloadGetRequests).toContain(usersQueryKey);
    expect(mockAdapter.payloadGetRequests).toContain(usersItemKey);
    expect(mockAdapter.payloadGetRequests).not.toContain(projectsQueryKey);
    expect(mockAdapter.payloadGetRequests).not.toContain(projectsItemKey);
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
        metadataReads:
          - 'sess1/list-query-opfs-eviction-efficiency/listQuery.query (metadata order=lru-desc cursor=null limit=100)'
          - 'sess1/list-query-opfs-eviction-efficiency/listQuery.item (metadata order=lru-desc cursor=null limit=100)'
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '✍️ sess1/list-query-opfs-eviction-efficiency/listQuery.query upserts=["listQuery.query.{tableId:\\"tasks\\"} (payload)"] removes=[] touches=[]'
        - '✍️ sess1/list-query-opfs-eviction-efficiency/listQuery.item upserts=["listQuery.item.\\"projects||1 (payload)"] removes=[] touches=[]'
        - '✍️ sess1/list-query-opfs-eviction-efficiency/listQuery.item upserts=["listQuery.item.\\"tasks||1 (payload)"] removes=[] touches=[]'
        - '📖 ❌ tsdf.sess1._o_.p (protected registry payload) | touch=never'
        - '📇 sess1/list-query-opfs-eviction-efficiency/listQuery.query (metadata order=lru-desc cursor=null limit=100 resultCount=3 nextCursor=null)'
        - '✍️ sess1/list-query-opfs-eviction-efficiency/listQuery.query upserts=[] removes=["listQuery.query.{tableId:\\"users\\"} (payload)"] touches=[]'
        - '📖 ❌ tsdf.sess1._o_.p (protected registry payload) | touch=never'
        - '📇 sess1/list-query-opfs-eviction-efficiency/listQuery.item (metadata order=lru-desc cursor=null limit=100 resultCount=3 nextCursor=null)'
        - '✍️ sess1/list-query-opfs-eviction-efficiency/listQuery.item upserts=[] removes=["listQuery.item.\\"users||1 (payload)"] touches=[]'
    `);
  });
});
