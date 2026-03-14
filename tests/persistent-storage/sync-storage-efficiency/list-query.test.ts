import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import type { ListQueryParams } from '../../mocks/listQueryStoreTestEnv';
import { advanceTime, flushAllTimers } from '../../utils/genericTestUtils';
import { startPersistentStorageOperationCapture } from '../../utils/persistentStorageOptimizationTestUtils';
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
      2s   | 📖 ❌ tsdf._m.g (global maintenance)
      .    | 🔑[0] ✅ tsdf.sess1.list-query-expiration.li."expired-users||1 (entry)
      .    | 🔑[1] ✅ tsdf._m.r.n:sess1.list-query-expiration.li.m (root, namespace, manifest)
      .    | 🔑[2] ✅ tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (entry)
      .    | 🔑[3] ✅ tsdf._m.r.n:sess1.list-query-expiration.lq.m (root, namespace, manifest)
      .    | 🔑[4] ✅ tsdf.sess1.list-query-expiration.li."fresh-users||2 (entry)
      .    | 🔑[5] ✅ tsdf.sess1.list-query-expiration.lq.{tableId:"fresh-users"} (entry)
      .    | 📖 ✅ tsdf._m.r.n:sess1.list-query-expiration.li.m (root, namespace, manifest) | 0.31 kb
      .    | 🗑️ ✅->❌ tsdf.sess1.list-query-expiration.li."expired-users||1 (entry)
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.list-query-expiration.li.m (root, namespace, manifest) | 0.31 kb -> 0.16 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.list-query-expiration.lq.m (root, namespace, manifest) | 0.52 kb
      .    | 🗑️ ✅->❌ tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"} (entry)
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.list-query-expiration.lq.m (root, namespace, manifest) | 0.52 kb -> 0.27 kb
      .    | ✍️ ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.05 kb
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
      1.81s | 📖 ❌ tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest)
      .     | 🔑[0] ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (entry)
      .     | 🔑[1] ✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest)
      .     | 🔑[2] ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"second"} (entry)
      .     | 🔑[3] ✅ tsdf._m.g (global maintenance)
      .     | ✍️ ❌->✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (entry) | ❌ -> 0.23 kb
      .     | 📖 ✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.39 kb
      .     | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.39 kb -> 0.60 kb
      .     | 📖 ❌ tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest)
      .     | 📖 ❌ tsdf.sess1.lq-query-metadata.li."third||1 (entry)
      .     | ✍️ ❌->✅ tsdf.sess1.lq-query-metadata.li."third||1 (entry) | ❌ -> 0.20 kb
      .     | ✍️ ❌->✅ tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest) | ❌ -> 0.14 kb
      .     | 🔑[0] ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (entry)
      .     | 🔑[1] ✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest)
      .     | 🔑[2] ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"second"} (entry)
      .     | 🔑[3] ✅ tsdf._m.g (global maintenance)
      .     | 🔑[4] ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"third"} (entry)
      .     | 🔑[5] ✅ tsdf.sess1.lq-query-metadata.li."third||1 (entry)
      .     | 🔑[6] ✅ tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest)
      .     | 📖 ✅ tsdf._m.r.n:sess1.lq-query-metadata.li.m (root, namespace, manifest) | 0.14 kb
      .     | 📖 ✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.60 kb
      .     | 🗑️ ✅->❌ tsdf.sess1.lq-query-metadata.lq.{tableId:"first"} (entry)
      .     | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-query-metadata.lq.m (root, namespace, manifest) | 0.60 kb -> 0.42 kb
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
      1s   | 📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.25 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.25 kb
      .    | 📖 ❌ tsdf.sess1.lq-item-metadata.li."users||3 (entry)
      .    | ✍️ ❌->✅ tsdf.sess1.lq-item-metadata.li."users||3 (entry) | ❌ -> 0.20 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.25 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.25 kb -> 0.37 kb
      .    | 🔑[0] ✅ tsdf.sess1.lq-item-metadata.li."users||1 (entry)
      .    | 🔑[1] ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest)
      .    | 🔑[2] ✅ tsdf.sess1.lq-item-metadata.li."users||2 (entry)
      .    | 🔑[3] ✅ tsdf.sess1.lq-item-metadata.lq.{tableId:"users"} (entry)
      .    | 🔑[4] ✅ tsdf._m.r.n:sess1.lq-item-metadata.lq.m (root, namespace, manifest)
      .    | 🔑[5] ✅ tsdf._m.g (global maintenance)
      .    | 🔑[6] ✅ tsdf.sess1.lq-item-metadata.li."users||3 (entry)
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.37 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-item-metadata.lq.m (root, namespace, manifest) | 0.26 kb
      .    | 🗑️ ✅->❌ tsdf.sess1.lq-item-metadata.li."users||3 (entry)
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m (root, namespace, manifest) | 0.37 kb -> 0.25 kb
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
      0    | 📖 ✅ tsdf._m.r.n:sess1.lq-direct-get-query-state.lq.m (root, namespace, manifest) | 0.23 kb
      .    | 📖 ✅ tsdf.sess1.lq-direct-get-query-state.lq.{tableId:"users"} (entry) | 0.23 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-direct-get-query-state.li.m (root, namespace, manifest) | 0.14 kb
      .    | 📖 ✅ tsdf.sess1.lq-direct-get-query-state.li."users||1 (entry) | 0.21 kb
      "
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
      1.81s | ✍️ ✅->✅ tsdf.sess1.lq-query-invalidation-flow.li."users||1 (entry) | 0.29 kb -> 0.29 kb
      .     | 📖 ✅ tsdf._m.r.n:sess1.lq-query-invalidation-flow.li.m (root, namespace, manifest) | 0.14 kb
      .     | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-query-invalidation-flow.li.m (root, namespace, manifest) | 0.14 kb -> 0.14 kb
      "
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
      0    | 📖 ✅ tsdf._m.r.n:sess1.lq-remount-flow.lq.m (root, namespace, manifest) | 0.23 kb
      .    | 📖 ✅ tsdf.sess1.lq-remount-flow.lq.{tableId:"users"} (entry) | 0.23 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-remount-flow.li.m (root, namespace, manifest) | 0.14 kb
      .    | 📖 ✅ tsdf.sess1.lq-remount-flow.li."users||1 (entry) | 0.21 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-remount-flow.li.m (root, namespace, manifest) | 0.14 kb
      .    | 📖 ✅ tsdf.sess1.lq-remount-flow.li."users||1 (entry) | 0.21 kb
      1s   | 📖 ✅ tsdf._m.r.n:sess1.lq-remount-flow.li.m (root, namespace, manifest) | 0.14 kb
      .    | ✍️ ✅->✅ tsdf.sess1.lq-remount-flow.li."users||1 (entry) | 0.21 kb -> 0.29 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-remount-flow.li.m (root, namespace, manifest) | 0.14 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-remount-flow.li.m (root, namespace, manifest) | 0.14 kb -> 0.14 kb
      2s   | 📖 ✅ tsdf._m.r.n:sess1.lq-remount-flow.lq.m (root, namespace, manifest) | 0.23 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-remount-flow.lq.m (root, namespace, manifest) | 0.23 kb -> 0.23 kb
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
      1.81s | ✍️ ✅->✅ tsdf.sess1.lq-item-invalidation-flow.li."users||1 (entry) | 0.29 kb -> 0.29 kb
      .     | 📖 ✅ tsdf._m.r.n:sess1.lq-item-invalidation-flow.li.m (root, namespace, manifest) | 0.14 kb
      .     | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-item-invalidation-flow.li.m (root, namespace, manifest) | 0.14 kb -> 0.14 kb
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
      0    | 📖 ✅ tsdf._m.r.n:sess1.lq-item-remount-flow.li.m (root, namespace, manifest) | 0.14 kb
      .    | 📖 ✅ tsdf.sess1.lq-item-remount-flow.li."users||1 (entry) | 0.21 kb
      1s   | 📖 ✅ tsdf._m.r.n:sess1.lq-item-remount-flow.li.m (root, namespace, manifest) | 0.14 kb
      .    | ✍️ ✅->✅ tsdf.sess1.lq-item-remount-flow.li."users||1 (entry) | 0.21 kb -> 0.29 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-item-remount-flow.li.m (root, namespace, manifest) | 0.14 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-item-remount-flow.li.m (root, namespace, manifest) | 0.14 kb -> 0.14 kb
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
      0    | 📖 ✅ tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m (root, namespace, manifest) | 0.25 kb
      .    | 📖 ✅ tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (entry) | 0.21 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m (root, namespace, manifest) | 0.25 kb
      .    | 📖 ✅ tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (entry) | 0.21 kb
      1s   | 📖 ✅ tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m (root, namespace, manifest) | 0.25 kb
      .    | ✍️ ✅->✅ tsdf.sess1.lq-multi-item-remount-flow.li."users||1 (entry) | 0.21 kb -> 0.29 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m (root, namespace, manifest) | 0.25 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m (root, namespace, manifest) | 0.25 kb -> 0.25 kb
      .    | ✍️ ✅->✅ tsdf.sess1.lq-multi-item-remount-flow.li."users||2 (entry) | 0.21 kb -> 0.29 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-multi-item-remount-flow.li.m (root, namespace, manifest) | 0.25 kb -> 0.25 kb
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
      0    | 📖 ✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.lq.m (root, namespace, manifest) | 0.45 kb
      .    | 📖 ✅ tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"users"} (entry) | 0.23 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.26 kb
      .    | 📖 ✅ tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (entry) | 0.21 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.26 kb
      .    | 📖 ✅ tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (entry) | 0.21 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.lq.m (root, namespace, manifest) | 0.45 kb
      .    | 📖 ✅ tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"} (entry) | 0.24 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.26 kb
      .    | 📖 ✅ tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (entry) | 0.22 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.26 kb
      .    | 📖 ✅ tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (entry) | 0.22 kb
      1s   | 📖 ✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.26 kb
      .    | ✍️ ✅->✅ tsdf.sess1.lq-multi-query-remount-flow.li."users||1 (entry) | 0.21 kb -> 0.29 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.26 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.26 kb -> 0.26 kb
      .    | ✍️ ✅->✅ tsdf.sess1.lq-multi-query-remount-flow.li."projects||1 (entry) | 0.22 kb -> 0.30 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.li.m (root, namespace, manifest) | 0.26 kb -> 0.26 kb
      2s   | 📖 ✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.lq.m (root, namespace, manifest) | 0.45 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.lq.m (root, namespace, manifest) | 0.45 kb -> 0.45 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.lq.m (root, namespace, manifest) | 0.45 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-multi-query-remount-flow.lq.m (root, namespace, manifest) | 0.45 kb -> 0.45 kb
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
      1s   | ✍️ ✅->✅ tsdf.sess1.lq-mutation-flow.li."users||1 (entry) | 0.29 kb -> 0.29 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.lq-mutation-flow.li.m (root, namespace, manifest) | 0.14 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.lq-mutation-flow.li.m (root, namespace, manifest) | 0.14 kb -> 0.14 kb
      "
    `);
  });
});
