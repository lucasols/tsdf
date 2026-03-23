import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
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
import type {
  ListQueryPersistentStorageConfig,
  PersistentStorageSchema,
} from '../../src/persistentStorage/types';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
} from '../mocks/listQueryStoreTestEnv';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { getParsedOpfsFileData } from '../utils/persistentStorageOptimizationTestUtils';

const rowSchema = __LEGIT_CAST__<PersistentStorageSchema<Row>, unknown>(
  rc_object({ id: rc_number, name: rc_string, age: rc_number.optional() }),
);
type StoredRow = { rowId: number; label: string; age?: number };

const storageSchema = __LEGIT_CAST__<
  PersistentStorageSchema<StoredRow>,
  unknown
>(rc_object({ rowId: rc_number, label: rc_string, age: rc_number.optional() }));
const querySchema = rc_object({ tableId: rc_string });

function createInvalidRow() {
  return __LEGIT_CAST__<Row, { invalid: true }>({ invalid: true });
}

function createConvertedSchemaConfig(
  overrides: {
    convertToStorage?: (value: Row) => StoredRow;
    convertFromStorage?: (value: StoredRow) => Row;
  } = {},
): ListQueryPersistentStorageConfig<Row, ListQueryParams, string, StoredRow> {
  return {
    storeName: 'unused',
    adapter: opfsPersistentStorage,
    schema: {
      storeSchema: rowSchema,
      storageSchema,
      convertToStorage:
        overrides.convertToStorage ??
        ((value) => ({ rowId: value.id, label: value.name, age: value.age })),
      convertFromStorage:
        overrides.convertFromStorage ??
        ((value) => ({ id: value.rowId, name: value.label, age: value.age })),
    },
    itemPayloadSchema: rc_string,
    queryPayloadSchema: querySchema,
  };
}

function listQueryScope(
  mockAdapter: ReturnType<typeof createOpfsPersistentStorageTestStore>,
  storeName: string,
  sessionKey: string,
) {
  return mockAdapter.scope(storeName, sessionKey).listQuery;
}

function createEnv(options: {
  storeName: string;
  sessionKey?: string;
  schemaConfig?: ListQueryPersistentStorageConfig<
    Row,
    ListQueryParams,
    string,
    StoredRow
  >;
  serverData?: Record<string, Row[]>;
  onPersistentStorageError?: (error: unknown) => void;
}) {
  const schemaConfig = options.schemaConfig ?? createConvertedSchemaConfig();

  return createListQueryStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey ?? 'session1',
    persistentStorage: {
      ...schemaConfig,
      storeName: options.storeName,
      onPersistentStorageError: options.onPersistentStorageError,
    },
  });
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});

