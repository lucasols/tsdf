import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import type { ListQueryParams } from '../../mocks/listQueryStoreTestEnv';
import {
  advanceTime,
} from '../../utils/genericTestUtils';
import { createIndexedDbPersistentStorageTestStore } from '../../utils/indexedDbPersistentStorageTestStore';
import {
  getIndexedDbStructureSnapshot,
  getParsedIndexedDbRecordData,
  getParsedTsdfIndexedDbRecordData,
  startIndexedDbPersistentStorageOperationCapture,
} from '../../utils/indexedDbPersistentStorageOptimizationTestUtils';
import {
  captureHookRemount,
  createDocumentEnv,
  createListQueryEnv,
  flushInvalidationPersistence,
  markEntryOfflineProtected,
  rawItemPayload,
  resolveAfterIndexedDbStorage,
  settleIndexedDbStorage,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  storeItemKey,
  waitForScheduledCleanup,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

async function readListQueryItemEntryRow(args: {
  id: number | string;
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  sessionKey: string;
  storeName: string;
  tableId: string;
}) {
  const scope = args.mockAdapter.scope(args.storeName, args.sessionKey);
  return getParsedIndexedDbRecordData(args.mockAdapter, {
    key: [
      args.sessionKey,
      args.storeName,
      'listQuery.item',
      scope.listQuery.itemKey(args.tableId, args.id),
    ],
    storeName: 'entries',
  });
}

async function readListQueryQueryEntryRow(args: {
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  params: unknown;
  sessionKey: string;
  storeName: string;
}) {
  const scope = args.mockAdapter.scope(args.storeName, args.sessionKey);
  return getParsedIndexedDbRecordData(args.mockAdapter, {
    key: [
      args.sessionKey,
      args.storeName,
      'listQuery.query',
      scope.listQuery.queryKey(args.params),
    ],
    storeName: 'entries',
  });
}

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
    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
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
      ""
      2.008s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","list-query-expiration","listQuery.item"], ["sess1","list-query-expiration","listQuery.query"]]
      2.013s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-expiration","listQuery.item"] -> keys=2 exists=yes valid=yes
      2.013s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-expiration","listQuery.query"] -> keys=2 exists=yes valid=yes
      2.016s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","list-query-expiration","listQuery.item"] keys=["\\"expired-users||1"]
      2.019s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","list-query-expiration","listQuery.query"] keys=["{tableId:\\"expired-users\\"}"]
      2.024s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","list-query-expiration","listQuery.item"] keys=1
      2.027s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","list-query-expiration","listQuery.query"] keys=1
      ""
    `);

    expect(await getIndexedDbStructureSnapshot(mockAdapter)).toMatchInlineSnapshot(`
      stores:
        - autoIncrement: '❌'
          indexes:
            - keyPath: ['s', 'n', 't', 'g', 'k']
              multiEntry: '❌'
              name: 'byScopeGroup'
              unique: '❌'
            - keyPath: ['s', 'n', 't', 'a', 'k']
              multiEntry: '❌'
              name: 'byScopeLastAccessAt'
              unique: '❌'
            - { keyPath: 's', multiEntry: '❌', name: 'bySession', unique: '❌' }
            - keyPath: ['s', 'o', 'n', 't', 'k']
              multiEntry: '❌'
              name: 'bySessionOfflineProtected'
              unique: '❌'
          keyPath: ['s', 'n', 't', 'k']
          name: 'entries'
          rowCount: 2
          rows:
            - key: ['sess1', 'list-query-expiration', 'listQuery.item', '"fresh-users||2']
              value: 'JSON object | 0.4 kb'
            - key: ['sess1', 'list-query-expiration', 'listQuery.query', '{tableId:"fresh-users"}']
              value: 'JSON object | 0.4 kb'
        - autoIncrement: '❌'
          indexes: []
          keyPath: 'k'
          name: 'meta'
          rowCount: 0
          rows: []
        - autoIncrement: '❌'
          indexes:
            - { keyPath: 's', multiEntry: '❌', name: 'bySession', unique: '❌' }
          keyPath: ['s', 'n', 't']
          name: 'namespacePolicies'
          rowCount: 0
          rows: []
      version: 1
    `);

    expect(
      await readListQueryItemEntryRow({
        id: 2,
        mockAdapter,
        sessionKey,
        storeName,
        tableId: 'fresh-users',
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689600000

      d:
        d: { id: 2, name: 'Fresh Item' }
        p: 'fresh-users||2'

      k: '"fresh-users||2'
      m: { p: 'fresh-users||2' }
      n: 'list-query-expiration'
      o: 0
      s: 'sess1'
      t: 'listQuery.item'
      v: 1
    `);

    expect(
      await readListQueryQueryEntryRow({
        mockAdapter,
        params: freshQueryParams,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689600000

      d:
        i: ['"fresh-users||2']

      k: '{tableId:"fresh-users"}'
      m:
        p: { tableId: 'fresh-users' }

      n: 'list-query-expiration'
      o: 0
      s: 'sess1'
      t: 'listQuery.query'
      v: 1
    `);
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
    listQueryScope.listQuery.setQueryStaticPolicy({ m: 2 });

    // Startup should only schedule the cleanup work.
    const startupOperationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    createDocumentEnv({ storeName: 'trigger-doc', sessionKey });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the startup pass runs, it should evict only the oldest persisted query.
    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listQueryScope.listQuery.listStoredQueryKeys().sort(),
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
      await readListQueryNamespacePolicyRow({
        kind: 'listQuery.query',
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      n: 'lq-startup-max-queries'
      p: { maxEntries: 2 }
      s: 'sess1'
      t: 'listQuery.query'
    `);
  });

  test('cold startup enforces the default list-query maxQueries policy before the store mounts', async () => {
    const storeName = 'lq-cold-default-max-queries';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
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
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
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
    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    env.scheduleFetch('highPriority', thirdQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listQueryScope.listQuery.listStoredQueryKeys().sort(),
    ).toMatchInlineSnapshot(`['{tableId:"second"}', '{tableId:"third"}']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      1.814s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-query-metadata","listQuery.query"]]
      1.82s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-metadata","listQuery.query"] -> keys=2 exists=yes valid=yes
      1.823s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-query-metadata","listQuery.query"] order=lru-desc -> ["{tableId:\\"second\\"}", "{tableId:\\"first\\"}"]
      1.827s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-query-metadata","listQuery.query"]]
      1.833s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-metadata","listQuery.query"] -> keys=2 exists=yes valid=yes
      1.838s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-query-metadata","listQuery.query"]]
      1.838s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-query-metadata","listQuery.query"]]
      1.847s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-metadata","listQuery.query"] -> keys=2 exists=yes valid=yes
      1.847s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-metadata","listQuery.query"] -> keys=2 exists=yes valid=yes
      1.894s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-query-metadata","listQuery.query"] put=["{tableId:\\"third\\"}"] delete=["{tableId:\\"first\\"}"] touch=[] static-policy
      1.899s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-query-metadata","listQuery.item"] put=["\\"third||1"] delete=[] touch=[] static-policy
      1.906s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-query-metadata","listQuery.item"], ["sess1","lq-query-metadata","listQuery.query"]]
      1.906s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-query-metadata","listQuery.item"], ["sess1","lq-query-metadata","listQuery.query"]]
      1.912s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-metadata","listQuery.item"] -> keys=1 exists=yes valid=yes
      1.912s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-metadata","listQuery.item"] -> keys=1 exists=yes valid=yes
      1.921s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-metadata","listQuery.query"] -> keys=2 exists=yes valid=yes
      1.921s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-metadata","listQuery.query"] -> keys=2 exists=yes valid=yes
      ""
    `);
    expect(getParsedTsdfIndexedDbRecordData('tsdf/sess1/lq-query-metadata/li._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          "third||1: { a: 1735689604987, p: 'third||1' }
      `);
    expect(
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-query-metadata/li.<"third||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Third' }
      p: 'third||1'
    `);
    expect(getParsedTsdfIndexedDbRecordData('tsdf/sess1/lq-query-metadata/lq._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          {tableId:"second"}:
            a: 1735689600100
            p: { tableId: 'second' }
          {tableId:"third"}:
            a: 1735689604987
            p: { tableId: 'third' }

        s: { maxEntries: 2 }
      `);
    expect(
      getParsedTsdfIndexedDbRecordData(
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
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
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

    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);

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

    expect(
      listQueryScope.listQuery.listStoredQueryKeys().sort(),
    ).toMatchInlineSnapshot(`['{tableId:"second"}', '{tableId:"third"}']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      2.624s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-coalesced-query-maintenance","listQuery.query"]]
      2.633s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-coalesced-query-maintenance","listQuery.query"] -> keys=2 exists=yes valid=yes
      2.637s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-coalesced-query-maintenance","listQuery.query"] order=lru-desc -> ["{tableId:\\"second\\"}", "{tableId:\\"first\\"}"]
      2.642s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-coalesced-query-maintenance","listQuery.query"]]
      2.651s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-coalesced-query-maintenance","listQuery.query"] -> keys=2 exists=yes valid=yes
      3.624s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-coalesced-query-maintenance","listQuery.query"]]
      3.624s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-coalesced-query-maintenance","listQuery.query"]]
      3.624s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-coalesced-query-maintenance","listQuery.query"]]
      3.63s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-coalesced-query-maintenance","listQuery.query"] -> keys=2 exists=yes valid=yes
      3.63s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-coalesced-query-maintenance","listQuery.query"] -> keys=2 exists=yes valid=yes
      3.63s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-coalesced-query-maintenance","listQuery.query"] -> keys=2 exists=yes valid=yes
      3.636s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-coalesced-query-maintenance","listQuery.query"] put=["{tableId:\\"third\\"}"] delete=["{tableId:\\"first\\"}"] touch=[] static-policy
      3.639s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-coalesced-query-maintenance","listQuery.query"] order=lru-desc -> ["{tableId:\\"third\\"}", "{tableId:\\"second\\"}"]
      3.641s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-coalesced-query-maintenance","listQuery.query"]]
      3.644s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-coalesced-query-maintenance","listQuery.query"]]
      3.647s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-coalesced-query-maintenance","listQuery.query"] -> keys=2 exists=yes valid=yes
      3.65s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-coalesced-query-maintenance","listQuery.query"] -> keys=2 exists=yes valid=yes
      3.674s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-coalesced-query-maintenance","listQuery.item"] put=["\\"third||1"] delete=[] touch=[] static-policy
      3.68s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-coalesced-query-maintenance","listQuery.item"], ["sess1","lq-coalesced-query-maintenance","listQuery.query"]]
      3.684s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-coalesced-query-maintenance","listQuery.item"] -> keys=1 exists=yes valid=yes
      3.69s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-coalesced-query-maintenance","listQuery.query"] -> keys=2 exists=yes valid=yes
      ""
    `);
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

    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    env.scheduleFetch('highPriority', usersQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();
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
      ""
      1.812s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> []
      1.856s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-empty-query-manifest","listQuery.query"] put=["{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Missing user\\"}],tableId:\\"users\\"}"] delete=[] touch=[] static-policy
      1.859s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-empty-query-manifest","listQuery.query"]]
      1.863s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-empty-query-manifest","listQuery.query"] -> keys=1 exists=yes valid=yes
      ""
    `);
    expect(
      getParsedTsdfIndexedDbRecordData('tsdf/sess1/lq-empty-query-manifest/lq._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        {filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}:
          a: 1735689604852
          p:
            filters:
              - { field: 'name', op: 'eq', value: 'Missing user' }
            tableId: 'users'
    `);
    expect(
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-empty-query-manifest/lq.<{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: []`);
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
      1.814s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-query-becomes-empty","listQuery.item"], ["sess1","lq-query-becomes-empty","listQuery.query"]]
      1.814s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-query-becomes-empty","listQuery.item"], ["sess1","lq-query-becomes-empty","listQuery.query"]]
      1.818s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-becomes-empty","listQuery.item"] -> keys=1 exists=yes valid=yes
      1.818s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-becomes-empty","listQuery.item"] -> keys=1 exists=yes valid=yes
      1.822s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-becomes-empty","listQuery.query"] -> keys=1 exists=yes valid=yes
      1.822s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-becomes-empty","listQuery.query"] -> keys=1 exists=yes valid=yes
      1.866s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-query-becomes-empty","listQuery.query"] put=["{tableId:\\"users\\"}"] delete=[] touch=[] static-policy
      1.87s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-query-becomes-empty","listQuery.item"] put=["\\"users||1"] delete=[] touch=[] static-policy
      1.874s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-query-becomes-empty","listQuery.item"], ["sess1","lq-query-becomes-empty","listQuery.query"]]
      1.875s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-query-becomes-empty","listQuery.item"], ["sess1","lq-query-becomes-empty","listQuery.query"]]
      1.878s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-becomes-empty","listQuery.item"] -> keys=1 exists=yes valid=yes
      1.879s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-becomes-empty","listQuery.item"] -> keys=1 exists=yes valid=yes
      1.882s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-becomes-empty","listQuery.query"] -> keys=1 exists=yes valid=yes
      1.883s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-becomes-empty","listQuery.query"] -> keys=1 exists=yes valid=yes
      ""
    `);
    expect(
      getParsedTsdfIndexedDbRecordData('tsdf/sess1/lq-query-becomes-empty/li._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        "users||1: { a: 1735689600000, p: 'users||1' }
    `);
    expect(
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-query-becomes-empty/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Cached user' }
      lf: ['age', 'email', 'id', 'name']
      p: 'users||1'
    `);
    expect(
      getParsedTsdfIndexedDbRecordData('tsdf/sess1/lq-query-becomes-empty/lq._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"users"}:
          a: 1735689600000
          p: { tableId: 'users' }
    `);
    expect(
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-query-becomes-empty/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: []`);
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

    const env = createListQueryEnv({ storeName, sessionKey, maxItems: 2 });

    // Drain the startup cleanup before capturing the maxItems flush.
    await settleStartupBackgroundScan(mockAdapter);

    // Adding a third item should snapshot the inline trim end-to-end.
    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.addItemToState(rawItemPayload('users', 3), {
      id: 3,
      name: 'Fresh',
    });
    await advanceTime(1100);
    await settleIndexedDbStorage();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listQueryScope.listQuery.listStoredItemKeys().sort(),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);
    expect(operationsBreakdown).not.toContain('query data');
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      1.105s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-item-metadata","listQuery.item"], ["sess1","lq-item-metadata","listQuery.query"]]
      1.111s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-item-metadata","listQuery.item"] -> keys=2 exists=yes valid=yes
      1.115s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-item-metadata","listQuery.query"] -> keys=1 exists=yes valid=yes
      1.118s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-item-metadata","listQuery.item"] order=lru-desc -> ["\\"users||2", "\\"users||1"]
      1.123s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-item-metadata","listQuery.item"], ["sess1","lq-item-metadata","listQuery.query"]]
      1.129s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-item-metadata","listQuery.item"] -> keys=2 exists=yes valid=yes
      1.133s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-item-metadata","listQuery.query"] -> keys=1 exists=yes valid=yes
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
    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    env.scheduleFetch('highPriority', adminsQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listQueryScope.listQuery.listStoredItemKeys().sort(),
    ).toMatchInlineSnapshot(`['"admins||4', '"standalone||1']`);
    expect(
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-expired-during-max-items/li._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        "admins||4: { a: 1735689610215, p: 'admins||4' }
        "standalone||1: { a: 1735689610215, p: 'standalone||1' }

      s: { maxEntries: 2 }
    `);
    expect(
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-expired-during-max-items/lq._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"admins"}:
          a: 1735689610215
          p: { tableId: 'admins' }
        {tableId:"users"}:
          a: 1735689607262
          p: { tableId: 'users' }
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      1.816s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-expired-during-max-items","listQuery.item"], ["sess1","lq-expired-during-max-items","listQuery.query"]]
      1.822s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-expired-during-max-items","listQuery.item"] -> keys=2 exists=yes valid=yes
      1.826s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-expired-during-max-items","listQuery.query"] -> keys=1 exists=yes valid=yes
      1.829s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-expired-during-max-items","listQuery.item"] order=lru-desc -> ["\\"users||3", "\\"standalone||2"]
      1.835s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-expired-during-max-items","listQuery.item"], ["sess1","lq-expired-during-max-items","listQuery.query"]]
      1.841s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-expired-during-max-items","listQuery.item"] -> keys=2 exists=yes valid=yes
      1.845s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-expired-during-max-items","listQuery.query"] -> keys=1 exists=yes valid=yes
      1.852s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-expired-during-max-items","listQuery.item"], ["sess1","lq-expired-during-max-items","listQuery.query"]]
      1.852s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-expired-during-max-items","listQuery.item"], ["sess1","lq-expired-during-max-items","listQuery.query"]]
      1.861s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-expired-during-max-items","listQuery.item"] -> keys=2 exists=yes valid=yes
      1.861s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-expired-during-max-items","listQuery.item"] -> keys=2 exists=yes valid=yes
      1.867s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-expired-during-max-items","listQuery.query"] -> keys=1 exists=yes valid=yes
      1.867s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-expired-during-max-items","listQuery.query"] -> keys=1 exists=yes valid=yes
      1.912s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-expired-during-max-items","listQuery.query"] put=["{tableId:\\"admins\\"}"] delete=[] touch=[] static-policy
      1.923s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-expired-during-max-items","listQuery.item"] put=["\\"admins||4", "\\"standalone||1"] delete=["\\"users||3", "\\"standalone||2"] touch=[] static-policy
      1.931s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-expired-during-max-items","listQuery.item"], ["sess1","lq-expired-during-max-items","listQuery.query"]]
      1.931s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-expired-during-max-items","listQuery.item"], ["sess1","lq-expired-during-max-items","listQuery.query"]]
      1.94s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-expired-during-max-items","listQuery.item"] -> keys=2 exists=yes valid=yes
      1.94s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-expired-during-max-items","listQuery.item"] -> keys=2 exists=yes valid=yes
      1.949s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-expired-during-max-items","listQuery.query"] -> keys=2 exists=yes valid=yes
      1.949s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-expired-during-max-items","listQuery.query"] -> keys=2 exists=yes valid=yes
      ""
    `);

    expect(await getIndexedDbStructureSnapshot(mockAdapter)).toMatchInlineSnapshot(`
      stores:
        - autoIncrement: '❌'
          indexes:
            - keyPath: ['sessionKey', 'storeName', 'kind', 'group', 'key']
              multiEntry: '❌'
              name: 'byScopeGroup'
              unique: '❌'
            - keyPath: ['sessionKey', 'storeName', 'kind', 'lastAccessAt', 'key']
              multiEntry: '❌'
              name: 'byScopeLastAccessAt'
              unique: '❌'
            - { keyPath: 'sessionKey', multiEntry: '❌', name: 'bySession', unique: '❌' }
            - keyPath: ['sessionKey', 'offlineProtected', 'storeName', 'kind', 'key']
              multiEntry: '❌'
              name: 'bySessionOfflineProtected'
              unique: '❌'
          keyPath: ['sessionKey', 'storeName', 'kind', 'key']
          name: 'entries'
          rowCount: 4
          rows:
            - key: ['sess1', 'lq-expired-during-max-items', 'listQuery.item', '"admins||4']
              value: 'JSON object | 0.5 kb'
            - key: ['sess1', 'lq-expired-during-max-items', 'listQuery.item', '"standalone||1']
              value: 'JSON object | 0.5 kb'
            - key: ['sess1', 'lq-expired-during-max-items', 'listQuery.query', '{tableId:"admins"}']
              value: 'JSON object | 0.5 kb'
            - key: ['sess1', 'lq-expired-during-max-items', 'listQuery.query', '{tableId:"users"}']
              value: 'JSON object | 0.5 kb'
        - autoIncrement: '❌'
          indexes: []
          keyPath: 'key'
          name: 'meta'
          rowCount: 0
          rows: []
        - autoIncrement: '❌'
          indexes:
            - { keyPath: 'sessionKey', multiEntry: '❌', name: 'bySession', unique: '❌' }
          keyPath: ['sessionKey', 'storeName', 'kind']
          name: 'namespacePolicies'
          rowCount: 1
          rows:
            - key: ['sess1', 'lq-expired-during-max-items', 'listQuery.item']
              value: 'JSON object | 0.2 kb'
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
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();

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
    listQueryScope.listQuery.setItemStaticPolicy({ m: 3 });
    createDocumentEnv({ storeName: 'trigger-doc', sessionKey });

    // Let the startup-scheduled maintenance enforce maxItems against the preloaded cache.
    const cleanupCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const cleanupOperations = cleanupCapture.finish().timelineString;

    // The oldest item should be evicted by recency, while the persisted query
    // payloads stay untouched and rely on later hydration to filter the missing item.
    expect(
      listQueryScope.listQuery.listStoredItemKeys().sort(),
    ).toMatchInlineSnapshot(`['"users||2', '"users||3', '"users||4']`);
    expect(
      getParsedTsdfIndexedDbRecordData('tsdf/sess1/lq-shared-item-cleanup/lq._i.r.json'),
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
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-shared-item-cleanup/lq.<{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: ['"users||1', '"users||2']`);
    expect(
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-shared-item-cleanup/lq.<{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: ['"users||1', '"users||3']`);
    expect(cleanupOperations).not.toContain('query data');
    expect(cleanupOperations).toMatchInlineSnapshot(`
      ""
      2.011s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-shared-item-cleanup","listQuery.item"], ["sess1","lq-shared-item-cleanup","listQuery.query"]]
      2.016s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-shared-item-cleanup","listQuery.query"] -> keys=2 exists=yes valid=yes
      2.018s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-shared-item-cleanup","listQuery.item"] -> keys=4 exists=yes valid=yes
      2.021s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","lq-shared-item-cleanup","listQuery.item"] keys=["\\"users||1"]
      2.03s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","lq-shared-item-cleanup","listQuery.item"] keys=3 static-policy
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
    const deleteCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.deleteItemState('users||1');
    await advanceTime(1100);
    await settleIndexedDbStorage();
    const deleteOperations = deleteCapture.finish().timelineString;

    expect(mockAdapter.has(deletedItemStorageKey)).toBe(false);
    expect(
      listQueryScope.listQuery.listStoredItemKeys().sort(),
    ).toMatchInlineSnapshot(`['"users||2']`);
    expect(getParsedTsdfIndexedDbRecordData('tsdf/sess1/lq-delete-flow/lq._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          {filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}:
            a: 1735689602052
            p:
              filters:
                - { field: 'name', op: 'eq', value: 'Alice' }
              tableId: 'users'
          {tableId:"users"}:
            a: 1735689602052
            p: { tableId: 'users' }
      `);
    expect(
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-delete-flow/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: ['"users||2']`);
    expect(getParsedTsdfIndexedDbRecordData('tsdf/sess1/lq-delete-flow/lq._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          {filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}:
            a: 1735689602052
            p:
              filters:
                - { field: 'name', op: 'eq', value: 'Alice' }
              tableId: 'users'
          {tableId:"users"}:
            a: 1735689602052
            p: { tableId: 'users' }
      `);
    expect(
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-delete-flow/lq.<{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: []`);
    expect(deleteOperations).toMatchInlineSnapshot(`
      ""
      1.106s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-delete-flow","listQuery.item"], ["sess1","lq-delete-flow","listQuery.query"]]
      1.106s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-delete-flow","listQuery.item"], ["sess1","lq-delete-flow","listQuery.query"]]
      1.112s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-delete-flow","listQuery.item"] -> keys=2 exists=yes valid=yes
      1.112s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-delete-flow","listQuery.item"] -> keys=2 exists=yes valid=yes
      1.118s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-delete-flow","listQuery.query"] -> keys=2 exists=yes valid=yes
      1.118s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-delete-flow","listQuery.query"] -> keys=2 exists=yes valid=yes
      1.164s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-delete-flow","listQuery.query"] put=["{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Alice\\"}],tableId:\\"users\\"}", "{tableId:\\"users\\"}"] delete=[] touch=[] static-policy
      1.17s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-delete-flow","listQuery.item"] put=["\\"users||2"] delete=["\\"users||1"] touch=[] static-policy
      1.175s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-delete-flow","listQuery.item"], ["sess1","lq-delete-flow","listQuery.query"]]
      1.176s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-delete-flow","listQuery.item"], ["sess1","lq-delete-flow","listQuery.query"]]
      1.179s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-delete-flow","listQuery.item"] -> keys=1 exists=yes valid=yes
      1.18s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-delete-flow","listQuery.item"] -> keys=1 exists=yes valid=yes
      1.185s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-delete-flow","listQuery.query"] -> keys=2 exists=yes valid=yes
      1.186s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-delete-flow","listQuery.query"] -> keys=2 exists=yes valid=yes
      ""
    `);
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

    // Deleting a cold standalone item should consult only the namespace index and remove the
    // payload file directly, without hydrating the cached item into memory first.
    const deleteCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.deleteItemState('users||1');
    await advanceTime(1100);
    await settleIndexedDbStorage();
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
      4ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-preload-query-state","listQuery.item"], ["sess1","lq-preload-query-state","listQuery.query"]]
      8ms | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-preload-query-state","listQuery.item"] -> keys=1 exists=yes valid=yes
      12ms | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-preload-query-state","listQuery.query"] -> keys=1 exists=yes valid=yes
      13ms | 📖 entries.getMany scope=["sess1","lq-preload-query-state","listQuery.query"] keys=["{tableId:\\"users\\"}"] -> ["{tableId:\\"users\\"}"]
      17ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-preload-query-state","listQuery.item"], ["sess1","lq-preload-query-state","listQuery.query"]]
      21ms | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-preload-query-state","listQuery.item"] -> keys=1 exists=yes valid=yes
      25ms | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-preload-query-state","listQuery.query"] -> keys=1 exists=yes valid=yes
      30ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-preload-query-state","listQuery.item"], ["sess1","lq-preload-query-state","listQuery.query"]]
      34ms | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-preload-query-state","listQuery.item"] -> keys=1 exists=yes valid=yes
      38ms | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-preload-query-state","listQuery.query"] -> keys=1 exists=yes valid=yes
      39ms | 📖 entries.getMany scope=["sess1","lq-preload-query-state","listQuery.item"] keys=["\\"users||1"] -> ["\\"users||1"]
      43ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-preload-query-state","listQuery.item"], ["sess1","lq-preload-query-state","listQuery.query"]]
      47ms | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-preload-query-state","listQuery.item"] -> keys=1 exists=yes valid=yes
      51ms | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-preload-query-state","listQuery.query"] -> keys=1 exists=yes valid=yes
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
    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
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
      4ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-preload-item-state","listQuery.item"]]
      10ms | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-preload-item-state","listQuery.item"] -> keys=2 exists=yes valid=yes
      11ms | 📖 entries.getMany scope=["sess1","lq-preload-item-state","listQuery.item"] keys=["\\"users||1"] -> ["\\"users||1"]
      15ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-preload-item-state","listQuery.item"]]
      21ms | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-preload-item-state","listQuery.item"] -> keys=2 exists=yes valid=yes
      26ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-preload-item-state","listQuery.item"]]
      32ms | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-preload-item-state","listQuery.item"] -> keys=2 exists=yes valid=yes
      33ms | 📖 entries.getMany scope=["sess1","lq-preload-item-state","listQuery.item"] keys=["\\"users||2"] -> ["\\"users||2"]
      37ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-preload-item-state","listQuery.item"]]
      43ms | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-preload-item-state","listQuery.item"] -> keys=2 exists=yes valid=yes
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
    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
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
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-query-invalidation-flow/lq._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"users"}:
          a: 1735689600000
          p: { tableId: 'users' }
    `);
    expect(
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-query-invalidation-flow/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`i: ['"users||1']`);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      ""
      1.814s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-query-invalidation-flow","listQuery.item"], ["sess1","lq-query-invalidation-flow","listQuery.query"]]
      1.818s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-invalidation-flow","listQuery.item"] -> keys=1 exists=yes valid=yes
      1.822s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-invalidation-flow","listQuery.query"] -> keys=1 exists=yes valid=yes
      1.866s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-query-invalidation-flow","listQuery.item"] put=["\\"users||1"] delete=[] touch=[] static-policy
      1.87s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-query-invalidation-flow","listQuery.item"], ["sess1","lq-query-invalidation-flow","listQuery.query"]]
      1.874s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-invalidation-flow","listQuery.item"] -> keys=1 exists=yes valid=yes
      1.878s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-query-invalidation-flow","listQuery.query"] -> keys=1 exists=yes valid=yes
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
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-coalesced-invalidations/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Fresh user 2' }
      lf: ['age', 'email', 'id', 'name']
      p: 'users||1'
    `);
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      ""
      1.904s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-coalesced-invalidations","listQuery.item"], ["sess1","lq-coalesced-invalidations","listQuery.query"]]
      1.908s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-coalesced-invalidations","listQuery.item"] -> keys=1 exists=yes valid=yes
      1.912s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-coalesced-invalidations","listQuery.query"] -> keys=1 exists=yes valid=yes
      1.956s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-coalesced-invalidations","listQuery.item"] put=["\\"users||1"] delete=[] touch=[] static-policy
      1.96s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","lq-coalesced-invalidations","listQuery.item"], ["sess1","lq-coalesced-invalidations","listQuery.query"]]
      1.964s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-coalesced-invalidations","listQuery.item"] -> keys=1 exists=yes valid=yes
      1.968s | 📖 scope-state entries+namespacePolicies scope=["sess1","lq-coalesced-invalidations","listQuery.query"] -> keys=1 exists=yes valid=yes
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
    await markEntryOfflineProtected(mockAdapter, itemStorageKey);
    await markEntryOfflineProtected(mockAdapter, queryStorageKey);

    // The refetch rewrites both namespaces, and should keep the externally-added markers.
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: usersQuery,
        itemPayload: false,
      });
    });
    await flushInvalidationPersistence();

    expect(hook.result.current.items).toMatchInlineSnapshot(`- { id: 1, name: 'Cached user' }`);
    expect(
      getParsedTsdfIndexedDbRecordData('tsdf/sess1/lq-offline-marker-flow/li._i.r.json'),
    ).toMatchInlineSnapshot(`null`);
    expect(
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-offline-marker-flow/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`null`);
    expect(
      getParsedTsdfIndexedDbRecordData('tsdf/sess1/lq-offline-marker-flow/lq._i.r.json'),
    ).toMatchInlineSnapshot(`null`);
    expect(
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-offline-marker-flow/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`null`);
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
      getParsedTsdfIndexedDbRecordData(
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
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(
      getParsedTsdfIndexedDbRecordData(
        'tsdf/sess1/lq-mutation-flow/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Cached user' }
      p: 'users||1'
    `);
    expect(getParsedTsdfIndexedDbRecordData('tsdf/sess1/lq-mutation-flow/li._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          "users||1: { a: 1735689600000, p: 'users||1' }
      `);
    expect(mutationOperations).toMatchInlineSnapshot(`"empty"`);
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
    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await resolveAfterIndexedDbStorage(preloadPromise, mockAdapter);

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      ""
      7ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","list-query-opfs-efficiency","listQuery.item"], ["sess1","list-query-opfs-efficiency","listQuery.query"]]
      15ms | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-efficiency","listQuery.item"] -> keys=3 exists=yes valid=yes
      21ms | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-efficiency","listQuery.query"] -> keys=2 exists=yes valid=yes
      22ms | 📖 entries.getMany scope=["sess1","list-query-opfs-efficiency","listQuery.query"] keys=["{tableId:\\"users\\"}"] -> ["{tableId:\\"users\\"}"]
      29ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","list-query-opfs-efficiency","listQuery.item"], ["sess1","list-query-opfs-efficiency","listQuery.query"]]
      37ms | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-efficiency","listQuery.item"] -> keys=3 exists=yes valid=yes
      43ms | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-efficiency","listQuery.query"] -> keys=2 exists=yes valid=yes
      51ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","list-query-opfs-efficiency","listQuery.item"], ["sess1","list-query-opfs-efficiency","listQuery.query"]]
      59ms | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-efficiency","listQuery.item"] -> keys=3 exists=yes valid=yes
      65ms | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-efficiency","listQuery.query"] -> keys=2 exists=yes valid=yes
      67ms | 📖 entries.getMany scope=["sess1","list-query-opfs-efficiency","listQuery.item"] keys=["\\"users||1", "\\"users||2"] -> ["\\"users||1", "\\"users||2"]
      74ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","list-query-opfs-efficiency","listQuery.item"], ["sess1","list-query-opfs-efficiency","listQuery.query"]]
      82ms | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-efficiency","listQuery.item"] -> keys=3 exists=yes valid=yes
      88ms | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-efficiency","listQuery.query"] -> keys=2 exists=yes valid=yes
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
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
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
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();

    env.scheduleFetch('highPriority', projectsQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();
    mockAdapter.clearInstrumentation();
    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);

    env.scheduleFetch('highPriority', tasksQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      ""
      1.818s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","list-query-opfs-eviction-efficiency","listQuery.item"], ["sess1","list-query-opfs-eviction-efficiency","listQuery.query"]]
      1.824s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-eviction-efficiency","listQuery.item"] -> keys=2 exists=yes valid=yes
      1.83s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-eviction-efficiency","listQuery.query"] -> keys=2 exists=yes valid=yes
      1.833s | 🔎 entries.byScopeLastAccessAt scope=["sess1","list-query-opfs-eviction-efficiency","listQuery.query"] order=lru-desc -> ["{tableId:\\"projects\\"}", "{tableId:\\"users\\"}"]
      1.841s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","list-query-opfs-eviction-efficiency","listQuery.item"], ["sess1","list-query-opfs-eviction-efficiency","listQuery.query"]]
      1.847s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-eviction-efficiency","listQuery.item"] -> keys=2 exists=yes valid=yes
      1.853s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-eviction-efficiency","listQuery.query"] -> keys=2 exists=yes valid=yes
      1.862s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","list-query-opfs-eviction-efficiency","listQuery.item"], ["sess1","list-query-opfs-eviction-efficiency","listQuery.query"]]
      1.871s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-eviction-efficiency","listQuery.item"] -> keys=2 exists=yes valid=yes
      1.88s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-eviction-efficiency","listQuery.query"] -> keys=2 exists=yes valid=yes
      1.925s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","list-query-opfs-eviction-efficiency","listQuery.item"] put=["\\"projects||1"] delete=[] touch=[] static-policy
      1.934s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","list-query-opfs-eviction-efficiency","listQuery.item"], ["sess1","list-query-opfs-eviction-efficiency","listQuery.query"]]
      1.943s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-eviction-efficiency","listQuery.item"] -> keys=2 exists=yes valid=yes
      1.952s | 📖 scope-state entries+namespacePolicies scope=["sess1","list-query-opfs-eviction-efficiency","listQuery.query"] -> keys=2 exists=yes valid=yes
      ""
    `);
    expect(mockAdapter.payloadGetRequests).toMatchInlineSnapshot(`[]`);
    expect(mockAdapter.payloadGetManyRequests).toMatchInlineSnapshot(`[]`);
  });
});
