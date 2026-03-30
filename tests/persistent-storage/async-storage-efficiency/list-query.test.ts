import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';

import type { ListQueryParams } from '../../mocks/listQueryStoreTestEnv';
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
  captureHookRemount,
  createDocumentEnv,
  createListQueryEnv,
  flushInvalidationPersistence,
  markEntryOfflineProtected,
  rawItemPayload,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  storeItemKey,
  waitForScheduledCleanup,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

describe('async storage efficiency: list-query', () => {
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
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir-values tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir-values tsdf/sess1
             |    └ (session directory) entries=["dir:list-query-expiration"]
      2.004s | 🗂️ list-dir-entries tsdf/sess1/list-query-expiration
             |    └ (store directory) entries=["file:li._i.r.json","file:li.h~1232081768.p.json","file:li.h~3303896864.p.json","file:lq._i.r.json","file:lq.h~2161479472.p.json","file:lq.h~4046999656.p.json"]
      2.005s | 📖 #1 tsdf/sess1/list-query-expiration/li._i.r.json
             |    └ (items index) | 0.26 kb
      2.008s | 📖 #2 tsdf/sess1/list-query-expiration/lq._i.r.json
             |    └ (queries index) | 0.33 kb
      2.011s | 🗑️ #3 ✅ tsdf/sess1/list-query-expiration/li.h~1232081768.p.json
             |    └ (item data, <"expired-users||1>)
      .      | 🗑️ #4 ✅ tsdf/sess1/list-query-expiration/lq.h~4046999656.p.json
             |    └ (query data, <{tableId:"expired-users"}>)
      2.014s | ✍️ #1 tsdf/sess1/list-query-expiration/li._i.r.json
             |    └ (items index) | 0.26 kb -> 0.13 kb
      .      | ✍️ #2 tsdf/sess1/list-query-expiration/lq._i.r.json
             |    └ (queries index) | 0.33 kb -> 0.17 kb
      2.016s | end
      "
    `);

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.71 kb)
      ├ sess1 (0.64 kb)
      │ └ list-query-expiration (0.63 kb)
      │   ├ li._i.r.json (0.15 kb)
      │   ├ li.h~3303896864.p.json (0.15 kb)
      │   ├ lq._i.r.json (0.19 kb)
      │   └ lq.h~2161479472.p.json (0.09 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);

    expect(
      getParsedOpfsFileData('tsdf/sess1/list-query-expiration/li._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        "fresh-users||2: { a: 1735689600000, p: 'fresh-users||2' }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/list-query-expiration/li.<"fresh-users||2>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 2, name: 'Fresh Item' }
      p: 'fresh-users||2'
    `);

    expect(
      getParsedOpfsFileData('tsdf/sess1/list-query-expiration/lq._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"fresh-users"}:
          a: 1735689600000
          p: { tableId: 'fresh-users' }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/list-query-expiration/lq.<{tableId:"fresh-users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: ['"fresh-users||2']`);
  });

  test('startup cleanup enforces maxQueries against preloaded persisted entries', async () => {
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
    listQueryScope.listQuery.setQueryStaticPolicy({ m: 2 });

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
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir-values tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir-values tsdf/sess1
             |    └ (session directory) entries=["dir:lq-startup-max-queries"]
      2.004s | 🗂️ list-dir-entries tsdf/sess1/lq-startup-max-queries
             |    └ (store directory) entries=["file:lq._i.r.json","file:lq.h~2817177027.p.json","file:lq.h~3601729766.p.json","file:lq.h~4141397404.p.json"]
      2.005s | 📖 #1 tsdf/sess1/lq-startup-max-queries/lq._i.r.json
             |    └ (queries index) | 0.43 kb
      2.008s | 🗑️ #2 ✅ tsdf/sess1/lq-startup-max-queries/lq.h~4141397404.p.json
             |    └ (query data, <{tableId:"first"}>)
      2.011s | ✍️ #1 tsdf/sess1/lq-startup-max-queries/lq._i.r.json
             |    └ (queries index) | 0.43 kb -> 0.30 kb
      2.013s | end
      "
    `);
    expect(
      getParsedOpfsFileData('tsdf/sess1/lq-startup-max-queries/lq._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"second"}:
          a: 1735689600100
          p: { tableId: 'second' }
        {tableId:"third"}:
          a: 1735689600200
          p: { tableId: 'third' }

      s: { m: 2 }
    `);
  });

  test('cold startup enforces the default list-query maxQueries policy before the store mounts', async () => {
    const storeName = 'lq-cold-default-max-queries';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    for (let index = 0; index <= 100; index++) {
      listQueryScope.listQuery.seedQuery({ tableId: `users-${index}` }, []);
      await advanceTime(10);
    }

    createDocumentEnv({ storeName: 'trigger-doc', sessionKey });
    await waitForScheduledCleanup();

    expect(
      listQueryScope.listQuery
        .listStoredQueryKeys()
        .sort((left, right) =>
          left.localeCompare(right, undefined, { numeric: true }),
        )
        .map((queryKey) =>
          queryKey.replace('{tableId:"', '').replace('"}', ''),
        ),
    ).toMatchInlineSnapshot(`
      - 'users-1'
      - 'users-2'
      - 'users-3'
      - 'users-4'
      - 'users-5'
      - 'users-6'
      - 'users-7'
      - 'users-8'
      - 'users-9'
      - 'users-10'
      - 'users-11'
      - 'users-12'
      - 'users-13'
      - 'users-14'
      - 'users-15'
      - 'users-16'
      - 'users-17'
      - 'users-18'
      - 'users-19'
      - 'users-20'
      - 'users-21'
      - 'users-22'
      - 'users-23'
      - 'users-24'
      - 'users-25'
      - 'users-26'
      - 'users-27'
      - 'users-28'
      - 'users-29'
      - 'users-30'
      - 'users-31'
      - 'users-32'
      - 'users-33'
      - 'users-34'
      - 'users-35'
      - 'users-36'
      - 'users-37'
      - 'users-38'
      - 'users-39'
      - 'users-40'
      - 'users-41'
      - 'users-42'
      - 'users-43'
      - 'users-44'
      - 'users-45'
      - 'users-46'
      - 'users-47'
      - 'users-48'
      - 'users-49'
      - 'users-50'
      - 'users-51'
      - 'users-52'
      - 'users-53'
      - 'users-54'
      - 'users-55'
      - 'users-56'
      - 'users-57'
      - 'users-58'
      - 'users-59'
      - 'users-60'
      - 'users-61'
      - 'users-62'
      - 'users-63'
      - 'users-64'
      - 'users-65'
      - 'users-66'
      - 'users-67'
      - 'users-68'
      - 'users-69'
      - 'users-70'
      - 'users-71'
      - 'users-72'
      - 'users-73'
      - 'users-74'
      - 'users-75'
      - 'users-76'
      - 'users-77'
      - 'users-78'
      - 'users-79'
      - 'users-80'
      - 'users-81'
      - 'users-82'
      - 'users-83'
      - 'users-84'
      - 'users-85'
      - 'users-86'
      - 'users-87'
      - 'users-88'
      - 'users-89'
      - 'users-90'
      - 'users-91'
      - 'users-92'
      - 'users-93'
      - 'users-94'
      - 'users-95'
      - 'users-96'
      - 'users-97'
      - 'users-98'
      - 'users-99'
      - 'users-100'
    `);
  });

  test('when maxQueries limit is reached the flush trims queries inline', async () => {
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
      storeName,
      sessionKey,
      maxQueries: 2,
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
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      1.81s  | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1.811s | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata (store directory)
      1.812s | 👁️ #1 file-open ✅ tsdf/sess1/lq-query-metadata/lq._i.r.json
             |    └ (queries index)
      1.813s | 📖 #1 tsdf/sess1/lq-query-metadata/lq._i.r.json
             |    └ (queries index) | 0.28 kb
             ·
      1.856s | 👁️ #2 file-open ❌ tsdf/sess1/lq-query-metadata/li._i.r.json
             |    └ (items index)
      .      | 📖 #1 tsdf/sess1/lq-query-metadata/lq._i.r.json
             |    └ (queries index) | 0.28 kb
      1.857s | 👁️ #3 file-open-or-create 🆕 tsdf/sess1/lq-query-metadata/li.h~4006559409.p.json
             |    └ (item data, <"third||1>)
      1.859s | 🗑️ #4 ✅ tsdf/sess1/lq-query-metadata/lq.h~4141397404.p.json
             |    └ (query data, <{tableId:"first"}>)
      .      | 👁️ #5 file-open-or-create 🆕 tsdf/sess1/lq-query-metadata/lq.h~3601729766.p.json
             |    └ (query data)
      1.86s  | ✍️ #3 tsdf/sess1/lq-query-metadata/li.h~4006559409.p.json
             |    └ (item data, <"third||1>) | 0.00 kb -> 0.09 kb
      1.862s | 👁️ #2 file-open-or-create 🆕 tsdf/sess1/lq-query-metadata/li._i.r.json
             |    └ (items index) ⚠️ DUPLICATE OPEN
      .      | ✍️ #5 tsdf/sess1/lq-query-metadata/lq.h~3601729766.p.json
             |    └ (query data) | 0.00 kb -> 0.04 kb
      1.865s | ✍️ #2 tsdf/sess1/lq-query-metadata/li._i.r.json
             |    └ (items index) | 0.00 kb -> 0.11 kb
      1.866s | ✍️ #1 tsdf/sess1/lq-query-metadata/lq._i.r.json
             |    └ (queries index) | 0.28 kb -> 0.30 kb
      1.868s | end
      "
    `);
    expect(getParsedOpfsFileData('tsdf/sess1/lq-query-metadata/li._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          "third||1: { a: 1735689604957, p: 'third||1' }
      `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-query-metadata/li.<"third||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Third' }
      p: 'third||1'
    `);
    expect(getParsedOpfsFileData('tsdf/sess1/lq-query-metadata/lq._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          {tableId:"second"}:
            a: 1735689600100
            p: { tableId: 'second' }
          {tableId:"third"}:
            a: 1735689604959
            p: { tableId: 'third' }

        s: { m: 2 }
      `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-query-metadata/lq.<{tableId:"third"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: ['"third||1']`);
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
      maxQueries: 2,
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
      1.812s | 👁️ #1 file-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/lq._i.r.json
             |    └ (queries index)
      1.813s | 📖 #1 tsdf/sess1/lq-coalesced-query-maintenance/lq._i.r.json
             |    └ (queries index) | 0.28 kb
             ·
      1.856s | 👁️ #2 file-open ❌ tsdf/sess1/lq-coalesced-query-maintenance/li._i.r.json
             |    └ (items index)
      .      | 📖 #1 tsdf/sess1/lq-coalesced-query-maintenance/lq._i.r.json
             |    └ (queries index) | 0.28 kb
      1.857s | 👁️ #3 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/li.h~4006559409.p.json
             |    └ (item data, <"third||1>)
      1.859s | 🗑️ #4 ✅ tsdf/sess1/lq-coalesced-query-maintenance/lq.h~4141397404.p.json
             |    └ (query data, <{tableId:"first"}>)
      .      | 👁️ #5 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/lq.h~3601729766.p.json
             |    └ (query data)
      1.86s  | ✍️ #3 tsdf/sess1/lq-coalesced-query-maintenance/li.h~4006559409.p.json
             |    └ (item data, <"third||1>) | 0.00 kb -> 0.09 kb
      1.862s | 👁️ #2 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/li._i.r.json
             |    └ (items index) ⚠️ DUPLICATE OPEN
      .      | ✍️ #5 tsdf/sess1/lq-coalesced-query-maintenance/lq.h~3601729766.p.json
             |    └ (query data) | 0.00 kb -> 0.04 kb
      1.865s | ✍️ #2 tsdf/sess1/lq-coalesced-query-maintenance/li._i.r.json
             |    └ (items index) | 0.00 kb -> 0.11 kb
      1.866s | ✍️ #1 tsdf/sess1/lq-coalesced-query-maintenance/lq._i.r.json
             |    └ (queries index) | 0.28 kb -> 0.30 kb
             ·
      3.62s  | 📖 #1 tsdf/sess1/lq-coalesced-query-maintenance/lq._i.r.json
             |    └ (queries index) | 0.30 kb
             ·
      3.663s | 📖 #1 tsdf/sess1/lq-coalesced-query-maintenance/lq._i.r.json
             |    └ (queries index) | 0.30 kb
      .      | 📖 #2 tsdf/sess1/lq-coalesced-query-maintenance/li._i.r.json
             |    └ (items index) | 0.11 kb
      3.666s | 🗑️ #6 ✅ tsdf/sess1/lq-coalesced-query-maintenance/lq.h~2817177027.p.json
             |    └ (query data)
      .      | 👁️ #7 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/lq.h~3370518832.p.json
             |    └ (query data, <{tableId:"fourth"}>)
      .      | 👁️ #8 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/li.h~1322690187.p.json
             |    └ (item data, <"fourth||2>)
      3.668s | ✍️ #3 tsdf/sess1/lq-coalesced-query-maintenance/li.h~4006559409.p.json
             |    └ (item data, <"third||1>) | 0.09 kb -> 0.15 kb
      3.669s | ✍️ #7 tsdf/sess1/lq-coalesced-query-maintenance/lq.h~3370518832.p.json
             |    └ (query data, <{tableId:"fourth"}>) | 0.00 kb -> 0.04 kb
      .      | ✍️ #8 tsdf/sess1/lq-coalesced-query-maintenance/li.h~1322690187.p.json
             |    └ (item data, <"fourth||2>) | 0.00 kb -> 0.09 kb
      3.673s | ✍️ #1 tsdf/sess1/lq-coalesced-query-maintenance/lq._i.r.json
             |    └ (queries index) | 0.30 kb -> 0.30 kb
      .      | ✍️ #2 tsdf/sess1/lq-coalesced-query-maintenance/li._i.r.json
             |    └ (items index) | 0.11 kb -> 0.21 kb
      3.675s | end
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
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      1.85s  | 📂 dir-open ❌ tsdf/sess1 (session directory)
      1.851s | 📁 dir-open-or-create 🆕 tsdf/sess1
             |    └ (session directory) ⚠️ DUPLICATE OPEN
      1.852s | 📁 dir-open-or-create 🆕 tsdf/sess1/lq-empty-query-manifest
             |    └ (store directory)
      1.853s | 👁️ #1 file-open-or-create 🆕 tsdf/sess1/lq-empty-query-manifest/lq.h~1731990418.p.json
             |    └ (query data)
      1.856s | ✍️ #1 tsdf/sess1/lq-empty-query-manifest/lq.h~1731990418.p.json
             |    └ (query data) | 0.00 kb -> 0.02 kb
      1.858s | 👁️ #2 file-open-or-create 🆕 tsdf/sess1/lq-empty-query-manifest/lq._i.r.json
             |    └ (queries index)
      1.861s | ✍️ #2 tsdf/sess1/lq-empty-query-manifest/lq._i.r.json
             |    └ (queries index) | 0.00 kb -> 0.38 kb
      1.863s | end
      "
    `);
    expect(
      getParsedOpfsFileData('tsdf/sess1/lq-empty-query-manifest/lq._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        {filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}:
          a: 1735689604851
          p:
            filters:
              - { field: 'name', op: 'eq', value: 'Missing user' }
            tableId: 'users'
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-empty-query-manifest/lq.<{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: []`);
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
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
      "
      time   |
      1.85s  | 📖 #1 tsdf/sess1/lq-query-becomes-empty/lq._i.r.json
             |    └ (queries index) | 0.14 kb
      .      | 📖 #2 tsdf/sess1/lq-query-becomes-empty/li._i.r.json
             |    └ (items index) | 0.11 kb
      1.855s | ✍️ #3 tsdf/sess1/lq-query-becomes-empty/lq.h~2902406637.p.json
             |    └ (query data, <{tableId:"users"}>) | 0.04 kb -> 0.02 kb
      .      | ✍️ #4 tsdf/sess1/lq-query-becomes-empty/li.h~228010772.p.json
             |    └ (item data, <"users||1>) | 0.10 kb -> 0.16 kb
      1.857s | end
      "
    `);
    expect(
      getParsedOpfsFileData('tsdf/sess1/lq-query-becomes-empty/li._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        "users||1: { a: 1735689600000, p: 'users||1' }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-query-becomes-empty/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Cached user' }
      lf: ['age', 'email', 'id', 'name']
      p: 'users||1'
    `);
    expect(
      getParsedOpfsFileData('tsdf/sess1/lq-query-becomes-empty/lq._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"users"}:
          a: 1735689600000
          p: { tableId: 'users' }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-query-becomes-empty/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: []`);
  });

  test('when maxItems limit is reached the flush trims items inline by recency without touching cold queries', async () => {
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

    const env = createListQueryEnv({ storeName, sessionKey, maxItems: 2 });

    // Drain the startup cleanup before capturing the maxItems flush.
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
             |    └ (items index) | 0.20 kb
             ·
      1.046s | 📖 #1 tsdf/sess1/lq-item-metadata/li._i.r.json
             |    └ (items index) | 0.20 kb
      1.049s | 🗑️ #2 ✅ tsdf/sess1/lq-item-metadata/li.h~228010772.p.json
             |    └ (item data, <"users||1>)
      .      | 👁️ #3 file-open-or-create 🆕 tsdf/sess1/lq-item-metadata/li.h~3224064498.p.json
             |    └ (item data, <"users||3>)
      1.052s | ✍️ #3 tsdf/sess1/lq-item-metadata/li.h~3224064498.p.json
             |    └ (item data, <"users||3>) | 0.00 kb -> 0.09 kb
      1.056s | ✍️ #1 tsdf/sess1/lq-item-metadata/li._i.r.json
             |    └ (items index) | 0.20 kb -> 0.22 kb
      1.058s | end
      "
    `);
  });

  test('maxItems-triggered flush re-evaluates mixed standalone and query-backed items using persisted recency', async () => {
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
      maxItems: 2,
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
    await flushAllTimers();

    await advanceTime(100);
    env.apiStore.addItemToState(rawItemPayload('standalone', 2), {
      id: 2,
      name: 'Expired newer',
    });
    await advanceTime(1100);
    await flushAllTimers();

    // Persist one query-backed item before introducing a second query-backed item.
    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    // Backdate the standalone entries so the later maxItems cleanup sees them as stale persisted candidates.
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
        lastAccessAt: expiredTimestamp,
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

    expect(
      listQueryScope.listQuery.listStoredItemKeys().sort(),
    ).toMatchInlineSnapshot(`['"admins||4', '"standalone||1']`);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-expired-during-max-items/li._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        "admins||4: { a: 1735689610121, p: 'admins||4' }
        "standalone||1: { a: 1735689610121, p: 'standalone||1' }

      s: { m: 2 }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-expired-during-max-items/lq._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"admins"}:
          a: 1735689610121
          p: { tableId: 'admins' }
        {tableId:"users"}:
          a: 1735689607154
          p: { tableId: 'users' }
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      1.81s  | 📖 #1 tsdf/sess1/lq-expired-during-max-items/li._i.r.json
             |    └ (items index) | 0.24 kb
             ·
      1.853s | 📖 #2 tsdf/sess1/lq-expired-during-max-items/lq._i.r.json
             |    └ (queries index) | 0.14 kb
      .      | 📖 #1 tsdf/sess1/lq-expired-during-max-items/li._i.r.json
             |    └ (items index) | 0.24 kb
      1.856s | 👁️ #3 file-open-or-create 🆕 tsdf/sess1/lq-expired-during-max-items/lq.h~2316387135.p.json
             |    └ (query data)
      .      | 🗑️ #4 ✅ tsdf/sess1/lq-expired-during-max-items/li.h~3224064498.p.json
             |    └ (item data, <"users||3>)
      .      | 🗑️ #5 ✅ tsdf/sess1/lq-expired-during-max-items/li.h~3111345837.p.json
             |    └ (item data, <"standalone||2>)
      .      | 👁️ #6 file-open-or-create 🆕 tsdf/sess1/lq-expired-during-max-items/li.h~2775221404.p.json
             |    └ (item data, <"standalone||1>)
      .      | 👁️ #7 file-open-or-create 🆕 tsdf/sess1/lq-expired-during-max-items/li.h~2792428996.p.json
             |    └ (item data, <"admins||4>)
      1.859s | ✍️ #3 tsdf/sess1/lq-expired-during-max-items/lq.h~2316387135.p.json
             |    └ (query data) | 0.00 kb -> 0.04 kb
      .      | ✍️ #6 tsdf/sess1/lq-expired-during-max-items/li.h~2775221404.p.json
             |    └ (item data, <"standalone||1>) | 0.00 kb -> 0.11 kb
      .      | ✍️ #7 tsdf/sess1/lq-expired-during-max-items/li.h~2792428996.p.json
             |    └ (item data, <"admins||4>) | 0.00 kb -> 0.12 kb
      1.863s | ✍️ #2 tsdf/sess1/lq-expired-during-max-items/lq._i.r.json
             |    └ (queries index) | 0.14 kb -> 0.28 kb
      .      | ✍️ #1 tsdf/sess1/lq-expired-during-max-items/li._i.r.json
             |    └ (items index) | 0.24 kb -> 0.25 kb
      1.865s | end
      "
    `);

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (1.19 kb)
      ├ sess1 (1.12 kb)
      │ └ lq-expired-during-max-items (1.11 kb)
      │   ├ li._i.r.json (0.27 kb)
      │   ├ li.h~2775221404.p.json (0.16 kb)
      │   ├ li.h~2792428996.p.json (0.17 kb)
      │   ├ lq._i.r.json (0.30 kb)
      │   ├ lq.h~2316387135.p.json (0.08 kb)
      │   └ lq.h~2902406637.p.json (0.08 kb)
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
      maxItems: 3,
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
    listQueryScope.listQuery.setItemStaticPolicy({ m: 3 });
    createDocumentEnv({ storeName: 'trigger-doc', sessionKey });

    // Let the startup-scheduled maintenance enforce maxItems against the preloaded cache.
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
        {filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}:
          a: 1735689600300
          p:
            filters:
              - { field: 'name', op: 'eq', value: 'Bob' }
            tableId: 'users'
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-shared-item-cleanup/lq.<{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: ['"users||1', '"users||2']`);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-shared-item-cleanup/lq.<{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: ['"users||1', '"users||3']`);
    expect(cleanupOperations).not.toContain('query data');
    expect(cleanupOperations).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir-values tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir-values tsdf/sess1
             |    └ (session directory) entries=["dir:lq-shared-item-cleanup"]
      2.004s | 🗂️ list-dir-entries tsdf/sess1/lq-shared-item-cleanup
             |    └ (store directory) entries=["file:li._i.r.json","file:li.h~1937155452.p.json","file:li.h~228010772.p.json","file:li.h~2854834066.p.json","file:li.h~3224064498.p.json","file:lq._i.r.json","file:lq.h~1471050956.p.json","file:lq.h~1805955701.p.json"]
      2.005s | 📖 #1 tsdf/sess1/lq-shared-item-cleanup/li._i.r.json
             |    └ (items index) | 0.41 kb
      2.008s | 📖 #2 tsdf/sess1/lq-shared-item-cleanup/lq._i.r.json
             |    └ (queries index) | 0.69 kb
      2.011s | 🗑️ #3 ✅ tsdf/sess1/lq-shared-item-cleanup/li.h~228010772.p.json
             |    └ (item data, <"users||1>)
      2.014s | ✍️ #1 tsdf/sess1/lq-shared-item-cleanup/li._i.r.json
             |    └ (items index) | 0.41 kb -> 0.32 kb
      2.016s | end
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
            a: 1735689601853
            p:
              filters:
                - { field: 'name', op: 'eq', value: 'Alice' }
              tableId: 'users'
          {tableId:"users"}:
            a: 1735689601853
            p: { tableId: 'users' }
      `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-delete-flow/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: ['"users||2']`);
    expect(getParsedOpfsFileData('tsdf/sess1/lq-delete-flow/lq._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          {filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}:
            a: 1735689601853
            p:
              filters:
                - { field: 'name', op: 'eq', value: 'Alice' }
              tableId: 'users'
          {tableId:"users"}:
            a: 1735689601853
            p: { tableId: 'users' }
      `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-delete-flow/lq.<{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: []`);
    expect(deleteOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.04s  | 📖 #1 tsdf/sess1/lq-delete-flow/lq._i.r.json
             |    └ (queries index) | 0.48 kb
      .      | 📖 #2 tsdf/sess1/lq-delete-flow/li._i.r.json (items index) | 0.20 kb
      1.043s | 🗑️ #3 ✅ tsdf/sess1/lq-delete-flow/li.h~228010772.p.json
             |    └ (item data, <"users||1>)
      1.045s | ✍️ #4 tsdf/sess1/lq-delete-flow/lq.h~2902406637.p.json
             |    └ (query data, <{tableId:"users"}>) | 0.06 kb -> 0.04 kb
      .      | ✍️ #5 tsdf/sess1/lq-delete-flow/lq.h~1805955701.p.json
             |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>) | 0.04 kb -> 0.02 kb
      .      | ✍️ #6 tsdf/sess1/lq-delete-flow/li.h~1937155452.p.json
             |    └ (item data, <"users||2>) | 0.08 kb -> 0.15 kb
      1.049s | ✍️ #2 tsdf/sess1/lq-delete-flow/li._i.r.json
             |    └ (items index) | 0.20 kb -> 0.11 kb
      1.051s | end
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
             |    └ (items index) | 0.11 kb
             ·
      1.046s | 📖 #1 tsdf/sess1/lq-cold-delete-flow/li._i.r.json
             |    └ (items index) | 0.11 kb
      1.049s | 🗑️ #2 ✅ tsdf/sess1/lq-cold-delete-flow/li.h~228010772.p.json
             |    └ (item data, <"users||1>)
      1.05s  | 🗑️ #1 ✅ tsdf/sess1/lq-cold-delete-flow/li._i.r.json (items index)
      1.051s | 🧹 del-dir ✅ tsdf/sess1/lq-cold-delete-flow (store directory)
      1.052s | 🧹 del-dir ✅ tsdf/sess1 (session directory)
      1.053s | end
      "
    `);
  });

  test('preloadQueryFromStorage hydrates the cached list query once and keeps later preloads and direct reads in memory', async () => {
    const storeName = 'lq-preload-query-state';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadQueryFromStorage(usersQuery),
      ),
    ).toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);
    expect(preloadCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/lq-preload-query-state (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/lq-preload-query-state/lq._i.r.json
           |    └ (queries index)
      3ms  | 📖 #1 tsdf/sess1/lq-preload-query-state/lq._i.r.json
           |    └ (queries index) | 0.14 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-preload-query-state/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>)
      7ms  | 📖 #2 tsdf/sess1/lq-preload-query-state/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>) | 0.04 kb
      10ms | 👁️ #3 file-open ✅ tsdf/sess1/lq-preload-query-state/li._i.r.json
           |    └ (items index)
      11ms | 📖 #3 tsdf/sess1/lq-preload-query-state/li._i.r.json
           |    └ (items index) | 0.11 kb
      14ms | 👁️ #4 file-open ✅ tsdf/sess1/lq-preload-query-state/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      15ms | 📖 #4 tsdf/sess1/lq-preload-query-state/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.10 kb
      18ms | end
      "
    `);

    // Once preloaded, repeated explicit preload calls should reuse in-memory state without new storage work.
    const repeatedPreloadCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadQueryFromStorage(usersQuery),
      ),
    ).toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);
    await advanceTime(100);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadQueryFromStorage(usersQuery),
      ),
    ).toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);
    await advanceTime(100);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadQueryFromStorage(usersQuery),
      ),
    ).toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);
    expect(
      repeatedPreloadCapture.finish().timelineString,
    ).toMatchInlineSnapshot(`"empty"`);

    // Repeated direct reads should also reuse in-memory query and item state without new storage work.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
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
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(operationsBreakdown).toMatchInlineSnapshot(`"empty"`);
  });

  test('preloadItemFromStorage hydrates the cached standalone list-query item once and keeps later preloads and direct reads in memory', async () => {
    const storeName = 'lq-preload-item-state';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 1)),
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||1', preloaded: '✅' }`);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 2)),
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||2', preloaded: '✅' }`);
    expect(preloadCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/lq-preload-item-state (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/lq-preload-item-state/li._i.r.json
           |    └ (items index)
      3ms  | 📖 #1 tsdf/sess1/lq-preload-item-state/li._i.r.json
           |    └ (items index) | 0.20 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-preload-item-state/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      7ms  | 📖 #2 tsdf/sess1/lq-preload-item-state/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.10 kb
      10ms | 📖 #1 tsdf/sess1/lq-preload-item-state/li._i.r.json
           |    └ (items index) | 0.20 kb ⚠️ REPEATED READ <10ms UNCHANGED
      13ms | 👁️ #3 file-open ✅ tsdf/sess1/lq-preload-item-state/li.h~1937155452.p.json
           |    └ (item data, <"users||2>)
      14ms | 📖 #3 tsdf/sess1/lq-preload-item-state/li.h~1937155452.p.json
           |    └ (item data, <"users||2>) | 0.11 kb
      17ms | end
      "
    `);

    // Once preloaded, repeated explicit preload calls should reuse in-memory state without new storage work.
    const repeatedPreloadCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 1)),
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||1', preloaded: '✅' }`);
    await advanceTime(100);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 1)),
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||1', preloaded: '✅' }`);
    await advanceTime(100);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 1)),
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||1', preloaded: '✅' }`);
    expect(
      repeatedPreloadCapture.finish().timelineString,
    ).toMatchInlineSnapshot(`"empty"`);

    // Repeated direct reads should also reuse in-memory state without new storage work.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
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
    await flushAllTimers();
    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(
      `"empty"`,
    );
  });

  test('useListQuery invalidation snapshots the full query persistence timeline through the refetch save', async () => {
    const storeName = 'lq-query-invalidation-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
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
      getParsedOpfsFileData(
        'tsdf/sess1/lq-query-invalidation-flow/lq._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"users"}:
          a: 1735689600000
          p: { tableId: 'users' }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-query-invalidation-flow/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: ['"users||1']`);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.85s  | 📖 #1 tsdf/sess1/lq-query-invalidation-flow/li._i.r.json
             |    └ (items index) | 0.11 kb
      1.855s | ✍️ #2 tsdf/sess1/lq-query-invalidation-flow/li.h~228010772.p.json
             |    └ (item data, <"users||1>) | 0.10 kb -> 0.16 kb
      1.857s | end
      "
    `);
  });

  test('repeated invalidations within the debounce window coalesce list-query persistence writes', async () => {
    const storeName = 'lq-coalesced-invalidations';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.updateItem('users||1', { name: 'Fresh user 2' });
      env.apiStore.invalidateQueryAndItems({
        queryPayload: usersQuery,
        itemPayload: false,
      });
    });
    await advanceTime(1900);
    await flushAllTimers();
    const secondInvalidationOperations =
      secondInvalidationCapture.finish().timelineString;

    expect(hook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Fresh user 2' }`,
    );
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-coalesced-invalidations/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Fresh user 2' }
      lf: ['age', 'email', 'id', 'name']
      p: 'users||1'
    `);
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.85s  | 📖 #1 tsdf/sess1/lq-coalesced-invalidations/li._i.r.json
             |    └ (items index) | 0.11 kb
      1.855s | ✍️ #2 tsdf/sess1/lq-coalesced-invalidations/li.h~228010772.p.json
             |    └ (item data, <"users||1>) | 0.10 kb -> 0.16 kb
      1.857s | end
      "
    `);
  });

  test('list-query invalidation preserves offline markers added by another tab before item and query manifest updates', async () => {
    const storeName = 'lq-offline-marker-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
    markEntryOfflineProtected(mockAdapter, itemStorageKey);
    markEntryOfflineProtected(mockAdapter, queryStorageKey);

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
      getParsedOpfsFileData('tsdf/sess1/lq-offline-marker-flow/li._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        "users||1: { a: 1735689600000, o: '✅', p: 'users||1' }
        "users||2: { a: 1735689606971, p: 'users||2' }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-offline-marker-flow/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Fresh user' }
      lf: ['age', 'email', 'id', 'name']
      p: 'users||1'
    `);
    expect(
      getParsedOpfsFileData('tsdf/sess1/lq-offline-marker-flow/lq._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"users"}:
          a: 1735689600000
          o: '✅'
          p: { tableId: 'users' }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-offline-marker-flow/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: ['"users||1', '"users||2']`);
  });

  test('query hook remount skips touch writes when the cached query and item are still in the current recency bucket', async () => {
    const storeName = 'lq-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/lq-remount-flow (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/lq-remount-flow/lq._i.r.json
           |    └ (queries index)
      3ms  | 📖 #1 tsdf/sess1/lq-remount-flow/lq._i.r.json
           |    └ (queries index) | 0.14 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-remount-flow/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>)
      7ms  | 📖 #2 tsdf/sess1/lq-remount-flow/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>) | 0.04 kb
      10ms | 👁️ #3 file-open ✅ tsdf/sess1/lq-remount-flow/li._i.r.json
           |    └ (items index)
      11ms | 📖 #3 tsdf/sess1/lq-remount-flow/li._i.r.json
           |    └ (items index) | 0.11 kb
      14ms | 👁️ #4 file-open ✅ tsdf/sess1/lq-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      15ms | 📖 #4 tsdf/sess1/lq-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.10 kb
      18ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('query hook remount reuses a persisted empty query without treating it as a cache miss', async () => {
    const storeName = 'lq-empty-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/lq-empty-remount-flow (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/lq-empty-remount-flow/lq._i.r.json
           |    └ (queries index)
      3ms  | 📖 #1 tsdf/sess1/lq-empty-remount-flow/lq._i.r.json
           |    └ (queries index) | 0.14 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-empty-remount-flow/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>)
      7ms  | 📖 #2 tsdf/sess1/lq-empty-remount-flow/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>) | 0.02 kb
      10ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('query hydration does not skip stale query and item touches once they fall outside the current recency bucket', async () => {
    const storeName = 'lq-remount-stale-touch';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/lq-remount-stale-touch (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/lq-remount-stale-touch/lq._i.r.json
           |    └ (queries index)
      3ms  | 📖 #1 tsdf/sess1/lq-remount-stale-touch/lq._i.r.json
           |    └ (queries index) | 0.14 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-remount-stale-touch/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>)
      7ms  | 📖 #2 tsdf/sess1/lq-remount-stale-touch/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>) | 0.04 kb
      10ms | 👁️ #3 file-open ✅ tsdf/sess1/lq-remount-stale-touch/li._i.r.json
           |    └ (items index)
      11ms | 📖 #3 tsdf/sess1/lq-remount-stale-touch/li._i.r.json
           |    └ (items index) | 0.11 kb
      14ms | 👁️ #4 file-open ✅ tsdf/sess1/lq-remount-stale-touch/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      15ms | 📖 #4 tsdf/sess1/lq-remount-stale-touch/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.10 kb
           ·
      50ms | 📖 #1 tsdf/sess1/lq-remount-stale-touch/lq._i.r.json
           |    └ (queries index) | 0.14 kb
      55ms | ✍️ #1 tsdf/sess1/lq-remount-stale-touch/lq._i.r.json
           |    └ (queries index) | 0.14 kb -> 0.14 kb
      58ms | 📖 #3 tsdf/sess1/lq-remount-stale-touch/li._i.r.json
           |    └ (items index) | 0.11 kb
      63ms | ✍️ #3 tsdf/sess1/lq-remount-stale-touch/li._i.r.json
           |    └ (items index) | 0.11 kb -> 0.11 kb
      65ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useItem invalidation snapshots the full item persistence timeline through the refetch save', async () => {
    const storeName = 'lq-item-invalidation-flow';
    const sessionKey = 'sess1';
    const itemPayload = rawItemPayload('users', 1);
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
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
      getParsedOpfsFileData(
        'tsdf/sess1/lq-item-invalidation-flow/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Fresh user' }
      lf: ['age', 'email', 'id', 'name']
      p: 'users||1'
    `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.85s  | 📖 #1 tsdf/sess1/lq-item-invalidation-flow/li._i.r.json
             |    └ (items index) | 0.11 kb
      1.855s | ✍️ #2 tsdf/sess1/lq-item-invalidation-flow/li.h~228010772.p.json
             |    └ (item data, <"users||1>) | 0.10 kb -> 0.16 kb
      1.857s | end
      "
    `);
  });

  test('item hook remount skips the touch write when the cached standalone item is still in the current recency bucket', async () => {
    const storeName = 'lq-item-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/lq-item-remount-flow (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/lq-item-remount-flow/li._i.r.json
           |    └ (items index)
      3ms  | 📖 #1 tsdf/sess1/lq-item-remount-flow/li._i.r.json
           |    └ (items index) | 0.11 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-item-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      7ms  | 📖 #2 tsdf/sess1/lq-item-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.10 kb
      10ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useMultipleItems remount reuses hydrated standalone list-query items without touching localStorage again', async () => {
    const storeName = 'lq-multi-item-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/lq-multi-item-remount-flow
           |    └ (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/lq-multi-item-remount-flow/li._i.r.json
           |    └ (items index)
      3ms  | 📖 #1 tsdf/sess1/lq-multi-item-remount-flow/li._i.r.json
           |    └ (items index) | 0.20 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-multi-item-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      .    | 👁️ #3 file-open ✅ tsdf/sess1/lq-multi-item-remount-flow/li.h~1937155452.p.json
           |    └ (item data, <"users||2>)
      7ms  | 📖 #2 tsdf/sess1/lq-multi-item-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.10 kb
      .    | 📖 #3 tsdf/sess1/lq-multi-item-remount-flow/li.h~1937155452.p.json
           |    └ (item data, <"users||2>) | 0.10 kb
      10ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useMultipleListQueries remount reuses hydrated queries without touching localStorage again', async () => {
    const storeName = 'lq-multi-query-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const mockAdapter = createOpfsPersistentStorageTestStore({});
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
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      .    | 📂 dir-open ✅ tsdf/sess1 (session directory) ⚠️ DUPLICATE OPEN
      1ms  | 📂 dir-open ✅ tsdf/sess1/lq-multi-query-remount-flow
           |    └ (store directory)
      .    | 📂 dir-open ✅ tsdf/sess1/lq-multi-query-remount-flow
           |    └ (store directory) ⚠️ DUPLICATE OPEN
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/lq._i.r.json
           |    └ (queries index)
      .    | 👁️ #1 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/lq._i.r.json
           |    └ (queries index) ⚠️ DUPLICATE OPEN
      3ms  | 📖 #1 tsdf/sess1/lq-multi-query-remount-flow/lq._i.r.json
           |    └ (queries index) | 0.28 kb
      .    | 📖 #1 tsdf/sess1/lq-multi-query-remount-flow/lq._i.r.json
           |    └ (queries index) | 0.28 kb ⚠️ REPEATED READ <10ms UNCHANGED
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>)
      .    | 👁️ #3 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/lq.h~2044383828.p.json
           |    └ (query data, <{tableId:"projects"}>)
      7ms  | 📖 #2 tsdf/sess1/lq-multi-query-remount-flow/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>) | 0.04 kb
      .    | 📖 #3 tsdf/sess1/lq-multi-query-remount-flow/lq.h~2044383828.p.json
           |    └ (query data, <{tableId:"projects"}>) | 0.04 kb
      10ms | 👁️ #4 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/li._i.r.json
           |    └ (items index)
      .    | 👁️ #4 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/li._i.r.json
           |    └ (items index) ⚠️ DUPLICATE OPEN
      11ms | 📖 #4 tsdf/sess1/lq-multi-query-remount-flow/li._i.r.json
           |    └ (items index) | 0.21 kb
      .    | 📖 #4 tsdf/sess1/lq-multi-query-remount-flow/li._i.r.json
           |    └ (items index) | 0.21 kb ⚠️ REPEATED READ <10ms UNCHANGED
      14ms | 👁️ #5 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      .    | 👁️ #6 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/li.h~2924752681.p.json
           |    └ (item data, <"projects||1>)
      15ms | 📖 #5 tsdf/sess1/lq-multi-query-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.10 kb
      .    | 📖 #6 tsdf/sess1/lq-multi-query-remount-flow/li.h~2924752681.p.json
           |    └ (item data, <"projects||1>) | 0.11 kb
      18ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('updating a hydrated list-query item writes the mutation without rereading cached entries', async () => {
    const storeName = 'lq-mutation-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({});
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
    await flushAllTimers();

    // Mutating the already-hydrated item should only need writes.
    const mutationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.apiStore.updateItemState(rawItemPayload('users', 1), (draft) => {
        draft.name = 'Edited user';
      });
    });
    await advanceTime(1100);
    await flushAllTimers();
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-mutation-flow/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Edited user' }
      lf: ['age', 'email', 'id', 'name']
      p: 'users||1'
    `);
    expect(getParsedOpfsFileData('tsdf/sess1/lq-mutation-flow/li._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          "users||1: { a: 1735689600000, p: 'users||1' }
      `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.04s  | 📖 #1 tsdf/sess1/lq-mutation-flow/li._i.r.json
             |    └ (items index) | 0.11 kb
      1.045s | ✍️ #2 tsdf/sess1/lq-mutation-flow/li.h~228010772.p.json
             |    └ (item data, <"users||1>) | 0.10 kb -> 0.16 kb
      1.047s | end
      "
    `);
  });

  test('list query preload reads only the requested query and its referenced items', async () => {
    const storeName = 'list-query-opfs-efficiency';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
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
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await resolveAfterAllTimers(preloadPromise);

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-efficiency
           |    └ (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/list-query-opfs-efficiency/lq._i.r.json
           |    └ (queries index)
      3ms  | 📖 #1 tsdf/sess1/list-query-opfs-efficiency/lq._i.r.json
           |    └ (queries index) | 0.28 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/list-query-opfs-efficiency/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>)
      7ms  | 📖 #2 tsdf/sess1/list-query-opfs-efficiency/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>) | 0.06 kb
      10ms | 👁️ #3 file-open ✅ tsdf/sess1/list-query-opfs-efficiency/li._i.r.json
           |    └ (items index)
      11ms | 📖 #3 tsdf/sess1/list-query-opfs-efficiency/li._i.r.json
           |    └ (items index) | 0.31 kb
      14ms | 👁️ #4 file-open ✅ tsdf/sess1/list-query-opfs-efficiency/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      .    | 👁️ #5 file-open ✅ tsdf/sess1/list-query-opfs-efficiency/li.h~1937155452.p.json
           |    └ (item data, <"users||2>)
      15ms | 📖 #4 tsdf/sess1/list-query-opfs-efficiency/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.09 kb
      .    | 📖 #5 tsdf/sess1/list-query-opfs-efficiency/li.h~1937155452.p.json
           |    └ (item data, <"users||2>) | 0.09 kb
      18ms | end
      "
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
    expect(mockAdapter.payloadGetManyRequests.flat()).toContain(usersQueryKey);
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
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const env = createListQueryEnv({
      storeName,
      sessionKey,
      maxItems: 2,
      maxQueries: 2,
      serverData: {
        users: [{ id: 1, name: 'User 1' }],
        projects: [{ id: 1, name: 'Project 1' }],
        tasks: [{ id: 1, name: 'Task 1' }],
      },
    });

    await settleStartupBackgroundScan(mockAdapter);

    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    env.scheduleFetch('highPriority', projectsQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    mockAdapter.clearInstrumentation();
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);

    env.scheduleFetch('highPriority', tasksQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time   |
      1.81s  | 📖 #1 tsdf/sess1/list-query-opfs-eviction-efficiency/lq._i.r.json
             |    └ (queries index) | 0.31 kb
             ·
      1.853s | 📖 #2 tsdf/sess1/list-query-opfs-eviction-efficiency/li._i.r.json
             |    └ (items index) | 0.24 kb
      1.858s | ✍️ #3 tsdf/sess1/list-query-opfs-eviction-efficiency/li.h~2924752681.p.json
             |    └ (item data, <"projects||1>) | 0.10 kb -> 0.16 kb
      1.86s  | end
      "
    `);
    expect(mockAdapter.payloadGetRequests).toMatchInlineSnapshot(`[]`);
    expect(mockAdapter.payloadGetManyRequests).toMatchInlineSnapshot(`[]`);
  });
});
