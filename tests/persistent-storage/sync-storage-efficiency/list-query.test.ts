import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { localPersistentStorage } from '../../../src/persistentStorage/storageAdapter';
import type { ListQueryParams } from '../../mocks/listQueryStoreTestEnv';
import { advanceTime, flushAllTimers } from '../../utils/genericTestUtils';
import {
  getLocalStorageTree,
  getParsedLocalStorageValue,
  startPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
  captureHookRemount,
  createListQueryEnv,
  flushInvalidationPersistence,
  listStoredKeys,
  persistentStore,
  rawItemPayload,
  setCachedItem,
  setCachedQuery,
  settleStartupBackgroundScan,
  setupSyncStorageEfficiencyTestSuite,
  storeItemKey,
  waitForScheduledCleanup,
} from './shared';

setupSyncStorageEfficiencyTestSuite();

describe('sync storage efficiency: list-query', () => {
  test('expiration cleanup removes expired queries and items through namespace manifests only', async () => {
    const expiredTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const storeName = 'list-query-expiration';
    const sessionKey = 'sess1';
    const expiredQueryParams: ListQueryParams = { tableId: 'expired-users' };
    const freshQueryParams: ListQueryParams = { tableId: 'fresh-users' };
    const listQueryScope = persistentStore.scope(storeName, sessionKey);

    // Seed one stale query+item pair and one fresh pair to verify cleanup across both manifests.
    const expiredItem = listQueryScope.listQuery.seedItem(
      'expired-users',
      1,
      { id: 1, name: 'Expired Item' },
      { timestamp: expiredTimestamp },
    );
    const expiredQueryKey = listQueryScope.listQuery.seedQuery(
      expiredQueryParams,
      [expiredItem.itemKey],
      { timestamp: expiredTimestamp },
    );

    const freshItem = listQueryScope.listQuery.seedItem('fresh-users', 2, {
      id: 2,
      name: 'Fresh Item',
    });
    const freshQueryKey = listQueryScope.listQuery.seedQuery(freshQueryParams, [
      freshItem.itemKey,
    ]);

    // Startup should only queue the background scan.
    const startupOperationCapture = startPersistentStorageOperationCapture();
    createListQueryEnv({ storeName, sessionKey });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the scan runs, capture the complete query and item cleanup sequence.
    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      expiredItemExists: localStorage.getItem(expiredItem.storageKey) !== null,
      expiredQueryExists: localStorage.getItem(expiredQueryKey) !== null,
      freshItemExists: localStorage.getItem(freshItem.storageKey) !== null,
      freshQueryExists: localStorage.getItem(freshQueryKey) !== null,
    }).toMatchInlineSnapshot(`
      expiredItemExists: '❌'
      expiredQueryExists: '❌'
      freshItemExists: '✅'
      freshQueryExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      2s   | 📖 #1 ❌ tsdf._m.g (global maintenance)
      .    | 🔑[0] #2 ✅ tsdf.sess1.list-query-expiration.li."expired-users||1
           |    └ (item data, <"expired-users||1>)
      .    | 🔑[1] #3 ✅ tsdf._m.r.n:sess1.list-query-expiration.li.m
           |    └ (items index)
      .    | 🔑[2] #4 ✅ tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"}
           |    └ (query data, <{tableId:"expired-users"}>)
      .    | 🔑[3] #5 ✅ tsdf.sess1.list-query-expiration.li."fresh-users||2
           |    └ (item data, <"fresh-users||2>)
      .    | 🔑[4] #6 ✅ tsdf.sess1.list-query-expiration.lq.{tableId:"fresh-users"}
           |    └ (query data, <{tableId:"fresh-users"}>)
      .    | 📖 #3 ✅ tsdf._m.r.n:sess1.list-query-expiration.li.m
           |    └ (items index) | 0.27 kb
      .    | 📖 #4 ✅ tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"}
           |    └ (query data, <{tableId:"expired-users"}>) | 0.15 kb
      .    | 📖 #6 ✅ tsdf.sess1.list-query-expiration.lq.{tableId:"fresh-users"}
           |    └ (query data, <{tableId:"fresh-users"}>) | 0.14 kb
      .    | 🗑️ #2 ✅->❌ tsdf.sess1.list-query-expiration.li."expired-users||1
           |    └ (item data, <"expired-users||1>)
      .    | 🗑️ #4 ✅->❌ tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"}
           |    └ (query data, <{tableId:"expired-users"}>)
      .    | ✍️ #1 ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.04 kb
      .    | ✍️ #3 ✅->✅ tsdf._m.r.n:sess1.list-query-expiration.li.m
           |    └ (items index) | 0.27 kb -> 0.14 kb
      "
    `);

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.64 kb)
      ├ _m (0.25 kb)
      │ ├ g (0.04 kb)
      │ └ r.n:sess1.list-query-expiration.li.m (0.20 kb)
      └ sess1.list-query-expiration (0.38 kb)
        ├ li."fresh-users||2 (0.14 kb)
        └ lq.{tableId:"fresh-users"} (0.19 kb)"
    `);

    expect(
      getParsedLocalStorageValue(
        'tsdf._m.r.n:sess1.list-query-expiration.li.m',
      ),
    ).toMatchInlineSnapshot(`
      e:
        - a: 1735689600000
          k: '"fresh-users||2'
          p: 'fresh-users||2'
    `);

    expect(
      getParsedLocalStorageValue(
        'tsdf.sess1.list-query-expiration.li."fresh-users||2',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 2, name: 'Fresh Item' }
      p: 'fresh-users||2'
    `);

    expect(
      getParsedLocalStorageValue(
        'tsdf.sess1.list-query-expiration.lq.{tableId:"fresh-users"}',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689600000
      i: ['"fresh-users||2']
      p: { tableId: 'fresh-users' }
    `);
  });

  test('startup cleanup enforces maxQueries against preloaded persisted entries', async () => {
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const storeName = 'lq-startup-max-queries';
    const sessionKey = 'sess1';

    // Seed an over-limit query cache so startup maintenance has to trim it.
    setCachedQuery(storeName, sessionKey, firstQuery, []);
    await advanceTime(100);
    setCachedQuery(storeName, sessionKey, secondQuery, []);
    await advanceTime(100);
    setCachedQuery(storeName, sessionKey, thirdQuery, []);

    // Startup should only schedule the cleanup work.
    const startupOperationCapture = startPersistentStorageOperationCapture();
    createListQueryEnv({ storeName, sessionKey, maxQueries: 2 });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the startup pass runs, it should evict only the oldest persisted query.
    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.lq.`).sort(),
    ).toMatchInlineSnapshot(`['{tableId:"second"}', '{tableId:"third"}']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      2s   | 📖 #1 ❌ tsdf._m.g (global maintenance)
      .    | 🔑[0] #2 ✅ tsdf.sess1.lq-startup-max-queries.lq.{tableId:"first"}
           |    └ (query data, <{tableId:"first"}>)
      .    | 🔑[1] #3 ✅ tsdf.sess1.lq-startup-max-queries.lq.{tableId:"second"}
           |    └ (query data, <{tableId:"second"}>)
      .    | 🔑[2] #4 ✅ tsdf.sess1.lq-startup-max-queries.lq.{tableId:"third"}
           |    └ (query data, <{tableId:"third"}>)
      .    | 📖 #2 ✅ tsdf.sess1.lq-startup-max-queries.lq.{tableId:"first"}
           |    └ (query data, <{tableId:"first"}>) | 0.10 kb
      .    | 📖 #3 ✅ tsdf.sess1.lq-startup-max-queries.lq.{tableId:"second"}
           |    └ (query data, <{tableId:"second"}>) | 0.10 kb
      .    | 📖 #4 ✅ tsdf.sess1.lq-startup-max-queries.lq.{tableId:"third"}
           |    └ (query data, <{tableId:"third"}>) | 0.10 kb
      .    | 🗑️ #2 ✅->❌ tsdf.sess1.lq-startup-max-queries.lq.{tableId:"first"}
           |    └ (query data, <{tableId:"first"}>)
      .    | 📖 #5 ❌ tsdf._m.r.n:sess1.lq-startup-max-queries.li.m (items index)
      .    | ✍️ #1 ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.04 kb
      "
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.sess1.lq-startup-max-queries.lq.{tableId:"third"}',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689600200
      i: []
      p: { tableId: 'third' }
    `);
  });

  test('when maxQueries limit is reached a full store cleanup occurs', async () => {
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const storeName = 'lq-query-metadata';
    const sessionKey = 'sess1';

    setCachedQuery(storeName, sessionKey, firstQuery, []);
    await advanceTime(100);
    setCachedQuery(storeName, sessionKey, secondQuery, []);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      maxQueries: 2,
      serverData: { third: [{ id: 1, name: 'Third' }] },
    });

    // Drain the startup-scheduled global scan before capturing the query fetch/eviction flow.
    await settleStartupBackgroundScan();

    // Fetching a third query should show the write path plus the idle-scheduled query eviction path.
    const readCapture = startPersistentStorageOperationCapture();
    env.scheduleFetch('highPriority', thirdQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.lq.`),
    ).toMatchInlineSnapshot(`['{tableId:"second"}', '{tableId:"third"}']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | 📖 #1 ❌ tsdf._m.r.n:sess1.lq-query-metadata.li.m (items index)
      .     | 📖 #2 ❌ tsdf.sess1.lq-query-metadata.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>)
      .     | ✍️ #2 ❌->✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>) | ❌ -> 0.12 kb
      .     | 📖 #1 ❌ tsdf._m.r.n:sess1.lq-query-metadata.li.m (items index)
      .     | ✍️ #3 ❌->✅ tsdf.sess1.lq-query-metadata.li."third||1
            |    └ (item data, <"third||1>) | ❌ -> 0.09 kb
      .     | ✍️ #1 ❌->✅ tsdf._m.r.n:sess1.lq-query-metadata.li.m
            |    └ (items index) | ❌ -> 0.12 kb
            ·
      3.81s | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-query-metadata.li.m
            |    └ (items index) | 0.12 kb
      .     | 🔑[0] #4 ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"first"}
            |    └ (query data, <{tableId:"first"}>)
      .     | 🔑[1] #5 ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"second"}
            |    └ (query data, <{tableId:"second"}>)
      .     | 🔑[2] #6 ✅ tsdf._m.g (global maintenance)
      .     | 🔑[3] #2 ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>)
      .     | 🔑[4] #3 ✅ tsdf.sess1.lq-query-metadata.li."third||1
            |    └ (item data, <"third||1>)
      .     | 🔑[5] #1 ✅ tsdf._m.r.n:sess1.lq-query-metadata.li.m (items index)
      .     | 📖 #4 ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"first"}
            |    └ (query data, <{tableId:"first"}>) | 0.10 kb
      .     | 📖 #5 ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"second"}
            |    └ (query data, <{tableId:"second"}>) | 0.10 kb
      .     | 📖 #2 ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>) | 0.12 kb
      .     | 🗑️ #4 ✅->❌ tsdf.sess1.lq-query-metadata.lq.{tableId:"first"}
            |    └ (query data, <{tableId:"first"}>)
      "
    `);

    expect(
      getParsedLocalStorageValue('tsdf._m.r.n:sess1.lq-query-metadata.li.m'),
    ).toMatchInlineSnapshot(`
      e:
        - a: 1735689604010
          k: '"third||1'
          p: 'third||1'
    `);
    expect(
      getParsedLocalStorageValue('tsdf.sess1.lq-query-metadata.li."third||1'),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Third' }
      p: 'third||1'
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.sess1.lq-query-metadata.lq.{tableId:"third"}',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689604010
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

    setCachedQuery(storeName, sessionKey, firstQuery, []);
    await advanceTime(100);
    setCachedQuery(storeName, sessionKey, secondQuery, []);

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
    await settleStartupBackgroundScan();

    const readCapture = startPersistentStorageOperationCapture();

    // The third query persists and schedules idle maintenance.
    env.scheduleFetch('highPriority', thirdQuery);
    await advanceTime(810);
    await advanceTime(1000);

    // The fourth query persists before that idle callback fires, so cleanup should still run once.
    env.scheduleFetch('highPriority', fourthQuery);
    await advanceTime(810);
    await advanceTime(1000);

    // Advance only to the first scheduled idle cleanup boundary.
    await advanceTime(200);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.lq.`).sort(),
    ).toMatchInlineSnapshot(`['{tableId:"fourth"}', '{tableId:"third"}']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | 📖 #1 ❌ tsdf._m.r.n:sess1.lq-coalesced-query-maintenance.li.m
            |    └ (items index)
      .     | 📖 #2 ❌ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>)
      .     | ✍️ #2 ❌->✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>) | ❌ -> 0.12 kb
      .     | 📖 #1 ❌ tsdf._m.r.n:sess1.lq-coalesced-query-maintenance.li.m
            |    └ (items index)
      .     | ✍️ #3 ❌->✅ tsdf.sess1.lq-coalesced-query-maintenance.li."third||1
            |    └ (item data, <"third||1>) | ❌ -> 0.09 kb
      .     | ✍️ #1 ❌->✅ tsdf._m.r.n:sess1.lq-coalesced-query-maintenance.li.m
            |    └ (items index) | ❌ -> 0.12 kb
            ·
      3.62s | 📖 #4 ❌ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"}
            |    └ (query data, <{tableId:"fourth"}>)
      .     | ✍️ #4 ❌->✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"}
            |    └ (query data, <{tableId:"fourth"}>) | ❌ -> 0.13 kb
      .     | ✍️ #3 ✅->✅ tsdf.sess1.lq-coalesced-query-maintenance.li."third||1
            |    └ (item data, <"third||1>) | 0.09 kb -> 0.15 kb
      .     | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-coalesced-query-maintenance.li.m
            |    └ (items index) | 0.12 kb
      .     | ✍️ #5 ❌->✅ tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2
            |    └ (item data, <"fourth||2>) | ❌ -> 0.09 kb
      .     | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.lq-coalesced-query-maintenance.li.m
            |    └ (items index) | 0.12 kb -> 0.28 kb
            ·
      3.81s | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-coalesced-query-maintenance.li.m
            |    └ (items index) | 0.28 kb
      .     | 🔑[0] #6 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"}
            |    └ (query data, <{tableId:"first"}>)
      .     | 🔑[1] #7 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"}
            |    └ (query data, <{tableId:"second"}>)
      .     | 🔑[2] #8 ✅ tsdf._m.g (global maintenance)
      .     | 🔑[3] #2 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>)
      .     | 🔑[4] #3 ✅ tsdf.sess1.lq-coalesced-query-maintenance.li."third||1
            |    └ (item data, <"third||1>)
      .     | 🔑[5] #1 ✅ tsdf._m.r.n:sess1.lq-coalesced-query-maintenance.li.m
            |    └ (items index)
      .     | 🔑[6] #4 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"}
            |    └ (query data, <{tableId:"fourth"}>)
      .     | 🔑[7] #5 ✅ tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2
            |    └ (item data, <"fourth||2>)
      .     | 📖 #6 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"}
            |    └ (query data, <{tableId:"first"}>) | 0.10 kb
      .     | 📖 #7 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"}
            |    └ (query data, <{tableId:"second"}>) | 0.10 kb
      .     | 📖 #2 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>) | 0.12 kb
      .     | 📖 #4 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"}
            |    └ (query data, <{tableId:"fourth"}>) | 0.13 kb
      .     | 🗑️ #7 ✅->❌ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"}
            |    └ (query data, <{tableId:"second"}>)
      .     | 🗑️ #6 ✅->❌ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"}
            |    └ (query data, <{tableId:"first"}>)
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
    const itemManifestKey = localPersistentStorage.getManifestKeyForPrefix(
      `tsdf.${sessionKey}.${storeName}.li.`,
    );
    const queryManifestKey = localPersistentStorage.getManifestKeyForPrefix(
      `tsdf.${sessionKey}.${storeName}.lq.`,
    );

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Existing user' }] },
    });

    await settleStartupBackgroundScan();

    const readCapture = startPersistentStorageOperationCapture();
    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(getParsedLocalStorageValue(itemManifestKey)).toMatchInlineSnapshot(
      `null`,
    );
    expect(getParsedLocalStorageValue(queryManifestKey)).toMatchInlineSnapshot(
      `null`,
    );
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | 📖 #1 ❌ tsdf._m.r.n:sess1.lq-empty-query-manifest.li.m (items index)
      .     | 📖 #2 ❌ tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}
            |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}>)
      .     | ✍️ #2 ❌->✅ tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}
            |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}>) | ❌ -> 0.22 kb
      "
    `);
  });

  test('query that becomes empty after invalidation do not clean up orphaned items from persistence', async () => {
    const storeName = 'lq-query-becomes-empty';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const itemManifestKey = localPersistentStorage.getManifestKeyForPrefix(
      `tsdf.${sessionKey}.${storeName}.li.`,
    );

    // Seed the cache with a query that has one item.
    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Cached user' }] },
    });

    // Hydrate cached data first without a mount refetch so the invalidation path stays isolated.
    await settleStartupBackgroundScan();
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
    const invalidationCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: usersQuery,
        itemPayload: false,
      });
    });
    await flushInvalidationPersistence();
    const invalidationOperations = invalidationCapture.finish().timelineString;

    // The query should now have no items.
    expect(hook.result.current.items).toMatchInlineSnapshot(`[]`);

    // The persisted query should reflect the empty items list.
    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readQueryEntry(usersQuery).data,
    ).toMatchInlineSnapshot(`
      hasMore: '❌'
      items: []
      payload: { tableId: 'users' }
    `);

    // The item manifest should still exist (items aren't proactively deleted on query update),
    // but the query manifest should show the query with an empty items list.
    expect(getParsedLocalStorageValue(itemManifestKey)).toMatchInlineSnapshot(
      `
        e:
          - a: 1735689605910
            f: ['age', 'email', 'id', 'name']
            k: '"users||1'
            p: 'users||1'
      `,
    );
    expect(
      getParsedLocalStorageValue(
        'tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"}',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689605910
      i: []
      p: { tableId: 'users' }
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.sess1.lq-query-becomes-empty.li."users||1',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Cached user' }
      lf: ['age', 'email', 'id', 'name']
      p: 'users||1'
    `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-query-becomes-empty.li.m
            |    └ (items index) | 0.12 kb
      .     | 📖 #2 ✅ tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"}
            |    └ (query data, <{tableId:"users"}>) | 0.12 kb
      .     | ✍️ #2 ✅->✅ tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"}
            |    └ (query data, <{tableId:"users"}>) | 0.12 kb -> 0.10 kb
      .     | ✍️ #3 ✅->✅ tsdf.sess1.lq-query-becomes-empty.li."users||1
            |    └ (item data, <"users||1>) | 0.10 kb -> 0.16 kb
      .     | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-query-becomes-empty.li.m
            |    └ (items index) | 0.12 kb ⚠️ REPEATED READ <10ms UNCHANGED
      .     | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.lq-query-becomes-empty.li.m
            |    └ (items index) | 0.12 kb -> 0.18 kb
      "
    `);
  });

  test('when maxItems limit is reached cleanup evicts the oldest unprotected item and rewrites the query', async () => {
    const storeName = 'lq-item-metadata';
    const sessionKey = 'sess1';

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Oldest cached',
    });
    await advanceTime(100);
    setCachedItem(storeName, sessionKey, 'users', 2, {
      id: 2,
      name: 'Newer cached',
    });
    setCachedQuery(storeName, sessionKey, { tableId: 'users' }, [
      storeItemKey('users', 1),
      storeItemKey('users', 2),
    ]);

    const env = createListQueryEnv({ storeName, sessionKey, maxItems: 2 });

    // Drain the startup-scheduled global scan before capturing the maxItems flush.
    await settleStartupBackgroundScan();

    // Adding a third item should snapshot the write plus idle-scheduled eviction sequence end-to-end.
    const readCapture = startPersistentStorageOperationCapture();
    env.apiStore.addItemToState(rawItemPayload('users', 3), {
      id: 3,
      name: 'Fresh',
    });
    await advanceTime(1100);
    await flushAllTimers();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`),
    ).toMatchInlineSnapshot(`['"users||2', '"users||3']`);
    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readQueryEntry({ tableId: 'users' }).data,
    ).toMatchInlineSnapshot(`
      hasMore: '❌'
      items: ['"users||2']
      payload: { tableId: 'users' }
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      1s   | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m
           |    └ (items index) | 0.22 kb
      .    | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m
           |    └ (items index) | 0.22 kb ⚠️ REPEATED READ <10ms UNCHANGED
      .    | ✍️ #2 ❌->✅ tsdf.sess1.lq-item-metadata.li."users||3
           |    └ (item data, <"users||3>) | ❌ -> 0.09 kb
      .    | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m
           |    └ (items index) | 0.22 kb ⚠️ REPEATED READ <10ms UNCHANGED
      .    | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m
           |    └ (items index) | 0.22 kb -> 0.32 kb
           ·
      3s   | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m
           |    └ (items index) | 0.32 kb
      .    | 🔑[0] #3 ✅ tsdf.sess1.lq-item-metadata.li."users||1
           |    └ (item data, <"users||1>)
      .    | 🔑[1] #1 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (items index)
      .    | 🔑[2] #4 ✅ tsdf.sess1.lq-item-metadata.li."users||2
           |    └ (item data, <"users||2>)
      .    | 🔑[3] #5 ✅ tsdf.sess1.lq-item-metadata.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>)
      .    | 🔑[4] #6 ✅ tsdf._m.g (global maintenance)
      .    | 🔑[5] #2 ✅ tsdf.sess1.lq-item-metadata.li."users||3
           |    └ (item data, <"users||3>)
      .    | 📖 #5 ✅ tsdf.sess1.lq-item-metadata.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.15 kb
      .    | 🗑️ #3 ✅->❌ tsdf.sess1.lq-item-metadata.li."users||1
           |    └ (item data, <"users||1>)
      .    | ✍️ #5 ✅->✅ tsdf.sess1.lq-item-metadata.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.15 kb -> 0.12 kb
      .    | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m
           |    └ (items index) | 0.32 kb -> 0.22 kb
      "
    `);
  });

  test('maxItems cleanup falls back to protected pinned and recency for preloaded query items and rewrites affected queries', async () => {
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

    // Seed two persisted queries that both reference the same oldest item.
    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Shared oldest',
    });
    await advanceTime(100);
    setCachedItem(storeName, sessionKey, 'users', 2, {
      id: 2,
      name: 'Alice only',
    });
    await advanceTime(100);
    setCachedItem(storeName, sessionKey, 'users', 3, {
      id: 3,
      name: 'Bob only',
    });
    await advanceTime(100);
    setCachedItem(storeName, sessionKey, 'users', 4, {
      id: 4,
      name: 'Standalone newest',
    });
    setCachedQuery(storeName, sessionKey, firstUsersQuery, [
      sharedItemKey,
      aliceOnlyItemKey,
    ]);
    setCachedQuery(storeName, sessionKey, secondUsersQuery, [
      sharedItemKey,
      bobOnlyItemKey,
    ]);

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`).sort(),
    ).toMatchInlineSnapshot(
      `['"users||1', '"users||2', '"users||3', '"users||4']`,
    );

    createListQueryEnv({ storeName, sessionKey, maxItems: 3 });

    // Let the startup-scheduled maintenance enforce maxItems against the preloaded cache.
    const cleanupCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const cleanupOperations = cleanupCapture.finish().timelineString;

    // The oldest item should be evicted by recency, and both query entries
    // should be rewritten to drop it.
    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`).sort(),
    ).toMatchInlineSnapshot(`['"users||2', '"users||3', '"users||4']`);
    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readQueryEntry(firstUsersQuery).data,
    ).toMatchInlineSnapshot(`
      hasMore: '❌'
      items: ['"users||2']

      payload:
        filters:
          - { field: 'name', op: 'eq', value: 'Alice' }
        tableId: 'users'
    `);
    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readQueryEntry(secondUsersQuery).data,
    ).toMatchInlineSnapshot(`
      hasMore: '❌'
      items: ['"users||3']

      payload:
        filters:
          - { field: 'name', op: 'eq', value: 'Bob' }
        tableId: 'users'
    `);
    expect(cleanupOperations).toMatchInlineSnapshot(`
      "
      time |
      2s   | 📖 #1 ❌ tsdf._m.g (global maintenance)
      .    | 🔑[0] #2 ✅ tsdf.sess1.lq-shared-item-cleanup.li."users||1
           |    └ (item data, <"users||1>)
      .    | 🔑[1] #3 ✅ tsdf._m.r.n:sess1.lq-shared-item-cleanup.li.m
           |    └ (items index)
      .    | 🔑[2] #4 ✅ tsdf.sess1.lq-shared-item-cleanup.li."users||2
           |    └ (item data, <"users||2>)
      .    | 🔑[3] #5 ✅ tsdf.sess1.lq-shared-item-cleanup.li."users||3
           |    └ (item data, <"users||3>)
      .    | 🔑[4] #6 ✅ tsdf.sess1.lq-shared-item-cleanup.li."users||4
           |    └ (item data, <"users||4>)
      .    | 🔑[5] #7 ✅ tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}
           |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>)
      .    | 🔑[6] #8 ✅ tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}
           |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}>)
      .    | 📖 #3 ✅ tsdf._m.r.n:sess1.lq-shared-item-cleanup.li.m
           |    └ (items index) | 0.42 kb
      .    | 📖 #7 ✅ tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}
           |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>) | 0.25 kb
      .    | 📖 #8 ✅ tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}
           |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}>) | 0.25 kb
      .    | 🗑️ #2 ✅->❌ tsdf.sess1.lq-shared-item-cleanup.li."users||1
           |    └ (item data, <"users||1>)
      .    | ✍️ #7 ✅->✅ tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}
           |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>) | 0.25 kb -> 0.23 kb
      .    | ✍️ #8 ✅->✅ tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}
           |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}>) | 0.25 kb -> 0.22 kb
      .    | ✍️ #1 ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.04 kb
      .    | ✍️ #3 ✅->✅ tsdf._m.r.n:sess1.lq-shared-item-cleanup.li.m
           |    └ (items index) | 0.42 kb -> 0.32 kb
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
    const listQueryScope = persistentStore.scope(storeName, sessionKey);
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
    const deleteCapture = startPersistentStorageOperationCapture();
    env.apiStore.deleteItemState('users||1');
    await advanceTime(1100);
    await flushAllTimers();
    const deleteOperations = deleteCapture.finish().timelineString;

    expect(localStorage.getItem(deletedItemStorageKey)).toBeNull();
    expect(listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`))
      .toMatchInlineSnapshot(`
        ['"users||2']
      `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.sess1.lq-delete-flow.lq.{tableId:"users"}',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689604100
      i: ['"users||2']
      p: { tableId: 'users' }
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689604100
      i: []

      p:
        filters:
          - { field: 'name', op: 'eq', value: 'Alice' }
        tableId: 'users'
    `);
    expect(deleteOperations).toMatchInlineSnapshot(`
      "
      time |
      1s   | 📖 #1 ✅ tsdf.sess1.lq-delete-flow.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.15 kb
      .    | ✍️ #1 ✅->✅ tsdf.sess1.lq-delete-flow.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.15 kb -> 0.12 kb
      .    | 📖 #2 ✅ tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}
           |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>) | 0.23 kb
      .    | ✍️ #2 ✅->✅ tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}
           |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>) | 0.23 kb -> 0.21 kb
      .    | 🗑️ #3 ✅->❌ tsdf.sess1.lq-delete-flow.li."users||1
           |    └ (item data, <"users||1>)
      .    | 📖 #4 ✅ tsdf._m.r.n:sess1.lq-delete-flow.li.m
           |    └ (items index) | 0.22 kb
      .    | ✍️ #5 ✅->✅ tsdf.sess1.lq-delete-flow.li."users||2
           |    └ (item data, <"users||2>) | 0.08 kb -> 0.15 kb
      .    | ✍️ #4 ✅->✅ tsdf._m.r.n:sess1.lq-delete-flow.li.m
           |    └ (items index) | 0.22 kb -> 0.18 kb
      "
    `);
  });

  test('direct getQueryState reads the cached list query multiple times with short gaps and keeps it in memory', async () => {
    const storeName = 'lq-direct-get-query-state';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so this capture only measures the direct read-through path.
    await settleStartupBackgroundScan();

    // Repeated direct reads with short gaps should hydrate from storage once, then reuse in-memory query and item state.
    const readCapture = startPersistentStorageOperationCapture();
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
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(env.store.state.queries[getCompositeKey(usersQuery)])
      .toMatchInlineSnapshot(`
        error: null
        hasMore: '❌'
        items: ['"users||1']
        payload: { tableId: 'users' }
        refetchOnMount: 'lowPriority'
        status: 'success'
        wasLoaded: '✅'
      `);
    expect(env.store.state.items[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached user'
      `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 ✅ tsdf.sess1.lq-direct-get-query-state.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.12 kb
      .    | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-direct-get-query-state.li.m
           |    └ (items index) | 0.12 kb
      .    | 📖 #3 ✅ tsdf.sess1.lq-direct-get-query-state.li."users||1
           |    └ (item data, <"users||1>) | 0.10 kb
           ·
      2s   | 📖 #1 ✅ tsdf.sess1.lq-direct-get-query-state.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.12 kb
      .    | ✍️ #1 ✅->✅ tsdf.sess1.lq-direct-get-query-state.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.12 kb -> 0.12 kb
      .    | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-direct-get-query-state.li.m
           |    └ (items index) | 0.12 kb
      .    | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.lq-direct-get-query-state.li.m
           |    └ (items index) | 0.12 kb -> 0.12 kb
      "
    `);
  });

  test('direct getQueryState touch preserves offline markers added by another tab before item and query manifest updates', async () => {
    const storeName = 'lq-direct-touch-offline-marker';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const listQueryScope = persistentStore.scope(storeName, sessionKey);
    const itemStorageKey = listQueryScope.listQuery.itemStorageKey('users', 1);
    const queryStorageKey =
      listQueryScope.listQuery.queryStorageKey(usersQuery);
    const itemManifestKey = localPersistentStorage.getManifestKeyForPrefix(
      `tsdf.${sessionKey}.${storeName}.li.`,
    );

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the later touches only come from the direct read path.
    await settleStartupBackgroundScan();

    // Reading the query schedules timestamp touches for both the query and its hydrated item.
    expect(env.apiStore.getQueryState(usersQuery)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1']
      payload: { tableId: 'users' }
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);

    // Simulate another tab marking the existing item manifest and query entry as offline-protected.
    const currentItemManifest = getParsedLocalStorageValue<{
      e: Array<Record<string, unknown>>;
      v: number;
    }>(itemManifestKey);
    const currentQueryEntry =
      getParsedLocalStorageValue<Record<string, unknown>>(queryStorageKey);

    localStorage.setItem(
      itemManifestKey,
      JSON.stringify({
        ...currentItemManifest,
        e: currentItemManifest?.e.map((entry) => ({ ...entry, o: true })),
      }),
    );
    localStorage.setItem(
      queryStorageKey,
      JSON.stringify({ ...currentQueryEntry, o: true }),
    );

    await flushAllTimers();

    expect(
      localPersistentStorage.readNamespaceEntryMetadataByPayload(
        itemStorageKey,
        `tsdf.${sessionKey}.${storeName}.li.`,
      )?.meta,
    ).toMatchInlineSnapshot(`
      o: '✅'
      p: 'users||1'
    `);
    expect(getParsedLocalStorageValue(itemManifestKey)).toMatchInlineSnapshot(`
      e:
        - a: 1735689604100
          k: '"users||1'
          o: '✅'
          p: 'users||1'
    `);
    expect(getParsedLocalStorageValue(queryStorageKey)).toMatchInlineSnapshot(`
      a: 1735689604100
      i: ['"users||1']
      o: '✅'
      p: { tableId: 'users' }
    `);
  });

  test('useListQuery invalidation snapshots the full query persistence timeline through the refetch save', async () => {
    const storeName = 'lq-query-invalidation-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Fresh user' }] },
    });

    // Hydrate cached data first without a mount refetch so the invalidation path stays isolated.
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Update the server copy, invalidate the mounted query, then capture fetch completion plus the debounced save.
    const invalidationCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.serverTable.updateItem('users||1', { name: 'Fresh user' });
      env.apiStore.invalidateQueryAndItems({
        queryPayload: usersQuery,
        itemPayload: false,
      });
    });
    await flushInvalidationPersistence();
    const invalidationOperations = invalidationCapture.finish().timelineString;

    expect(hook.result.current.items).toMatchInlineSnapshot(`
      - { id: 1, name: 'Fresh user' }
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.sess1.lq-query-invalidation-flow.lq.{tableId:"users"}',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689604100
      i: ['"users||1']
      p: { tableId: 'users' }
    `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-query-invalidation-flow.li.m
            |    └ (items index) | 0.12 kb
      .     | ✍️ #2 ✅->✅ tsdf.sess1.lq-query-invalidation-flow.li."users||1
            |    └ (item data, <"users||1>) | 0.10 kb -> 0.16 kb
      .     | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-query-invalidation-flow.li.m
            |    └ (items index) | 0.12 kb ⚠️ REPEATED READ <10ms UNCHANGED
      .     | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.lq-query-invalidation-flow.li.m
            |    └ (items index) | 0.12 kb -> 0.18 kb
      "
    `);
  });

  test('repeated invalidations within the debounce window coalesce list-query persistence writes', async () => {
    const storeName = 'lq-coalesced-invalidations';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Fresh user 1' }] },
    });

    // Hydrate cached data first so only the invalidation writes are counted below.
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Let the first refetch finish, but stay inside the debounced persistence window.
    const firstInvalidationCapture = startPersistentStorageOperationCapture();
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

    expect(hook.result.current.items).toMatchInlineSnapshot(`
      - { id: 1, name: 'Fresh user 1' }
    `);
    expect(firstInvalidationOperations).toMatchInlineSnapshot(`"empty"`);

    // A second invalidation before the first debounce flush should replace the pending save.
    const secondInvalidationCapture = startPersistentStorageOperationCapture();
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

    expect(hook.result.current.items).toMatchInlineSnapshot(`
      - { id: 1, name: 'Fresh user 2' }
    `);
    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readItemData('users', 1),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Fresh user 2'
    `);
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-coalesced-invalidations.li.m
            |    └ (items index) | 0.12 kb
      .     | ✍️ #2 ✅->✅ tsdf.sess1.lq-coalesced-invalidations.li."users||1
            |    └ (item data, <"users||1>) | 0.10 kb -> 0.16 kb
      .     | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-coalesced-invalidations.li.m
            |    └ (items index) | 0.12 kb ⚠️ REPEATED READ <10ms UNCHANGED
      .     | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.lq-coalesced-invalidations.li.m
            |    └ (items index) | 0.12 kb -> 0.18 kb
      "
    `);
  });

  test('list-query invalidation preserves offline markers added by another tab before item and query manifest updates', async () => {
    const storeName = 'lq-offline-marker-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const listQueryScope = persistentStore.scope(storeName, sessionKey);
    const itemStorageKey = listQueryScope.listQuery.itemStorageKey('users', 1);
    const queryStorageKey =
      listQueryScope.listQuery.queryStorageKey(usersQuery);
    const itemManifestKey = localPersistentStorage.getManifestKeyForPrefix(
      `tsdf.${sessionKey}.${storeName}.li.`,
    );

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(storeName, sessionKey, usersQuery, [
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
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Simulate another tab marking the existing item manifest and query entry as offline-protected.
    const currentItemManifest = getParsedLocalStorageValue<{
      e: Array<Record<string, unknown>>;
      v: number;
    }>(itemManifestKey);
    const currentQueryEntry =
      getParsedLocalStorageValue<Record<string, unknown>>(queryStorageKey);

    localStorage.setItem(
      itemManifestKey,
      JSON.stringify({
        ...currentItemManifest,
        e: currentItemManifest?.e.map((entry) => ({ ...entry, o: true })),
      }),
    );
    localStorage.setItem(
      queryStorageKey,
      JSON.stringify({ ...currentQueryEntry, o: true }),
    );

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
      localPersistentStorage.readNamespaceEntryMetadataByPayload(
        itemStorageKey,
        `tsdf.${sessionKey}.${storeName}.li.`,
      )?.meta,
    ).toMatchInlineSnapshot(`
      f: ['age', 'email', 'id', 'name']
      o: '✅'
      p: 'users||1'
    `);
    expect(getParsedLocalStorageValue(itemManifestKey)).toMatchInlineSnapshot(`
      e:
        - a: 1735689605910
          f: ['age', 'email', 'id', 'name']
          k: '"users||1'
          o: '✅'
          p: 'users||1'
        - a: 1735689605910
          k: '"users||2'
          p: 'users||2'
    `);
    expect(getParsedLocalStorageValue(queryStorageKey)).toMatchInlineSnapshot(`
      a: 1735689605910
      i: ['"users||1', '"users||2']
      o: '✅'
      p: { tableId: 'users' }
    `);
  });

  test('query hook remount reuses hydrated list-query state without touching localStorage again', async () => {
    const storeName = 'lq-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted query flow.
    await settleStartupBackgroundScan();

    // The first mount hydrates the cold query and its item from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useListQuery(usersQuery, {
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        }),
      );

    expect(secondHook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Cached user' }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 ✅ tsdf.sess1.lq-remount-flow.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.12 kb
      .    | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-remount-flow.li.m
           |    └ (items index) | 0.12 kb
      .    | 📖 #3 ✅ tsdf.sess1.lq-remount-flow.li."users||1
           |    └ (item data, <"users||1>) | 0.10 kb
           ·
      2s   | 📖 #1 ✅ tsdf.sess1.lq-remount-flow.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.12 kb
      .    | ✍️ #1 ✅->✅ tsdf.sess1.lq-remount-flow.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.12 kb -> 0.12 kb
      .    | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-remount-flow.li.m
           |    └ (items index) | 0.12 kb
      .    | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.lq-remount-flow.li.m
           |    └ (items index) | 0.12 kb -> 0.12 kb
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('query hook remount reuses a persisted empty query without treating it as a cache miss', async () => {
    const storeName = 'lq-empty-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };

    // Persist an explicit empty query so this is an empty-cache remount, not a
    // missing-cache remount.
    setCachedQuery(storeName, sessionKey, usersQuery, []);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted query flow.
    await settleStartupBackgroundScan();

    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useListQuery(usersQuery, {
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        }),
      );

    expect(secondHook.result.current.items).toMatchInlineSnapshot(`[]`);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 ✅ tsdf.sess1.lq-empty-remount-flow.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.10 kb
           ·
      2s   | 📖 #1 ✅ tsdf.sess1.lq-empty-remount-flow.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.10 kb
      .    | ✍️ #1 ✅->✅ tsdf.sess1.lq-empty-remount-flow.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.10 kb -> 0.10 kb
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('query hook cache miss writes the fetched query once and remount stays fully in memory', async () => {
    const storeName = 'lq-query-remount-no-cache';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Fetched user' }] },
    });

    // Drain the startup scan so the capture focuses on the mounted query flow.
    await settleStartupBackgroundScan();

    // With no persisted query, the first mount should pay the cache miss once,
    // then keep the fetched result in memory for the remount.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useListQuery(usersQuery, {
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        }),
      );

    expect(secondHook.result.current.items).toMatchInlineSnapshot(`
      - { id: 1, name: 'Fetched user' }
    `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time  |
      0     | 📖 #1 ❌ tsdf.sess1.lq-query-remount-no-cache.lq.{tableId:"users"}
            |    └ (query data, <{tableId:"users"}>)
      .     | 📖 #1 ❌ tsdf.sess1.lq-query-remount-no-cache.lq.{tableId:"users"}
            |    └ (query data, <{tableId:"users"}>)
      .     | 📖 #1 ❌ tsdf.sess1.lq-query-remount-no-cache.lq.{tableId:"users"}
            |    └ (query data, <{tableId:"users"}>)
            ·
      1.81s | 📖 #2 ❌ tsdf._m.r.n:sess1.lq-query-remount-no-cache.li.m
            |    └ (items index)
      .     | 📖 #1 ❌ tsdf.sess1.lq-query-remount-no-cache.lq.{tableId:"users"}
            |    └ (query data, <{tableId:"users"}>)
      .     | ✍️ #1 ❌->✅ tsdf.sess1.lq-query-remount-no-cache.lq.{tableId:"users"}
            |    └ (query data, <{tableId:"users"}>) | ❌ -> 0.12 kb
      .     | 📖 #2 ❌ tsdf._m.r.n:sess1.lq-query-remount-no-cache.li.m
            |    └ (items index)
      .     | ✍️ #3 ❌->✅ tsdf.sess1.lq-query-remount-no-cache.li."users||1
            |    └ (item data, <"users||1>) | ❌ -> 0.10 kb
      .     | ✍️ #2 ❌->✅ tsdf._m.r.n:sess1.lq-query-remount-no-cache.li.m
            |    └ (items index) | ❌ -> 0.12 kb
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useItem invalidation snapshots the full item persistence timeline through the refetch save', async () => {
    const storeName = 'lq-item-invalidation-flow';
    const sessionKey = 'sess1';
    const itemPayload = rawItemPayload('users', 1);

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Fresh user' }] },
    });

    // Hydrate cached data first without a mount refetch so the invalidation path stays isolated.
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useItem(itemPayload, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Update the server copy, invalidate the mounted item hook, then capture fetch completion plus the debounced save.
    const invalidationCapture = startPersistentStorageOperationCapture();
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
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readItemData('users', 1),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Fresh user'
    `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-item-invalidation-flow.li.m
            |    └ (items index) | 0.12 kb
      .     | ✍️ #2 ✅->✅ tsdf.sess1.lq-item-invalidation-flow.li."users||1
            |    └ (item data, <"users||1>) | 0.10 kb -> 0.16 kb
      .     | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-item-invalidation-flow.li.m
            |    └ (items index) | 0.12 kb ⚠️ REPEATED READ <10ms UNCHANGED
      .     | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.lq-item-invalidation-flow.li.m
            |    └ (items index) | 0.12 kb -> 0.18 kb
      "
    `);
  });

  test('item hook remount reuses hydrated standalone list-query items without touching localStorage again', async () => {
    const storeName = 'lq-item-remount-flow';
    const sessionKey = 'sess1';

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted item flow.
    await settleStartupBackgroundScan();

    // The first mount must hydrate the cold cached item from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useItem(rawItemPayload('users', 1), {
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        }),
      );

    expect(secondHook.result.current.data).toMatchInlineSnapshot(`
      id: 1
      name: 'Cached user'
    `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-item-remount-flow.li.m
           |    └ (items index) | 0.12 kb
      .    | 📖 #2 ✅ tsdf.sess1.lq-item-remount-flow.li."users||1
           |    └ (item data, <"users||1>) | 0.10 kb
           ·
      2s   | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-item-remount-flow.li.m
           |    └ (items index) | 0.12 kb
      .    | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.lq-item-remount-flow.li.m
           |    └ (items index) | 0.12 kb -> 0.12 kb
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('item hook cache miss writes the fetched item once and remount stays fully in memory', async () => {
    const storeName = 'lq-item-remount-no-cache';
    const sessionKey = 'sess1';
    const itemPayload = rawItemPayload('users', 1);

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Fetched user' }] },
    });

    // Drain the startup scan so the capture focuses on the mounted item flow.
    await settleStartupBackgroundScan();

    // With no persisted item, the first mount should pay the cache miss once,
    // then keep the fetched result in memory for the remount.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useItem(itemPayload, {
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        }),
      );

    expect(secondHook.result.current.data).toMatchInlineSnapshot(`
      id: 1
      name: 'Fetched user'
    `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time  |
      0     | 📖 #1 ❌ tsdf._m.r.n:sess1.lq-item-remount-no-cache.li.m
            |    └ (items index)
      .     | 📖 #1 ❌ tsdf._m.r.n:sess1.lq-item-remount-no-cache.li.m
            |    └ (items index)
      10ms  | 📖 #1 ❌ tsdf._m.r.n:sess1.lq-item-remount-no-cache.li.m
            |    └ (items index)
            ·
      810ms | 📖 #1 ❌ tsdf._m.r.n:sess1.lq-item-remount-no-cache.li.m
            |    └ (items index)
            ·
      1.81s | 📖 #1 ❌ tsdf._m.r.n:sess1.lq-item-remount-no-cache.li.m
            |    └ (items index)
      .     | 📖 #1 ❌ tsdf._m.r.n:sess1.lq-item-remount-no-cache.li.m
            |    └ (items index)
      .     | ✍️ #2 ❌->✅ tsdf.sess1.lq-item-remount-no-cache.li."users||1
            |    └ (item data, <"users||1>) | ❌ -> 0.10 kb
      .     | 📖 #1 ❌ tsdf._m.r.n:sess1.lq-item-remount-no-cache.li.m
            |    └ (items index)
      .     | ✍️ #1 ❌->✅ tsdf._m.r.n:sess1.lq-item-remount-no-cache.li.m
            |    └ (items index) | ❌ -> 0.12 kb
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useMultipleItems remount reuses hydrated standalone list-query items without touching localStorage again', async () => {
    const storeName = 'lq-multi-item-remount-flow';
    const sessionKey = 'sess1';

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user 1',
    });
    setCachedItem(storeName, sessionKey, 'users', 2, {
      id: 2,
      name: 'Cached user 2',
    });

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted item flow.
    await settleStartupBackgroundScan();

    // The first mount must hydrate both cold cached items from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useMultipleItems(
          [
            { payload: rawItemPayload('users', 1) },
            { payload: rawItemPayload('users', 2) },
          ],
          { disableRefetchOnMount: true, returnRefetchingStatus: true },
        ),
      );

    expect(secondHook.result.current.map((item) => item.data))
      .toMatchInlineSnapshot(`
        - { id: 1, name: 'Cached user 1' }
        - { id: 2, name: 'Cached user 2' }
      `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m
           |    └ (items index) | 0.22 kb
      .    | 📖 #2 ✅ tsdf.sess1.lq-multi-item-remount-flow.li."users||1
           |    └ (item data, <"users||1>) | 0.10 kb
      .    | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m
           |    └ (items index) | 0.22 kb ⚠️ REPEATED READ <10ms UNCHANGED
      .    | 📖 #3 ✅ tsdf.sess1.lq-multi-item-remount-flow.li."users||2
           |    └ (item data, <"users||2>) | 0.10 kb
           ·
      2s   | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m
           |    └ (items index) | 0.22 kb
      .    | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m
           |    └ (items index) | 0.22 kb -> 0.22 kb
      .    | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m
           |    └ (items index) | 0.22 kb
      .    | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m
           |    └ (items index) | 0.22 kb -> 0.22 kb
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useMultipleListQueries remount reuses hydrated queries without touching localStorage again', async () => {
    const storeName = 'lq-multi-query-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedItem(storeName, sessionKey, 'projects', 1, {
      id: 1,
      name: 'Cached project',
    });
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);
    setCachedQuery(storeName, sessionKey, projectsQuery, [
      storeItemKey('projects', 1),
    ]);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the mounted query flow.
    await settleStartupBackgroundScan();

    // The first mount must hydrate both cold cached queries and their items from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useMultipleListQueries(
          [{ payload: usersQuery }, { payload: projectsQuery }],
          { disableRefetchOnMount: true, returnRefetchingStatus: true },
        ),
      );

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
      0    | 📖 #1 ✅ tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.12 kb
      .    | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m
           |    └ (items index) | 0.23 kb
      .    | 📖 #3 ✅ tsdf.sess1.lq-multi-query-remount-flow.li."users||1
           |    └ (item data, <"users||1>) | 0.10 kb
      .    | 📖 #4 ✅ tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"}
           |    └ (query data, <{tableId:"projects"}>) | 0.13 kb
      .    | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m
           |    └ (items index) | 0.23 kb ⚠️ REPEATED READ <10ms UNCHANGED
      .    | 📖 #5 ✅ tsdf.sess1.lq-multi-query-remount-flow.li."projects||1
           |    └ (item data, <"projects||1>) | 0.11 kb
           ·
      2s   | 📖 #1 ✅ tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.12 kb
      .    | ✍️ #1 ✅->✅ tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.12 kb -> 0.12 kb
      .    | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m
           |    └ (items index) | 0.23 kb
      .    | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m
           |    └ (items index) | 0.23 kb -> 0.23 kb
      .    | 📖 #4 ✅ tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"}
           |    └ (query data, <{tableId:"projects"}>) | 0.13 kb
      .    | ✍️ #4 ✅->✅ tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"}
           |    └ (query data, <{tableId:"projects"}>) | 0.13 kb -> 0.13 kb
      .    | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m
           |    └ (items index) | 0.23 kb
      .    | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m
           |    └ (items index) | 0.23 kb -> 0.23 kb
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('updating a hydrated list-query item writes the mutation without rereading cached entries', async () => {
    const storeName = 'lq-mutation-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached user',
    });
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

    const env = createListQueryEnv({ storeName, sessionKey });

    // Hydrate the cached query through a normal mounted component first.
    await settleStartupBackgroundScan();
    renderHook(() =>
      env.apiStore.useListQuery(usersQuery, { disableRefetchOnMount: true }),
    );
    await flushAllTimers();

    // Mutating the already-hydrated item should only need manifest reads plus writes.
    const mutationCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.apiStore.updateItemState(rawItemPayload('users', 1), (draft) => {
        draft.name = 'Edited user';
      });
    });
    await advanceTime(1100);
    await flushAllTimers();
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readItemData('users', 1),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Edited user'
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      time |
      1s   | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-mutation-flow.li.m
           |    └ (items index) | 0.12 kb
      .    | ✍️ #2 ✅->✅ tsdf.sess1.lq-mutation-flow.li."users||1
           |    └ (item data, <"users||1>) | 0.10 kb -> 0.16 kb
      .    | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-mutation-flow.li.m
           |    └ (items index) | 0.12 kb ⚠️ REPEATED READ <10ms UNCHANGED
      .    | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.lq-mutation-flow.li.m
           |    └ (items index) | 0.12 kb -> 0.18 kb
      "
    `);
  });
});
