import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { advanceTime } from '../../utils/genericTestUtils';
import { startIndexedDbPersistentStorageOperationCapture } from '../../utils/indexedDbPersistentStorageOptimizationTestUtils';
import { createIndexedDbPersistentStorageTestStore } from '../../utils/indexedDbPersistentStorageTestStore';
import {
  stripTimelineDurations,
  readListQueryItemNamespaceSnapshot,
  readListQueryQueryNamespaceSnapshot,
  readListQueryItemPayloadSnapshot,
  readListQueryQueryPayloadSnapshot,
} from './listQueryShared';
import {
  captureHookRemount,
  createListQueryEnv,
  flushInvalidationPersistence,
  getAsyncListItemEntrySizeBytes,
  getAsyncListQueryEntrySizeBytes,
  partialResourcesConfig,
  rawItemPayload,
  resolveAfterIndexedDbStorage,
  setProtectedKeysSnapshot,
  settleIndexedDbStorage,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  storeItemKey,
  sumPersistedEntryBytes,
  waitForHookValue,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

describe('indexeddb async storage efficiency: list-query', () => {
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
      1ms | 📖 entries.getMany scope=["sess1","lq-preload-query-state","listQuery.query"] keys=["{tableId:\\"users\\"}"] -> ["{tableId:\\"users\\"}"]
      3ms | 📖 entries.getMany scope=["sess1","lq-preload-query-state","listQuery.item"] keys=["\\"users||1"] -> ["\\"users||1"]
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
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
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
      1ms | 📖 entries.getMany scope=["sess1","lq-preload-item-state","listQuery.item"] keys=["\\"users||1"] -> ["\\"users||1"]
      3ms | 📖 entries.getMany scope=["sess1","lq-preload-item-state","listQuery.item"] keys=["\\"users||2"] -> ["\\"users||2"]
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
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
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

  test("round-trip persistence preserves the fully-loaded ('*') marker for cached items", async () => {
    const storeName = 'lq-full-star-roundtrip';
    const sessionKey = 'sess1';
    const itemPayload = rawItemPayload('users', 1);
    const mockAdapter = createIndexedDbPersistentStorageTestStore();

    // Writer session: fetch the complete item so the fully-loaded ('*') marker
    // must be persisted alongside the item data.
    const writerEnv = createListQueryEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Cached', age: 31, email: 'cached@site.test' }],
      },
    });

    await settleStartupBackgroundScan(mockAdapter);

    writerEnv.apiStore.scheduleItemFetch('highPriority', itemPayload, {
      fields: '*',
    });

    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();

    // The persisted manifest metadata must carry `f: '*'`; if the adapter
    // rejected the marker the entry would be silently dropped on read.
    expect(
      await readListQueryItemNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        "users||1: { a: 1735689613862, f: '*', p: 'users||1' }
    `);
    expect(
      await readListQueryItemPayloadSnapshot({
        id: 1,
        mockAdapter,
        sessionKey,
        storeName,
        tableId: 'users',
      }),
    ).toMatchInlineSnapshot(`
      age: 31
      email: 'cached@site.test'
      id: 1
      name: 'Cached'
    `);

    // Reader session: same storage, but the server now has newer data so we
    // can tell hydrated data ('Cached') apart from fetched data ('Fresh').
    const readerEnv = createListQueryEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', age: 32, email: 'fresh@site.test' }],
      },
    });

    // Hydrate the cached snapshot into the reader before any hook subscribes.
    expect(
      await resolveAfterIndexedDbStorage(
        readerEnv.apiStore.preloadItemFromStorage(itemPayload),
        mockAdapter,
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||1', preloaded: '✅' }`);

    // Hydration restored the fully-loaded marker, so a `fields: '*'` read is
    // satisfiable from the cached snapshot.
    expect(
      readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)],
    ).toBe('*');

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = readerEnv.apiStore.useItem(itemPayload, {
        fields: '*',
        returnRefetchingStatus: true,
      });
      renders.add({ status, name: data?.name ?? null });
    });

    await settleIndexedDbStorage();

    // The hook renders success with the hydrated data right away and only
    // transitions through a background revalidation, never a blocking load.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: Cached
      -> status: refetching ⋅ name: Cached
      -> status: success ⋅ name: Fresh
      "
    `);

    // The only network request is the low-priority revalidation of the
    // hydrated item, not a fields-driven fetch of missing data.
    expect(
      readerEnv.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'item'
        payload: { itemId: 'users||1' }
    `);

    // The marker survives the revalidation.
    expect(
      readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)],
    ).toBe('*');
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
      serverData: { users: [{ id: 1, name: 'Cached user' }] },
    });

    // Hydrate cached data and settle the automatic revalidation first so the explicit invalidation path stays isolated.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Update the server copy, invalidate for the mounted query, then capture fetch completion plus the debounced save.
    const refetchCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
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

    expect(hook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Fresh user' }`,
    );
    expect(
      await readListQueryQueryNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        {tableId:"users"}:
          a: 1735689600000
          p: { tableId: 'users' }
    `);
    expect(
      await readListQueryQueryPayloadSnapshot({
        mockAdapter,
        params: usersQuery,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`['"users||1']`);
    expect(refetchOperations).toMatchInlineSnapshot(`
      ""
      1.812s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-query-invalidation-flow","listQuery.query"] order=lru-desc -> ["{tableId:\\"users\\"}"]
      1.815s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-query-invalidation-flow","listQuery.item"] order=lru-desc -> ["\\"users||1"]
      1.861s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-query-invalidation-flow","listQuery.item"] put=["\\"users||1"] delete=[] touch=[] static-policy
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
      serverData: { users: [{ id: 1, name: 'Cached user' }] },
    });

    // Hydrate cached data and settle the automatic revalidation first so only the invalidation writes are counted below.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Let the first refetch finish, but stay inside the debounced persistence window.
    const firstRefetchCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
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

    expect(hook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Fresh user 1' }`,
    );
    expect(firstRefetchOperations).toMatchInlineSnapshot(`"empty"`);

    // A second refetch before the first debounce flush should replace the pending save.
    const secondRefetchCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.updateItem('users||1', { name: 'Fresh user 2' });
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: usersQuery,
        type: 'highPriority',
      });
    });
    await advanceTime(1900);
    await settleIndexedDbStorage();
    const secondRefetchOperations =
      secondRefetchCapture.finish().timelineString;

    expect(hook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Fresh user 2' }`,
    );
    expect(
      await readListQueryItemPayloadSnapshot({
        id: 1,
        mockAdapter,
        sessionKey,
        storeName,
        tableId: 'users',
      }),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Fresh user 2'
    `);
    expect(secondRefetchOperations).toMatchInlineSnapshot(`
      ""
      1.81s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-coalesced-invalidations","listQuery.query"] order=lru-desc -> ["{tableId:\\"users\\"}"]
      1.81s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-coalesced-invalidations","listQuery.item"] order=lru-desc -> ["\\"users||1"]
      1.85s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-coalesced-invalidations","listQuery.item"] put=["\\"users||1"] delete=[] touch=[] static-policy
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
      serverData: { users: [{ id: 1, name: 'Cached user' }] },
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
    setProtectedKeysSnapshot(sessionKey, [itemStorageKey, queryStorageKey]);

    // The refetch rewrites both namespaces, and should keep the externally-added markers.
    act(() => {
      env.serverTable.setItem('users||1', { id: 1, name: 'Fresh user' });
      env.serverTable.setItem('users||2', { id: 2, name: 'Second user' });
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
      await readListQueryItemNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        "users||1: { a: 1735689600000, o: '✅', p: 'users||1' }
        "users||2: { a: 1735689617832, p: 'users||2' }
    `);
    expect(
      await readListQueryItemPayloadSnapshot({
        id: 1,
        mockAdapter,
        sessionKey,
        storeName,
        tableId: 'users',
      }),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Fresh user'
    `);
    expect(
      await readListQueryQueryNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        {tableId:"users"}:
          a: 1735689600000
          o: '✅'
          p: { tableId: 'users' }
    `);
    expect(
      await readListQueryQueryPayloadSnapshot({
        mockAdapter,
        params: usersQuery,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);
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
        settleTimeMs: 20,
        settleStorageWithoutTimers: true,
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
      ""
      1ms | 📖 entries.getMany scope=["sess1","lq-remount-flow","listQuery.query"] keys=["{tableId:\\"users\\"}"] -> ["{tableId:\\"users\\"}"]
      2ms | 📖 entries.getMany scope=["sess1","lq-remount-flow","listQuery.item"] keys=["\\"users||1"] -> ["\\"users||1"]
      ""
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
        settleTimeMs: 20,
        settleStorageWithoutTimers: true,
        render: () =>
          env.apiStore.useListQuery(usersQuery, {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
      });

    expect(secondHook.result.current.items).toMatchInlineSnapshot(`[]`);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","lq-empty-remount-flow","listQuery.query"] keys=["{tableId:\\"users\\"}"] -> ["{tableId:\\"users\\"}"]
      ""
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
        isReady: (result) => result.items.length === 1,
        mockAdapter,
        postReadySettleTimeMs: 100,
        settleTimeMs: 20,
        settleStorageWithoutTimers: true,
        render: () =>
          env.apiStore.useListQuery(usersQuery, {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
      });

    expect(secondHook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Cached user' }`,
    );
    expect(firstMountOperations).toContain(
      'entries.getMany scope=["sess1","lq-remount-stale-touch","listQuery.query"] keys=["{tableId:\\"users\\"}"] -> ["{tableId:\\"users\\"}"]',
    );
    expect(firstMountOperations).toContain(
      'commit scope=["sess1","lq-remount-stale-touch","listQuery.query"] put=[] delete=[] touch=["{tableId:\\"users\\"}"]',
    );
    expect(firstMountOperations).toContain(
      'entries.getMany scope=["sess1","lq-remount-stale-touch","listQuery.item"] keys=["\\"users||1"] -> ["\\"users||1"]',
    );
    expect(firstMountOperations).toContain(
      'commit scope=["sess1","lq-remount-stale-touch","listQuery.item"] put=[] delete=[] touch=["\\"users||1"]',
    );
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
      serverData: { users: [{ id: 1, name: 'Cached user' }] },
    });

    // Hydrate cached data and settle the automatic revalidation first so the explicit invalidation path stays isolated.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useItem(itemPayload, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Update the server copy, invalidate for the mounted item hook, then capture fetch completion plus the debounced save.
    const refetchCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
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
      await readListQueryItemPayloadSnapshot({
        id: 1,
        mockAdapter,
        sessionKey,
        storeName,
        tableId: 'users',
      }),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Fresh user'
    `);
    expect(refetchOperations).toMatchInlineSnapshot(`
      ""
      1.811s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-item-invalidation-flow","listQuery.query"] order=lru-desc -> []
      1.814s | 🔎 entries.byScopeLastAccessAt scope=["sess1","lq-item-invalidation-flow","listQuery.item"] order=lru-desc -> ["\\"users||1"]
      1.86s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","lq-item-invalidation-flow","listQuery.item"] put=["\\"users||1"] delete=[] touch=[] static-policy
      ""
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
        settleStorageWithoutTimers: true,
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
      ""
      1ms | 📖 entries.getMany scope=["sess1","lq-item-remount-flow","listQuery.item"] keys=["\\"users||1"] -> ["\\"users||1"]
      ""
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
        settleStorageWithoutTimers: true,
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
      ""
      2ms | 📖 entries.getMany scope=["sess1","lq-multi-item-remount-flow","listQuery.item"] keys=["\\"users||1", "\\"users||2"] -> ["\\"users||1", "\\"users||2"]
      ""
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
        isReady: (result) => result.every((query) => query.items.length === 1),
        mockAdapter,
        settleTimeMs: 20,
        settleStorageWithoutTimers: true,
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
    // The exact gap between the two hydrated queries can vary with queued task
    // draining, but the first mount must still hydrate both query rows and both
    // item rows before the remount goes fully hot.
    expect(stripTimelineDurations(firstMountOperations)).toMatchInlineSnapshot(`
      ""
      | 📖 entries.getMany scope=["sess1","lq-multi-query-remount-flow","listQuery.query"] keys=["{tableId:\\"users\\"}"] -> ["{tableId:\\"users\\"}"]
      | 📖 entries.getMany scope=["sess1","lq-multi-query-remount-flow","listQuery.item"] keys=["\\"users||1"] -> ["\\"users||1"]
      | 📖 entries.getMany scope=["sess1","lq-multi-query-remount-flow","listQuery.query"] keys=["{tableId:\\"projects\\"}"] -> ["{tableId:\\"projects\\"}"]
      | 📖 entries.getMany scope=["sess1","lq-multi-query-remount-flow","listQuery.item"] keys=["\\"projects||1"] -> ["\\"projects||1"]
      ""
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
    await waitForHookValue(
      () => env.apiStore.getItemState(rawItemPayload('users', 1)),
      (item) => item?.name === 'Cached user',
    );

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
    await waitForHookValue(
      () => env.apiStore.getItemState(rawItemPayload('users', 1)),
      (item) => item?.name === 'Edited user',
    );
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(env.apiStore.getItemState(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Edited user'
      `);
    expect(
      await readListQueryItemPayloadSnapshot({
        id: 1,
        mockAdapter,
        sessionKey,
        storeName,
        tableId: 'users',
      }),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Edited user'
    `);
    expect(
      await readListQueryItemNamespaceSnapshot({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      entries:
        "users||1: { a: 1735689600000, p: 'users||1' }
    `);
    expect(mutationOperations).toContain(
      'commit scope=["sess1","lq-mutation-flow","listQuery.item"] put=["\\"users||1"] delete=[] touch=[] static-policy',
    );
    expect(mutationOperations).not.toContain('entries.getMany');
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
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await resolveAfterIndexedDbStorage(preloadPromise, mockAdapter);

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","list-query-opfs-efficiency","listQuery.query"] keys=["{tableId:\\"users\\"}"] -> ["{tableId:\\"users\\"}"]
      4ms | 📖 entries.getMany scope=["sess1","list-query-opfs-efficiency","listQuery.item"] keys=["\\"users||1", "\\"users||2"] -> ["\\"users||1", "\\"users||2"]
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
    expect(mockAdapter.payloadGetRequests).toContain(usersQueryKey);
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
      maxItemBytes: Math.max(
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes(rawItemPayload('users', 1), {
            id: 1,
            name: 'User 1',
          }),
          getAsyncListItemEntrySizeBytes(rawItemPayload('projects', 1), {
            id: 1,
            name: 'Project 1',
          }),
        ),
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes(rawItemPayload('projects', 1), {
            id: 1,
            name: 'Project 1',
          }),
          getAsyncListItemEntrySizeBytes(rawItemPayload('tasks', 1), {
            id: 1,
            name: 'Task 1',
          }),
        ),
      ),
      // All three queries fit the query budget — the byte pressure that forces
      // an eviction during the tasks flush comes from maxItemBytes alone.
      maxQueryBytes: sumPersistedEntryBytes(
        getAsyncListQueryEntrySizeBytes(usersQuery, [storeItemKey('users', 1)]),
        getAsyncListQueryEntrySizeBytes(projectsQuery, [
          storeItemKey('projects', 1),
        ]),
        getAsyncListQueryEntrySizeBytes(tasksQuery, [storeItemKey('tasks', 1)]),
      ),
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
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);

    env.scheduleFetch('highPriority', tasksQuery);
    await settleIndexedDbStorage();
    await advanceTime(1100);
    await settleIndexedDbStorage();

    const evictionOperations = readCapture.finish().timelineString;

    expect(evictionOperations).toContain(
      'entries.byScopeLastAccessAt scope=["sess1","list-query-opfs-eviction-efficiency","listQuery.query"] order=lru-desc -> ["{tableId:\\"projects\\"}", "{tableId:\\"users\\"}"]',
    );
    expect(evictionOperations).toContain(
      'commit scope=["sess1","list-query-opfs-eviction-efficiency","listQuery.item"]',
    );
    expect(evictionOperations).not.toContain('entries.getMany');
    expect(mockAdapter.payloadGetRequests).toMatchInlineSnapshot(`[]`);
    expect(mockAdapter.payloadGetManyRequests).toMatchInlineSnapshot(`[]`);
  });
});
