import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_number, rc_object, rc_string } from 'runcheck';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import type { PersistentStorageSchema } from '../../src/persistentStorage/types';
import { createInMemoryBrowserTabsTransportFactory } from '../mocks/browserTabsTestUtils';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterAll(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
  opfsPersistentStorage.resetForTests?.();
  resetMockBrowserOpfsForTests();
});

const collectionItemSchema = rc_object({
  value: rc_object({
    hashId: rc_string,
    name: rc_string,
    sequentialId: rc_string,
  }),
});

type IdentityRow = Row & { hashId: string; sequentialId: string };

const listItemSchema = __LEGIT_CAST__<
  PersistentStorageSchema<IdentityRow>,
  unknown
>(
  rc_object({
    id: rc_number,
    hashId: rc_string,
    name: rc_string,
    sequentialId: rc_string,
    age: rc_number.optional(),
    city: rc_string.optional(),
  }),
);

const partialResources: PartialResourcesConfig<IdentityRow> = {
  mergeItems: (prev, fetched) => {
    if (!prev) return fetched;
    return { ...prev, ...fetched };
  },
  selectFields: (fields, item) => {
    const nextValue: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in item) {
        nextValue[field] = item[field];
      }
    }
    return __LEGIT_CAST__<IdentityRow, Record<string, unknown>>(nextValue);
  },
};

type CollectionIdentityItem = {
  hashId: string;
  name: string;
  sequentialId: string;
};

const collectionIdentityData: Record<string, CollectionIdentityItem> = {
  'seq:1': { sequentialId: 'seq:1', hashId: 'user:hash:alice', name: 'Alice' },
  'hash:alice': {
    sequentialId: 'seq:1',
    hashId: 'user:hash:alice',
    name: 'Alice',
  },
};

const listIdentityData: Tables<IdentityRow> = {
  users: [
    {
      id: 1,
      sequentialId: 'users||1',
      hashId: 'user:hash:alice',
      name: 'Alice',
      age: 31,
    },
    {
      id: 2,
      sequentialId: 'users||2',
      hashId: 'user:hash:alice',
      name: 'Alice',
      city: 'Rio',
    },
    {
      id: 3,
      sequentialId: 'users||3',
      hashId: 'user:hash:bruno',
      name: 'Bruno',
      age: 29,
    },
  ],
};

const usersQuery: ListQueryParams = { tableId: 'users' };
const aliceCollectionAliasKey = getCompositeKey('seq:1');
const aliceCollectionCanonicalKey = getCompositeKey('user:hash:alice');
const aliceListAliasKey = getCompositeKey('users||1');
const aliceListCanonicalKey = getCompositeKey('user:hash:alice');

function listLocalStorageKeys(prefix: string): string[] {
  const keys: string[] = [];

  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) {
      keys.push(key);
    }
  }

  return keys.sort();
}

