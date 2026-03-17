import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import type {
  PersistedDocumentData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createMockOpfsStorageAdapter } from '../mocks/mockOpfsStorageAdapter';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

const wrappedSchema = rc_object({
  value: rc_object({ name: rc_string, value: rc_number }),
});

type TestData = { name: string; value: number };
const defaultServerData: TestData = { name: 'test', value: 42 };

function createDocPersistenceEnv(options: {
  storeName: string;
  sessionKey?: string;
  version?: number;
  getSessionKey?: () => string | false;
  serverData?: TestData;
  storageAdapter: ReturnType<typeof createMockOpfsStorageAdapter>['adapter'];
}) {
  const getSessionKey =
    options.getSessionKey ?? (() => options.sessionKey ?? 'session1');

  return createDocumentStoreTestEnv(options.serverData ?? defaultServerData, {
    getSessionKey,
    storageAdapter: options.storageAdapter,
    persistentStorage: {
      storeName: options.storeName,
      adapter: opfsPersistentStorage,
      schema: wrappedSchema,
      version: options.version,
    },
  });
}

function populateStorage(
  mockAdapter: ReturnType<typeof createMockOpfsStorageAdapter>,
  storeName: string,
  sessionKey: string,
  data: TestData,
  version: number | undefined = undefined,
) {
  const key = `tsdf.${sessionKey}.${storeName}`;
  const entry: StorageCacheEntry<PersistedDocumentData<{ value: TestData }>> =
    version === undefined
      ? { data: { data: { value: data } }, timestamp: Date.now() }
      : { data: { data: { value: data } }, timestamp: Date.now(), version };

  mockAdapter.setValue(key, entry);

  return key;
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

describe('opfs: document store persistence', () => {
  test('version mismatch cleans up stored entry', async () => {
    const mockAdapter = createMockOpfsStorageAdapter();
    const key = populateStorage(
      mockAdapter,
      'opfs-version-mismatch',
      'sess1',
      { name: 'old', value: 1 },
      1,
    );

    const env = createDocPersistenceEnv({
      storeName: 'opfs-version-mismatch',
      sessionKey: 'sess1',
      version: 2,
      storageAdapter: mockAdapter.adapter,
    });

    await advanceTime(2100);
    await flushAllTimers();

    expect(mockAdapter.has(key)).toBe(true);
    expect(mockAdapter.readRequests).toMatchInlineSnapshot(`[]`);

    await env.apiStore.preloadPersistentStorage();
    await advanceTime(2100);
    await flushAllTimers();

    expect(mockAdapter.readRequests).toEqual([key]);
    expect(mockAdapter.has(key)).toBe(false);
  });

  test('schema validation failure triggers cleanup', async () => {
    const mockAdapter = createMockOpfsStorageAdapter({ readDelayMs: 50 });
    const key = 'tsdf.session1.opfs-cleanup';
    const entry: StorageCacheEntry<PersistedDocumentData<{ badField: true }>> =
      { data: { data: { badField: true } }, timestamp: Date.now(), version: 1 };
    mockAdapter.setValue(key, entry);

    const env = createDocPersistenceEnv({
      storeName: 'opfs-cleanup',
      storageAdapter: mockAdapter.adapter,
    });

    await advanceTime(2100);
    await flushAllTimers();

    expect(mockAdapter.readRequests).toMatchInlineSnapshot(`[]`);

    const preloadPromise = env.apiStore.preloadPersistentStorage();
    await advanceTime(50);
    await preloadPromise;
    await advanceTime(3000);

    expect(mockAdapter.readRequests).toEqual([key]);
    expect(mockAdapter.has(key)).toBe(false);
  });

  test('loads cached data on first read and refetches on mount', async () => {
    const mockAdapter = createMockOpfsStorageAdapter({ readDelayMs: 100 });
    const key = populateStorage(mockAdapter, 'opfs-doc', 'session1', {
      name: 'cached',
      value: 42,
    });

    const env = createDocPersistenceEnv({
      storeName: 'opfs-doc',
      storageAdapter: mockAdapter.adapter,
    });

    await advanceTime(2100);
    await flushAllTimers();

    const renders = createLoggerStore();

    expect(env.store.state).toMatchInlineSnapshot(`
      data: null
      error: null
      refetchOnMount: '❌'
      status: 'idle'
    `);
    expect(mockAdapter.readRequests).toMatchInlineSnapshot(`[]`);

    renderHook(() => {
      const { data, status } = env.apiStore.useDocument({
        returnRefetchingStatus: true,
      });

      renders.add({ status, data: data?.value ?? null });
    });

    await flushAllTimers();

    expect(mockAdapter.readRequests).toEqual([key]);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {name:cached, value:42}
      -> status: refetching ⋅ data: {name:cached, value:42}
      -> status: success ⋅ data: {name:test, value:42}
      "
    `);
  });

  test('explicit preload hydrates cached data before mount', async () => {
    const mockAdapter = createMockOpfsStorageAdapter({ readDelayMs: 100 });
    populateStorage(mockAdapter, 'opfs-preload', 'session1', {
      name: 'cached',
      value: 7,
    });

    const env = createDocPersistenceEnv({
      storeName: 'opfs-preload',
      storageAdapter: mockAdapter.adapter,
      serverData: { name: 'fresh', value: 8 },
    });

    const preloadPromise = env.apiStore.preloadPersistentStorage();
    await advanceTime(100);
    await preloadPromise;

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
      -> status: success ⋅ data: {name:cached, value:7}
      -> status: refetching ⋅ data: {name:cached, value:7}
      -> status: success ⋅ data: {name:fresh, value:8}
      "
    `);
  });

  test('reset prevents stale OPFS hydration from modifying store', async () => {
    const mockAdapter = createMockOpfsStorageAdapter({ readDelayMs: 100 });
    populateStorage(mockAdapter, 'test-dispose', 'session1', {
      name: 'stale',
      value: 999,
    });

    const env = createDocPersistenceEnv({
      storeName: 'test-dispose',
      storageAdapter: mockAdapter.adapter,
    });

    env.apiStore.reset();

    await advanceTime(200);

    expect(env.store.state).toMatchInlineSnapshot(`
      data: null
      error: null
      refetchOnMount: 'lowPriority'
      status: 'idle'
    `);
  });
});
