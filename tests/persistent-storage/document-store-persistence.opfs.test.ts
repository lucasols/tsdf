import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type {
  PersistedDocumentData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createMockOpfsStorageAdapter } from '../mocks/mockOpfsStorageAdapter';
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
    ignoreInitialTimeCheck: true,
    getSessionKey,
    storageAdapter: options.storageAdapter,
    persistentStorage: {
      storeName: options.storeName,
      backend: 'opfs',
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
  version = 1,
) {
  const key = `tsdf.${sessionKey}.${storeName}`;
  const entry: StorageCacheEntry<PersistedDocumentData<{ value: TestData }>> = {
    data: { data: { value: data } },
    timestamp: Date.now(),
    version,
  };

  mockAdapter.setValue(key, entry);

  return key;
}

beforeAll(() => {
  vi.useFakeTimers();
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

    createDocPersistenceEnv({
      storeName: 'opfs-version-mismatch',
      sessionKey: 'sess1',
      version: 2,
      storageAdapter: mockAdapter.adapter,
    });

    expect(mockAdapter.has(key)).toBe(true);

    await advanceTime(2100);
    await flushAllTimers();

    expect(mockAdapter.has(key)).toBe(false);
  });

  test('schema validation failure triggers cleanup', async () => {
    const mockAdapter = createMockOpfsStorageAdapter({ readDelayMs: 50 });
    const key = 'tsdf.session1.opfs-cleanup';
    const entry: StorageCacheEntry<PersistedDocumentData<{ badField: true }>> =
      {
        data: { data: { badField: true } },
        timestamp: Date.now(),
        version: 1,
      };
    mockAdapter.setValue(key, entry);

    createDocPersistenceEnv({
      storeName: 'opfs-cleanup',
      storageAdapter: mockAdapter.adapter,
    });

    await advanceTime(3000);

    expect(mockAdapter.has(key)).toBe(false);
  });

  test('hydrates cached data asynchronously and refetches on mount', async () => {
    const mockAdapter = createMockOpfsStorageAdapter({ readDelayMs: 100 });
    populateStorage(mockAdapter, 'opfs-doc', 'session1', {
      name: 'cached',
      value: 42,
    });

    const env = createDocPersistenceEnv({
      storeName: 'opfs-doc',
      storageAdapter: mockAdapter.adapter,
    });

    const renders = createLoggerStore();

    await advanceTime(200);

    renders.addMark('after hydration');

    renderHook(() => {
      const { data, status } = env.apiStore.useDocument({
        returnRefetchingStatus: true,
      });

      renders.add({ status, data: data?.value ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "

      >>> after hydration

      -> status: success ⋅ data: {name:cached, value:42}
      -> status: refetching ⋅ data: {name:cached, value:42}
      -> status: success ⋅ data: {name:test, value:42}
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
