import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { getDefaultMaxBytesForScope } from '../../../src/persistentStorage/persistentStorageDefaults';
import type { ListQueryParams } from '../../mocks/listQueryStoreTestEnv';
import { advanceTime } from '../../utils/genericTestUtils';
import {
  getIndexedDbStructureSnapshot,
  getParsedIndexedDbRecordData,
  startIndexedDbPersistentStorageOperationCapture,
} from '../../utils/indexedDbPersistentStorageOptimizationTestUtils';
import { createIndexedDbPersistentStorageTestStore } from '../../utils/indexedDbPersistentStorageTestStore';
import {
  stripTimelineDurations,
  readListQueryItemNamespaceSnapshot,
  readListQueryQueryNamespaceSnapshot,
  readListQueryItemPayloadSnapshot,
  readListQueryQueryPayloadSnapshot,
} from './listQueryShared';
import {
  createDocumentEnv,
  createListQueryEnv,
  flushInvalidationPersistence,
  getAsyncListItemEntrySizeBytes,
  getAsyncListQueryEntrySizeBytes,
  rawItemPayload,
  settleIndexedDbStorage,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  storeItemKey,
  sumPersistedEntryBytes,
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
      12.009s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","list-query-expiration","listQuery.item"], ["sess1","list-query-expiration","listQuery.query"]]
      12.013s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-expiration","listQuery.query"] -> keys=2 exists=yes valid=yes
      12.013s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-expiration","listQuery.item"] -> keys=2 exists=yes valid=yes
      12.013s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-expiration","listQuery.item"] -> keys=2 exists=yes valid=yes
      12.013s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-expiration","listQuery.query"] -> keys=2 exists=yes valid=yes
      12.015s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","list-query-expiration","listQuery.item"] keys=["\\"expired-users||1"]
      12.018s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","list-query-expiration","listQuery.query"] keys=["{tableId:\\"expired-users\\"}"]
      12.021s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","list-query-expiration","listQuery.item"] keys=1
      12.024s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","list-query-expiration","listQuery.query"] keys=1
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
      12.006s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-startup-max-queries","listQuery.query"]]
      12.011s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-startup-max-queries","listQuery.query"] -> keys=3 exists=yes valid=yes
      12.013s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","lq-startup-max-queries","listQuery.query"] keys=["{tableId:\\"first\\"}"]
      12.018s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","lq-startup-max-queries","listQuery.query"] keys=2 static-policy
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
    const defaultMaxQueryBytes = getDefaultMaxBytesForScope(
      'async',
      'listQuery.query',
    );
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

  test('a store whose custom maxQueryBytes was removed from its config clears the persisted limit on its next save', async () => {
    const cachedQuery = { tableId: 'cached' };
    const fetchedQuery = { tableId: 'fetched' };
    const storeName = 'lq-query-policy-reset';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    // An earlier version of the app persisted the store with a custom limit.
    listQueryScope.listQuery.seedQuery(cachedQuery, []);
    listQueryScope.listQuery.setQueryStaticPolicy({ b: 5000 });

    // The current version uses the default limit.
    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { fetched: [{ id: 1, name: 'Fetched' }] },
    });
    await settleStartupBackgroundScan(mockAdapter);

    // Saving a fetched query also saves the store's current limit: none. The
    // cleanup at the next app start would otherwise keep enforcing the old one.
    env.scheduleFetch('highPriority', fetchedQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();

    expect(
      (await listQueryScope.listQuery.listStoredQueryKeys()).sort(),
    ).toMatchInlineSnapshot(`['{tableId:"cached"}', '{tableId:"fetched"}']`);
    expect(
      await readListQueryNamespacePolicyRow({
        kind: 'listQuery.query',
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      p: null
      s: 'sess1'
    `);
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
    const itemNamespaceSnapshot = await readListQueryItemNamespaceSnapshot({
      mockAdapter,
      sessionKey,
      storeName,
    });
    expect(
      itemNamespaceSnapshot && {
        ...itemNamespaceSnapshot,
        entries: Object.fromEntries(
          Object.entries(itemNamespaceSnapshot.entries).map(([key, entry]) => [
            key,
            { ...entry, a: '<timestamp>' },
          ]),
        ),
      },
    ).toMatchInlineSnapshot(`
      entries:
        "third||1: { a: '<timestamp>', p: 'third||1' }
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
          a: 1735689613966
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
          a: 1735689613862
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

    // Hydrate cached data and settle the automatic revalidation first so the explicit invalidation path stays isolated.
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
    const refetchCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: usersQuery,
        type: 'highPriority',
      });
    });
    await flushInvalidationPersistence(1700);
    const refetchOperations = refetchCapture.finish().timelineString;

    expect(hook.result.current.items).toMatchInlineSnapshot(`[]`);
    expect(refetchOperations).toMatchInlineSnapshot(`
      ""
      1.812s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-query-becomes-empty","listQuery.query"] order=lru-desc -> ["{tableId:\\"users\\"}"]
      1.815s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-query-becomes-empty","listQuery.item"] order=lru-desc -> ["\\"users||1"]
      1.861s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-query-becomes-empty","listQuery.query"] put=["{tableId:\\"users\\"}"] delete=[] touch=[] static-policy
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
        "users||1: { a: 1735689600000, p: 'users||1' }
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
          name: 'Expired recent',
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
      name: 'Expired recent',
    });
    await advanceTime(1100);
    await settleIndexedDbStorage();

    await advanceTime(100);
    env.apiStore.addItemToState(rawItemPayload('standalone', 2), {
      id: 2,
      name: 'Expired older',
    });
    await advanceTime(1100);
    await settleIndexedDbStorage();

    // Persist one query-backed item before introducing a second query-backed
    // item. This flush already overflows the item budget, so the least recently
    // persisted item (standalone||1) loses its storage slot here while staying
    // loaded in memory.
    env.scheduleFetch('highPriority', usersQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();

    // Backdate the standalone entries so the later maxItems cleanup sees them
    // as stale candidates (standalone||1 is already out of storage, so its
    // backdate only touches leftover metadata). The timestamps are distinct so
    // the recency ordering stays deterministic.
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
        lastAccessAt: expiredTimestamp - 60 * 60 * 1000,
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

    // The budget keeps the two most recently accessed items: the freshly
    // fetched admins||4 and the query-backed users||3. The stale standalone||2
    // is removed, and the previously budget-evicted standalone||1 is not
    // resurrected as if it were freshly accessed.
    expect(
      (await listQueryScope.listQuery.listStoredItemKeys()).sort(),
    ).toMatchInlineSnapshot(`['"admins||4', '"users||3']`);
    expect(
      await readListQueryItemNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        "admins||4: { a: 1735689619226, p: 'admins||4' }
        "users||3: { a: 1735689616210, p: 'users||3' }

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
          a: 1735689619180
          p: { tableId: 'admins' }
        {tableId:"users"}:
          a: 1735689616164
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
      1.816s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-expired-during-max-items","listQuery.item"] order=lru-desc -> ["\\"users||3", "\\"standalone||2"]
      1.862s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-expired-during-max-items","listQuery.query"] put=["{tableId:\\"admins\\"}"] delete=[] touch=[] static-policy
      1.91s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-expired-during-max-items","listQuery.item"] put=["\\"admins||4"] delete=["\\"standalone||2"] touch=[] static-policy
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
              - key: ['["sess1","lq-expired-during-max-items","li"]', '"users||3']
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
      12.011s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-shared-item-cleanup","listQuery.item"], ["sess1","lq-shared-item-cleanup","listQuery.query"]]
      12.015s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-shared-item-cleanup","listQuery.query"] -> keys=2 exists=yes valid=yes
      12.017s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-shared-item-cleanup","listQuery.item"] -> keys=4 exists=yes valid=yes
      12.019s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","lq-shared-item-cleanup","listQuery.item"] keys=["\\"users||1"]
      12.026s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","lq-shared-item-cleanup","listQuery.item"] keys=3 static-policy
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
});
