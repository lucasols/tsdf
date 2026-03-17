import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { localPersistentStorage } from '../../../src/persistentStorage/storageAdapter';
import type { ListQueryParams } from '../../mocks/listQueryStoreTestEnv';
import { advanceTime, flushAllTimers } from '../../utils/genericTestUtils';
import {
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
      2s   | 📖 ❌ #1 tsdf._m.g (global maintenance)
      .    | 🔑[0] ✅ #2 tsdf.sess1.list-query-expiration.li."expired-users||1 (item entry)
      .    | 🔑[1] ✅ #3 tsdf._m.r.n:sess1.list-query-expiration.li.m (root, namespace, manifest)
      .    | 🔑[2] ✅ #4 tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (query entry)
      .    | 🔑[3] ✅ #5 tsdf.sess1.list-query-expiration.li."fresh-users||2 (item entry)
      .    | 🔑[4] ✅ #6 tsdf.sess1.list-query-expiration.lq.{tableId:"fresh-users"} (query entry)
      .    | 📖 ✅ #3 tsdf._m.r.n:sess1.list-query-expiration.li.m (root, namespace, manifest) | 0.27 kb
      .    | 🗑️ ✅->❌ #2 tsdf.sess1.list-query-expiration.li."expired-users||1 (item entry)
      .    | 📖 ✅ #4 tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (query entry) | 0.15 kb
      .    | 📖 ✅ #6 tsdf.sess1.list-query-expiration.lq.{tableId:"fresh-users"} (query entry) | 0.14 kb
      .    | 🗑️ ✅->❌ #4 tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (query entry)
      .    | ✍️ ❌->✅ #1 tsdf._m.g (global maintenance) | ❌ -> 0.04 kb
      .    | ✍️ ✅->✅ #3 tsdf._m.r.n:sess1.list-query-expiration.li.m (root, namespace, manifest) | 0.27 kb -> 0.14 kb
      "
    `);
  });

  test('maxQueries cleanup snapshots the full manifest history', async () => {
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

    // Fetching a third query should show the write path and the query eviction path together.
    const readCapture = startPersistentStorageOperationCapture();
    env.scheduleFetch('highPriority', thirdQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.lq.`),
    ).toMatchInlineSnapshot(`['{tableId:"second"}', '{tableId:"third"}']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | 📖 ❌ #1 tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest)
      .     | 📖 ❌ #2 tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (query entry)
      .     | ✍️ ❌->✅ #2 tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (query entry) | ❌ -> 0.12 kb
      .     | 📖 ❌ #1 tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest)
      .     | 📖 ❌ #3 tsdf.sess1.lq-query-metadata.li."third||1 (item entry)
      .     | ✍️ ❌->✅ #3 tsdf.sess1.lq-query-metadata.li."third||1 (item entry) | ❌ -> 0.17 kb
      .     | ✍️ ❌->✅ #1 tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest) | ❌ -> 0.12 kb
      .     | 🔑[0] ✅ #4 tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (query entry)
      .     | 🔑[1] ✅ #5 tsdf.sess1.lq-query-metadata.lq.{tableId:"second"} (query entry)
      .     | 🔑[2] ✅ #6 tsdf._m.g (global maintenance)
      .     | 🔑[3] ✅ #2 tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (query entry)
      .     | 🔑[4] ✅ #3 tsdf.sess1.lq-query-metadata.li."third||1 (item entry)
      .     | 🔑[5] ✅ #1 tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest)
      .     | 📖 ✅ #4 tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (query entry) | 0.10 kb
      .     | 📖 ✅ #5 tsdf.sess1.lq-query-metadata.lq.{tableId:"second"} (query entry) | 0.10 kb
      .     | 📖 ✅ #2 tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (query entry) | 0.12 kb
      .     | 🗑️ ✅->❌ #4 tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (query entry)
      .     | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest) | 0.12 kb
      "
    `);

    expect(
      getParsedLocalStorageValue('tsdf._m.r.n:sess1.lq-query-metadata.lq.m'),
    ).toMatchInlineSnapshot(`null`);
    expect(
      getParsedLocalStorageValue('tsdf._m.r.n:sess1.lq-query-metadata.li.m'),
    ).toMatchInlineSnapshot(`
      e:
        - a: 1735689604010
          k: '"third||1'
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
      1.81s | 📖 ❌ #1 tsdf._m.r.n:sess1.lq-empty-query-manifest.li.m (root, namespace, manifest)
      .     | 📖 ❌ #2 tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (query entry)
      .     | ✍️ ❌->✅ #2 tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"} (query entry) | ❌ -> 0.22 kb
      "
    `);
  });

  test('query that becomes empty after invalidation cleans up orphaned items from persistence', async () => {
    const storeName = 'lq-query-becomes-empty';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const itemManifestKey = localPersistentStorage.getManifestKeyForPrefix(
      `tsdf.${sessionKey}.${storeName}.li.`,
    );
    const queryManifestKey = localPersistentStorage.getManifestKeyForPrefix(
      `tsdf.${sessionKey}.${storeName}.lq.`,
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
            k: '"users||1'
            p: 'users||1'
      `,
    );
    expect(getParsedLocalStorageValue(queryManifestKey)).toMatchInlineSnapshot(
      `null`,
    );
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-query-becomes-empty.li.m (root, namespace, manifest) | 0.12 kb
      .     | 📖 ✅ #2 tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (query entry) | 0.12 kb
      .     | ✍️ ✅->✅ #2 tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"} (query entry) | 0.12 kb -> 0.10 kb
      .     | ✍️ ✅->✅ #3 tsdf.sess1.lq-query-becomes-empty.li."users||1 (item entry) | 0.18 kb -> 0.27 kb
      .     | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-query-becomes-empty.li.m (root, namespace, manifest) | 0.12 kb
      .     | ✍️ ✅->✅ #1 tsdf._m.r.n:sess1.lq-query-becomes-empty.li.m (root, namespace, manifest) | 0.12 kb -> 0.12 kb
      "
    `);
  });

  test('maxItems cleanup snapshots the full manifest history', async () => {
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

    // Adding a third item should snapshot the write plus eviction sequence end-to-end.
    const readCapture = startPersistentStorageOperationCapture();
    env.apiStore.addItemToState(rawItemPayload('users', 3), {
      id: 3,
      name: 'Fresh',
    });
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      1s   | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.22 kb
      .    | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.22 kb
      .    | 📖 ❌ #2 tsdf.sess1.lq-item-metadata.li."users||3 (item entry)
      .    | ✍️ ❌->✅ #2 tsdf.sess1.lq-item-metadata.li."users||3 (item entry) | ❌ -> 0.17 kb
      .    | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.22 kb
      .    | ✍️ ✅->✅ #1 tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.22 kb -> 0.32 kb
      .    | 🔑[0] ✅ #3 tsdf.sess1.lq-item-metadata.li."users||1 (item entry)
      .    | 🔑[1] ✅ #1 tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest)
      .    | 🔑[2] ✅ #4 tsdf.sess1.lq-item-metadata.li."users||2 (item entry)
      .    | 🔑[3] ✅ #5 tsdf.sess1.lq-item-metadata.lq.{tableId:"users"} (query entry)
      .    | 🔑[4] ✅ #6 tsdf._m.g (global maintenance)
      .    | 🔑[5] ✅ #2 tsdf.sess1.lq-item-metadata.li."users||3 (item entry)
      .    | 📖 ✅ #5 tsdf.sess1.lq-item-metadata.lq.{tableId:"users"} (query entry) | 0.15 kb
      .    | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.32 kb
      .    | 🗑️ ✅->❌ #2 tsdf.sess1.lq-item-metadata.li."users||3 (item entry)
      .    | ✍️ ✅->✅ #1 tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.32 kb -> 0.22 kb
      "
    `);
  });

  test('direct getQueryState hydrates the cached list query once and leaves its items in memory for later reads', async () => {
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

    // Reading the query should pull both the query and its referenced item into state.
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
    expect(env.apiStore.getItemState(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached user'
      `);
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
      0    | 📖 ✅ #1 tsdf.sess1.lq-direct-get-query-state.lq.{tableId:"users"} (query entry) | 0.12 kb
      .    | 📖 ✅ #2 tsdf._m.r.n:sess1.lq-direct-get-query-state.li.m (root, namespace, manifest) | 0.12 kb
      .    | 📖 ✅ #3 tsdf.sess1.lq-direct-get-query-state.li."users||1 (item entry) | 0.18 kb
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
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readQueryEntry(usersQuery).data,
    ).toMatchInlineSnapshot(`
      hasMore: '❌'
      items: ['"users||1']
      payload: { tableId: 'users' }
    `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-query-invalidation-flow.li.m (root, namespace, manifest) | 0.12 kb
      .     | ✍️ ✅->✅ #2 tsdf.sess1.lq-query-invalidation-flow.li."users||1 (item entry) | 0.18 kb -> 0.27 kb
      .     | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-query-invalidation-flow.li.m (root, namespace, manifest) | 0.12 kb
      .     | ✍️ ✅->✅ #1 tsdf._m.r.n:sess1.lq-query-invalidation-flow.li.m (root, namespace, manifest) | 0.12 kb -> 0.12 kb
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
      o: '✅'
      p: 'users||1'
    `);
    expect(getParsedLocalStorageValue(itemManifestKey)).toMatchInlineSnapshot(`
      e:
        - a: 1735689605910
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
      0    | 📖 ✅ #1 tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (query entry) | 0.12 kb
      .    | 📖 ✅ #2 tsdf._m.r.n:sess1.lq-remount-flow.li.m (root, namespace, manifest) | 0.12 kb
      .    | 📖 ✅ #3 tsdf.sess1.lq-remount-flow.li."users||1 (item entry) | 0.18 kb
      .    | 📖 ✅ #2 tsdf._m.r.n:sess1.lq-remount-flow.li.m (root, namespace, manifest) | 0.12 kb
      .    | 📖 ✅ #3 tsdf.sess1.lq-remount-flow.li."users||1 (item entry) | 0.18 kb
      2s   | 📖 ✅ #1 tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (query entry) | 0.12 kb
      .    | ✍️ ✅->✅ #1 tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (query entry) | 0.12 kb -> 0.12 kb
      .    | 📖 ✅ #2 tsdf._m.r.n:sess1.lq-remount-flow.li.m (root, namespace, manifest) | 0.12 kb
      .    | ✍️ ✅->✅ #2 tsdf._m.r.n:sess1.lq-remount-flow.li.m (root, namespace, manifest) | 0.12 kb -> 0.12 kb
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
      1.81s | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-item-invalidation-flow.li.m (root, namespace, manifest) | 0.12 kb
      .     | ✍️ ✅->✅ #2 tsdf.sess1.lq-item-invalidation-flow.li."users||1 (item entry) | 0.18 kb -> 0.27 kb
      .     | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-item-invalidation-flow.li.m (root, namespace, manifest) | 0.12 kb
      .     | ✍️ ✅->✅ #1 tsdf._m.r.n:sess1.lq-item-invalidation-flow.li.m (root, namespace, manifest) | 0.12 kb -> 0.12 kb
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
      0    | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-item-remount-flow.li.m (root, namespace, manifest) | 0.12 kb
      .    | 📖 ✅ #2 tsdf.sess1.lq-item-remount-flow.li."users||1 (item entry) | 0.18 kb
      2s   | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-item-remount-flow.li.m (root, namespace, manifest) | 0.12 kb
      .    | ✍️ ✅->✅ #1 tsdf._m.r.n:sess1.lq-item-remount-flow.li.m (root, namespace, manifest) | 0.12 kb -> 0.12 kb
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
      0    | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m (root, namespace, manifest) | 0.22 kb
      .    | 📖 ✅ #2 tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (item entry) | 0.19 kb
      .    | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m (root, namespace, manifest) | 0.22 kb
      .    | 📖 ✅ #3 tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (item entry) | 0.19 kb
      2s   | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m (root, namespace, manifest) | 0.22 kb
      .    | ✍️ ✅->✅ #1 tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m (root, namespace, manifest) | 0.22 kb -> 0.22 kb
      .    | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m (root, namespace, manifest) | 0.22 kb
      .    | ✍️ ✅->✅ #1 tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m (root, namespace, manifest) | 0.22 kb -> 0.22 kb
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
      0    | 📖 ✅ #1 tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (query entry) | 0.12 kb
      .    | 📖 ✅ #2 tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.23 kb
      .    | 📖 ✅ #3 tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (item entry) | 0.18 kb
      .    | 📖 ✅ #2 tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.23 kb
      .    | 📖 ✅ #3 tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (item entry) | 0.18 kb
      .    | 📖 ✅ #4 tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (query entry) | 0.13 kb
      .    | 📖 ✅ #2 tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.23 kb
      .    | 📖 ✅ #5 tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (item entry) | 0.20 kb
      .    | 📖 ✅ #2 tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.23 kb
      .    | 📖 ✅ #5 tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (item entry) | 0.20 kb
      2s   | 📖 ✅ #1 tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (query entry) | 0.12 kb
      .    | ✍️ ✅->✅ #1 tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (query entry) | 0.12 kb -> 0.12 kb
      .    | 📖 ✅ #2 tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.23 kb
      .    | ✍️ ✅->✅ #2 tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.23 kb -> 0.23 kb
      .    | 📖 ✅ #4 tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (query entry) | 0.13 kb
      .    | ✍️ ✅->✅ #4 tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (query entry) | 0.13 kb -> 0.13 kb
      .    | 📖 ✅ #2 tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.23 kb
      .    | ✍️ ✅->✅ #2 tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.23 kb -> 0.23 kb
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
      1s   | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-mutation-flow.li.m (root, namespace, manifest) | 0.12 kb
      .    | ✍️ ✅->✅ #2 tsdf.sess1.lq-mutation-flow.li."users||1 (item entry) | 0.18 kb -> 0.27 kb
      .    | 📖 ✅ #1 tsdf._m.r.n:sess1.lq-mutation-flow.li.m (root, namespace, manifest) | 0.12 kb
      .    | ✍️ ✅->✅ #1 tsdf._m.r.n:sess1.lq-mutation-flow.li.m (root, namespace, manifest) | 0.12 kb -> 0.12 kb
      "
    `);
  });
});
