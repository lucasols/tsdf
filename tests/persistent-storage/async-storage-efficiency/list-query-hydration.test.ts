import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../../utils/genericTestUtils';
import { createOpfsPersistentStorageTestStore } from '../../utils/opfsPersistentStorageTestStore';
import {
  getParsedOpfsFileData,
  startOpfsPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
  captureHookRemount,
  createListQueryEnv,
  flushInvalidationPersistence,
  getAsyncListItemEntrySizeBytes,
  getAsyncListQueryEntrySizeBytes,
  rawItemPayload,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  storeItemKey,
  sumPersistedEntryBytes,
  syncEntriesOfflineProtectedFromSiblingTab,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

describe('async storage efficiency: list-query', () => {
  test('preloadQueryFromStorage hydrates the cached list query once and keeps later preloads and direct reads in memory', async () => {
    const storeName = 'lq-preload-query-state';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadQueryFromStorage(usersQuery),
      ),
    ).toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);
    expect(preloadCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/lq-preload-query-state (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/lq-preload-query-state/lq._i.r.json
           |    └ (queries index)
      3ms  | 📖 #1 tsdf/sess1/lq-preload-query-state/lq._i.r.json
           |    └ (queries index) | 0.16 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-preload-query-state/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>)
      7ms  | 📖 #2 tsdf/sess1/lq-preload-query-state/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>) | 0.03 kb
      10ms | 👁️ #3 file-open ✅ tsdf/sess1/lq-preload-query-state/li._i.r.json
           |    └ (items index)
      11ms | 📖 #3 tsdf/sess1/lq-preload-query-state/li._i.r.json
           |    └ (items index) | 0.12 kb
      14ms | 👁️ #4 file-open ✅ tsdf/sess1/lq-preload-query-state/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      15ms | 📖 #4 tsdf/sess1/lq-preload-query-state/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.06 kb
      18ms | end
      "
    `);

    // Once preloaded, repeated explicit preload calls should reuse in-memory state without new storage work.
    const repeatedPreloadCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadQueryFromStorage(usersQuery),
      ),
    ).toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);
    await advanceTime(100);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadQueryFromStorage(usersQuery),
      ),
    ).toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);
    await advanceTime(100);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadQueryFromStorage(usersQuery),
      ),
    ).toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);
    expect(
      repeatedPreloadCapture.finish().timelineString,
    ).toMatchInlineSnapshot(`"empty"`);

    // Repeated direct reads should also reuse in-memory query and item state without new storage work.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
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
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(operationsBreakdown).toMatchInlineSnapshot(`"empty"`);
  });

  test('preloadItemFromStorage hydrates the cached standalone list-query item once and keeps later preloads and direct reads in memory', async () => {
    const storeName = 'lq-preload-item-state';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 1)),
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||1', preloaded: '✅' }`);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 2)),
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||2', preloaded: '✅' }`);
    expect(preloadCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/lq-preload-item-state (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/lq-preload-item-state/li._i.r.json
           |    └ (items index)
      3ms  | 📖 #1 tsdf/sess1/lq-preload-item-state/li._i.r.json
           |    └ (items index) | 0.23 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-preload-item-state/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      7ms  | 📖 #2 tsdf/sess1/lq-preload-item-state/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.06 kb
      10ms | 👁️ #3 file-open ✅ tsdf/sess1/lq-preload-item-state/li.h~1937155452.p.json
           |    └ (item data, <"users||2>)
      11ms | 📖 #3 tsdf/sess1/lq-preload-item-state/li.h~1937155452.p.json
           |    └ (item data, <"users||2>) | 0.07 kb
      14ms | end
      "
    `);

    // Once preloaded, repeated explicit preload calls should reuse in-memory state without new storage work.
    const repeatedPreloadCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 1)),
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||1', preloaded: '✅' }`);
    await advanceTime(100);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 1)),
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||1', preloaded: '✅' }`);
    await advanceTime(100);
    expect(
      await resolveAfterAllTimers(
        env.apiStore.preloadItemFromStorage(rawItemPayload('users', 1)),
      ),
    ).toMatchInlineSnapshot(`- { payload: 'users||1', preloaded: '✅' }`);
    expect(
      repeatedPreloadCapture.finish().timelineString,
    ).toMatchInlineSnapshot(`"empty"`);

    // Repeated direct reads should also reuse in-memory state without new storage work.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
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
    await flushAllTimers();
    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(
      `"empty"`,
    );
  });

  test('useListQuery invalidation snapshots the full query persistence timeline through the refetch save', async () => {
    const storeName = 'lq-query-invalidation-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
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
      getParsedOpfsFileData(
        'tsdf/sess1/lq-query-invalidation-flow/lq._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"users"}:
          a: 1735689600000
          p: { tableId: 'users' }
          z: 57
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-query-invalidation-flow/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`['"users||1']`);
    expect(refetchOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.852s | ✍️ #1 tsdf/sess1/lq-query-invalidation-flow/li.h~228010772.p.json
             |    └ (item data, <"users||1>) | 0.06 kb -> 0.05 kb
      1.856s | ✍️ #2 tsdf/sess1/lq-query-invalidation-flow/li._i.r.json
             |    └ (items index) | 0.12 kb -> 0.12 kb
      1.858s | end
      "
    `);
  });

  test('repeated invalidations within the debounce window coalesce list-query persistence writes', async () => {
    const storeName = 'lq-coalesced-invalidations';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
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

    expect(hook.result.current.items).toMatchInlineSnapshot(
      `- { id: 1, name: 'Fresh user 2' }`,
    );
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-coalesced-invalidations/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Fresh user 2'
    `);
    expect(secondRefetchOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.852s | ✍️ #1 tsdf/sess1/lq-coalesced-invalidations/li.h~228010772.p.json
             |    └ (item data, <"users||1>) | 0.06 kb -> 0.06 kb
      1.856s | ✍️ #2 tsdf/sess1/lq-coalesced-invalidations/li._i.r.json
             |    └ (items index) | 0.12 kb -> 0.12 kb
      1.858s | end
      "
    `);
  });

  test('list-query invalidation preserves offline markers added by another tab before item and query manifest updates', async () => {
    const storeName = 'lq-offline-marker-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
    await syncEntriesOfflineProtectedFromSiblingTab(sessionKey, [
      itemStorageKey,
      queryStorageKey,
    ]);

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
      getParsedOpfsFileData('tsdf/sess1/lq-offline-marker-flow/li._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        "users||1: { a: 1735689600000, o: '✅', p: 'users||1', z: 62 }
        "users||2: { a: 1735689613968, p: 'users||2', z: 63 }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-offline-marker-flow/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Fresh user'
    `);
    expect(
      getParsedOpfsFileData('tsdf/sess1/lq-offline-marker-flow/lq._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"users"}:
          a: 1735689600000
          o: '✅'
          p: { tableId: 'users' }
          z: 70
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-offline-marker-flow/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);
  });

  test('query hook remount skips touch writes when the cached query and item are still in the current recency bucket', async () => {
    const storeName = 'lq-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
    expect(firstMountOperations).not.toContain('⚠️ DUPLICATE OPEN');
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/lq-remount-flow (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/lq-remount-flow/lq._i.r.json
           |    └ (queries index)
      3ms  | 📖 #1 tsdf/sess1/lq-remount-flow/lq._i.r.json
           |    └ (queries index) | 0.16 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-remount-flow/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>)
      7ms  | 📖 #2 tsdf/sess1/lq-remount-flow/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>) | 0.03 kb
      10ms | 👁️ #3 file-open ✅ tsdf/sess1/lq-remount-flow/li._i.r.json
           |    └ (items index)
      11ms | 📖 #3 tsdf/sess1/lq-remount-flow/li._i.r.json
           |    └ (items index) | 0.12 kb
      14ms | 👁️ #4 file-open ✅ tsdf/sess1/lq-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      15ms | 📖 #4 tsdf/sess1/lq-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.06 kb
      18ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('query hook remount reuses a persisted empty query without treating it as a cache miss', async () => {
    const storeName = 'lq-empty-remount-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
           |    └ (queries index) | 0.16 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-empty-remount-flow/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>)
      7ms  | 📖 #2 tsdf/sess1/lq-empty-remount-flow/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>) | 0.00 kb
      10ms | end
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
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/lq-remount-stale-touch/lq._i.r.json
           |    └ (queries index)
      3ms  | 📖 #1 tsdf/sess1/lq-remount-stale-touch/lq._i.r.json
           |    └ (queries index) | 0.16 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-remount-stale-touch/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>)
      7ms  | 📖 #2 tsdf/sess1/lq-remount-stale-touch/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>) | 0.03 kb
      10ms | 👁️ #3 file-open ✅ tsdf/sess1/lq-remount-stale-touch/li._i.r.json
           |    └ (items index)
      11ms | 📖 #3 tsdf/sess1/lq-remount-stale-touch/li._i.r.json
           |    └ (items index) | 0.12 kb
      14ms | 👁️ #4 file-open ✅ tsdf/sess1/lq-remount-stale-touch/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      15ms | 📖 #4 tsdf/sess1/lq-remount-stale-touch/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.06 kb
           ·
      52ms | ✍️ #1 tsdf/sess1/lq-remount-stale-touch/lq._i.r.json
           |    └ (queries index) | 0.16 kb -> 0.16 kb
      60ms | ✍️ #3 tsdf/sess1/lq-remount-stale-touch/li._i.r.json
           |    └ (items index) | 0.12 kb -> 0.12 kb
      62ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useItem invalidation snapshots the full item persistence timeline through the refetch save', async () => {
    const storeName = 'lq-item-invalidation-flow';
    const sessionKey = 'sess1';
    const itemPayload = rawItemPayload('users', 1);
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
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
      getParsedOpfsFileData(
        'tsdf/sess1/lq-item-invalidation-flow/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Fresh user'
    `);
    expect(refetchOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.81s  | 👁️ #1 file-open ❌ tsdf/sess1/lq-item-invalidation-flow/lq._i.r.json
             |    └ (queries index)
             ·
      1.853s | ✍️ #2 tsdf/sess1/lq-item-invalidation-flow/li.h~228010772.p.json
             |    └ (item data, <"users||1>) | 0.06 kb -> 0.05 kb
      1.857s | ✍️ #3 tsdf/sess1/lq-item-invalidation-flow/li._i.r.json
             |    └ (items index) | 0.12 kb -> 0.12 kb
      1.859s | end
      "
    `);
  });

  test('item hook remount skips the touch write when the cached standalone item is still in the current recency bucket', async () => {
    const storeName = 'lq-item-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
           |    └ (items index) | 0.12 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-item-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      7ms  | 📖 #2 tsdf/sess1/lq-item-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.06 kb
      10ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useMultipleItems remount reuses hydrated standalone list-query items without touching localStorage again', async () => {
    const storeName = 'lq-multi-item-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
           |    └ (items index) | 0.23 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-multi-item-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      .    | 👁️ #3 file-open ✅ tsdf/sess1/lq-multi-item-remount-flow/li.h~1937155452.p.json
           |    └ (item data, <"users||2>)
      7ms  | 📖 #2 tsdf/sess1/lq-multi-item-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.06 kb
      .    | 📖 #3 tsdf/sess1/lq-multi-item-remount-flow/li.h~1937155452.p.json
           |    └ (item data, <"users||2>) | 0.06 kb
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
    const mockAdapter = createOpfsPersistentStorageTestStore({});
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
    expect(firstMountOperations).not.toContain('⚠️ DUPLICATE OPEN');
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/lq-multi-query-remount-flow
           |    └ (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/lq._i.r.json
           |    └ (queries index)
      3ms  | 📖 #1 tsdf/sess1/lq-multi-query-remount-flow/lq._i.r.json
           |    └ (queries index) | 0.31 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>)
      .    | 👁️ #3 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/lq.h~2044383828.p.json
           |    └ (query data, <{tableId:"projects"}>)
      7ms  | 📖 #2 tsdf/sess1/lq-multi-query-remount-flow/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>) | 0.03 kb
      .    | 📖 #3 tsdf/sess1/lq-multi-query-remount-flow/lq.h~2044383828.p.json
           |    └ (query data, <{tableId:"projects"}>) | 0.03 kb
      10ms | 👁️ #4 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/li._i.r.json
           |    └ (items index)
      11ms | 📖 #4 tsdf/sess1/lq-multi-query-remount-flow/li._i.r.json
           |    └ (items index) | 0.24 kb
      14ms | 👁️ #5 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      .    | 👁️ #6 file-open ✅ tsdf/sess1/lq-multi-query-remount-flow/li.h~2924752681.p.json
           |    └ (item data, <"projects||1>)
      15ms | 📖 #5 tsdf/sess1/lq-multi-query-remount-flow/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.06 kb
      .    | 📖 #6 tsdf/sess1/lq-multi-query-remount-flow/li.h~2924752681.p.json
           |    └ (item data, <"projects||1>) | 0.06 kb
      18ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('updating a hydrated list-query item writes the mutation without rereading cached entries', async () => {
    const storeName = 'lq-mutation-flow';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({});
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
    await flushAllTimers();

    // Mutating the already-hydrated item should only need writes.
    const mutationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.apiStore.updateItemState(rawItemPayload('users', 1), (draft) => {
        draft.name = 'Edited user';
      });
    });
    await advanceTime(1100);
    await flushAllTimers();
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-mutation-flow/li.<"users||1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Edited user'
    `);
    expect(getParsedOpfsFileData('tsdf/sess1/lq-mutation-flow/li._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          "users||1: { a: 1735689600000, p: 'users||1', z: 63 }
      `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.042s | ✍️ #1 tsdf/sess1/lq-mutation-flow/li.h~228010772.p.json
             |    └ (item data, <"users||1>) | 0.06 kb -> 0.06 kb
      1.044s | end
      "
    `);
  });

  test('list query preload reads only the requested query and its referenced items', async () => {
    const storeName = 'list-query-opfs-efficiency';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
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
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await resolveAfterAllTimers(preloadPromise);

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/list-query-opfs-efficiency
           |    └ (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/list-query-opfs-efficiency/lq._i.r.json
           |    └ (queries index)
      3ms  | 📖 #1 tsdf/sess1/list-query-opfs-efficiency/lq._i.r.json
           |    └ (queries index) | 0.31 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/list-query-opfs-efficiency/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>)
      7ms  | 📖 #2 tsdf/sess1/list-query-opfs-efficiency/lq.h~2902406637.p.json
           |    └ (query data, <{tableId:"users"}>) | 0.05 kb
      10ms | 👁️ #3 file-open ✅ tsdf/sess1/list-query-opfs-efficiency/li._i.r.json
           |    └ (items index)
      11ms | 📖 #3 tsdf/sess1/list-query-opfs-efficiency/li._i.r.json
           |    └ (items index) | 0.35 kb
      14ms | 👁️ #4 file-open ✅ tsdf/sess1/list-query-opfs-efficiency/li.h~228010772.p.json
           |    └ (item data, <"users||1>)
      .    | 👁️ #5 file-open ✅ tsdf/sess1/list-query-opfs-efficiency/li.h~1937155452.p.json
           |    └ (item data, <"users||2>)
      15ms | 📖 #4 tsdf/sess1/list-query-opfs-efficiency/li.h~228010772.p.json
           |    └ (item data, <"users||1>) | 0.05 kb
      .    | 📖 #5 tsdf/sess1/list-query-opfs-efficiency/li.h~1937155452.p.json
           |    └ (item data, <"users||2>) | 0.05 kb
      18ms | end
      "
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
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const env = createListQueryEnv({
      storeName,
      sessionKey,
      maxItemBytes: sumPersistedEntryBytes(
        getAsyncListItemEntrySizeBytes(rawItemPayload('users', 1), {
          id: 1,
          name: 'User 1',
        }),
        getAsyncListItemEntrySizeBytes(rawItemPayload('projects', 1), {
          id: 1,
          name: 'Project 1',
        }),
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
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    env.scheduleFetch('highPriority', projectsQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();
    mockAdapter.clearInstrumentation();
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);

    env.scheduleFetch('highPriority', tasksQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time   |
      1.85s  | 👁️ #1 file-open-or-create 🆕 tsdf/sess1/list-query-opfs-eviction-efficiency/lq.h~4263007875.p.json
             |    └ (query data)
      .      | 🗑️ #2 ✅ tsdf/sess1/list-query-opfs-eviction-efficiency/li.h~228010772.p.json
             |    └ (item data, <"users||1>)
      .      | 👁️ #3 file-open-or-create 🆕 tsdf/sess1/list-query-opfs-eviction-efficiency/li.h~1128283337.p.json
             |    └ (item data)
      1.853s | ✍️ #1 tsdf/sess1/list-query-opfs-eviction-efficiency/lq.h~4263007875.p.json
             |    └ (query data) | 0.00 kb -> 0.03 kb
      .      | ✍️ #3 tsdf/sess1/list-query-opfs-eviction-efficiency/li.h~1128283337.p.json
             |    └ (item data) | 0.00 kb -> 0.05 kb
      1.857s | ✍️ #4 tsdf/sess1/list-query-opfs-eviction-efficiency/lq._i.r.json
             |    └ (queries index) | 0.34 kb -> 0.48 kb
      .      | ✍️ #5 tsdf/sess1/list-query-opfs-eviction-efficiency/li._i.r.json
             |    └ (items index) | 0.27 kb -> 0.27 kb
      1.859s | end
      "
    `);
    expect(mockAdapter.payloadGetRequests).toMatchInlineSnapshot(`[]`);
    expect(mockAdapter.payloadGetManyRequests).toMatchInlineSnapshot(`[]`);
  });

  test('a newly fetched query evicts the least recently used in-state query when the query budget is full', async () => {
    const storeName = 'lq-query-budget-recency';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const tasksQuery = { tableId: 'tasks' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);
    const env = createListQueryEnv({
      storeName,
      sessionKey,
      // The budget fits exactly two persisted queries, so fetching a third
      // must evict one even though all three stay loaded in memory.
      maxQueryBytes: sumPersistedEntryBytes(
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

    // Fetch and persist users, then projects, with a real time gap so their
    // persisted lastAccessAt timestamps differ (users is the oldest).
    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    env.scheduleFetch('highPriority', projectsQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listQuery.listStoredQueryKeys().sort())
      .toMatchInlineSnapshot(`
        ['{tableId:"projects"}', '{tableId:"users"}']
      `);

    // Fetching tasks overflows the query budget. The new query must win a
    // persistence slot: unchanged in-state queries compete with their real
    // persisted recency, so the least recently persisted one (users) is
    // evicted — the fresh fetch is never silently dropped.
    env.scheduleFetch('highPriority', tasksQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listQuery.listStoredQueryKeys().sort())
      .toMatchInlineSnapshot(`
        ['{tableId:"projects"}', '{tableId:"tasks"}']
      `);
    // The evicted query's item is dropped with it — its only reference was
    // the users query, which is no longer persisted.
    expect(listQueryScope.listQuery.listStoredItemKeys().sort())
      .toMatchInlineSnapshot(`
        ['"projects||1', '"tasks||1']
      `);
  });

  test('a budget-evicted in-state query stays evicted across later flushes instead of churning back into storage', async () => {
    const storeName = 'lq-query-budget-stability';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const tasksQuery = { tableId: 'tasks' };
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);
    const env = createListQueryEnv({
      storeName,
      sessionKey,
      // The budget fits exactly two persisted queries, so keeping three
      // loaded in memory forces one of them out of persistence.
      maxQueryBytes: sumPersistedEntryBytes(
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

    // The third fetch overflowed the budget and evicted the least recently
    // persisted query (users) even though it is still loaded in memory.
    expect(listQueryScope.listQuery.listStoredQueryKeys().sort())
      .toMatchInlineSnapshot(`
        ['{tableId:"projects"}', '{tableId:"tasks"}']
      `);

    // Trigger more flushes with a state change that does not alter any
    // persisted query content: refetching tasks yields identical data. The
    // evicted users query must not re-enter storage as if it were freshly
    // accessed and knock out a different survivor — that would make every
    // flush churn remove/re-add writes while the state stays over budget.
    const churnCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);

    env.scheduleFetch('highPriority', tasksQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listQuery.listStoredQueryKeys().sort())
      .toMatchInlineSnapshot(`
        ['{tableId:"projects"}', '{tableId:"tasks"}']
      `);

    env.scheduleFetch('highPriority', tasksQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listQuery.listStoredQueryKeys().sort())
      .toMatchInlineSnapshot(`
        ['{tableId:"projects"}', '{tableId:"tasks"}']
      `);

    // The two follow-up flushes must not have produced any query entry
    // removals or re-writes — the persisted set is already stable.
    expect(churnCapture.finish().timelineString).toMatchInlineSnapshot(
      `"empty"`,
    );
  });

  test('a budget-evicted in-state item stays evicted across later flushes instead of churning back into storage', async () => {
    const storeName = 'lq-item-budget-stability';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const listQueryScope = mockAdapter.scope(storeName, sessionKey);
    const env = createListQueryEnv({
      storeName,
      sessionKey,
      // The budget fits exactly two persisted standalone items, so keeping
      // three loaded in memory forces one of them out of persistence.
      maxItemBytes: sumPersistedEntryBytes(
        getAsyncListItemEntrySizeBytes(rawItemPayload('users', 2), {
          id: 2,
          name: 'User 2',
        }),
        getAsyncListItemEntrySizeBytes(rawItemPayload('users', 3), {
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

    await settleStartupBackgroundScan(mockAdapter);

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

    // The third fetch overflowed the budget and evicted the least recently
    // persisted item (users||1) even though it is still loaded in memory.
    expect(listQueryScope.listQuery.listStoredItemKeys().sort())
      .toMatchInlineSnapshot(`
        ['"users||2', '"users||3']
      `);

    // Trigger more flushes with a state change that does not alter any
    // persisted item content: refetching users||3 yields identical data. The
    // evicted users||1 item must not re-enter storage as if it were freshly
    // accessed and knock out a different survivor.
    const churnCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);

    env.apiStore.scheduleItemFetch('highPriority', rawItemPayload('users', 3));
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listQuery.listStoredItemKeys().sort())
      .toMatchInlineSnapshot(`
        ['"users||2', '"users||3']
      `);

    env.apiStore.scheduleItemFetch('highPriority', rawItemPayload('users', 3));
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listQuery.listStoredItemKeys().sort())
      .toMatchInlineSnapshot(`
        ['"users||2', '"users||3']
      `);

    // The two follow-up flushes must not have produced any item entry
    // removals or re-writes — the persisted set is already stable. The only
    // captured operations are failed opens of the queries index (this test
    // never persists a query, so the file does not exist): read-only probes,
    // no writes and no removals.
    expect(churnCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time   |
      1.81s  | 👁️ #1 file-open ❌ tsdf/sess1/lq-item-budget-stability/lq._i.r.json
             |    └ (queries index)
             ·
      4.721s | 👁️ #1 file-open ❌ tsdf/sess1/lq-item-budget-stability/lq._i.r.json
             |    └ (queries index)
      4.722s | end
      "
    `);
  });
});
