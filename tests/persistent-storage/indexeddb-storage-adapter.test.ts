import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { serializeProtectedRef } from '../../src/persistentStorage/asyncStorageAdapter';
import { DOCUMENT_PERSISTED_ENTRY_KEY } from '../../src/persistentStorage/documentEntryKey';
import {
  createIndexedDbPersistentStorageForTests,
  type IndexedDbPersistentStorageOperation,
} from '../../src/persistentStorage/indexedDbAsyncStorageAdapter';
import { pick } from '../utils/genericTestUtils';
import { getParsedIndexedDbRecordData } from '../utils/indexedDbPersistentStorageOptimizationTestUtils';
import { createIndexedDbPersistentStorageTestStore } from '../utils/indexedDbPersistentStorageTestStore';

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

function getLastOperation<
  TType extends IndexedDbPersistentStorageOperation['type'],
>(
  operations: IndexedDbPersistentStorageOperation[],
  type: TType,
): Extract<IndexedDbPersistentStorageOperation, { type: TType }> | null {
  for (const operation of [...operations].reverse()) {
    if (operation.type === type) {
      return __LEGIT_CAST__<
        Extract<IndexedDbPersistentStorageOperation, { type: TType }>,
        IndexedDbPersistentStorageOperation
      >(operation);
    }
  }

  return null;
}