describe('canonical item identity', () => {
  test('collection collapses alias fetches into one canonical cached item', async () => {
    const env = createCollectionStoreTestEnv(collectionIdentityData, {
      resolveItemIdentity: ({ data }) => data.value.hashId,
    });

    // The first fetch starts from the sequential lookup, but the loaded item
    // should immediately move under the canonical hash payload.
    env.apiStore.scheduleFetch('highPriority', 'seq:1');
    await flushAllTimers();

    expect(env.apiStore.getItemKey('seq:1')).toBe(aliceCollectionAliasKey);
    expect(env.apiStore.getItemState('seq:1')).toMatchInlineSnapshot(`
      data:
        value: { hashId: 'user:hash:alice', name: 'Alice', sequentialId: 'seq:1' }

      error: null
      payload: 'user:hash:alice'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);

    // Re-reading through the canonical payload must reuse the same item
    // instead of materializing a second cache entry.
    env.apiStore.scheduleFetch('highPriority', 'hash:alice');
    await flushAllTimers();

    expect(
      Object.entries(env.store.state)
        .filter(([, item]) => item !== null)
        .map(([itemKey]) => itemKey),
    ).toMatchInlineSnapshot(`
      ['"user:hash:alice']
    `);
  });

  test('collection persistence restores alias reuse after reloading the store', async () => {
    const testId = 'collection-canonical-persistence';
    const sessionKey = () => 'canonical-session';
    const persistentStorage = {
      adapter: 'local-sync' as const,
      schema: collectionItemSchema,
      payloadSchema: rc_string,
    };

    const firstEnv = createCollectionStoreTestEnv(collectionIdentityData, {
      id: testId,
      getSessionKey: sessionKey,
      persistentStorage,
      resolveItemIdentity: ({ data }) => data.value.hashId,
    });

    firstEnv.apiStore.scheduleFetch('highPriority', 'seq:1');
    await flushAllTimers();

    expect(
      listLocalStorageKeys(`tsdf.canonical-session.${testId}.ci.`),
    ).toHaveLength(1);
    expect(
      listLocalStorageKeys(`tsdf.canonical-session.${testId}.ci.`)[0],
    ).toContain(aliceCollectionCanonicalKey);

    firstEnv.apiStore.dispose();

    const reloadedEnv = createCollectionStoreTestEnv(collectionIdentityData, {
      id: testId,
      getSessionKey: sessionKey,
      persistentStorage,
      resolveItemIdentity: ({ data }) => data.value.hashId,
    });

    // Reading through the old sequential payload should hydrate the canonical
    // item directly from storage, including the alias mapping.
    expect(reloadedEnv.apiStore.getItemKey('seq:1')).toBe(
      aliceCollectionAliasKey,
    );
    expect(reloadedEnv.apiStore.getItemState('seq:1')).toMatchInlineSnapshot(`
      data:
        value: { hashId: 'user:hash:alice', name: 'Alice', sequentialId: 'seq:1' }

      error: null
      payload: 'user:hash:alice'
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);
  });

  test('collection async persistence restores alias reuse after reloading the store', async () => {
    const testId = 'collection-canonical-persistence-opfs';
    const sessionKey = () => 'canonical-session';
    const opfsStore = createOpfsPersistentStorageTestStore();
    const persistentStorage = {
      adapter: opfsPersistentStorage,
      schema: collectionItemSchema,
      payloadSchema: rc_string,
    };

    const firstEnv = createCollectionStoreTestEnv(collectionIdentityData, {
      id: testId,
      getSessionKey: sessionKey,
      persistentStorage,
      resolveItemIdentity: ({ data }) => data.value.hashId,
    });

    firstEnv.apiStore.scheduleFetch('highPriority', 'seq:1');
    await flushAllTimers();

    expect(
      opfsStore
        .scope(testId, sessionKey())
        .collection.listStoredPayloads()
        .sort(),
    ).toMatchInlineSnapshot(`
      ['user:hash:alice']
    `);

    firstEnv.apiStore.dispose();
    await flushAllTimers();

    const reloadedEnv = createCollectionStoreTestEnv(collectionIdentityData, {
      id: testId,
      getSessionKey: sessionKey,
      persistentStorage,
      resolveItemIdentity: ({ data }) => data.value.hashId,
    });

    await reloadedEnv.apiStore.preloadItemFromStorage('seq:1');
    await flushAllTimers();

    expect(reloadedEnv.apiStore.getItemState('seq:1')).toMatchInlineSnapshot(`
      data:
        value: { hashId: 'user:hash:alice', name: 'Alice', sequentialId: 'seq:1' }

      error: null
      payload: 'user:hash:alice'
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);
  });

  test('list query merges alias items into one canonical item and unions partial fields', async () => {
    const env = createListQueryStoreTestEnv<IdentityRow, true>(
      listIdentityData,
      { partialResources, resolveItemIdentity: ({ data }) => data.hashId },
    );

    // First load a narrow standalone item resource through one alias.
    env.apiStore.scheduleItemFetch('highPriority', 'users||1', {
      fields: ['hashId', 'name'],
    });
    await flushAllTimers();

    // Then load a list containing two different payloads that actually point
    // to the same entity. The query should keep only the canonical item key
    // while the canonical item data keeps fields from both fetches.
    env.apiStore.scheduleListQueryFetch('highPriority', usersQuery, undefined, {
      fields: ['age', 'city', 'hashId'],
    });
    await flushAllTimers();

    expect(env.store.state.queries[getCompositeKey(usersQuery)]?.items)
      .toMatchInlineSnapshot(`
        ['"user:hash:alice', '"user:hash:bruno']
      `);

    expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(`
      age: 31
      city: 'Rio'
      hashId: 'user:hash:alice'
      name: 'Alice'
    `);
    expect(
      Object.keys(env.store.state.itemQueries)
        .filter((itemKey) => env.store.state.itemQueries[itemKey] !== undefined)
        .sort(),
    ).toMatchInlineSnapshot(`
      ['"user:hash:alice', '"user:hash:bruno']
    `);
  });

  test('list query persistence restores alias lookups through the canonical entry', async () => {
    const testId = 'list-query-canonical-persistence';
    const sessionKey = () => 'canonical-session';
    const persistentStorage = {
      adapter: 'local-sync' as const,
      schema: listItemSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: rc_object({ tableId: rc_string }),
    };

    const firstEnv = createListQueryStoreTestEnv(listIdentityData, {
      id: testId,
      getSessionKey: sessionKey,
      persistentStorage,
      resolveItemIdentity: ({ data }) => data.hashId,
    });

    firstEnv.forceListUpdate(usersQuery);
    await flushAllTimers();

    expect(listLocalStorageKeys(`tsdf.canonical-session.${testId}.li.`))
      .toMatchInlineSnapshot(`
      - 'tsdf.canonical-session.list-query-canonical-persistence.li."user:hash:alice'
      - 'tsdf.canonical-session.list-query-canonical-persistence.li."user:hash:bruno'
    `);

    firstEnv.apiStore.dispose();

    const reloadedEnv = createListQueryStoreTestEnv(listIdentityData, {
      id: testId,
      getSessionKey: sessionKey,
      persistentStorage,
      resolveItemIdentity: ({ data }) => data.hashId,
    });

    // The sequential alias should reuse the persisted canonical item without
    // re-fetching, and related queries should still point at the same query.
    expect(reloadedEnv.apiStore.getItemKey('users||1')).toBe(aliceListAliasKey);
    expect(reloadedEnv.apiStore.getItemState('users||1')).toEqual(
      reloadedEnv.apiStore.getItemState('user:hash:alice'),
    );
    expect(
      reloadedEnv.apiStore.getItemState('users||1')?.hashId,
    ).toMatchInlineSnapshot(`"user:hash:alice"`);
    expect(reloadedEnv.apiStore.getQueryState(usersQuery)?.items)
      .toMatchInlineSnapshot(`
        ['"user:hash:alice', '"user:hash:bruno']
      `);
    expect(
      reloadedEnv.apiStore
        .getQueriesRelatedToItem('users||1')
        .map(({ key }) => key),
    ).toMatchInlineSnapshot(`
      ['{tableId:"users"}']
    `);
  });

  test('list query async persistence restores alias lookups through the canonical entry', async () => {
    const testId = 'list-query-canonical-persistence-opfs';
    const sessionKey = () => 'canonical-session';
    const opfsStore = createOpfsPersistentStorageTestStore();
    const persistentStorage = {
      adapter: opfsPersistentStorage,
      schema: listItemSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: rc_object({ tableId: rc_string }),
    };

    const firstEnv = createListQueryStoreTestEnv(listIdentityData, {
      id: testId,
      getSessionKey: sessionKey,
      persistentStorage,
      resolveItemIdentity: ({ data }) => data.hashId,
    });

    firstEnv.forceListUpdate(usersQuery);
    await flushAllTimers();

    const storedItemKeys = opfsStore
      .scope(testId, sessionKey())
      .listQuery.listStoredItemKeys()
      .sort();
    expect(storedItemKeys).toContain(aliceListCanonicalKey);
    expect(storedItemKeys).not.toContain(aliceListAliasKey);

    firstEnv.apiStore.dispose();
    await flushAllTimers();

    const reloadedEnv = createListQueryStoreTestEnv(listIdentityData, {
      id: testId,
      getSessionKey: sessionKey,
      persistentStorage,
      resolveItemIdentity: ({ data }) => data.hashId,
    });

    await reloadedEnv.apiStore.preloadItemFromStorage('users||1');
    await reloadedEnv.apiStore.preloadQueryFromStorage(usersQuery);
    await flushAllTimers();

    expect(reloadedEnv.apiStore.getItemState('users||1')).toEqual(
      reloadedEnv.apiStore.getItemState('user:hash:alice'),
    );
    expect(reloadedEnv.apiStore.getQueryState(usersQuery)?.items)
      .toMatchInlineSnapshot(`
        ['"user:hash:alice', '"user:hash:bruno']
      `);
    expect(
      reloadedEnv.apiStore
        .getQueriesRelatedToItem('users||1')
        .map(({ key }) => key),
    ).toMatchInlineSnapshot(`
      ['{tableId:"users"}']
    `);
  });

  test('list query browser-tab snapshots propagate canonical aliases to another tab', async () => {
    const sharedTransport = createInMemoryBrowserTabsTransportFactory();
    const sharedId = 'list-query-canonical-browser-tabs';

    const receivingTab = createListQueryStoreTestEnv(listIdentityData, {
      id: sharedId,
      testScenario: { loaded: { tables: ['users'] } },
      browserTabsTransportFactory: sharedTransport,
      testBrowserTabId: 'tab-b',
      resolveItemIdentity: ({ data }) => data.hashId,
    });
    const publishingTab = createListQueryStoreTestEnv(listIdentityData, {
      id: sharedId,
      browserTabsTransportFactory: sharedTransport,
      testBrowserTabId: 'tab-a',
      resolveItemIdentity: ({ data }) => data.hashId,
    });

    // Tab A rewrites the loaded aliases into canonical query membership, and
    // tab B should apply the remote snapshot even though its local state
    // started from the raw pre-canonicalized snapshot.
    publishingTab.forceListUpdate(usersQuery);
    await flushAllTimers();

    expect(receivingTab.store.state.queries[getCompositeKey(usersQuery)]?.items)
      .toMatchInlineSnapshot(`
        ['"user:hash:alice', '"user:hash:bruno']
      `);
    expect(receivingTab.apiStore.getItemKey('users||2')).toBe(
      getCompositeKey('users||2'),
    );
  });

  test('list query standalone item snapshots keep the canonical item in sync across tabs', async () => {
    const sharedTransport = createInMemoryBrowserTabsTransportFactory();
    const sharedId = 'list-query-canonical-item-browser-tabs';

    const receivingTab = createListQueryStoreTestEnv(listIdentityData, {
      id: sharedId,
      testScenario: { loaded: { items: ['users||1'] } },
      browserTabsTransportFactory: sharedTransport,
      testBrowserTabId: 'tab-b',
      resolveItemIdentity: ({ data }) => data.hashId,
    });
    const publishingTab = createListQueryStoreTestEnv(listIdentityData, {
      id: sharedId,
      browserTabsTransportFactory: sharedTransport,
      testBrowserTabId: 'tab-a',
      resolveItemIdentity: ({ data }) => data.hashId,
    });

    // Tab B starts with the old alias snapshot only. When tab A fetches the
    // standalone item and canonicalizes it, tab B should keep the item under
    // the canonical key instead of dropping it when the alias tombstone lands.
    publishingTab.apiStore.scheduleItemFetch('highPriority', 'users||1');
    await flushAllTimers();

    expect(receivingTab.apiStore.getItemKey('users||1')).toBe(
      aliceListAliasKey,
    );
    expect(receivingTab.apiStore.getItemState('users||1'))
      .toMatchInlineSnapshot(`
      age: 31
      hashId: 'user:hash:alice'
      id: 1
      name: 'Alice'
      sequentialId: 'users||1'
    `);
    expect(
      receivingTab.store.state.itemQueries[getCompositeKey('users||1')],
    ).toBeNull();
  });

  test('list query state helpers and mutation rollback resolve alias payloads to the canonical item', async () => {
    const env = createListQueryStoreTestEnv(listIdentityData, {
      resolveItemIdentity: ({ data }) => data.hashId,
    });

    env.forceListUpdate(usersQuery);
    await flushAllTimers();

    // Manual state updates should keep targeting the canonical item even when
    // callers keep using the old sequential payload.
    env.apiStore.updateItemState('users||1', (draft) => {
      draft.name = 'Alice updated through alias';
    });

    expect(env.apiStore.getItemState('user:hash:alice')).toMatchInlineSnapshot(`
      city: 'Rio'
      hashId: 'user:hash:alice'
      id: 2
      name: 'Alice updated through alias'
      sequentialId: 'users||2'
    `);

    env.apiStore.addItemToState('users||1', {
      id: 99,
      hashId: 'user:hash:alice',
      name: 'Alice replaced through alias add',
      sequentialId: 'users||99',
    });

    expect(env.apiStore.getItemState('user:hash:alice')).toMatchInlineSnapshot(`
      hashId: 'user:hash:alice'
      id: 99
      name: 'Alice replaced through alias add'
      sequentialId: 'users||99'
    `);

    // Optimistic mutations capture rollback state from the targeted items. The
    // alias payload should still roll back the canonical item and query entry.
    let optimisticPayload: unknown = null;
    let mutationPayload: unknown = null;
    await env.apiStore.performMutation('users||1', {
      mutation: (payload) => {
        mutationPayload = payload;
        return Promise.reject(new Error('forced mutation failure'));
      },
      optimisticUpdate: (payload) => {
        optimisticPayload = payload;
        env.apiStore.deleteItemState(payload);
      },
      revalidateOnSuccess: false,
      silentErrors: true,
    });

    expect(optimisticPayload).toMatchInlineSnapshot(`"users||1"`);
    expect(mutationPayload).toMatchInlineSnapshot(`"users||1"`);

    expect(env.apiStore.getQueryState(usersQuery)?.items)
      .toMatchInlineSnapshot(`
      ['"user:hash:alice', '"user:hash:bruno']
    `);
    expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(`
      hashId: 'user:hash:alice'
      id: 99
      name: 'Alice replaced through alias add'
      sequentialId: 'users||99'
    `);

    // Alias-based deletes should remove the canonical item and query
    // membership instead of leaving the visible item behind.
    env.apiStore.deleteItemState('users||1');

    expect(env.apiStore.getQueryState(usersQuery)?.items)
      .toMatchInlineSnapshot(`
      ['"user:hash:bruno']
    `);
    expect(env.apiStore.getItemState('users||1')).toBeNull();
  });

  test('collection state helpers resolve alias payloads to the canonical item', async () => {
    const env = createCollectionStoreTestEnv(collectionIdentityData, {
      resolveItemIdentity: ({ data }) => data.value.hashId,
    });

    env.apiStore.scheduleFetch('highPriority', 'seq:1');
    await flushAllTimers();

    // Alias-based updates should keep modifying the canonical cached item.
    env.apiStore.updateItemState('seq:1', (draft) => {
      draft.value.name = 'Alice updated through alias';
    });

    expect(env.apiStore.getItemState('user:hash:alice')).toMatchInlineSnapshot(`
      data:
        value:
          hashId: 'user:hash:alice'
          name: 'Alice updated through alias'
          sequentialId: 'seq:1'

      error: null
      payload: 'user:hash:alice'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);

    env.apiStore.addItemToState('seq:1', {
      value: {
        hashId: 'user:hash:alice',
        name: 'Alice replaced through alias add',
        sequentialId: 'seq:99',
      },
    });

    expect(env.apiStore.getItemState('user:hash:alice')).toMatchInlineSnapshot(`
      data:
        value:
          hashId: 'user:hash:alice'
          name: 'Alice replaced through alias add'
          sequentialId: 'seq:99'

      error: null
      payload: 'user:hash:alice'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);

    // Alias-based deletes should clear the visible canonical item.
    env.apiStore.deleteItemState('seq:1');

    expect(env.apiStore.getItemState('seq:1')).toBeNull();
    expect(
      Object.entries(env.store.state)
        .filter(([, item]) => item !== null)
        .map(([itemKey]) => itemKey),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('collection refetch keeps the latest requested payload when a custom item key collapses entries', async () => {
    const env = createCollectionStoreTestEnv(
      {
        first: { id: '1', name: 'Alice from first lookup' },
        second: { id: '1', name: 'Alice from second lookup' },
      },
      { getCollectionItemKey: () => 'shared-user' },
    );

    env.apiStore.scheduleFetch('highPriority', 'first');
    await flushAllTimers();
    env.apiStore.scheduleFetch('highPriority', 'second');
    await flushAllTimers();

    expect(env.apiStore.getItemKey('second')).toBe(
      getCompositeKey('shared-user'),
    );
    expect(env.apiStore.getItemState('second')).toMatchInlineSnapshot(`
      data:
        value: { id: '1', name: 'Alice from second lookup' }

      error: null
      payload: 'second'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
  });

  test('list query keeps raw item identities unchanged when canonicalization is disabled', async () => {
    const env = createListQueryStoreTestEnv(listIdentityData);

    env.forceListUpdate(usersQuery);
    await flushAllTimers();

    // This guards the opt-in behavior: without the new hook, list identity
    // still follows the original payloads returned by the fetch.
    expect(env.store.state.queries[getCompositeKey(usersQuery)]?.items)
      .toMatchInlineSnapshot(`
        ['"users||1', '"users||2', '"users||3']
      `);
  });
});
