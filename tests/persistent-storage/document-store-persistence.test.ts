import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { renderHook } from '@testing-library/react';
import { rc_number, rc_object, rc_string, rc_to_standard } from 'runcheck';
import { Store } from 't-state';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { DocumentStoreState } from '../../src/documentStore';
import { createDocumentStore } from '../../src/documentStore';
import { setupDocumentPersistence } from '../../src/persistentStorage/documentStorePersistence';
import type {
  StorageAdapter,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import type { StoreError } from '../../src/utils/storeShared';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

function normalizeError(exception: Error): StoreError {
  return {
    code: 500,
    id: 'error',
    message: exception.message,
  };
}

type TestData = { name: string; value: number };

const testSchema = rc_object({ name: rc_string, value: rc_number });

function createTestDocumentStore(options: {
  fetchFn?: (signal: AbortSignal) => Promise<TestData>;
  fetchDuration?: number;
  storeName?: string;
  sessionKey?: string;
  version?: number;
  backend?: 'localStorage' | 'opfs';
}) {
  const fetchDuration = options.fetchDuration ?? 800;
  const serverData: TestData = { name: 'test', value: 42 };

  const fetchFn =
    options.fetchFn ??
    (async (signal: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, fetchDuration);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        });
      });
      return serverData;
    });

  const store = createDocumentStore<TestData>({
    fetchFn,
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 200,
    baseCoalescingWindowMs: 10,
    backgroundCoalescingWindowMultiplier: 1,
    blockWindowClose: null,
    persistentStorage: {
      storeName: options.storeName ?? 'test-doc',
      backend: options.backend ?? 'localStorage',
      schema: testSchema,
      version: options.version,
      getSessionKey: () => options.sessionKey ?? 'session1',
    },
  });

  return { store, serverData };
}

