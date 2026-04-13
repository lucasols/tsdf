import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { getDefaultMaxBytesForScope } from '../../../src/persistentStorage/persistentStorageDefaults';
import type { ListQueryParams } from '../../mocks/listQueryStoreTestEnv';
import { advanceTime } from '../../utils/genericTestUtils';
import {
  getIndexedDbNamespaceSnapshot,
  getIndexedDbPayloadSnapshot,
  getIndexedDbStructureSnapshot,
  getParsedIndexedDbRecordData,
  startIndexedDbPersistentStorageOperationCapture,
} from '../../utils/indexedDbPersistentStorageOptimizationTestUtils';
import { createIndexedDbPersistentStorageTestStore } from '../../utils/indexedDbPersistentStorageTestStore';
import {
  captureHookRemount,
  createDocumentEnv,
  createListQueryEnv,
  flushInvalidationPersistence,
  getAsyncListItemEntrySizeBytes,
  getAsyncListQueryEntrySizeBytes,
  rawItemPayload,
  resolveAfterIndexedDbStorage,
  setProtectedKeysSnapshot,
  settleIndexedDbStorage,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  storeItemKey,
  sumPersistedEntryBytes,
  waitForHookValue,
  waitForScheduledCleanup,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

async function readListQueryNamespacePolicyRow(args: {
  kind: 'listQuery.item' | 'listQuery.query';
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  sessionKey: string;
  storeName: string;
}) {
  return getParsedIndexedDbRecordData(args.mockAdapter, {
    key: [args.sessionKey, args.storeName, args.kind],
    storeName: 'namespacePolicies',
  });
}

function stripTimelineDurations(timeline: string): string {
  return timeline.replace(/^\s*\d+(?:\.\d+)?(?:ms|s)\s+\| /gm, '| ');
}

async function readListQueryItemNamespaceSnapshot(args: {
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  sessionKey: string;
  storeName: string;
}) {
  const scope = args.mockAdapter.scope(args.storeName, args.sessionKey);
  return getIndexedDbNamespaceSnapshot(
    args.mockAdapter,
    scope.listQuery.itemNamespace,
  );
}

async function readListQueryQueryNamespaceSnapshot(args: {
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  sessionKey: string;
  storeName: string;
}) {
  const scope = args.mockAdapter.scope(args.storeName, args.sessionKey);
  return getIndexedDbNamespaceSnapshot(
    args.mockAdapter,
    scope.listQuery.queryNamespace,
  );
}

async function readListQueryItemPayloadSnapshot(args: {
  id: number | string;
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  sessionKey: string;
  storeName: string;
  tableId: string;
}) {
  const scope = args.mockAdapter.scope(args.storeName, args.sessionKey);
  return getIndexedDbPayloadSnapshot(args.mockAdapter, {
    key: scope.listQuery.itemKey(args.tableId, args.id),
    scope: scope.listQuery.itemNamespace,
  });
}

async function readListQueryQueryPayloadSnapshot(args: {
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  params: unknown;
  sessionKey: string;
  storeName: string;
}) {
  const scope = args.mockAdapter.scope(args.storeName, args.sessionKey);
  return getIndexedDbPayloadSnapshot(args.mockAdapter, {
    key: scope.listQuery.queryKey(args.params),
    scope: scope.listQuery.queryNamespace,
  });
}

describe('indexeddb async storage efficiency: list-query', () => {
  test('expiration cleanup removes expired queries and items through namespace manifests only', async () => {
    const expiredTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const storeName = 'list-query-expiration';
    const sessionKey = 'sess1';
    const expiredQueryParams: ListQueryParams = { tableId: 'expired-users' };
    const freshQueryParams: ListQueryParams = { tableId: 'fresh-users' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    // Seed one stale query+item pair and one fresh pair to verify cleanup across both namespaces.
    const expiredItemKey = listQueryScope.listQuery.seedItem(
      'expired-users',
      1,
      { id: 1, name: 'Expired Item' },
      { timestamp: expiredTimestamp },
    ).storageKey;
    const expiredQueryKey = listQueryScope.listQuery.seedQuery(
      expiredQueryParams,
      [storeItemKey('expired-users', 1)],
      { timestamp: expiredTimestamp },
    );
    const freshItemKey = listQueryScope.listQuery.seedItem('fresh-users', 2, {
      id: 2,
      name: 'Fresh Item',
    }).storageKey;
    const freshQueryKey = listQueryScope.listQuery.seedQuery(freshQueryParams, [
      storeItemKey('fresh-users', 2),
    ]);
    // Startup should only queue the background scan.
    const startupOperationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    createListQueryEnv({ storeName, sessionKey });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the scan runs, capture the complete query and item cleanup sequence.
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      expiredItemExists: await mockAdapter.has(expiredItemKey),
      expiredQueryExists: await mockAdapter.has(expiredQueryKey),
      freshItemExists: await mockAdapter.has(freshItemKey),
      freshQueryExists: await mockAdapter.has(freshQueryKey),
    }).toMatchInlineSnapshot(`
      expiredItemExists: '❌'
      expiredQueryExists: '❌'
      freshItemExists: '✅'
      freshQueryExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      2.011s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","list-query-expiration","listQuery.item"], ["sess1","list-query-expiration","listQuery.query"]]
      2.016s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-expiration","listQuery.query"] -> keys=2 exists=yes valid=yes
      2.016s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-expiration","listQuery.item"] -> keys=2 exists=yes valid=yes
      2.016s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-expiration","listQuery.item"] -> keys=2 exists=yes valid=yes
      2.016s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-expiration","listQuery.query"] -> keys=2 exists=yes valid=yes
      2.019s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","list-query-expiration","listQuery.item"] keys=["\\"expired-users||1"]
      2.022s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","list-query-expiration","listQuery.query"] keys=["{tableId:\\"expired-users\\"}"]
      2.027s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","list-query-expiration","listQuery.item"] keys=1
      2.03s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","list-query-expiration","listQuery.query"] keys=1
      ""
    `);
    expect(await getIndexedDbStructureSnapshot(mockAdapter))
      .toMatchInlineSnapshot(`
        stores:
          - autoIncrement: '❌'
            indexes:
              - keyPath: ['i', 'g']
                multiEntry: '❌'
                name: 'byScopeGroup'
                unique: '❌'
              - keyPath: ['i', 'a']
                multiEntry: '❌'
                name: 'byScopeLastAccessAt'
                unique: '❌'
              - keyPath: ['i', 'o']
                multiEntry: '❌'
                name: 'byScopeOfflineProtected'
                unique: '❌'
            keyPath: null
            name: 'entries'
            rowCount: 2
            rows:
              - key: ['["sess1","list-query-expiration","li"]', '"fresh-users||2']
                value: 'JSON object | 0.3 kb'
              - key: ['["sess1","list-query-expiration","lq"]', '{tableId:"fresh-users"}']
                value: 'JSON object | 0.3 kb'
          - autoIncrement: '❌'
            indexes: []
            keyPath: 'k'
            name: 'meta'
            rowCount: 0
            rows: []
          - autoIncrement: '❌'
            indexes:
              - { keyPath: 's', multiEntry: '❌', name: 'bySession', unique: '❌' }
            keyPath: null
            name: 'namespacePolicies'
            rowCount: 2
            rows:
              - key: ['sess1', 'list-query-expiration', 'li']
                value: 'JSON object | 0.0 kb'
              - key: ['sess1', 'list-query-expiration', 'lq']
                value: 'JSON object | 0.0 kb'
        version: 1
      `);
    expect(
      await readListQueryItemNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        "fresh-users||2: { a: 1735689600000, p: 'fresh-users||2' }
    `);
    expect(
      await readListQueryItemPayloadSnapshot({
        id: 2,
        mockAdapter,
        sessionKey,
        storeName,
        tableId: 'fresh-users',
      }),
    ).toMatchInlineSnapshot(`
      id: 2
      name: 'Fresh Item'
    `);
    expect(
      await readListQueryQueryNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        {tableId:"fresh-users"}:
          a: 1735689600000
          p: { tableId: 'fresh-users' }
    `);
    expect(
      await readListQueryQueryPayloadSnapshot({
        mockAdapter,
        params: freshQueryParams,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`['"fresh-users||2']`);
  });

  test('startup cleanup enforces maxQueries against preloaded persisted entries', async () => {
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const storeName = 'lq-startup-max-queries';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    // Seed an over-limit query cache so startup maintenance has to trim it.
    listQueryScope.listQuery.seedQuery(firstQuery, []);
    await advanceTime(100);
    listQueryScope.listQuery.seedQuery(secondQuery, []);
    await advanceTime(100);
    listQueryScope.listQuery.seedQuery(thirdQuery, []);
    listQueryScope.listQuery.setQueryStaticPolicy({
      b: sumPersistedEntryBytes(
        getAsyncListQueryEntrySizeBytes(secondQuery, []),
        getAsyncListQueryEntrySizeBytes(thirdQuery, []),
      ),
    });

    // Startup should only schedule the cleanup work.
    const startupOperationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    createDocumentEnv({ storeName: 'trigger-doc', sessionKey });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the startup pass runs, it should evict only the oldest persisted query.
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      (await listQueryScope.listQuery.listStoredQueryKeys()).sort(),
    ).toMatchInlineSnapshot(`['{tableId:"second"}', '{tableId:"third"}']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      2.008s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-startup-max-queries","listQuery.query"]]
      2.014s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-startup-max-queries","listQuery.query"] -> keys=3 exists=yes valid=yes
      2.017s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","lq-startup-max-queries","listQuery.query"] keys=["{tableId:\\"first\\"}"]
      2.024s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","lq-startup-max-queries","listQuery.query"] keys=2 static-policy
      ""
    `);
    expect(
      await readListQueryQueryNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        {tableId:"second"}:
          a: 1735689600100
          p: { tableId: 'second' }
        {tableId:"third"}:
          a: 1735689600200
          p: { tableId: 'third' }

      staticPolicy: { b: 91 }
    `);
    expect(
      await readListQueryNamespacePolicyRow({
        kind: 'listQuery.query',
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      p: { b: 91 }
      s: 'sess1'
    `);
  });

  test('cold startup enforces the default list-query maxQueries policy before the store mounts', async () => {
    const storeName = 'lq-cold-default-max-queries';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);
    const defaultMaxQueryBytes = getDefaultMaxBytesForScope({
      adapter: 'async',
      scopeKind: 'listQuery.query',
    });
    const largeTableIdSuffix = 'q'.repeat(16_384);
    const getQuery = (index: number) => ({
      tableId: `users-${String(index).padStart(4, '0')}-${largeTableIdSuffix}`,
    });
    const entrySizeBytes = getAsyncListQueryEntrySizeBytes(getQuery(0), []);
    const keptQueryCount = Math.floor(defaultMaxQueryBytes / entrySizeBytes);
    const totalQueries = keptQueryCount + 4;

    for (let index = 0; index < totalQueries; index++) {
      listQueryScope.listQuery.seedQuery(getQuery(index), []);
      await advanceTime(1);
    }

    createDocumentEnv({ storeName: 'trigger-doc', sessionKey });
    await waitForScheduledCleanup();

    const storedQueryKeys =
      await listQueryScope.listQuery.listStoredQueryKeys();

    expect(storedQueryKeys.length).toBeLessThan(totalQueries);
    expect(storedQueryKeys).not.toContain(`{tableId:"${getQuery(0).tableId}"}`);
    expect(storedQueryKeys).toContain(
      `{tableId:"${getQuery(totalQueries - 1).tableId}"}`,
    );
  });

  test('when maxQueries limit is reached the flush trims queries inline', async () => {
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const storeName = 'lq-query-metadata';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedQuery(firstQuery, []);
    await advanceTime(100);
    listQueryScope.listQuery.seedQuery(secondQuery, []);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      maxQueryBytes: sumPersistedEntryBytes(
        getAsyncListQueryEntrySizeBytes(secondQuery, []),
        getAsyncListQueryEntrySizeBytes(thirdQuery, [storeItemKey('third', 1)]),
      ),
      serverData: { third: [{ id: 1, name: 'Third' }] },
    });

    // Drain the startup-scheduled cleanup before capturing the query fetch/eviction flow.
    await settleStartupBackgroundScan(mockAdapter);

    // Fetching a third query should inline the query trim before any follow-up maintenance is needed.
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    env.scheduleFetch('highPriority', thirdQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      (await listQueryScope.listQuery.listStoredQueryKeys()).sort(),
    ).toMatchInlineSnapshot(`['{tableId:"second"}', '{tableId:"third"}']`);
    expect(stripTimelineDurations(operationsBreakdown)).toMatchInlineSnapshot(`
      ""
      | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-query-metadata","listQuery.item"] order=lru-desc -> []
      | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-query-metadata","listQuery.query"] order=lru-desc -> ["{tableId:\\"second\\"}", "{tableId:\\"first\\"}"]
      | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-query-metadata","listQuery.query"] put=["{tableId:\\"third\\"}"] delete=["{tableId:\\"first\\"}"] touch=[] static-policy
      | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-query-metadata","listQuery.item"] put=["\\"third||1"] delete=[] touch=[] static-policy
      ""
    `);
    expect(
      await readListQueryItemNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        "third||1: { a: 1735689605004, p: 'third||1' }
    `);
    expect(
      await readListQueryItemPayloadSnapshot({
        id: 1,
        mockAdapter,
        sessionKey,
        storeName,
        tableId: 'third',
      }),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Third'
    `);
    expect(
      await readListQueryQueryNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        {tableId:"second"}:
          a: 1735689600100
          p: { tableId: 'second' }
        {tableId:"third"}:
          a: 1735689604956
          p: { tableId: 'third' }

      staticPolicy: { b: 103 }
    `);
    expect(
      await readListQueryQueryPayloadSnapshot({
        mockAdapter,
        params: thirdQuery,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`['"third||1']`);
  });

  test('multiple overflowing query writes trim inline during each flush', async () => {
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const fourthQuery = { tableId: 'fourth' };
    const storeName = 'lq-coalesced-query-maintenance';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedQuery(firstQuery, []);
    await advanceTime(100);
    listQueryScope.listQuery.seedQuery(secondQuery, []);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      maxQueryBytes: Math.max(
        sumPersistedEntryBytes(
          getAsyncListQueryEntrySizeBytes(secondQuery, []),
          getAsyncListQueryEntrySizeBytes(thirdQuery, [
            storeItemKey('third', 1),
          ]),
        ),
        sumPersistedEntryBytes(
          getAsyncListQueryEntrySizeBytes(thirdQuery, [
            storeItemKey('third', 1),
          ]),
          getAsyncListQueryEntrySizeBytes(fourthQuery, [
            storeItemKey('fourth', 2),
          ]),
        ),
      ),
      serverData: {
        third: [{ id: 1, name: 'Third' }],
        fourth: [{ id: 2, name: 'Fourth' }],
      },
    });

    // Drain the startup maintenance so the capture only covers the inline overflow trims.
    await settleStartupBackgroundScan(mockAdapter);

    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);

    // The third query persists and trims the oldest query in the same flush.
    env.scheduleFetch('highPriority', thirdQuery);
    await advanceTime(810);
    await advanceTime(1000);

    // The fourth query repeats the same inline trim for the next oldest query.
    env.scheduleFetch('highPriority', fourthQuery);
    await advanceTime(810);
    await advanceTime(1000);
    await settleIndexedDbStorage();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(operationsBreakdown).toContain(
      'entries.byScopeLastAccessAt scope=["sess1","lq-coalesced-query-maintenance","listQuery.query"] order=lru-desc -> ["{tableId:\\"second\\"}", "{tableId:\\"first\\"}"]',
    );
    expect(operationsBreakdown).not.toContain('entries.getMany');
  });

  test('persisting an empty query does not materialize the item namespace manifest', async () => {
    const storeName = 'lq-empty-query-manifest';
    const sessionKey = 'sess1';
    const usersQuery = {
      tableId: 'users',
      filters: [{ field: 'name', op: 'eq', value: 'Missing user' }],
    } satisfies ListQueryParams;
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Existing user' }] },
    });

    await settleStartupBackgroundScan(mockAdapter);

    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    env.scheduleFetch('highPriority', usersQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      await listQueryScope.listQuery.listStoredItemKeys(),
    ).toMatchInlineSnapshot(`[]`);
    expect(
      await listQueryScope.listQuery.listStoredQueryKeys(),
    ).toMatchInlineSnapshot(
      `['{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}']`,
    );
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      1.811s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-empty-query-manifest","listQuery.item"] order=lru-desc -> []
      1.813s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-empty-query-manifest","listQuery.query"] order=lru-desc -> []
      1.859s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-empty-query-manifest","listQuery.query"] put=["{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Missing user\\"}],tableId:\\"users\\"}"] delete=[] touch=[] static-policy
      ""
    `);
    expect(
      await readListQueryQueryNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        {filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}:
          a: 1735689604854
          p:
            filters:
              - { field: 'name', op: 'eq', value: 'Missing user' }
            tableId: 'users'
    `);
    expect(
      await readListQueryQueryPayloadSnapshot({
        mockAdapter,
        params: usersQuery,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('query that becomes empty after invalidation do not clean up orphaned items from persistence', async () => {
    const storeName = 'lq-query-becomes-empty';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    // Seed the cache with a query that has one item.
    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user',
    });
    listQueryScope.listQuery.seedQuery(usersQuery, [storeItemKey('users', 1)]);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Cached user' }] },
    });

    // Hydrate cached data first without a mount refetch so the invalidation path stays isolated.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Remove all items from the server so the refetch returns an empty list.
    env.serverTable.removeItem('users||1');

    // Invalidate the mounted query, then capture the persistence operations.
    const invalidationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: usersQuery,
        itemPayload: false,
      });
    });
    await flushInvalidationPersistence(1700);
    const invalidationOperations = invalidationCapture.finish().timelineString;

    expect(hook.result.current.items).toMatchInlineSnapshot(`[]`);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      ""
      1.812s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-query-becomes-empty","listQuery.item"] order=lru-desc -> ["\\"users||1"]
      1.815s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-query-becomes-empty","listQuery.query"] order=lru-desc -> ["{tableId:\\"users\\"}"]
      1.861s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-query-becomes-empty","listQuery.query"] put=["{tableId:\\"users\\"}"] delete=[] touch=[] static-policy
      1.907s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-query-becomes-empty","listQuery.item"] put=["\\"users||1"] delete=[] touch=[] static-policy
      ""
    `);
    expect(
      await readListQueryItemNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        "users||1:
          a: 1735689600000
          f: ['age', 'email', 'id', 'name']
          p: 'users||1'
    `);
    expect(
      await readListQueryItemPayloadSnapshot({
        id: 1,
        mockAdapter,
        sessionKey,
        storeName,
        tableId: 'users',
      }),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Cached user'
    `);
    expect(
      await readListQueryQueryNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        {tableId:"users"}:
          a: 1735689600000
          p: { tableId: 'users' }
    `);
    expect(
      await readListQueryQueryPayloadSnapshot({
        mockAdapter,
        params: usersQuery,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('when maxItems limit is reached the flush trims items inline by recency without touching cold queries', async () => {
    const storeName = 'lq-item-metadata';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Oldest cached',
    });
    await advanceTime(100);
    listQueryScope.listQuery.seedItem('users', 2, {
      id: 2,
      name: 'Newer cached',
    });
    listQueryScope.listQuery.seedQuery({ tableId: 'users' }, [
      storeItemKey('users', 1),
      storeItemKey('users', 2),
    ]);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      maxItemBytes: Math.max(
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes(rawItemPayload('users', 1), {
            id: 1,
            name: 'Oldest cached',
          }),
          getAsyncListItemEntrySizeBytes(rawItemPayload('users', 2), {
            id: 2,
            name: 'Newer cached',
          }),
        ),
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes(rawItemPayload('users', 2), {
            id: 2,
            name: 'Newer cached',
          }),
          getAsyncListItemEntrySizeBytes(rawItemPayload('users', 3), {
            id: 3,
            name: 'Fresh',
          }),
        ),
      ),
    });

    // Drain the startup cleanup before capturing the maxItems flush.
    await settleStartupBackgroundScan(mockAdapter);

    // Adding a third item should snapshot the inline trim end-to-end.
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.addItemToState(rawItemPayload('users', 3), {
      id: 3,
      name: 'Fresh',
    });
    await advanceTime(1100);
    await settleIndexedDbStorage();
    const operationsBreakdown = readCapture.finish().timelineString;
    await settleIndexedDbStorage();

    expect(
      (await listQueryScope.listQuery.listStoredItemKeys()).sort(),
    ).toMatchInlineSnapshot(`['"users||2', '"users||3']`);
    expect(operationsBreakdown).not.toContain(
      'commit scope=["sess1","lq-item-metadata","listQuery.query"]',
    );
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      1s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-item-metadata","listQuery.item"] order=lru-desc -> ["\\"users||2", "\\"users||1"]
      1s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-item-metadata","listQuery.query"] order=lru-desc -> ["{tableId:\\"users\\"}"]
      1.04s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-item-metadata","listQuery.item"] put=["\\"users||3"] delete=["\\"users||1"] touch=[] static-policy
      ""
    `);
  });

  test('maxItems-triggered flush re-evaluates mixed standalone and query-backed items using persisted recency', async () => {
    const expiredTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const storeName = 'lq-expired-during-max-items';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const adminsQuery = { tableId: 'admins' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);
    const env = createListQueryEnv({
      storeName,
      sessionKey,
      maxItemBytes: sumPersistedEntryBytes(
        getAsyncListItemEntrySizeBytes(rawItemPayload('standalone', 1), {
          id: 1,
          name: 'Expired oldest',
        }),
        getAsyncListItemEntrySizeBytes(rawItemPayload('admins', 4), {
          id: 4,
          name: 'Second referenced fresh',
        }),
      ),
      serverData: {
        users: [{ id: 3, name: 'Referenced fresh' }],
        admins: [{ id: 4, name: 'Second referenced fresh' }],
      },
    });

    // Drain startup cleanup first so the later item removals are attributable to the maxItems path.
    await settleStartupBackgroundScan(mockAdapter);

    // Persist two standalone items that will later look expired to the cleanup pass.
    env.apiStore.addItemToState(rawItemPayload('standalone', 1), {
      id: 1,
      name: 'Expired oldest',
    });
    await advanceTime(1100);
    await settleIndexedDbStorage();

    await advanceTime(100);
    env.apiStore.addItemToState(rawItemPayload('standalone', 2), {
      id: 2,
      name: 'Expired newer',
    });
    await advanceTime(1100);
    await settleIndexedDbStorage();

    // Persist one query-backed item before introducing a second query-backed item.
    env.scheduleFetch('highPriority', usersQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();

    // Backdate the standalone entries so the later maxItems cleanup sees them as stale persisted candidates.
    mockAdapter.setMetadata(
      listQueryScope.listQuery.itemStorageKey('standalone', 1),
      {
        ...(await mockAdapter.readMetadata(
          listQueryScope.listQuery.itemStorageKey('standalone', 1),
        )),
        lastAccessAt: expiredTimestamp,
      },
    );
    mockAdapter.setMetadata(
      listQueryScope.listQuery.itemStorageKey('standalone', 2),
      {
        ...(await mockAdapter.readMetadata(
          listQueryScope.listQuery.itemStorageKey('standalone', 2),
        )),
        lastAccessAt: expiredTimestamp,
      },
    );
    await settleIndexedDbStorage();

    // Fetching a second query-backed item should re-run the inline trim using the
    // persisted timestamps from the earlier writes.
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    env.scheduleFetch('highPriority', adminsQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      (await listQueryScope.listQuery.listStoredItemKeys()).sort(),
    ).toMatchInlineSnapshot(`['"admins||4', '"standalone||2']`);
    expect(
      await readListQueryItemNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        "admins||4: { a: 1735689610219, p: 'admins||4' }
        "standalone||2: { a: 1735689610219, p: 'standalone||2' }

      staticPolicy: { b: 147 }
    `);
    expect(
      await readListQueryQueryNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        {tableId:"admins"}:
          a: 1735689610173
          p: { tableId: 'admins' }
        {tableId:"users"}:
          a: 1735689607155
          p: { tableId: 'users' }
    `);
    expect(
      await readListQueryQueryPayloadSnapshot({
        mockAdapter,
        params: usersQuery,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`['"users||3']`);
    expect(
      await readListQueryQueryPayloadSnapshot({
        mockAdapter,
        params: adminsQuery,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`['"admins||4']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      1.812s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-expired-during-max-items","listQuery.query"] order=lru-desc -> ["{tableId:\\"users\\"}"]
      1.816s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-expired-during-max-items","listQuery.item"] order=lru-desc -> ["\\"users||3", "\\"standalone||1"]
      1.862s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-expired-during-max-items","listQuery.query"] put=["{tableId:\\"admins\\"}"] delete=[] touch=[] static-policy
      1.914s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-expired-during-max-items","listQuery.item"] put=["\\"admins||4", "\\"standalone||2"] delete=["\\"standalone||1", "\\"users||3"] touch=[] static-policy
      ""
    `);

    expect(await getIndexedDbStructureSnapshot(mockAdapter))
      .toMatchInlineSnapshot(`
        stores:
          - autoIncrement: '❌'
            indexes:
              - keyPath: ['i', 'g']
                multiEntry: '❌'
                name: 'byScopeGroup'
                unique: '❌'
              - keyPath: ['i', 'a']
                multiEntry: '❌'
                name: 'byScopeLastAccessAt'
                unique: '❌'
              - keyPath: ['i', 'o']
                multiEntry: '❌'
                name: 'byScopeOfflineProtected'
                unique: '❌'
            keyPath: null
            name: 'entries'
            rowCount: 4
            rows:
              - key: ['["sess1","lq-expired-during-max-items","li"]', '"admins||4']
                value: 'JSON object | 0.3 kb'
              - key: ['["sess1","lq-expired-during-max-items","li"]', '"standalone||2']
                value: 'JSON object | 0.3 kb'
              - key: ['["sess1","lq-expired-during-max-items","lq"]', '{tableId:"admins"}']
                value: 'JSON object | 0.3 kb'
              - key: ['["sess1","lq-expired-during-max-items","lq"]', '{tableId:"users"}']
                value: 'JSON object | 0.2 kb'
          - autoIncrement: '❌'
            indexes: []
            keyPath: 'k'
            name: 'meta'
            rowCount: 0
            rows: []
          - autoIncrement: '❌'
            indexes:
              - { keyPath: 's', multiEntry: '❌', name: 'bySession', unique: '❌' }
            keyPath: null
            name: 'namespacePolicies'
            rowCount: 2
            rows:
              - key: ['sess1', 'lq-expired-during-max-items', 'li']
                value: 'JSON object | 0.1 kb'
              - key: ['sess1', 'lq-expired-during-max-items', 'lq']
                value: 'JSON object | 0.0 kb'
        version: 1
      `);
  });

  test('item flush preserves fresh standalone entries that were persisted before the store noticed them', async () => {
    const storeName = 'lq-fresh-standalone-before-visible';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);
    const env = createListQueryEnv({
      storeName,
      sessionKey,
      maxItemBytes: sumPersistedEntryBytes(
        getAsyncListItemEntrySizeBytes(rawItemPayload('standalone', 1), {
          id: 1,
          name: 'Fresh standalone one',
        }),
        getAsyncListItemEntrySizeBytes(rawItemPayload('standalone', 2), {
          id: 2,
          name: 'Fresh standalone two',
        }),
        getAsyncListItemEntrySizeBytes(rawItemPayload('users', 3), {
          id: 3,
          name: 'Referenced fresh',
        }),
      ),
      serverData: { users: [{ id: 3, name: 'Referenced fresh' }] },
    });

    // Drain startup cleanup first so the later flush only reflects the item commit path.
    await settleStartupBackgroundScan(mockAdapter);

    // Seed fresh standalone entries after mount to simulate persistence created
    // outside the current in-memory session.
    listQueryScope.listQuery.seedItem('standalone', 1, {
      id: 1,
      name: 'Fresh standalone one',
    });
    await advanceTime(100);
    listQueryScope.listQuery.seedItem('standalone', 2, {
      id: 2,
      name: 'Fresh standalone two',
    });

    env.scheduleFetch('highPriority', usersQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();

    expect((await listQueryScope.listQuery.listStoredItemKeys()).sort())
      .toMatchInlineSnapshot(`
        ['"standalone||1', '"standalone||2', '"users||3']
      `);
  });

  test('maxItems startup cleanup falls back to protected pinned and recency for preloaded query items', async () => {
    const storeName = 'lq-shared-item-cleanup';
    const sessionKey = 'sess1';
    const firstUsersQuery = {
      tableId: 'users',
      filters: [{ field: 'name', op: 'eq', value: 'Alice' }],
    } satisfies ListQueryParams;
    const secondUsersQuery = {
      tableId: 'users',
      filters: [{ field: 'name', op: 'eq', value: 'Bob' }],
    } satisfies ListQueryParams;
    const sharedItemKey = storeItemKey('users', 1);
    const aliceOnlyItemKey = storeItemKey('users', 2);
    const bobOnlyItemKey = storeItemKey('users', 3);
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    // Seed two persisted queries that both reference the same oldest item.
    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Shared oldest',
    });
    await advanceTime(100);
    listQueryScope.listQuery.seedItem('users', 2, {
      id: 2,
      name: 'Alice only',
    });
    await advanceTime(100);
    listQueryScope.listQuery.seedItem('users', 3, { id: 3, name: 'Bob only' });
    await advanceTime(100);
    listQueryScope.listQuery.seedItem('users', 4, {
      id: 4,
      name: 'Standalone newest',
    });
    listQueryScope.listQuery.seedQuery(firstUsersQuery, [
      sharedItemKey,
      aliceOnlyItemKey,
    ]);
    listQueryScope.listQuery.seedQuery(secondUsersQuery, [
      sharedItemKey,
      bobOnlyItemKey,
    ]);
    listQueryScope.listQuery.setItemStaticPolicy({
      b: sumPersistedEntryBytes(
        getAsyncListItemEntrySizeBytes(rawItemPayload('users', 2), {
          id: 2,
          name: 'Alice only',
        }),
        getAsyncListItemEntrySizeBytes(rawItemPayload('users', 3), {
          id: 3,
          name: 'Bob only',
        }),
        getAsyncListItemEntrySizeBytes(rawItemPayload('users', 4), {
          id: 4,
          name: 'Standalone newest',
        }),
      ),
    });
    createDocumentEnv({ storeName: 'trigger-doc', sessionKey });

    // Let the startup-scheduled maintenance enforce maxItems against the preloaded cache.
    const cleanupCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const cleanupOperations = cleanupCapture.finish().timelineString;

    // The oldest item should be evicted by recency, while the persisted query
    // payloads stay untouched and rely on later hydration to filter the missing item.
    expect(
      (await listQueryScope.listQuery.listStoredItemKeys()).sort(),
    ).toMatchInlineSnapshot(`['"users||2', '"users||3', '"users||4']`);
    expect(
      await readListQueryQueryNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        {filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}:
          a: 1735689600300
          p:
            filters:
              - { field: 'name', op: 'eq', value: 'Alice' }
            tableId: 'users'
        {filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}:
          a: 1735689600300
          p:
            filters:
              - { field: 'name', op: 'eq', value: 'Bob' }
            tableId: 'users'
    `);
    expect(
      await readListQueryQueryPayloadSnapshot({
        mockAdapter,
        params: firstUsersQuery,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);
    expect(
      await readListQueryQueryPayloadSnapshot({
        mockAdapter,
        params: secondUsersQuery,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`['"users||1', '"users||3']`);
    expect(cleanupOperations).not.toContain('entries.getMany');
    expect(cleanupOperations).toMatchInlineSnapshot(`
      ""
      2.013s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-shared-item-cleanup","listQuery.item"], ["sess1","lq-shared-item-cleanup","listQuery.query"]]
      2.018s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-shared-item-cleanup","listQuery.query"] -> keys=2 exists=yes valid=yes
      2.02s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-shared-item-cleanup","listQuery.item"] -> keys=4 exists=yes valid=yes
      2.023s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","lq-shared-item-cleanup","listQuery.item"] keys=["\\"users||1"]
      2.032s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","lq-shared-item-cleanup","listQuery.item"] keys=3 static-policy
      ""
    `);
  });

  test('deleteItemState removes the persisted list item and rewrites related query and item entries', async () => {
    const storeName = 'lq-delete-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const filteredUsersQuery = {
      tableId: 'users',
      filters: [{ field: 'name', op: 'eq', value: 'Alice' }],
    } satisfies ListQueryParams;
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);
    const deletedItemStorageKey = listQueryScope.listQuery.itemStorageKey(
      'users',
      1,
    );

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      },
    });

    env.scheduleFetch('highPriority', usersQuery);
    env.scheduleFetch('highPriority', filteredUsersQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();

    // Capture the explicit delete path after the initial query+item persistence has settled.
    env.apiStore.deleteItemState('users||1');
    await advanceTime(1100);
    await settleIndexedDbStorage();

    expect(await mockAdapter.has(deletedItemStorageKey)).toBe(false);
    expect(
      (await listQueryScope.listQuery.listStoredItemKeys()).sort(),
    ).toMatchInlineSnapshot(`['"users||2']`);
    const queryNamespaceSnapshot = await readListQueryQueryNamespaceSnapshot({
      mockAdapter,
      sessionKey,
      storeName,
    });
    expect(
      queryNamespaceSnapshot && {
        ...queryNamespaceSnapshot,
        entries: Object.fromEntries(
          Object.entries(queryNamespaceSnapshot.entries).map(([key, entry]) => [
            key,
            { ...entry, a: '<timestamp>' },
          ]),
        ),
      },
    ).toMatchInlineSnapshot(`
      entries:
        {filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}:
          a: '<timestamp>'
          p:
            filters:
              - { field: 'name', op: 'eq', value: 'Alice' }
            tableId: 'users'
        {tableId:"users"}:
          a: '<timestamp>'
          p: { tableId: 'users' }
    `);
    expect(
      await readListQueryQueryPayloadSnapshot({
        mockAdapter,
        params: usersQuery,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`['"users||2']`);
    expect(
      await readListQueryQueryPayloadSnapshot({
        mockAdapter,
        params: filteredUsersQuery,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('deleteItemState removes a cold persisted item without hydrating it first', async () => {
    const storeName = 'lq-cold-delete-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);
    const deletedItemStorageKey = listQueryScope.listQuery.itemStorageKey(
      'users',
      1,
    );

    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user',
    });

    const env = createListQueryEnv({ storeName, sessionKey });

    // Let the startup scan settle so the captured delete path only reflects the explicit flush.
    await settleStartupBackgroundScan(mockAdapter);

    // Deleting a cold standalone item should consult only the persisted namespace state and
    // remove the row directly, without hydrating the cached item into memory first.
    const deleteCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.deleteItemState('users||1');
    await advanceTime(1100);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();
    const {
      operations: deleteOperationLabels,
      timelineString: deleteOperations,
    } = deleteCapture.finish();

    expect(await mockAdapter.has(deletedItemStorageKey)).toBe(false);
    expect(
      await listQueryScope.listQuery.listStoredItemKeys(),
    ).toMatchInlineSnapshot(`[]`);
    expect(
      deleteOperationLabels.filter(
        (label) =>
          label.startsWith('📖') && label.includes(deletedItemStorageKey),
      ),
    ).toMatchInlineSnapshot(`[]`);
    expect(deleteOperations).toContain(
      'entries.byScopeLastAccessAt scope=["sess1","lq-cold-delete-flow","listQuery.item"] order=lru-desc -> ["\\"users||1"]',
    );
    expect(deleteOperations).toContain(
      'commit scope=["sess1","lq-cold-delete-flow","listQuery.item"] put=[] delete=["\\"users||1"] touch=[] static-policy',
    );
    expect(deleteOperations).toMatchInlineSnapshot(`
      ""
      1s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-cold-delete-flow","listQuery.item"] order=lru-desc -> ["\\"users||1"]
      1s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-cold-delete-flow","listQuery.query"] order=lru-desc -> []
      1.04s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-cold-delete-flow","listQuery.item"] put=[] delete=["\\"users||1"] touch=[] static-policy
      ""
    `);
  });

  test('preloadQueryFromStorage hydrates the cached list query once and keeps later preloads and direct reads in memory', async () => {
    const storeName = 'lq-preload-query-state';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user',
    });
    listQueryScope.listQuery.seedQuery(usersQuery, [storeItemKey('users', 1)]);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture only measures explicit preload behavior.
    await settleStartupBackgroundScan(mockAdapter);

    // Preload should materialize both the cached query and its referenced item through the async path.
    const preloadCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    expect(
      await resolveAfterIndexedDbStorage(
        env.apiStore.preloadQueryFromStorage(usersQuery),
        mockAdapter,
      ),
    ).toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);
    expect(preloadCapture.finish().timelineString).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","lq-preload-query-state","listQuery.query"] keys=["{tableId:\\"users\\"}"] -> ["{tableId:\\"users\\"}"]
      3ms | 📖 entries.getMany scope=["sess1","lq-preload-query-state","listQuery.item"] keys=["\\"users||1"] -> ["\\"users||1"]
      ""
    `);

    // Once preloaded, repeated explicit preload calls should reuse in-memory state without new storage work.
    const repeatedPreloadCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    expect(
      await resolveAfterIndexedDbStorage(
        env.apiStore.preloadQueryFromStorage(usersQuery),
        mockAdapter,
      ),
    ).toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);
    await advanceTime(100);
    expect(
      await resolveAfterIndexedDbStorage(
        env.apiStore.preloadQueryFromStorage(usersQuery),
        mockAdapter,
      ),
    ).toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);
    await advanceTime(100);
    expect(
      await resolveAfterIndexedDbStorage(
        env.apiStore.preloadQueryFromStorage(usersQuery),
        mockAdapter,
      ),
    ).toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);
    expect(
      repeatedPreloadCapture.finish().timelineString,
    ).toMatchInlineSnapshot(`"empty"`);

    // Repeated direct reads should also reuse in-memory query and item state without new storage work.
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    expect(env.apiStore.getQueryState(usersQuery)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1']
      payload: { tableId: 'users' }
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);
    await advanceTime(100);
    expect(env.apiStore.getQueryState(usersQuery)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1']
      payload: { tableId: 'users' }
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);
    await advanceTime(100);
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
    await settleIndexedDbStorage();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(operationsBreakdown).toMatchInlineSnapshot(`"empty"`);
  });

  test('preloadItemFromStorage hydrates the cached standalone list-query item once and keeps later preloads and direct reads in memory', async () => {
    const storeName = 'lq-preload-item-state';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user',
    });
    listQueryScope.listQuery.seedItem('users', 2, {
      id: 2,
      name: 'Another cached user',
    });

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture only measures explicit preload behavior.
    await settleStartupBackgroundScan(mockAdapter);

    // Preload should materialize the cached item into store state through the async path.
    const preloadCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    expect(
      await resolveAfterIndexedDbStorage(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 1)),
        mockAdapter,
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||1', preloaded: '✅' }`);
    expect(
      await resolveAfterIndexedDbStorage(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 2)),
        mockAdapter,
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||2', preloaded: '✅' }`);
    expect(preloadCapture.finish().timelineString).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","lq-preload-item-state","listQuery.item"] keys=["\\"users||1"] -> ["\\"users||1"]
      3ms | 📖 entries.getMany scope=["sess1","lq-preload-item-state","listQuery.item"] keys=["\\"users||2"] -> ["\\"users||2"]
      ""
    `);

    // Once preloaded, repeated explicit preload calls should reuse in-memory state without new storage work.
    const repeatedPreloadCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    expect(
      await resolveAfterIndexedDbStorage(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 1)),
        mockAdapter,
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||1', preloaded: '✅' }`);
    await advanceTime(100);
    expect(
      await resolveAfterIndexedDbStorage(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 1)),
        mockAdapter,
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||1', preloaded: '✅' }`);
    await advanceTime(100);
    expect(
      await resolveAfterIndexedDbStorage(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 1)),
        mockAdapter,
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||1', preloaded: '✅' }`);
    expect(
      repeatedPreloadCapture.finish().timelineString,
    ).toMatchInlineSnapshot(`"empty"`);

    // Repeated direct reads should also reuse in-memory state without new storage work.
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    expect(env.apiStore.getItemState(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached user'
      `);
    await advanceTime(100);
    expect(env.apiStore.getItemState(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached user'
      `);
    await advanceTime(100);
    expect(env.apiStore.getItemState(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached user'
      `);
    await settleIndexedDbStorage();
    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(
      `"empty"`,
    );
  });

  test('useListQuery invalidation snapshots the full query persistence timeline through the refetch save', async () => {
    const storeName = 'lq-query-invalidation-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user',
    });
    listQueryScope.listQuery.seedQuery(usersQuery, [storeItemKey('users', 1)]);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Fresh user' }] },
    });

    // Hydrate cached data first without a mount refetch so the invalidation path stays isolated.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Update the server copy, invalidate the mounted query, then capture fetch completion plus the debounced save.
    const invalidationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.updateItem('users||1', { name: 'Fresh user' });
      env.apiStore.invalidateQueryAndItems({
        queryPayload: usersQuery,
        itemPayload: false,
      });
    });
    await flushInvalidationPersistence();
    const invalidationOperations = invalidationCapture.finish().timelineString;

    expect(hook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Fresh user' }`,
    );
    expect(
      await readListQueryQueryNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        {tableId:"users"}:
          a: 1735689600000
          p: { tableId: 'users' }
    `);
    expect(
      await readListQueryQueryPayloadSnapshot({
        mockAdapter,
        params: usersQuery,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`['"users||1']`);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      ""
      1.812s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-query-invalidation-flow","listQuery.item"] order=lru-desc -> ["\\"users||1"]
      1.815s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-query-invalidation-flow","listQuery.query"] order=lru-desc -> ["{tableId:\\"users\\"}"]
      1.861s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-query-invalidation-flow","listQuery.item"] put=["\\"users||1"] delete=[] touch=[] static-policy
      ""
    `);
  });

  test('repeated invalidations within the debounce window coalesce list-query persistence writes', async () => {
    const storeName = 'lq-coalesced-invalidations';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user',
    });
    listQueryScope.listQuery.seedQuery(usersQuery, [storeItemKey('users', 1)]);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Fresh user 1' }] },
    });

    // Hydrate cached data first so only the invalidation writes are counted below.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Let the first refetch finish, but stay inside the debounced persistence window.
    const firstInvalidationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.updateItem('users||1', { name: 'Fresh user 1' });
      env.apiStore.invalidateQueryAndItems({
        queryPayload: usersQuery,
        itemPayload: false,
      });
    });
    await advanceTime(900);
    const firstInvalidationOperations =
      firstInvalidationCapture.finish().timelineString;

    expect(hook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Fresh user 1' }`,
    );
    expect(firstInvalidationOperations).toMatchInlineSnapshot(`"empty"`);

    // A second invalidation before the first debounce flush should replace the pending save.
    const secondInvalidationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.updateItem('users||1', { name: 'Fresh user 2' });
      env.apiStore.invalidateQueryAndItems({
        queryPayload: usersQuery,
        itemPayload: false,
      });
    });
    await advanceTime(1900);
    await settleIndexedDbStorage();
    const secondInvalidationOperations =
      secondInvalidationCapture.finish().timelineString;

    expect(hook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Fresh user 2' }`,
    );
    expect(
      await readListQueryItemPayloadSnapshot({
        id: 1,
        mockAdapter,
        sessionKey,
        storeName,
        tableId: 'users',
      }),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Fresh user 2'
    `);
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      ""
      1.81s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-coalesced-invalidations","listQuery.item"] order=lru-desc -> ["\\"users||1"]
      1.81s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-coalesced-invalidations","listQuery.query"] order=lru-desc -> ["{tableId:\\"users\\"}"]
      1.85s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-coalesced-invalidations","listQuery.item"] put=["\\"users||1"] delete=[] touch=[] static-policy
      ""
    `);
  });

  test('list-query invalidation preserves offline markers added by another tab before item and query manifest updates', async () => {
    const storeName = 'lq-offline-marker-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);
    const itemStorageKey = listQueryScope.listQuery.itemStorageKey('users', 1);
    const queryStorageKey =
      listQueryScope.listQuery.queryStorageKey(usersQuery);

    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user',
    });
    listQueryScope.listQuery.seedQuery(usersQuery, [storeItemKey('users', 1)]);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: {
        users: [
          { id: 1, name: 'Fresh user' },
          { id: 2, name: 'Second user' },
        ],
      },
    });

    // Hydrate cached data first so the later save is a normal invalidation write.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Simulate another tab marking the existing item and query entries as offline-protected.
    setProtectedKeysSnapshot(sessionKey, [itemStorageKey, queryStorageKey]);

    // The refetch rewrites both namespaces, and should keep the externally-added markers.
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: usersQuery,
        itemPayload: false,
      });
    });
    await flushInvalidationPersistence();

    expect(hook.result.current.items).toMatchInlineSnapshot(`
      - { id: 1, name: 'Fresh user' }
      - { id: 2, name: 'Second user' }
    `);
    expect(
      await readListQueryItemNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        "users||1:
          a: 1735689600000
          f: ['age', 'email', 'id', 'name']
          o: '✅'
          p: 'users||1'
        "users||2: { a: 1735689607006, p: 'users||2' }
    `);
    expect(
      await readListQueryItemPayloadSnapshot({
        id: 1,
        mockAdapter,
        sessionKey,
        storeName,
        tableId: 'users',
      }),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Fresh user'
    `);
    expect(
      await readListQueryQueryNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        {tableId:"users"}:
          a: 1735689600000
          o: '✅'
          p: { tableId: 'users' }
    `);
    expect(
      await readListQueryQueryPayloadSnapshot({
        mockAdapter,
        params: usersQuery,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);
  });

  test('query hook remount skips touch writes when the cached query and item are still in the current recency bucket', async () => {
    const storeName = 'lq-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    // Seed both entries with the current fake time so hydration should treat them
    // as fresh and skip the follow-up metadata touches.
    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user',
    });
    listQueryScope.listQuery.seedQuery(usersQuery, [storeItemKey('users', 1)]);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted query flow.
    await settleStartupBackgroundScan(mockAdapter);

    // The first mount hydrates the cold query and its item from persistence, but
    // because both entries are still in the current recency bucket no touch write
    // should be scheduled after the reads complete.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        render: () =>
          env.apiStore.useListQuery(usersQuery, {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
      });

    expect(secondHook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Cached user' }`,
    );
    // The snapshot ends after the initial query+item reads, which makes the
    // skipped touches explicit for both entries.
    expect(firstMountOperations).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","lq-remount-flow","listQuery.query"] keys=["{tableId:\\"users\\"}"] -> ["{tableId:\\"users\\"}"]
      2ms | 📖 entries.getMany scope=["sess1","lq-remount-flow","listQuery.item"] keys=["\\"users||1"] -> ["\\"users||1"]
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('query hook remount reuses a persisted empty query without treating it as a cache miss', async () => {
    const storeName = 'lq-empty-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    // Persist an explicit empty query so this is an empty-cache remount, not a
    // missing-cache remount.
    listQueryScope.listQuery.seedQuery(usersQuery, []);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted query flow.
    await settleStartupBackgroundScan(mockAdapter);

    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        render: () =>
          env.apiStore.useListQuery(usersQuery, {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
      });

    expect(secondHook.result.current.items).toMatchInlineSnapshot(`[]`);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","lq-empty-remount-flow","listQuery.query"] keys=["{tableId:\\"users\\"}"] -> ["{tableId:\\"users\\"}"]
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('query hydration does not skip stale query and item touches once they fall outside the current recency bucket', async () => {
    const storeName = 'lq-remount-stale-touch';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedItem(
      'users',
      1,
      { id: 1, name: 'Cached user' },
      { timestamp: Date.now() - 7 * 60 * 60 * 1000 },
    );
    listQueryScope.listQuery.seedQuery(usersQuery, [storeItemKey('users', 1)], {
      timestamp: Date.now() - 7 * 60 * 60 * 1000,
    });

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so this capture isolates the mounted hydration flow.
    await settleStartupBackgroundScan(mockAdapter);

    // Both entries are older than the current recency bucket, so hydration should
    // reread metadata and then write the touched timestamps back.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        render: () =>
          env.apiStore.useListQuery(usersQuery, {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
      });

    expect(secondHook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Cached user' }`,
    );
    expect(firstMountOperations).toContain(
      'entries.getMany scope=["sess1","lq-remount-stale-touch","listQuery.query"] keys=["{tableId:\\"users\\"}"] -> ["{tableId:\\"users\\"}"]',
    );
    expect(firstMountOperations).toContain(
      'commit scope=["sess1","lq-remount-stale-touch","listQuery.query"] put=[] delete=[] touch=["{tableId:\\"users\\"}"]',
    );
    expect(firstMountOperations).toContain(
      'entries.getMany scope=["sess1","lq-remount-stale-touch","listQuery.item"] keys=["\\"users||1"] -> ["\\"users||1"]',
    );
    expect(firstMountOperations).toContain(
      'commit scope=["sess1","lq-remount-stale-touch","listQuery.item"] put=[] delete=[] touch=["\\"users||1"]',
    );
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useItem invalidation snapshots the full item persistence timeline through the refetch save', async () => {
    const storeName = 'lq-item-invalidation-flow';
    const sessionKey = 'sess1';
    const itemPayload = rawItemPayload('users', 1);
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user',
    });

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Fresh user' }] },
    });

    // Hydrate cached data first without a mount refetch so the invalidation path stays isolated.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useItem(itemPayload, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Update the server copy, invalidate the mounted item hook, then capture fetch completion plus the debounced save.
    const invalidationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.updateItem('users||1', { name: 'Fresh user' });
      env.apiStore.invalidateItem(itemPayload);
    });
    await flushInvalidationPersistence();
    const invalidationOperations = invalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(`
      id: 1
      name: 'Fresh user'
    `);
    expect(
      await readListQueryItemPayloadSnapshot({
        id: 1,
        mockAdapter,
        sessionKey,
        storeName,
        tableId: 'users',
      }),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Fresh user'
    `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      ""
      1.812s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-item-invalidation-flow","listQuery.item"] order=lru-desc -> ["\\"users||1"]
      1.814s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-item-invalidation-flow","listQuery.query"] order=lru-desc -> []
      1.86s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-item-invalidation-flow","listQuery.item"] put=["\\"users||1"] delete=[] touch=[] static-policy
      ""
    `);
  });

  test('item hook remount skips the touch write when the cached standalone item is still in the current recency bucket', async () => {
    const storeName = 'lq-item-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    // Seed with the current fake time so hydration should treat the entry as fresh
    // and skip the follow-up metadata touch.
    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user',
    });

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted item flow.
    await settleStartupBackgroundScan(mockAdapter);

    // The first mount must hydrate the cold cached item from persistence,
    // but because the entry is still in the current recency bucket no touch write
    // should be scheduled after the read completes.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        render: () =>
          env.apiStore.useItem(rawItemPayload('users', 1), {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
      });

    expect(secondHook.result.current.data).toMatchInlineSnapshot(`
      id: 1
      name: 'Cached user'
    `);
    // The snapshot ends after the initial entry data+metadata reads, which makes the
    // skipped touch explicit.
    expect(firstMountOperations).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","lq-item-remount-flow","listQuery.item"] keys=["\\"users||1"] -> ["\\"users||1"]
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useMultipleItems remount reuses hydrated standalone list-query items without touching localStorage again', async () => {
    const storeName = 'lq-multi-item-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user 1',
    });
    listQueryScope.listQuery.seedItem('users', 2, {
      id: 2,
      name: 'Cached user 2',
    });

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted item flow.
    await settleStartupBackgroundScan(mockAdapter);

    // The first mount must hydrate both cold cached items from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        render: () =>
          env.apiStore.useMultipleItems(
            [
              { payload: rawItemPayload('users', 1) },
              { payload: rawItemPayload('users', 2) },
            ],
            { disableRefetchOnMount: true, returnRefetchingStatus: true },
          ),
      });

    expect(secondHook.result.current.map((item) => item.data))
      .toMatchInlineSnapshot(`
        - { id: 1, name: 'Cached user 1' }
        - { id: 2, name: 'Cached user 2' }
      `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      ""
      2ms | 📖 entries.getMany scope=["sess1","lq-multi-item-remount-flow","listQuery.item"] keys=["\\"users||1", "\\"users||2"] -> ["\\"users||1", "\\"users||2"]
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useMultipleListQueries remount reuses hydrated queries without touching localStorage again', async () => {
    const storeName = 'lq-multi-query-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore({});
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user',
    });
    listQueryScope.listQuery.seedItem('projects', 1, {
      id: 1,
      name: 'Cached project',
    });
    listQueryScope.listQuery.seedQuery(usersQuery, [storeItemKey('users', 1)]);
    listQueryScope.listQuery.seedQuery(projectsQuery, [
      storeItemKey('projects', 1),
    ]);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted query flow.
    await settleStartupBackgroundScan(mockAdapter);

    // The first mount must hydrate both cold cached queries and their items from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        render: () =>
          env.apiStore.useMultipleListQueries(
            [{ payload: usersQuery }, { payload: projectsQuery }],
            { disableRefetchOnMount: true, returnRefetchingStatus: true },
          ),
      });

    expect(
      secondHook.result.current.map((query) =>
        query.items.map((item) => item.name),
      ),
    ).toMatchInlineSnapshot(`
      - ['Cached user']
      - ['Cached project']
    `);
    // The exact gap between the two hydrated queries can vary with queued task
    // draining, but the first mount must still hydrate both query rows and both
    // item rows before the remount goes fully hot.
    expect(stripTimelineDurations(firstMountOperations)).toMatchInlineSnapshot(`
      ""
      | 📖 entries.getMany scope=["sess1","lq-multi-query-remount-flow","listQuery.query"] keys=["{tableId:\\"users\\"}"] -> ["{tableId:\\"users\\"}"]
      | 📖 entries.getMany scope=["sess1","lq-multi-query-remount-flow","listQuery.item"] keys=["\\"users||1"] -> ["\\"users||1"]
      | 📖 entries.getMany scope=["sess1","lq-multi-query-remount-flow","listQuery.query"] keys=["{tableId:\\"projects\\"}"] -> ["{tableId:\\"projects\\"}"]
      | 📖 entries.getMany scope=["sess1","lq-multi-query-remount-flow","listQuery.item"] keys=["\\"projects||1"] -> ["\\"projects||1"]
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('updating a hydrated list-query item writes the mutation without rereading cached entries', async () => {
    const storeName = 'lq-mutation-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore({});
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user',
    });
    listQueryScope.listQuery.seedQuery(usersQuery, [storeItemKey('users', 1)]);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Hydrate the cached query through a normal mounted component first.
    await settleStartupBackgroundScan(mockAdapter);
    renderHook(() =>
      env.apiStore.useListQuery(usersQuery, { disableRefetchOnMount: true }),
    );
    await settleIndexedDbStorage();
    await waitForHookValue(
      () => env.apiStore.getItemState(rawItemPayload('users', 1)),
      (item) => item?.name === 'Cached user',
    );

    // Mutating the already-hydrated item should only need writes.
    const mutationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.apiStore.updateItemState(rawItemPayload('users', 1), (draft) => {
        draft.name = 'Edited user';
      });
    });
    await advanceTime(1100);
    await settleIndexedDbStorage();
    await waitForHookValue(
      () => env.apiStore.getItemState(rawItemPayload('users', 1)),
      (item) => item?.name === 'Edited user',
    );
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(env.apiStore.getItemState(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Edited user'
      `);
    expect(
      await readListQueryItemPayloadSnapshot({
        id: 1,
        mockAdapter,
        sessionKey,
        storeName,
        tableId: 'users',
      }),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Edited user'
    `);
    expect(
      await readListQueryItemNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        "users||1:
          a: 1735689600000
          f: ['age', 'email', 'id', 'name']
          p: 'users||1'
    `);
    expect(mutationOperations).toContain(
      'commit scope=["sess1","lq-mutation-flow","listQuery.item"] put=["\\"users||1"] delete=[] touch=[] static-policy',
    );
    expect(mutationOperations).not.toContain('entries.getMany');
  });

  test('list query preload reads only the requested query and its referenced items', async () => {
    const storeName = 'list-query-opfs-efficiency';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore({
      initialState: {
        storeName,
        sessionKey,
        listQuery: {
          items: [
            { tableId: 'users', id: 1, data: { id: 1, name: 'User 1' } },
            { tableId: 'users', id: 2, data: { id: 2, name: 'User 2' } },
            { tableId: 'projects', id: 1, data: { id: 1, name: 'Project 1' } },
          ],
          queries: [
            {
              params: usersQuery,
              items: [
                { tableId: 'users', id: 1 },
                { tableId: 'users', id: 2 },
              ],
            },
            { params: projectsQuery, items: [{ tableId: 'projects', id: 1 }] },
          ],
        },
      },
    });
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);
    const usersItemKey = listQueryScope.listQuery.itemStorageKey('users', 1);
    const usersSecondItemKey = listQueryScope.listQuery.itemStorageKey(
      'users',
      2,
    );
    const projectsItemKey = listQueryScope.listQuery.itemStorageKey(
      'projects',
      1,
    );
    const usersQueryKey = listQueryScope.listQuery.queryStorageKey(usersQuery);
    const projectsQueryKey =
      listQueryScope.listQuery.queryStorageKey(projectsQuery);
    const env = createListQueryEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await resolveAfterIndexedDbStorage(preloadPromise, mockAdapter);

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","list-query-opfs-efficiency","listQuery.query"] keys=["{tableId:\\"users\\"}"] -> ["{tableId:\\"users\\"}"]
      4ms | 📖 entries.getMany scope=["sess1","list-query-opfs-efficiency","listQuery.item"] keys=["\\"users||1", "\\"users||2"] -> ["\\"users||1", "\\"users||2"]
      ""
    `);

    expect(
      mockAdapter.payloadGetManyRequests.filter(
        (keys) =>
          keys.includes(usersItemKey) || keys.includes(usersSecondItemKey),
      ),
    ).toMatchInlineSnapshot(`
      - - 'tsdf.sess1.list-query-opfs-efficiency.li."users||1'
        - 'tsdf.sess1.list-query-opfs-efficiency.li."users||2'
    `);
    expect(mockAdapter.payloadGetRequests).toContain(usersQueryKey);
    expect(mockAdapter.payloadGetManyRequests.flat()).toContain(usersItemKey);
    expect(mockAdapter.payloadGetManyRequests.flat()).toContain(
      usersSecondItemKey,
    );
    expect(mockAdapter.payloadGetManyRequests.flat()).not.toContain(
      projectsQueryKey,
    );
    expect(mockAdapter.payloadGetManyRequests.flat()).not.toContain(
      projectsItemKey,
    );
  });

  test('list query eviction uses metadata scans without reading stored query or item entry data', async () => {
    const storeName = 'list-query-opfs-eviction-efficiency';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const tasksQuery = { tableId: 'tasks' };
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const env = createListQueryEnv({
      storeName,
      sessionKey,
      maxItemBytes: Math.max(
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes(rawItemPayload('users', 1), {
            id: 1,
            name: 'User 1',
          }),
          getAsyncListItemEntrySizeBytes(rawItemPayload('projects', 1), {
            id: 1,
            name: 'Project 1',
          }),
        ),
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes(rawItemPayload('projects', 1), {
            id: 1,
            name: 'Project 1',
          }),
          getAsyncListItemEntrySizeBytes(rawItemPayload('tasks', 1), {
            id: 1,
            name: 'Task 1',
          }),
        ),
      ),
      maxQueryBytes: Math.max(
        sumPersistedEntryBytes(
          getAsyncListQueryEntrySizeBytes(usersQuery, [
            storeItemKey('users', 1),
          ]),
          getAsyncListQueryEntrySizeBytes(projectsQuery, [
            storeItemKey('projects', 1),
          ]),
        ),
        sumPersistedEntryBytes(
          getAsyncListQueryEntrySizeBytes(projectsQuery, [
            storeItemKey('projects', 1),
          ]),
          getAsyncListQueryEntrySizeBytes(tasksQuery, [
            storeItemKey('tasks', 1),
          ]),
        ),
      ),
      serverData: {
        users: [{ id: 1, name: 'User 1' }],
        projects: [{ id: 1, name: 'Project 1' }],
        tasks: [{ id: 1, name: 'Task 1' }],
      },
    });

    await settleStartupBackgroundScan(mockAdapter);

    env.scheduleFetch('highPriority', usersQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();

    env.scheduleFetch('highPriority', projectsQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();
    mockAdapter.clearInstrumentation();
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);

    env.scheduleFetch('highPriority', tasksQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();

    const evictionOperations = readCapture.finish().timelineString;

    expect(evictionOperations).toContain(
      'entries.byScopeLastAccessAt scope=["sess1","list-query-opfs-eviction-efficiency","listQuery.query"] order=lru-desc -> ["{tableId:\\"projects\\"}", "{tableId:\\"users\\"}"]',
    );
    expect(evictionOperations).toContain(
      'commit scope=["sess1","list-query-opfs-eviction-efficiency","listQuery.item"]',
    );
    expect(evictionOperations).not.toContain('entries.getMany');
    expect(mockAdapter.payloadGetRequests).toMatchInlineSnapshot(`[]`);
    expect(mockAdapter.payloadGetManyRequests).toMatchInlineSnapshot(`[]`);
  });
});
