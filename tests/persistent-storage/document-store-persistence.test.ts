import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, renderHook } from '@testing-library/react';
import {
  rc_number,
  rc_object,
  rc_parse_json,
  rc_string,
  rc_to_standard,
  rc_unknown,
} from 'runcheck';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createDocumentStore } from '../../src/documentStore';
import type {
  PersistedDocumentData,
  StorageAdapter,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

const cacheEntryTimestampSchema = rc_object({
  data: rc_unknown,
  timestamp: rc_number,
  version: rc_number,
});

const testDataSchema = rc_object({ name: rc_string, value: rc_number });
const wrappedSchema = rc_object({ value: testDataSchema });

type TestData = { name: string; value: number };
const defaultServerData: TestData = { name: 'test', value: 42 };

function setCachedDocumentData(
  storeName: string,
  sessionKey: string,
  data: TestData,
  version = 1,
) {
  const key = `tsdf.${sessionKey}.${storeName}`;
  const entry: StorageCacheEntry<PersistedDocumentData<{ value: TestData }>> = {
    data: { data: { value: data } },
    timestamp: Date.now(),
    version,
  };
  localStorage.setItem(key, JSON.stringify(entry));
}

function createDocPersistenceEnv(options: {
  storeName: string;
  sessionKey?: string;
  version?: number;
  getSessionKey?: () => string | false;
  serverData?: TestData;
  backend?: 'localStorage' | 'opfs';
  storageAdapter?: StorageAdapter;
}) {
  const getSessionKey =
    options.getSessionKey ?? (() => options.sessionKey ?? 'session1');

  return createDocumentStoreTestEnv(options.serverData ?? defaultServerData, {
    ignoreInitialTimeCheck: true,
    getSessionKey,
    storageAdapter: options.storageAdapter,
    persistentStorage: {
      storeName: options.storeName,
      backend: options.backend ?? 'localStorage',
      schema: wrappedSchema,
      version: options.version,
    },
  });
}

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
});

