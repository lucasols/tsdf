import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { rc_object, rc_string } from 'runcheck';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import { createCompactLocalStorageEntry } from '../../src/persistentStorage/compactLocalStorageEntry';
import type { CollectionPersistentStorageConfig } from '../../src/persistentStorage/types';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createMockLocalStorageStore } from '../mocks/mockLocalStorageStore';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';

const itemSchema = rc_object({
  value: rc_object({ id: rc_string, name: rc_string }),
});
const storageSchema = rc_object({ itemId: rc_string, label: rc_string });

type ItemData = { id: string; name: string };

type ItemState = { value: ItemData };

function createInvalidItemState() {
  return __LEGIT_CAST__<ItemState, { invalid: true }>({ invalid: true });
}

type StoredItemState = { itemId: string; label: string };

function createConvertedSchemaConfig(
  overrides: {
    convertToStorage?: (value: ItemState) => StoredItemState;
    convertFromStorage?: (value: StoredItemState) => ItemState;
  } = {},
): CollectionPersistentStorageConfig<ItemState, string, StoredItemState> {
  return {
    storeName: 'unused',
    adapter: 'local-sync',
    schema: {
      storeSchema: itemSchema,
      storageSchema,
      convertToStorage:
        overrides.convertToStorage ??
        ((value) => ({ itemId: value.value.id, label: value.value.name })),
      convertFromStorage:
        overrides.convertFromStorage ??
        ((value) => ({ value: { id: value.itemId, name: value.label } })),
    },
    payloadSchema: rc_string,
  };
}

function createEnv(options: {
  storeName: string;
  sessionKey?: string;
  schemaConfig?: CollectionPersistentStorageConfig<
    ItemState,
    string,
    StoredItemState
  >;
  serverData?: Record<string, ItemData>;
  onPersistentStorageError?: (error: unknown) => void;
}) {
  const schemaConfig = options.schemaConfig ?? createConvertedSchemaConfig();

  return createCollectionStoreTestEnv(options.serverData ?? {}, {
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

describe('localStorage: converted collection store persistence', () => {
  test('first hook read hydrates converted cached items and then refetches', async () => {
    const mockStore = createMockLocalStorageStore({
      storeName: 'col-converted-hook',
      sessionKey: 'sess1',
      initialState: {
        collection: [{ payload: '1', data: { itemId: '1', label: 'Cached' } }],
      },
    });

    // Seed the collection item in storage format so the hook exercises convertFromStorage.
    const env = createEnv({
      storeName: 'col-converted-hook',
      sessionKey: 'sess1',
      serverData: { '1': { id: '1', name: 'Fresh' } },
    });
    const renders = createLoggerStore();

    // A direct item hook read should hydrate immediately and then refetch the fresh server value.
    renderHook(() => {
      const { data, status } = env.apiStore.useItem('1', {
        returnRefetchingStatus: true,
      });

      renders.add({ status, data: data?.value ?? null });
    });

    await flushAllTimers();

    expect(mockStore.collection.readItemData<StoredItemState>('1'))
      .toMatchInlineSnapshot(`
        itemId: '1'
        label: 'Fresh'
      `);
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {id:1, name:Cached}
      -> status: refetching ⋅ data: {id:1, name:Cached}
      -> status: success ⋅ data: {id:1, name:Fresh}
      "
    `);
  });

  test('invalid storage data and invalid payloads are cleaned up on read', async () => {
    const invalidDataStore = createMockLocalStorageStore({
      storeName: 'col-converted-invalid-data',
      sessionKey: 'sess1',
      initialState: { collection: [{ payload: '1', data: { wrong: true } }] },
    });
    const invalidPayloadStore = createMockLocalStorageStore({
      storeName: 'col-converted-invalid-payload',
      sessionKey: 'sess1',
    });

    // Keep data-shape and payload-shape failures together here because both are envelope-validation failures.
    const invalidPayloadKey =
      invalidPayloadStore.collection.itemStorageKey('true');
    invalidPayloadStore.collection.seedItem('true', {
      itemId: '1',
      label: 'Cached',
    });
    const invalidPayloadEntry =
      invalidPayloadStore.collection.readItemEntry<unknown>('true');
    invalidPayloadStore.setValue(
      invalidPayloadKey,
      createCompactLocalStorageEntry(
        { d: invalidPayloadEntry.data.data, p: true },
        invalidPayloadEntry.version,
      ),
    );

    const invalidDataEnv = createEnv({
      storeName: 'col-converted-invalid-data',
      sessionKey: 'sess1',
    });
    const invalidPayloadEnv = createEnv({
      storeName: 'col-converted-invalid-payload',
      sessionKey: 'sess1',
    });

    expect(invalidDataEnv.apiStore.getItemState('1')).toBeUndefined();
    expect(invalidPayloadEnv.apiStore.getItemState('true')).toBeUndefined();

    await flushAllTimers();

    expect(
      invalidDataStore.has(invalidDataStore.collection.itemStorageKey('1')),
    ).toBe(false);
    expect(invalidPayloadStore.has(invalidPayloadKey)).toBe(false);
  });

  test('convertFromStorage failures are cleaned up on read', async () => {
    const throwingStore = createMockLocalStorageStore({
      storeName: 'col-converted-throwing',
      sessionKey: 'sess1',
      initialState: {
        collection: [{ payload: '1', data: { itemId: '1', label: 'Cached' } }],
      },
    });
    const invalidFinalStore = createMockLocalStorageStore({
      storeName: 'col-converted-invalid-final',
      sessionKey: 'sess1',
      initialState: {
        collection: [{ payload: '1', data: { itemId: '1', label: 'Cached' } }],
      },
    });

    // These entries pass storageSchema and only fail after conversion/final validation.
    const throwingEnv = createEnv({
      storeName: 'col-converted-throwing',
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
      storeName: 'col-converted-invalid-final',
      sessionKey: 'sess1',
      schemaConfig: {
        ...createConvertedSchemaConfig({
          convertFromStorage: createInvalidItemState,
        }),
        storeName: 'placeholder',
      },
    });

    expect(throwingEnv.apiStore.getItemState('1')).toBeUndefined();
    expect(invalidFinalEnv.apiStore.getItemState('1')).toBeUndefined();

    await flushAllTimers();

    expect(
      throwingStore.has(throwingStore.collection.itemStorageKey('1')),
    ).toBe(false);
    expect(
      invalidFinalStore.has(invalidFinalStore.collection.itemStorageKey('1')),
    ).toBe(false);
  });

  test('write conversion errors are reported and do not overwrite cached items', async () => {
    const mockStore = createMockLocalStorageStore({
      storeName: 'col-converted-save-error',
      sessionKey: 'sess1',
      initialState: {
        collection: [{ payload: '1', data: { itemId: '1', label: 'Cached' } }],
      },
    });

    // Preserve an old cache entry so the assertion proves failed writes do not replace existing data.
    const onPersistentStorageError = vi.fn();
    const env = createEnv({
      storeName: 'col-converted-save-error',
      sessionKey: 'sess1',
      serverData: { '1': { id: '1', name: 'Fresh' } },
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

    // A successful fetch should still update the store; persistence alone should fail.
    renderHook(() => {
      env.apiStore.useItem('1', { returnRefetchingStatus: true });
    });

    await flushAllTimers();

    expect(onPersistentStorageError).toHaveBeenCalledTimes(1);
    expect(mockStore.collection.readItemData<StoredItemState>('1'))
      .toMatchInlineSnapshot(`
        itemId: '1'
        label: 'Cached'
      `);
  });
});
