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
import type { ConvertedPersistentStorageDataSchema } from '../../src/persistentStorage/types';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { getParsedOpfsFileData } from '../utils/persistentStorageOptimizationTestUtils';

const documentSchema = rc_object({
  value: rc_object({ name: rc_string, value: rc_number }),
});
const storageSchema = rc_object({ fullName: rc_string, amount: rc_number });
type TestData = { name: string; value: number };

const defaultServerData: TestData = { name: 'fresh', value: 42 };

type DocumentState = { value: TestData };

function createInvalidDocumentState() {
  return __LEGIT_CAST__<DocumentState, { invalid: true }>({ invalid: true });
}

type StoredDocumentState = { fullName: string; amount: number };

function createConvertedSchema(
  overrides: {
    convertToStorage?: (value: DocumentState) => StoredDocumentState;
    convertFromStorage?: (value: StoredDocumentState) => DocumentState;
  } = {},
): ConvertedPersistentStorageDataSchema<DocumentState, StoredDocumentState> {
  return {
    storeSchema: documentSchema,
    storageSchema,
    convertToStorage:
      overrides.convertToStorage ??
      ((value) => ({ fullName: value.value.name, amount: value.value.value })),
    convertFromStorage:
      overrides.convertFromStorage ??
      ((value) => ({ value: { name: value.fullName, value: value.amount } })),
  };
}

function createEnv(options: {
  storeName: string;
  sessionKey?: string;
  schema?: ConvertedPersistentStorageDataSchema<
    DocumentState,
    StoredDocumentState
  >;
  serverData?: TestData;
  onPersistentStorageError?: (error: unknown) => void;
}) {
  return createDocumentStoreTestEnv(options.serverData ?? defaultServerData, {
    getSessionKey: () => options.sessionKey ?? 'session1',
    persistentStorage: {
      storeName: options.storeName,
      adapter: opfsPersistentStorage,
      schema: options.schema ?? createConvertedSchema(),
      onPersistentStorageError: options.onPersistentStorageError,
    },
  });
}

function documentScope(
  mockAdapter: ReturnType<typeof createOpfsPersistentStorageTestStore>,
  storeName: string,
  sessionKey: string,
) {
  return mockAdapter.scope(storeName, sessionKey).document;
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

describe('opfs: converted document store persistence', () => {
  test('explicit preload hydrates converted cached data before mount', async () => {
    createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'doc-opfs-converted',
        sessionKey: 'sess1',
        document: { data: { fullName: 'cached', amount: 9 } },
      },
    });

    // Seed OPFS with the storage representation and hydrate it before any hook mounts.
    const env = createEnv({
      storeName: 'doc-opfs-converted',
      sessionKey: 'sess1',
    });

    const preloadPromise = env.apiStore.preloadPersistentStorage();
    await resolveAfterAllTimers(preloadPromise);

    const renders = createLoggerStore();

    // After explicit preload, the hook should start from hydrated data and then refetch normally.
    renderHook(() => {
      const { data, status } = env.apiStore.useDocument({
        returnRefetchingStatus: true,
      });

      renders.add({ status, data: data?.value ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {name:cached, value:9}
      -> status: refetching ⋅ data: {name:cached, value:9}
      -> status: success ⋅ data: {name:fresh, value:42}
      "
    `);
  });

  test('invalid converted cached data is removed during preload', async () => {
    const invalidStorageAdapter = createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'doc-opfs-invalid-storage',
        sessionKey: 'sess1',
        document: { data: { wrong: true } },
      },
    });
    const throwingAdapter = createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'doc-opfs-throwing',
        sessionKey: 'sess1',
        document: { data: { fullName: 'cached', amount: 1 } },
      },
    });

    const invalidStorageEnv = createEnv({
      storeName: 'doc-opfs-invalid-storage',
      sessionKey: 'sess1',
    });
    const throwingEnv = createEnv({
      storeName: 'doc-opfs-throwing',
      sessionKey: 'sess1',
      schema: createConvertedSchema({
        // The storage payload is valid, so cleanup here proves convertFromStorage failures are handled.
        convertFromStorage() {
          throw new Error('boom');
        },
      }),
    });

    const invalidStoragePreload =
      invalidStorageEnv.apiStore.preloadPersistentStorage();
    await resolveAfterAllTimers(invalidStoragePreload);
    await advanceTime(2100);

    const throwingPreload = throwingEnv.apiStore.preloadPersistentStorage();
    await resolveAfterAllTimers(throwingPreload);
    await advanceTime(2100);

    expect(
      invalidStorageAdapter.has(
        documentScope(
          invalidStorageAdapter,
          'doc-opfs-invalid-storage',
          'sess1',
        ).storageKey(),
      ),
    ).toBe(false);
    expect(
      throwingAdapter.has(
        documentScope(
          throwingAdapter,
          'doc-opfs-throwing',
          'sess1',
        ).storageKey(),
      ),
    ).toBe(false);
  });

  test('invalid final data after conversion is removed during preload', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'doc-opfs-invalid-final',
        sessionKey: 'sess1',
        document: { data: { fullName: 'cached', amount: 4 } },
      },
    });

    const env = createEnv({
      storeName: 'doc-opfs-invalid-final',
      sessionKey: 'sess1',
      schema: createConvertedSchema({
        convertFromStorage: createInvalidDocumentState,
      }),
    });

    const preloadPromise = env.apiStore.preloadPersistentStorage();
    await resolveAfterAllTimers(preloadPromise);
    await advanceTime(4300);
    await flushAllTimers();

    expect(
      mockAdapter.has(
        documentScope(
          mockAdapter,
          'doc-opfs-invalid-final',
          'sess1',
        ).storageKey(),
      ),
    ).toBe(false);
  });

  test('write conversion errors are reported and keep the previous cached data', async () => {
    createOpfsPersistentStorageTestStore({
      initialState: {
        storeName: 'doc-opfs-save-error',
        sessionKey: 'sess1',
        document: { data: { fullName: 'cached', amount: 7 } },
      },
    });
    const onPersistentStorageError = vi.fn();
    const env = createEnv({
      storeName: 'doc-opfs-save-error',
      sessionKey: 'sess1',
      onPersistentStorageError,
      schema: createConvertedSchema({
        convertToStorage() {
          throw new Error('cannot-save');
        },
      }),
    });

    // Fetch success should still happen; only the persistence write should be skipped.
    renderHook(() => {
      env.apiStore.useDocument({ returnRefetchingStatus: true });
    });

    await flushAllTimers();

    expect(onPersistentStorageError).toHaveBeenCalledTimes(1);
    expect(getParsedOpfsFileData('tsdf/sess1/doc-opfs-save-error/d.e.p.json'))
      .toMatchInlineSnapshot(`
        d: { amount: 7, fullName: 'cached' }
      `);
  });
});
