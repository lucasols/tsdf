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

import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createMockLocalStorageStore } from '../mocks/mockLocalStorageStore';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';

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
      backend: 'localStorage',
      schema: options.schema ?? createConvertedSchema(),
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

describe('localStorage: converted document store persistence', () => {
  test('first render hydrates converted cached data and then refetches', async () => {
    const mockStore = createMockLocalStorageStore({
      storeName: 'doc-converted-hook',
      sessionKey: 'sess1',
      initialState: { document: { data: { fullName: 'cached', amount: 7 } } },
    });

    // Seed the cache in storage format so hydration must pass through convertFromStorage.
    const env = createEnv({
      storeName: 'doc-converted-hook',
      sessionKey: 'sess1',
    });
    const renders = createLoggerStore();

    // The first hook read should hydrate from storage, then schedule the normal refetch flow.
    renderHook(() => {
      const { data, status } = env.apiStore.useDocument({
        returnRefetchingStatus: true,
      });

      renders.add({ status, data: data?.value ?? null });
    });

    await flushAllTimers();

    expect(mockStore.document.readData<StoredDocumentState>())
      .toMatchInlineSnapshot(`
        amount: 42
        fullName: 'fresh'
      `);
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {name:cached, value:7}
      -> status: refetching ⋅ data: {name:cached, value:7}
      -> status: success ⋅ data: {name:fresh, value:42}
      "
    `);
  });

  test('invalid storage-format data is discarded and cleaned up', async () => {
    const mockStore = createMockLocalStorageStore({
      storeName: 'doc-converted-invalid-storage',
      sessionKey: 'sess1',
      initialState: { document: { data: { wrong: true } } },
    });

    // Startup hydration should reject data that does not match storageSchema.
    const env = createEnv({
      storeName: 'doc-converted-invalid-storage',
      sessionKey: 'sess1',
    });

    expect(env.store.state).toMatchInlineSnapshot(`
      data: null
      error: null
      refetchOnMount: '❌'
      status: 'idle'
    `);

    await flushAllTimers();

    expect(mockStore.has(mockStore.document.storageKey())).toBe(false);
  });

  test('conversion failures while hydrating are discarded and cleaned up', async () => {
    const throwingStore = createMockLocalStorageStore({
      storeName: 'doc-converted-throwing',
      sessionKey: 'sess1',
      initialState: { document: { data: { fullName: 'cached', amount: 1 } } },
    });
    const invalidFinalStore = createMockLocalStorageStore({
      storeName: 'doc-converted-invalid-final',
      sessionKey: 'sess1',
      initialState: { document: { data: { fullName: 'cached', amount: 2 } } },
    });

    // Seed valid storage-format payloads so the failure comes from conversion/final validation.
    const throwingEnv = createEnv({
      storeName: 'doc-converted-throwing',
      sessionKey: 'sess1',
      schema: createConvertedSchema({
        convertFromStorage() {
          throw new Error('boom');
        },
      }),
    });
    const invalidFinalEnv = createEnv({
      storeName: 'doc-converted-invalid-final',
      sessionKey: 'sess1',
      schema: createConvertedSchema({
        convertFromStorage: createInvalidDocumentState,
      }),
    });

    expect(throwingEnv.store.state.status).toBe('idle');
    expect(invalidFinalEnv.store.state.status).toBe('idle');

    await flushAllTimers();

    expect(throwingStore.has(throwingStore.document.storageKey())).toBe(false);
    expect(invalidFinalStore.has(invalidFinalStore.document.storageKey())).toBe(
      false,
    );
  });

  test('write conversion errors are reported and do not overwrite cached data', async () => {
    const mockStore = createMockLocalStorageStore({
      storeName: 'doc-converted-save-error',
      sessionKey: 'sess1',
      initialState: { document: { data: { fullName: 'cached', amount: 7 } } },
    });

    // Keep an existing cache entry so the assertion shows failed writes do not clobber prior data.
    const onPersistentStorageError = vi.fn();
    const env = createEnv({
      storeName: 'doc-converted-save-error',
      sessionKey: 'sess1',
      onPersistentStorageError,
      schema: createConvertedSchema({
        convertToStorage() {
          throw new Error('cannot-save');
        },
      }),
    });

    // A normal mount fetch should still succeed; only persistence should fail.
    renderHook(() => {
      env.apiStore.useDocument({ returnRefetchingStatus: true });
    });

    await flushAllTimers();

    expect(onPersistentStorageError).toHaveBeenCalledTimes(1);
    expect(mockStore.document.readData<StoredDocumentState>())
      .toMatchInlineSnapshot(`
        amount: 7
        fullName: 'cached'
      `);
  });
});
