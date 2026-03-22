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
import { advanceTime, flushAllTimers } from '../../utils/genericTestUtils';

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
    listQueryScope.listQuery.registerNamespaces();

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
      simplified
      time   |
      2.01s  | 🗂️ tsdf/sess1/list-query-expiration/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22expired-users%7C%7C1.json","file:__tsdf_meta__%3A%22fresh-users%7C%7C2.json","file:__tsdf_payload__%3A%22expired-users%7C%7C1.json","file:__tsdf_payload__%3A%22fresh-users%7C%7C2.json"]
      2.012s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.00 kb -> 0.23 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.36 kb
      2.013s | 🗑️ ✅ tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_payload__%3A%22expired-users%7C%7C1.json
             |    └ (tsdf.sess1.list-query-expiration.li."expired-users||1 (payload))
      .      | 🗑️ ✅ tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_meta__%3A%22expired-users%7C%7C1.json
             |    └ (tsdf.sess1.list-query-expiration.li."expired-users||1 (metadata))
      .      | 🗂️ tsdf/sess1/list-query-expiration/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22fresh-users%7C%7C2.json","file:__tsdf_payload__%3A%22fresh-users%7C%7C2.json"]
      2.015s | 📖 tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_meta__%3A%22expired-users%7C%7C1.json
             |    └ (tsdf.sess1.list-query-expiration.li."expired-users||1 (metadata)) | 0.30 kb
      .      | 📖 tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_meta__%3A%22fresh-users%7C%7C2.json
             |    └ (tsdf.sess1.list-query-expiration.li."fresh-users||2 (metadata)) | 0.29 kb
      .      | 🗂️ tsdf/sess1/list-query-expiration/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22expired-users%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22fresh-users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22expired-users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22fresh-users%22%7D.json"]
      2.018s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.36 kb
      .      | 🗑️ ✅ tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22expired-users%22%7D.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (payload))
      .      | 🗑️ ✅ tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22expired-users%22%7D.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (metadata))
      .      | 🗂️ tsdf/sess1/list-query-expiration/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22fresh-users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22fresh-users%22%7D.json"]
      2.02s  | 📖 tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22expired-users%22%7D.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (metadata)) | 0.38 kb
      .      | 📖 tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fresh-users%22%7D.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"fresh-users"} (metadata)) | 0.37 kb
      2.023s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.36 kb
      2.024s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb
      2.026s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb -> 0.13 kb

      verbose
      time   |
      2.002s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.003s | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.004s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.005s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.006s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.007s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.008s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.009s | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📂 dir-open ✅ tsdf/sess1/list-query-expiration (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.01s  | 📂 dir-open ✅ tsdf/sess1/list-query-expiration/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/list-query-expiration/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22expired-users%7C%7C1.json","file:__tsdf_meta__%3A%22fresh-users%7C%7C2.json","file:__tsdf_payload__%3A%22expired-users%7C%7C1.json","file:__tsdf_payload__%3A%22fresh-users%7C%7C2.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/list-query-expiration (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.011s | 📂 dir-open ✅ tsdf/sess1/list-query-expiration/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/list-query-expiration (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.012s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.00 kb -> 0.23 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.36 kb
      .      | 📄 file-open ✅ tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_meta__%3A%22expired-users%7C%7C1.json
             |    └ (tsdf.sess1.list-query-expiration.li."expired-users||1 (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_meta__%3A%22fresh-users%7C%7C2.json
             |    └ (tsdf.sess1.list-query-expiration.li."fresh-users||2 (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/list-query-expiration/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/list-query-expiration (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.013s | 🗑️ ✅ tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_payload__%3A%22expired-users%7C%7C1.json
             |    └ (tsdf.sess1.list-query-expiration.li."expired-users||1 (payload))
      .      | 🗑️ ✅ tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_meta__%3A%22expired-users%7C%7C1.json
             |    └ (tsdf.sess1.list-query-expiration.li."expired-users||1 (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/list-query-expiration/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/list-query-expiration/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22fresh-users%7C%7C2.json","file:__tsdf_payload__%3A%22fresh-users%7C%7C2.json"]
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.014s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/list-query-expiration (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.015s | 📖 tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_meta__%3A%22expired-users%7C%7C1.json
             |    └ (tsdf.sess1.list-query-expiration.li."expired-users||1 (metadata)) | 0.30 kb
      .      | 📖 tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_meta__%3A%22fresh-users%7C%7C2.json
             |    └ (tsdf.sess1.list-query-expiration.li."fresh-users||2 (metadata)) | 0.29 kb
      .      | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📂 dir-open ✅ tsdf/sess1/list-query-expiration/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/list-query-expiration/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22expired-users%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22fresh-users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22expired-users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22fresh-users%22%7D.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/list-query-expiration (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.016s | 📂 dir-open ✅ tsdf/sess1/list-query-expiration/listQuery.query (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/list-query-expiration (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.017s | 📄 file-open ✅ tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22expired-users%22%7D.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fresh-users%22%7D.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"fresh-users"} (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/list-query-expiration/listQuery.query (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/list-query-expiration (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.018s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.36 kb
      .      | 🗑️ ✅ tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22expired-users%22%7D.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (payload))
      .      | 🗑️ ✅ tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22expired-users%22%7D.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/list-query-expiration/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/list-query-expiration/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22fresh-users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22fresh-users%22%7D.json"]
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.019s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.02s  | 📖 tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22expired-users%22%7D.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (metadata)) | 0.38 kb
      .      | 📖 tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fresh-users%22%7D.json
             |    └ (tsdf.sess1.list-query-expiration.lq.{tableId:"fresh-users"} (metadata)) | 0.37 kb
      .      | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      2.021s | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      2.022s | 📄 file-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      2.023s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.36 kb
      2.024s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb
      2.026s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb -> 0.13 kb
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
    const thirdItemKey = listQueryScope.listQuery.itemStorageKey('third', 1);
    const thirdQueryKey = listQueryScope.listQuery.queryStorageKey(thirdQuery);

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
      simplified
      time   |
      4.914s | 🗂️ tsdf/sess1/lq-query-metadata/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json"]
      4.959s | ✍️ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata)) | 0.00 kb -> 0.34 kb
      4.961s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.19 kb
      4.963s | ✍️ tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (metadata)) | 0.00 kb -> 0.27 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.19 kb
      4.965s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.19 kb -> 0.34 kb
      6.954s | 🗂️ tsdf/sess1/lq-query-metadata/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json"]
      6.959s | 📖 tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (metadata)) | 0.31 kb
      .      | 📖 tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"second"} (metadata)) | 0.32 kb
      .      | 📖 tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata)) | 0.34 kb
      6.994s | 🗑️ ✅ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (payload))
      .      | 🗑️ ✅ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (metadata))
      .      | 🗂️ tsdf/sess1/lq-query-metadata/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json"]
      6.996s | 🗂️ tsdf/sess1/lq-query-metadata/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22third%7C%7C1.json","file:__tsdf_payload__%3A%22third%7C%7C1.json"]
      7.001s | 📖 tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (metadata)) | 0.27 kb

      verbose
      time   |
      4.911s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.912s | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.913s | 📂 dir-open ❌ tsdf/sess1/lq-query-metadata/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata (store directory)
      4.914s | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-query-metadata/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json"]
      4.951s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.952s | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      4.953s | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-query-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      4.954s | 📄 file-open ❌ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata))
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      4.955s | 📄 file-open-or-create 🆕 tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (payload))
      .      | 📄 file-open-or-create 🆕 tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.956s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      4.957s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📂 dir-open ❌ tsdf/sess1/lq-query-metadata/listQuery.item (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-query-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      4.958s | 📁 dir-open-or-create 🆕 tsdf/sess1/lq-query-metadata/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      4.959s | ✍️ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata)) | 0.00 kb -> 0.34 kb
      .      | 📄 file-open-or-create 🆕 tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (payload))
      .      | 📄 file-open-or-create 🆕 tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      4.96s  | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      4.961s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.19 kb
      .      | 📄 file-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      4.963s | ✍️ tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (metadata)) | 0.00 kb -> 0.27 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.19 kb
      4.965s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.19 kb -> 0.34 kb
      6.951s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.952s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.953s | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.954s | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-query-metadata/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata (store directory)
      6.955s | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory)
      6.956s | 📄 file-open ✅ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"second"} (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata))
      6.959s | 📖 tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (metadata)) | 0.31 kb
      .      | 📖 tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"second"} (metadata)) | 0.32 kb
      .      | 📖 tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata)) | 0.34 kb
      6.991s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.992s | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.993s | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.994s | 🗑️ ✅ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (payload))
      .      | 🗑️ ✅ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json
             |    └ (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-query-metadata/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json"]
      .      | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.995s | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.996s | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-query-metadata/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22third%7C%7C1.json","file:__tsdf_payload__%3A%22third%7C%7C1.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata (store directory)
      6.997s | 📂 dir-open ✅ tsdf/sess1/lq-query-metadata/listQuery.item (scope directory)
      6.998s | 📄 file-open ✅ tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (metadata))
      7.001s | 📖 tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-metadata.li."third||1 (metadata)) | 0.27 kb
      "
    `);
    expect(getParsedOpfsEntryFiles(mockAdapter, thirdItemKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata: { p: 'third||1' }
          key: '"third||1'
          lastAccessAt: 1735689604950
          sizeBytes: 44
          version: 1
          writtenAt: 1735689604950

        payload:
          d: { id: 1, name: 'Third' }
          p: 'third||1'
      `);
    expect(getParsedOpfsEntryFiles(mockAdapter, thirdQueryKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata:
            i: ['"third||1']
            p: { tableId: 'third' }
          key: '{tableId:"third"}'
          lastAccessAt: 1735689604950
          sizeBytes: 44
          version: 1
          writtenAt: 1735689604950

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
      simplified
      time   |
      4.914s | 🗂️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json"]
      4.959s | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata)) | 0.00 kb -> 0.34 kb
      4.961s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.21 kb
      4.963s | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata)) | 0.00 kb -> 0.27 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.21 kb
      4.965s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.21 kb -> 0.39 kb
      6.769s | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22fourth%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata)) | 0.00 kb -> 0.34 kb
      .      | 📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata)) | 0.27 kb
      6.771s | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (payload)) | 0.09 kb -> 0.15 kb
      .      | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata)) | 0.27 kb -> 0.27 kb
      .      | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22fourth%7C%7C2.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22fourth%7C%7C2.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata)) | 0.00 kb -> 0.27 kb
      6.954s | 🗂️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22fourth%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json"]
      6.959s | 📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (metadata)) | 0.31 kb
      .      | 📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata)) | 0.34 kb
      .      | 📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (metadata)) | 0.32 kb
      .      | 📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata)) | 0.34 kb
      6.994s | 🗑️ ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (payload))
      .      | 🗑️ ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (metadata))
      .      | 🗑️ ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (payload))
      .      | 🗑️ ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (metadata))
      .      | 🗂️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22fourth%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json"]
      6.996s | 🗂️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22fourth%7C%7C2.json","file:__tsdf_meta__%3A%22third%7C%7C1.json","file:__tsdf_payload__%3A%22fourth%7C%7C2.json","file:__tsdf_payload__%3A%22third%7C%7C1.json"]
      7.001s | 📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22fourth%7C%7C2.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata)) | 0.27 kb
      .      | 📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata)) | 0.27 kb

      verbose
      time   |
      4.911s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.912s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.913s | 📂 dir-open ❌ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      4.914s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json"]
      4.951s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.952s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      4.953s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      4.954s | 📄 file-open ❌ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata))
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      4.955s | 📄 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (payload))
      .      | 📄 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.956s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      4.957s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📂 dir-open ❌ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      4.958s | 📁 dir-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      4.959s | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata)) | 0.00 kb -> 0.34 kb
      .      | 📄 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (payload))
      .      | 📄 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      4.96s  | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      4.961s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.21 kb
      .      | 📄 file-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      4.963s | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata)) | 0.00 kb -> 0.27 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.21 kb
      4.965s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.21 kb -> 0.39 kb
      6.761s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.762s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      6.763s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.764s | 📄 file-open ❌ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata))
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      6.765s | 📄 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22fourth%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (payload))
      .      | 📄 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      6.766s | 📄 file-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))
      .      | 📄 file-open ❌ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22fourth%7C%7C2.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata))
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory)
      6.767s | 📄 file-open-or-create ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))
      .      | 📄 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22fourth%7C%7C2.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (payload))
      .      | 📄 file-open-or-create 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22fourth%7C%7C2.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata))
      6.769s | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22fourth%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata)) | 0.00 kb -> 0.34 kb
      .      | 📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata)) | 0.27 kb
      6.771s | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (payload)) | 0.09 kb -> 0.15 kb
      .      | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata)) | 0.27 kb -> 0.27 kb
      .      | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22fourth%7C%7C2.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22fourth%7C%7C2.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata)) | 0.00 kb -> 0.27 kb
      6.951s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.952s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.953s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.954s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22fourth%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      6.955s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)
      6.956s | 📄 file-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata))
      6.959s | 📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (metadata)) | 0.31 kb
      .      | 📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata)) | 0.34 kb
      .      | 📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (metadata)) | 0.32 kb
      .      | 📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata)) | 0.34 kb
      6.991s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.992s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.993s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.994s | 🗑️ ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (payload))
      .      | 🗑️ ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (metadata))
      .      | 🗑️ ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (payload))
      .      | 🗑️ ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22fourth%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json"]
      .      | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.995s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.996s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22fourth%7C%7C2.json","file:__tsdf_meta__%3A%22third%7C%7C1.json","file:__tsdf_payload__%3A%22fourth%7C%7C2.json","file:__tsdf_payload__%3A%22third%7C%7C1.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance (store directory)
      6.997s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory)
      6.998s | 📄 file-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22fourth%7C%7C2.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))
      7.001s | 📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22fourth%7C%7C2.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata)) | 0.27 kb
      .      | 📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata)) | 0.27 kb
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
    const queryStorageKey =
      listQueryScope.listQuery.queryStorageKey(usersQuery);

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
      simplified
      time   |
      4.859s | ✍️ tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (payload)) | 0.00 kb -> 0.18 kb
      .      | ✍️ tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata)) | 0.00 kb -> 0.55 kb
      4.861s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.20 kb
      6.854s | 🗂️ tsdf/sess1/lq-empty-query-manifest/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json"]
      6.859s | 📖 tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata)) | 0.55 kb

      verbose
      time   |
      4.811s | 📂 dir-open ❌ tsdf/sess1 (session directory)
      4.812s | 📂 dir-open ❌ tsdf/sess1 (session directory)
      4.851s | 📂 dir-open ❌ tsdf/sess1 (session directory)
      4.852s | 📁 dir-open-or-create 🆕 tsdf/sess1 (session directory)
      4.853s | 📁 dir-open-or-create 🆕 tsdf/sess1/lq-empty-query-manifest (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      4.854s | 📁 dir-open-or-create 🆕 tsdf/sess1/lq-empty-query-manifest/listQuery.query (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      4.855s | 📄 file-open-or-create 🆕 tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (payload))
      .      | 📄 file-open-or-create 🆕 tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      4.856s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      4.857s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      4.859s | ✍️ tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (payload)) | 0.00 kb -> 0.18 kb
      .      | ✍️ tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata)) | 0.00 kb -> 0.55 kb
      4.861s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.20 kb
      6.851s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.852s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.853s | 📂 dir-open ✅ tsdf/sess1/lq-empty-query-manifest (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.854s | 📂 dir-open ✅ tsdf/sess1/lq-empty-query-manifest/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-empty-query-manifest/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-empty-query-manifest (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.855s | 📂 dir-open ✅ tsdf/sess1/lq-empty-query-manifest/listQuery.query (scope directory)
      .      | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.856s | 📄 file-open ✅ tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/lq-empty-query-manifest (store directory)
      6.857s | 📂 dir-open ❌ tsdf/sess1/lq-empty-query-manifest/listQuery.item (scope directory)
      6.859s | 📖 tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata)) | 0.55 kb
      "
    `);
    expect(getParsedOpfsEntryFiles(mockAdapter, queryStorageKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata:
            i: []
            p:
              filters:
                - { field: 'name', op: 'eq', value: 'Missing user' }
              tableId: 'users'
          key: '{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}'
          lastAccessAt: 1735689604850
          sizeBytes: 94
          version: 1
          writtenAt: 1735689604850

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
    const itemStorageKey = listQueryScope.listQuery.itemStorageKey('users', 1);
    const queryStorageKey =
      listQueryScope.listQuery.queryStorageKey(usersQuery);

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

        timestamp: 1735689600000
        version: 1
      `);
    expect(listQueryScope.listQuery.readItemData('users', 1))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached user'
      `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      4.913s | 🗂️ tsdf/sess1/lq-query-becomes-empty/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      4.914s | 🗂️ tsdf/sess1/lq-query-becomes-empty/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      5.007s | 📖 tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata)) | 0.34 kb
      5.008s | ✍️ tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (payload)) | 0.09 kb -> 0.06 kb
      .      | ✍️ tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata)) | 0.34 kb -> 0.31 kb
      .      | 📖 tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata)) | 0.27 kb
      5.01s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.20 kb
      5.011s | ✍️ tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata)) | 0.27 kb -> 0.27 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.20 kb
      5.013s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.20 kb -> 0.36 kb
      7.003s | 🗂️ tsdf/sess1/lq-query-becomes-empty/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      7.053s | 🗂️ tsdf/sess1/lq-query-becomes-empty/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      7.058s | 📖 tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata)) | 0.31 kb
      7.108s | 📖 tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata)) | 0.27 kb

      verbose
      time   |
      4.911s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.912s | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.913s | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-query-becomes-empty/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty (store directory)
      4.914s | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-query-becomes-empty/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      4.951s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.952s | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.953s | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty (store directory)
      4.954s | 📄 file-open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item (scope directory)
      4.955s | 📄 file-open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata))
      5.001s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      5.002s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-query-becomes-empty (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      5.003s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      5.004s | 📄 file-open-or-create ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      5.005s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-query-becomes-empty (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      5.006s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      5.007s | 📖 tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata)) | 0.34 kb
      .      | 📄 file-open-or-create ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      5.008s | ✍️ tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (payload)) | 0.09 kb -> 0.06 kb
      .      | ✍️ tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata)) | 0.34 kb -> 0.31 kb
      .      | 📖 tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata)) | 0.27 kb
      .      | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      5.009s | 📄 file-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      5.01s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.20 kb
      5.011s | ✍️ tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata)) | 0.27 kb -> 0.27 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.20 kb
      5.013s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.20 kb -> 0.36 kb
      7.001s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.002s | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.003s | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-query-becomes-empty/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty (store directory)
      7.004s | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query (scope directory)
      7.005s | 📄 file-open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata))
      7.051s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.052s | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.053s | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-query-becomes-empty/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty (store directory)
      7.054s | 📂 dir-open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item (scope directory)
      7.055s | 📄 file-open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata))
      7.058s | 📖 tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata)) | 0.31 kb
      7.108s | 📖 tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata)) | 0.27 kb
      "
    `);
    expect(getParsedOpfsEntryFiles(mockAdapter, itemStorageKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata: { p: 'users||1' }
          key: '"users||1'
          lastAccessAt: 1735689600000
          sizeBytes: 83
          version: 1
          writtenAt: 1735689605000

        payload:
          d: { id: 1, name: 'Cached user' }
          lf: ['age', 'email', 'id', 'name']
          p: 'users||1'
      `);
    expect(getParsedOpfsEntryFiles(mockAdapter, queryStorageKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata:
            i: []
            p: { tableId: 'users' }
          key: '{tableId:"users"}'
          lastAccessAt: 1735689600000
          sizeBytes: 32
          version: 1
          writtenAt: 1735689605000

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
      simplified
      time   |
      4.103s | 🗂️ tsdf/sess1/lq-item-metadata/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C2.json"]
      4.104s | 🗂️ tsdf/sess1/lq-item-metadata/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      4.149s | ✍️ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_payload__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (metadata)) | 0.00 kb -> 0.27 kb
      4.151s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.18 kb
      6.144s | 🗂️ tsdf/sess1/lq-item-metadata/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      6.147s | 🗂️ tsdf/sess1/lq-item-metadata/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_meta__%3A%22users%7C%7C3.json","file:__tsdf_payload__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C3.json"]
      6.149s | 📖 tsdf/sess1/lq-item-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-item-metadata.lq.{tableId:"users"} (metadata)) | 0.36 kb
      6.152s | 📖 tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||1 (metadata)) | 0.27 kb
      .      | 📖 tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||2 (metadata)) | 0.27 kb
      .      | 📖 tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (metadata)) | 0.27 kb
      6.184s | 🗑️ ✅ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_payload__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (payload))
      .      | 🗑️ ✅ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (metadata))
      .      | 🗂️ tsdf/sess1/lq-item-metadata/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C2.json"]

      verbose
      time   |
      4.101s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.102s | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.103s | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-item-metadata/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C2.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata (store directory)
      4.104s | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-item-metadata/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      4.141s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.142s | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      4.143s | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-item-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      4.144s | 📄 file-open ❌ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (metadata))
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      4.145s | 📄 file-open-or-create 🆕 tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_payload__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (payload))
      .      | 📄 file-open-or-create 🆕 tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      4.146s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      4.147s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      4.149s | ✍️ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_payload__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (payload)) | 0.00 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (metadata)) | 0.00 kb -> 0.27 kb
      4.151s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.18 kb
      6.141s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.142s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.143s | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.144s | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-item-metadata/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.145s | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata/listQuery.query (scope directory)
      .      | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.146s | 📄 file-open ✅ tsdf/sess1/lq-item-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-item-metadata.lq.{tableId:"users"} (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.147s | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-item-metadata/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_meta__%3A%22users%7C%7C3.json","file:__tsdf_payload__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C3.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata (store directory)
      6.148s | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory)
      6.149s | 📖 tsdf/sess1/lq-item-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-item-metadata.lq.{tableId:"users"} (metadata)) | 0.36 kb
      .      | 📄 file-open ✅ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||1 (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||2 (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (metadata))
      6.152s | 📖 tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||1 (metadata)) | 0.27 kb
      .      | 📖 tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||2 (metadata)) | 0.27 kb
      .      | 📖 tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (metadata)) | 0.27 kb
      6.181s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.182s | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.183s | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata (store directory)
      6.184s | 🗑️ ✅ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_payload__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (payload))
      .      | 🗑️ ✅ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-item-metadata.li."users||3 (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-item-metadata/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C2.json"]
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
    listQueryScope.listQuery.registerNamespaces();

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
      simplified
      time   |
      2.31s  | 🗂️ tsdf/sess1/lq-shared-item-cleanup/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_meta__%3A%22users%7C%7C3.json","file:__tsdf_meta__%3A%22users%7C%7C4.json","file:__tsdf_payload__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C3.json","file:__tsdf_payload__%3A%22users%7C%7C4.json"]
      2.312s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.00 kb -> 0.23 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.36 kb
      .      | 🗂️ tsdf/sess1/lq-shared-item-cleanup/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.json"]
      2.315s | 📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||1 (metadata)) | 0.27 kb
      .      | 📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||2 (metadata)) | 0.27 kb
      .      | 📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||3 (metadata)) | 0.27 kb
      .      | 📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C4.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||4 (metadata)) | 0.27 kb
      2.317s | 📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)) | 0.58 kb
      .      | 📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"} (metadata)) | 0.57 kb
      2.318s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb
      2.32s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb -> 0.13 kb

      verbose
      time   |
      2.302s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.303s | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.304s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.305s | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.306s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.307s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.308s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.309s | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-shared-item-cleanup (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.31s  | 📂 dir-open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-shared-item-cleanup/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_meta__%3A%22users%7C%7C3.json","file:__tsdf_meta__%3A%22users%7C%7C4.json","file:__tsdf_payload__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C3.json","file:__tsdf_payload__%3A%22users%7C%7C4.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-shared-item-cleanup (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.311s | 📂 dir-open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-shared-item-cleanup (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.312s | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.00 kb -> 0.23 kb
      .      | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.36 kb
      .      | 📄 file-open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||1 (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||2 (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||3 (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C4.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||4 (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-shared-item-cleanup/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-shared-item-cleanup (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      2.313s | 📂 dir-open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.query (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      2.314s | 📄 file-open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"} (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      2.315s | 📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||1 (metadata)) | 0.27 kb
      .      | 📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||2 (metadata)) | 0.27 kb
      .      | 📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||3 (metadata)) | 0.27 kb
      .      | 📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C4.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.li."users||4 (metadata)) | 0.27 kb
      .      | 📄 file-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      2.316s | 📄 file-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance)
      2.317s | 📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)) | 0.58 kb
      .      | 📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"} (metadata)) | 0.57 kb
      2.318s | 📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb
      2.32s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json
             |    └ (global maintenance) | 0.23 kb -> 0.13 kb
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

        timestamp: 1735689601850
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

        timestamp: 1735689601850
        version: 1
      `);
    expect(deleteOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      5.997s | 📖 tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata)) | 0.36 kb
      .      | 📖 tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)) | 0.55 kb
      .      | 🗑️ ✅ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||1 (payload))
      .      | 🗑️ ✅ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||1 (metadata))
      5.999s | ✍️ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (payload)) | 0.11 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata)) | 0.36 kb -> 0.34 kb
      .      | ✍️ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (payload)) | 0.19 kb -> 0.17 kb
      .      | ✍️ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)) | 0.55 kb -> 0.53 kb
      .      | 📖 tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (metadata)) | 0.27 kb
      6.002s | ✍️ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (payload)) | 0.08 kb -> 0.15 kb
      .      | ✍️ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (metadata)) | 0.27 kb -> 0.27 kb
      7.994s | 🗂️ tsdf/sess1/lq-delete-flow/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      7.997s | 🗂️ tsdf/sess1/lq-delete-flow/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C2.json"]
      7.999s | 📖 tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)) | 0.53 kb
      .      | 📖 tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata)) | 0.34 kb
      8.002s | 📖 tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (metadata)) | 0.27 kb

      verbose
      time   |
      5.991s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      5.992s | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      5.993s | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow/listQuery.query (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-delete-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      5.994s | 📄 file-open ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata))
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-delete-flow/listQuery.query (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      5.995s | 📄 file-open-or-create ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      5.996s | 📄 file-open ✅ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow/listQuery.item (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-delete-flow (store directory)
      5.997s | 📖 tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata)) | 0.36 kb
      .      | 📖 tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)) | 0.55 kb
      .      | 🗑️ ✅ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||1 (payload))
      .      | 🗑️ ✅ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||1 (metadata))
      .      | 📁 dir-open-or-create ✅ tsdf/sess1/lq-delete-flow/listQuery.item (scope directory)
      5.998s | 📄 file-open-or-create ✅ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (metadata))
      5.999s | ✍️ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (payload)) | 0.11 kb -> 0.09 kb
      .      | ✍️ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata)) | 0.36 kb -> 0.34 kb
      .      | ✍️ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (payload)) | 0.19 kb -> 0.17 kb
      .      | ✍️ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)) | 0.55 kb -> 0.53 kb
      .      | 📖 tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (metadata)) | 0.27 kb
      6.002s | ✍️ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (payload)) | 0.08 kb -> 0.15 kb
      .      | ✍️ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (metadata)) | 0.27 kb -> 0.27 kb
      7.991s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.992s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.993s | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.994s | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-delete-flow/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.995s | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow/listQuery.query (scope directory)
      .      | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.996s | 📄 file-open ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.997s | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-delete-flow/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C2.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow (store directory)
      7.998s | 📂 dir-open ✅ tsdf/sess1/lq-delete-flow/listQuery.item (scope directory)
      7.999s | 📖 tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)) | 0.53 kb
      .      | 📖 tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata)) | 0.34 kb
      .      | 📄 file-open ✅ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (metadata))
      8.002s | 📖 tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-delete-flow.li."users||2 (metadata)) | 0.27 kb
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
        sizeBytes: 50
        version: 1
        writtenAt: 1735664400000
      `);
    expect(getParsedOpfsEntryFiles(mockAdapter, itemStorageKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata: { o: '✅', p: 'users||1' }
          key: '"users||1'
          lastAccessAt: 1735664400000
          sizeBytes: 50
          version: 1
          writtenAt: 1735664400000

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
        sizeBytes: 44
        version: 1
        writtenAt: 1735664400000
      `);
    expect(getParsedOpfsEntryFiles(mockAdapter, queryStorageKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata:
            i: ['"users||1']
            o: '✅'
            p: { tableId: 'users' }
          key: '{tableId:"users"}'
          lastAccessAt: 1735664400000
          sizeBytes: 44
          version: 1
          writtenAt: 1735664400000

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
      simplified
      time   |
      4.913s | 🗂️ tsdf/sess1/lq-query-invalidation-flow/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      4.914s | 🗂️ tsdf/sess1/lq-query-invalidation-flow/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      5.007s | 📖 tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata)) | 0.27 kb
      5.008s | ✍️ tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata)) | 0.27 kb -> 0.27 kb
      5.01s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.20 kb
      7.004s | 🗂️ tsdf/sess1/lq-query-invalidation-flow/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      7.054s | 🗂️ tsdf/sess1/lq-query-invalidation-flow/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      7.059s | 📖 tsdf/sess1/lq-query-invalidation-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.lq.{tableId:"users"} (metadata)) | 0.34 kb
      7.109s | 📖 tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata)) | 0.27 kb

      verbose
      time   |
      4.911s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.912s | 📂 dir-open ✅ tsdf/sess1/lq-query-invalidation-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.913s | 📂 dir-open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-query-invalidation-flow/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-query-invalidation-flow (store directory)
      4.914s | 📂 dir-open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-query-invalidation-flow/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      4.951s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.952s | 📂 dir-open ✅ tsdf/sess1/lq-query-invalidation-flow (store directory)
      4.953s | 📂 dir-open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item (scope directory)
      4.954s | 📄 file-open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata))
      5.001s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      5.002s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-query-invalidation-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      5.003s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      5.004s | 📄 file-open-or-create ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      5.005s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      5.006s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      5.007s | 📖 tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata)) | 0.27 kb
      5.008s | ✍️ tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata)) | 0.27 kb -> 0.27 kb
      5.01s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.20 kb
      7.001s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.002s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.003s | 📂 dir-open ✅ tsdf/sess1/lq-query-invalidation-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.004s | 📂 dir-open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-query-invalidation-flow/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-query-invalidation-flow (store directory)
      7.005s | 📂 dir-open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.query (scope directory)
      7.006s | 📄 file-open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.lq.{tableId:"users"} (metadata))
      7.051s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.052s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.053s | 📂 dir-open ✅ tsdf/sess1/lq-query-invalidation-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.054s | 📂 dir-open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-query-invalidation-flow/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-query-invalidation-flow (store directory)
      7.055s | 📂 dir-open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item (scope directory)
      7.056s | 📄 file-open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata))
      7.059s | 📖 tsdf/sess1/lq-query-invalidation-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.lq.{tableId:"users"} (metadata)) | 0.34 kb
      7.109s | 📖 tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata)) | 0.27 kb
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
      simplified
      time   |
      5.813s | 🗂️ tsdf/sess1/lq-coalesced-invalidations/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      5.814s | 🗂️ tsdf/sess1/lq-coalesced-invalidations/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      5.907s | 📖 tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata)) | 0.27 kb
      5.908s | ✍️ tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata)) | 0.27 kb -> 0.27 kb
      5.91s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.20 kb
      7.904s | 🗂️ tsdf/sess1/lq-coalesced-invalidations/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      7.954s | 🗂️ tsdf/sess1/lq-coalesced-invalidations/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      7.959s | 📖 tsdf/sess1/lq-coalesced-invalidations/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.lq.{tableId:"users"} (metadata)) | 0.34 kb
      8.009s | 📖 tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata)) | 0.27 kb

      verbose
      time   |
      5.811s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      5.812s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-invalidations (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      5.813s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-coalesced-invalidations/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-invalidations (store directory)
      5.814s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-coalesced-invalidations/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      5.851s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      5.852s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-invalidations (store directory)
      5.853s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item (scope directory)
      5.854s | 📄 file-open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata))
      5.901s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      5.902s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-coalesced-invalidations (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      5.903s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      5.904s | 📄 file-open-or-create ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      5.905s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      5.906s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      5.907s | 📖 tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata)) | 0.27 kb
      5.908s | ✍️ tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata)) | 0.27 kb -> 0.27 kb
      5.91s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.20 kb
      7.901s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.902s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.903s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-invalidations (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.904s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-coalesced-invalidations/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-invalidations (store directory)
      7.905s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.query (scope directory)
      7.906s | 📄 file-open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.lq.{tableId:"users"} (metadata))
      7.951s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.952s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.953s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-invalidations (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      7.954s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-coalesced-invalidations/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-invalidations (store directory)
      7.955s | 📂 dir-open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item (scope directory)
      7.956s | 📄 file-open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata))
      7.959s | 📖 tsdf/sess1/lq-coalesced-invalidations/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.lq.{tableId:"users"} (metadata)) | 0.34 kb
      8.009s | 📖 tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata)) | 0.27 kb
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
        customMetadata: { p: 'users||1' }
        key: '"users||1'
        lastAccessAt: 1735689600000
        payloadRef: '__tsdf_payload__:"users||1'
        sizeBytes: 82
        version: 1
        writtenAt: 1735689605000
      `);
    expect(getParsedOpfsEntryFiles(mockAdapter, itemStorageKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata: { p: 'users||1' }
          key: '"users||1'
          lastAccessAt: 1735689600000
          sizeBytes: 82
          version: 1
          writtenAt: 1735689605000

        payload:
          d: { id: 1, name: 'Fresh user' }
          lf: ['age', 'email', 'id', 'name']
          p: 'users||1'
      `);
    expect(readEntryMetadata(mockAdapter, queryStorageKey))
      .toMatchInlineSnapshot(`
        customMetadata:
          i: ['"users||1', '"users||2']
          p: { tableId: 'users' }

        key: '{tableId:"users"}'
        lastAccessAt: 1735689600000
        payloadRef: '__tsdf_payload__:{tableId:"users"}'
        sizeBytes: 57
        version: 1
        writtenAt: 1735689605000
      `);
    expect(getParsedOpfsEntryFiles(mockAdapter, queryStorageKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata:
            i: ['"users||1', '"users||2']
            p: { tableId: 'users' }
          key: '{tableId:"users"}'
          lastAccessAt: 1735689600000
          sizeBytes: 57
          version: 1
          writtenAt: 1735689605000

        payload:
          i: ['"users||1', '"users||2']
          p: { tableId: 'users' }
      `);
  });

  test('query hook remount reuses hydrated list-query state without touching localStorage again', async () => {
    const storeName = 'lq-remount-flow';
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

    // Drain the startup scan so the capture focuses on the mounted query flow.
    await settleStartupBackgroundScan(mockAdapter);

    // The first mount hydrates the cold query and its item from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        render: () =>
          env.apiStore.useListQuery(usersQuery, {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
        sessionKey,
        storeName,
      });

    expect(secondHook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Cached user' }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      3.057s | 📖 tsdf/sess1/lq-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (payload)) | 0.09 kb
      .      | 📖 tsdf/sess1/lq-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (metadata)) | 0.34 kb
      3.107s | 📖 tsdf/sess1/lq-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-remount-flow.li."users||1 (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/lq-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-remount-flow.li."users||1 (metadata)) | 0.27 kb

      verbose
      time   |
      3.001s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3.002s | 📂 dir-open ✅ tsdf/sess1/lq-remount-flow (store directory)
      3.003s | 📂 dir-open ✅ tsdf/sess1/lq-remount-flow/listQuery.query (scope directory)
      3.004s | 📄 file-open ✅ tsdf/sess1/lq-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (payload))
      .      | 📄 file-open ✅ tsdf/sess1/lq-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (metadata))
      3.051s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3.052s | 📂 dir-open ✅ tsdf/sess1/lq-remount-flow (store directory)
      3.053s | 📂 dir-open ✅ tsdf/sess1/lq-remount-flow/listQuery.item (scope directory)
      3.054s | 📄 file-open ✅ tsdf/sess1/lq-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-remount-flow.li."users||1 (payload))
      .      | 📄 file-open ✅ tsdf/sess1/lq-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-remount-flow.li."users||1 (metadata))
      3.057s | 📖 tsdf/sess1/lq-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (payload)) | 0.09 kb
      .      | 📖 tsdf/sess1/lq-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (metadata)) | 0.34 kb
      3.107s | 📖 tsdf/sess1/lq-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-remount-flow.li."users||1 (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/lq-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-remount-flow.li."users||1 (metadata)) | 0.27 kb
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
      simplified
      time   |
      4.863s | 🗂️ tsdf/sess1/lq-item-invalidation-flow/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      4.957s | 📖 tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata)) | 0.27 kb
      4.958s | ✍️ tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata)) | 0.27 kb -> 0.27 kb
      4.96s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.20 kb
      6.956s | 🗂️ tsdf/sess1/lq-item-invalidation-flow/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      7.011s | 📖 tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata)) | 0.27 kb

      verbose
      time   |
      4.861s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.862s | 📂 dir-open ✅ tsdf/sess1/lq-item-invalidation-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.863s | 📂 dir-open ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-item-invalidation-flow/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-item-invalidation-flow (store directory)
      4.864s | 📂 dir-open ❌ tsdf/sess1/lq-item-invalidation-flow/listQuery.query (scope directory)
      4.901s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.902s | 📂 dir-open ✅ tsdf/sess1/lq-item-invalidation-flow (store directory)
      4.903s | 📂 dir-open ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item (scope directory)
      4.904s | 📄 file-open ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata))
      4.951s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      4.952s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-item-invalidation-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      4.953s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      4.954s | 📄 file-open-or-create ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      4.955s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      4.956s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      4.957s | 📖 tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata)) | 0.27 kb
      4.958s | ✍️ tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata)) | 0.27 kb -> 0.27 kb
      4.96s  | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.20 kb
      6.951s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.952s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.953s | 📂 dir-open ✅ tsdf/sess1/lq-item-invalidation-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.954s | 📂 dir-open ❌ tsdf/sess1/lq-item-invalidation-flow/listQuery.query (scope directory)
      .      | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.955s | 📂 dir-open ✅ tsdf/sess1/lq-item-invalidation-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.956s | 📂 dir-open ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-item-invalidation-flow/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-item-invalidation-flow (store directory)
      6.957s | 📂 dir-open ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item (scope directory)
      6.958s | 📄 file-open ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata))
      7.011s | 📖 tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata)) | 0.27 kb
      "
    `);
  });

  test('item hook remount reuses hydrated standalone list-query items without touching localStorage again', async () => {
    const storeName = 'lq-item-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);

    listQueryScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cached user',
    });

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted item flow.
    await settleStartupBackgroundScan(mockAdapter);

    // The first mount must hydrate the cold cached item from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        render: () =>
          env.apiStore.useItem(rawItemPayload('users', 1), {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
        sessionKey,
        storeName,
      });

    expect(secondHook.result.current.data).toMatchInlineSnapshot(`
      id: 1
      name: 'Cached user'
    `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      3.057s | 📖 tsdf/sess1/lq-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-remount-flow.li."users||1 (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/lq-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-remount-flow.li."users||1 (metadata)) | 0.27 kb

      verbose
      time   |
      3.001s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3.002s | 📂 dir-open ✅ tsdf/sess1/lq-item-remount-flow (store directory)
      3.003s | 📂 dir-open ✅ tsdf/sess1/lq-item-remount-flow/listQuery.item (scope directory)
      3.004s | 📄 file-open ✅ tsdf/sess1/lq-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-remount-flow.li."users||1 (payload))
      .      | 📄 file-open ✅ tsdf/sess1/lq-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-remount-flow.li."users||1 (metadata))
      3.057s | 📖 tsdf/sess1/lq-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-remount-flow.li."users||1 (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/lq-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-item-remount-flow.li."users||1 (metadata)) | 0.27 kb
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
        sessionKey,
        storeName,
      });

    expect(secondHook.result.current.map((item) => item.data))
      .toMatchInlineSnapshot(`
        - { id: 1, name: 'Cached user 1' }
        - { id: 2, name: 'Cached user 2' }
      `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      3.057s | 📖 tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (metadata)) | 0.27 kb
      .      | 📖 tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (metadata)) | 0.27 kb

      verbose
      time   |
      3.001s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3.002s | 📂 dir-open ✅ tsdf/sess1/lq-multi-item-remount-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-multi-item-remount-flow (store directory)
      3.003s | 📂 dir-open ✅ tsdf/sess1/lq-multi-item-remount-flow/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-multi-item-remount-flow/listQuery.item (scope directory)
      3.004s | 📄 file-open ✅ tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (payload))
      .      | 📄 file-open ✅ tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (payload))
      .      | 📄 file-open ✅ tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (metadata))
      3.057s | 📖 tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (metadata)) | 0.27 kb
      .      | 📖 tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json
             |    └ (tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (metadata)) | 0.27 kb
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
        sessionKey,
        storeName,
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
      simplified
      time   |
      3.057s | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (payload)) | 0.09 kb
      .      | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (metadata)) | 0.34 kb
      .      | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22projects%22%7D.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (metadata)) | 0.36 kb
      3.107s | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (metadata)) | 0.27 kb
      3.108s | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_payload__%3A%22projects%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (payload)) | 0.11 kb
      .      | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (metadata)) | 0.28 kb

      verbose
      time   |
      3.001s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3.002s | 📂 dir-open ✅ tsdf/sess1/lq-multi-query-remount-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-multi-query-remount-flow (store directory)
      3.003s | 📂 dir-open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.query (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.query (scope directory)
      3.004s | 📄 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (payload))
      .      | 📄 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (metadata))
      .      | 📄 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22projects%22%7D.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (payload))
      .      | 📄 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (metadata))
      3.051s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3.052s | 📂 dir-open ✅ tsdf/sess1/lq-multi-query-remount-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3.053s | 📂 dir-open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/sess1/lq-multi-query-remount-flow (store directory)
      3.054s | 📄 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (payload))
      .      | 📄 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (metadata))
      .      | 📂 dir-open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.item (scope directory)
      3.055s | 📄 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_payload__%3A%22projects%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (payload))
      .      | 📄 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (metadata))
      3.057s | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (payload)) | 0.09 kb
      .      | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (metadata)) | 0.34 kb
      .      | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22projects%22%7D.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (metadata)) | 0.36 kb
      3.107s | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (metadata)) | 0.27 kb
      3.108s | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_payload__%3A%22projects%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (payload)) | 0.11 kb
      .      | 📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json
             |    └ (tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (metadata)) | 0.28 kb
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
        lastAccessAt: 1735689600000
        payloadRef: '__tsdf_payload__:"users||1'
        sizeBytes: 83
        version: 1
        writtenAt: 1735689604190
      `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      4.103s | 🗂️ tsdf/sess1/lq-mutation-flow/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      4.104s | 🗂️ tsdf/sess1/lq-mutation-flow/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      4.197s | 📖 tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata)) | 0.27 kb
      4.198s | ✍️ tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata)) | 0.27 kb -> 0.27 kb
      4.2s   | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.18 kb
      6.194s | 🗂️ tsdf/sess1/lq-mutation-flow/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      6.244s | 🗂️ tsdf/sess1/lq-mutation-flow/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      6.249s | 📖 tsdf/sess1/lq-mutation-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-mutation-flow.lq.{tableId:"users"} (metadata)) | 0.34 kb
      6.299s | 📖 tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata)) | 0.27 kb

      verbose
      time   |
      4.101s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.102s | 📂 dir-open ✅ tsdf/sess1/lq-mutation-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.103s | 📂 dir-open ✅ tsdf/sess1/lq-mutation-flow/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-mutation-flow/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-mutation-flow (store directory)
      4.104s | 📂 dir-open ✅ tsdf/sess1/lq-mutation-flow/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-mutation-flow/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      4.141s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      4.142s | 📂 dir-open ✅ tsdf/sess1/lq-mutation-flow (store directory)
      4.143s | 📂 dir-open ✅ tsdf/sess1/lq-mutation-flow/listQuery.item (scope directory)
      4.144s | 📄 file-open ✅ tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata))
      4.191s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      4.192s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-mutation-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__ (session directory)
      4.193s | 📁 dir-open-or-create ✅ tsdf/sess1/lq-mutation-flow/listQuery.item (scope directory)
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__ (session directory)
      4.194s | 📄 file-open-or-create ✅ tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata))
      .      | 📂 dir-open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__ (store directory)
      4.195s | 📄 file-open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      .      | 📁 dir-open-or-create ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)
      4.196s | 📄 file-open-or-create 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry)
      4.197s | 📖 tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata)) | 0.27 kb
      4.198s | ✍️ tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (payload)) | 0.10 kb -> 0.16 kb
      .      | ✍️ tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata)) | 0.27 kb -> 0.27 kb
      4.2s   | ✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json
             |    └ (internal registry) | 0.00 kb -> 0.18 kb
      6.191s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.192s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.193s | 📂 dir-open ✅ tsdf/sess1/lq-mutation-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.194s | 📂 dir-open ✅ tsdf/sess1/lq-mutation-flow/listQuery.query (scope directory)
      .      | 🗂️ tsdf/sess1/lq-mutation-flow/listQuery.query
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-mutation-flow (store directory)
      6.195s | 📂 dir-open ✅ tsdf/sess1/lq-mutation-flow/listQuery.query (scope directory)
      6.196s | 📄 file-open ✅ tsdf/sess1/lq-mutation-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-mutation-flow.lq.{tableId:"users"} (metadata))
      6.241s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.242s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.243s | 📂 dir-open ✅ tsdf/sess1/lq-mutation-flow (store directory)
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      6.244s | 📂 dir-open ✅ tsdf/sess1/lq-mutation-flow/listQuery.item (scope directory)
      .      | 🗂️ tsdf/sess1/lq-mutation-flow/listQuery.item
             |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      .      | 📂 dir-open ✅ tsdf/sess1/lq-mutation-flow (store directory)
      6.245s | 📂 dir-open ✅ tsdf/sess1/lq-mutation-flow/listQuery.item (scope directory)
      6.246s | 📄 file-open ✅ tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata))
      6.249s | 📖 tsdf/sess1/lq-mutation-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.lq-mutation-flow.lq.{tableId:"users"} (metadata)) | 0.34 kb
      6.299s | 📖 tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata)) | 0.27 kb
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
    await advanceTime(100);
    await preloadPromise;

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      3.057s | 📖 tsdf/sess1/list-query-opfs-efficiency/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.list-query-opfs-efficiency.lq.{tableId:"users"} (payload)) | 0.09 kb
      .      | 📖 tsdf/sess1/list-query-opfs-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.list-query-opfs-efficiency.lq.{tableId:"users"} (metadata)) | 0.34 kb
      3.107s | 📖 tsdf/sess1/list-query-opfs-efficiency/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.list-query-opfs-efficiency.li."users||1 (payload)) | 0.09 kb
      .      | 📖 tsdf/sess1/list-query-opfs-efficiency/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.list-query-opfs-efficiency.li."users||1 (metadata)) | 0.27 kb

      verbose
      time   |
      3.001s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3.002s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-efficiency (store directory)
      3.003s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-efficiency/listQuery.query (scope directory)
      3.004s | 📄 file-open ✅ tsdf/sess1/list-query-opfs-efficiency/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.list-query-opfs-efficiency.lq.{tableId:"users"} (payload))
      .      | 📄 file-open ✅ tsdf/sess1/list-query-opfs-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.list-query-opfs-efficiency.lq.{tableId:"users"} (metadata))
      3.051s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3.052s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-efficiency (store directory)
      3.053s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-efficiency/listQuery.item (scope directory)
      3.054s | 📄 file-open ✅ tsdf/sess1/list-query-opfs-efficiency/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.list-query-opfs-efficiency.li."users||1 (payload))
      .      | 📄 file-open ✅ tsdf/sess1/list-query-opfs-efficiency/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.list-query-opfs-efficiency.li."users||1 (metadata))
      3.057s | 📖 tsdf/sess1/list-query-opfs-efficiency/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.list-query-opfs-efficiency.lq.{tableId:"users"} (payload)) | 0.09 kb
      .      | 📖 tsdf/sess1/list-query-opfs-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
             |    └ (tsdf.sess1.list-query-opfs-efficiency.lq.{tableId:"users"} (metadata)) | 0.34 kb
      3.107s | 📖 tsdf/sess1/list-query-opfs-efficiency/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.list-query-opfs-efficiency.li."users||1 (payload)) | 0.09 kb
      .      | 📖 tsdf/sess1/list-query-opfs-efficiency/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
             |    └ (tsdf.sess1.list-query-opfs-efficiency.li."users||1 (metadata)) | 0.27 kb
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
      simplified
      time    |
      14.759s | ✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22tasks%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (payload)) | 0.00 kb -> 0.09 kb
      .       | ✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata)) | 0.00 kb -> 0.34 kb
      .       | 📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata)) | 0.28 kb
      14.761s | ✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_payload__%3A%22projects%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (payload)) | 0.10 kb -> 0.16 kb
      .       | ✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata)) | 0.28 kb -> 0.28 kb
      .       | ✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_payload__%3A%22tasks%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (payload)) | 0.00 kb -> 0.09 kb
      .       | ✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22tasks%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata)) | 0.00 kb -> 0.27 kb
      16.754s | 🗂️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query
              |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22projects%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22tasks%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      16.759s | 📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"projects"} (metadata)) | 0.36 kb
      .       | 📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata)) | 0.34 kb
      .       | 📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"users"} (metadata)) | 0.34 kb
      16.794s | 🗑️ ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"users"} (payload))
      .       | 🗑️ ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"users"} (metadata))
      .       | 🗂️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query
              |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22projects%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22tasks%22%7D.json"]
      16.796s | 🗂️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item
              |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22projects%7C%7C1.json","file:__tsdf_meta__%3A%22tasks%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22projects%7C%7C1.json","file:__tsdf_payload__%3A%22tasks%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      16.801s | 📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata)) | 0.28 kb
      .       | 📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22tasks%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata)) | 0.27 kb
      .       | 📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."users||1 (metadata)) | 0.27 kb
      16.834s | 🗑️ ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."users||1 (payload))
      .       | 🗑️ ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."users||1 (metadata))
      .       | 🗂️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item
              |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22projects%7C%7C1.json","file:__tsdf_meta__%3A%22tasks%7C%7C1.json","file:__tsdf_payload__%3A%22projects%7C%7C1.json","file:__tsdf_payload__%3A%22tasks%7C%7C1.json"]

      verbose
      time    |
      14.751s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      14.752s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency (store directory)
      .       | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      14.753s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query (scope directory)
      .       | 📁 dir-open-or-create ✅ tsdf/sess1/list-query-opfs-eviction-efficiency (store directory)
      .       | 📂 dir-open ✅ tsdf/sess1 (session directory)
      14.754s | 📄 file-open ❌ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata))
      .       | 📁 dir-open-or-create ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query
              |    └ (scope directory)
      .       | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency (store directory)
      .       | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      14.755s | 📄 file-open-or-create 🆕 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22tasks%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (payload))
      .       | 📄 file-open-or-create 🆕 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata))
      .       | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item (scope directory)
      .       | 📁 dir-open-or-create ✅ tsdf/sess1/list-query-opfs-eviction-efficiency (store directory)
      14.756s | 📄 file-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata))
      .       | 📄 file-open ❌ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22tasks%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata))
      .       | 📁 dir-open-or-create ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item
              |    └ (scope directory)
      14.757s | 📄 file-open-or-create ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_payload__%3A%22projects%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (payload))
      .       | 📄 file-open-or-create ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata))
      .       | 📄 file-open-or-create 🆕 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_payload__%3A%22tasks%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (payload))
      .       | 📄 file-open-or-create 🆕 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22tasks%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata))
      14.759s | ✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22tasks%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (payload)) | 0.00 kb -> 0.09 kb
      .       | ✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata)) | 0.00 kb -> 0.34 kb
      .       | 📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata)) | 0.28 kb
      14.761s | ✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_payload__%3A%22projects%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (payload)) | 0.10 kb -> 0.16 kb
      .       | ✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata)) | 0.28 kb -> 0.28 kb
      .       | ✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_payload__%3A%22tasks%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (payload)) | 0.00 kb -> 0.09 kb
      .       | ✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22tasks%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata)) | 0.00 kb -> 0.27 kb
      16.751s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      16.752s | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .       | 📂 dir-open ✅ tsdf/sess1 (session directory)
      16.753s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency (store directory)
      .       | 📂 dir-open ✅ tsdf/sess1 (session directory)
      16.754s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query (scope directory)
      .       | 🗂️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query
              |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22projects%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22tasks%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]
      .       | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency (store directory)
      16.755s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query (scope directory)
      16.756s | 📄 file-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"projects"} (metadata))
      .       | 📄 file-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata))
      .       | 📄 file-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"users"} (metadata))
      16.759s | 📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"projects"} (metadata)) | 0.36 kb
      .       | 📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata)) | 0.34 kb
      .       | 📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"users"} (metadata)) | 0.34 kb
      16.791s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      16.792s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency (store directory)
      .       | 📂 dir-open ✅ tsdf/sess1 (session directory)
      16.793s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query (scope directory)
      .       | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency (store directory)
      .       | 📂 dir-open ✅ tsdf/sess1 (session directory)
      16.794s | 🗑️ ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"users"} (payload))
      .       | 🗑️ ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"users"} (metadata))
      .       | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query (scope directory)
      .       | 🗂️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query
              |    └ (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22projects%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22tasks%22%7D.json"]
      .       | 📂 dir-open ❌ tsdf/sess1/_o_.p (store directory)
      .       | 📂 dir-open ✅ tsdf/sess1 (session directory)
      16.795s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency (store directory)
      .       | 📂 dir-open ✅ tsdf/sess1 (session directory)
      16.796s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item (scope directory)
      .       | 🗂️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item
              |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22projects%7C%7C1.json","file:__tsdf_meta__%3A%22tasks%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22projects%7C%7C1.json","file:__tsdf_payload__%3A%22tasks%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]
      .       | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency (store directory)
      16.797s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item (scope directory)
      16.798s | 📄 file-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata))
      .       | 📄 file-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22tasks%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata))
      .       | 📄 file-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."users||1 (metadata))
      16.801s | 📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata)) | 0.28 kb
      .       | 📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22tasks%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata)) | 0.27 kb
      .       | 📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."users||1 (metadata)) | 0.27 kb
      16.831s | 📂 dir-open ✅ tsdf/sess1 (session directory)
      16.832s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency (store directory)
      .       | 📂 dir-open ✅ tsdf/sess1 (session directory)
      16.833s | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item (scope directory)
      .       | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency (store directory)
      16.834s | 🗑️ ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."users||1 (payload))
      .       | 🗑️ ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json
              |    └ (tsdf.sess1.list-query-opfs-eviction-efficiency.li."users||1 (metadata))
      .       | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item (scope directory)
      .       | 🗂️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item
              |    └ (scope directory) entries=["file:__tsdf_meta__%3A%22projects%7C%7C1.json","file:__tsdf_meta__%3A%22tasks%7C%7C1.json","file:__tsdf_payload__%3A%22projects%7C%7C1.json","file:__tsdf_payload__%3A%22tasks%7C%7C1.json"]
      "
    `);
  });
});