describe('opfs: converted list query store persistence', () => {
  test('explicit query preload hydrates converted item data before mount', async () => {
    const usersQuery = { tableId: 'users' };
    createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'lq-opfs-converted',
        sessionKey: 'sess1',
        listQuery: {
          items: [
            { tableId: 'users', id: 1, data: { rowId: 1, label: 'Cached' } },
          ],
          queries: [
            { params: usersQuery, items: [{ tableId: 'users', id: 1 }] },
          ],
        },
      },
    });

    // Seed the query entry and its item entry in storage format so preload must convert the item data.
    const env = createEnv({
      storeName: 'lq-opfs-converted',
      sessionKey: 'sess1',
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);

    const renders = createLoggerStore({ arrays: 'all' });

    // After preload, the hook should start from cached data and then refetch the query.
    renderHook(() => {
      const { items, status } = env.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      -> status: refetching ⋅ names: [Cached]
      -> status: success ⋅ names: [Fresh]
      "
    `);
  });

  test('invalid converted cached items are removed during query preload', async () => {
    const usersQuery = { tableId: 'users' };
    const invalidStorageAdapter = createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'lq-opfs-invalid-storage',
        sessionKey: 'sess1',
        listQuery: {
          items: [{ tableId: 'users', id: 1, data: { wrong: true } }],
          queries: [
            { params: usersQuery, items: [{ tableId: 'users', id: 1 }] },
          ],
        },
      },
    });
    const invalidQueryScope = listQueryScope(
      invalidStorageAdapter,
      'lq-opfs-invalid-storage',
      'sess1',
    );
    const throwingAdapter = createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'lq-opfs-throwing',
        sessionKey: 'sess1',
        listQuery: {
          items: [
            { tableId: 'users', id: 1, data: { rowId: 1, label: 'Cached' } },
          ],
          queries: [
            { params: usersQuery, items: [{ tableId: 'users', id: 1 }] },
          ],
        },
      },
    });
    const throwingQueryScope = listQueryScope(
      throwingAdapter,
      'lq-opfs-throwing',
      'sess1',
    );

    const invalidStorageEnv = createEnv({
      storeName: 'lq-opfs-invalid-storage',
      sessionKey: 'sess1',
    });
    const throwingEnv = createEnv({
      storeName: 'lq-opfs-throwing',
      sessionKey: 'sess1',
      schemaConfig: {
        ...createConvertedSchemaConfig({
          convertFromStorage() {
            throw new Error('boom');
          },
        }),
        storeName: 'placeholder',
      },
    });

    const invalidStoragePreload =
      invalidStorageEnv.apiStore.preloadQueryFromStorage(usersQuery);
    await resolveAfterAllTimers(invalidStoragePreload);
    await advanceTime(2100);

    const throwingPreload =
      throwingEnv.apiStore.preloadQueryFromStorage(usersQuery);
    await resolveAfterAllTimers(throwingPreload);
    await advanceTime(2100);

    expect(
      invalidStorageAdapter.has(invalidQueryScope.itemStorageKey('users', 1)),
    ).toBe(false);
    expect(
      throwingAdapter.has(throwingQueryScope.itemStorageKey('users', 1)),
    ).toBe(false);
  });

  test('invalid final data after conversion is removed during query preload', async () => {
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'lq-opfs-invalid-final',
        sessionKey: 'sess1',
        listQuery: {
          items: [
            { tableId: 'users', id: 1, data: { rowId: 1, label: 'Cached' } },
          ],
          queries: [
            { params: usersQuery, items: [{ tableId: 'users', id: 1 }] },
          ],
        },
      },
    });
    const persistedQuery = listQueryScope(
      mockAdapter,
      'lq-opfs-invalid-final',
      'sess1',
    );

    // This entry passes storageSchema and only fails the final storeSchema after conversion.
    const env = createEnv({
      storeName: 'lq-opfs-invalid-final',
      sessionKey: 'sess1',
      schemaConfig: {
        ...createConvertedSchemaConfig({
          convertFromStorage: createInvalidRow,
        }),
        storeName: 'placeholder',
      },
    });

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await resolveAfterAllTimers(preloadPromise);
    await advanceTime(2100);

    expect(mockAdapter.has(persistedQuery.itemStorageKey('users', 1))).toBe(
      false,
    );
  });

  test('write conversion errors are reported without overwriting item entries', async () => {
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'lq-opfs-save-error',
        sessionKey: 'sess1',
        listQuery: {
          items: [
            { tableId: 'users', id: 1, data: { rowId: 1, label: 'Cached' } },
          ],
        },
      },
    });
    const persistedQuery = listQueryScope(
      mockAdapter,
      'lq-opfs-save-error',
      'sess1',
    );
    const usersItemKey = persistedQuery.itemKey('users', 1);

    // Keep an older cached item so the test proves failed writes do not replace it.
    const onPersistentStorageError = vi.fn();
    const env = createEnv({
      storeName: 'lq-opfs-save-error',
      sessionKey: 'sess1',
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
      onPersistentStorageError,
      schemaConfig: {
        ...createConvertedSchemaConfig({
          convertToStorage() {
            throw new Error('cannot-save');
          },
        }),
        storeName: 'placeholder',
      },
    });

    // Query metadata should still be persisted because only item data goes through conversion.
    renderHook(() => {
      env.apiStore.useListQuery(usersQuery, { returnRefetchingStatus: true });
    });

    await flushAllTimers();

    expect(onPersistentStorageError).toHaveBeenCalledTimes(1);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-save-error/li.%22users%7C%7C1.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d: { label: 'Cached', rowId: 1 }
      p: 'users||1'
    `);
    const storedQuery = getParsedOpfsFileData(
      'tsdf/sess1/lq-opfs-save-error/lq.%7BtableId%3A%22users%22%7D.p.json',
    );
    expect(storedQuery).toMatchObject({
      i: [usersItemKey],
      p: { tableId: 'users' },
    });
    expect(storedQuery).not.toHaveProperty('h');
  });
});