describe('indexeddb persistent storage adapter', () => {
  test('metadata filtering uses the native group index', async () => {
    const operations: IndexedDbPersistentStorageOperation[] = [];
    const { adapter, driver } = createIndexedDbPersistentStorageForTests({
      databaseName: `tsdf-idb-filter-${Math.random().toString(36).slice(2, 10)}`,
      instrumentation: {
        operations,
        record(operation) {
          operations.push(operation);
        },
        reset() {
          operations.length = 0;
        },
      },
    });
    const scope = {
      kind: 'listQuery.item',
      sessionKey: 'sess1',
      storeName: 'grouped-items',
    } as const;
    const namespace = adapter.openNamespace<
      { id: number },
      { g?: string; p?: string }
    >(scope);

    const seedPromise = namespace.commit({
      upserts: [
        {
          key: 'a',
          metadata: { g: 'users', p: 'users||1' },
          value: { id: 1 },
          version: 1,
        },
        {
          key: 'b',
          metadata: { g: 'users', p: 'users||2' },
          value: { id: 2 },
          version: 1,
        },
        {
          key: 'c',
          metadata: { g: 'admins', p: 'admins||3' },
          value: { id: 3 },
          version: 1,
        },
      ],
    });
    await seedPromise;

    operations.length = 0;

    const filtered = await driver.__tsdfManagedStorage.listManagedMetadata(
      scope,
      { filter: { equals: 'users', key: 'g' }, order: 'key' },
    );

    expect(filtered.map((entry) => entry.key)).toMatchInlineSnapshot(
      `['a', 'b']`,
    );
    const filterOperation = getLastOperation(operations, 'listManagedMetadata');
    expect(
      filterOperation === null
        ? null
        : {
            ...pick(filterOperation, ['order', 'resultKeys', 'scope', 'type']),
            usedIndex: filterOperation.usedIndex,
          },
    ).toMatchInlineSnapshot(`
      order: 'key'
      resultKeys: ['a', 'b']
      scope: { kind: 'listQuery.item', sessionKey: 'sess1', storeName: 'grouped-items' }
      type: 'listManagedMetadata'
      usedIndex: 'group'
    `);

    adapter.resetForTests?.();
  });

  test('lru metadata listing uses the native last-access index', async () => {
    const operations: IndexedDbPersistentStorageOperation[] = [];
    const { adapter, driver } = createIndexedDbPersistentStorageForTests({
      databaseName: `tsdf-idb-lru-${Math.random().toString(36).slice(2, 10)}`,
      instrumentation: {
        operations,
        record(operation) {
          operations.push(operation);
        },
        reset() {
          operations.length = 0;
        },
      },
    });
    const scope = {
      kind: 'collection.item',
      sessionKey: 'sess1',
      storeName: 'lru-items',
    } as const;
    const namespace = adapter.openNamespace<{ id: number }>(scope);

    const seedPromise = namespace.commit({
      upserts: [
        { key: 'old', value: { id: 1 }, version: 1 },
        { key: 'new', value: { id: 2 }, version: 1 },
      ],
    });
    await seedPromise;

    const touchPromise = namespace.commit({
      touches: [
        { key: 'old', lastAccessAt: Date.now() + 10 },
        { key: 'new', lastAccessAt: Date.now() + 20 },
      ],
    });
    await touchPromise;

    operations.length = 0;
    const listed = await driver.__tsdfManagedStorage.listManagedMetadata(
      scope,
      { order: 'lru-desc' },
    );

    expect(listed.map((entry) => entry.key)).toMatchInlineSnapshot(
      `['new', 'old']`,
    );
    const lruOperation = getLastOperation(operations, 'listManagedMetadata');
    expect(
      lruOperation === null
        ? null
        : {
            ...pick(lruOperation, ['order', 'resultKeys', 'scope', 'type']),
            usedIndex: lruOperation.usedIndex,
          },
    ).toMatchInlineSnapshot(`
      order: 'lru-desc'
      resultKeys: ['new', 'old']
      scope: { kind: 'collection.item', sessionKey: 'sess1', storeName: 'lru-items' }
      type: 'listManagedMetadata'
      usedIndex: 'lru'
    `);

    adapter.resetForTests?.();
  });

  test('protected-key reads and syncs use the indexeddb fast path', async () => {
    const operations: IndexedDbPersistentStorageOperation[] = [];
    const { adapter } = createIndexedDbPersistentStorageForTests({
      databaseName: `tsdf-idb-protected-${Math.random().toString(36).slice(2, 10)}`,
      instrumentation: {
        operations,
        record(operation) {
          operations.push(operation);
        },
        reset() {
          operations.length = 0;
        },
      },
    });
    const scope = {
      kind: 'document',
      sessionKey: 'sess1',
      storeName: 'protected-doc',
    } as const;
    const namespace = adapter.openNamespace<{ value: number }, { o?: true }>(
      scope,
    );

    const seedPromise = namespace.commit({
      upserts: [
        {
          key: 'document',
          metadata: { o: true },
          value: { value: 1 },
          version: 1,
        },
      ],
    });
    await seedPromise;

    operations.length = 0;
    const protectedKeys = await adapter.readProtectedStorageKeys('sess1');

    expect([...protectedKeys]).toMatchInlineSnapshot(
      `['["sess1","protected-doc","d","document"]']`,
    );
    expect(
      getLastOperation(operations, 'readProtectedStorageKeys') === null
        ? null
        : pick(getLastOperation(operations, 'readProtectedStorageKeys'), [
            'sessionKey',
            'type',
            'values',
          ]),
    ).toMatchInlineSnapshot(`
      sessionKey: 'sess1'
      type: 'readProtectedStorageKeys'
      values: ['["sess1","protected-doc","d","document"]']
    `);

    operations.length = 0;
    const nextProtectedRef = serializeProtectedRef({
      key: 'document',
      kind: 'document',
      sessionKey: 'sess1',
      storeName: 'protected-doc',
    });
    await adapter.syncSessionProtectedKeys('sess1', [nextProtectedRef], []);

    expect(
      getLastOperation(operations, 'syncSessionProtectedKeys') === null
        ? null
        : pick(getLastOperation(operations, 'syncSessionProtectedKeys'), [
            'sessionKey',
            'type',
            'values',
          ]),
    ).toMatchInlineSnapshot(`
      sessionKey: 'sess1'
      type: 'syncSessionProtectedKeys'
      values: ['["sess1","protected-doc","d","document"]']
    `);

    adapter.resetForTests?.();
  });

  test('clearSession only removes records from the targeted session', async () => {
    const { adapter } = createIndexedDbPersistentStorageForTests({
      databaseName: `tsdf-idb-clear-${Math.random().toString(36).slice(2, 10)}`,
    });
    const session1Scope = {
      kind: 'document',
      sessionKey: 'sess1',
      storeName: 'docs',
    } as const;
    const session2Scope = {
      kind: 'document',
      sessionKey: 'sess2',
      storeName: 'docs',
    } as const;
    const session1Namespace = adapter.openNamespace<{ value: number }>(
      session1Scope,
    );
    const session2Namespace = adapter.openNamespace<{ value: number }>(
      session2Scope,
    );

    const seedPromise = Promise.all([
      session1Namespace.commit({
        upserts: [{ key: 'document', value: { value: 1 }, version: 1 }],
      }),
      session2Namespace.commit({
        upserts: [{ key: 'document', value: { value: 2 }, version: 1 }],
      }),
    ]);
    await seedPromise;

    await adapter.clearSession('sess1');

    expect(await session1Namespace.get('document')).toBeNull();
    const persistedSession2 = await session2Namespace.get('document');
    expect(
      persistedSession2 === null
        ? null
        : {
            metadata: pick(persistedSession2.metadata, [
              'customMetadata',
              'key',
              'payloadRef',
              'version',
            ]),
            value: persistedSession2.value,
          },
    ).toMatchInlineSnapshot(`
      metadata:
        customMetadata: {}
        key: 'document'
        payloadRef: '__tsdf_payload__:document'
        version: 1

      value: { value: 2 }
    `);

    adapter.resetForTests?.();
  });

  test('getParsedIndexedDbRecordData reads raw indexeddb rows without tsdf path parsing', async () => {
    const mockAdapter = createIndexedDbPersistentStorageTestStore({
      databaseName: 'tsdf-idb-generic-row-reader',
    });
    const documentScope = mockAdapter.scope('generic-reader', 'sess1');

    documentScope.document.seed(
      { value: { name: 'Cached document', value: 7 } },
      { timestamp: 1735689600000 },
    );

    const entry = await getParsedIndexedDbRecordData<Record<string, unknown>>(
      mockAdapter,
      {
        key: [
          'sess1',
          'generic-reader',
          'document',
          DOCUMENT_PERSISTED_ENTRY_KEY,
        ],
        storeName: 'entries',
      },
    );

    expect(entry === null ? null : pick(entry, ['a', 'd', 'i']))
      .toMatchInlineSnapshot(`
        a: 1735689600000

        d:
          value: { name: 'Cached document', value: 7 }

        i: '["sess1","generic-reader","d"]'
      `);
  });
});
