import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import type { ListQueryParams } from '../../mocks/listQueryStoreTestEnv';
import { createOpfsPersistentStorageTestStore } from '../../utils/opfsPersistentStorageTestStore';
import {
  getParsedOpfsEntryFiles,
  startOpfsPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
  captureHookRemount,
  createListQueryEnv,
  flushInvalidationPersistence,
  markEntryOfflineProtected,
  rawItemPayload,
  readEntryMetadata,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  storeItemKey,
  waitForScheduledCleanup,
} from './shared';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../../utils/genericTestUtils';

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
    const startupOperationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    createListQueryEnv({ storeName, sessionKey });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the scan runs, capture the complete query and item cleanup sequence.
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
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
      2.002s | 🗂️ list-dir tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:list-query-expiration"]
      2.004s | 🗂️ list-dir tsdf/sess1/list-query-expiration
             |    └ (store directory) entries=["file:li.%22expired-users%7C%7C1.m.json","file:li.%22expired-users%7C%7C1.p.json","file:li.%22fresh-users%7C%7C2.m.json","file:li.%22fresh-users%7C%7C2.p.json","file:lq.%7BtableId%3A%22expired-users%22%7D.m.json","file:lq.%7BtableId%3A%22expired-users%22%7D.p.json","file:lq.%7BtableId%3A%22fresh-users%22%7D.m.json","file:lq.%7BtableId%3A%22fresh-users%22%7D.p.json"]
      2.005s | 📄 file-open ✅ #1 tsdf/sess1/list-query-expiration/li.%22expired-users%7C%7C1.m.json
             |    └ (tsdf.sess1.list-query-expiration.li."expired-users||1 (metadata))
      .      | 📄 file-open ✅ #2 tsdf/sess1/list-query-expiration/li.%22fresh-users%7C%7C2.m.json
             |    └ (tsdf.sess1.list-query-expiration.li."fresh-users||2 (metadata))
      .      | 📄 file-open ✅ #3 tsdf/sess1/list-query-expiration/lq.%7BtableId%3A%22expired-users%22%7D.m.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (metadata))
      .      | 📄 file-open ✅ #4 tsdf/sess1/list-query-expiration/lq.%7BtableId%3A%22fresh-users%22%7D.m.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"fresh-users"} (metadata))
      2.007s | 📖 #1 tsdf/sess1/list-query-expiration/li.%22expired-users%7C%7C1.m.json
             |    └ (tsdf.sess1.list-query-expiration.li."expired-users||1 (metadata)) | 0.09 kb
      .      | 📖 #2 tsdf/sess1/list-query-expiration/li.%22fresh-users%7C%7C2.m.json
             |    └ (tsdf.sess1.list-query-expiration.li."fresh-users||2 (metadata)) | 0.09 kb
      .      | 📖 #3 tsdf/sess1/list-query-expiration/lq.%7BtableId%3A%22expired-users%22%7D.m.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (metadata)) | 0.16 kb
      .      | 📖 #4 tsdf/sess1/list-query-expiration/lq.%7BtableId%3A%22fresh-users%22%7D.m.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"fresh-users"} (metadata)) | 0.16 kb
      2.009s | 🗑️ ✅ #5 tsdf/sess1/list-query-expiration/li.%22expired-users%7C%7C1.p.json
             |    └ (tsdf.sess1.list-query-expiration.li."expired-users||1 (payload))
      .      | 🗑️ ✅ #1 tsdf/sess1/list-query-expiration/li.%22expired-users%7C%7C1.m.json
             |    └ (tsdf.sess1.list-query-expiration.li."expired-users||1 (metadata))
      .      | 🗑️ ✅ #6 tsdf/sess1/list-query-expiration/lq.%7BtableId%3A%22expired-users%22%7D.p.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (payload))
      .      | 🗑️ ✅ #3 tsdf/sess1/list-query-expiration/lq.%7BtableId%3A%22expired-users%22%7D.m.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (metadata))
      2.01s  | end
      "
    `);
  });

  test('when maxQueries limit is reached a full store cleanup occurs', async () => {
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

    // Fetching a third query should show the write path plus the query eviction path.
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
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
      1.812s | 🗂️ list-dir tsdf/sess1/lq-query-metadata
             |    └ (store directory) entries=["file:lq.%7BtableId%3A%22first%22%7D.m.json","file:lq.%7BtableId%3A%22first%22%7D.p.json","file:lq.%7BtableId%3A%22second%22%7D.m.json","file:lq.%7BtableId%3A%22second%22%7D.p.json"]
      1.813s | 🗂️ list-dir tsdf/sess1/lq-query-metadata
             |    └ (store directory) entries=["file:lq.%7BtableId%3A%22first%22%7D.m.json","file:lq.%7BtableId%3A%22first%22%7D.p.json","file:lq.%7BtableId%3A%22second%22%7D.m.json","file:lq.%7BtableId%3A%22second%22%7D.p.json"]
      1.814s | 📄 file-open ✅ #1 tsdf/sess1/lq-query-metadata/lq.%7BtableId%3A%22first%22%7D.m.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (metadata))
      1.815s | 📄 file-open ✅ #2 tsdf/sess1/lq-query-metadata/lq.%7BtableId%3A%22first%22%7D.p.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (payload))
      1.816s | 📄 file-open ✅ #3 tsdf/sess1/lq-query-metadata/lq.%7BtableId%3A%22second%22%7D.m.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"second"} (metadata))
      1.817s | 📄 file-open ✅ #4 tsdf/sess1/lq-query-metadata/lq.%7BtableId%3A%22second%22%7D.p.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"second"} (payload))
      1.858s | 📄 file-open ❌ #5 tsdf/sess1/lq-query-metadata/lq.%7BtableId%3A%22third%22%7D.m.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata))
      .      | 📄 file-open ❌ #6 tsdf/sess1/lq-query-metadata/li.%22third%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (metadata))
      1.859s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      1.86s  | 📁 dir-open-or-create ✅ tsdf/sess1/lq-query-metadata (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-query-metadata (store directory)
      1.861s | 📄 file-open-or-create 🆕 #7 tsdf/sess1/lq-query-metadata/lq.%7BtableId%3A%22third%22%7D.p.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (payload))
      .      | 📄 file-open-or-create 🆕 #5 tsdf/sess1/lq-query-metadata/lq.%7BtableId%3A%22third%22%7D.m.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata))
      .      | 📄 file-open-or-create 🆕 #8 tsdf/sess1/lq-query-metadata/li.%22third%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (payload))
      .      | 📄 file-open-or-create 🆕 #6 tsdf/sess1/lq-query-metadata/li.%22third%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (metadata))
      1.864s | ✍️ #7 tsdf/sess1/lq-query-metadata/lq.%7BtableId%3A%22third%22%7D.p.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ #5 tsdf/sess1/lq-query-metadata/lq.%7BtableId%3A%22third%22%7D.m.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata)) | 0.00 kb -> 0.13 kb
      .      | ✍️ #8 tsdf/sess1/lq-query-metadata/li.%22third%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ #6 tsdf/sess1/lq-query-metadata/li.%22third%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (metadata)) | 0.00 kb -> 0.08 kb
      3.866s | 🗂️ list-dir tsdf/sess1/lq-query-metadata
             |    └ (store directory) entries=["file:li.%22third%7C%7C1.m.json","file:li.%22third%7C%7C1.p.json","file:lq.%7BtableId%3A%22first%22%7D.m.json","file:lq.%7BtableId%3A%22first%22%7D.p.json","file:lq.%7BtableId%3A%22second%22%7D.m.json","file:lq.%7BtableId%3A%22second%22%7D.p.json","file:lq.%7BtableId%3A%22third%22%7D.m.json","file:lq.%7BtableId%3A%22third%22%7D.p.json"]
      3.868s | 📖 #1 tsdf/sess1/lq-query-metadata/lq.%7BtableId%3A%22first%22%7D.m.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (metadata)) | 0.11 kb
      .      | 📖 #3 tsdf/sess1/lq-query-metadata/lq.%7BtableId%3A%22second%22%7D.m.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"second"} (metadata)) | 0.11 kb
      .      | 📖 #5 tsdf/sess1/lq-query-metadata/lq.%7BtableId%3A%22third%22%7D.m.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata)) | 0.13 kb
      3.91s  | 🗑️ ✅ #2 tsdf/sess1/lq-query-metadata/lq.%7BtableId%3A%22first%22%7D.p.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (payload))
      .      | 🗑️ ✅ #1 tsdf/sess1/lq-query-metadata/lq.%7BtableId%3A%22first%22%7D.m.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (metadata))
      3.911s | 🧹 del-dir ❌ tsdf/sess1/lq-query-metadata (store directory)
      3.912s | 🗂️ list-dir tsdf/sess1/lq-query-metadata
             |    └ (store directory) entries=["file:li.%22third%7C%7C1.m.json","file:li.%22third%7C%7C1.p.json","file:lq.%7BtableId%3A%22second%22%7D.m.json","file:lq.%7BtableId%3A%22second%22%7D.p.json","file:lq.%7BtableId%3A%22third%22%7D.m.json","file:lq.%7BtableId%3A%22third%22%7D.p.json"]
      3.914s | 📖 #6 tsdf/sess1/lq-query-metadata/li.%22third%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (metadata)) | 0.08 kb
      3.916s | end
      "
    `);
    expect(
      getParsedOpfsEntryFiles(
        listQueryScope.listQuery.itemNamespace,
        listQueryScope.listQuery.itemKey('third', 1),
      ),
    ).toMatchInlineSnapshot(`
      metadata: { a: 1735689604959, p: 'third||1', v: 1 }
      payload:
        d: { id: 1, name: 'Third' }
        p: 'third||1'
    `);
    expect(
      getParsedOpfsEntryFiles(
        listQueryScope.listQuery.queryNamespace,
        listQueryScope.listQuery.queryKey(thirdQuery),
      ),
    ).toMatchInlineSnapshot(`
      metadata:
        a: 1735689604959
        i: ['"third||1']
        p: { tableId: 'third' }
        v: 1

      payload:
        i: ['"third||1']
        p: { tableId: 'third' }
    `);
  });

  test('multiple overflowing query writes before idle maintenance trigger a single cleanup pass', async () => {
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

    // Drain the startup maintenance so the capture only covers coalesced query eviction.
    await settleStartupBackgroundScan(mockAdapter);

    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    // The third query persists and schedules maintenance.
    env.scheduleFetch('highPriority', thirdQuery);
    await advanceTime(810);
    await advanceTime(1000);

    // The fourth query persists before that cleanup fires, so maintenance should still run once.
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
      1.811s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      1.812s | 🗂️ list-dir tsdf/sess1/lq-coalesced-query-maintenance
             |    └ (store directory) entries=["file:lq.%7BtableId%3A%22first%22%7D.m.json","file:lq.%7BtableId%3A%22first%22%7D.p.json","file:lq.%7BtableId%3A%22second%22%7D.m.json","file:lq.%7BtableId%3A%22second%22%7D.p.json"]
      1.813s | 🗂️ list-dir tsdf/sess1/lq-coalesced-query-maintenance
             |    └ (store directory) entries=["file:lq.%7BtableId%3A%22first%22%7D.m.json","file:lq.%7BtableId%3A%22first%22%7D.p.json","file:lq.%7BtableId%3A%22second%22%7D.m.json","file:lq.%7BtableId%3A%22second%22%7D.p.json"]
      1.814s | 📄 file-open ✅ #1 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22first%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (metadata))
      1.815s | 📄 file-open ✅ #2 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22first%22%7D.p.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (payload))
      1.816s | 📄 file-open ✅ #3 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22second%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (metadata))
      1.817s | 📄 file-open ✅ #4 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22second%22%7D.p.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (payload))
      1.858s | 📄 file-open ❌ #5 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22third%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata))
      .      | 📄 file-open ❌ #6 tsdf/sess1/lq-coalesced-query-maintenance/li.%22third%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))
      1.859s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      1.86s  | 📁 dir-open-or-create ✅ tsdf/sess1/lq-coalesced-query-maintenance
             |    └ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-coalesced-query-maintenance
             |    └ (store directory)
      1.861s | 📄 file-open-or-create 🆕 #7 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22third%22%7D.p.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (payload))
      .      | 📄 file-open-or-create 🆕 #5 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22third%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata))
      .      | 📄 file-open-or-create 🆕 #8 tsdf/sess1/lq-coalesced-query-maintenance/li.%22third%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (payload))
      .      | 📄 file-open-or-create 🆕 #6 tsdf/sess1/lq-coalesced-query-maintenance/li.%22third%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))
      1.864s | ✍️ #7 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22third%22%7D.p.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ #5 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22third%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata)) | 0.00 kb -> 0.13 kb
      .      | ✍️ #8 tsdf/sess1/lq-coalesced-query-maintenance/li.%22third%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ #6 tsdf/sess1/lq-coalesced-query-maintenance/li.%22third%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata)) | 0.00 kb -> 0.08 kb
      3.66s  | 📄 file-open ❌ #9 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22fourth%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata))
      .      | 📄 file-open ❌ #10 tsdf/sess1/lq-coalesced-query-maintenance/li.%22fourth%7C%7C2.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata))
      3.661s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      .      | 📖 #6 tsdf/sess1/lq-coalesced-query-maintenance/li.%22third%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata)) | 0.08 kb
      3.662s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-coalesced-query-maintenance
             |    └ (store directory)
      3.663s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      .      | 📄 file-open-or-create 🆕 #11 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22fourth%22%7D.p.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (payload))
      .      | 📄 file-open-or-create 🆕 #9 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22fourth%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata))
      3.664s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-coalesced-query-maintenance
             |    └ (store directory)
      3.665s | 📄 file-open-or-create ✅ #8 tsdf/sess1/lq-coalesced-query-maintenance/li.%22third%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (payload))
      .      | 📄 file-open-or-create ✅ #6 tsdf/sess1/lq-coalesced-query-maintenance/li.%22third%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))
      .      | 📄 file-open-or-create 🆕 #12 tsdf/sess1/lq-coalesced-query-maintenance/li.%22fourth%7C%7C2.p.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (payload))
      .      | 📄 file-open-or-create 🆕 #10 tsdf/sess1/lq-coalesced-query-maintenance/li.%22fourth%7C%7C2.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata))
      3.666s | ✍️ #11 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22fourth%22%7D.p.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ #9 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22fourth%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata)) | 0.00 kb -> 0.14 kb
      3.668s | ✍️ #8 tsdf/sess1/lq-coalesced-query-maintenance/li.%22third%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (payload)) | 0.09 kb -> 0.15 kb
      .      | ✍️ #6 tsdf/sess1/lq-coalesced-query-maintenance/li.%22third%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata)) | 0.08 kb -> 0.08 kb
      .      | ✍️ #12 tsdf/sess1/lq-coalesced-query-maintenance/li.%22fourth%7C%7C2.p.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ #10 tsdf/sess1/lq-coalesced-query-maintenance/li.%22fourth%7C%7C2.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata)) | 0.00 kb -> 0.08 kb
      3.866s | 🗂️ list-dir tsdf/sess1/lq-coalesced-query-maintenance
             |    └ (store directory) entries=["file:li.%22fourth%7C%7C2.m.json","file:li.%22fourth%7C%7C2.p.json","file:li.%22third%7C%7C1.m.json","file:li.%22third%7C%7C1.p.json","file:lq.%7BtableId%3A%22first%22%7D.m.json","file:lq.%7BtableId%3A%22first%22%7D.p.json","file:lq.%7BtableId%3A%22fourth%22%7D.m.json","file:lq.%7BtableId%3A%22fourth%22%7D.p.json","file:lq.%7BtableId%3A%22second%22%7D.m.json","file:lq.%7BtableId%3A%22second%22%7D.p.json","file:lq.%7BtableId%3A%22third%22%7D.m.json","file:lq.%7BtableId%3A%22third%22%7D.p.json"]
      3.868s | 📖 #1 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22first%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (metadata)) | 0.11 kb
      .      | 📖 #9 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22fourth%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata)) | 0.14 kb
      .      | 📖 #3 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22second%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (metadata)) | 0.11 kb
      .      | 📖 #5 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22third%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata)) | 0.13 kb
      3.91s  | 🗑️ ✅ #4 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22second%22%7D.p.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (payload))
      .      | 🗑️ ✅ #3 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22second%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (metadata))
      .      | 🗑️ ✅ #2 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22first%22%7D.p.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (payload))
      .      | 🗑️ ✅ #1 tsdf/sess1/lq-coalesced-query-maintenance/lq.%7BtableId%3A%22first%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (metadata))
      3.911s | 🧹 del-dir ❌ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      3.912s | 🗂️ list-dir tsdf/sess1/lq-coalesced-query-maintenance
             |    └ (store directory) entries=["file:li.%22fourth%7C%7C2.m.json","file:li.%22fourth%7C%7C2.p.json","file:li.%22third%7C%7C1.m.json","file:li.%22third%7C%7C1.p.json","file:lq.%7BtableId%3A%22fourth%22%7D.m.json","file:lq.%7BtableId%3A%22fourth%22%7D.p.json","file:lq.%7BtableId%3A%22third%22%7D.m.json","file:lq.%7BtableId%3A%22third%22%7D.p.json"]
      3.914s | 📖 #10 tsdf/sess1/lq-coalesced-query-maintenance/li.%22fourth%7C%7C2.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata)) | 0.08 kb
      .      | 📖 #6 tsdf/sess1/lq-coalesced-query-maintenance/li.%22third%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata)) | 0.08 kb
      3.916s | end
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

    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
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
      1.81s  | 📂 dir-open ❌ tsdf/sess1 (session directory)
      1.851s | 📁 dir-open-or-create 🆕 tsdf/sess1 (session directory)
      1.852s | 📁 dir-open-or-create 🆕 tsdf/sess1/lq-empty-query-manifest (store directory)
      1.853s | 📄 file-open-or-create 🆕 #1 tsdf/sess1/lq-empty-query-manifest/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.p.json
             |    └ (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (payload))
      .      | 📄 file-open-or-create 🆕 #2 tsdf/sess1/lq-empty-query-manifest/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata))
      1.856s | ✍️ #1 tsdf/sess1/lq-empty-query-manifest/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.p.json
             |    └ (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (payload)) | 0.00 kb -> 0.18 kb
      .      | ✍️ #2 tsdf/sess1/lq-empty-query-manifest/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata)) | 0.00 kb -> 0.23 kb
      3.858s | 🗂️ list-dir tsdf/sess1/lq-empty-query-manifest
             |    └ (store directory) entries=["file:lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.m.json","file:lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.p.json"]
      3.86s  | 📖 #2 tsdf/sess1/lq-empty-query-manifest/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata)) | 0.23 kb
      3.862s | 🗂️ list-dir tsdf/sess1/lq-empty-query-manifest
             |    └ (store directory) entries=["file:lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.m.json","file:lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.p.json"]
      3.863s | end
      "
    `);
    expect(
      getParsedOpfsEntryFiles(
        listQueryScope.listQuery.queryNamespace,
        listQueryScope.listQuery.queryKey(usersQuery),
      ),
    ).toMatchInlineSnapshot(`
      metadata:
        a: 1735689604851
        i: []
        p:
          filters:
            - { field: 'name', op: 'eq', value: 'Missing user' }
          tableId: 'users'
        v: 1

      payload:
        i: []
        p:
          filters:
            - { field: 'name', op: 'eq', value: 'Missing user' }
          tableId: 'users'
    `);
  });

  test('query that becomes empty after invalidation do not clean up orphaned items from persistence', async () => {
    const storeName = 'lq-query-becomes-empty';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
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
    const invalidationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: usersQuery,
        itemPayload: false,
      });
    });
    await flushInvalidationPersistence();
    const invalidationOperations = invalidationCapture.finish().timelineString;

    expect(hook.result.current.items).toMatchInlineSnapshot(`[]`);
    expect(listQueryScope.listQuery.readQueryEntry(usersQuery))
      .toMatchInlineSnapshot(`
        data:
          hasMore: '❌'
          items: []
          payload: { tableId: 'users' }

        timestamp: 1735689605015
        version: 1
      `);
    expect(listQueryScope.listQuery.readItemData('users', 1))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached user'
      `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.81s  | 🗂️ list-dir tsdf/sess1/lq-query-becomes-empty
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      1.811s | 🗂️ list-dir tsdf/sess1/lq-query-becomes-empty
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      1.853s | 📖 #1 tsdf/sess1/lq-query-becomes-empty/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata)) | 0.13 kb
      .      | 📖 #2 tsdf/sess1/lq-query-becomes-empty/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata)) | 0.08 kb
      1.905s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      1.906s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-query-becomes-empty (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-query-becomes-empty (store directory)
      1.907s | 📄 file-open-or-create ✅ #3 tsdf/sess1/lq-query-becomes-empty/lq.%7BtableId%3A%22users%22%7D.p.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (payload))
      .      | 📄 file-open-or-create ✅ #1 tsdf/sess1/lq-query-becomes-empty/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata))
      .      | 📄 file-open-or-create ✅ #4 tsdf/sess1/lq-query-becomes-empty/li.%22users%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (payload))
      .      | 📄 file-open-or-create ✅ #2 tsdf/sess1/lq-query-becomes-empty/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata))
      1.91s  | ✍️ #3 tsdf/sess1/lq-query-becomes-empty/lq.%7BtableId%3A%22users%22%7D.p.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (payload)) | 0.09 kb -> 0.06 kb
      .      | ✍️ #1 tsdf/sess1/lq-query-becomes-empty/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata)) | 0.13 kb -> 0.11 kb
      .      | ✍️ #4 tsdf/sess1/lq-query-becomes-empty/li.%22users%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ #2 tsdf/sess1/lq-query-becomes-empty/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata)) | 0.08 kb -> 0.08 kb
      3.912s | 🗂️ list-dir tsdf/sess1/lq-query-becomes-empty
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      3.914s | 📖 #1 tsdf/sess1/lq-query-becomes-empty/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata)) | 0.11 kb
      3.966s | 🗂️ list-dir tsdf/sess1/lq-query-becomes-empty
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      3.968s | 📖 #2 tsdf/sess1/lq-query-becomes-empty/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata)) | 0.08 kb
      4.02s  | end
      "
    `);
    expect(
      getParsedOpfsEntryFiles(
        listQueryScope.listQuery.itemNamespace,
        listQueryScope.listQuery.itemKey('users', 1),
      ),
    ).toMatchInlineSnapshot(`
      metadata: { a: 1735689605015, p: 'users||1', v: 1 }
      payload:
        d: { id: 1, name: 'Cached user' }
        lf: ['age', 'email', 'id', 'name']
        p: 'users||1'
    `);
    expect(
      getParsedOpfsEntryFiles(
        listQueryScope.listQuery.queryNamespace,
        listQueryScope.listQuery.queryKey(usersQuery),
      ),
    ).toMatchInlineSnapshot(`
      metadata:
        a: 1735689605015
        i: []
        p: { tableId: 'users' }
        v: 1

      payload:
        i: []
        p: { tableId: 'users' }
    `);
  });

  test('when maxItems limit is reached a full store cleanup occurs', async () => {
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

    // Adding a third item should snapshot the write plus eviction sequence end-to-end.
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    env.apiStore.addItemToState(rawItemPayload('users', 3), {
      id: 3,
      name: 'Fresh',
    });
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listQueryScope.listQuery.listStoredItemKeys().sort(),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      1s     | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1.001s | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata (store directory)
      1.002s | 🗂️ list-dir tsdf/sess1/lq-item-metadata
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:li.%22users%7C%7C2.m.json","file:li.%22users%7C%7C2.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      1.003s | 📄 file-open ✅ #1 tsdf/sess1/lq-item-metadata/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||1 (metadata))
      1.004s | 📄 file-open ✅ #2 tsdf/sess1/lq-item-metadata/li.%22users%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||1 (payload))
      1.005s | 📄 file-open ✅ #3 tsdf/sess1/lq-item-metadata/li.%22users%7C%7C2.m.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||2 (metadata))
      1.006s | 📄 file-open ✅ #4 tsdf/sess1/lq-item-metadata/li.%22users%7C%7C2.p.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||2 (payload))
      1.007s | 🗂️ list-dir tsdf/sess1/lq-item-metadata
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:li.%22users%7C%7C2.m.json","file:li.%22users%7C%7C2.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      1.008s | 📄 file-open ✅ #5 tsdf/sess1/lq-item-metadata/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-item-metadata.lq.{tableId:"users"} (metadata))
      1.009s | 📄 file-open ✅ #6 tsdf/sess1/lq-item-metadata/lq.%7BtableId%3A%22users%22%7D.p.json
             |    └ (tsdf.sess1.lq-item-metadata.lq.{tableId:"users"} (payload))
      1.05s  | 📄 file-open ❌ #7 tsdf/sess1/lq-item-metadata/li.%22users%7C%7C3.m.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (metadata))
      1.051s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      1.052s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-item-metadata (store directory)
      1.053s | 📄 file-open-or-create 🆕 #8 tsdf/sess1/lq-item-metadata/li.%22users%7C%7C3.p.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (payload))
      .      | 📄 file-open-or-create 🆕 #7 tsdf/sess1/lq-item-metadata/li.%22users%7C%7C3.m.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (metadata))
      1.056s | ✍️ #8 tsdf/sess1/lq-item-metadata/li.%22users%7C%7C3.p.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ #7 tsdf/sess1/lq-item-metadata/li.%22users%7C%7C3.m.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (metadata)) | 0.00 kb -> 0.08 kb
      3.058s | 🗂️ list-dir tsdf/sess1/lq-item-metadata
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:li.%22users%7C%7C2.m.json","file:li.%22users%7C%7C2.p.json","file:li.%22users%7C%7C3.m.json","file:li.%22users%7C%7C3.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      3.06s  | 📖 #5 tsdf/sess1/lq-item-metadata/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-item-metadata.lq.{tableId:"users"} (metadata)) | 0.16 kb
      3.062s | 🗂️ list-dir tsdf/sess1/lq-item-metadata
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:li.%22users%7C%7C2.m.json","file:li.%22users%7C%7C2.p.json","file:li.%22users%7C%7C3.m.json","file:li.%22users%7C%7C3.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      3.064s | 📖 #1 tsdf/sess1/lq-item-metadata/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||1 (metadata)) | 0.08 kb
      .      | 📖 #3 tsdf/sess1/lq-item-metadata/li.%22users%7C%7C2.m.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||2 (metadata)) | 0.08 kb
      .      | 📖 #7 tsdf/sess1/lq-item-metadata/li.%22users%7C%7C3.m.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (metadata)) | 0.08 kb
      3.106s | 🗑️ ✅ #8 tsdf/sess1/lq-item-metadata/li.%22users%7C%7C3.p.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (payload))
      .      | 🗑️ ✅ #7 tsdf/sess1/lq-item-metadata/li.%22users%7C%7C3.m.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (metadata))
      3.107s | 🧹 del-dir ❌ tsdf/sess1/lq-item-metadata (store directory)
      3.108s | end
      "
    `);
  });

  test('maxItems cleanup evicts standalone items before query-related shared items', async () => {
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
    createListQueryEnv({ storeName, sessionKey, maxItems: 3 });

    // Let the startup-scheduled maintenance enforce maxItems against the preloaded cache.
    const cleanupCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    await waitForScheduledCleanup();
    const cleanupOperations = cleanupCapture.finish().timelineString;

    expect(
      listQueryScope.listQuery.listStoredItemKeys().sort(),
    ).toMatchInlineSnapshot(
      `['"users||1', '"users||2', '"users||3', '"users||4']`,
    );
    expect(listQueryScope.listQuery.readQueryEntry(firstUsersQuery))
      .toMatchInlineSnapshot(`
        data:
          hasMore: '❌'
          items: ['"users||1', '"users||2']
          payload:
            filters:
              - { field: 'name', op: 'eq', value: 'Alice' }
            tableId: 'users'

        timestamp: 1735689600300
        version: 1
      `);
    expect(listQueryScope.listQuery.readQueryEntry(secondUsersQuery))
      .toMatchInlineSnapshot(`
        data:
          hasMore: '❌'
          items: ['"users||1', '"users||3']
          payload:
            filters:
              - { field: 'name', op: 'eq', value: 'Bob' }
            tableId: 'users'

        timestamp: 1735689600300
        version: 1
      `);
    expect(cleanupOperations).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:lq-shared-item-cleanup"]
      2.004s | 🗂️ list-dir tsdf/sess1/lq-shared-item-cleanup
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:li.%22users%7C%7C2.m.json","file:li.%22users%7C%7C2.p.json","file:li.%22users%7C%7C3.m.json","file:li.%22users%7C%7C3.p.json","file:li.%22users%7C%7C4.m.json","file:li.%22users%7C%7C4.p.json","file:lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.m.json","file:lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.p.json","file:lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.m.json","file:lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.p.json"]
      2.005s | 📄 file-open ✅ #1 tsdf/sess1/lq-shared-item-cleanup/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||1 (metadata))
      .      | 📄 file-open ✅ #2 tsdf/sess1/lq-shared-item-cleanup/li.%22users%7C%7C2.m.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||2 (metadata))
      .      | 📄 file-open ✅ #3 tsdf/sess1/lq-shared-item-cleanup/li.%22users%7C%7C3.m.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||3 (metadata))
      .      | 📄 file-open ✅ #4 tsdf/sess1/lq-shared-item-cleanup/li.%22users%7C%7C4.m.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||4 (metadata))
      .      | 📄 file-open ✅ #5 tsdf/sess1/lq-shared-item-cleanup/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata))
      .      | 📄 file-open ✅ #6 tsdf/sess1/lq-shared-item-cleanup/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"} (metadata))
      2.007s | 📖 #1 tsdf/sess1/lq-shared-item-cleanup/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||1 (metadata)) | 0.08 kb
      .      | 📖 #2 tsdf/sess1/lq-shared-item-cleanup/li.%22users%7C%7C2.m.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||2 (metadata)) | 0.08 kb
      .      | 📖 #3 tsdf/sess1/lq-shared-item-cleanup/li.%22users%7C%7C3.m.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||3 (metadata)) | 0.08 kb
      .      | 📖 #4 tsdf/sess1/lq-shared-item-cleanup/li.%22users%7C%7C4.m.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||4 (metadata)) | 0.08 kb
      .      | 📖 #5 tsdf/sess1/lq-shared-item-cleanup/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)) | 0.27 kb
      .      | 📖 #6 tsdf/sess1/lq-shared-item-cleanup/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"} (metadata)) | 0.26 kb
      2.009s | end
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
    const deleteCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    env.apiStore.deleteItemState('users||1');
    await advanceTime(1100);
    await flushAllTimers();
    const deleteOperations = deleteCapture.finish().timelineString;

    expect(mockAdapter.has(deletedItemStorageKey)).toBe(false);
    expect(
      listQueryScope.listQuery.listStoredItemKeys().sort(),
    ).toMatchInlineSnapshot(`['"users||2']`);
    expect(listQueryScope.listQuery.readQueryEntry(usersQuery))
      .toMatchInlineSnapshot(`
        data:
          hasMore: '❌'
          items: ['"users||2']
          payload: { tableId: 'users' }

        timestamp: 1735689606014
        version: 1
      `);
    expect(listQueryScope.listQuery.readQueryEntry(filteredUsersQuery))
      .toMatchInlineSnapshot(`
        data:
          hasMore: '❌'
          items: []
          payload:
            filters:
              - { field: 'name', op: 'eq', value: 'Alice' }
            tableId: 'users'

        timestamp: 1735689606014
        version: 1
      `);
    expect(deleteOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.041s | 📖 #1 tsdf/sess1/lq-delete-flow/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata)) | 0.16 kb
      .      | 📖 #2 tsdf/sess1/lq-delete-flow/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)) | 0.24 kb
      .      | 📖 #3 tsdf/sess1/lq-delete-flow/li.%22users%7C%7C2.m.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (metadata)) | 0.08 kb
      1.043s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1.044s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-delete-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow (store directory)
      1.045s | 📄 file-open-or-create ✅ #4 tsdf/sess1/lq-delete-flow/lq.%7BtableId%3A%22users%22%7D.p.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (payload))
      .      | 📄 file-open-or-create ✅ #1 tsdf/sess1/lq-delete-flow/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata))
      .      | 📄 file-open-or-create ✅ #5 tsdf/sess1/lq-delete-flow/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.p.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (payload))
      .      | 📄 file-open-or-create ✅ #2 tsdf/sess1/lq-delete-flow/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata))
      .      | 🗑️ ✅ #6 tsdf/sess1/lq-delete-flow/li.%22users%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||1 (payload))
      .      | 🗑️ ✅ #7 tsdf/sess1/lq-delete-flow/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||1 (metadata))
      1.046s | 🧹 del-dir ❌ tsdf/sess1/lq-delete-flow (store directory)
      1.047s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      1.048s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-delete-flow (store directory)
      .      | ✍️ #4 tsdf/sess1/lq-delete-flow/lq.%7BtableId%3A%22users%22%7D.p.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (payload)) | 0.11 kb -> 0.09 kb
      .      | ✍️ #1 tsdf/sess1/lq-delete-flow/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata)) | 0.16 kb -> 0.13 kb
      .      | ✍️ #5 tsdf/sess1/lq-delete-flow/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.p.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (payload)) | 0.19 kb -> 0.17 kb
      .      | ✍️ #2 tsdf/sess1/lq-delete-flow/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)) | 0.24 kb -> 0.22 kb
      1.049s | 📄 file-open-or-create ✅ #8 tsdf/sess1/lq-delete-flow/li.%22users%7C%7C2.p.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (payload))
      .      | 📄 file-open-or-create ✅ #3 tsdf/sess1/lq-delete-flow/li.%22users%7C%7C2.m.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (metadata))
      1.052s | ✍️ #8 tsdf/sess1/lq-delete-flow/li.%22users%7C%7C2.p.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (payload)) | 0.08 kb -> 0.15 kb
      .      | ✍️ #3 tsdf/sess1/lq-delete-flow/li.%22users%7C%7C2.m.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (metadata)) | 0.08 kb -> 0.08 kb
      3.054s | 🗂️ list-dir tsdf/sess1/lq-delete-flow
             |    └ (store directory) entries=["file:li.%22users%7C%7C2.m.json","file:li.%22users%7C%7C2.p.json","file:lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.m.json","file:lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      3.056s | 📖 #2 tsdf/sess1/lq-delete-flow/lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)) | 0.22 kb
      .      | 📖 #1 tsdf/sess1/lq-delete-flow/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata)) | 0.13 kb
      3.058s | 🗂️ list-dir tsdf/sess1/lq-delete-flow
             |    └ (store directory) entries=["file:li.%22users%7C%7C2.m.json","file:li.%22users%7C%7C2.p.json","file:lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.m.json","file:lq.%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      3.06s  | 📖 #3 tsdf/sess1/lq-delete-flow/li.%22users%7C%7C2.m.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (metadata)) | 0.08 kb
      3.062s | end
      "
    `);
  });

  test('direct getQueryState reads the cached list query multiple times with short gaps and keeps it in memory', async () => {
    const storeName = 'lq-direct-get-query-state';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user',
    });
    listQueryScope.listQuery.seedQuery(usersQuery, [storeItemKey('users', 1)]);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so this capture only measures the direct read-through path.
    await settleStartupBackgroundScan(mockAdapter);

    // Repeated direct reads with short gaps should hydrate once, then reuse in-memory query and item state.
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    expect(env.apiStore.getQueryState(usersQuery)).toMatchInlineSnapshot(
      `undefined`,
    );
    await advanceTime(100);
    expect(env.apiStore.getQueryState(usersQuery)).toMatchInlineSnapshot(
      `undefined`,
    );
    await advanceTime(100);
    expect(env.apiStore.getQueryState(usersQuery)).toMatchInlineSnapshot(
      `undefined`,
    );
    expect(
      env.apiStore.getItemState(rawItemPayload('users', 1)),
    ).toMatchInlineSnapshot(`undefined`);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(env.store.state).toMatchInlineSnapshot(`
      itemFieldInvalidationFields: {}

      itemLoadedFields: {}

      itemQueries: {}

      items: {}

      queries: {}
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`"empty"`);
  });

  test('direct getQueryState touch preserves offline markers added by another tab before item and query manifest updates', async () => {
    const storeName = 'lq-direct-touch-offline-marker';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);
    const itemStorageKey = listQueryScope.listQuery.itemStorageKey('users', 1);
    const queryStorageKey =
      listQueryScope.listQuery.queryStorageKey(usersQuery);

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

    // Drain the startup scan so the later touches only come from the direct read path.
    await settleStartupBackgroundScan(mockAdapter);

    // Reading the query schedules timestamp touches for both the query and its hydrated item.
    expect(env.apiStore.getQueryState(usersQuery)).toMatchInlineSnapshot(
      `undefined`,
    );

    // Simulate another tab marking the existing item and query entries as offline-protected.
    markEntryOfflineProtected(mockAdapter, itemStorageKey);
    markEntryOfflineProtected(mockAdapter, queryStorageKey);
    await advanceTime(40);
    await flushAllTimers();

    expect(readEntryMetadata(mockAdapter, itemStorageKey))
      .toMatchInlineSnapshot(`
        customMetadata: { o: '✅', p: 'users||1' }
        key: '"users||1'
        lastAccessAt: 1735664400000
        payloadRef: '__tsdf_payload__:"users||1'
        version: 1
        writtenAt: 1735664400000
      `);
    expect(
      getParsedOpfsEntryFiles(
        listQueryScope.listQuery.itemNamespace,
        listQueryScope.listQuery.itemKey('users', 1),
      ),
    ).toMatchInlineSnapshot(`
      metadata: { a: 1735664400000, o: '✅', p: 'users||1', v: 1 }
      payload:
        d: { id: 1, name: 'Cached user' }
        p: 'users||1'
    `);
    expect(readEntryMetadata(mockAdapter, queryStorageKey))
      .toMatchInlineSnapshot(`
        customMetadata:
          i: ['"users||1']
          o: '✅'
          p: { tableId: 'users' }

        key: '{tableId:"users"}'
        lastAccessAt: 1735664400000
        payloadRef: '__tsdf_payload__:{tableId:"users"}'
        version: 1
        writtenAt: 1735664400000
      `);
    expect(
      getParsedOpfsEntryFiles(
        listQueryScope.listQuery.queryNamespace,
        listQueryScope.listQuery.queryKey(usersQuery),
      ),
    ).toMatchInlineSnapshot(`
      metadata:
        a: 1735664400000
        i: ['"users||1']
        o: '✅'
        p: { tableId: 'users' }
        v: 1

      payload:
        i: ['"users||1']
        p: { tableId: 'users' }
    `);
  });

  test('useListQuery invalidation snapshots the full query persistence timeline through the refetch save', async () => {
    const storeName = 'lq-query-invalidation-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
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
    const invalidationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
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
    expect(listQueryScope.listQuery.readQueryEntry(usersQuery))
      .toMatchInlineSnapshot(`
        data:
          hasMore: '❌'
          items: ['"users||1']
          payload: { tableId: 'users' }

        timestamp: 1735689600000
        version: 1
      `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.81s  | 🗂️ list-dir tsdf/sess1/lq-query-invalidation-flow
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      1.811s | 🗂️ list-dir tsdf/sess1/lq-query-invalidation-flow
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      1.853s | 📖 #1 tsdf/sess1/lq-query-invalidation-flow/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata)) | 0.08 kb
      1.905s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      1.906s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-query-invalidation-flow (store directory)
      1.907s | 📄 file-open-or-create ✅ #2 tsdf/sess1/lq-query-invalidation-flow/li.%22users%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (payload))
      .      | 📄 file-open-or-create ✅ #1 tsdf/sess1/lq-query-invalidation-flow/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata))
      1.91s  | ✍️ #2 tsdf/sess1/lq-query-invalidation-flow/li.%22users%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ #1 tsdf/sess1/lq-query-invalidation-flow/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata)) | 0.08 kb -> 0.08 kb
      3.912s | 🗂️ list-dir tsdf/sess1/lq-query-invalidation-flow
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      3.914s | 📖 #3 tsdf/sess1/lq-query-invalidation-flow/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.lq.{tableId:"users"} (metadata)) | 0.13 kb
      3.966s | 🗂️ list-dir tsdf/sess1/lq-query-invalidation-flow
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      3.968s | 📖 #1 tsdf/sess1/lq-query-invalidation-flow/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata)) | 0.08 kb
      4.02s  | end
      "
    `);
  });

  test('repeated invalidations within the debounce window coalesce list-query persistence writes', async () => {
    const storeName = 'lq-coalesced-invalidations';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
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
    const firstInvalidationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
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
      startOpfsPersistentStorageOperationCapture(mockAdapter, {
        storeName,
        sessionKey,
      });
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
    expect(listQueryScope.listQuery.readItemData('users', 1))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Fresh user 2'
      `);
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.81s  | 🗂️ list-dir tsdf/sess1/lq-coalesced-invalidations
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      1.811s | 🗂️ list-dir tsdf/sess1/lq-coalesced-invalidations
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      1.853s | 📖 #1 tsdf/sess1/lq-coalesced-invalidations/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata)) | 0.08 kb
      1.905s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      1.906s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-coalesced-invalidations (store directory)
      1.907s | 📄 file-open-or-create ✅ #2 tsdf/sess1/lq-coalesced-invalidations/li.%22users%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (payload))
      .      | 📄 file-open-or-create ✅ #1 tsdf/sess1/lq-coalesced-invalidations/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata))
      1.91s  | ✍️ #2 tsdf/sess1/lq-coalesced-invalidations/li.%22users%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ #1 tsdf/sess1/lq-coalesced-invalidations/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata)) | 0.08 kb -> 0.08 kb
      3.912s | 🗂️ list-dir tsdf/sess1/lq-coalesced-invalidations
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      3.914s | 📖 #3 tsdf/sess1/lq-coalesced-invalidations/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.lq.{tableId:"users"} (metadata)) | 0.13 kb
      3.966s | 🗂️ list-dir tsdf/sess1/lq-coalesced-invalidations
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      3.968s | 📖 #1 tsdf/sess1/lq-coalesced-invalidations/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata)) | 0.08 kb
      4.02s  | end
      "
    `);
  });

  test('list-query invalidation preserves offline markers added by another tab before item and query manifest updates', async () => {
    const storeName = 'lq-offline-marker-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
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
    expect(readEntryMetadata(mockAdapter, itemStorageKey))
      .toMatchInlineSnapshot(`
        customMetadata: { o: '✅', p: 'users||1' }
        key: '"users||1'
        lastAccessAt: 1735689605015
        payloadRef: '__tsdf_payload__:"users||1'
        version: 1
        writtenAt: 1735689605015
      `);
    expect(
      getParsedOpfsEntryFiles(
        listQueryScope.listQuery.itemNamespace,
        listQueryScope.listQuery.itemKey('users', 1),
      ),
    ).toMatchInlineSnapshot(`
      metadata: { a: 1735689605015, o: '✅', p: 'users||1', v: 1 }
      payload:
        d: { id: 1, name: 'Fresh user' }
        lf: ['age', 'email', 'id', 'name']
        p: 'users||1'
    `);
    expect(readEntryMetadata(mockAdapter, queryStorageKey))
      .toMatchInlineSnapshot(`
        customMetadata:
          i: ['"users||1', '"users||2']
          o: '✅'
          p: { tableId: 'users' }

        key: '{tableId:"users"}'
        lastAccessAt: 1735689605015
        payloadRef: '__tsdf_payload__:{tableId:"users"}'
        version: 1
        writtenAt: 1735689605015
      `);
    expect(
      getParsedOpfsEntryFiles(
        listQueryScope.listQuery.queryNamespace,
        listQueryScope.listQuery.queryKey(usersQuery),
      ),
    ).toMatchInlineSnapshot(`
      metadata:
        a: 1735689605015
        i: ['"users||1', '"users||2']
        o: '✅'
        p: { tableId: 'users' }
        v: 1

      payload:
        i: ['"users||1', '"users||2']
        p: { tableId: 'users' }
    `);
  });

  test('query hook remount skips touch writes when the cached query and item are still in the current recency bucket', async () => {
    const storeName = 'lq-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
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
      time  |
      0     | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms   | 📂 dir-open ✅ tsdf/sess1/lq-remount-flow (store directory)
      2ms   | 📄 file-open ✅ #1 tsdf/sess1/lq-remount-flow/lq.%7BtableId%3A%22users%22%7D.p.json
            |    └ (tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (payload))
      .     | 📄 file-open ✅ #2 tsdf/sess1/lq-remount-flow/lq.%7BtableId%3A%22users%22%7D.m.json
            |    └ (tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (metadata))
      4ms   | 📖 #1 tsdf/sess1/lq-remount-flow/lq.%7BtableId%3A%22users%22%7D.p.json
            |    └ (tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (payload)) | 0.09 kb
      .     | 📖 #2 tsdf/sess1/lq-remount-flow/lq.%7BtableId%3A%22users%22%7D.m.json
            |    └ (tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (metadata)) | 0.13 kb
      56ms  | 📄 file-open ✅ #3 tsdf/sess1/lq-remount-flow/li.%22users%7C%7C1.p.json
            |    └ (tsdf.sess1.lq-remount-flow.li."users||1 (payload))
      .     | 📄 file-open ✅ #4 tsdf/sess1/lq-remount-flow/li.%22users%7C%7C1.m.json
            |    └ (tsdf.sess1.lq-remount-flow.li."users||1 (metadata))
      58ms  | 📖 #3 tsdf/sess1/lq-remount-flow/li.%22users%7C%7C1.p.json
            |    └ (tsdf.sess1.lq-remount-flow.li."users||1 (payload)) | 0.10 kb
      .     | 📖 #4 tsdf/sess1/lq-remount-flow/li.%22users%7C%7C1.m.json
            |    └ (tsdf.sess1.lq-remount-flow.li."users||1 (metadata)) | 0.08 kb
      110ms | end
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
      2ms  | 📄 file-open ✅ #1 tsdf/sess1/lq-remount-stale-touch/lq.%7BtableId%3A%22users%22%7D.p.json
           |    └ (tsdf.sess1.lq-remount-stale-touch.lq.{tableId:"users"} (payload))
      .    | 📄 file-open ✅ #2 tsdf/sess1/lq-remount-stale-touch/lq.%7BtableId%3A%22users%22%7D.m.json
           |    └ (tsdf.sess1.lq-remount-stale-touch.lq.{tableId:"users"} (metadata))
      4ms  | 📖 #1 tsdf/sess1/lq-remount-stale-touch/lq.%7BtableId%3A%22users%22%7D.p.json
           |    └ (tsdf.sess1.lq-remount-stale-touch.lq.{tableId:"users"} (payload)) | 0.09 kb
      .    | 📖 #2 tsdf/sess1/lq-remount-stale-touch/lq.%7BtableId%3A%22users%22%7D.m.json
           |    └ (tsdf.sess1.lq-remount-stale-touch.lq.{tableId:"users"} (metadata)) | 0.13 kb
      6ms  | 📄 file-open ✅ #3 tsdf/sess1/lq-remount-stale-touch/li.%22users%7C%7C1.p.json
           |    └ (tsdf.sess1.lq-remount-stale-touch.li."users||1 (payload))
      .    | 📄 file-open ✅ #4 tsdf/sess1/lq-remount-stale-touch/li.%22users%7C%7C1.m.json
           |    └ (tsdf.sess1.lq-remount-stale-touch.li."users||1 (metadata))
      8ms  | 📖 #3 tsdf/sess1/lq-remount-stale-touch/li.%22users%7C%7C1.p.json
           |    └ (tsdf.sess1.lq-remount-stale-touch.li."users||1 (payload)) | 0.10 kb
      .    | 📖 #4 tsdf/sess1/lq-remount-stale-touch/li.%22users%7C%7C1.m.json
           |    └ (tsdf.sess1.lq-remount-stale-touch.li."users||1 (metadata)) | 0.08 kb
      47ms | 📖 #2 tsdf/sess1/lq-remount-stale-touch/lq.%7BtableId%3A%22users%22%7D.m.json
           |    └ (tsdf.sess1.lq-remount-stale-touch.lq.{tableId:"users"} (metadata)) | 0.13 kb
      49ms | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      50ms | 📂 dir-open ✅ tsdf/sess1 (session directory)
      .    | 📁 dir-open-or-create ✅ tsdf/sess1/lq-remount-stale-touch (store directory)
      51ms | 📂 dir-open ✅ tsdf/sess1/lq-remount-stale-touch (store directory)
      .    | 📄 file-open-or-create ✅ #2 tsdf/sess1/lq-remount-stale-touch/lq.%7BtableId%3A%22users%22%7D.m.json
           |    └ (tsdf.sess1.lq-remount-stale-touch.lq.{tableId:"users"} (metadata))
      53ms | 📖 #4 tsdf/sess1/lq-remount-stale-touch/li.%22users%7C%7C1.m.json
           |    └ (tsdf.sess1.lq-remount-stale-touch.li."users||1 (metadata)) | 0.08 kb
      54ms | ✍️ #2 tsdf/sess1/lq-remount-stale-touch/lq.%7BtableId%3A%22users%22%7D.m.json
           |    └ (tsdf.sess1.lq-remount-stale-touch.lq.{tableId:"users"} (metadata)) | 0.13 kb -> 0.13 kb
      55ms | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      56ms | 📁 dir-open-or-create ✅ tsdf/sess1/lq-remount-stale-touch (store directory)
      57ms | 📄 file-open-or-create ✅ #4 tsdf/sess1/lq-remount-stale-touch/li.%22users%7C%7C1.m.json
           |    └ (tsdf.sess1.lq-remount-stale-touch.li."users||1 (metadata))
      60ms | ✍️ #4 tsdf/sess1/lq-remount-stale-touch/li.%22users%7C%7C1.m.json
           |    └ (tsdf.sess1.lq-remount-stale-touch.li."users||1 (metadata)) | 0.08 kb -> 0.08 kb
      62ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useItem invalidation snapshots the full item persistence timeline through the refetch save', async () => {
    const storeName = 'lq-item-invalidation-flow';
    const sessionKey = 'sess1';
    const itemPayload = rawItemPayload('users', 1);
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
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
    const invalidationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
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
    expect(listQueryScope.listQuery.readItemData('users', 1))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Fresh user'
      `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.81s  | 🗂️ list-dir tsdf/sess1/lq-item-invalidation-flow
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json"]
      1.811s | 🗂️ list-dir tsdf/sess1/lq-item-invalidation-flow
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json"]
      1.853s | 📖 #1 tsdf/sess1/lq-item-invalidation-flow/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata)) | 0.08 kb
      1.905s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      1.906s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-item-invalidation-flow (store directory)
      1.907s | 📄 file-open-or-create ✅ #2 tsdf/sess1/lq-item-invalidation-flow/li.%22users%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (payload))
      .      | 📄 file-open-or-create ✅ #1 tsdf/sess1/lq-item-invalidation-flow/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata))
      1.91s  | ✍️ #2 tsdf/sess1/lq-item-invalidation-flow/li.%22users%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ #1 tsdf/sess1/lq-item-invalidation-flow/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata)) | 0.08 kb -> 0.08 kb
      3.912s | 🗂️ list-dir tsdf/sess1/lq-item-invalidation-flow
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json"]
      3.913s | 🗂️ list-dir tsdf/sess1/lq-item-invalidation-flow
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json"]
      3.915s | 📖 #1 tsdf/sess1/lq-item-invalidation-flow/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata)) | 0.08 kb
      3.967s | end
      "
    `);
  });

  test('item hook remount skips the touch write when the cached standalone item is still in the current recency bucket', async () => {
    const storeName = 'lq-item-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
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
    // The snapshot ends after the initial payload+metadata reads, which makes the
    // skipped touch explicit.
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/lq-item-remount-flow (store directory)
      2ms  | 📄 file-open ✅ #1 tsdf/sess1/lq-item-remount-flow/li.%22users%7C%7C1.p.json
           |    └ (tsdf.sess1.lq-item-remount-flow.li."users||1 (payload))
      .    | 📄 file-open ✅ #2 tsdf/sess1/lq-item-remount-flow/li.%22users%7C%7C1.m.json
           |    └ (tsdf.sess1.lq-item-remount-flow.li."users||1 (metadata))
      4ms  | 📖 #1 tsdf/sess1/lq-item-remount-flow/li.%22users%7C%7C1.p.json
           |    └ (tsdf.sess1.lq-item-remount-flow.li."users||1 (payload)) | 0.10 kb
      .    | 📖 #2 tsdf/sess1/lq-item-remount-flow/li.%22users%7C%7C1.m.json
           |    └ (tsdf.sess1.lq-item-remount-flow.li."users||1 (metadata)) | 0.08 kb
      56ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useMultipleItems remount reuses hydrated standalone list-query items without touching localStorage again', async () => {
    const storeName = 'lq-multi-item-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
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
      1ms  | 📂 dir-open ✅ tsdf/sess1/lq-multi-item-remount-flow (store directory)
      2ms  | 📄 file-open ✅ #1 tsdf/sess1/lq-multi-item-remount-flow/li.%22users%7C%7C1.p.json
           |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (payload))
      .    | 📄 file-open ✅ #2 tsdf/sess1/lq-multi-item-remount-flow/li.%22users%7C%7C1.m.json
           |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (metadata))
      .    | 📄 file-open ✅ #3 tsdf/sess1/lq-multi-item-remount-flow/li.%22users%7C%7C2.p.json
           |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (payload))
      .    | 📄 file-open ✅ #4 tsdf/sess1/lq-multi-item-remount-flow/li.%22users%7C%7C2.m.json
           |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (metadata))
      4ms  | 📖 #1 tsdf/sess1/lq-multi-item-remount-flow/li.%22users%7C%7C1.p.json
           |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (payload)) | 0.10 kb
      .    | 📖 #2 tsdf/sess1/lq-multi-item-remount-flow/li.%22users%7C%7C1.m.json
           |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (metadata)) | 0.08 kb
      .    | 📖 #3 tsdf/sess1/lq-multi-item-remount-flow/li.%22users%7C%7C2.p.json
           |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (payload)) | 0.10 kb
      .    | 📖 #4 tsdf/sess1/lq-multi-item-remount-flow/li.%22users%7C%7C2.m.json
           |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (metadata)) | 0.08 kb
      56ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useMultipleListQueries remount reuses hydrated queries without touching localStorage again', async () => {
    const storeName = 'lq-multi-query-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
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
      time  |
      0     | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms   | 📂 dir-open ✅ tsdf/sess1/lq-multi-query-remount-flow (store directory)
      2ms   | 📄 file-open ✅ #1 tsdf/sess1/lq-multi-query-remount-flow/lq.%7BtableId%3A%22users%22%7D.p.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (payload))
      .     | 📄 file-open ✅ #2 tsdf/sess1/lq-multi-query-remount-flow/lq.%7BtableId%3A%22users%22%7D.m.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (metadata))
      .     | 📄 file-open ✅ #3 tsdf/sess1/lq-multi-query-remount-flow/lq.%7BtableId%3A%22projects%22%7D.p.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (payload))
      .     | 📄 file-open ✅ #4 tsdf/sess1/lq-multi-query-remount-flow/lq.%7BtableId%3A%22projects%22%7D.m.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (metadata))
      4ms   | 📖 #1 tsdf/sess1/lq-multi-query-remount-flow/lq.%7BtableId%3A%22users%22%7D.p.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (payload)) | 0.09 kb
      .     | 📖 #2 tsdf/sess1/lq-multi-query-remount-flow/lq.%7BtableId%3A%22users%22%7D.m.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (metadata)) | 0.13 kb
      .     | 📖 #3 tsdf/sess1/lq-multi-query-remount-flow/lq.%7BtableId%3A%22projects%22%7D.p.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (payload)) | 0.10 kb
      .     | 📖 #4 tsdf/sess1/lq-multi-query-remount-flow/lq.%7BtableId%3A%22projects%22%7D.m.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (metadata)) | 0.14 kb
      56ms  | 📄 file-open ✅ #5 tsdf/sess1/lq-multi-query-remount-flow/li.%22users%7C%7C1.p.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (payload))
      .     | 📄 file-open ✅ #6 tsdf/sess1/lq-multi-query-remount-flow/li.%22users%7C%7C1.m.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (metadata))
      .     | 📄 file-open ✅ #7 tsdf/sess1/lq-multi-query-remount-flow/li.%22projects%7C%7C1.p.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (payload))
      .     | 📄 file-open ✅ #8 tsdf/sess1/lq-multi-query-remount-flow/li.%22projects%7C%7C1.m.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (metadata))
      58ms  | 📖 #5 tsdf/sess1/lq-multi-query-remount-flow/li.%22users%7C%7C1.p.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (payload)) | 0.10 kb
      .     | 📖 #6 tsdf/sess1/lq-multi-query-remount-flow/li.%22users%7C%7C1.m.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (metadata)) | 0.08 kb
      .     | 📖 #7 tsdf/sess1/lq-multi-query-remount-flow/li.%22projects%7C%7C1.p.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (payload)) | 0.11 kb
      .     | 📖 #8 tsdf/sess1/lq-multi-query-remount-flow/li.%22projects%7C%7C1.m.json
            |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (metadata)) | 0.08 kb
      110ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('updating a hydrated list-query item writes the mutation without rereading cached entries', async () => {
    const storeName = 'lq-mutation-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);
    const itemStorageKey = listQueryScope.listQuery.itemStorageKey('users', 1);

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
    const mutationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    act(() => {
      env.apiStore.updateItemState(rawItemPayload('users', 1), (draft) => {
        draft.name = 'Edited user';
      });
    });
    await advanceTime(1100);
    await flushAllTimers();
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(listQueryScope.listQuery.readItemData('users', 1))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Edited user'
      `);
    expect(readEntryMetadata(mockAdapter, itemStorageKey))
      .toMatchInlineSnapshot(`
        customMetadata: { p: 'users||1' }
        key: '"users||1'
        lastAccessAt: 1735689604205
        payloadRef: '__tsdf_payload__:"users||1'
        version: 1
        writtenAt: 1735689604205
      `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1s     | 🗂️ list-dir tsdf/sess1/lq-mutation-flow
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      1.001s | 🗂️ list-dir tsdf/sess1/lq-mutation-flow
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      1.043s | 📖 #1 tsdf/sess1/lq-mutation-flow/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata)) | 0.08 kb
      1.095s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      1.096s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-mutation-flow (store directory)
      1.097s | 📄 file-open-or-create ✅ #2 tsdf/sess1/lq-mutation-flow/li.%22users%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (payload))
      .      | 📄 file-open-or-create ✅ #1 tsdf/sess1/lq-mutation-flow/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata))
      1.1s   | ✍️ #2 tsdf/sess1/lq-mutation-flow/li.%22users%7C%7C1.p.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ #1 tsdf/sess1/lq-mutation-flow/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata)) | 0.08 kb -> 0.08 kb
      3.102s | 🗂️ list-dir tsdf/sess1/lq-mutation-flow
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      3.104s | 📖 #3 tsdf/sess1/lq-mutation-flow/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.lq-mutation-flow.lq.{tableId:"users"} (metadata)) | 0.13 kb
      3.156s | 🗂️ list-dir tsdf/sess1/lq-mutation-flow
             |    └ (store directory) entries=["file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      3.158s | 📖 #1 tsdf/sess1/lq-mutation-flow/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata)) | 0.08 kb
      3.21s  | end
      "
    `);
  });

  test('list query preload reads only the requested query and its referenced items', async () => {
    const storeName = 'list-query-opfs-efficiency';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
      initialState: {
        storeName,
        sessionKey,
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
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);
    const usersItemKey = listQueryScope.listQuery.itemStorageKey('users', 1);
    const projectsItemKey = listQueryScope.listQuery.itemStorageKey(
      'projects',
      1,
    );
    const usersQueryKey = listQueryScope.listQuery.queryStorageKey(usersQuery);
    const projectsQueryKey =
      listQueryScope.listQuery.queryStorageKey(projectsQuery);
    const env = createListQueryEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await resolveAfterAllTimers(preloadPromise);

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms   | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-efficiency (store directory)
      2ms   | 📄 file-open ✅ #1 tsdf/sess1/list-query-opfs-efficiency/lq.%7BtableId%3A%22users%22%7D.p.json
            |    └ (tsdf.sess1.list-query-opfs-efficiency.lq.{tableId:"users"} (payload))
      .     | 📄 file-open ✅ #2 tsdf/sess1/list-query-opfs-efficiency/lq.%7BtableId%3A%22users%22%7D.m.json
            |    └ (tsdf.sess1.list-query-opfs-efficiency.lq.{tableId:"users"} (metadata))
      4ms   | 📖 #1 tsdf/sess1/list-query-opfs-efficiency/lq.%7BtableId%3A%22users%22%7D.p.json
            |    └ (tsdf.sess1.list-query-opfs-efficiency.lq.{tableId:"users"} (payload)) | 0.09 kb
      .     | 📖 #2 tsdf/sess1/list-query-opfs-efficiency/lq.%7BtableId%3A%22users%22%7D.m.json
            |    └ (tsdf.sess1.list-query-opfs-efficiency.lq.{tableId:"users"} (metadata)) | 0.13 kb
      56ms  | 📄 file-open ✅ #3 tsdf/sess1/list-query-opfs-efficiency/li.%22users%7C%7C1.p.json
            |    └ (tsdf.sess1.list-query-opfs-efficiency.li."users||1 (payload))
      .     | 📄 file-open ✅ #4 tsdf/sess1/list-query-opfs-efficiency/li.%22users%7C%7C1.m.json
            |    └ (tsdf.sess1.list-query-opfs-efficiency.li."users||1 (metadata))
      58ms  | 📖 #3 tsdf/sess1/list-query-opfs-efficiency/li.%22users%7C%7C1.p.json
            |    └ (tsdf.sess1.list-query-opfs-efficiency.li."users||1 (payload)) | 0.09 kb
      .     | 📖 #4 tsdf/sess1/list-query-opfs-efficiency/li.%22users%7C%7C1.m.json
            |    └ (tsdf.sess1.list-query-opfs-efficiency.li."users||1 (metadata)) | 0.08 kb
      110ms | end
      "
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
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    env.scheduleFetch('highPriority', tasksQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time   |
      1.85s  | 📄 file-open ❌ #1 tsdf/sess1/list-query-opfs-eviction-efficiency/lq.%7BtableId%3A%22tasks%22%7D.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata))
      .      | 📄 file-open ❌ #2 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22tasks%7C%7C1.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata))
      1.851s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      .      | 📖 #3 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22projects%7C%7C1.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata)) | 0.08 kb
      1.852s | 📁 dir-open-or-create ✅ tsdf/sess1/list-query-opfs-eviction-efficiency
             |    └ (store directory)
      1.853s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      .      | 📄 file-open-or-create 🆕 #4 tsdf/sess1/list-query-opfs-eviction-efficiency/lq.%7BtableId%3A%22tasks%22%7D.p.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (payload))
      .      | 📄 file-open-or-create 🆕 #1 tsdf/sess1/list-query-opfs-eviction-efficiency/lq.%7BtableId%3A%22tasks%22%7D.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata))
      1.854s | 📁 dir-open-or-create ✅ tsdf/sess1/list-query-opfs-eviction-efficiency
             |    └ (store directory)
      1.855s | 📄 file-open-or-create ✅ #5 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22projects%7C%7C1.p.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (payload))
      .      | 📄 file-open-or-create ✅ #3 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22projects%7C%7C1.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata))
      .      | 📄 file-open-or-create 🆕 #6 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22tasks%7C%7C1.p.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (payload))
      .      | 📄 file-open-or-create 🆕 #2 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22tasks%7C%7C1.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata))
      1.856s | ✍️ #4 tsdf/sess1/list-query-opfs-eviction-efficiency/lq.%7BtableId%3A%22tasks%22%7D.p.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ #1 tsdf/sess1/list-query-opfs-eviction-efficiency/lq.%7BtableId%3A%22tasks%22%7D.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata)) | 0.00 kb -> 0.13 kb
      1.858s | ✍️ #5 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22projects%7C%7C1.p.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ #3 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22projects%7C%7C1.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata)) | 0.08 kb -> 0.08 kb
      .      | ✍️ #6 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22tasks%7C%7C1.p.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ #2 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22tasks%7C%7C1.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata)) | 0.00 kb -> 0.08 kb
      3.86s  | 🗂️ list-dir tsdf/sess1/list-query-opfs-eviction-efficiency
             |    └ (store directory) entries=["file:li.%22projects%7C%7C1.m.json","file:li.%22projects%7C%7C1.p.json","file:li.%22tasks%7C%7C1.m.json","file:li.%22tasks%7C%7C1.p.json","file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22projects%22%7D.m.json","file:lq.%7BtableId%3A%22projects%22%7D.p.json","file:lq.%7BtableId%3A%22tasks%22%7D.m.json","file:lq.%7BtableId%3A%22tasks%22%7D.p.json","file:lq.%7BtableId%3A%22users%22%7D.m.json","file:lq.%7BtableId%3A%22users%22%7D.p.json"]
      3.862s | 📖 #7 tsdf/sess1/list-query-opfs-eviction-efficiency/lq.%7BtableId%3A%22projects%22%7D.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"projects"} (metadata)) | 0.14 kb
      .      | 📖 #1 tsdf/sess1/list-query-opfs-eviction-efficiency/lq.%7BtableId%3A%22tasks%22%7D.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata)) | 0.13 kb
      .      | 📖 #8 tsdf/sess1/list-query-opfs-eviction-efficiency/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"users"} (metadata)) | 0.13 kb
      3.904s | 🗑️ ✅ #9 tsdf/sess1/list-query-opfs-eviction-efficiency/lq.%7BtableId%3A%22users%22%7D.p.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"users"} (payload))
      .      | 🗑️ ✅ #8 tsdf/sess1/list-query-opfs-eviction-efficiency/lq.%7BtableId%3A%22users%22%7D.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"users"} (metadata))
      3.905s | 🧹 del-dir ❌ tsdf/sess1/list-query-opfs-eviction-efficiency (store directory)
      3.906s | 🗂️ list-dir tsdf/sess1/list-query-opfs-eviction-efficiency
             |    └ (store directory) entries=["file:li.%22projects%7C%7C1.m.json","file:li.%22projects%7C%7C1.p.json","file:li.%22tasks%7C%7C1.m.json","file:li.%22tasks%7C%7C1.p.json","file:li.%22users%7C%7C1.m.json","file:li.%22users%7C%7C1.p.json","file:lq.%7BtableId%3A%22projects%22%7D.m.json","file:lq.%7BtableId%3A%22projects%22%7D.p.json","file:lq.%7BtableId%3A%22tasks%22%7D.m.json","file:lq.%7BtableId%3A%22tasks%22%7D.p.json"]
      3.908s | 📖 #3 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22projects%7C%7C1.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata)) | 0.08 kb
      .      | 📖 #2 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22tasks%7C%7C1.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata)) | 0.08 kb
      .      | 📖 #10 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."users||1 (metadata)) | 0.08 kb
      3.95s  | 🗑️ ✅ #11 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22users%7C%7C1.p.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."users||1 (payload))
      .      | 🗑️ ✅ #10 tsdf/sess1/list-query-opfs-eviction-efficiency/li.%22users%7C%7C1.m.json
             |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."users||1 (metadata))
      3.951s | 🧹 del-dir ❌ tsdf/sess1/list-query-opfs-eviction-efficiency (store directory)
      3.952s | end
      "
    `);
  });
});
