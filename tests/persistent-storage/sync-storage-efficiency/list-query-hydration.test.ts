import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
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
  getLocalListItemEntrySizeBytes,
  getLocalListQueryEntrySizeBytes,
  listStoredKeys,
  persistentStore,
  rawItemPayload,
  setCachedItem,
  setCachedQuery,
  settleStartupBackgroundScan,
  setupSyncStorageEfficiencyTestSuite,
  storeItemKey,
  sumPersistedEntryBytes,
  waitForScheduledCleanup,
} from './shared';

setupSyncStorageEfficiencyTestSuite();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sync storage efficiency: list-query', () => {
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

  test('missing list-query entries become visible again before the next task', async () => {
    const storeName = 'lq-microtask-miss-cache';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' } satisfies ListQueryParams;

    const env = createListQueryEnv({ storeName, sessionKey });

    // Drain the startup scan so the test only exercises the direct read path.
    await settleStartupBackgroundScan();

    // The initial misses should only dedupe repeated sync reads in the same turn.
    expect(env.apiStore.getQueryState(usersQuery)).toBeUndefined();
    expect(
      env.apiStore.getItemState(rawItemPayload('users', 1)),
    ).toBeUndefined();

    // Another tab can persist the query and item before the next task runs.
    await Promise.resolve();
    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Fresh user',
    });
    setCachedQuery(storeName, sessionKey, usersQuery, ['"users||1']);

    // The next reads should hydrate from the newly persisted entries immediately.
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
        name: 'Fresh user'
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
      e: Record<string, Record<string, unknown>>;
      v: number;
    }>(itemManifestKey);
    const currentQueryEntry =
      getParsedLocalStorageValue<Record<string, unknown>>(queryStorageKey);
    if (currentItemManifest === null) {
      throw new Error(`Missing localStorage manifest for ${itemManifestKey}`);
    }

    const itemEntryKey = persistentStore
      .scope(storeName, sessionKey)
      .listQuery.itemKey('users', 1);
    const currentItemEntry = currentItemManifest.e[itemEntryKey];
    if (currentItemEntry === undefined) {
      throw new Error(
        `Missing list item manifest entry for ${itemManifestKey}`,
      );
    }

    localStorage.setItem(
      itemManifestKey,
      JSON.stringify({
        ...currentItemManifest,
        e: {
          ...currentItemManifest.e,
          [itemEntryKey]: { ...currentItemEntry, o: true },
        },
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
        "users||1: { a: 1735689614100, o: '✅', p: 'users||1', z: 50 }
    `);
    expect(getParsedLocalStorageValue(queryStorageKey)).toMatchInlineSnapshot(`
      a: 1735689614100
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
      serverData: { users: [{ id: 1, name: 'Cached user' }] },
    });

    // Hydrate cached data and settle the automatic revalidation first so the explicit invalidation path stays isolated.
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Update the server copy, invalidate for the mounted query, then capture fetch completion plus the debounced save.
    const refetchCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.serverTable.updateItem('users||1', { name: 'Fresh user' });
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: usersQuery,
        type: 'highPriority',
      });
    });
    await flushInvalidationPersistence();
    const refetchOperations = refetchCapture.finish().timelineString;

    expect(hook.result.current.items).toMatchInlineSnapshot(`
      - { id: 1, name: 'Fresh user' }
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.sess1.lq-query-invalidation-flow.lq.{tableId:"users"}',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689614100
      i: ['"users||1']
      p: { tableId: 'users' }
    `);
    expect(refetchOperations).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | ✍️ #1 ✅->✅ tsdf.sess1.lq-query-invalidation-flow.li."users||1
            |    └ (item data, <"users||1>) | 0.10 kb -> 0.10 kb
      .     | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-query-invalidation-flow.li.m
            |    └ (items index) | 0.12 kb
      .     | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.lq-query-invalidation-flow.li.m
            |    └ (items index) | 0.12 kb -> 0.12 kb
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
      serverData: { users: [{ id: 1, name: 'Cached user' }] },
    });

    // Hydrate cached data and settle the automatic revalidation first so only the invalidation writes are counted below.
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Let the first refetch finish, but stay inside the debounced persistence window.
    const firstRefetchCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.serverTable.updateItem('users||1', { name: 'Fresh user 1' });
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: usersQuery,
        type: 'highPriority',
      });
    });
    await advanceTime(900);
    const firstRefetchOperations = firstRefetchCapture.finish().timelineString;

    expect(hook.result.current.items).toMatchInlineSnapshot(`
      - { id: 1, name: 'Fresh user 1' }
    `);
    expect(firstRefetchOperations).toMatchInlineSnapshot(`"empty"`);

    // A second refetch before the first debounce flush should replace the pending save.
    const secondRefetchCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.serverTable.updateItem('users||1', { name: 'Fresh user 2' });
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: usersQuery,
        type: 'highPriority',
      });
    });
    await advanceTime(1900);
    await flushAllTimers();
    const secondRefetchOperations =
      secondRefetchCapture.finish().timelineString;

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
    expect(secondRefetchOperations).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | ✍️ #1 ✅->✅ tsdf.sess1.lq-coalesced-invalidations.li."users||1
            |    └ (item data, <"users||1>) | 0.10 kb -> 0.10 kb
      .     | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-coalesced-invalidations.li.m
            |    └ (items index) | 0.12 kb
      .     | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.lq-coalesced-invalidations.li.m
            |    └ (items index) | 0.12 kb -> 0.12 kb
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
      e: Record<string, Record<string, unknown>>;
      v: number;
    }>(itemManifestKey);
    const currentQueryEntry =
      getParsedLocalStorageValue<Record<string, unknown>>(queryStorageKey);
    if (currentItemManifest === null) {
      throw new Error(`Missing localStorage manifest for ${itemManifestKey}`);
    }

    const itemEntryKey = persistentStore
      .scope(storeName, sessionKey)
      .listQuery.itemKey('users', 1);
    const currentItemEntry = currentItemManifest.e[itemEntryKey];
    if (currentItemEntry === undefined) {
      throw new Error(
        `Missing list item manifest entry for ${itemManifestKey}`,
      );
    }

    localStorage.setItem(
      itemManifestKey,
      JSON.stringify({
        ...currentItemManifest,
        e: {
          ...currentItemManifest.e,
          [itemEntryKey]: { ...currentItemEntry, o: true },
        },
      }),
    );
    localStorage.setItem(
      queryStorageKey,
      JSON.stringify({ ...currentQueryEntry, o: true }),
    );

    // The refetch rewrites both namespaces, and should keep the externally-added markers.
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: usersQuery,
        type: 'highPriority',
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
        "users||1: { a: 1735689613910, o: '✅', p: 'users||1', z: 49 }
        "users||2: { a: 1735689613910, p: 'users||2', z: 50 }
    `);
    expect(getParsedLocalStorageValue(queryStorageKey)).toMatchInlineSnapshot(`
      a: 1735689613910
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
      await captureHookRemount(
        () =>
          env.apiStore.useListQuery(usersQuery, {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
        { firstMountSettleMode: 'none', remountSettleMode: 'none' },
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
      await captureHookRemount(
        () =>
          env.apiStore.useListQuery(usersQuery, {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
        { firstMountSettleMode: 'none', remountSettleMode: 'none' },
      );

    expect(secondHook.result.current.items).toMatchInlineSnapshot(`[]`);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 ✅ tsdf.sess1.lq-empty-remount-flow.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.10 kb
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
      await captureHookRemount(
        () =>
          env.apiStore.useListQuery(usersQuery, {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
        { remountSettleMode: 'none' },
      );

    expect(secondHook.result.current.items).toMatchInlineSnapshot(`
      - { id: 1, name: 'Fetched user' }
    `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time  |
      0     | 📖 #1 ❌ tsdf.sess1.lq-query-remount-no-cache.lq.{tableId:"users"}
            |    └ (query data, <{tableId:"users"}>)
            ·
      1.81s | 📖 #1 ❌ tsdf.sess1.lq-query-remount-no-cache.lq.{tableId:"users"}
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
      serverData: { users: [{ id: 1, name: 'Cached user' }] },
    });

    // Hydrate cached data and settle the automatic revalidation first so the explicit invalidation path stays isolated.
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useItem(itemPayload, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Update the server copy, invalidate for the mounted item hook, then capture fetch completion plus the debounced save.
    const refetchCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.serverTable.updateItem('users||1', { name: 'Fresh user' });
      env.apiStore.invalidateItem(itemPayload, 'highPriority');
    });
    await flushInvalidationPersistence();
    const refetchOperations = refetchCapture.finish().timelineString;

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
    expect(refetchOperations).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | ✍️ #1 ✅->✅ tsdf.sess1.lq-item-invalidation-flow.li."users||1
            |    └ (item data, <"users||1>) | 0.10 kb -> 0.10 kb
      .     | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-item-invalidation-flow.li.m
            |    └ (items index) | 0.12 kb
      .     | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.lq-item-invalidation-flow.li.m
            |    └ (items index) | 0.12 kb -> 0.12 kb
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
      await captureHookRemount(
        () =>
          env.apiStore.useItem(rawItemPayload('users', 1), {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
        { firstMountSettleMode: 'none', remountSettleMode: 'none' },
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
      await captureHookRemount(
        () =>
          env.apiStore.useItem(itemPayload, {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
        { remountSettleMode: 'none' },
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
      10ms  | 📖 #1 ❌ tsdf._m.r.n:sess1.lq-item-remount-no-cache.li.m
            |    └ (items index)
            ·
      1.81s | 📖 #1 ❌ tsdf._m.r.n:sess1.lq-item-remount-no-cache.li.m
            |    └ (items index)
      .     | ✍️ #2 ❌->✅ tsdf.sess1.lq-item-remount-no-cache.li."users||1
            |    └ (item data, <"users||1>) | ❌ -> 0.10 kb
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
      await captureHookRemount(
        () =>
          env.apiStore.useMultipleItems(
            [
              { payload: rawItemPayload('users', 1) },
              { payload: rawItemPayload('users', 2) },
            ],
            { disableRefetchOnMount: true, returnRefetchingStatus: true },
          ),
        { firstMountSettleMode: 'none', remountSettleMode: 'none' },
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
           |    └ (items index) | 0.23 kb
      .    | 📖 #2 ✅ tsdf.sess1.lq-multi-item-remount-flow.li."users||1
           |    └ (item data, <"users||1>) | 0.10 kb
      .    | 📖 #3 ✅ tsdf.sess1.lq-multi-item-remount-flow.li."users||2
           |    └ (item data, <"users||2>) | 0.10 kb
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
      await captureHookRemount(
        () =>
          env.apiStore.useMultipleListQueries(
            [{ payload: usersQuery }, { payload: projectsQuery }],
            { disableRefetchOnMount: true, returnRefetchingStatus: true },
          ),
        { firstMountSettleMode: 'none', remountSettleMode: 'none' },
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
           |    └ (items index) | 0.24 kb
      .    | 📖 #3 ✅ tsdf.sess1.lq-multi-query-remount-flow.li."users||1
           |    └ (item data, <"users||1>) | 0.10 kb
      .    | 📖 #4 ✅ tsdf.sess1.lq-multi-query-remount-flow.lq.{tableId:"projects"}
           |    └ (query data, <{tableId:"projects"}>) | 0.13 kb
      .    | 📖 #5 ✅ tsdf.sess1.lq-multi-query-remount-flow.li."projects||1
           |    └ (item data, <"projects||1>) | 0.11 kb
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
      1s   | ✍️ #1 ✅->✅ tsdf.sess1.lq-mutation-flow.li."users||1
           |    └ (item data, <"users||1>) | 0.10 kb -> 0.10 kb
      .    | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-mutation-flow.li.m
           |    └ (items index) | 0.12 kb
      .    | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.lq-mutation-flow.li.m
           |    └ (items index) | 0.12 kb -> 0.12 kb
      "
    `);
  });

  test('a budget-evicted in-state query stays evicted across later flushes instead of churning back into storage', async () => {
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const tasksQuery = { tableId: 'tasks' };
    const storeName = 'lq-query-budget-stability';
    const sessionKey = 'sess1';
    const env = createListQueryEnv({
      storeName,
      sessionKey,
      // The budget fits exactly two persisted queries, so keeping three
      // loaded in memory forces one of them out of persistence.
      maxQueryBytes: sumPersistedEntryBytes(
        getLocalListQueryEntrySizeBytes(projectsQuery, [
          storeItemKey('projects', 1),
        ]),
        getLocalListQueryEntrySizeBytes(tasksQuery, [storeItemKey('tasks', 1)]),
      ),
      serverData: {
        users: [{ id: 1, name: 'User 1' }],
        projects: [{ id: 1, name: 'Project 1' }],
        tasks: [{ id: 1, name: 'Task 1' }],
      },
    });

    await settleStartupBackgroundScan();

    // Fetch three queries with real time gaps so persisted recency is
    // unambiguous: users is the oldest, tasks the newest.
    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    env.scheduleFetch('highPriority', projectsQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    env.scheduleFetch('highPriority', tasksQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    await waitForScheduledCleanup();

    // The third fetch overflowed the budget and the scheduled cleanup evicted
    // the least recently persisted query (users) even though it is still
    // loaded in memory.
    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.lq.`),
    ).toMatchInlineSnapshot(`['{tableId:"projects"}', '{tableId:"tasks"}']`);

    // Trigger more flushes with a state change that does not alter any
    // persisted query content: refetching tasks yields identical data. The
    // evicted users query must not re-enter storage as if it were freshly
    // accessed and knock out a different survivor.
    env.scheduleFetch('highPriority', tasksQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    await waitForScheduledCleanup();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.lq.`),
    ).toMatchInlineSnapshot(`['{tableId:"projects"}', '{tableId:"tasks"}']`);

    env.scheduleFetch('highPriority', tasksQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    await waitForScheduledCleanup();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.lq.`),
    ).toMatchInlineSnapshot(`['{tableId:"projects"}', '{tableId:"tasks"}']`);
  });

  test('a budget-evicted in-state item stays evicted across later flushes instead of churning back into storage', async () => {
    const storeName = 'lq-item-budget-stability';
    const sessionKey = 'sess1';
    const env = createListQueryEnv({
      storeName,
      sessionKey,
      // The budget fits exactly two persisted items, so keeping three loaded
      // in memory forces one of them out of persistence.
      maxItemBytes: sumPersistedEntryBytes(
        getLocalListItemEntrySizeBytes(rawItemPayload('users', 2), {
          id: 2,
          name: 'User 2',
        }),
        getLocalListItemEntrySizeBytes(rawItemPayload('users', 3), {
          id: 3,
          name: 'User 3',
        }),
      ),
      serverData: {
        users: [
          { id: 1, name: 'User 1' },
          { id: 2, name: 'User 2' },
          { id: 3, name: 'User 3' },
        ],
      },
    });

    await settleStartupBackgroundScan();

    // Fetch three standalone items with real time gaps so persisted recency
    // is unambiguous: users||1 is the oldest, users||3 the newest.
    env.apiStore.scheduleItemFetch('highPriority', rawItemPayload('users', 1));
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    env.apiStore.scheduleItemFetch('highPriority', rawItemPayload('users', 2));
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    env.apiStore.scheduleItemFetch('highPriority', rawItemPayload('users', 3));
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    await waitForScheduledCleanup();

    // The third fetch overflowed the budget and the scheduled cleanup evicted
    // the least recently persisted item (users||1) even though it is still
    // loaded in memory.
    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`),
    ).toMatchInlineSnapshot(`['"users||2', '"users||3']`);

    // Trigger more flushes with a state change that does not alter any
    // persisted item content: refetching users||3 yields identical data. The
    // evicted users||1 item must not re-enter storage as if it were freshly
    // accessed and knock out a different survivor.
    env.apiStore.scheduleItemFetch('highPriority', rawItemPayload('users', 3));
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    await waitForScheduledCleanup();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`),
    ).toMatchInlineSnapshot(`['"users||2', '"users||3']`);

    env.apiStore.scheduleItemFetch('highPriority', rawItemPayload('users', 3));
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    await waitForScheduledCleanup();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`),
    ).toMatchInlineSnapshot(`['"users||2', '"users||3']`);
  });
});
