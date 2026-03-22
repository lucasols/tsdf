import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import type { ListQueryParams } from '../../mocks/listQueryStoreTestEnv';
import { createOpfsPersistentStorageTestStore } from '../../utils/opfsPersistentStorageTestStore';
import { startOpfsPersistentStorageOperationCapture } from '../../utils/persistentStorageOptimizationTestUtils';
import {
  captureHookRemount,
  createListQueryEnv,
  flushInvalidationPersistence,
  isEmptyOperationSummary,
  listQueryItemStorageKey,
  listQueryStorageKey,
  listStoredKeys,
  markEntryOfflineProtected,
  rawItemPayload,
  readEntryMetadata,
  registerAsyncNamespace,
  setCachedItem,
  setCachedQuery,
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
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
    });

    // Seed one stale query+item pair and one fresh pair to verify cleanup across both namespaces.
    const expiredItemKey = setCachedItem(
      mockAdapter,
      storeName,
      sessionKey,
      'expired-users',
      1,
      { id: 1, name: 'Expired Item' },
      expiredTimestamp,
    );
    const expiredQueryKey = setCachedQuery(
      mockAdapter,
      storeName,
      sessionKey,
      expiredQueryParams,
      [storeItemKey('expired-users', 1)],
      { timestamp: expiredTimestamp },
    );
    const freshItemKey = setCachedItem(
      mockAdapter,
      storeName,
      sessionKey,
      'fresh-users',
      2,
      { id: 2, name: 'Fresh Item' },
    );
    const freshQueryKey = setCachedQuery(
      mockAdapter,
      storeName,
      sessionKey,
      freshQueryParams,
      [storeItemKey('fresh-users', 2)],
    );
    registerAsyncNamespace(mockAdapter, {
      sessionKey,
      storeName,
      kind: 'listQuery.item',
    });
    registerAsyncNamespace(mockAdapter, {
      sessionKey,
      storeName,
      kind: 'listQuery.query',
    });

    // Startup should only queue the background scan.
    const startupOperationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    createListQueryEnv({ storeName, sessionKey });
    const startupOperationBreakdown = startupOperationCapture.finish();

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);

    // Once the scan runs, capture the complete query and item cleanup sequence.
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish();

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
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/list-query-expiration/listQuery.item'
          - 'sess1/list-query-expiration/listQuery.item'
          - 'sess1/list-query-expiration/listQuery.query'
          - 'sess1/list-query-expiration/listQuery.query'
        metadataBatchReads:
          - ['li."expired-users||1 (metadata)', 'li."fresh-users||2 (metadata)']
          - - 'lq.{tableId:"expired-users"} (metadata)'
            - 'lq.{tableId:"fresh-users"} (metadata)'
        metadataReads:
          - 'li."expired-users||1 (metadata)'
          - 'li."fresh-users||2 (metadata)'
          - 'lq.{tableId:"expired-users"} (metadata)'
          - 'lq.{tableId:"fresh-users"} (metadata)'
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ✅ tsdf/sess1/list-query-expiration/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/list-query-expiration/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22expired-users%7C%7C1.json","file:__tsdf_meta__%3A%22fresh-users%7C%7C2.json","file:__tsdf_payload__%3A%22expired-users%7C%7C1.json","file:__tsdf_payload__%3A%22fresh-users%7C%7C2.json"]'
        - '📂 open ✅ tsdf/sess1/list-query-expiration/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_meta__%3A%22expired-users%7C%7C1.json (tsdf.sess1.list-query-expiration.li."expired-users||1 (metadata))'
        - '📄 open ✅ tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_meta__%3A%22fresh-users%7C%7C2.json (tsdf.sess1.list-query-expiration.li."fresh-users||2 (metadata))'
        - '📖 tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_meta__%3A%22expired-users%7C%7C1.json (tsdf.sess1.list-query-expiration.li."expired-users||1 (metadata))'
        - '📖 tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_meta__%3A%22fresh-users%7C%7C2.json (tsdf.sess1.list-query-expiration.li."fresh-users||2 (metadata))'
        - '📂 open ✅ tsdf/sess1/list-query-expiration/listQuery.item (scope directory)'
        - '🗑️ ✅ tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_payload__%3A%22expired-users%7C%7C1.json (tsdf.sess1.list-query-expiration.li."expired-users||1 (payload))'
        - '🗑️ ✅ tsdf/sess1/list-query-expiration/listQuery.item/__tsdf_meta__%3A%22expired-users%7C%7C1.json (tsdf.sess1.list-query-expiration.li."expired-users||1 (metadata))'
        - '📂 open ✅ tsdf/sess1/list-query-expiration/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/list-query-expiration/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22fresh-users%7C%7C2.json","file:__tsdf_payload__%3A%22fresh-users%7C%7C2.json"]'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ✅ tsdf/sess1/list-query-expiration/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/list-query-expiration/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22expired-users%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22fresh-users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22expired-users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22fresh-users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/list-query-expiration/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22expired-users%22%7D.json (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (metadata))'
        - '📄 open ✅ tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fresh-users%22%7D.json (tsdf.sess1.list-query-expiration.lq.{tableId:"fresh-users"} (metadata))'
        - '📖 tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22expired-users%22%7D.json (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (metadata))'
        - '📖 tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fresh-users%22%7D.json (tsdf.sess1.list-query-expiration.lq.{tableId:"fresh-users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/list-query-expiration/listQuery.query (scope directory)'
        - '🗑️ ✅ tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22expired-users%22%7D.json (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (payload))'
        - '🗑️ ✅ tsdf/sess1/list-query-expiration/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22expired-users%22%7D.json (tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/list-query-expiration/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/list-query-expiration/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22fresh-users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22fresh-users%22%7D.json"]'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
        - '📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
    `);
  });

  test('when maxQueries limit is reached a full store cleanup occurs', async () => {
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const storeName = 'lq-query-metadata';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
    });

    setCachedQuery(mockAdapter, storeName, sessionKey, firstQuery, []);
    await advanceTime(100);
    setCachedQuery(mockAdapter, storeName, sessionKey, secondQuery, []);

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
    const operationsBreakdown = readCapture.finish();

    expect(
      listStoredKeys(mockAdapter, {
        sessionKey,
        storeName,
        kind: 'listQuery.query',
      }).sort(),
    ).toMatchInlineSnapshot(`['{tableId:"second"}', '{tableId:"third"}']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-query-metadata/listQuery.query'
          - 'sess1/lq-query-metadata/listQuery.query'
          - 'sess1/lq-query-metadata/listQuery.query'
          - 'sess1/lq-query-metadata/listQuery.item'
        metadataBatchReads:
          - - 'lq.{tableId:"first"} (metadata)'
            - 'lq.{tableId:"second"} (metadata)'
            - 'lq.{tableId:"third"} (metadata)'
          - ['li."third||1 (metadata)']
        metadataReads:
          - 'lq.{tableId:"first"} (metadata)'
          - 'lq.{tableId:"second"} (metadata)'
          - 'lq.{tableId:"third"} (metadata)'
          - 'li."third||1 (metadata)'
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ❌ tsdf/sess1/lq-query-metadata/listQuery.item (scope directory)'
        - '📂 open ✅ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory)'
        - '📄 open ❌ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata))'
        - '📁 ensure ✅ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory)'
        - '📄 ensure 🆕 tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (payload))'
        - '📄 ensure 🆕 tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata))'
        - '✍️ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (payload))'
        - '✍️ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata))'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ❌ tsdf/sess1/lq-query-metadata/listQuery.item (scope directory)'
        - '📁 ensure 🆕 tsdf/sess1/lq-query-metadata/listQuery.item (scope directory)'
        - '📄 ensure 🆕 tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json (tsdf.sess1.lq-query-metadata.li."third||1 (payload))'
        - '📄 ensure 🆕 tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json (tsdf.sess1.lq-query-metadata.li."third||1 (metadata))'
        - '✍️ tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json (tsdf.sess1.lq-query-metadata.li."third||1 (payload))'
        - '✍️ tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json (tsdf.sess1.lq-query-metadata.li."third||1 (metadata))'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ✅ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json (tsdf.sess1.lq-query-metadata.lq.{tableId:"second"} (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata))'
        - '📖 tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (metadata))'
        - '📖 tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json (tsdf.sess1.lq-query-metadata.lq.{tableId:"second"} (metadata))'
        - '📖 tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json (tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory)'
        - '🗑️ ✅ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (payload))'
        - '🗑️ ✅ tsdf/sess1/lq-query-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json (tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-query-metadata/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-query-metadata/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-query-metadata/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22third%7C%7C1.json","file:__tsdf_payload__%3A%22third%7C%7C1.json"]'
        - '📂 open ✅ tsdf/sess1/lq-query-metadata/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json (tsdf.sess1.lq-query-metadata.li."third||1 (metadata))'
        - '📖 tsdf/sess1/lq-query-metadata/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json (tsdf.sess1.lq-query-metadata.li."third||1 (metadata))'
    `);
  });

  test('multiple overflowing query writes before idle maintenance trigger a single cleanup pass', async () => {
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const fourthQuery = { tableId: 'fourth' };
    const storeName = 'lq-coalesced-query-maintenance';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
    });

    setCachedQuery(mockAdapter, storeName, sessionKey, firstQuery, []);
    await advanceTime(100);
    setCachedQuery(mockAdapter, storeName, sessionKey, secondQuery, []);

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
    const operationsBreakdown = readCapture.finish();

    expect(
      listStoredKeys(mockAdapter, {
        sessionKey,
        storeName,
        kind: 'listQuery.query',
      }).sort(),
    ).toMatchInlineSnapshot(`['{tableId:"fourth"}', '{tableId:"third"}']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-coalesced-query-maintenance/listQuery.query'
          - 'sess1/lq-coalesced-query-maintenance/listQuery.query'
          - 'sess1/lq-coalesced-query-maintenance/listQuery.query'
          - 'sess1/lq-coalesced-query-maintenance/listQuery.item'
        metadataBatchReads:
          - ['li."third||1 (metadata)']
          - - 'lq.{tableId:"first"} (metadata)'
            - 'lq.{tableId:"fourth"} (metadata)'
            - 'lq.{tableId:"second"} (metadata)'
            - 'lq.{tableId:"third"} (metadata)'
          - ['li."fourth||2 (metadata)', 'li."third||1 (metadata)']
        metadataReads:
          - 'li."third||1 (metadata)'
          - 'lq.{tableId:"first"} (metadata)'
          - 'lq.{tableId:"fourth"} (metadata)'
          - 'lq.{tableId:"second"} (metadata)'
          - 'lq.{tableId:"third"} (metadata)'
          - 'li."fourth||2 (metadata)'
          - 'li."third||1 (metadata)'
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ❌ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory)'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)'
        - '📄 open ❌ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata))'
        - '📁 ensure ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)'
        - '📄 ensure 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (payload))'
        - '📄 ensure 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata))'
        - '✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (payload))'
        - '✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata))'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ❌ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory)'
        - '📁 ensure 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory)'
        - '📄 ensure 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (payload))'
        - '📄 ensure 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))'
        - '✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (payload))'
        - '✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)'
        - '📄 open ❌ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata))'
        - '📁 ensure ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)'
        - '📄 ensure 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22fourth%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (payload))'
        - '📄 ensure 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata))'
        - '✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22fourth%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (payload))'
        - '✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))'
        - '📄 open ❌ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22fourth%7C%7C2.json (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata))'
        - '📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))'
        - '📁 ensure ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory)'
        - '📄 ensure ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (payload))'
        - '📄 ensure ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))'
        - '📄 ensure 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22fourth%7C%7C2.json (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (payload))'
        - '📄 ensure 🆕 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22fourth%7C%7C2.json (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata))'
        - '✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22third%7C%7C1.json (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (payload))'
        - '✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))'
        - '✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_payload__%3A%22fourth%7C%7C2.json (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (payload))'
        - '✍️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22fourth%7C%7C2.json (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22fourth%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata))'
        - '📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (metadata))'
        - '📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"} (metadata))'
        - '📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (metadata))'
        - '📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)'
        - '🗑️ ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22second%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (payload))'
        - '🗑️ ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22second%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"} (metadata))'
        - '🗑️ ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22first%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (payload))'
        - '🗑️ ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22first%22%7D.json (tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22fourth%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22third%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22fourth%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22third%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22fourth%7C%7C2.json","file:__tsdf_meta__%3A%22third%7C%7C1.json","file:__tsdf_payload__%3A%22fourth%7C%7C2.json","file:__tsdf_payload__%3A%22third%7C%7C1.json"]'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22fourth%7C%7C2.json (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))'
        - '📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22fourth%7C%7C2.json (tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2 (metadata))'
        - '📖 tsdf/sess1/lq-coalesced-query-maintenance/listQuery.item/__tsdf_meta__%3A%22third%7C%7C1.json (tsdf.sess1.lq-coalesced-query-maintenance.li."third||1 (metadata))'
    `);
  });

  test('persisting an empty query does not materialize the item namespace manifest', async () => {
    const storeName = 'lq-empty-query-manifest';
    const sessionKey = 'sess1';
    const usersQuery = {
      tableId: 'users',
      filters: [{ field: 'name', op: 'eq', value: 'Missing user' }],
    } satisfies ListQueryParams;
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
    });

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
    const operationsBreakdown = readCapture.finish();

    expect(
      listStoredKeys(mockAdapter, {
        sessionKey,
        storeName,
        kind: 'listQuery.item',
      }),
    ).toMatchInlineSnapshot(`[]`);
    expect(
      listStoredKeys(mockAdapter, {
        sessionKey,
        storeName,
        kind: 'listQuery.query',
      }),
    ).toMatchInlineSnapshot(
      `['{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}']`,
    );
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: ['sess1/lq-empty-query-manifest/listQuery.query']
        metadataBatchReads:
          - - 'lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata)'
        metadataReads:
          - 'lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata)'
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📁 ensure 🆕 tsdf/sess1/lq-empty-query-manifest/listQuery.query (scope directory)'
        - '📄 ensure 🆕 tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (payload))'
        - '📄 ensure 🆕 tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata))'
        - '✍️ tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (payload))'
        - '✍️ tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ✅ tsdf/sess1/lq-empty-query-manifest/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-empty-query-manifest/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-empty-query-manifest/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/lq-empty-query-manifest/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Missing%20user%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata))'
        - '📂 open ❌ tsdf/sess1/lq-empty-query-manifest/listQuery.item (scope directory)'
    `);
  });

  test('query that becomes empty after invalidation do not clean up orphaned items from persistence', async () => {
    const storeName = 'lq-query-becomes-empty';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    // Seed the cache with a query that has one item.
    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(mockAdapter, storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

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
    const invalidationOperations = invalidationCapture.finish();

    expect(hook.result.current.items).toMatchInlineSnapshot(`[]`);
    expect(mockAdapter.listQuery.readQueryEntry(usersQuery))
      .toMatchInlineSnapshot(`
        data:
          hasMore: '❌'
          items: []
          payload: { tableId: 'users' }

        timestamp: 1735689600000
        version: 1
      `);
    expect(mockAdapter.listQuery.readItemData('users', 1))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached user'
      `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-query-becomes-empty/listQuery.item'
          - 'sess1/lq-query-becomes-empty/listQuery.query'
          - 'sess1/lq-query-becomes-empty/listQuery.query'
          - 'sess1/lq-query-becomes-empty/listQuery.item'
        metadataBatchReads:
          - ['lq.{tableId:"users"} (metadata)']
          - ['li."users||1 (metadata)']
          - ['lq.{tableId:"users"} (metadata)']
          - ['li."users||1 (metadata)']
        metadataReads:
          - 'lq.{tableId:"users"} (metadata)'
          - 'li."users||1 (metadata)'
          - 'lq.{tableId:"users"} (metadata)'
          - 'li."users||1 (metadata)'
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-query-becomes-empty/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]'
        - '📂 open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-query-becomes-empty/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata))'
        - '📁 ensure ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query (scope directory)'
        - '📄 ensure ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (payload))'
        - '📄 ensure ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata))'
        - '✍️ tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (payload))'
        - '✍️ tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📖 tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata))'
        - '📁 ensure ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item (scope directory)'
        - '📄 ensure ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-becomes-empty.li."users||1 (payload))'
        - '📄 ensure ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata))'
        - '✍️ tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-becomes-empty.li."users||1 (payload))'
        - '✍️ tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata))'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-query-becomes-empty/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/lq-query-becomes-empty/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-query-becomes-empty/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]'
        - '📂 open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-query-becomes-empty/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-becomes-empty.li."users||1 (metadata))'
    `);
  });

  test('when maxItems limit is reached a full store cleanup occurs', async () => {
    const storeName = 'lq-item-metadata';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
    });

    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Oldest cached',
    });
    await advanceTime(100);
    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 2, {
      id: 2,
      name: 'Newer cached',
    });
    setCachedQuery(mockAdapter, storeName, sessionKey, { tableId: 'users' }, [
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
    const operationsBreakdown = readCapture.finish();

    expect(
      listStoredKeys(mockAdapter, {
        sessionKey,
        storeName,
        kind: 'listQuery.item',
      }).sort(),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-item-metadata/listQuery.item'
          - 'sess1/lq-item-metadata/listQuery.query'
          - 'sess1/lq-item-metadata/listQuery.query'
          - 'sess1/lq-item-metadata/listQuery.item'
          - 'sess1/lq-item-metadata/listQuery.item'
        metadataBatchReads:
          - ['lq.{tableId:"users"} (metadata)']
          - - 'li."users||1 (metadata)'
            - 'li."users||2 (metadata)'
            - 'li."users||3 (metadata)'
        metadataReads:
          - 'lq.{tableId:"users"} (metadata)'
          - 'li."users||1 (metadata)'
          - 'li."users||2 (metadata)'
          - 'li."users||3 (metadata)'
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ✅ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C2.json"]'
        - '📂 open ✅ tsdf/sess1/lq-item-metadata/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-item-metadata/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory)'
        - '📄 open ❌ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json (tsdf.sess1.lq-item-metadata.li."users||3 (metadata))'
        - '📁 ensure ✅ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory)'
        - '📄 ensure 🆕 tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_payload__%3A%22users%7C%7C3.json (tsdf.sess1.lq-item-metadata.li."users||3 (payload))'
        - '📄 ensure 🆕 tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json (tsdf.sess1.lq-item-metadata.li."users||3 (metadata))'
        - '✍️ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_payload__%3A%22users%7C%7C3.json (tsdf.sess1.lq-item-metadata.li."users||3 (payload))'
        - '✍️ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json (tsdf.sess1.lq-item-metadata.li."users||3 (metadata))'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ✅ tsdf/sess1/lq-item-metadata/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-item-metadata/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-item-metadata/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-item-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-item-metadata.lq.{tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/lq-item-metadata/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-item-metadata.lq.{tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_meta__%3A%22users%7C%7C3.json","file:__tsdf_payload__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C3.json"]'
        - '📂 open ✅ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-item-metadata.li."users||1 (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json (tsdf.sess1.lq-item-metadata.li."users||2 (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json (tsdf.sess1.lq-item-metadata.li."users||3 (metadata))'
        - '📖 tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-item-metadata.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json (tsdf.sess1.lq-item-metadata.li."users||2 (metadata))'
        - '📖 tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json (tsdf.sess1.lq-item-metadata.li."users||3 (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory)'
        - '🗑️ ✅ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_payload__%3A%22users%7C%7C3.json (tsdf.sess1.lq-item-metadata.li."users||3 (payload))'
        - '🗑️ ✅ tsdf/sess1/lq-item-metadata/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json (tsdf.sess1.lq-item-metadata.li."users||3 (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-item-metadata/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C2.json"]'
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
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
    });

    // Seed two persisted queries that both reference the same oldest item.
    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Shared oldest',
    });
    await advanceTime(100);
    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 2, {
      id: 2,
      name: 'Alice only',
    });
    await advanceTime(100);
    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 3, {
      id: 3,
      name: 'Bob only',
    });
    await advanceTime(100);
    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 4, {
      id: 4,
      name: 'Standalone newest',
    });
    setCachedQuery(mockAdapter, storeName, sessionKey, firstUsersQuery, [
      sharedItemKey,
      aliceOnlyItemKey,
    ]);
    setCachedQuery(mockAdapter, storeName, sessionKey, secondUsersQuery, [
      sharedItemKey,
      bobOnlyItemKey,
    ]);
    registerAsyncNamespace(mockAdapter, {
      sessionKey,
      storeName,
      kind: 'listQuery.item',
    });
    registerAsyncNamespace(mockAdapter, {
      sessionKey,
      storeName,
      kind: 'listQuery.query',
    });

    createListQueryEnv({ storeName, sessionKey, maxItems: 3 });

    // Let the startup-scheduled maintenance enforce maxItems against the preloaded cache.
    const cleanupCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    await waitForScheduledCleanup();
    const cleanupOperations = cleanupCapture.finish();

    expect(
      listStoredKeys(mockAdapter, {
        sessionKey,
        storeName,
        kind: 'listQuery.item',
      }).sort(),
    ).toMatchInlineSnapshot(
      `['"users||1', '"users||2', '"users||3', '"users||4']`,
    );
    expect(mockAdapter.listQuery.readQueryEntry(firstUsersQuery))
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
    expect(mockAdapter.listQuery.readQueryEntry(secondUsersQuery))
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
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-shared-item-cleanup/listQuery.item'
          - 'sess1/lq-shared-item-cleanup/listQuery.query'
        metadataBatchReads:
          - - 'li."users||1 (metadata)'
            - 'li."users||2 (metadata)'
            - 'li."users||3 (metadata)'
            - 'li."users||4 (metadata)'
          - - 'lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)'
            - 'lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"} (metadata)'
        metadataReads:
          - 'li."users||1 (metadata)'
          - 'li."users||2 (metadata)'
          - 'li."users||3 (metadata)'
          - 'li."users||4 (metadata)'
          - 'lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)'
          - 'lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"} (metadata)'
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-shared-item-cleanup/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_meta__%3A%22users%7C%7C3.json","file:__tsdf_meta__%3A%22users%7C%7C4.json","file:__tsdf_payload__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C3.json","file:__tsdf_payload__%3A%22users%7C%7C4.json"]'
        - '📂 open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-shared-item-cleanup.li."users||1 (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json (tsdf.sess1.lq-shared-item-cleanup.li."users||2 (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json (tsdf.sess1.lq-shared-item-cleanup.li."users||3 (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C4.json (tsdf.sess1.lq-shared-item-cleanup.li."users||4 (metadata))'
        - '📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-shared-item-cleanup.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json (tsdf.sess1.lq-shared-item-cleanup.li."users||2 (metadata))'
        - '📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C3.json (tsdf.sess1.lq-shared-item-cleanup.li."users||3 (metadata))'
        - '📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.item/__tsdf_meta__%3A%22users%7C%7C4.json (tsdf.sess1.lq-shared-item-cleanup.li."users||4 (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-shared-item-cleanup/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-shared-item-cleanup/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/lq-shared-item-cleanup/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Bob%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
        - '📖 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/maintenance.json (global maintenance)'
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
    const deletedItemStorageKey = listQueryItemStorageKey(
      storeName,
      sessionKey,
      'users',
      1,
    );
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
    });

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
    const deleteOperations = deleteCapture.finish();

    expect(mockAdapter.has(deletedItemStorageKey)).toBe(false);
    expect(
      listStoredKeys(mockAdapter, {
        sessionKey,
        storeName,
        kind: 'listQuery.item',
      }).sort(),
    ).toMatchInlineSnapshot(`['"users||2']`);
    expect(mockAdapter.listQuery.readQueryEntry(usersQuery))
      .toMatchInlineSnapshot(`
        data:
          hasMore: '❌'
          items: ['"users||2']
          payload: { tableId: 'users' }

        timestamp: 1735689601850
        version: 1
      `);
    expect(mockAdapter.listQuery.readQueryEntry(filteredUsersQuery))
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
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: ['sess1/lq-delete-flow/listQuery.query', 'sess1/lq-delete-flow/listQuery.item']
        metadataBatchReads:
          - - 'lq.{tableId:"users"} (metadata)'
            - 'lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)'
          - ['li."users||2 (metadata)']
          - - 'lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)'
            - 'lq.{tableId:"users"} (metadata)'
          - ['li."users||2 (metadata)']
        metadataReads:
          - 'lq.{tableId:"users"} (metadata)'
          - 'lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)'
          - 'li."users||2 (metadata)'
          - 'lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)'
          - 'lq.{tableId:"users"} (metadata)'
          - 'li."users||2 (metadata)'
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ✅ tsdf/sess1/lq-delete-flow/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata))'
        - '📁 ensure ✅ tsdf/sess1/lq-delete-flow/listQuery.query (scope directory)'
        - '📄 ensure ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (payload))'
        - '📄 ensure ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata))'
        - '📄 ensure ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (payload))'
        - '📄 ensure ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata))'
        - '✍️ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (payload))'
        - '✍️ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata))'
        - '✍️ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (payload))'
        - '✍️ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-delete-flow/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json (tsdf.sess1.lq-delete-flow.li."users||2 (metadata))'
        - '📖 tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json (tsdf.sess1.lq-delete-flow.li."users||2 (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-delete-flow/listQuery.item (scope directory)'
        - '🗑️ ✅ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-delete-flow.li."users||1 (payload))'
        - '🗑️ ✅ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-delete-flow.li."users||1 (metadata))'
        - '📁 ensure ✅ tsdf/sess1/lq-delete-flow/listQuery.item (scope directory)'
        - '📄 ensure ✅ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C2.json (tsdf.sess1.lq-delete-flow.li."users||2 (payload))'
        - '📄 ensure ✅ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json (tsdf.sess1.lq-delete-flow.li."users||2 (metadata))'
        - '✍️ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C2.json (tsdf.sess1.lq-delete-flow.li."users||2 (payload))'
        - '✍️ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json (tsdf.sess1.lq-delete-flow.li."users||2 (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-delete-flow/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-delete-flow/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-delete-flow/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7Bfilters%3A%5B%7Bfield%3A%22name%22%2Cop%3A%22eq%22%2Cvalue%3A%22Alice%22%7D%5D%2CtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/lq-delete-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-delete-flow.lq.{tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-delete-flow/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-delete-flow/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C2.json","file:__tsdf_payload__%3A%22users%7C%7C2.json"]'
        - '📂 open ✅ tsdf/sess1/lq-delete-flow/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json (tsdf.sess1.lq-delete-flow.li."users||2 (metadata))'
        - '📖 tsdf/sess1/lq-delete-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json (tsdf.sess1.lq-delete-flow.li."users||2 (metadata))'
    `);
  });

  test('direct getQueryState reads the cached list query multiple times with short gaps and keeps it in memory', async () => {
    const storeName = 'lq-direct-get-query-state';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(mockAdapter, storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

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
    const operationsBreakdown = readCapture.finish();

    expect(env.store.state).toMatchInlineSnapshot(`
      itemFieldInvalidationFields: {}

      itemLoadedFields: {}

      itemQueries: {}

      items: {}

      queries: {}
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);
  });

  test('direct getQueryState touch preserves offline markers added by another tab before item and query manifest updates', async () => {
    const storeName = 'lq-direct-touch-offline-marker';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const itemStorageKey = listQueryItemStorageKey(
      storeName,
      sessionKey,
      'users',
      1,
    );
    const queryStorageKey = listQueryStorageKey(
      storeName,
      sessionKey,
      usersQuery,
    );
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    mockAdapter.setValue(itemStorageKey, {
      data: { d: { id: 1, name: 'Cached user' }, p: 'users||1' },
      timestamp: Date.now() - 7 * 60 * 60 * 1000,
      version: 1,
    });
    mockAdapter.setValue(queryStorageKey, {
      data: { p: usersQuery, i: [storeItemKey('users', 1)] },
      timestamp: Date.now() - 7 * 60 * 60 * 1000,
      version: 1,
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
  });

  test('useListQuery invalidation snapshots the full query persistence timeline through the refetch save', async () => {
    const storeName = 'lq-query-invalidation-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(mockAdapter, storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

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
    const invalidationOperations = invalidationCapture.finish();

    expect(hook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Fresh user' }`,
    );
    expect(mockAdapter.listQuery.readQueryEntry(usersQuery))
      .toMatchInlineSnapshot(`
        data:
          hasMore: '❌'
          items: ['"users||1']
          payload: { tableId: 'users' }

        timestamp: 1735689600000
        version: 1
      `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-query-invalidation-flow/listQuery.item'
          - 'sess1/lq-query-invalidation-flow/listQuery.query'
          - 'sess1/lq-query-invalidation-flow/listQuery.query'
          - 'sess1/lq-query-invalidation-flow/listQuery.item'
        metadataBatchReads:
          - ['li."users||1 (metadata)']
          - ['lq.{tableId:"users"} (metadata)']
          - ['li."users||1 (metadata)']
        metadataReads:
          - 'li."users||1 (metadata)'
          - 'lq.{tableId:"users"} (metadata)'
          - 'li."users||1 (metadata)'
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-query-invalidation-flow/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]'
        - '📂 open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-query-invalidation-flow/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata))'
        - '📁 ensure ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item (scope directory)'
        - '📄 ensure ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (payload))'
        - '📄 ensure ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata))'
        - '✍️ tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (payload))'
        - '✍️ tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata))'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-query-invalidation-flow/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-query-invalidation-flow.lq.{tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/lq-query-invalidation-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-query-invalidation-flow.lq.{tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-query-invalidation-flow/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]'
        - '📂 open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-query-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-query-invalidation-flow.li."users||1 (metadata))'
    `);
  });

  test('repeated invalidations within the debounce window coalesce list-query persistence writes', async () => {
    const storeName = 'lq-coalesced-invalidations';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(mockAdapter, storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

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
    const firstInvalidationOperations = firstInvalidationCapture.finish();

    expect(hook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Fresh user 1' }`,
    );
    expect(firstInvalidationOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);

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
    const secondInvalidationOperations = secondInvalidationCapture.finish();

    expect(hook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Fresh user 2' }`,
    );
    expect(mockAdapter.listQuery.readItemData('users', 1))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Fresh user 2'
      `);
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-coalesced-invalidations/listQuery.item'
          - 'sess1/lq-coalesced-invalidations/listQuery.query'
          - 'sess1/lq-coalesced-invalidations/listQuery.query'
          - 'sess1/lq-coalesced-invalidations/listQuery.item'
        metadataBatchReads:
          - ['li."users||1 (metadata)']
          - ['lq.{tableId:"users"} (metadata)']
          - ['li."users||1 (metadata)']
        metadataReads:
          - 'li."users||1 (metadata)'
          - 'lq.{tableId:"users"} (metadata)'
          - 'li."users||1 (metadata)'
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-coalesced-invalidations/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-coalesced-invalidations/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata))'
        - '📁 ensure ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item (scope directory)'
        - '📄 ensure ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (payload))'
        - '📄 ensure ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata))'
        - '✍️ tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (payload))'
        - '✍️ tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata))'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-coalesced-invalidations/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-coalesced-invalidations.lq.{tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/lq-coalesced-invalidations/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-coalesced-invalidations.lq.{tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-coalesced-invalidations/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]'
        - '📂 open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-coalesced-invalidations/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-coalesced-invalidations.li."users||1 (metadata))'
    `);
  });

  test('list-query invalidation preserves offline markers added by another tab before item and query manifest updates', async () => {
    const storeName = 'lq-offline-marker-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const itemStorageKey = listQueryItemStorageKey(
      storeName,
      sessionKey,
      'users',
      1,
    );
    const queryStorageKey = listQueryStorageKey(
      storeName,
      sessionKey,
      usersQuery,
    );
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(mockAdapter, storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

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
  });

  test('query hook remount reuses hydrated list-query state without touching localStorage again', async () => {
    const storeName = 'lq-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(mockAdapter, storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

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
        - '📂 open ✅ tsdf/sess1/lq-remount-flow/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (payload))'
        - '📄 open ✅ tsdf/sess1/lq-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/lq-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (payload))'
        - '📖 tsdf/sess1/lq-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-remount-flow/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-remount-flow.li."users||1 (payload))'
        - '📄 open ✅ tsdf/sess1/lq-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-remount-flow.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-remount-flow.li."users||1 (payload))'
        - '📖 tsdf/sess1/lq-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-remount-flow.li."users||1 (metadata))'
    `);
    expect(remountOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);
    expect(isEmptyOperationSummary(remountOperations)).toBe(true);
  });

  test('useItem invalidation snapshots the full item persistence timeline through the refetch save', async () => {
    const storeName = 'lq-item-invalidation-flow';
    const sessionKey = 'sess1';
    const itemPayload = rawItemPayload('users', 1);
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 1, {
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
    const invalidationOperations = invalidationCapture.finish();

    expect(hook.result.current.data).toMatchInlineSnapshot(`
      id: 1
      name: 'Fresh user'
    `);
    expect(mockAdapter.listQuery.readItemData('users', 1))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Fresh user'
      `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-item-invalidation-flow/listQuery.item'
          - 'sess1/lq-item-invalidation-flow/listQuery.item'
        metadataBatchReads:
          - ['li."users||1 (metadata)']
          - ['li."users||1 (metadata)']
        metadataReads: ['li."users||1 (metadata)', 'li."users||1 (metadata)']
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-item-invalidation-flow/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]'
        - '📂 open ❌ tsdf/sess1/lq-item-invalidation-flow/listQuery.query (scope directory)'
        - '📂 open ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata))'
        - '📁 ensure ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item (scope directory)'
        - '📄 ensure ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (payload))'
        - '📄 ensure ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata))'
        - '✍️ tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (payload))'
        - '✍️ tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata))'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ❌ tsdf/sess1/lq-item-invalidation-flow/listQuery.query (scope directory)'
        - '📂 open ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-item-invalidation-flow/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]'
        - '📂 open ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-item-invalidation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-item-invalidation-flow.li."users||1 (metadata))'
    `);
  });

  test('item hook remount reuses hydrated standalone list-query items without touching localStorage again', async () => {
    const storeName = 'lq-item-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 1, {
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
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['li."users||1 (metadata)']
        metadataReads: ['li."users||1 (metadata)']
        payloadBatchReads:
          - ['li."users||1 (payload)']
        scopedPayloadReads: ['li."users||1 (payload)']

      operations:
        - '📂 open ✅ tsdf/sess1/lq-item-remount-flow/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-item-remount-flow.li."users||1 (payload))'
        - '📄 open ✅ tsdf/sess1/lq-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-item-remount-flow.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-item-remount-flow.li."users||1 (payload))'
        - '📖 tsdf/sess1/lq-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-item-remount-flow.li."users||1 (metadata))'
    `);
    expect(remountOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);
    expect(isEmptyOperationSummary(remountOperations)).toBe(true);
  });

  test('useMultipleItems remount reuses hydrated standalone list-query items without touching localStorage again', async () => {
    const storeName = 'lq-multi-item-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user 1',
    });
    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 2, {
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
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['li."users||1 (metadata)']
          - ['li."users||2 (metadata)']
        metadataReads: ['li."users||1 (metadata)', 'li."users||2 (metadata)']
        payloadBatchReads:
          - ['li."users||1 (payload)']
          - ['li."users||2 (payload)']
        scopedPayloadReads: ['li."users||1 (payload)', 'li."users||2 (payload)']

      operations:
        - '📂 open ✅ tsdf/sess1/lq-multi-item-remount-flow/listQuery.item (scope directory)'
        - '📂 open ✅ tsdf/sess1/lq-multi-item-remount-flow/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (payload))'
        - '📄 open ✅ tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C2.json (tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (payload))'
        - '📄 open ✅ tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json (tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (metadata))'
        - '📖 tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (payload))'
        - '📖 tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C2.json (tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (payload))'
        - '📖 tsdf/sess1/lq-multi-item-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C2.json (tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (metadata))'
    `);
    expect(remountOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);
    expect(isEmptyOperationSummary(remountOperations)).toBe(true);
  });

  test('useMultipleListQueries remount reuses hydrated queries without touching localStorage again', async () => {
    const storeName = 'lq-multi-query-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedItem(mockAdapter, storeName, sessionKey, 'projects', 1, {
      id: 1,
      name: 'Cached project',
    });
    setCachedQuery(mockAdapter, storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);
    setCachedQuery(mockAdapter, storeName, sessionKey, projectsQuery, [
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
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['lq.{tableId:"users"} (metadata)']
          - ['lq.{tableId:"projects"} (metadata)']
          - ['li."users||1 (metadata)']
          - ['li."projects||1 (metadata)']
        metadataReads:
          - 'lq.{tableId:"users"} (metadata)'
          - 'lq.{tableId:"projects"} (metadata)'
          - 'li."users||1 (metadata)'
          - 'li."projects||1 (metadata)'
        payloadBatchReads:
          - ['lq.{tableId:"users"} (payload)']
          - ['lq.{tableId:"projects"} (payload)']
          - ['li."users||1 (payload)']
          - ['li."projects||1 (payload)']
        scopedPayloadReads:
          - 'lq.{tableId:"users"} (payload)'
          - 'lq.{tableId:"projects"} (payload)'
          - 'li."users||1 (payload)'
          - 'li."projects||1 (payload)'

      operations:
        - '📂 open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.query (scope directory)'
        - '📂 open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (payload))'
        - '📄 open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (metadata))'
        - '📄 open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22projects%22%7D.json (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (payload))'
        - '📄 open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (metadata))'
        - '📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (payload))'
        - '📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (payload))'
        - '📄 open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22projects%22%7D.json (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (payload))'
        - '📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json (tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_payload__%3A%22projects%7C%7C1.json (tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (payload))'
        - '📄 open ✅ tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json (tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (metadata))'
        - '📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (payload))'
        - '📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_payload__%3A%22projects%7C%7C1.json (tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (payload))'
        - '📖 tsdf/sess1/lq-multi-query-remount-flow/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json (tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (metadata))'
    `);
    expect(remountOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);
    expect(isEmptyOperationSummary(remountOperations)).toBe(true);
  });

  test('updating a hydrated list-query item writes the mutation without rereading cached entries', async () => {
    const storeName = 'lq-mutation-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const itemStorageKey = listQueryItemStorageKey(
      storeName,
      sessionKey,
      'users',
      1,
    );
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedItem(mockAdapter, storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(mockAdapter, storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

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
    const mutationOperations = mutationCapture.finish();

    expect(mockAdapter.listQuery.readItemData('users', 1))
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
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-mutation-flow/listQuery.item'
          - 'sess1/lq-mutation-flow/listQuery.query'
          - 'sess1/lq-mutation-flow/listQuery.query'
          - 'sess1/lq-mutation-flow/listQuery.item'
        metadataBatchReads:
          - ['li."users||1 (metadata)']
          - ['lq.{tableId:"users"} (metadata)']
          - ['li."users||1 (metadata)']
        metadataReads:
          - 'li."users||1 (metadata)'
          - 'lq.{tableId:"users"} (metadata)'
          - 'li."users||1 (metadata)'
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ✅ tsdf/sess1/lq-mutation-flow/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-mutation-flow/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]'
        - '📂 open ✅ tsdf/sess1/lq-mutation-flow/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-mutation-flow/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-mutation-flow/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata))'
        - '📁 ensure ✅ tsdf/sess1/lq-mutation-flow/listQuery.item (scope directory)'
        - '📄 ensure ✅ tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-mutation-flow.li."users||1 (payload))'
        - '📄 ensure ✅ tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata))'
        - '✍️ tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.lq-mutation-flow.li."users||1 (payload))'
        - '✍️ tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata))'
        - '📂 open ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 open ❌ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📁 ensure ✅ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected (scope directory)'
        - '📄 ensure 🆕 tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '✍️ tsdf/__tsdf_async__/__tsdf_async__/__internal.protected/registry.json (internal registry)'
        - '📂 open ✅ tsdf/sess1/lq-mutation-flow/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/lq-mutation-flow/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/lq-mutation-flow/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-mutation-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-mutation-flow.lq.{tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/lq-mutation-flow/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.lq-mutation-flow.lq.{tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/lq-mutation-flow/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/lq-mutation-flow/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]'
        - '📂 open ✅ tsdf/sess1/lq-mutation-flow/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata))'
        - '📖 tsdf/sess1/lq-mutation-flow/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.lq-mutation-flow.li."users||1 (metadata))'
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
    const mockAdapter = createOpfsPersistentStorageTestStore({
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
    const env = createListQueryEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);
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
        - '📂 open ✅ tsdf/sess1/list-query-opfs-efficiency/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/list-query-opfs-efficiency/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.list-query-opfs-efficiency.lq.{tableId:"users"} (payload))'
        - '📄 open ✅ tsdf/sess1/list-query-opfs-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.list-query-opfs-efficiency.lq.{tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/list-query-opfs-efficiency/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.list-query-opfs-efficiency.lq.{tableId:"users"} (payload))'
        - '📖 tsdf/sess1/list-query-opfs-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.list-query-opfs-efficiency.lq.{tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/list-query-opfs-efficiency/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/list-query-opfs-efficiency/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.list-query-opfs-efficiency.li."users||1 (payload))'
        - '📄 open ✅ tsdf/sess1/list-query-opfs-efficiency/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.list-query-opfs-efficiency.li."users||1 (metadata))'
        - '📖 tsdf/sess1/list-query-opfs-efficiency/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.list-query-opfs-efficiency.li."users||1 (payload))'
        - '📖 tsdf/sess1/list-query-opfs-efficiency/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.list-query-opfs-efficiency.li."users||1 (metadata))'
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
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
    });
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

    expect(readCapture.finish()).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/list-query-opfs-eviction-efficiency/listQuery.query'
          - 'sess1/list-query-opfs-eviction-efficiency/listQuery.query'
          - 'sess1/list-query-opfs-eviction-efficiency/listQuery.item'
          - 'sess1/list-query-opfs-eviction-efficiency/listQuery.item'
        metadataBatchReads:
          - ['li."projects||1 (metadata)']
          - - 'lq.{tableId:"projects"} (metadata)'
            - 'lq.{tableId:"tasks"} (metadata)'
            - 'lq.{tableId:"users"} (metadata)'
          - - 'li."projects||1 (metadata)'
            - 'li."tasks||1 (metadata)'
            - 'li."users||1 (metadata)'
        metadataReads:
          - 'li."projects||1 (metadata)'
          - 'lq.{tableId:"projects"} (metadata)'
          - 'lq.{tableId:"tasks"} (metadata)'
          - 'lq.{tableId:"users"} (metadata)'
          - 'li."projects||1 (metadata)'
          - 'li."tasks||1 (metadata)'
          - 'li."users||1 (metadata)'
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query (scope directory)'
        - '📄 open ❌ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata))'
        - '📁 ensure ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query (scope directory)'
        - '📄 ensure 🆕 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22tasks%22%7D.json (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (payload))'
        - '📄 ensure 🆕 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata))'
        - '✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22tasks%22%7D.json (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (payload))'
        - '✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata))'
        - '📂 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata))'
        - '📄 open ❌ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22tasks%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata))'
        - '📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata))'
        - '📁 ensure ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item (scope directory)'
        - '📄 ensure ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_payload__%3A%22projects%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (payload))'
        - '📄 ensure ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata))'
        - '📄 ensure 🆕 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_payload__%3A%22tasks%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (payload))'
        - '📄 ensure 🆕 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22tasks%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata))'
        - '✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_payload__%3A%22projects%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (payload))'
        - '✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata))'
        - '✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_payload__%3A%22tasks%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (payload))'
        - '✍️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22tasks%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata))'
        - '📂 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22projects%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22tasks%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query (scope directory)'
        - '📄 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"projects"} (metadata))'
        - '📄 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata))'
        - '📄 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"users"} (metadata))'
        - '📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"projects"} (metadata))'
        - '📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"tasks"} (metadata))'
        - '📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query (scope directory)'
        - '🗑️ ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_payload__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"users"} (payload))'
        - '🗑️ ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query/__tsdf_meta__%3A%7BtableId%3A%22users%22%7D.json (tsdf.sess1.list-query-opfs-eviction-efficiency.lq.{tableId:"users"} (metadata))'
        - '📂 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query (scope directory)'
        - '🗂️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.query (scope directory) entries=["file:__tsdf_meta__%3A%7BtableId%3A%22projects%22%7D.json","file:__tsdf_meta__%3A%7BtableId%3A%22tasks%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22projects%22%7D.json","file:__tsdf_payload__%3A%7BtableId%3A%22tasks%22%7D.json"]'
        - '📂 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22projects%7C%7C1.json","file:__tsdf_meta__%3A%22tasks%7C%7C1.json","file:__tsdf_meta__%3A%22users%7C%7C1.json","file:__tsdf_payload__%3A%22projects%7C%7C1.json","file:__tsdf_payload__%3A%22tasks%7C%7C1.json","file:__tsdf_payload__%3A%22users%7C%7C1.json"]'
        - '📂 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item (scope directory)'
        - '📄 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata))'
        - '📄 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22tasks%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata))'
        - '📄 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."users||1 (metadata))'
        - '📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22projects%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."projects||1 (metadata))'
        - '📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22tasks%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."tasks||1 (metadata))'
        - '📖 tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."users||1 (metadata))'
        - '📂 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item (scope directory)'
        - '🗑️ ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_payload__%3A%22users%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."users||1 (payload))'
        - '🗑️ ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item/__tsdf_meta__%3A%22users%7C%7C1.json (tsdf.sess1.list-query-opfs-eviction-efficiency.li."users||1 (metadata))'
        - '📂 open ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item (scope directory)'
        - '🗂️ tsdf/sess1/list-query-opfs-eviction-efficiency/listQuery.item (scope directory) entries=["file:__tsdf_meta__%3A%22projects%7C%7C1.json","file:__tsdf_meta__%3A%22tasks%7C%7C1.json","file:__tsdf_payload__%3A%22projects%7C%7C1.json","file:__tsdf_payload__%3A%22tasks%7C%7C1.json"]'
    `);
  });
});
