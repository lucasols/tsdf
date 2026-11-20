import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import type { TSDFDebugLogEntry } from '../../../src/debug';
import { createAsyncStorageAdapter } from '../../../src/persistentStorage/asyncStorageAdapter';
import { OpfsAsyncStorageDriver } from '../../../src/persistentStorage/opfsAsyncStorageAdapter';
import { getDefaultMaxBytesForScope } from '../../../src/persistentStorage/persistentStorageDefaults';
import type { ListQueryParams } from '../../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../../utils/genericTestUtils';
import { createOpfsPersistentStorageTestStore } from '../../utils/opfsPersistentStorageTestStore';
import {
  getOpfsDirTree,
  getParsedOpfsFileData,
  startOpfsPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
  createDocumentEnv,
  createDeadlineUntilFileDeletes,
  createListQueryEnv,
  flushInvalidationPersistence,
  getAsyncListItemEntrySizeBytes,
  getAsyncListQueryEntrySizeBytes,
  LARGE_MAINTENANCE_TEST_OPTIONS,
  opfsMaintenanceRemoveBatchSize,
  rawItemPayload,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  storeItemKey,
  stubIdleCallbacks,
  sumPersistedEntryBytes,
  syncEntriesOfflineProtectedFromSiblingTab,
  waitForScheduledCleanup,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

describe('async storage efficiency: list-query', () => {
  test(
    'item maintenance keeps an item another tab offline-protected while it was suspended',
    LARGE_MAINTENANCE_TEST_OPTIONS,
    async () => {
      const storeName = 'list-query-stale-maintenance-plan';
      const sessionKey = 'sess1';
      // One full removal batch plus `cached||0`..`cached||2`.
      const cachedItemCount = opfsMaintenanceRemoveBatchSize + 3;
      const idleCallbacks = stubIdleCallbacks();

      const mockAdapter = createOpfsPersistentStorageTestStore();
      const listQueryScope = mockAdapter.scope(storeName, sessionKey);
      const cachedItem = (index: number) => ({
        id: index,
        name: 'Cached item',
      });
      // Seed in recency order so `cached||0` is the least recently used item
      // and `recent||1` / `recent||2` are the most recent ones.
      const seededItems = [
        ...Array.from({ length: cachedItemCount }, (_, index) => ({
          tableId: 'cached',
          id: index,
        })),
        { tableId: 'recent', id: 1 },
        { tableId: 'recent', id: 2 },
      ];
      const cachedStorageKeys: string[] = [];
      for (const [index, { tableId, id }] of seededItems.entries()) {
        cachedStorageKeys.push(
          listQueryScope.listQuery.seedItem(tableId, id, cachedItem(id), {
            timestamp: TEST_INITIAL_TIME + index,
          }).storageKey,
        );
      }

      const liveItem = { id: 1, name: 'Live item' };
      const env = createListQueryEnv({
        // Stores with an `ignoreItems` filter enforce the item byte budget
        // during background maintenance instead of evicting inline on flush.
        ignoreItems: (payload) => payload.startsWith('ignored||'),
        // Room for the live item plus the two most recent cached items.
        maxItemBytes: sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes(rawItemPayload('live', 1), liveItem),
          getAsyncListItemEntrySizeBytes(
            rawItemPayload('recent', 1),
            cachedItem(1),
          ),
          getAsyncListItemEntrySizeBytes(
            rawItemPayload('recent', 2),
            cachedItem(2),
          ),
        ),
        storeName,
        sessionKey,
      });

      env.apiStore.addItemToState(rawItemPayload('live', 1), liveItem);
      await advanceTime(1200);

      // The first slice plans to evict every `cached||*` item and runs out of
      // time after the first full removal batch, leaving
      // `cached||0`..`cached||2` still planned for removal.
      await idleCallbacks.runNext(
        createDeadlineUntilFileDeletes(
          mockAdapter,
          opfsMaintenanceRemoveBatchSize,
        ),
      );
      expect(listQueryScope.listQuery.listStoredItemKeys().sort())
        .toMatchInlineSnapshot(`
          - '"cached||0'
          - '"cached||1'
          - '"cached||2'
          - '"live||1'
          - '"recent||1'
          - '"recent||2'
        `);

      // While maintenance waits for the next idle period, another tab marks
      // `cached||1` as offline-protected.
      await syncEntriesOfflineProtectedFromSiblingTab(sessionKey, [
        cachedStorageKeys[1] ?? '',
      ]);

      // The next batch removes items only if their stored metadata still
      // matches the plan: `cached||1` changed, so it is kept while the
      // unchanged items are removed. Maintenance then re-plans with fresh
      // metadata, where the protected item stays.
      await idleCallbacks.runUntilIdle(() => 50);

      expect(
        listQueryScope.listQuery.listStoredItemKeys().sort(),
      ).toMatchInlineSnapshot(
        `['"cached||1', '"live||1', '"recent||1', '"recent||2']`,
      );
    },
  );

  test(
    'query maintenance keeps a query another tab refreshed and defers item cleanup to a fresh plan',
    LARGE_MAINTENANCE_TEST_OPTIONS,
    async () => {
      const storeName = 'list-query-stale-query-plan';
      const sessionKey = 'sess1';
      // One full removal batch plus the `old-0`..`old-2` queries.
      const oldQueryCount = opfsMaintenanceRemoveBatchSize + 3;
      const idleCallbacks = stubIdleCallbacks();

      const mockAdapter = createOpfsPersistentStorageTestStore();
      const listQueryScope = mockAdapter.scope(storeName, sessionKey);
      // Seed in recency order so `old-0` is the least recently used query and
      // `recent` is the most recent one.
      const seededQueries = [
        ...Array.from({ length: oldQueryCount }, (_, index) => ({
          tableId: `old-${index}`,
        })),
        { tableId: 'recent' },
      ];
      for (const [index, query] of seededQueries.entries()) {
        listQueryScope.listQuery.seedQuery(query, [], {
          timestamp: TEST_INITIAL_TIME + index,
        });
      }
      // An ignored cached item that item maintenance removes.
      listQueryScope.listQuery.seedItem('ignored', 1, {
        id: 1,
        name: 'Ignored cached item',
      });

      const env = createListQueryEnv({
        // Stores with an `ignoreItems` filter enforce the byte budgets during
        // background maintenance instead of evicting inline on flush.
        ignoreItems: (payload) => payload.startsWith('ignored||'),
        // Room for the most recent query only.
        maxQueryBytes: getAsyncListQueryEntrySizeBytes(
          { tableId: 'recent' },
          [],
        ),
        storeName,
        sessionKey,
      });

      env.apiStore.addItemToState(rawItemPayload('live', 1), {
        id: 1,
        name: 'Live item',
      });
      await advanceTime(1200);

      // The first slice plans to evict every `old-*` query and runs out of time
      // after the first full removal batch, leaving `old-0`..`old-2` planned.
      await idleCallbacks.runNext(
        createDeadlineUntilFileDeletes(
          mockAdapter,
          opfsMaintenanceRemoveBatchSize,
        ),
      );

      // While maintenance waits for the next idle period, another tab reads the
      // `old-1` query, making it the most recently used one.
      const siblingAdapter = createAsyncStorageAdapter(
        new OpfsAsyncStorageDriver(),
      );
      await resolveAfterAllTimers(
        siblingAdapter
          .openNamespace(listQueryScope.listQuery.queryNamespace)
          .commit({
            touches: [
              {
                key: listQueryScope.listQuery.queryKey({ tableId: 'old-1' }),
                lastAccessAt: Date.now(),
              },
            ],
          }),
      );
      siblingAdapter.resetForTests?.();

      // The continuation keeps the refreshed query and stops before item
      // cleanup, since items would be judged against an outdated query set.
      await idleCallbacks.runNext(() => 50);
      const afterStaleSlice = {
        queries: listQueryScope.listQuery.listStoredQueryKeys().sort(),
        items: listQueryScope.listQuery.listStoredItemKeys().sort(),
      };

      // The rescheduled pass re-plans from fresh metadata: `old-1` is now the
      // most recent query, so `recent` is evicted, and item cleanup runs.
      await idleCallbacks.runUntilIdle(() => 50);

      expect({
        afterStaleSlice,
        afterRescheduledPass: {
          queries: listQueryScope.listQuery.listStoredQueryKeys().sort(),
          items: listQueryScope.listQuery.listStoredItemKeys().sort(),
        },
      }).toMatchInlineSnapshot(`
        afterRescheduledPass:
          items: ['"live||1']
          queries: ['{tableId:"old-1"}']

        afterStaleSlice:
          items: ['"ignored||1', '"live||1']
          queries: ['{tableId:"old-1"}', '{tableId:"recent"}']
      `);
    },
  );

  test('expiration cleanup removes expired queries and items through namespace manifests only', async () => {
    const expiredTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const storeName = 'list-query-expiration';
    const sessionKey = 'sess1';
    const expiredQueryParams: ListQueryParams = { tableId: 'expired-users' };
    const freshQueryParams: ListQueryParams = { tableId: 'fresh-users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    createListQueryEnv({ storeName, sessionKey });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the scan runs, capture the complete query and item cleanup sequence.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      expiredItemExists: mockAdapter.has(expiredItemKey),
      expiredQueryExists: mockAdapter.has(expiredQueryKey),
      freshItemExists: mockAdapter.has(freshItemKey),
      freshQueryExists: mockAdapter.has(freshQueryKey),
    }).toMatchInlineSnapshot(`
      expiredItemExists: '❌'
      expiredQueryExists: '❌'
      freshItemExists: '✅'
      freshQueryExists: '✅'
    `);
    expect(operationsBreakdown).not.toContain('⚠️ DUPLICATE OPEN');
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time    |
      12.001s | 📂 dir-open ✅ tsdf (root directory)
      12.002s | 🗂️ list-dir-values tsdf (root directory) entries=["dir:sess1"]
      12.003s | 🗂️ list-dir-values tsdf/sess1
              |    └ (session directory) entries=["dir:list-query-expiration"]
      12.004s | 🗂️ list-dir-entries tsdf/sess1/list-query-expiration
              |    └ (store directory) entries=["file:li._i.r.json","file:li.h~1232081768.p.json","file:li.h~3303896864.p.json","file:lq._i.r.json","file:lq.h~2161479472.p.json","file:lq.h~4046999656.p.json"]
      12.005s | 📖 #1 tsdf/sess1/list-query-expiration/li._i.r.json
              |    └ (items index) | 0.28 kb
      12.008s | 📖 #2 tsdf/sess1/list-query-expiration/lq._i.r.json
              |    └ (queries index) | 0.35 kb
      12.011s | 🗑️ #3 ✅ tsdf/sess1/list-query-expiration/li.h~1232081768.p.json
              |    └ (item data, <"expired-users||1>)
      .       | 🗑️ #4 ✅ tsdf/sess1/list-query-expiration/lq.h~4046999656.p.json
              |    └ (query data, <{tableId:"expired-users"}>)
      12.014s | ✍️ #1 tsdf/sess1/list-query-expiration/li._i.r.json
              |    └ (items index) | 0.28 kb -> 0.14 kb
      .       | ✍️ #2 tsdf/sess1/list-query-expiration/lq._i.r.json
              |    └ (queries index) | 0.35 kb -> 0.18 kb
      12.016s | end
      "
    `);

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.67 kb)
      ├ sess1 (0.60 kb)
      │ └ list-query-expiration (0.59 kb)
      │   ├ li._i.r.json (0.17 kb)
      │   ├ li.h~3303896864.p.json (0.10 kb)
      │   ├ lq._i.r.json (0.20 kb)
      │   └ lq.h~2161479472.p.json (0.08 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);

    expect(
      getParsedOpfsFileData('tsdf/sess1/list-query-expiration/li._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        "fresh-users||2: { a: 1735689600000, p: 'fresh-users||2', z: 68 }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/list-query-expiration/li.<"fresh-users||2>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      id: 2
      name: 'Fresh Item'
    `);

    expect(
      getParsedOpfsFileData('tsdf/sess1/list-query-expiration/lq._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"fresh-users"}:
          a: 1735689600000
          p: { tableId: 'fresh-users' }
          z: 69
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/list-query-expiration/lq.<{tableId:"fresh-users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`['"fresh-users||2']`);
  });

  test('startup cleanup enforces maxQueryBytes against preloaded persisted entries', async () => {
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const storeName = 'lq-startup-max-queries';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    createDocumentEnv({ storeName: 'trigger-doc', sessionKey });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the startup pass runs, it should evict only the oldest persisted query.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listQueryScope.listQuery.listStoredQueryKeys().sort(),
    ).toMatchInlineSnapshot(`['{tableId:"second"}', '{tableId:"third"}']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time    |
      12.001s | 📂 dir-open ✅ tsdf (root directory)
      12.002s | 🗂️ list-dir-values tsdf (root directory) entries=["dir:sess1"]
      12.003s | 🗂️ list-dir-values tsdf/sess1
              |    └ (session directory) entries=["dir:lq-startup-max-queries"]
      12.004s | 🗂️ list-dir-entries tsdf/sess1/lq-startup-max-queries
              |    └ (store directory) entries=["file:lq._i.r.json","file:lq.h~2817177027.p.json","file:lq.h~3601729766.p.json","file:lq.h~4141397404.p.json"]
      12.005s | 📖 #1 tsdf/sess1/lq-startup-max-queries/lq._i.r.json
              |    └ (queries index) | 0.47 kb
      12.008s | 🗑️ #2 ✅ tsdf/sess1/lq-startup-max-queries/lq.h~4141397404.p.json
              |    └ (query data, <{tableId:"first"}>)
      12.011s | ✍️ #1 tsdf/sess1/lq-startup-max-queries/lq._i.r.json
              |    └ (queries index) | 0.47 kb -> 0.33 kb
      12.013s | end
      "
    `);
    expect(
      getParsedOpfsFileData('tsdf/sess1/lq-startup-max-queries/lq._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"second"}:
          a: 1735689600100
          p: { tableId: 'second' }
          z: 46
        {tableId:"third"}:
          a: 1735689600200
          p: { tableId: 'third' }
          z: 45

      s: { b: 91 }
    `);
  });

  test('cold startup enforces the default list-query maxQueryBytes policy before the store mounts', async () => {
    const storeName = 'lq-cold-default-max-queries';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      listQueryScope.listQuery.seedQuery(getQuery(index), [], {
        timestamp: TEST_INITIAL_TIME.valueOf() + index,
      });
    }

    createDocumentEnv({ storeName: 'trigger-doc', sessionKey });
    await waitForScheduledCleanup();

    const storedQueryKeys = listQueryScope.listQuery.listStoredQueryKeys();

    expect(storedQueryKeys.length).toBeLessThan(totalQueries);
    expect(storedQueryKeys).not.toContain(`{tableId:"${getQuery(0).tableId}"}`);
    expect(storedQueryKeys).toContain(
      `{tableId:"${getQuery(totalQueries - 1).tableId}"}`,
    );
  });

  test('when maxQueryBytes limit is reached the flush trims queries inline', async () => {
    const debugEntries: TSDFDebugLogEntry[] = [];
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const storeName = 'lq-query-metadata';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedQuery(firstQuery, []);
    await advanceTime(100);
    listQueryScope.listQuery.seedQuery(secondQuery, []);

    const env = createListQueryEnv({
      debugEntries,
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
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    env.scheduleFetch('highPriority', thirdQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listQueryScope.listQuery.listStoredQueryKeys().sort(),
    ).toMatchInlineSnapshot(`['{tableId:"second"}', '{tableId:"third"}']`);
    expect(
      debugEntries
        .filter((entry) => entry.operation === 'quota-cleanup')
        .map((entry) => ({
          details: {
            adapter: entry.details?.adapter,
            evictedEntries: entry.details?.evictedEntries,
            keptEntries: entry.details?.keptEntries,
            maxBytes: entry.details?.maxBytes,
            namespaceKind: entry.details?.namespaceKind,
            phase: entry.details?.phase,
            quota: entry.details?.quota,
            status: entry.details?.status,
            storeName: entry.details?.storeName,
            totalEntries: entry.details?.totalEntries,
            unprotectedBytes: entry.details?.unprotectedBytes,
          },
          message: entry.message,
          operation: entry.operation,
        })),
    ).toMatchInlineSnapshot(`
      - details:
          adapter: 'async'
          evictedEntries: 1
          keptEntries: 2
          maxBytes: 103
          namespaceKind: 'listQuery.query'
          phase: 'flush'
          quota: 'maxQueryBytes'
          status: 'success'
          storeName: 'lq-query-metadata'
          totalEntries: 3
          unprotectedBytes: 148
        message: 'persistent storage quota-cleanup success'
        operation: 'quota-cleanup'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      1.81s  | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1.811s | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata (store directory)
      1.812s | 👁️ #1 file-open ❌ tsdf/sess1/lq-query-metadata/li._i.r.json
             |    └ (items index)
      1.813s | 👁️ #2 file-open ✅ tsdf/sess1/lq-query-metadata/lq._i.r.json
             |    └ (queries index)
      1.814s | 📖 #2 tsdf/sess1/lq-query-metadata/lq._i.r.json
             |    └ (queries index) | 0.30 kb
             ·
      1.857s | 🗑️ #3 ✅ tsdf/sess1/lq-query-metadata/lq.h~4141397404.p.json
             |    └ (query data, <{tableId:"first"}>)
      .      | 👁️ #4 file-open-or-create 🆕 tsdf/sess1/lq-query-metadata/lq.h~3601729766.p.json
             |    └ (query data)
      .      | 👁️ #1 file-open ❌ tsdf/sess1/lq-query-metadata/li._i.r.json
             |    └ (items index)
      1.858s | 👁️ #5 file-open-or-create 🆕 tsdf/sess1/lq-query-metadata/li.h~4006559409.p.json
             |    └ (item data)
      1.86s  | ✍️ #4 tsdf/sess1/lq-query-metadata/lq.h~3601729766.p.json
             |    └ (query data) | 0.00 kb -> 0.03 kb
      1.861s | ✍️ #5 tsdf/sess1/lq-query-metadata/li.h~4006559409.p.json
             |    └ (item data) | 0.00 kb -> 0.04 kb
      1.863s | 👁️ #1 file-open-or-create 🆕 tsdf/sess1/lq-query-metadata/li._i.r.json
             |    └ (items index)
      1.864s | ✍️ #2 tsdf/sess1/lq-query-metadata/lq._i.r.json
             |    └ (queries index) | 0.30 kb -> 0.33 kb
      1.866s | ✍️ #1 tsdf/sess1/lq-query-metadata/li._i.r.json
             |    └ (items index) | 0.00 kb -> 0.12 kb
      1.868s | end
      "
    `);
    expect(getParsedOpfsFileData('tsdf/sess1/lq-query-metadata/li._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          "third||1: { a: 1735689614058, p: 'third||1', z: 57 }
      `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-query-metadata/li.<"third||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Third'
    `);
    expect(getParsedOpfsFileData('tsdf/sess1/lq-query-metadata/lq._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          {tableId:"second"}:
            a: 1735689600100
            p: { tableId: 'second' }
            z: 46
          {tableId:"third"}:
            a: 1735689614057
            p: { tableId: 'third' }
            z: 57

        s: { b: 103 }
      `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-query-metadata/lq.<{tableId:"third"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`['"third||1']`);
  });

  test('multiple overflowing query writes trim inline during each flush', async () => {
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const fourthQuery = { tableId: 'fourth' };
    const storeName = 'lq-coalesced-query-maintenance';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedQuery(firstQuery, []);
    await advanceTime(100);
    listQueryScope.listQuery.seedQuery(secondQuery, []);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      maxQueryBytes: Math.max(
        sumPersistedEntryBytes(
          getAsyncListQueryEntrySizeBytes(firstQuery, []),
          getAsyncListQueryEntrySizeBytes(secondQuery, []),
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

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);

    // The third query persists and trims the oldest query in the same flush.
    env.scheduleFetch('highPriority', thirdQuery);
    await advanceTime(810);
    await advanceTime(1000);

    // The fourth query repeats the same inline trim for the next oldest query.
    env.scheduleFetch('highPriority', fourthQuery);
    await advanceTime(810);
    await advanceTime(1000);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listQueryScope.listQuery.listStoredQueryKeys().sort(),
    ).toMatchInlineSnapshot(`['{tableId:"fourth"}', '{tableId:"third"}']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      1.81s  | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1.811s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance
             |    └ (store directory)
      1.812s | 👁️ #1 file-open ❌ tsdf/sess1/lq-coalesced-query-maintenance/li._i.r.json
             |    └ (items index)
      1.813s | 👁️ #2 file-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/lq._i.r.json
             |    └ (queries index)
      1.814s | 📖 #2 tsdf/sess1/lq-coalesced-query-maintenance/lq._i.r.json
             |    └ (queries index) | 0.30 kb
             ·
      1.857s | 🗑️ #3 ✅ tsdf/sess1/lq-coalesced-query-maintenance/lq.h~4141397404.p.json
             |    └ (query data, <{tableId:"first"}>)
      .      | 👁️ #4 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/lq.h~3601729766.p.json
             |    └ (query data)
      .      | 👁️ #1 file-open ❌ tsdf/sess1/lq-coalesced-query-maintenance/li._i.r.json
             |    └ (items index)
      1.858s | 👁️ #5 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/li.h~4006559409.p.json
             |    └ (item data)
      1.86s  | ✍️ #4 tsdf/sess1/lq-coalesced-query-maintenance/lq.h~3601729766.p.json
             |    └ (query data) | 0.00 kb -> 0.03 kb
      1.861s | ✍️ #5 tsdf/sess1/lq-coalesced-query-maintenance/li.h~4006559409.p.json
             |    └ (item data) | 0.00 kb -> 0.04 kb
      1.863s | 👁️ #1 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/li._i.r.json
             |    └ (items index)
      1.864s | ✍️ #2 tsdf/sess1/lq-coalesced-query-maintenance/lq._i.r.json
             |    └ (queries index) | 0.30 kb -> 0.33 kb
      1.866s | ✍️ #1 tsdf/sess1/lq-coalesced-query-maintenance/li._i.r.json
             |    └ (items index) | 0.00 kb -> 0.12 kb
             ·
      3.66s  | 🗑️ #6 ✅ tsdf/sess1/lq-coalesced-query-maintenance/lq.h~2817177027.p.json
             |    └ (query data)
      .      | 👁️ #7 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/lq.h~3370518832.p.json
             |    └ (query data, <{tableId:"fourth"}>)
      .      | 👁️ #8 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/li.h~1322690187.p.json
             |    └ (item data, <"fourth||2>)
      3.663s | ✍️ #7 tsdf/sess1/lq-coalesced-query-maintenance/lq.h~3370518832.p.json
             |    └ (query data, <{tableId:"fourth"}>) | 0.00 kb -> 0.03 kb
      .      | ✍️ #8 tsdf/sess1/lq-coalesced-query-maintenance/li.h~1322690187.p.json
             |    └ (item data, <"fourth||2>) | 0.00 kb -> 0.05 kb
      3.667s | ✍️ #2 tsdf/sess1/lq-coalesced-query-maintenance/lq._i.r.json
             |    └ (queries index) | 0.33 kb -> 0.33 kb
      .      | ✍️ #1 tsdf/sess1/lq-coalesced-query-maintenance/li._i.r.json
             |    └ (items index) | 0.12 kb -> 0.23 kb
      3.669s | end
      "
    `);
  });

  test('persisting an empty query does not materialize the item namespace manifest', async () => {
    const storeName = 'lq-empty-query-manifest';
    const sessionKey = 'sess1';
    const usersQuery = {
      tableId: 'users',
      filters: [{ field: 'name', op: 'eq', value: 'Missing user' }],
    } satisfies ListQueryParams;
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Existing user' }] },
    });

    await settleStartupBackgroundScan(mockAdapter);

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(listQueryScope.listQuery.listStoredItemKeys()).toMatchInlineSnapshot(
      `[]`,
    );
    expect(
      listQueryScope.listQuery.listStoredQueryKeys(),
    ).toMatchInlineSnapshot(
      `['{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}']`,
    );
    expect(operationsBreakdown).not.toContain('⚠️ DUPLICATE OPEN');
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      1.811s | 📁 dir-open-or-create 🆕 tsdf (root directory)
      1.812s | 📂 dir-open ❌ tsdf/sess1 (session directory)
      1.813s | 📂 dir-open ❌ tsdf/sess1 (session directory)
             ·
      1.854s | 📂 dir-open ❌ tsdf/sess1 (session directory)
      1.855s | 📁 dir-open-or-create 🆕 tsdf/sess1 (session directory)
      1.856s | 📁 dir-open-or-create 🆕 tsdf/sess1/lq-empty-query-manifest
             |    └ (store directory)
      1.857s | 👁️ #1 file-open-or-create 🆕 tsdf/sess1/lq-empty-query-manifest/lq.h~1731990418.p.json
             |    └ (query data)
      1.86s  | ✍️ #1 tsdf/sess1/lq-empty-query-manifest/lq.h~1731990418.p.json
             |    └ (query data) | 0.00 kb -> 0.00 kb
      1.862s | 👁️ #2 file-open-or-create 🆕 tsdf/sess1/lq-empty-query-manifest/lq._i.r.json
             |    └ (queries index)
      1.865s | ✍️ #2 tsdf/sess1/lq-empty-query-manifest/lq._i.r.json
             |    └ (queries index) | 0.00 kb -> 0.40 kb
      1.867s | end
      "
    `);
    expect(
      getParsedOpfsFileData('tsdf/sess1/lq-empty-query-manifest/lq._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        {filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}:
          a: 1735689613955
          p:
            filters:
              - { field: 'name', op: 'eq', value: 'Missing user' }
            tableId: 'users'
          z: 107
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-empty-query-manifest/lq.<{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('query that becomes empty after invalidation do not clean up orphaned items from persistence', async () => {
    const storeName = 'lq-query-becomes-empty';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
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
      "
      time   |
      1.852s | ✍️ #1 tsdf/sess1/lq-query-becomes-empty/lq.h~2902406637.p.json
             |    └ (query data, <{tableId:"users"}>) | 0.03 kb -> 0.00 kb
      1.856s | ✍️ #2 tsdf/sess1/lq-query-becomes-empty/lq._i.r.json
             |    └ (queries index) | 0.16 kb -> 0.16 kb
      1.858s | end
      "
    `);
    expect(
      getParsedOpfsFileData('tsdf/sess1/lq-query-becomes-empty/li._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        "users||1: { a: 1735689600000, p: 'users||1', z: 63 }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-query-becomes-empty/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Cached user'
    `);
    expect(
      getParsedOpfsFileData('tsdf/sess1/lq-query-becomes-empty/lq._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"users"}:
          a: 1735689600000
          p: { tableId: 'users' }
          z: 45
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-query-becomes-empty/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('when maxItemBytes is reached the flush trims items inline by recency without touching cold queries', async () => {
    const storeName = 'lq-item-metadata';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
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

    // Drain the startup cleanup before capturing the maxItemBytes flush.
    await settleStartupBackgroundScan(mockAdapter);

    // Adding a third item should snapshot the inline trim end-to-end.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.addItemToState(rawItemPayload('users', 3), {
      id: 3,
      name: 'Fresh',
    });
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listQueryScope.listQuery.listStoredItemKeys().sort(),
    ).toMatchInlineSnapshot(`['"users||2', '"users||3']`);
    expect(operationsBreakdown).not.toContain('query data');
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      1s     | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1.001s | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata (store directory)
      1.002s | 👁️ #1 file-open ✅ tsdf/sess1/lq-item-metadata/li._i.r.json
             |    └ (items index)
      1.003s | 📖 #1 tsdf/sess1/lq-item-metadata/li._i.r.json
             |    └ (items index) | 0.23 kb
      1.006s | 👁️ #2 file-open ✅ tsdf/sess1/lq-item-metadata/lq._i.r.json
             |    └ (queries index)
      1.007s | 📖 #2 tsdf/sess1/lq-item-metadata/lq._i.r.json
             |    └ (queries index) | 0.16 kb
             ·
      1.05s  | 🗑️ #3 ✅ tsdf/sess1/lq-item-metadata/li.h~228010772.p.json
             |    └ (item data, <"users||1>)
      .      | 👁️ #4 file-open-or-create 🆕 tsdf/sess1/lq-item-metadata/li.h~3224064498.p.json
             |    └ (item data)
      1.053s | ✍️ #4 tsdf/sess1/lq-item-metadata/li.h~3224064498.p.json
             |    └ (item data) | 0.00 kb -> 0.04 kb
      1.057s | ✍️ #1 tsdf/sess1/lq-item-metadata/li._i.r.json
             |    └ (items index) | 0.23 kb -> 0.26 kb
      1.059s | end
      "
    `);
  });

  test('maxItemBytes-triggered flush re-evaluates mixed standalone and query-backed items using persisted recency', async () => {
    const expiredTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const storeName = 'lq-expired-during-max-items';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const adminsQuery = { tableId: 'admins' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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

    // Drain startup cleanup first so the later item removals are attributable to the maxItemBytes path.
    await settleStartupBackgroundScan(mockAdapter);

    // Persist two standalone items that will later look expired to the cleanup pass.
    env.apiStore.addItemToState(rawItemPayload('standalone', 1), {
      id: 1,
      name: 'Expired recent',
    });
    await advanceTime(1100);
    await flushAllTimers();

    await advanceTime(100);
    env.apiStore.addItemToState(rawItemPayload('standalone', 2), {
      id: 2,
      name: 'Expired older',
    });
    await advanceTime(1100);
    await flushAllTimers();

    // Persist one query-backed item before introducing a second query-backed
    // item. This flush already overflows maxItemBytes, so the least recently
    // persisted item (standalone||1) loses its storage slot here while staying
    // loaded in memory.
    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    // Backdate the standalone entries so the later maxItemBytes cleanup sees
    // them as stale candidates (standalone||1 is already out of storage, so its
    // backdate only touches leftover metadata). The timestamps are distinct so
    // the recency ordering stays deterministic.
    mockAdapter.setMetadata(
      listQueryScope.listQuery.itemStorageKey('standalone', 1),
      {
        ...mockAdapter.readMetadata(
          listQueryScope.listQuery.itemStorageKey('standalone', 1),
        ),
        lastAccessAt: expiredTimestamp,
      },
    );
    mockAdapter.setMetadata(
      listQueryScope.listQuery.itemStorageKey('standalone', 2),
      {
        ...mockAdapter.readMetadata(
          listQueryScope.listQuery.itemStorageKey('standalone', 2),
        ),
        lastAccessAt: expiredTimestamp - 60 * 60 * 1000,
      },
    );

    // Fetching a second query-backed item should re-run the inline trim using the
    // persisted timestamps from the earlier writes.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    env.scheduleFetch('highPriority', adminsQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    // The budget keeps the two most recently accessed items: the freshly
    // fetched admins||4 and the query-backed users||3. The stale standalone||2
    // is removed, and the previously budget-evicted standalone||1 is not
    // resurrected as if it were freshly accessed.
    expect(
      listQueryScope.listQuery.listStoredItemKeys().sort(),
    ).toMatchInlineSnapshot(`['"admins||4', '"users||3']`);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-expired-during-max-items/li._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        "admins||4: { a: 1735689619212, p: 'admins||4', z: 76 }
        "users||3: { a: 1735689616251, p: 'users||3', z: 68 }

      s: { b: 147 }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-expired-during-max-items/lq._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"admins"}:
          a: 1735689619212
          p: { tableId: 'admins' }
          z: 59
        {tableId:"users"}:
          a: 1735689616252
          p: { tableId: 'users' }
          z: 57
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      1.85s  | 👁️ #1 file-open-or-create 🆕 tsdf/sess1/lq-expired-during-max-items/lq.h~2316387135.p.json
             |    └ (query data)
      .      | 🗑️ #2 ✅ tsdf/sess1/lq-expired-during-max-items/li.h~3111345837.p.json
             |    └ (item data, <"standalone||2>)
      .      | 👁️ #3 file-open-or-create 🆕 tsdf/sess1/lq-expired-during-max-items/li.h~2792428996.p.json
             |    └ (item data)
      1.853s | ✍️ #1 tsdf/sess1/lq-expired-during-max-items/lq.h~2316387135.p.json
             |    └ (query data) | 0.00 kb -> 0.03 kb
      .      | ✍️ #3 tsdf/sess1/lq-expired-during-max-items/li.h~2792428996.p.json
             |    └ (item data) | 0.00 kb -> 0.08 kb
      1.857s | ✍️ #4 tsdf/sess1/lq-expired-during-max-items/lq._i.r.json
             |    └ (queries index) | 0.16 kb -> 0.30 kb
      .      | ✍️ #5 tsdf/sess1/lq-expired-during-max-items/li._i.r.json
             |    └ (items index) | 0.28 kb -> 0.26 kb
      1.859s | end
      "
    `);

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (1.12 kb)
      ├ sess1 (1.05 kb)
      │ └ lq-expired-during-max-items (1.04 kb)
      │   ├ li._i.r.json (0.28 kb)
      │   ├ li.h~2792428996.p.json (0.12 kb)
      │   ├ li.h~3224064498.p.json (0.11 kb)
      │   ├ lq._i.r.json (0.33 kb)
      │   ├ lq.h~2316387135.p.json (0.07 kb)
      │   └ lq.h~2902406637.p.json (0.07 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
  });

  test('item flush preserves fresh standalone entries that were persisted before the store noticed them', async () => {
    const storeName = 'lq-fresh-standalone-before-visible';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listQuery.listStoredItemKeys().sort())
      .toMatchInlineSnapshot(`
        ['"standalone||1', '"standalone||2', '"users||3']
      `);
  });

  test('maxItemBytes startup cleanup falls back to protected pinned and recency for preloaded query items', async () => {
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
    const mockAdapter = createOpfsPersistentStorageTestStore();
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

    // Let the startup-scheduled maintenance enforce maxItemBytes against the preloaded cache.
    const cleanupCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const cleanupOperations = cleanupCapture.finish().timelineString;

    // The oldest item should be evicted by recency, while the persisted query
    // payloads stay untouched and rely on later hydration to filter the missing item.
    expect(
      listQueryScope.listQuery.listStoredItemKeys().sort(),
    ).toMatchInlineSnapshot(`['"users||2', '"users||3', '"users||4']`);
    expect(
      getParsedOpfsFileData('tsdf/sess1/lq-shared-item-cleanup/lq._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        {filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}:
          a: 1735689600300
          p:
            filters:
              - { field: 'name', op: 'eq', value: 'Alice' }
            tableId: 'users'
          z: 125
        {filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}:
          a: 1735689600300
          p:
            filters:
              - { field: 'name', op: 'eq', value: 'Bob' }
            tableId: 'users'
          z: 123
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-shared-item-cleanup/lq.<{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-shared-item-cleanup/lq.<{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`['"users||1', '"users||3']`);
    expect(cleanupOperations).not.toContain('query data');
    expect(cleanupOperations).toMatchInlineSnapshot(`
      "
      time    |
      12.001s | 📂 dir-open ✅ tsdf (root directory)
      12.002s | 🗂️ list-dir-values tsdf (root directory) entries=["dir:sess1"]
      12.003s | 🗂️ list-dir-values tsdf/sess1
              |    └ (session directory) entries=["dir:lq-shared-item-cleanup"]
      12.004s | 🗂️ list-dir-entries tsdf/sess1/lq-shared-item-cleanup
              |    └ (store directory) entries=["file:li._i.r.json","file:li.h~1937155452.p.json","file:li.h~228010772.p.json","file:li.h~2854834066.p.json","file:li.h~3224064498.p.json","file:lq._i.r.json","file:lq.h~1471050956.p.json","file:lq.h~1805955701.p.json"]
      12.005s | 📖 #1 tsdf/sess1/lq-shared-item-cleanup/li._i.r.json
              |    └ (items index) | 0.47 kb
      12.008s | 📖 #2 tsdf/sess1/lq-shared-item-cleanup/lq._i.r.json
              |    └ (queries index) | 0.72 kb
      12.011s | 🗑️ #3 ✅ tsdf/sess1/lq-shared-item-cleanup/li.h~228010772.p.json
              |    └ (item data, <"users||1>)
      12.014s | ✍️ #1 tsdf/sess1/lq-shared-item-cleanup/li._i.r.json
              |    └ (items index) | 0.47 kb -> 0.36 kb
      12.016s | end
      "
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
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    // Capture the explicit delete path after the initial query+item persistence has settled.
    const deleteCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.deleteItemState('users||1');
    await advanceTime(1100);
    await flushAllTimers();
    const deleteOperations = deleteCapture.finish().timelineString;

    expect(mockAdapter.has(deletedItemStorageKey)).toBe(false);
    expect(
      listQueryScope.listQuery.listStoredItemKeys().sort(),
    ).toMatchInlineSnapshot(`['"users||2']`);
    expect(getParsedOpfsFileData('tsdf/sess1/lq-delete-flow/lq._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          {filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}:
            a: 1735689601855
            p:
              filters:
                - { field: 'name', op: 'eq', value: 'Alice' }
              tableId: 'users'
            z: 100
          {tableId:"users"}:
            a: 1735689601855
            p: { tableId: 'users' }
            z: 57
      `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-delete-flow/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`['"users||2']`);
    expect(getParsedOpfsFileData('tsdf/sess1/lq-delete-flow/lq._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          {filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}:
            a: 1735689601855
            p:
              filters:
                - { field: 'name', op: 'eq', value: 'Alice' }
              tableId: 'users'
            z: 100
          {tableId:"users"}:
            a: 1735689601855
            p: { tableId: 'users' }
            z: 57
      `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-delete-flow/lq.<{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`[]`);
    expect(deleteOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.04s  | 🗑️ #1 ✅ tsdf/sess1/lq-delete-flow/li.h~228010772.p.json
             |    └ (item data, <"users||1>)
      1.042s | ✍️ #2 tsdf/sess1/lq-delete-flow/lq.h~2902406637.p.json
             |    └ (query data, <{tableId:"users"}>) | 0.05 kb -> 0.03 kb
      .      | ✍️ #3 tsdf/sess1/lq-delete-flow/lq.h~1805955701.p.json
             |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>) | 0.03 kb -> 0.00 kb
      1.043s | ✍️ #4 tsdf/sess1/lq-delete-flow/li._i.r.json
             |    └ (items index) | 0.23 kb -> 0.12 kb
      1.046s | ✍️ #5 tsdf/sess1/lq-delete-flow/lq._i.r.json
             |    └ (queries index) | 0.51 kb -> 0.51 kb
      1.048s | end
      "
    `);
  });

  test('deleteItemState removes a cold persisted item without hydrating it first', async () => {
    const storeName = 'lq-cold-delete-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
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

    // Deleting a cold standalone item should consult only the namespace index and remove the
    // payload file directly, without hydrating the cached item into memory first.
    const deleteCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.deleteItemState('users||1');
    await advanceTime(1100);
    await flushAllTimers();
    const {
      operations: deleteOperationLabels,
      timelineString: deleteOperations,
    } = deleteCapture.finish();

    expect(mockAdapter.has(deletedItemStorageKey)).toBe(false);
    expect(listQueryScope.listQuery.listStoredItemKeys()).toMatchInlineSnapshot(
      `[]`,
    );
    expect(
      deleteOperationLabels.filter(
        (label) =>
          label.startsWith('📖') && label.includes(deletedItemStorageKey),
      ),
    ).toMatchInlineSnapshot(`[]`);
    expect(deleteOperations).toMatchInlineSnapshot(`
      "
      time   |
      1s     | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1.001s | 📂 dir-open ✅ tsdf/sess1/lq-cold-delete-flow (store directory)
      1.002s | 👁️ #1 file-open ✅ tsdf/sess1/lq-cold-delete-flow/li._i.r.json
             |    └ (items index)
      1.003s | 📖 #1 tsdf/sess1/lq-cold-delete-flow/li._i.r.json
             |    └ (items index) | 0.12 kb
      1.006s | 👁️ #2 file-open ❌ tsdf/sess1/lq-cold-delete-flow/lq._i.r.json
             |    └ (queries index)
             ·
      1.047s | 🗑️ #3 ✅ tsdf/sess1/lq-cold-delete-flow/li.h~228010772.p.json
             |    └ (item data, <"users||1>)
      1.048s | 🗑️ #1 ✅ tsdf/sess1/lq-cold-delete-flow/li._i.r.json (items index)
      1.049s | 🧹 del-dir ✅ tsdf/sess1/lq-cold-delete-flow (store directory)
      1.05s  | 🧹 del-dir ✅ tsdf/sess1 (session directory)
      1.051s | end
      "
    `);
  });
});