function setCachedDocumentData(
  storeName: string,
  sessionKey: string,
  data: TestData,
  version = 1,
) {
  const key = `tsdf.${sessionKey}.${storeName}`;
  const entry: StorageCacheEntry<{ data: TestData }> = {
    data: { data },
    timestamp: Date.now(),
    version,
  };
  localStorage.setItem(key, JSON.stringify(entry));
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

    const { store } = createTestDocumentStore({
      storeName: 'doc1',
      sessionKey: 'sess1',
    });

    expect(store.store.state).toMatchInlineSnapshot(`
      data: { name: 'cached', value: 1 }
      error: null
      refetchOnMount: 'lowPriority'
      status: 'success'
    `);
  });

  test('refetch is triggered on mount after hydration', async () => {
    setCachedDocumentData('doc2', 'sess1', { name: 'stale', value: 0 });

    const { store } = createTestDocumentStore({
      storeName: 'doc2',
      sessionKey: 'sess1',
    });

    // Initial state has data from cache with refetchOnMount
    expect(store.store.state.status).toBe('success');
    expect(store.store.state.refetchOnMount).toBe('lowPriority');

    // Mount the hook to trigger refetch
    renderHook(() => store.useDocument());
    await flushAllTimers();

    // After refetch, data should be from server
    expect(store.store.state).toMatchInlineSnapshot(`
      data: { name: 'test', value: 42 }
      error: null
      refetchOnMount: '❌'
      status: 'success'
    `);
  });

  test('version mismatch causes cached data to be discarded', () => {
    setCachedDocumentData('doc3', 'sess1', { name: 'old', value: 99 }, 1);

    const { store } = createTestDocumentStore({
      storeName: 'doc3',
      sessionKey: 'sess1',
      version: 2, // Different version
    });

    // Should start idle since version doesn't match
    expect(store.store.state).toMatchInlineSnapshot(`
      data: null
      error: null
      refetchOnMount: '❌'
      status: 'idle'
    `);
  });

  test('schema validation failure causes cached data to be discarded', () => {
    // Store invalid data (missing required fields)
    const key = 'tsdf.sess1.doc4';
    const entry: StorageCacheEntry<{ data: { invalid: true } }> = {
      data: { data: { invalid: true } },
      timestamp: Date.now(),
      version: 1,
    };
    localStorage.setItem(key, JSON.stringify(entry));

    const { store } = createTestDocumentStore({
      storeName: 'doc4',
      sessionKey: 'sess1',
    });

    expect(store.store.state.data).toBeNull();
    expect(store.store.state.status).toBe('idle');
  });

  test('data is saved to localStorage after successful fetch', async () => {
    const { store } = createTestDocumentStore({
      storeName: 'doc5',
      sessionKey: 'sess1',
    });

    // Mount and trigger fetch
    renderHook(() => store.useDocument());
    await flushAllTimers();

    // Wait for debounce to fire (1 second)
    await advanceTime(1100);

    const cached = localStorage.getItem('tsdf.sess1.doc5');
    expect(cached).not.toBeNull();

    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<{ data: TestData }>,
      unknown
    >(JSON.parse(cached ?? ''));
    expect(parsed.data.data).toMatchInlineSnapshot(`
      name: 'test'
      value: 42
    `);
  });

  test('save is debounced - only final state is saved', async () => {
    let fetchCount = 0;
    const { store } = createTestDocumentStore({
      storeName: 'doc6',
      sessionKey: 'sess1',
      fetchFn: (signal: AbortSignal) => {
        fetchCount++;
        return new Promise<TestData>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ name: 'fetch', value: fetchCount }),
            100,
          );
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Aborted'));
          });
        });
      },
    });

    renderHook(() => store.useDocument());
    await flushAllTimers();

    // Trigger another fetch
    store.invalidateData('highPriority');
    await flushAllTimers();

    // Wait for debounce
    await advanceTime(1100);

    const cached = localStorage.getItem('tsdf.sess1.doc6');
    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<{ data: TestData }>,
      unknown
    >(JSON.parse(cached ?? ''));
    // Should have the latest data
    expect(parsed.data.data.value).toBe(2);
  });

  test('reset clears persisted storage', async () => {
    setCachedDocumentData('doc7', 'sess1', { name: 'to-clear', value: 7 });

    const { store } = createTestDocumentStore({
      storeName: 'doc7',
      sessionKey: 'sess1',
    });

    // Verify data was loaded
    expect(store.store.state.data).not.toBeNull();

    // Reset the store
    store.reset();

    // Wait for async clear
    await flushAllTimers();

    // Storage should be cleared
    const cached = localStorage.getItem('tsdf.sess1.doc7');
    expect(cached).toBeNull();
  });

  test('session key isolation - different sessions do not share data', () => {
    setCachedDocumentData('doc8', 'sess-a', { name: 'session-a', value: 1 });

    const { store } = createTestDocumentStore({
      storeName: 'doc8',
      sessionKey: 'sess-b', // Different session
    });

    // Should not load data from different session
    expect(store.store.state.data).toBeNull();
    expect(store.store.state.status).toBe('idle');
  });

  test('save uses current session key when getSessionKey changes', async () => {
    let currentSession = 'sess-old';

    const store = createDocumentStore<TestData>({
      fetchFn: async (signal: AbortSignal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Aborted'));
          });
        });
        return { name: 'data', value: 1 };
      },
      errorNormalizer: normalizeError,
      lowPriorityThrottleMs: 200,
      baseCoalescingWindowMs: 10,
      backgroundCoalescingWindowMultiplier: 1,
      blockWindowClose: null,
      persistentStorage: {
        storeName: 'dynamic-session-doc',
        backend: 'localStorage',
        schema: testSchema,
        getSessionKey: () => currentSession,
      },
    });

    // Fetch data in old session
    renderHook(() => store.useDocument());
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
    store.invalidateData('highPriority');
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

    const store = createDocumentStore<TestData>({
      fetchFn: async (signal: AbortSignal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Aborted'));
          });
        });
        return { name: 'server', value: 99 };
      },
      errorNormalizer: normalizeError,
      lowPriorityThrottleMs: 200,
      baseCoalescingWindowMs: 10,
      backgroundCoalescingWindowMultiplier: 1,
      blockWindowClose: null,
      persistentStorage: {
        storeName: 'skip-doc',
        backend: 'localStorage',
        schema: testSchema,
        getSessionKey: () => sessionReady,
      },
    });

    // Session not ready — should not have loaded cached data
    expect(store.store.state.data).toBeNull();
    expect(store.store.state.status).toBe('idle');

    // Fetch data while session is still not ready
    renderHook(() => store.useDocument());
    await flushAllTimers();
    await advanceTime(1100);

    // Data should NOT have been saved (session not ready)
    expect(localStorage.getItem('tsdf.false.skip-doc')).toBeNull();

    // Session becomes ready
    sessionReady = 'eventually-ready';

    // Trigger another save
    store.invalidateData('highPriority');
    await flushAllTimers();
    await advanceTime(1100);

    // Now data should be saved under the real session key
    expect(
      localStorage.getItem('tsdf.eventually-ready.skip-doc'),
    ).not.toBeNull();
  });

  test('fast refetch (<100ms) does not show refetching status', async () => {
    setCachedDocumentData('doc9', 'sess1', { name: 'cached', value: 1 });

    const { store } = createTestDocumentStore({
      storeName: 'doc9',
      sessionKey: 'sess1',
      fetchDuration: 50, // Fast fetch < 100ms
    });

    const statusHistory: string[] = [];

    store.store.subscribe(({ current }) => {
      statusHistory.push(current.status);
    });

    // Trigger refetch
    store.scheduleFetch('lowPriority');
    // Wait for coalescing
    await advanceTime(15);
    // Wait for fetch to complete (50ms < 100ms threshold)
    await advanceTime(60);

    // Should never have shown 'refetching' status
    expect(statusHistory.includes('refetching')).toBe(false);
    // Should end with success
    expect(store.store.state.status).toBe('success');
  });

  test('slow refetch (>100ms) shows refetching status after 100ms', async () => {
    setCachedDocumentData('doc10', 'sess1', { name: 'cached', value: 1 });

    const { store } = createTestDocumentStore({
      storeName: 'doc10',
      sessionKey: 'sess1',
      fetchDuration: 800, // Slow fetch > 100ms
    });

    const statusHistory: string[] = [];

    store.store.subscribe(({ current }) => {
      if (!statusHistory.includes(current.status)) {
        statusHistory.push(current.status);
      }
    });

    // Trigger refetch
    store.scheduleFetch('lowPriority');
    // Wait for coalescing
    await advanceTime(15);

    // At 50ms - still no refetching
    await advanceTime(50);
    expect(store.store.state.status).toBe('success');

    // At 115ms - should show refetching now (100ms delay triggered)
    await advanceTime(60);
    expect(store.store.state.status).toBe('refetching');

    // Complete the fetch
    await flushAllTimers();
    expect(store.store.state.status).toBe('success');

    // Should have shown refetching
    expect(statusHistory).toContain('refetching');
  });

  test('mutation during hydrated refetch does not leave orphaned timer that flips status back to refetching', async () => {
    setCachedDocumentData('doc-supersede', 'session1', {
      name: 'cached',
      value: 1,
    });

    const { store } = createTestDocumentStore({
      storeName: 'doc-supersede',
      sessionKey: 'session1',
    });

    // Mount the hook — triggers lowPriority refetch (simulates app startup)
    renderHook(() => store.useDocument());

    // Wait for coalescing window so the first (hydrated) fetch starts
    await advanceTime(15);
    expect(store.store.state.status).toBe('success'); // still showing cached data

    // User starts a slow mutation while the hydrated refetch is in-flight.
    // This aborts the current fetch. The mutation stays in progress (not ended yet),
    // so no revalidation fetch can start.
    const endMutation = store.startMutation();

    // Advance past the 100ms timer threshold. While the mutation is in progress,
    // no revalidation fetch can start, so the orphaned timer is the only thing
    // that could change the status.
    await advanceTime(200);

    // Status must still be 'success' — the timer should have been cleared on abort,
    // not fire and incorrectly flip the store to 'refetching'.
    expect(store.store.state.status).toBe('success');

    endMutation();
    await flushAllTimers();
  });

  test('hydrated refetch optimization only applies to first fetch', async () => {
    setCachedDocumentData('doc11', 'sess1', { name: 'cached', value: 1 });

    const { store } = createTestDocumentStore({
      storeName: 'doc11',
      sessionKey: 'sess1',
      fetchDuration: 800,
    });

    // First fetch (hydrated) — delay refetching status
    store.scheduleFetch('lowPriority');
    await flushAllTimers();

    // Second fetch — should show refetching immediately
    store.scheduleFetch('highPriority');
    await advanceTime(15); // coalescing window

    // Should show refetching immediately (no delay)
    expect(store.store.state.status).toBe('refetching');

    await flushAllTimers();
  });
});

