import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  ConvertedPersistentStorageDataSchema,
  PersistentStorageSchema,
} from '../../src/persistentStorage/types';
import { pick } from '../utils/genericTestUtils';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';
import { createCollectionStoreTestEnv } from './collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from './documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
} from './listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from './testEnvUtils';

const persistentStore = createLocalStoragePersistentTestStore();

const documentSchema = rc_object({ value: rc_number });
const collectionSchema = rc_object({ value: rc_object({ name: rc_string }) });
const rowSchema = __LEGIT_CAST__<PersistentStorageSchema<Row>, unknown>(
  rc_object({ id: rc_number, name: rc_string }),
);
const listQueryParamsSchema = rc_object({ tableId: rc_string });

type ConvertedDocumentValue = { name: string; value: number };
type ConvertedDocumentState = { value: ConvertedDocumentValue };
type StoredDocumentState = { fullName: string; amount: number };

function createConvertedDocumentSchema(): ConvertedPersistentStorageDataSchema<
  ConvertedDocumentState,
  StoredDocumentState
> {
  return {
    storeSchema: rc_object({
      value: rc_object({ name: rc_string, value: rc_number }),
    }),
    storageSchema: rc_object({ fullName: rc_string, amount: rc_number }),
    convertToStorage: (value) => ({
      fullName: value.value.name,
      amount: value.value.value,
    }),
    convertFromStorage: (value) => ({
      value: { name: value.fullName, value: value.amount },
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  localStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  localStorage.clear();
});

describe('testScenario persistent storage seeding', () => {
  test('document loaded seeds persistent storage with the loaded snapshot', () => {
    const storeName = 'doc-scenario-loaded';
    const sessionKey = 'scenario-session';

    createDocumentStoreTestEnv<number>(42, {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: { adapter: 'local-sync', schema: documentSchema },
    });

    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .document.readData<{ value: number }>(),
    ).toMatchInlineSnapshot(`
      value: 42
    `);
  });

  test('document loadedWithStaleData seeds stale data instead of server data', () => {
    const storeName = 'doc-scenario-stale';
    const sessionKey = 'scenario-session';

    createDocumentStoreTestEnv<number>(42, {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: { loadedWithStaleData: 7 },
      persistentStorage: { adapter: 'local-sync', schema: documentSchema },
    });

    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .document.readData<{ value: number }>(),
    ).toMatchInlineSnapshot(`
      value: 7
    `);
  });

  test('collection loaded seeds one persistent item entry per loaded item', () => {
    const storeName = 'collection-scenario-loaded';
    const sessionKey = 'scenario-session';

    createCollectionStoreTestEnv(
      { '1': { name: 'Ada' }, '2': { name: 'Grace' } },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
        },
      },
    );

    const scope = persistentStore.scope(storeName, sessionKey);

    expect(scope.collection.readItemData<{ value: { name: string } }>('1'))
      .toMatchInlineSnapshot(`
        value: { name: 'Ada' }
      `);
    expect(scope.collection.readItemData<{ value: { name: string } }>('2'))
      .toMatchInlineSnapshot(`
        value: { name: 'Grace' }
      `);
  });

  test('list-query loaded seeds both query and item persistent entries', () => {
    const storeName = 'list-query-scenario-loaded';
    const sessionKey = 'scenario-session';
    const usersQuery: ListQueryParams = { tableId: 'users' };

    createListQueryStoreTestEnv(
      {
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ],
      },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        testScenario: { loaded: { tables: ['users'] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: rowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryParamsSchema,
        },
      },
    );

    const scope = persistentStore.scope(storeName, sessionKey);

    expect(scope.listQuery.readItemData<Row>('users', 1))
      .toMatchInlineSnapshot(`
      id: 1
      name: 'Ada'
    `);
    expect(
      pick(scope.listQuery.readQueryEntry(usersQuery), ['data', 'timestamp']),
    ).toMatchInlineSnapshot(`
      data:
        hasMore: '❌'
        items: ['"users||1', '"users||2']
        payload: { tableId: 'users' }

      timestamp: 1735689590000
    `);
  });

  test('converted schemas seed storage-format data instead of store-format data', () => {
    const storeName = 'doc-scenario-converted';
    const sessionKey = 'scenario-session';

    createDocumentStoreTestEnv<
      ConvertedDocumentValue,
      null,
      StoredDocumentState
    >(
      { name: 'Fresh', value: 42 },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: createConvertedDocumentSchema(),
        },
      },
    );

    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .document.readData<StoredDocumentState>(),
    ).toMatchInlineSnapshot(`
      amount: 42
      fullName: 'Fresh'
    `);
  });
});
