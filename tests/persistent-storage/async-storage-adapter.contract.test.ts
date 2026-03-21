import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { clearSessionStorage } from '../../src/main';
import { createAsyncStorageAdapter } from '../../src/persistentStorage/asyncStorageAdapter';
import type {
  AsyncStorageDriver,
  AsyncStorageNamespaceScope,
} from '../../src/persistentStorage/types';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime } from '../utils/genericTestUtils';

type DriverOperation =
  | { key: string; scope: AsyncStorageNamespaceScope; type: 'get' }
  | { keys: string[]; scope: AsyncStorageNamespaceScope; type: 'listKeys' }
  | { key: string; scope: AsyncStorageNamespaceScope; type: 'remove' }
  | { scope: AsyncStorageNamespaceScope; type: 'clear' }
  | {
      key: string;
      scope: AsyncStorageNamespaceScope;
      type: 'set';
      value: unknown;
    };

function createNaiveAsyncStorageDriver() {
  const namespaces = new Map<string, Map<string, unknown>>();
  const operations: DriverOperation[] = [];

  function getNamespaceId(scope: AsyncStorageNamespaceScope): string {
    return JSON.stringify([scope.sessionKey, scope.storeName, scope.kind]);
  }

  function getNamespace(
    scope: AsyncStorageNamespaceScope,
  ): Map<string, unknown> {
    const namespaceId = getNamespaceId(scope);
    let namespace = namespaces.get(namespaceId);
    if (!namespace) {
      namespace = new Map();
      namespaces.set(namespaceId, namespace);
    }
    return namespace;
  }

  const driver: AsyncStorageDriver = {
    get(scope, key) {
      operations.push({ type: 'get', scope, key });
      return Promise.resolve(getNamespace(scope).get(key) ?? null);
    },
    set(scope, key, value) {
      operations.push({ type: 'set', scope, key, value });
      getNamespace(scope).set(key, value);
      return Promise.resolve();
    },
    remove(scope, key) {
      operations.push({ type: 'remove', scope, key });
      const namespace = getNamespace(scope);
      namespace.delete(key);
      if (namespace.size === 0) {
        namespaces.delete(getNamespaceId(scope));
      }
      return Promise.resolve();
    },
    listKeys(scope) {
      const keys = [...getNamespace(scope).keys()].sort();
      operations.push({ type: 'listKeys', scope, keys });
      return Promise.resolve(keys);
    },
    clear(scope) {
      operations.push({ type: 'clear', scope });
      namespaces.delete(getNamespaceId(scope));
      return Promise.resolve();
    },
    resetForTests() {
      namespaces.clear();
      operations.length = 0;
    },
  };

  return { driver, namespaces, operations };
}