describe('localStorage: document store persistence', () => {
  test('data is available on first render from cached localStorage', () => {
    setCachedDocumentData('doc1', 'sess1', { name: 'cached', value: 1 });

    const env = createDocPersistenceEnv({
      storeName: 'doc1',
      sessionKey: 'sess1',
    });

    expect(env.store.state).toMatchInlineSnapshot(`
      data:
        value: { name: 'cached', value: 1 }

      error: null
      refetchOnMount: 'lowPriority'
      status: 'success'
    `);
  });

  test('refetch is triggered on mount after hydration', async () => {
    setCachedDocumentData('doc2', 'sess1', { name: 'stale', value: 0 });

    const env = createDocPersistenceEnv({
      storeName: 'doc2',
      sessionKey: 'sess1',
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = env.apiStore.useDocument({
        returnRefetchingStatus: true,
      });

      renders.add({ status, data: data?.value ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {name:stale, value:0}
      -> status: refetching ⋅ data: {name:stale, value:0}
      -> status: success ⋅ data: {name:test, value:42}
      "
    `);
  });

  test('version mismatch causes cached data to be discarded', () => {
    setCachedDocumentData('doc3', 'sess1', { name: 'old', value: 99 }, 1);

    const env = createDocPersistenceEnv({
      storeName: 'doc3',
      sessionKey: 'sess1',
      version: 2, // Different version
    });

    // Should start idle since version doesn't match
    expect(env.store.state).toMatchInlineSnapshot(`
      data: null
      error: null
      refetchOnMount: '❌'
      status: 'idle'
    `);
  });

  test('schema validation failure causes cached data to be discarded', () => {
    // Store invalid data (doesn't match wrapped schema { value: { name, value } })
    const key = 'tsdf.sess1.doc4';
    const entry: StorageCacheEntry<{ data: { invalid: true } }> = {
      data: { data: { invalid: true } },
      timestamp: Date.now(),
      version: 1,
    };
    localStorage.setItem(key, JSON.stringify(entry));

    const env = createDocPersistenceEnv({
      storeName: 'doc4',
      sessionKey: 'sess1',
    });

    expect(env.store.state.data).toBeNull();
    expect(env.store.state.status).toBe('idle');
  });

  test('data is saved to localStorage after successful fetch', async () => {
    const env = createDocPersistenceEnv({
      storeName: 'doc5',
      sessionKey: 'sess1',
    });

    // Mount and trigger fetch
    renderHook(() => env.apiStore.useDocument());
    await flushAllTimers();

    // Wait for debounce to fire (1 second)
    await advanceTime(1100);

    const cached = localStorage.getItem('tsdf.sess1.doc5');
    expect(cached).not.toBeNull();

    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<PersistedDocumentData<{ value: TestData }>>,
      unknown
    >(JSON.parse(cached ?? ''));
    expect(parsed.data.data).toMatchInlineSnapshot(
      `value: { name: 'test', value: 42 }`,
    );
  });

  test('save is debounced - only final state is saved', async () => {
    const env = createDocPersistenceEnv({
      storeName: 'doc6',
      sessionKey: 'sess1',
    });

    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    // Fetch initial data
    renderHook(() => env.apiStore.useDocument());
    await flushAllTimers();

    // Reset spy after initial fetch+save cycle
    setItemSpy.mockClear();

    // Rapidly update state multiple times (within the debounce window)
    act(() => {
      env.apiStore.updateState((draft) => {
        draft.value = { name: 'intermediate', value: 1 };
      });
      env.apiStore.updateState((draft) => {
        draft.value = { name: 'final', value: 99 };
      });
    });

    // Wait for debounce
    await advanceTime(1100);

    // Should have only written once (debounced)
    const writeCount = setItemSpy.mock.calls.filter(
      ([key]) => key === 'tsdf.sess1.doc6',
    ).length;
    expect(writeCount).toBe(1);

    // Saved data should be the final state
    const cached = localStorage.getItem('tsdf.sess1.doc6');
    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<PersistedDocumentData<{ value: TestData }>>,
      unknown
    >(JSON.parse(cached ?? ''));
    expect(parsed.data.data.value).toMatchInlineSnapshot(`
      name: 'final'
      value: 99
    `);

    setItemSpy.mockRestore();
  });

  test('reset clears persisted storage', async () => {
    setCachedDocumentData('doc7', 'sess1', { name: 'to-clear', value: 7 });

    const env = createDocPersistenceEnv({
      storeName: 'doc7',
      sessionKey: 'sess1',
    });

    // Verify data was loaded
    expect(env.store.state.data).not.toBeNull();

    // Reset the store
    env.apiStore.reset();

    // Wait for async clear
    await flushAllTimers();

    // Storage should be cleared
    const cached = localStorage.getItem('tsdf.sess1.doc7');
    expect(cached).toBeNull();
  });

  test('session key isolation - different sessions do not share data', () => {
    setCachedDocumentData('doc8', 'sess-a', { name: 'session-a', value: 1 });

    const env = createDocPersistenceEnv({
      storeName: 'doc8',
      sessionKey: 'sess-b', // Different session
    });

    // Should not load data from different session
    expect(env.store.state.data).toBeNull();
    expect(env.store.state.status).toBe('idle');
  });

//   test('save uses current session key when getSessionKey changes', async () => {
//     let currentSession = 'sess-old';

//     const env = createDocPersistenceEnv({
//       storeName: 'dynamic-session-doc',
//       serverData: { name: 'data', value: 1 },
//       getSessionKey: () => currentSession,
//     });

//     // Fetch data in old session
//     renderHook(() => env.apiStore.useDocument());
//     await flushAllTimers();

//     // Wait for debounced save
//     await advanceTime(1100);

//     // Data should be saved under old session key
//     expect(
//       localStorage.getItem('tsdf.sess-old.dynamic-session-doc'),
//     ).not.toBeNull();

//     // Session changes (e.g., tenant switch)
//     currentSession = 'sess-new';

//     // Trigger another save by invalidating
//     env.apiStore.invalidateData('highPriority');
//     await flushAllTimers();
//     await advanceTime(1100);

//     // Data should be saved under NEW session key, not old one
//     expect(
//       localStorage.getItem('tsdf.sess-new.dynamic-session-doc'),
//     ).not.toBeNull();
//   });

//   test('getSessionKey returning false skips all storage operations', async () => {
//     let sessionReady: string | false = false;

//     setCachedDocumentData('skip-doc', 'eventually-ready', {
//       name: 'cached',
//       value: 1,
//     });

//     const env = createDocPersistenceEnv({
//       storeName: 'skip-doc',
//       serverData: { name: 'server', value: 99 },
//       getSessionKey: () => sessionReady,
//     });

//     // Session not ready — should not have loaded cached data
//     expect(env.store.state.data).toBeNull();
//     expect(env.store.state.status).toBe('idle');

//     // Fetch data while session is still not ready
//     renderHook(() => env.apiStore.useDocument());
//     await flushAllTimers();
//     await advanceTime(1100);

//     // Data should NOT have been saved (session not ready)
//     expect(localStorage.getItem('tsdf.false.skip-doc')).toBeNull();

//     // Session becomes ready
//     sessionReady = 'eventually-ready';

//     // Trigger another save
//     env.apiStore.invalidateData('highPriority');
//     await flushAllTimers();
//     await advanceTime(1100);

//     // Now data should be saved under the real session key
//     expect(
//       localStorage.getItem('tsdf.eventually-ready.skip-doc'),
//     ).not.toBeNull();
//   });

//   test('cached data shows refetching status before settling with server data', async () => {
//     setCachedDocumentData('doc-revalidation', 'sess1', { name: 'stale', value: 1 });

//     const env = createDocPersistenceEnv({
//       storeName: 'doc-revalidation',
//       sessionKey: 'sess1',
//       serverData: { name: 'fresh', value: 99 },
//     });

//     const renders = createLoggerStore();

//     renderHook(() => {
//       const { data, status } = env.apiStore.useDocument({
//         returnRefetchingStatus: true,
//         disableRefetchOnMount: true,
//       });

//       renders.add({ status, data: data?.value ?? null });
//     });

//     await flushAllTimers();

//     expect(renders.changesSnapshot).toMatchInlineSnapshot(`
//       "
//       -> status: success ⋅ data: {name:stale, value:1}
//       -> status: refetching ⋅ data: {name:stale, value:1}
//       -> status: success ⋅ data: {name:fresh, value:99}
//       "
//     `);
//   });

// });

// describe('standard schema support', () => {
//   test('works with Standard Schema v1 via rc_to_standard', () => {
//     const standardSchema = rc_to_standard(testDataSchema);

//     const key = 'tsdf.sess-std.std-doc';
//     const entry: StorageCacheEntry<{ data: TestData }> = {
//       data: { data: { name: 'standard', value: 99 } },
//       timestamp: Date.now(),
//       version: 1,
//     };
//     localStorage.setItem(key, JSON.stringify(entry));

//     const store = createDocumentStore<TestData>({
//       id: 'std-doc',
//       getSessionKey: () => 'sess-std',
//       fetchFn: () => Promise.resolve({ name: 'fresh', value: 1 }),
//       errorNormalizer: normalizeError,
//       lowPriorityThrottleMs: 200,
//       baseCoalescingWindowMs: 10,
//       blockWindowClose: null,
//       persistentStorage: {
//         storeName: 'std-doc',
//         backend: 'localStorage',
//         schema: standardSchema,
//       },
//     });

//     expect(store.store.state.data).toMatchInlineSnapshot(`
//       name: 'standard'
//       value: 99
//     `);
//   });
// });

// describe('opfs: stale hydration guard', () => {
//   function createMockAdapter(readDelayMs: number) {
//     const storage = new Map<string, string>();

//     const adapter: StorageAdapter = {
//       async read<T>(key: string): Promise<T | null> {
//         if (readDelayMs > 0) {
//           await new Promise<void>((resolve) =>
//             setTimeout(resolve, readDelayMs),
//           );
//         }
//         const raw = storage.get(key);
//         if (!raw) return null;
//         return __LEGIT_CAST__<T, unknown>(JSON.parse(raw));
//       },
//       write<T>(key: string, value: T): Promise<void> {
//         storage.set(key, JSON.stringify(value));
//         return Promise.resolve();
//       },
//       remove(key: string): Promise<void> {
//         storage.delete(key);
//         return Promise.resolve();
//       },
//       removeByPrefix(prefix: string): Promise<void> {
//         for (const key of [...storage.keys()]) {
//           if (key.startsWith(prefix)) storage.delete(key);
//         }
//         return Promise.resolve();
//       },
//       listKeys(prefix: string): Promise<string[]> {
//         return Promise.resolve(
//           [...storage.keys()].filter((k) => k.startsWith(prefix)),
//         );
//       },
//     };

//     return { adapter, storage };
//   }

//   function populateStorage(
//     storage: Map<string, string>,
//     storeName: string,
//     sessionKey: string,
//     data: TestData,
//     version = 1,
//   ) {
//     const key = `tsdf.${sessionKey}.${storeName}`;
//     const entry: StorageCacheEntry<PersistedDocumentData<{ value: TestData }>> =
//       {
//         data: { data: { value: data } },
//         timestamp: Date.now(),
//         version,
//       };
//     storage.set(key, JSON.stringify(entry));
//   }

//   test('OPFS hydration works when persistence is still attached', async () => {
//     const { adapter, storage } = createMockAdapter(100);
//     populateStorage(storage, 'opfs-doc', 'session1', {
//       name: 'cached',
//       value: 42,
//     });

//     const env = createDocPersistenceEnv({
//       storeName: 'opfs-doc',
//       backend: 'opfs',
//       storageAdapter: adapter,
//     });

//     // Advance past the read delay so OPFS hydration completes (before mounting)
//     await advanceTime(200);

//     // Store should have been hydrated with cached data
//     expect(env.store.state).toMatchInlineSnapshot(`
//       data:
//         value: { name: 'cached', value: 42 }

//       error: null
//       refetchOnMount: 'lowPriority'
//       status: 'success'
//     `);

//     // Mount the hook — this triggers a refetch due to refetchOnMount: 'lowPriority'
//     renderHook(() => env.apiStore.useDocument());
//     await flushAllTimers();

//     // After refetch, data should be from server
//     expect(env.store.state).toMatchInlineSnapshot(`
//       data:
//         value: { name: 'test', value: 42 }

//       error: null
//       refetchOnMount: '❌'
//       status: 'success'
//     `);
//   });

//   test('reset prevents stale OPFS hydration from modifying store', async () => {
//     const { adapter, storage } = createMockAdapter(100);
//     populateStorage(storage, 'test-dispose', 'session1', {
//       name: 'stale',
//       value: 999,
//     });

//     const env = createDocPersistenceEnv({
//       storeName: 'test-dispose',
//       backend: 'opfs',
//       storageAdapter: adapter,
//     });

//     // Reset immediately before OPFS read completes (disposes persistence)
//     env.apiStore.reset();

//     // Advance past the read delay so the load promise resolves
//     await advanceTime(200);

//     // Store should NOT have been modified by the stale hydration callback
//     // (refetchOnMount is 'lowPriority' because reset() sets it for the next mount)
//     expect(env.store.state).toMatchInlineSnapshot(`
//       data: null
//       error: null
//       refetchOnMount: 'lowPriority'
//       status: 'idle'
//     `);
//   });
// });
