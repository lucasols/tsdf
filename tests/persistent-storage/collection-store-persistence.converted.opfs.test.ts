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
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';

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
    adapter: opfsPersistentStorage,
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

function collectionScope(
  mockAdapter: ReturnType<typeof createOpfsPersistentStorageTestStore>,
  storeName: string,
  sessionKey: string,
) {
  return mockAdapter.scope(storeName, sessionKey).collection;
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

describe('opfs: converted collection store persistence', () => {
  test('explicit preload hydrates converted cached items before mount', async () => {
    createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'col-opfs-converted',
        sessionKey: 'sess1',
        collection: [{ payload: '1', data: { itemId: '1', label: 'Cached' } }],
      },
    });

    // Preload should hydrate the item from OPFS before any component reads it.
    const env = createEnv({
      storeName: 'col-opfs-converted',
      sessionKey: 'sess1',
      serverData: { '1': { id: '1', name: 'Fresh' } },
    });

    const preloadPromise = env.apiStore.preloadItemFromStorage('1');
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
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
    const invalidStorageAdapter = createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'col-opfs-invalid-storage',
        sessionKey: 'sess1',
        collection: [{ payload: '1', data: { wrong: true } }],
      },
    });
    const throwingAdapter = createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'col-opfs-throwing',
        sessionKey: 'sess1',
        collection: [{ payload: '1', data: { itemId: '1', label: 'Cached' } }],
      },
    });

    const invalidStorageEnv = createEnv({
      storeName: 'col-opfs-invalid-storage',
      sessionKey: 'sess1',
    });
    const throwingEnv = createEnv({
      storeName: 'col-opfs-throwing',
      sessionKey: 'sess1',
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
    await resolveAfterAllTimers(invalidStoragePreload);
    await advanceTime(2100);

    const throwingPreload = throwingEnv.apiStore.preloadItemFromStorage('1');
    await resolveAfterAllTimers(throwingPreload);
    await advanceTime(2100);

    expect(
      invalidStorageAdapter.has(
        collectionScope(
          invalidStorageAdapter,
          'col-opfs-invalid-storage',
          'sess1',
        ).itemStorageKey('1'),
      ),
    ).toBe(false);
    expect(
      throwingAdapter.has(
        collectionScope(
          throwingAdapter,
          'col-opfs-throwing',
          'sess1',
        ).itemStorageKey('1'),
      ),
    ).toBe(false);
  });

  test('invalid final data after conversion is removed during preload', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'col-opfs-invalid-final',
        sessionKey: 'sess1',
        collection: [{ payload: '1', data: { itemId: '1', label: 'Cached' } }],
      },
    });
    const persistedCollection = collectionScope(
      mockAdapter,
      'col-opfs-invalid-final',
      'sess1',
    );

    const env = createEnv({
      storeName: 'col-opfs-invalid-final',
      sessionKey: 'sess1',
      schemaConfig: {
        ...createConvertedSchemaConfig({
          convertFromStorage: createInvalidItemState,
        }),
        storeName: 'placeholder',
      },
    });

    const preloadPromise = env.apiStore.preloadItemFromStorage('1');
    await resolveAfterAllTimers(preloadPromise);
    await advanceTime(2100);

    expect(mockAdapter.has(persistedCollection.itemStorageKey('1'))).toBe(
      false,
    );
  });

  test('write conversion errors are reported and keep the previous cached item', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'col-opfs-save-error',
        sessionKey: 'sess1',
        collection: [{ payload: '1', data: { itemId: '1', label: 'Cached' } }],
      },
    });
    const persistedCollection = collectionScope(
      mockAdapter,
      'col-opfs-save-error',
      'sess1',
    );
    const onPersistentStorageError = vi.fn();
    const env = createEnv({
      storeName: 'col-opfs-save-error',
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

    // The fetch path is still valid; only the persisted write should fail and leave the old entry intact.
    renderHook(() => {
      env.apiStore.useItem('1', { returnRefetchingStatus: true });
    });

    await flushAllTimers();

    expect(onPersistentStorageError).toHaveBeenCalledTimes(1);
    expect(persistedCollection.readItemData<StoredItemState>('1'))
      .toMatchInlineSnapshot(`
        itemId: '1'
        label: 'Cached'
      `);
  });
});