function isUserRecordKey(key: string): boolean {
  return (
    key.startsWith('__tsdf_payload__:') || key.startsWith('__tsdf_meta__:')
  );
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

describe('createAsyncStorageAdapter', () => {
  test('two quick commits coalesce into one driver flush and pending writes flush before get/getMany/listKeys/listMetadata/clear', async () => {
    const driverState = createNaiveAsyncStorageDriver();
    const adapter = createAsyncStorageAdapter(driverState.driver);
    const scope = {
      sessionKey: 'sess1',
      storeName: 'coalesced',
      kind: 'document',
    } as const;
    const namespace = adapter.openNamespace<{ value: string }>(scope);

    const firstCommit = namespace.commit({
      upserts: [{ key: 'document', value: { value: 'first' }, version: 1 }],
    });
    const secondCommit = namespace.commit({
      upserts: [{ key: 'document', value: { value: 'second' }, version: 1 }],
    });

    await advanceTime(39);
    expect(driverState.operations).toMatchInlineSnapshot(`[]`);

    const singleEntry = await namespace.get('document', { touch: 'never' });
    const manyEntries = await namespace.getMany(['document'], {
      touch: 'never',
    });
    const keys = await namespace.listKeys();
    const metadataEntries = await namespace.listMetadata();
    await namespace.clear();
    await Promise.all([firstCommit, secondCommit]);

    expect(singleEntry?.value).toMatchInlineSnapshot(`
      value: 'second'
    `);
    expect(manyEntries[0]?.value).toMatchInlineSnapshot(`
      value: 'second'
    `);
    expect(keys).toMatchInlineSnapshot(`
      ['document']
    `);
    expect(metadataEntries.map((entry) => entry.key)).toMatchInlineSnapshot(`
      ['document']
    `);
    expect(
      driverState.operations
        .filter(
          (operation) =>
            operation.scope.sessionKey === 'sess1' &&
            operation.scope.storeName === 'coalesced' &&
            operation.scope.kind === 'document',
        )
        .map((operation) => {
          switch (operation.type) {
            case 'set':
              return { type: operation.type, key: operation.key };
            case 'get':
              return { type: operation.type, key: operation.key };
            case 'remove':
              return { type: operation.type, key: operation.key };
            case 'listKeys':
              return { type: operation.type, keys: operation.keys };
            case 'clear':
              return { type: operation.type };
          }
        }),
    ).toMatchInlineSnapshot(`
      - { key: '__tsdf_meta__:document', type: 'get' }
      - { key: '__tsdf_payload__:document', type: 'set' }
      - { key: '__tsdf_meta__:document', type: 'set' }
      - { key: '__tsdf_payload__:document', type: 'get' }
      - { key: '__tsdf_meta__:document', type: 'get' }
      - { key: '__tsdf_payload__:document', type: 'get' }
      - { key: '__tsdf_meta__:document', type: 'get' }
      - keys: ['__tsdf_meta__:document', '__tsdf_payload__:document']
        type: 'listKeys'
      - keys: ['__tsdf_meta__:document', '__tsdf_payload__:document']
        type: 'listKeys'
      - { key: '__tsdf_meta__:document', type: 'get' }
      - type: 'clear'
    `);
  });

  test('repeated coarse reads inside one recency bucket emit at most one touch metadata write', async () => {
    const driverState = createNaiveAsyncStorageDriver();
    const adapter = createAsyncStorageAdapter(driverState.driver);
    const scope = {
      sessionKey: 'sess1',
      storeName: 'touch-guard',
      kind: 'document',
    } as const;
    const namespace = adapter.openNamespace<{ value: string }>(scope);

    const seedCommit = namespace.commit({
      upserts: [{ key: 'document', value: { value: 'cached' }, version: 1 }],
    });
    await advanceTime(40);
    await seedCommit;

    driverState.operations.length = 0;

    await advanceTime(6 * 60 * 60 * 1000);
    const firstRead = await namespace.get('document', { touch: 'coarse' });
    await advanceTime(40);
    const secondRead = await namespace.get('document', { touch: 'coarse' });

    expect(firstRead?.value).toMatchInlineSnapshot(`
      value: 'cached'
    `);
    expect(secondRead?.value).toMatchInlineSnapshot(`
      value: 'cached'
    `);
    expect(
      driverState.operations.filter(
        (operation) =>
          operation.type === 'set' &&
          operation.scope.sessionKey === 'sess1' &&
          operation.scope.storeName === 'touch-guard' &&
          operation.scope.kind === 'document' &&
          operation.key === '__tsdf_meta__:document',
      ),
    ).toHaveLength(1);
  });

  test('clearSessionStorage works for any wrapped async driver', async () => {
    const driverState = createNaiveAsyncStorageDriver();
    const adapter = createAsyncStorageAdapter(driverState.driver);
    const clearedDocument = adapter.openNamespace<{ value: string }>({
      sessionKey: 'sess-clear',
      storeName: 'docs',
      kind: 'document',
    });
    const keptDocument = adapter.openNamespace<{ value: string }>({
      sessionKey: 'sess-keep',
      storeName: 'docs',
      kind: 'document',
    });
    const clearedCollection = adapter.openNamespace<{ value: string }>({
      sessionKey: 'sess-clear',
      storeName: 'users',
      kind: 'collection.item',
    });

    const pendingCommits = [
      clearedDocument.commit({
        upserts: [
          { key: 'document', value: { value: 'clear me' }, version: 1 },
        ],
      }),
      keptDocument.commit({
        upserts: [{ key: 'document', value: { value: 'keep me' }, version: 1 }],
      }),
      clearedCollection.commit({
        upserts: [{ key: '1', value: { value: 'clear user' }, version: 1 }],
      }),
    ];
    await advanceTime(40);
    await Promise.all(pendingCommits);

    await clearSessionStorage('sess-clear', adapter);

    expect(
      await clearedDocument.get('document', { touch: 'never' }),
    ).toMatchInlineSnapshot(`null`);
    expect(
      await clearedCollection.get('1', { touch: 'never' }),
    ).toMatchInlineSnapshot(`null`);
    expect(await keptDocument.get('document', { touch: 'never' }))
      .toMatchInlineSnapshot(`
      metadata:
        customMetadata: {}
        key: 'document'
        lastAccessAt: 1735689600040
        payloadRef: '__tsdf_payload__:document'
        sizeBytes: 19
        version: 1
        writtenAt: 1735689600040

      value: { value: 'keep me' }
    `);

    expect(
      driverState.operations
        .filter((operation) => operation.type === 'clear')
        .map((operation) => operation.scope),
    ).toMatchInlineSnapshot(`
      - { kind: 'document', sessionKey: 'sess-clear', storeName: 'docs' }
      - { kind: 'collection.item', sessionKey: 'sess-clear', storeName: 'users' }
    `);
    expect(
      [...driverState.namespaces.entries()]
        .filter(([, entries]) =>
          [...entries.keys()].some((key) => isUserRecordKey(key)),
        )
        .map(([namespaceId]) =>
          __LEGIT_CAST__<[string, string, string], unknown>(
            JSON.parse(namespaceId),
          ),
        ),
    ).toMatchInlineSnapshot(`
      - ['sess-keep', 'docs', 'document']
    `);
  });
});
