import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getDefaultMaxBytesForScope } from '../../../src/persistentStorage/persistentStorageDefaults';
import { scheduleLocalStorageMaintenance } from '../../../src/persistentStorage/persistentStorageManager';
import { localPersistentStorage } from '../../../src/persistentStorage/storageAdapter';
import type { ListQueryParams } from '../../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../../utils/genericTestUtils';
import {
  getLocalStorageTree,
  getParsedLocalStorageValue,
  startPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
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
  test('maintenance aborts when the active session changes between query and item scans', async () => {
    const storeName = 'list-query-session-switch-maintenance';
    let activeSessionKey = 'session-a';
    const idleCallbacks = new Map<number, IdleRequestCallback>();
    let nextIdleCallbackId = 1;
    let lockRequestCount = 0;
    let sessionSwitched = false;

    for (const sessionKey of ['session-a', 'session-b']) {
      setCachedItem(storeName, sessionKey, 'users', 1, {
        id: 1,
        name: `${sessionKey} oldest user`,
      });
      vi.setSystemTime(Date.now() + 1);
      setCachedItem(storeName, sessionKey, 'users', 2, {
        id: 2,
        name: `${sessionKey} newest user`,
      });
      setCachedQuery(
        storeName,
        sessionKey,
        { tableId: 'users' },
        [storeItemKey('users', 1), storeItemKey('users', 2)],
        sessionKey === 'session-b',
      );
      vi.setSystemTime(Date.now() + 1);
    }

    vi.stubGlobal(
      'requestIdleCallback',
      (callback: IdleRequestCallback): number => {
        const callbackId = nextIdleCallbackId++;
        idleCallbacks.set(callbackId, callback);
        return callbackId;
      },
    );
    vi.stubGlobal('cancelIdleCallback', (callbackId: number) => {
      idleCallbacks.delete(callbackId);
    });
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: {
        async request<T>(
          _name: string,
          callback: () => T | Promise<T>,
        ): Promise<T> {
          const result = await callback();
          lockRequestCount++;

          // The query snapshot belongs to session A. Before item cleanup can
          // begin, login state changes and the same store now points at B.
          if (lockRequestCount === 3) {
            activeSessionKey = 'session-b';
            sessionSwitched = true;
          }

          return result;
        },
      },
      writable: true,
    });

    createListQueryEnv({
      storeName,
      getSessionKey: () => activeSessionKey,
      maxItemBytes: getLocalListItemEntrySizeBytes(rawItemPayload('users', 2), {
        id: 2,
        name: 'session-b newest user',
      }),
    });
    const sessionAItemPrefix = `tsdf.session-a.${storeName}.li.`;
    scheduleLocalStorageMaintenance([
      localPersistentStorage.getManifestKeyForPrefix(sessionAItemPrefix),
    ]);

    const nextCallbackEntry = idleCallbacks.entries().next().value;
    if (nextCallbackEntry === undefined) {
      throw new Error('Expected a scheduled idle maintenance callback.');
    }
    const [callbackId, callback] = nextCallbackEntry;
    idleCallbacks.delete(callbackId);
    callback({ didTimeout: false, timeRemaining: () => 50 });
    for (let pass = 0; pass < 200; pass++) await Promise.resolve();

    expect({
      sessionBItems: [1, 2].map((id) =>
        persistentStore
          .scope(storeName, 'session-b')
          .listQuery.readItemData('users', id),
      ),
      sessionSwitched,
    }).toMatchInlineSnapshot(`
      sessionBItems:
        - { id: 1, name: 'session-b oldest user' }
        - { id: 2, name: 'session-b newest user' }
      sessionSwitched: '✅'
    `);
  });

  test('item maintenance does not overwrite a query changed while cleanup is yielding', async () => {
    const storeName = 'list-query-interrupted-maintenance';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const oldestItemStorageKey = setCachedItem(
      storeName,
      sessionKey,
      'users',
      1,
      { id: 1, name: 'Oldest user' },
    );
    vi.setSystemTime(Date.now() + 1);
    setCachedItem(storeName, sessionKey, 'users', 2, {
      id: 2,
      name: 'Newest user',
    });
    const queryStorageKey = setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
      storeItemKey('users', 2),
    ]);
    const idleCallbacks = new Map<number, IdleRequestCallback>();
    let nextIdleCallbackId = 1;

    vi.stubGlobal(
      'requestIdleCallback',
      (callback: IdleRequestCallback): number => {
        const callbackId = nextIdleCallbackId++;
        idleCallbacks.set(callbackId, callback);
        return callbackId;
      },
    );
    vi.stubGlobal('cancelIdleCallback', (callbackId: number): void => {
      idleCallbacks.delete(callbackId);
    });

    createListQueryEnv({
      storeName,
      sessionKey,
      maxItemBytes: sumPersistedEntryBytes(
        getLocalListItemEntrySizeBytes(rawItemPayload('users', 2), {
          id: 2,
          name: 'Newest user',
        }),
      ),
    });

    const itemPrefix = `tsdf.${sessionKey}.${storeName}.li.`;
    scheduleLocalStorageMaintenance([
      localPersistentStorage.getManifestKeyForPrefix(itemPrefix),
    ]);

    async function runNextIdleCallback(
      timeRemaining: () => number,
    ): Promise<void> {
      const nextCallbackEntry = idleCallbacks.entries().next().value;
      if (nextCallbackEntry === undefined) {
        throw new Error('Expected a scheduled idle maintenance callback.');
      }

      const [callbackId, callback] = nextCallbackEntry;
      idleCallbacks.delete(callbackId);
      callback({ didTimeout: false, timeRemaining });

      for (let pass = 0; pass < 100; pass++) {
        await Promise.resolve();
      }
    }

    // End the first slice immediately after it evicts the oldest item, before
    // it can rewrite the query that referenced that item.
    await runNextIdleCallback(() =>
      localStorage.getItem(oldestItemStorageKey) === null ? 0 : 50,
    );
    expect({
      continuationScheduled: idleCallbacks.size,
      oldestItemExists: localStorage.getItem(oldestItemStorageKey) !== null,
    }).toMatchInlineSnapshot(`
      continuationScheduled: 1
      oldestItemExists: '❌'
    `);

    // Another tab refreshes the query while maintenance is suspended. It
    // changes the query but still references the item that maintenance just
    // removed, so the continuation must compare against its old snapshot and
    // the retry must reconcile the refreshed query against stored items.
    setCachedQuery(
      storeName,
      sessionKey,
      usersQuery,
      [storeItemKey('users', 1), storeItemKey('users', 2)],
      true,
    );
    await runNextIdleCallback(() => 50);

    expect(getParsedLocalStorageValue(queryStorageKey)).toMatchInlineSnapshot(`
      a: 1735689600001
      h: '✅'
      i: ['"users||1', '"users||2']
      p: { tableId: 'users' }
    `);

    // The stale comparison schedules a fresh pass. That pass must remove the
    // dangling item reference even though the item was evicted by the prior
    // pass rather than the retry itself.
    expect(idleCallbacks.size).toBe(1);
    await runNextIdleCallback(() => 50);
    expect({
      continuationScheduled: idleCallbacks.size,
      query: getParsedLocalStorageValue(queryStorageKey),
    }).toMatchInlineSnapshot(`
      continuationScheduled: 0
      query:
        a: 1735689600001
        h: '✅'
        i: ['"users||2']
        p: { tableId: 'users' }
    `);
  });

  test('item maintenance retries query reconciliation after a storage write fails', async () => {
    const storeName = 'list-query-reconciliation-write-failure';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const oldestItemStorageKey = setCachedItem(
      storeName,
      sessionKey,
      'users',
      1,
      { id: 1, name: 'Oldest user' },
    );
    vi.setSystemTime(Date.now() + 1);
    setCachedItem(storeName, sessionKey, 'users', 2, {
      id: 2,
      name: 'Newest user',
    });
    const queryStorageKey = setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
      storeItemKey('users', 2),
    ]);
    const idleCallbacks = new Map<number, IdleRequestCallback>();
    let nextIdleCallbackId = 1;

    vi.stubGlobal(
      'requestIdleCallback',
      (callback: IdleRequestCallback): number => {
        const callbackId = nextIdleCallbackId++;
        idleCallbacks.set(callbackId, callback);
        return callbackId;
      },
    );
    vi.stubGlobal('cancelIdleCallback', (callbackId: number) => {
      idleCallbacks.delete(callbackId);
    });

    createListQueryEnv({
      storeName,
      sessionKey,
      maxItemBytes: getLocalListItemEntrySizeBytes(rawItemPayload('users', 2), {
        id: 2,
        name: 'Newest user',
      }),
    });
    const itemPrefix = `tsdf.${sessionKey}.${storeName}.li.`;
    scheduleLocalStorageMaintenance([
      localPersistentStorage.getManifestKeyForPrefix(itemPrefix),
    ]);

    async function runNextIdleCallback(
      timeRemaining: () => number,
    ): Promise<void> {
      const nextCallbackEntry = idleCallbacks.entries().next().value;
      if (nextCallbackEntry === undefined) {
        throw new Error('Expected a scheduled idle maintenance callback.');
      }
      const [callbackId, callback] = nextCallbackEntry;
      idleCallbacks.delete(callbackId);
      callback({ didTimeout: false, timeRemaining });
      for (let pass = 0; pass < 100; pass++) await Promise.resolve();
    }

    // Pause after the payload is removed but before its query is rewritten.
    await runNextIdleCallback(() =>
      localStorage.getItem(oldestItemStorageKey) === null ? 0 : 50,
    );

    const originalSetItem = localStorage.setItem.bind(localStorage);
    let failQueryWrite = true;
    const setItemSpy = vi
      .spyOn(localStorage, 'setItem')
      .mockImplementation((key, value) => {
        if (key === queryStorageKey && failQueryWrite) {
          failQueryWrite = false;
          throw new Error('simulated query write failure');
        }
        originalSetItem(key, value);
      });

    await runNextIdleCallback(() => 50);
    setItemSpy.mockRestore();

    // A failed CAS write is incomplete work, so maintenance must retry after
    // the transient storage failure clears.
    expect(idleCallbacks.size).toBe(1);
    await runNextIdleCallback(() => 50);

    expect(getParsedLocalStorageValue(queryStorageKey)).toMatchInlineSnapshot(`
      a: 1735689600001
      i: ['"users||2']
      p: { tableId: 'users' }
    `);
  });

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
      12s  | 📖 #1 ❌ tsdf._m.g (global maintenance)
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
      .    | 📖 #4 ✅ tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"}
           |    └ (query data, <{tableId:"expired-users"}>) | 0.15 kb
      .    | 📖 #6 ✅ tsdf.sess1.list-query-expiration.lq.{tableId:"fresh-users"}
           |    └ (query data, <{tableId:"fresh-users"}>) | 0.14 kb
      .    | 📖 #3 ✅ tsdf._m.r.n:sess1.list-query-expiration.li.m
           |    └ (items index) | 0.28 kb
      .    | 📖 #7 ❌ tsdf.sess1._o_.s (entry data)
      .    | 🗑️ #2 ✅->❌ tsdf.sess1.list-query-expiration.li."expired-users||1
           |    └ (item data, <"expired-users||1>)
      .    | ✍️ #3 ✅->✅ tsdf._m.r.n:sess1.list-query-expiration.li.m
           |    └ (items index) | 0.28 kb -> 0.14 kb
      .    | 🗑️ #4 ✅->❌ tsdf.sess1.list-query-expiration.lq.{tableId:"expired-users"}
           |    └ (query data, <{tableId:"expired-users"}>)
      .    | ✍️ #1 ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.04 kb
      "
    `);

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.65 kb)
      ├ _m (0.25 kb)
      │ ├ g (0.04 kb)
      │ └ r.n:sess1.list-query-expiration.li.m (0.21 kb)
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
        "fresh-users||2: { a: 1735689600000, p: 'fresh-users||2', z: 55 }
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

  test('startup cleanup enforces maxQueryBytes against preloaded persisted entries', async () => {
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
    createListQueryEnv({
      storeName,
      sessionKey,
      maxQueryBytes: sumPersistedEntryBytes(
        getLocalListQueryEntrySizeBytes(secondQuery, []),
        getLocalListQueryEntrySizeBytes(thirdQuery, []),
      ),
    });
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
      12s  | 📖 #1 ❌ tsdf._m.g (global maintenance)
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

  test('cold startup enforces the local-sync default list-query maxQueryBytes policy before the store mounts', async () => {
    const storeName = 'lq-cold-default-max-queries-sync';
    const sessionKey = 'sess1';
    const listQueryScope = persistentStore.scope(storeName, sessionKey);
    const defaultMaxQueryBytes = getDefaultMaxBytesForScope(
      'local-sync',
      'listQuery.query',
    );
    const largeTableIdSuffix = 'q'.repeat(8_192);
    const getQuery = (index: number) => ({
      tableId: `users-${String(index).padStart(4, '0')}-${largeTableIdSuffix}`,
    });
    const entrySizeBytes = getLocalListQueryEntrySizeBytes(getQuery(0), []);
    const keptQueryCount = Math.floor(defaultMaxQueryBytes / entrySizeBytes);
    const totalQueries = keptQueryCount + 4;

    for (let index = 0; index < totalQueries; index++) {
      listQueryScope.listQuery.seedQuery(getQuery(index), [], {
        timestamp: TEST_INITIAL_TIME.valueOf() + index,
      });
    }

    createListQueryEnv({ storeName, sessionKey });
    await waitForScheduledCleanup();

    const storedQueryKeys = listStoredKeys(
      `tsdf.${sessionKey}.${storeName}.lq.`,
    );

    expect(storedQueryKeys.length).toBeLessThan(totalQueries);
    expect(storedQueryKeys).not.toContain(`{tableId:"${getQuery(0).tableId}"}`);
    expect(storedQueryKeys).toContain(
      `{tableId:"${getQuery(totalQueries - 1).tableId}"}`,
    );
  });

  test('when maxQueryBytes limit is reached a full store cleanup occurs', async () => {
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
      maxQueryBytes: sumPersistedEntryBytes(
        getLocalListQueryEntrySizeBytes(secondQuery, []),
        getLocalListQueryEntrySizeBytes(thirdQuery, [storeItemKey('third', 1)]),
      ),
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
      1.81s | 📖 #1 ❌ tsdf.sess1.lq-query-metadata.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>)
      .     | ✍️ #1 ❌->✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>) | ❌ -> 0.12 kb
      .     | 📖 #2 ❌ tsdf._m.r.n:sess1.lq-query-metadata.li.m (items index)
      .     | ✍️ #3 ❌->✅ tsdf.sess1.lq-query-metadata.li."third||1
            |    └ (item data, <"third||1>) | ❌ -> 0.09 kb
      .     | ✍️ #2 ❌->✅ tsdf._m.r.n:sess1.lq-query-metadata.li.m
            |    └ (items index) | ❌ -> 0.12 kb
            ·
      3.81s | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-query-metadata.li.m
            |    └ (items index) | 0.12 kb
      .     | 🔑[0] #4 ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"first"}
            |    └ (query data, <{tableId:"first"}>)
      .     | 🔑[1] #5 ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"second"}
            |    └ (query data, <{tableId:"second"}>)
      .     | 🔑[2] #6 ✅ tsdf._m.g (global maintenance)
      .     | 🔑[3] #1 ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>)
      .     | 🔑[4] #3 ✅ tsdf.sess1.lq-query-metadata.li."third||1
            |    └ (item data, <"third||1>)
      .     | 🔑[5] #2 ✅ tsdf._m.r.n:sess1.lq-query-metadata.li.m (items index)
      .     | 📖 #4 ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"first"}
            |    └ (query data, <{tableId:"first"}>) | 0.10 kb
      .     | 📖 #5 ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"second"}
            |    └ (query data, <{tableId:"second"}>) | 0.10 kb
      .     | 📖 #1 ✅ tsdf.sess1.lq-query-metadata.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>) | 0.12 kb
      .     | 🗑️ #4 ✅->❌ tsdf.sess1.lq-query-metadata.lq.{tableId:"first"}
            |    └ (query data, <{tableId:"first"}>)
      "
    `);

    expect(
      getParsedLocalStorageValue('tsdf._m.r.n:sess1.lq-query-metadata.li.m'),
    ).toMatchInlineSnapshot(`
      e:
        "third||1: { a: 1735689614010, p: 'third||1', z: 44 }
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
      a: 1735689614010
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
      maxQueryBytes: Math.max(
        sumPersistedEntryBytes(
          getLocalListQueryEntrySizeBytes(firstQuery, []),
          getLocalListQueryEntrySizeBytes(secondQuery, []),
        ),
        sumPersistedEntryBytes(
          getLocalListQueryEntrySizeBytes(thirdQuery, [
            storeItemKey('third', 1),
          ]),
          getLocalListQueryEntrySizeBytes(fourthQuery, [
            storeItemKey('fourth', 2),
          ]),
        ),
      ),
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
      1.81s | 📖 #1 ❌ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>)
      .     | ✍️ #1 ❌->✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>) | ❌ -> 0.12 kb
      .     | 📖 #2 ❌ tsdf._m.r.n:sess1.lq-coalesced-query-maintenance.li.m
            |    └ (items index)
      .     | ✍️ #3 ❌->✅ tsdf.sess1.lq-coalesced-query-maintenance.li."third||1
            |    └ (item data, <"third||1>) | ❌ -> 0.09 kb
      .     | ✍️ #2 ❌->✅ tsdf._m.r.n:sess1.lq-coalesced-query-maintenance.li.m
            |    └ (items index) | ❌ -> 0.12 kb
            ·
      3.62s | 📖 #4 ❌ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"}
            |    └ (query data, <{tableId:"fourth"}>)
      .     | ✍️ #4 ❌->✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"}
            |    └ (query data, <{tableId:"fourth"}>) | ❌ -> 0.13 kb
      .     | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-coalesced-query-maintenance.li.m
            |    └ (items index) | 0.12 kb
      .     | ✍️ #5 ❌->✅ tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2
            |    └ (item data, <"fourth||2>) | ❌ -> 0.09 kb
      .     | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.lq-coalesced-query-maintenance.li.m
            |    └ (items index) | 0.12 kb -> 0.23 kb
            ·
      3.81s | 📖 #2 ✅ tsdf._m.r.n:sess1.lq-coalesced-query-maintenance.li.m
            |    └ (items index) | 0.23 kb
      .     | 🔑[0] #6 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"}
            |    └ (query data, <{tableId:"first"}>)
      .     | 🔑[1] #7 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"}
            |    └ (query data, <{tableId:"second"}>)
      .     | 🔑[2] #8 ✅ tsdf._m.g (global maintenance)
      .     | 🔑[3] #1 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>)
      .     | 🔑[4] #3 ✅ tsdf.sess1.lq-coalesced-query-maintenance.li."third||1
            |    └ (item data, <"third||1>)
      .     | 🔑[5] #2 ✅ tsdf._m.r.n:sess1.lq-coalesced-query-maintenance.li.m
            |    └ (items index)
      .     | 🔑[6] #4 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"}
            |    └ (query data, <{tableId:"fourth"}>)
      .     | 🔑[7] #5 ✅ tsdf.sess1.lq-coalesced-query-maintenance.li."fourth||2
            |    └ (item data, <"fourth||2>)
      .     | 📖 #6 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"}
            |    └ (query data, <{tableId:"first"}>) | 0.10 kb
      .     | 📖 #7 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"}
            |    └ (query data, <{tableId:"second"}>) | 0.10 kb
      .     | 📖 #1 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"third"}
            |    └ (query data, <{tableId:"third"}>) | 0.12 kb
      .     | 📖 #4 ✅ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"fourth"}
            |    └ (query data, <{tableId:"fourth"}>) | 0.13 kb
      .     | 🗑️ #6 ✅->❌ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"first"}
            |    └ (query data, <{tableId:"first"}>)
      .     | 🗑️ #7 ✅->❌ tsdf.sess1.lq-coalesced-query-maintenance.lq.{tableId:"second"}
            |    └ (query data, <{tableId:"second"}>)
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
      1.81s | 📖 #1 ❌ tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}
            |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}>)
      .     | ✍️ #1 ❌->✅ tsdf.sess1.lq-empty-query-manifest.lq.{filters:[{field:"name",op:"eq",value:"Missing user"}],tableId:"users"}
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

    // Hydrate cached data and settle the automatic revalidation first so the explicit invalidation path stays isolated.
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
    const refetchCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: usersQuery,
        type: 'highPriority',
      });
    });
    await flushInvalidationPersistence();
    const refetchOperations = refetchCapture.finish().timelineString;

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
          "users||1: { a: 1735689614100, p: 'users||1', z: 50 }
      `,
    );
    expect(
      getParsedLocalStorageValue(
        'tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"}',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689615910
      i: []
      p: { tableId: 'users' }
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.sess1.lq-query-becomes-empty.li."users||1',
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Cached user' }
      p: 'users||1'
    `);
    expect(refetchOperations).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | 📖 #1 ✅ tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"}
            |    └ (query data, <{tableId:"users"}>) | 0.12 kb
      .     | ✍️ #1 ✅->✅ tsdf.sess1.lq-query-becomes-empty.lq.{tableId:"users"}
            |    └ (query data, <{tableId:"users"}>) | 0.12 kb -> 0.10 kb
      "
    `);
  });

  test('when maxItemBytes is reached cleanup evicts the oldest unprotected item and rewrites the query', async () => {
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

    const env = createListQueryEnv({
      storeName,
      sessionKey,
      maxItemBytes: Math.max(
        sumPersistedEntryBytes(
          getLocalListItemEntrySizeBytes(rawItemPayload('users', 1), {
            id: 1,
            name: 'Oldest cached',
          }),
          getLocalListItemEntrySizeBytes(rawItemPayload('users', 2), {
            id: 2,
            name: 'Newer cached',
          }),
        ),
        sumPersistedEntryBytes(
          getLocalListItemEntrySizeBytes(rawItemPayload('users', 2), {
            id: 2,
            name: 'Newer cached',
          }),
          getLocalListItemEntrySizeBytes(rawItemPayload('users', 3), {
            id: 3,
            name: 'Fresh',
          }),
        ),
      ),
    });

    // Drain the startup-scheduled global scan before capturing the maxItemBytes flush.
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
           |    └ (items index) | 0.23 kb
      .    | ✍️ #2 ❌->✅ tsdf.sess1.lq-item-metadata.li."users||3
           |    └ (item data, <"users||3>) | ❌ -> 0.09 kb
      .    | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m
           |    └ (items index) | 0.23 kb -> 0.34 kb
           ·
      3s   | 📖 #1 ✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m
           |    └ (items index) | 0.34 kb
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
      .    | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.lq-item-metadata.li.m
           |    └ (items index) | 0.34 kb -> 0.23 kb
      .    | ✍️ #5 ✅->✅ tsdf.sess1.lq-item-metadata.lq.{tableId:"users"}
           |    └ (query data, <{tableId:"users"}>) | 0.15 kb -> 0.12 kb
      "
    `);
  });

  test('maxItemBytes cleanup falls back to protected pinned and recency for preloaded query items and rewrites affected queries', async () => {
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

    createListQueryEnv({
      storeName,
      sessionKey,
      maxItemBytes: sumPersistedEntryBytes(
        getLocalListItemEntrySizeBytes(rawItemPayload('users', 2), {
          id: 2,
          name: 'Alice only',
        }),
        getLocalListItemEntrySizeBytes(rawItemPayload('users', 3), {
          id: 3,
          name: 'Bob only',
        }),
        getLocalListItemEntrySizeBytes(rawItemPayload('users', 4), {
          id: 4,
          name: 'Standalone newest',
        }),
      ),
    });

    // Let the startup-scheduled maintenance enforce maxItemBytes against the preloaded cache.
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
      12s  | 📖 #1 ❌ tsdf._m.g (global maintenance)
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
      .    | 📖 #7 ✅ tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}
           |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>) | 0.25 kb
      .    | 📖 #8 ✅ tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}
           |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}>) | 0.25 kb
      .    | 📖 #3 ✅ tsdf._m.r.n:sess1.lq-shared-item-cleanup.li.m
           |    └ (items index) | 0.44 kb
      .    | 🗑️ #2 ✅->❌ tsdf.sess1.lq-shared-item-cleanup.li."users||1
           |    └ (item data, <"users||1>)
      .    | ✍️ #3 ✅->✅ tsdf._m.r.n:sess1.lq-shared-item-cleanup.li.m
           |    └ (items index) | 0.44 kb -> 0.34 kb
      .    | ✍️ #7 ✅->✅ tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}
           |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}>) | 0.25 kb -> 0.23 kb
      .    | ✍️ #8 ✅->✅ tsdf.sess1.lq-shared-item-cleanup.lq.{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}
           |    └ (query data, <{filters:[{field:"name",op:"eq",value:"Bob"}],tableId:"users"}>) | 0.25 kb -> 0.22 kb
      .    | ✍️ #1 ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.04 kb
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
      a: 1735689614100
      i: ['"users||2']
      p: { tableId: 'users' }
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf.sess1.lq-delete-flow.lq.{filters:[{field:"name",op:"eq",value:"Alice"}],tableId:"users"}',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689614100
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
           |    └ (items index) | 0.23 kb
      .    | ✍️ #4 ✅->✅ tsdf._m.r.n:sess1.lq-delete-flow.li.m
           |    └ (items index) | 0.23 kb -> 0.12 kb
      "
    `);
  });
});
