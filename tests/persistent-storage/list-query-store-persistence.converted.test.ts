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
  PersistedListQueryItemData,
  PersistentStorageSchema,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
} from '../mocks/listQueryStoreTestEnv';
import { createMockLocalStorageStore } from '../mocks/mockLocalStorageStore';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';

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
    backend: 'localStorage',
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
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
});

describe('localStorage: converted list query store persistence', () => {
  test('query reads hydrate converted item data and then refetch', async () => {
    const usersQuery = { tableId: 'users' };
    const mockStore = createMockLocalStorageStore({
      storeName: 'lq-converted-hook',
      sessionKey: 'sess1',
      initialState: {
        listQuery: {
          items: [
            {
              tableId: 'users',
              id: 1,
              data: { rowId: 1, label: 'Cached', age: 20 },
            },
          ],
          queries: [
            { params: usersQuery, items: [{ tableId: 'users', id: 1 }] },
          ],
        },
      },
    });

    // Seed both the query entry and its item entry in storage format.
    const env = createEnv({
      storeName: 'lq-converted-hook',
      sessionKey: 'sess1',
      serverData: { users: [{ id: 1, name: 'Fresh', age: 21 }] },
    });
    const renders = createLoggerStore({ arrays: 'all' });

    // The query hook should hydrate the cached item first and then refetch the query.
    renderHook(() => {
      const { items, status } = env.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    expect(mockStore.listQuery.readItemData<StoredRow>('users', 1))
      .toMatchInlineSnapshot(`
        age: 21
        label: 'Fresh'
        rowId: 1
      `);
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      -> status: refetching ⋅ names: [Cached]
      -> status: success ⋅ names: [Fresh]
      "
    `);
  });

  test('invalid storage data and invalid item payloads are cleaned up on query read', async () => {
    const usersQuery = { tableId: 'users' };
    const invalidStorageStore = createMockLocalStorageStore({
      storeName: 'lq-converted-invalid-storage',
      sessionKey: 'sess1',
      initialState: {
        listQuery: {
          items: [{ tableId: 'users', id: 1, data: { wrong: true } }],
          queries: [
            { params: usersQuery, items: [{ tableId: 'users', id: 1 }] },
          ],
        },
      },
    });
    const invalidPayloadStore = createMockLocalStorageStore({
      storeName: 'lq-converted-invalid-payload',
      sessionKey: 'sess1',
      initialState: {
        listQuery: {
          queries: [
            { params: usersQuery, items: [{ tableId: 'users', id: 1 }] },
          ],
        },
      },
    });

    // Cover the two envelope-level failures together: bad item data and bad item payload.
    const invalidPayloadKey = invalidPayloadStore.listQuery.itemStorageKey(
      'users',
      1,
    );
    invalidPayloadStore.setValue(invalidPayloadKey, {
      data: { data: { rowId: 1, label: 'Cached' }, payload: true },
      timestamp: Date.now(),
      version: 1,
    } satisfies StorageCacheEntry<PersistedListQueryItemData<unknown>>);

    const invalidStorageEnv = createEnv({
      storeName: 'lq-converted-invalid-storage',
      sessionKey: 'sess1',
    });
    const invalidPayloadEnv = createEnv({
      storeName: 'lq-converted-invalid-payload',
      sessionKey: 'sess1',
    });

    expect(
      invalidStorageEnv.apiStore.getQueryState(usersQuery)?.items,
    ).toMatchInlineSnapshot(`[]`);
    expect(
      invalidPayloadEnv.apiStore.getQueryState(usersQuery)?.items,
    ).toMatchInlineSnapshot(`[]`);

    await flushAllTimers();

    expect(
      invalidStorageStore.has(
        invalidStorageStore.listQuery.itemStorageKey('users', 1),
      ),
    ).toBe(false);
    expect(invalidPayloadStore.has(invalidPayloadKey)).toBe(false);
  });

  test('convertFromStorage failures are cleaned up on query read', async () => {
    const usersQuery = { tableId: 'users' };
    const throwingStore = createMockLocalStorageStore({
      storeName: 'lq-converted-throwing',
      sessionKey: 'sess1',
      initialState: {
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
    const invalidFinalStore = createMockLocalStorageStore({
      storeName: 'lq-converted-invalid-final',
      sessionKey: 'sess1',
      initialState: {
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

    // These items pass storageSchema and only fail after conversion/final validation.
    const throwingEnv = createEnv({
      storeName: 'lq-converted-throwing',
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
    const invalidFinalEnv = createEnv({
      storeName: 'lq-converted-invalid-final',
      sessionKey: 'sess1',
      schemaConfig: {
        ...createConvertedSchemaConfig({
          convertFromStorage: createInvalidRow,
        }),
        storeName: 'placeholder',
      },
    });

    expect(
      throwingEnv.apiStore.getQueryState(usersQuery)?.items,
    ).toMatchInlineSnapshot(`[]`);
    expect(
      invalidFinalEnv.apiStore.getQueryState(usersQuery)?.items,
    ).toMatchInlineSnapshot(`[]`);

    await flushAllTimers();

    expect(
      throwingStore.has(throwingStore.listQuery.itemStorageKey('users', 1)),
    ).toBe(false);
    expect(
      invalidFinalStore.has(
        invalidFinalStore.listQuery.itemStorageKey('users', 1),
      ),
    ).toBe(false);
  });

  test('write conversion errors are reported without overwriting item entries', async () => {
    const usersQuery = { tableId: 'users' };
    const mockStore = createMockLocalStorageStore({
      storeName: 'lq-converted-save-error',
      sessionKey: 'sess1',
      initialState: {
        listQuery: {
          items: [
            { tableId: 'users', id: 1, data: { rowId: 1, label: 'Cached' } },
          ],
        },
      },
    });
    const itemKey = mockStore.listQuery.itemKey('users', 1);

    // Keep an older cached item to prove failed writes do not replace it.
    const onPersistentStorageError = vi.fn();
    const env = createEnv({
      storeName: 'lq-converted-save-error',
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

    // Query writes should still succeed because only item data uses the converted format.
    renderHook(() => {
      env.apiStore.useListQuery(usersQuery, { returnRefetchingStatus: true });
    });

    await flushAllTimers();

    expect(onPersistentStorageError).toHaveBeenCalledTimes(1);
    expect(mockStore.listQuery.readItemData<StoredRow>('users', 1))
      .toMatchInlineSnapshot(`
      label: 'Cached'
      rowId: 1
    `);
    expect(mockStore.listQuery.readQueryEntry(usersQuery).data.payload)
      .toMatchInlineSnapshot(`
        tableId: 'users'
      `);
    expect(mockStore.listQuery.readQueryEntry(usersQuery).data.items).toEqual([
      itemKey,
    ]);
    expect(mockStore.listQuery.readQueryEntry(usersQuery).data.hasMore).toBe(
      false,
    );
  });
});