describe('standard schema support', () => {
  test('works with Standard Schema v1 via rc_to_standard', () => {
    const standardSchema = rc_to_standard(testSchema);

    const key = 'tsdf.sess-std.std-doc';
    const entry: StorageCacheEntry<{ data: TestData }> = {
      data: { data: { name: 'standard', value: 99 } },
      timestamp: Date.now(),
      version: 1,
    };
    localStorage.setItem(key, JSON.stringify(entry));

    const store = createDocumentStore<TestData>({
      fetchFn: () => Promise.resolve({ name: 'fresh', value: 1 }),
      errorNormalizer: normalizeError,
      lowPriorityThrottleMs: 200,
      baseCoalescingWindowMs: 10,
      backgroundCoalescingWindowMultiplier: 1,
      blockWindowClose: null,
      persistentStorage: {
        storeName: 'std-doc',
        backend: 'localStorage',
        schema: standardSchema,
        getSessionKey: () => 'sess-std',
      },
    });

    expect(store.store.state.data).toMatchInlineSnapshot(`
      name: 'standard'
      value: 99
    `);
  });
});

describe('opfs: stale hydration guard', () => {
  function createMockAdapter(readDelayMs: number) {
    const storage = new Map<string, string>();

    const adapter: StorageAdapter = {
      async read<T>(key: string): Promise<T | null> {
        if (readDelayMs > 0) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, readDelayMs),
          );
        }
        const raw = storage.get(key);
        if (!raw) return null;
        return __LEGIT_CAST__<T, unknown>(JSON.parse(raw));
      },
      write<T>(key: string, value: T): Promise<void> {
        storage.set(key, JSON.stringify(value));
        return Promise.resolve();
      },
      remove(key: string): Promise<void> {
        storage.delete(key);
        return Promise.resolve();
      },
      removeByPrefix(prefix: string): Promise<void> {
        for (const key of [...storage.keys()]) {
          if (key.startsWith(prefix)) storage.delete(key);
        }
        return Promise.resolve();
      },
      listKeys(prefix: string): Promise<string[]> {
        return Promise.resolve(
          [...storage.keys()].filter((k) => k.startsWith(prefix)),
        );
      },
    };

    return { adapter, storage };
  }

  function populateStorage(
    storage: Map<string, string>,
    storeName: string,
    sessionKey: string,
    data: TestData,
    version = 1,
  ) {
    const key = `tsdf.${sessionKey}.${storeName}`;
    const entry: StorageCacheEntry<{ data: TestData }> = {
      data: { data },
      timestamp: Date.now(),
      version,
    };
    storage.set(key, JSON.stringify(entry));
  }

  test('OPFS hydration works when persistence is still attached', async () => {
    const { adapter, storage } = createMockAdapter(100);
    populateStorage(storage, 'opfs-doc', 'sess1', {
      name: 'cached',
      value: 42,
    });

    const persistence = setupDocumentPersistence<TestData>(
      {
        storeName: 'opfs-doc',
        backend: 'opfs',
        schema: testSchema,
        getSessionKey: () => 'sess1',
      },
      { adapter },
    );

    const store = new Store<DocumentStoreState<TestData>>({
      state: () => ({
        data: null,
        error: null,
        status: 'idle',
        refetchOnMount: false,
      }),
    });

    const invalidateSpy = vi.fn();
    persistence.attach(store, invalidateSpy);

    // Advance past the read delay so hydration completes
    await advanceTime(200);

    // Store should have been hydrated with cached data
    expect(store.state).toMatchInlineSnapshot(`
      data: { name: 'cached', value: 42 }
      error: null
      refetchOnMount: 'lowPriority'
      status: 'success'
    `);
    expect(invalidateSpy).toHaveBeenCalledWith('lowPriority');

    persistence.dispose();
  });

  test('dispose prevents stale OPFS hydration from modifying store', async () => {
    const { adapter, storage } = createMockAdapter(100);
    populateStorage(storage, 'test-dispose', 'sess1', {
      name: 'stale',
      value: 999,
    });

    const persistence = setupDocumentPersistence<TestData>(
      {
        storeName: 'test-dispose',
        backend: 'opfs',
        schema: testSchema,
        getSessionKey: () => 'sess1',
      },
      { adapter },
    );

    const store = new Store<DocumentStoreState<TestData>>({
      state: () => ({
        data: null,
        error: null,
        status: 'idle',
        refetchOnMount: false,
      }),
    });

    const invalidateSpy = vi.fn();
    persistence.attach(store, invalidateSpy);

    // Dispose BEFORE the delayed read resolves
    persistence.dispose();

    // Advance past the read delay so the load promise resolves
    await advanceTime(200);

    // Store should NOT have been modified by the stale hydration callback
    expect(store.state).toMatchInlineSnapshot(`
      data: null
      error: null
      refetchOnMount: '❌'
      status: 'idle'
    `);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
