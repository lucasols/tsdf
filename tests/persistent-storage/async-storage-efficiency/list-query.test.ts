import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import type { ListQueryParams } from '../../mocks/listQueryStoreTestEnv';
import { createMockOpfsStorageAdapter } from '../../mocks/mockOpfsStorageAdapter';
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
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });

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
    createListQueryEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });
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
        externalPayloadReads: ['tsdf.sess1._o_.p (protected registry payload)']
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/list-query-expiration/listQuery.item'
          - 'sess1/list-query-expiration/listQuery.item'
          - 'sess1/list-query-expiration/listQuery.query'
          - 'sess1/list-query-expiration/listQuery.query'
        metadataBatchReads:
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['li."expired-users||1 (metadata)', 'li."fresh-users||2 (metadata)']
          - - 'lq.{tableId:"expired-users"} (metadata)'
            - 'lq.{tableId:"fresh-users"} (metadata)'
        metadataReads:
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'li."expired-users||1 (metadata)'
          - 'li."fresh-users||2 (metadata)'
          - 'lq.{tableId:"expired-users"} (metadata)'
          - 'lq.{tableId:"fresh-users"} (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '📖 ❌ <internal:record>'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📖 ✅ <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/list-query-expiration/listQuery.item keys=["__tsdf_meta__:\\"expired-users||1","__tsdf_meta__:\\"fresh-users||2","__tsdf_payload__:\\"expired-users||1","__tsdf_payload__:\\"fresh-users||2"]'
        - '📚 sess1/list-query-expiration/listQuery.item hits=2/2 ["li.\\"expired-users||1 (metadata)","li.\\"fresh-users||2 (metadata)"]'
        - '🗑️ sess1/list-query-expiration/listQuery.item ["li.\\"expired-users||1 (payload)","li.\\"expired-users||1 (metadata)"]'
        - '🗂️ sess1/list-query-expiration/listQuery.item keys=["__tsdf_meta__:\\"fresh-users||2","__tsdf_payload__:\\"fresh-users||2"]'
        - '📖 ✅ <internal:record>'
        - '🗂️ sess1/list-query-expiration/listQuery.query keys=["__tsdf_meta__:{tableId:\\"expired-users\\"}","__tsdf_meta__:{tableId:\\"fresh-users\\"}","__tsdf_payload__:{tableId:\\"expired-users\\"}","__tsdf_payload__:{tableId:\\"fresh-users\\"}"]'
        - '📚 sess1/list-query-expiration/listQuery.query hits=2/2 ["lq.{tableId:\\"expired-users\\"} (metadata)","lq.{tableId:\\"fresh-users\\"} (metadata)"]'
        - '🗑️ sess1/list-query-expiration/listQuery.query ["lq.{tableId:\\"expired-users\\"} (payload)","lq.{tableId:\\"expired-users\\"} (metadata)"]'
        - '🗂️ sess1/list-query-expiration/listQuery.query keys=["__tsdf_meta__:{tableId:\\"fresh-users\\"}","__tsdf_payload__:{tableId:\\"fresh-users\\"}"]'
        - '📖 ✅ <internal:record>'
        - '📖 ✅ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
    `);
  });

  test('when maxQueries limit is reached a full store cleanup occurs', async () => {
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const storeName = 'lq-query-metadata';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });

    setCachedQuery(mockAdapter, storeName, sessionKey, firstQuery, []);
    await advanceTime(100);
    setCachedQuery(mockAdapter, storeName, sessionKey, secondQuery, []);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      maxQueries: 2,
      serverData: { third: [{ id: 1, name: 'Third' }] },
      storageAdapter: mockAdapter.adapter,
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
        externalPayloadReads:
          - 'tsdf.sess1._o_.p (protected registry payload)'
          - 'tsdf.sess1._o_.p (protected registry payload)'
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-query-metadata/listQuery.item'
          - 'sess1/lq-query-metadata/listQuery.query'
          - 'sess1/lq-query-metadata/listQuery.query'
          - 'sess1/lq-query-metadata/listQuery.query'
          - 'sess1/lq-query-metadata/listQuery.item'
        metadataBatchReads:
          - ['lq.{tableId:"third"} (metadata)']
          - ['li."third||1 (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - - 'lq.{tableId:"first"} (metadata)'
            - 'lq.{tableId:"second"} (metadata)'
            - 'lq.{tableId:"third"} (metadata)'
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['li."third||1 (metadata)']
        metadataReads:
          - 'lq.{tableId:"third"} (metadata)'
          - 'li."third||1 (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'lq.{tableId:"first"} (metadata)'
          - 'lq.{tableId:"second"} (metadata)'
          - 'lq.{tableId:"third"} (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'li."third||1 (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '🗂️ sess1/lq-query-metadata/listQuery.item keys=[]'
        - '🗂️ sess1/lq-query-metadata/listQuery.query keys=["__tsdf_meta__:{tableId:\\"first\\"}","__tsdf_meta__:{tableId:\\"second\\"}","__tsdf_payload__:{tableId:\\"first\\"}","__tsdf_payload__:{tableId:\\"second\\"}"]'
        - '📚 sess1/lq-query-metadata/listQuery.query hits=0/1 ["lq.{tableId:\\"third\\"} (metadata)"]'
        - '✍️ sess1/lq-query-metadata/listQuery.query ["lq.{tableId:\\"third\\"} (payload)","lq.{tableId:\\"third\\"} (metadata)"]'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/lq-query-metadata/listQuery.item hits=0/1 ["li.\\"third||1 (metadata)"]'
        - '✍️ sess1/lq-query-metadata/listQuery.item ["li.\\"third||1 (payload)","li.\\"third||1 (metadata)"]'
        - '📖 ✅ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-query-metadata/listQuery.query keys=["__tsdf_meta__:{tableId:\\"first\\"}","__tsdf_meta__:{tableId:\\"second\\"}","__tsdf_meta__:{tableId:\\"third\\"}","__tsdf_payload__:{tableId:\\"first\\"}","__tsdf_payload__:{tableId:\\"second\\"}","__tsdf_payload__:{tableId:\\"third\\"}"]'
        - '📚 sess1/lq-query-metadata/listQuery.query hits=3/3 ["lq.{tableId:\\"first\\"} (metadata)","lq.{tableId:\\"second\\"} (metadata)","lq.{tableId:\\"third\\"} (metadata)"]'
        - '🗑️ sess1/lq-query-metadata/listQuery.query ["lq.{tableId:\\"first\\"} (payload)","lq.{tableId:\\"first\\"} (metadata)"]'
        - '🗂️ sess1/lq-query-metadata/listQuery.query keys=["__tsdf_meta__:{tableId:\\"second\\"}","__tsdf_meta__:{tableId:\\"third\\"}","__tsdf_payload__:{tableId:\\"second\\"}","__tsdf_payload__:{tableId:\\"third\\"}"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-query-metadata/listQuery.item keys=["__tsdf_meta__:\\"third||1","__tsdf_payload__:\\"third||1"]'
        - '📚 sess1/lq-query-metadata/listQuery.item hits=1/1 ["li.\\"third||1 (metadata)"]'
    `);
  });

  test('multiple overflowing query writes before idle maintenance trigger a single cleanup pass', async () => {
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const fourthQuery = { tableId: 'fourth' };
    const storeName = 'lq-coalesced-query-maintenance';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });

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
      storageAdapter: mockAdapter.adapter,
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
        externalPayloadReads:
          - 'tsdf.sess1._o_.p (protected registry payload)'
          - 'tsdf.sess1._o_.p (protected registry payload)'
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-coalesced-query-maintenance/listQuery.item'
          - 'sess1/lq-coalesced-query-maintenance/listQuery.query'
          - 'sess1/lq-coalesced-query-maintenance/listQuery.query'
          - 'sess1/lq-coalesced-query-maintenance/listQuery.query'
          - 'sess1/lq-coalesced-query-maintenance/listQuery.item'
        metadataBatchReads:
          - ['lq.{tableId:"third"} (metadata)']
          - ['li."third||1 (metadata)']
          - ['lq.{tableId:"fourth"} (metadata)']
          - ['li."third||1 (metadata)', 'li."fourth||2 (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - - 'lq.{tableId:"first"} (metadata)'
            - 'lq.{tableId:"fourth"} (metadata)'
            - 'lq.{tableId:"second"} (metadata)'
            - 'lq.{tableId:"third"} (metadata)'
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['li."fourth||2 (metadata)', 'li."third||1 (metadata)']
        metadataReads:
          - 'lq.{tableId:"third"} (metadata)'
          - 'li."third||1 (metadata)'
          - 'lq.{tableId:"fourth"} (metadata)'
          - 'li."third||1 (metadata)'
          - 'li."fourth||2 (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'lq.{tableId:"first"} (metadata)'
          - 'lq.{tableId:"fourth"} (metadata)'
          - 'lq.{tableId:"second"} (metadata)'
          - 'lq.{tableId:"third"} (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'li."fourth||2 (metadata)'
          - 'li."third||1 (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '🗂️ sess1/lq-coalesced-query-maintenance/listQuery.item keys=[]'
        - '🗂️ sess1/lq-coalesced-query-maintenance/listQuery.query keys=["__tsdf_meta__:{tableId:\\"first\\"}","__tsdf_meta__:{tableId:\\"second\\"}","__tsdf_payload__:{tableId:\\"first\\"}","__tsdf_payload__:{tableId:\\"second\\"}"]'
        - '📚 sess1/lq-coalesced-query-maintenance/listQuery.query hits=0/1 ["lq.{tableId:\\"third\\"} (metadata)"]'
        - '✍️ sess1/lq-coalesced-query-maintenance/listQuery.query ["lq.{tableId:\\"third\\"} (payload)","lq.{tableId:\\"third\\"} (metadata)"]'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/lq-coalesced-query-maintenance/listQuery.item hits=0/1 ["li.\\"third||1 (metadata)"]'
        - '✍️ sess1/lq-coalesced-query-maintenance/listQuery.item ["li.\\"third||1 (payload)","li.\\"third||1 (metadata)"]'
        - '📖 ✅ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/lq-coalesced-query-maintenance/listQuery.query hits=0/1 ["lq.{tableId:\\"fourth\\"} (metadata)"]'
        - '✍️ sess1/lq-coalesced-query-maintenance/listQuery.query ["lq.{tableId:\\"fourth\\"} (payload)","lq.{tableId:\\"fourth\\"} (metadata)"]'
        - '📚 sess1/lq-coalesced-query-maintenance/listQuery.item hits=1/2 ["li.\\"third||1 (metadata)","li.\\"fourth||2 (metadata)"]'
        - '✍️ sess1/lq-coalesced-query-maintenance/listQuery.item ["li.\\"third||1 (payload)","li.\\"third||1 (metadata)","li.\\"fourth||2 (payload)","li.\\"fourth||2 (metadata)"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-coalesced-query-maintenance/listQuery.query keys=["__tsdf_meta__:{tableId:\\"first\\"}","__tsdf_meta__:{tableId:\\"fourth\\"}","__tsdf_meta__:{tableId:\\"second\\"}","__tsdf_meta__:{tableId:\\"third\\"}","__tsdf_payload__:{tableId:\\"first\\"}","__tsdf_payload__:{tableId:\\"fourth\\"}","__tsdf_payload__:{tableId:\\"second\\"}","__tsdf_payload__:{tableId:\\"third\\"}"]'
        - '📚 sess1/lq-coalesced-query-maintenance/listQuery.query hits=4/4 ["lq.{tableId:\\"first\\"} (metadata)","lq.{tableId:\\"fourth\\"} (metadata)","lq.{tableId:\\"second\\"} (metadata)","lq.{tableId:\\"third\\"} (metadata)"]'
        - '🗑️ sess1/lq-coalesced-query-maintenance/listQuery.query ["lq.{tableId:\\"second\\"} (payload)","lq.{tableId:\\"second\\"} (metadata)","lq.{tableId:\\"first\\"} (payload)","lq.{tableId:\\"first\\"} (metadata)"]'
        - '🗂️ sess1/lq-coalesced-query-maintenance/listQuery.query keys=["__tsdf_meta__:{tableId:\\"fourth\\"}","__tsdf_meta__:{tableId:\\"third\\"}","__tsdf_payload__:{tableId:\\"fourth\\"}","__tsdf_payload__:{tableId:\\"third\\"}"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-coalesced-query-maintenance/listQuery.item keys=["__tsdf_meta__:\\"fourth||2","__tsdf_meta__:\\"third||1","__tsdf_payload__:\\"fourth||2","__tsdf_payload__:\\"third||1"]'
        - '📚 sess1/lq-coalesced-query-maintenance/listQuery.item hits=2/2 ["li.\\"fourth||2 (metadata)","li.\\"third||1 (metadata)"]'
    `);
  });

  test('persisting an empty query does not materialize the item namespace manifest', async () => {
    const storeName = 'lq-empty-query-manifest';
    const sessionKey = 'sess1';
    const usersQuery = {
      tableId: 'users',
      filters: [{ field: 'name', op: 'eq', value: 'Missing user' }],
    } satisfies ListQueryParams;
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Existing user' }] },
      storageAdapter: mockAdapter.adapter,
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
        externalPayloadReads:
          - 'tsdf.sess1._o_.p (protected registry payload)'
          - 'tsdf.sess1._o_.p (protected registry payload)'
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-empty-query-manifest/listQuery.item'
          - 'sess1/lq-empty-query-manifest/listQuery.query'
          - 'sess1/lq-empty-query-manifest/listQuery.query'
          - 'sess1/lq-empty-query-manifest/listQuery.item'
        metadataBatchReads:
          - - 'lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata)'
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - - 'lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata)'
          - ['tsdf.sess1._o_.p (protected registry metadata)']
        metadataReads:
          - 'lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '🗂️ sess1/lq-empty-query-manifest/listQuery.item keys=[]'
        - '🗂️ sess1/lq-empty-query-manifest/listQuery.query keys=[]'
        - '📚 sess1/lq-empty-query-manifest/listQuery.query hits=0/1 ["lq.{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Missing user\\"}],tableId:\\"users\\"} (metadata)"]'
        - '✍️ sess1/lq-empty-query-manifest/listQuery.query ["lq.{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Missing user\\"}],tableId:\\"users\\"} (payload)","lq.{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Missing user\\"}],tableId:\\"users\\"} (metadata)"]'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-empty-query-manifest/listQuery.query keys=["__tsdf_meta__:{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Missing user\\"}],tableId:\\"users\\"}","__tsdf_payload__:{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Missing user\\"}],tableId:\\"users\\"}"]'
        - '📚 sess1/lq-empty-query-manifest/listQuery.query hits=1/1 ["lq.{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Missing user\\"}],tableId:\\"users\\"} (metadata)"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-empty-query-manifest/listQuery.item keys=[]'
    `);
  });

  test('query that becomes empty after invalidation do not clean up orphaned items from persistence', async () => {
    const storeName = 'lq-query-becomes-empty';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createMockOpfsStorageAdapter({
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
      storageAdapter: mockAdapter.adapter,
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
        - '🗂️ sess1/lq-query-becomes-empty/listQuery.item keys=["__tsdf_meta__:\\"users||1","__tsdf_payload__:\\"users||1"]'
        - '🗂️ sess1/lq-query-becomes-empty/listQuery.query keys=["__tsdf_meta__:{tableId:\\"users\\"}","__tsdf_payload__:{tableId:\\"users\\"}"]'
        - '📚 sess1/lq-query-becomes-empty/listQuery.query hits=1/1 ["lq.{tableId:\\"users\\"} (metadata)"]'
        - '✍️ sess1/lq-query-becomes-empty/listQuery.query ["lq.{tableId:\\"users\\"} (payload)","lq.{tableId:\\"users\\"} (metadata)"]'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/lq-query-becomes-empty/listQuery.item hits=1/1 ["li.\\"users||1 (metadata)"]'
        - '✍️ sess1/lq-query-becomes-empty/listQuery.item ["li.\\"users||1 (payload)","li.\\"users||1 (metadata)"]'
        - '📖 ✅ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '🗂️ sess1/lq-query-becomes-empty/listQuery.query keys=["__tsdf_meta__:{tableId:\\"users\\"}","__tsdf_payload__:{tableId:\\"users\\"}"]'
        - '📚 sess1/lq-query-becomes-empty/listQuery.query hits=1/1 ["lq.{tableId:\\"users\\"} (metadata)"]'
        - '🗂️ sess1/lq-query-becomes-empty/listQuery.item keys=["__tsdf_meta__:\\"users||1","__tsdf_payload__:\\"users||1"]'
        - '📚 sess1/lq-query-becomes-empty/listQuery.item hits=1/1 ["li.\\"users||1 (metadata)"]'
    `);
  });

  test('when maxItems limit is reached a full store cleanup occurs', async () => {
    const storeName = 'lq-item-metadata';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });

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

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      maxItems: 2,
      storageAdapter: mockAdapter.adapter,
    });

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
        externalPayloadReads:
          - 'tsdf.sess1._o_.p (protected registry payload)'
          - 'tsdf.sess1._o_.p (protected registry payload)'
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-item-metadata/listQuery.item'
          - 'sess1/lq-item-metadata/listQuery.query'
          - 'sess1/lq-item-metadata/listQuery.query'
          - 'sess1/lq-item-metadata/listQuery.item'
          - 'sess1/lq-item-metadata/listQuery.item'
        metadataBatchReads:
          - ['li."users||3 (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['lq.{tableId:"users"} (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - - 'li."users||1 (metadata)'
            - 'li."users||2 (metadata)'
            - 'li."users||3 (metadata)'
        metadataReads:
          - 'li."users||3 (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'lq.{tableId:"users"} (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'li."users||1 (metadata)'
          - 'li."users||2 (metadata)'
          - 'li."users||3 (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '🗂️ sess1/lq-item-metadata/listQuery.item keys=["__tsdf_meta__:\\"users||1","__tsdf_meta__:\\"users||2","__tsdf_payload__:\\"users||1","__tsdf_payload__:\\"users||2"]'
        - '🗂️ sess1/lq-item-metadata/listQuery.query keys=["__tsdf_meta__:{tableId:\\"users\\"}","__tsdf_payload__:{tableId:\\"users\\"}"]'
        - '📚 sess1/lq-item-metadata/listQuery.item hits=0/1 ["li.\\"users||3 (metadata)"]'
        - '✍️ sess1/lq-item-metadata/listQuery.item ["li.\\"users||3 (payload)","li.\\"users||3 (metadata)"]'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-item-metadata/listQuery.query keys=["__tsdf_meta__:{tableId:\\"users\\"}","__tsdf_payload__:{tableId:\\"users\\"}"]'
        - '📚 sess1/lq-item-metadata/listQuery.query hits=1/1 ["lq.{tableId:\\"users\\"} (metadata)"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-item-metadata/listQuery.item keys=["__tsdf_meta__:\\"users||1","__tsdf_meta__:\\"users||2","__tsdf_meta__:\\"users||3","__tsdf_payload__:\\"users||1","__tsdf_payload__:\\"users||2","__tsdf_payload__:\\"users||3"]'
        - '📚 sess1/lq-item-metadata/listQuery.item hits=3/3 ["li.\\"users||1 (metadata)","li.\\"users||2 (metadata)","li.\\"users||3 (metadata)"]'
        - '🗑️ sess1/lq-item-metadata/listQuery.item ["li.\\"users||3 (payload)","li.\\"users||3 (metadata)"]'
        - '🗂️ sess1/lq-item-metadata/listQuery.item keys=["__tsdf_meta__:\\"users||1","__tsdf_meta__:\\"users||2","__tsdf_payload__:\\"users||1","__tsdf_payload__:\\"users||2"]'
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
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });

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

    createListQueryEnv({
      storeName,
      sessionKey,
      maxItems: 3,
      storageAdapter: mockAdapter.adapter,
    });

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
        externalPayloadReads: ['tsdf.sess1._o_.p (protected registry payload)']
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-shared-item-cleanup/listQuery.item'
          - 'sess1/lq-shared-item-cleanup/listQuery.query'
        metadataBatchReads:
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - - 'li."users||1 (metadata)'
            - 'li."users||2 (metadata)'
            - 'li."users||3 (metadata)'
            - 'li."users||4 (metadata)'
          - - 'lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)'
            - 'lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"} (metadata)'
        metadataReads:
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'li."users||1 (metadata)'
          - 'li."users||2 (metadata)'
          - 'li."users||3 (metadata)'
          - 'li."users||4 (metadata)'
          - 'lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)'
          - 'lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"} (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '📖 ❌ <internal:record>'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📖 ✅ <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-shared-item-cleanup/listQuery.item keys=["__tsdf_meta__:\\"users||1","__tsdf_meta__:\\"users||2","__tsdf_meta__:\\"users||3","__tsdf_meta__:\\"users||4","__tsdf_payload__:\\"users||1","__tsdf_payload__:\\"users||2","__tsdf_payload__:\\"users||3","__tsdf_payload__:\\"users||4"]'
        - '📚 sess1/lq-shared-item-cleanup/listQuery.item hits=4/4 ["li.\\"users||1 (metadata)","li.\\"users||2 (metadata)","li.\\"users||3 (metadata)","li.\\"users||4 (metadata)"]'
        - '🗂️ sess1/lq-shared-item-cleanup/listQuery.query keys=["__tsdf_meta__:{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Alice\\"}],tableId:\\"users\\"}","__tsdf_meta__:{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Bob\\"}],tableId:\\"users\\"}","__tsdf_payload__:{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Alice\\"}],tableId:\\"users\\"}","__tsdf_payload__:{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Bob\\"}],tableId:\\"users\\"}"]'
        - '📚 sess1/lq-shared-item-cleanup/listQuery.query hits=2/2 ["lq.{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Alice\\"}],tableId:\\"users\\"} (metadata)","lq.{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Bob\\"}],tableId:\\"users\\"} (metadata)"]'
        - '📖 ✅ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
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
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      },
      storageAdapter: mockAdapter.adapter,
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
        externalPayloadReads:
          - 'tsdf.sess1._o_.p (protected registry payload)'
          - 'tsdf.sess1._o_.p (protected registry payload)'
        legacyFallbackReads: []
        listKeyScans: ['sess1/lq-delete-flow/listQuery.query', 'sess1/lq-delete-flow/listQuery.item']
        metadataBatchReads:
          - - 'lq.{tableId:"users"} (metadata)'
            - 'lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)'
          - ['li."users||2 (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - - 'lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)'
            - 'lq.{tableId:"users"} (metadata)'
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['li."users||2 (metadata)']
        metadataReads:
          - 'lq.{tableId:"users"} (metadata)'
          - 'lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)'
          - 'li."users||2 (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"} (metadata)'
          - 'lq.{tableId:"users"} (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'li."users||2 (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '📚 sess1/lq-delete-flow/listQuery.query hits=2/2 ["lq.{tableId:\\"users\\"} (metadata)","lq.{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Alice\\"}],tableId:\\"users\\"} (metadata)"]'
        - '✍️ sess1/lq-delete-flow/listQuery.query ["lq.{tableId:\\"users\\"} (payload)","lq.{tableId:\\"users\\"} (metadata)","lq.{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Alice\\"}],tableId:\\"users\\"} (payload)","lq.{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Alice\\"}],tableId:\\"users\\"} (metadata)"]'
        - '📚 sess1/lq-delete-flow/listQuery.item hits=1/1 ["li.\\"users||2 (metadata)"]'
        - '🗑️ sess1/lq-delete-flow/listQuery.item ["li.\\"users||1 (payload)","li.\\"users||1 (metadata)"]'
        - '✍️ sess1/lq-delete-flow/listQuery.item ["li.\\"users||2 (payload)","li.\\"users||2 (metadata)"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-delete-flow/listQuery.query keys=["__tsdf_meta__:{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Alice\\"}],tableId:\\"users\\"}","__tsdf_meta__:{tableId:\\"users\\"}","__tsdf_payload__:{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Alice\\"}],tableId:\\"users\\"}","__tsdf_payload__:{tableId:\\"users\\"}"]'
        - '📚 sess1/lq-delete-flow/listQuery.query hits=2/2 ["lq.{filters:[{field:\\"name\\",op:\\"eq\\",value:\\"Alice\\"}],tableId:\\"users\\"} (metadata)","lq.{tableId:\\"users\\"} (metadata)"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-delete-flow/listQuery.item keys=["__tsdf_meta__:\\"users||2","__tsdf_payload__:\\"users||2"]'
        - '📚 sess1/lq-delete-flow/listQuery.item hits=1/1 ["li.\\"users||2 (metadata)"]'
    `);
  });

  test('direct getQueryState reads the cached list query multiple times with short gaps and keeps it in memory', async () => {
    const storeName = 'lq-direct-get-query-state';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createMockOpfsStorageAdapter({
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
      storageAdapter: mockAdapter.adapter,
    });

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
    const mockAdapter = createMockOpfsStorageAdapter({
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

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

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
    const mockAdapter = createMockOpfsStorageAdapter({
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
      storageAdapter: mockAdapter.adapter,
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
        externalPayloadReads:
          - 'tsdf.sess1._o_.p (protected registry payload)'
          - 'tsdf.sess1._o_.p (protected registry payload)'
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-query-invalidation-flow/listQuery.item'
          - 'sess1/lq-query-invalidation-flow/listQuery.query'
          - 'sess1/lq-query-invalidation-flow/listQuery.query'
          - 'sess1/lq-query-invalidation-flow/listQuery.item'
        metadataBatchReads:
          - ['li."users||1 (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['lq.{tableId:"users"} (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['li."users||1 (metadata)']
        metadataReads:
          - 'li."users||1 (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'lq.{tableId:"users"} (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'li."users||1 (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '🗂️ sess1/lq-query-invalidation-flow/listQuery.item keys=["__tsdf_meta__:\\"users||1","__tsdf_payload__:\\"users||1"]'
        - '🗂️ sess1/lq-query-invalidation-flow/listQuery.query keys=["__tsdf_meta__:{tableId:\\"users\\"}","__tsdf_payload__:{tableId:\\"users\\"}"]'
        - '📚 sess1/lq-query-invalidation-flow/listQuery.item hits=1/1 ["li.\\"users||1 (metadata)"]'
        - '✍️ sess1/lq-query-invalidation-flow/listQuery.item ["li.\\"users||1 (payload)","li.\\"users||1 (metadata)"]'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-query-invalidation-flow/listQuery.query keys=["__tsdf_meta__:{tableId:\\"users\\"}","__tsdf_payload__:{tableId:\\"users\\"}"]'
        - '📚 sess1/lq-query-invalidation-flow/listQuery.query hits=1/1 ["lq.{tableId:\\"users\\"} (metadata)"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-query-invalidation-flow/listQuery.item keys=["__tsdf_meta__:\\"users||1","__tsdf_payload__:\\"users||1"]'
        - '📚 sess1/lq-query-invalidation-flow/listQuery.item hits=1/1 ["li.\\"users||1 (metadata)"]'
    `);
  });

  test('repeated invalidations within the debounce window coalesce list-query persistence writes', async () => {
    const storeName = 'lq-coalesced-invalidations';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createMockOpfsStorageAdapter({
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
      storageAdapter: mockAdapter.adapter,
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
        externalPayloadReads:
          - 'tsdf.sess1._o_.p (protected registry payload)'
          - 'tsdf.sess1._o_.p (protected registry payload)'
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-coalesced-invalidations/listQuery.item'
          - 'sess1/lq-coalesced-invalidations/listQuery.query'
          - 'sess1/lq-coalesced-invalidations/listQuery.query'
          - 'sess1/lq-coalesced-invalidations/listQuery.item'
        metadataBatchReads:
          - ['li."users||1 (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['lq.{tableId:"users"} (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['li."users||1 (metadata)']
        metadataReads:
          - 'li."users||1 (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'lq.{tableId:"users"} (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'li."users||1 (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '🗂️ sess1/lq-coalesced-invalidations/listQuery.item keys=["__tsdf_meta__:\\"users||1","__tsdf_payload__:\\"users||1"]'
        - '🗂️ sess1/lq-coalesced-invalidations/listQuery.query keys=["__tsdf_meta__:{tableId:\\"users\\"}","__tsdf_payload__:{tableId:\\"users\\"}"]'
        - '📚 sess1/lq-coalesced-invalidations/listQuery.item hits=1/1 ["li.\\"users||1 (metadata)"]'
        - '✍️ sess1/lq-coalesced-invalidations/listQuery.item ["li.\\"users||1 (payload)","li.\\"users||1 (metadata)"]'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-coalesced-invalidations/listQuery.query keys=["__tsdf_meta__:{tableId:\\"users\\"}","__tsdf_payload__:{tableId:\\"users\\"}"]'
        - '📚 sess1/lq-coalesced-invalidations/listQuery.query hits=1/1 ["lq.{tableId:\\"users\\"} (metadata)"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-coalesced-invalidations/listQuery.item keys=["__tsdf_meta__:\\"users||1","__tsdf_payload__:\\"users||1"]'
        - '📚 sess1/lq-coalesced-invalidations/listQuery.item hits=1/1 ["li.\\"users||1 (metadata)"]'
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
    const mockAdapter = createMockOpfsStorageAdapter({
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
      storageAdapter: mockAdapter.adapter,
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
      writtenAt: 1735689604950
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
      writtenAt: 1735689604950
    `);
  });

  test('query hook remount reuses hydrated list-query state without touching localStorage again', async () => {
    const storeName = 'lq-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createMockOpfsStorageAdapter({
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
      storageAdapter: mockAdapter.adapter,
    });

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
        - '📚 sess1/lq-remount-flow/listQuery.query hits=2/2 ["lq.{tableId:\\"users\\"} (payload)","lq.{tableId:\\"users\\"} (metadata)"]'
        - '📚 sess1/lq-remount-flow/listQuery.item hits=2/2 ["li.\\"users||1 (payload)","li.\\"users||1 (metadata)"]'
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
    const mockAdapter = createMockOpfsStorageAdapter({
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
      storageAdapter: mockAdapter.adapter,
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
        externalPayloadReads:
          - 'tsdf.sess1._o_.p (protected registry payload)'
          - 'tsdf.sess1._o_.p (protected registry payload)'
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-item-invalidation-flow/listQuery.item'
          - 'sess1/lq-item-invalidation-flow/listQuery.query'
          - 'sess1/lq-item-invalidation-flow/listQuery.query'
          - 'sess1/lq-item-invalidation-flow/listQuery.item'
        metadataBatchReads:
          - ['li."users||1 (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['li."users||1 (metadata)']
        metadataReads:
          - 'li."users||1 (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'li."users||1 (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '🗂️ sess1/lq-item-invalidation-flow/listQuery.item keys=["__tsdf_meta__:\\"users||1","__tsdf_payload__:\\"users||1"]'
        - '🗂️ sess1/lq-item-invalidation-flow/listQuery.query keys=[]'
        - '📚 sess1/lq-item-invalidation-flow/listQuery.item hits=1/1 ["li.\\"users||1 (metadata)"]'
        - '✍️ sess1/lq-item-invalidation-flow/listQuery.item ["li.\\"users||1 (payload)","li.\\"users||1 (metadata)"]'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-item-invalidation-flow/listQuery.query keys=[]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-item-invalidation-flow/listQuery.item keys=["__tsdf_meta__:\\"users||1","__tsdf_payload__:\\"users||1"]'
        - '📚 sess1/lq-item-invalidation-flow/listQuery.item hits=1/1 ["li.\\"users||1 (metadata)"]'
    `);
  });

  test('item hook remount reuses hydrated standalone list-query items without touching localStorage again', async () => {
    const storeName = 'lq-item-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
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
      storageAdapter: mockAdapter.adapter,
    });

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
        - '📚 sess1/lq-item-remount-flow/listQuery.item hits=2/2 ["li.\\"users||1 (payload)","li.\\"users||1 (metadata)"]'
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
    const mockAdapter = createMockOpfsStorageAdapter({
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

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

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
        - '📚 sess1/lq-multi-item-remount-flow/listQuery.item hits=2/2 ["li.\\"users||1 (payload)","li.\\"users||1 (metadata)"]'
        - '📚 sess1/lq-multi-item-remount-flow/listQuery.item hits=2/2 ["li.\\"users||2 (payload)","li.\\"users||2 (metadata)"]'
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
    const mockAdapter = createMockOpfsStorageAdapter({
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

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

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
        - '📚 sess1/lq-multi-query-remount-flow/listQuery.query hits=2/2 ["lq.{tableId:\\"users\\"} (payload)","lq.{tableId:\\"users\\"} (metadata)"]'
        - '📚 sess1/lq-multi-query-remount-flow/listQuery.query hits=2/2 ["lq.{tableId:\\"projects\\"} (payload)","lq.{tableId:\\"projects\\"} (metadata)"]'
        - '📚 sess1/lq-multi-query-remount-flow/listQuery.item hits=2/2 ["li.\\"users||1 (payload)","li.\\"users||1 (metadata)"]'
        - '📚 sess1/lq-multi-query-remount-flow/listQuery.item hits=2/2 ["li.\\"projects||1 (payload)","li.\\"projects||1 (metadata)"]'
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
    const mockAdapter = createMockOpfsStorageAdapter({
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
      storageAdapter: mockAdapter.adapter,
    });

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
      writtenAt: 1735689604140
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads:
          - 'tsdf.sess1._o_.p (protected registry payload)'
          - 'tsdf.sess1._o_.p (protected registry payload)'
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/lq-mutation-flow/listQuery.item'
          - 'sess1/lq-mutation-flow/listQuery.query'
          - 'sess1/lq-mutation-flow/listQuery.query'
          - 'sess1/lq-mutation-flow/listQuery.item'
        metadataBatchReads:
          - ['li."users||1 (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['lq.{tableId:"users"} (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['li."users||1 (metadata)']
        metadataReads:
          - 'li."users||1 (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'lq.{tableId:"users"} (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'li."users||1 (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '🗂️ sess1/lq-mutation-flow/listQuery.item keys=["__tsdf_meta__:\\"users||1","__tsdf_payload__:\\"users||1"]'
        - '🗂️ sess1/lq-mutation-flow/listQuery.query keys=["__tsdf_meta__:{tableId:\\"users\\"}","__tsdf_payload__:{tableId:\\"users\\"}"]'
        - '📚 sess1/lq-mutation-flow/listQuery.item hits=1/1 ["li.\\"users||1 (metadata)"]'
        - '✍️ sess1/lq-mutation-flow/listQuery.item ["li.\\"users||1 (payload)","li.\\"users||1 (metadata)"]'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-mutation-flow/listQuery.query keys=["__tsdf_meta__:{tableId:\\"users\\"}","__tsdf_payload__:{tableId:\\"users\\"}"]'
        - '📚 sess1/lq-mutation-flow/listQuery.query hits=1/1 ["lq.{tableId:\\"users\\"} (metadata)"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/lq-mutation-flow/listQuery.item keys=["__tsdf_meta__:\\"users||1","__tsdf_payload__:\\"users||1"]'
        - '📚 sess1/lq-mutation-flow/listQuery.item hits=1/1 ["li.\\"users||1 (metadata)"]'
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
