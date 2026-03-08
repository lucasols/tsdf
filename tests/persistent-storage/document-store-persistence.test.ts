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
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createDocumentStore } from '../../src/documentStore';
import type {
  PersistedDocumentData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
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

function getStoredEntryTimestamp(key: string): number {
  const raw = localStorage.getItem(key);
  if (raw === null) {
    throw new Error(`Missing localStorage entry for ${key}`);
  }

  const parsed = rc_parse_json(raw, cacheEntryTimestampSchema);
  if (!parsed.ok) {
    throw new Error(`Invalid localStorage entry for ${key}`);
  }

  return parsed.value.timestamp;
}

function createDocPersistenceEnv(options: {
  storeName: string;
  sessionKey?: string;
  version?: number;
  getSessionKey?: () => string | false;
  serverData?: TestData;
  onPersistentStorageError?: (error: unknown) => void;
}) {
  const getSessionKey =
    options.getSessionKey ?? (() => options.sessionKey ?? 'session1');

  return createDocumentStoreTestEnv(options.serverData ?? defaultServerData, {
    getSessionKey,
    persistentStorage: {
      storeName: options.storeName,
      backend: 'localStorage',
      schema: wrappedSchema,
      version: options.version,
      onPersistentStorageError: options.onPersistentStorageError,
    },
  });
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
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

  test('preload reports unavailable async preload through persistent storage error handler', async () => {
    const onPersistentStorageError = vi.fn();
    const env = createDocPersistenceEnv({
      storeName: 'doc-preload-local',
      sessionKey: 'sess1',
      onPersistentStorageError,
    });

    await env.apiStore.preloadPersistentStorage();

    expect(onPersistentStorageError).toHaveBeenCalledTimes(1);
    expect(onPersistentStorageError.mock.calls[0]?.[0]).toMatchObject({
      message: 'Async preload is not available',
    });
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

  test('save uses current session key when getSessionKey changes', async () => {
    let currentSession = 'sess-old';

    const env = createDocPersistenceEnv({
      storeName: 'dynamic-session-doc',
      serverData: { name: 'data', value: 1 },
      getSessionKey: () => currentSession,
    });

    // Fetch data in old session
    renderHook(() => env.apiStore.useDocument());
    await flushAllTimers();

    // Wait for debounced save
    await advanceTime(1100);

    // Data should be saved under old session key
    expect(
      localStorage.getItem('tsdf.sess-old.dynamic-session-doc'),
    ).not.toBeNull();

    // Session changes (e.g., tenant switch)
    currentSession = 'sess-new';

    // Trigger another save by invalidating
    env.apiStore.invalidateData('highPriority');
    await flushAllTimers();
    await advanceTime(1100);

    // Data should be saved under NEW session key, not old one
    expect(
      localStorage.getItem('tsdf.sess-new.dynamic-session-doc'),
    ).not.toBeNull();
  });

  test('getSessionKey returning false skips all storage operations', async () => {
    let sessionReady: string | false = false;

    setCachedDocumentData('skip-doc', 'eventually-ready', {
      name: 'cached',
      value: 1,
    });

    const env = createDocPersistenceEnv({
      storeName: 'skip-doc',
      serverData: { name: 'server', value: 99 },
      getSessionKey: () => sessionReady,
    });

    // Session not ready — should not have loaded cached data
    expect(env.store.state.data).toBeNull();
    expect(env.store.state.status).toBe('idle');

    // Fetch data while session is still not ready
    renderHook(() => env.apiStore.useDocument());
    await flushAllTimers();
    await advanceTime(1100);

    // Data should NOT have been saved (session not ready)
    expect(localStorage.getItem('tsdf.false.skip-doc')).toBeNull();

    // Session becomes ready
    sessionReady = 'eventually-ready';

    // Trigger another save
    env.apiStore.invalidateData('highPriority');
    await flushAllTimers();
    await advanceTime(1100);

    // Now data should be saved under the real session key
    expect(
      localStorage.getItem('tsdf.eventually-ready.skip-doc'),
    ).not.toBeNull();
  });

  test('cached data shows refetching status before settling with server data', async () => {
    setCachedDocumentData('doc-revalidation', 'sess1', {
      name: 'stale',
      value: 1,
    });

    const env = createDocPersistenceEnv({
      storeName: 'doc-revalidation',
      sessionKey: 'sess1',
      serverData: { name: 'fresh', value: 99 },
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
      -> status: success ⋅ data: {name:stale, value:1}
      -> status: refetching ⋅ data: {name:stale, value:1}
      -> status: success ⋅ data: {name:fresh, value:99}
      "
    `);

    expect(env.serverMock.numOfFinishedFetches).toBe(1);
  });

  test('disableRefetchOnMount keeps cached data without refetching', async () => {
    setCachedDocumentData('doc-revalidation-no-refetch', 'sess1', {
      name: 'stale',
      value: 1,
    });
    const key = 'tsdf.sess1.doc-revalidation-no-refetch';
    const originalTimestamp = getStoredEntryTimestamp(key);

    const env = createDocPersistenceEnv({
      storeName: 'doc-revalidation-no-refetch',
      sessionKey: 'sess1',
      serverData: { name: 'fresh', value: 99 },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = env.apiStore.useDocument({
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add({ status, data: data?.value ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {name:stale, value:1}
      "
    `);

    expect(env.serverMock.numOfFinishedFetches).toBe(0);
    expect(getStoredEntryTimestamp(key)).toBeGreaterThan(originalTimestamp);
  });
});

describe('localStorage: invalid data cleanup', () => {
  test('version mismatch cleans up localStorage entry', async () => {
    setCachedDocumentData('cleanup-v', 'sess1', { name: 'old', value: 1 }, 1);

    const env = createDocPersistenceEnv({
      storeName: 'cleanup-v',
      sessionKey: 'sess1',
      version: 2,
    });

    // Entry still exists before idle cleanup fires
    expect(localStorage.getItem('tsdf.sess1.cleanup-v')).not.toBeNull();

    // First read triggers lazy localStorage hydration/cleanup logic
    expect(env.store.state.data).toBeNull();

    // Advance past idle fallback timeout (2000ms)
    await advanceTime(2100);

    // Entry should be cleaned up
    expect(localStorage.getItem('tsdf.sess1.cleanup-v')).toBeNull();
  });

  test('schema validation failure cleans up localStorage entry', async () => {
    const key = 'tsdf.sess1.cleanup-schema';
    const entry: StorageCacheEntry<{ data: { invalid: true } }> = {
      data: { data: { invalid: true } },
      timestamp: Date.now(),
      version: 1,
    };
    localStorage.setItem(key, JSON.stringify(entry));

    const env = createDocPersistenceEnv({
      storeName: 'cleanup-schema',
      sessionKey: 'sess1',
    });

    expect(localStorage.getItem(key)).not.toBeNull();

    expect(env.store.state.data).toBeNull();

    await advanceTime(2100);

    expect(localStorage.getItem(key)).toBeNull();
  });

  test('malformed cache entry cleans up localStorage entry', async () => {
    const key = 'tsdf.sess1.cleanup-malformed';
    localStorage.setItem(
      key,
      JSON.stringify({
        timestamp: Date.now(),
        version: 1,
        wrongShape: true,
      }),
    );

    const env = createDocPersistenceEnv({
      storeName: 'cleanup-malformed',
      sessionKey: 'sess1',
    });

    expect(env.store.state.data).toBeNull();
    expect(env.store.state.status).toBe('idle');
    expect(localStorage.getItem(key)).not.toBeNull();

    await advanceTime(2100);

    expect(localStorage.getItem(key)).toBeNull();
  });

  test('invalid JSON cleans up localStorage entry', async () => {
    const key = 'tsdf.sess1.cleanup-invalid-json';
    localStorage.setItem(key, '{invalid');

    const env = createDocPersistenceEnv({
      storeName: 'cleanup-invalid-json',
      sessionKey: 'sess1',
    });

    expect(env.store.state.data).toBeNull();
    expect(env.store.state.status).toBe('idle');
    expect(localStorage.getItem(key)).not.toBeNull();

    await advanceTime(2100);

    expect(localStorage.getItem(key)).toBeNull();
  });

  test('timestamp is refreshed on successful localStorage read', async () => {
    const originalTimestamp = Date.now() - 100_000;
    const key = 'tsdf.sess1.ts-refresh';
    const entry: StorageCacheEntry<PersistedDocumentData<{ value: TestData }>> =
      {
        data: { data: { value: { name: 'cached', value: 1 } } },
        timestamp: originalTimestamp,
        version: 1,
      };
    localStorage.setItem(key, JSON.stringify(entry));

    const env = createDocPersistenceEnv({
      storeName: 'ts-refresh',
      sessionKey: 'sess1',
    });

    expect(env.store.state.data).toMatchInlineSnapshot(`
      value: { name: 'cached', value: 1 }
    `);

    // Advance past idle fallback timeout
    await advanceTime(2100);

    const raw = localStorage.getItem(key);
    expect(raw).not.toBeNull();

    const parsed = rc_parse_json(raw ?? '', cacheEntryTimestampSchema);
    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      expect(parsed.value.timestamp).toBeGreaterThan(originalTimestamp);
    }
  });
});

describe('standard schema support', () => {
  test('works with Standard Schema v1 via rc_to_standard', () => {
    const standardSchema = rc_to_standard(testDataSchema);

    const key = 'tsdf.sess-std.std-doc';
    const entry: StorageCacheEntry<{ data: TestData }> = {
      data: { data: { name: 'standard', value: 99 } },
      timestamp: Date.now(),
      version: 1,
    };
    localStorage.setItem(key, JSON.stringify(entry));

    const store = createDocumentStore<TestData>({
      id: 'std-doc',
      getSessionKey: () => 'sess-std',
      fetchFn: () => Promise.resolve({ name: 'fresh', value: 1 }),
      errorNormalizer: normalizeError,
      lowPriorityThrottleMs: 200,
      baseCoalescingWindowMs: 10,
      blockWindowClose: null,
      persistentStorage: {
        storeName: 'std-doc',
        backend: 'localStorage',
        schema: standardSchema,
      },
    });

    expect(store.store.state.data).toMatchInlineSnapshot(`
      name: 'standard'
      value: 99
    `);
  });
});
