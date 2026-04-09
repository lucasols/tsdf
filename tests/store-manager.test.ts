import { rc_number, rc_object } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createStoreManager } from '../src/storeManager';
import { createCollectionStoreTestEnv } from './mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from './mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from './mocks/listQueryStoreTestEnv';
import { normalizeError, TEST_INITIAL_TIME } from './mocks/testEnvUtils';
import { flushAllTimers } from './utils/genericTestUtils';

const docSchema = rc_object({ value: rc_number });

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

test('getAllStoreIds returns the registered ids across mixed store types', () => {
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });

  createDocumentStoreTestEnv(1, { id: 'doc-store', storeManager });
  createCollectionStoreTestEnv(
    { '1': { title: 'Todo', completed: false } },
    { id: 'todos', storeManager },
  );
  createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    { id: 'users', storeManager },
  );

  expect(storeManager.getAllStoreIds()).toMatchInlineSnapshot(`
    ['doc-store', 'todos', 'users']
  `);
});

test('duplicate ids are rejected within the same store manager', () => {
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });

  createDocumentStoreTestEnv(1, { id: 'shared-doc', storeManager });

  expect(() => {
    createDocumentStoreTestEnv(2, { id: 'shared-doc', storeManager });
  }).toThrowError(
    '[tsdf] Duplicate store id "shared-doc" created in the same storeManager. Store ids must be unique per manager so global operations like resetAll(...) stay unambiguous.',
  );
});

test('dispose unregisters stores and allows recreating the same id', () => {
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });

  const documentEnv = createDocumentStoreTestEnv(1, {
    id: 'doc-store',
    storeManager,
  });
  const collectionEnv = createCollectionStoreTestEnv(
    { '1': { title: 'Todo', completed: false } },
    { id: 'todos', storeManager },
  );
  const listQueryEnv = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    { id: 'users', storeManager },
  );

  documentEnv.apiStore.dispose();
  documentEnv.apiStore.dispose();
  collectionEnv.apiStore.dispose();

  expect(storeManager.getAllStoreIds()).toMatchInlineSnapshot(`
    ['users']
  `);

  createDocumentStoreTestEnv(2, { id: 'doc-store', storeManager });

  listQueryEnv.apiStore.dispose();

  expect(storeManager.getAllStoreIds()).toMatchInlineSnapshot(`
    ['doc-store']
  `);
});

test('resetAll resets every registered store except ignored ids', async () => {
  const storeManager = createStoreManager({
    getSessionKey: () => 'shared-session',
    errorNormalizer: normalizeError,
  });

  const documentEnv = createDocumentStoreTestEnv(1, {
    id: 'doc-store',
    storeManager,
    testScenario: 'loaded',
  });
  const collectionEnv = createCollectionStoreTestEnv(
    { '1': { title: 'Todo', completed: false } },
    { id: 'collection-store', storeManager, testScenario: 'loaded' },
  );
  const listQueryEnv = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    { id: 'list-store', storeManager },
  );

  listQueryEnv.scheduleFetch('highPriority', { tableId: 'users' });
  await flushAllTimers();

  storeManager.resetAll(['collection-store']);

  expect(documentEnv.store.state).toMatchInlineSnapshot(`
    data: null
    error: null
    refetchOnMount: 'lowPriority'
    status: 'idle'
  `);
  expect(collectionEnv.store.state).toMatchInlineSnapshot(`
    "1:
      data:
        value: { completed: '❌', title: 'Todo' }
      error: null
      payload: '1'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
  `);
  expect(listQueryEnv.store.state).toMatchInlineSnapshot(`
    itemFieldInvalidationFields: {}

    itemLoadedFields: {}

    itemQueries: {}

    items: {}

    queries: {}
  `);
});

test('inline offline session config inherits session scoping from the store manager', () => {
  const storeManager = createStoreManager({
    getSessionKey: () => 'manager-session',
    errorNormalizer: normalizeError,
    offlineSession: { network: { enabled: true } },
  });
  const offlineSession = storeManager.getOfflineSession()!;

  createDocumentStoreTestEnv(1, {
    id: 'manager-bound-offline-doc',
    storeManager,
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {},
    },
  });

  expect(offlineSession.getSessionKey()).toBe('manager-session');
});
