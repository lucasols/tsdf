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
import type { CollectionPersistentStorageConfig } from '../../src/persistentStorage/types';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createMockOpfsStorageAdapter } from '../mocks/mockOpfsStorageAdapter';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

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
    backend: 'opfs',
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
  storageAdapter: ReturnType<typeof createMockOpfsStorageAdapter>['adapter'];
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
    storageAdapter: options.storageAdapter,
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

describe('opfs: converted collection store persistence', () => {
  test('explicit preload hydrates converted cached items before mount', async () => {
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 100,
      storeName: 'col-opfs-converted',
      sessionKey: 'sess1',
      initialState: {
        collection: [{ payload: '1', data: { itemId: '1', label: 'Cached' } }],
      },
    });

    // Preload should hydrate the item from OPFS before any component reads it.
    const env = createEnv({
      storeName: 'col-opfs-converted',
      sessionKey: 'sess1',
      storageAdapter: mockAdapter.adapter,
      serverData: { '1': { id: '1', name: 'Fresh' } },
    });

    const preloadPromise = env.apiStore.preloadItemFromStorage('1');
    await advanceTime(100);
    await expect(preloadPromise).resolves.toMatchInlineSnapshot(`
      - { payload: '1', preloaded: '✅' }
    `);

    const renders = createLoggerStore();

    // Once preloaded, the hook should show cached data first and then the fresh response.
    renderHook(() => {
      const { data, status } = env.apiStore.useItem('1', {
        returnRefetchingStatus: true,
      });

      renders.add({ status, data: data?.value ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {id:1, name:Cached}
      -> status: refetching ⋅ data: {id:1, name:Cached}
      -> status: success ⋅ data: {id:1, name:Fresh}
      "
    `);
  });

  test('invalid converted cached data is removed during preload', async () => {
    const invalidStorageAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 50,
      storeName: 'col-opfs-invalid-storage',
      sessionKey: 'sess1',
      initialState: { collection: [{ payload: '1', data: { wrong: true } }] },
    });
    const throwingAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 50,
      storeName: 'col-opfs-throwing',
      sessionKey: 'sess1',
      initialState: {
        collection: [{ payload: '1', data: { itemId: '1', label: 'Cached' } }],
      },
    });

    const invalidStorageEnv = createEnv({
      storeName: 'col-opfs-invalid-storage',
      sessionKey: 'sess1',
      storageAdapter: invalidStorageAdapter.adapter,
    });
    const throwingEnv = createEnv({
      storeName: 'col-opfs-throwing',
      sessionKey: 'sess1',
      storageAdapter: throwingAdapter.adapter,
      schemaConfig: {
        ...createConvertedSchemaConfig({
          // The storage payload is valid, so this isolates convertFromStorage cleanup.
          convertFromStorage() {
            throw new Error('boom');
          },
        }),
        storeName: 'placeholder',
      },
    });

    const invalidStoragePreload =
      invalidStorageEnv.apiStore.preloadItemFromStorage('1');
    await advanceTime(50);
    await invalidStoragePreload;
    await advanceTime(2100);

    const throwingPreload = throwingEnv.apiStore.preloadItemFromStorage('1');
    await advanceTime(50);
    await throwingPreload;
    await advanceTime(2100);

    expect(
      invalidStorageAdapter.has(
        invalidStorageAdapter.collection.itemStorageKey('1'),
      ),
    ).toBe(false);
    expect(
      throwingAdapter.has(throwingAdapter.collection.itemStorageKey('1')),
    ).toBe(false);
  });

  test('invalid final data after conversion is removed during preload', async () => {
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 50,
      storeName: 'col-opfs-invalid-final',
      sessionKey: 'sess1',
      initialState: {
        collection: [{ payload: '1', data: { itemId: '1', label: 'Cached' } }],
      },
    });

    const env = createEnv({
      storeName: 'col-opfs-invalid-final',
      sessionKey: 'sess1',
      storageAdapter: mockAdapter.adapter,
      schemaConfig: {
        ...createConvertedSchemaConfig({
          convertFromStorage: createInvalidItemState,
        }),
        storeName: 'placeholder',
      },
    });

    const preloadPromise = env.apiStore.preloadItemFromStorage('1');
    await advanceTime(50);
    await preloadPromise;
    await advanceTime(2100);

    expect(mockAdapter.has(mockAdapter.collection.itemStorageKey('1'))).toBe(
      false,
    );
  });

  test('write conversion errors are reported and keep the previous cached item', async () => {
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 100,
      storeName: 'col-opfs-save-error',
      sessionKey: 'sess1',
      initialState: {
        collection: [{ payload: '1', data: { itemId: '1', label: 'Cached' } }],
      },
    });
    const onPersistentStorageError = vi.fn();
    const env = createEnv({
      storeName: 'col-opfs-save-error',
      sessionKey: 'sess1',
      storageAdapter: mockAdapter.adapter,
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

    // The fetch path is still valid; only the persisted write should fail and leave the old entry intact.
    renderHook(() => {
      env.apiStore.useItem('1', { returnRefetchingStatus: true });
    });

    await flushAllTimers();

    expect(onPersistentStorageError).toHaveBeenCalledTimes(1);
    expect(mockAdapter.collection.readItemData<StoredItemState>('1'))
      .toMatchInlineSnapshot(`
        itemId: '1'
        label: 'Cached'
      `);
  });
});
