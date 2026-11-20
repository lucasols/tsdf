import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import { type Row } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { getParsedLocalStorageValue } from '../utils/persistentStorageOptimizationTestUtils';
import {
  persistentStore,
  rawItemPayload,
  storeItemKey,
  itemStorageKey,
  createEnv,
} from './listQueryStorePersistenceTestShared';

const partialResourcesConfig: PartialResourcesConfig<Row> = {
  mergeItems: (prev, fetched) => {
    if (!prev) return fetched;
    return { ...prev, ...fetched };
  },
  selectFields: (fields, item) => {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in item) {
        result[field] = item[field];
      }
    }
    return __LEGIT_CAST__<Row, Record<string, unknown>>(result);
  },
  inferFields: (item) =>
    Object.entries(item)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field),
};

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

describe('localStorage: list query store persistence', () => {
  test('round-trip persistence preserves partial-resource metadata for cached list queries', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-partial-roundtrip';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Cached' }] },
    });

    // The writer persists a partial list result, including the loaded-field
    // metadata needed to know which item fields are actually complete.
    renderHook(() => {
      writerEnv.apiStore.useListQuery(usersQuery, { fields: ['id', 'name'] });
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    const renders = createLoggerStore();

    // Assert the synchronous hydration result before flushing the mount effect;
    // this isolates whether localStorage restored the partial metadata.
    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        fields: ['id', 'name'],
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      "
    `);
    expect(readerEnv.serverTable.numOfFinishedFetches).toBe(0);
    // The restored item must still know that only id/name were loaded, even
    // though the cached object is already usable by the hook.
    expect(readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        ['id', 'name']
      `);
  });

  test("round-trip persistence preserves the fully-loaded ('*') marker for cached items", async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-full-star-roundtrip';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Cached', age: 31, email: 'cached@site.test' }],
      },
    });

    // The writer fetches the complete item; the persisted snapshot must carry
    // the fully-loaded marker (`lf: '*'`) instead of an enumerated field list.
    writerEnv.apiStore.scheduleItemFetch('highPriority', itemPayload, {
      fields: '*',
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { age: 31, email: 'cached@site.test', id: 1, name: 'Cached' }
      lf: '*'
      p: 'users||1'
    `);

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', age: 32, email: 'fresh@site.test' }],
      },
    });

    const renders = createLoggerStore();

    // A full ('*') read must be satisfiable straight from hydration: the first
    // render is already a success, which only happens when the restored marker
    // is '*' — a fabricated field list would not vouch for a complete item.
    renderHook(() => {
      const { data, status } = readerEnv.apiStore.useItem(itemPayload, {
        fields: '*',
        returnRefetchingStatus: true,
      });

      renders.add({ status, name: data?.name ?? null });
    });

    // Assert the synchronous hydration result before flushing the mount effect.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: Cached
      "
    `);
    expect(readerEnv.serverTable.numOfFinishedFetches).toBe(0);
    expect(
      readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)],
    ).toBe('*');

    await flushAllTimers();

    // The hydrated snapshot only revalidates (a single low-priority refetch of
    // the complete item), it never blocks the UI behind a loading state.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: Cached
      ⋅⋅⋅
      -> status: refetching ⋅ name: Cached
      -> status: success ⋅ name: Fresh
      "
    `);
    expect(
      readerEnv.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'item'
        payload: { itemId: 'users||1' }
    `);
    expect(
      readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)],
    ).toBe('*');
  });

  test('items invalidated before a reload are still shown from cache, including fields the server omitted', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-partial-invalidated-before-reload';
    const sessionKey = 'sess1';
    const requestedFields = ['id', 'name', 'email'];

    // The server row has no `email`: the request loads the field, but the
    // item snapshot does not carry it, so `inferFields` cannot vouch for it —
    // only the loaded-fields metadata can.
    const writerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Cached' }] },
    });

    const { unmount } = renderHook(() => {
      writerEnv.apiStore.useListQuery(usersQuery, { fields: requestedFields });
    });
    await flushAllTimers();
    unmount();

    // Everything gets invalidated (e.g. a realtime reconnect) and the tab is
    // closed before any refetch: the invalidation must not erase which fields
    // the persisted snapshot holds.
    act(() => {
      writerEnv.apiStore.invalidateQueryAndItems({
        all: true,
        type: 'realtimeUpdate',
      });
    });
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Cached' }
      lf: ['email', 'id', 'name']
      p: 'users||1'
    `);

    // After the reload the server cannot be reached (offline), so the cache
    // is all the UI has.
    const readerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });
    readerEnv.serverTable.setNextListFetchError('offline');

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        fields: requestedFields,
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });
    await flushAllTimers();

    // The cached row is visible from the first render and stays visible when
    // the revalidation fails, instead of an endless loading state with no rows.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      -> status: refetching ⋅ names: [Cached]
      -> status: error ⋅ names: [Cached]
      "
    `);
  });

  test("a fully-loaded ('*') item invalidated before a reload still satisfies a full read from cache", async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-full-star-invalidated-before-reload';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Cached' }] },
    });

    writerEnv.apiStore.scheduleItemFetch('highPriority', itemPayload, {
      fields: '*',
    });
    await flushAllTimers();

    // The complete item is invalidated and the tab is closed before a refetch.
    act(() => {
      writerEnv.apiStore.invalidateItem(itemPayload, 'realtimeUpdate');
    });
    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });
    readerEnv.serverTable.setNextFetchError(itemPayload, 'offline');

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = readerEnv.apiStore.useItem(itemPayload, {
        fields: '*',
        returnRefetchingStatus: true,
      });

      renders.add({ status, name: data?.name ?? null });
    });
    await flushAllTimers();

    // The restored snapshot is still a complete item: it is shown right away
    // and kept while the revalidation cannot reach the server.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: Cached
      -> status: refetching ⋅ name: Cached
      -> status: error ⋅ name: Cached
      "
    `);
  });

  test('a failed mutation rollback keeps a concurrent invalidation in state and the snapshot fields in storage', async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-rollback-loaded-fields';
    const sessionKey = 'sess1';

    const env = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Server' }] },
    });

    // A manually added item has no loadedFields metadata entry — for such
    // items `inferFields` governs the staleness baseline, so the persisted
    // snapshot must carry no `lf` field either.
    act(() => {
      env.apiStore.addItemToState(itemPayload, { id: 1, name: 'Client draft' });
    });
    await advanceTime(1100);
    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Client draft' }
      p: 'users||1'
    `);

    // Start a slow save that will ultimately fail. The rollback snapshot is
    // captured now, while the item is still metadata-free.
    let rejectMutation: (error: Error) => void = () => {};
    let mutationResult!: Promise<unknown>;
    act(() => {
      mutationResult = env.apiStore.performMutation(itemPayload, {
        optimisticUpdate: () => {
          env.apiStore.updateItemState(itemPayload, (draft) => {
            draft.name = 'Optimistic';
          });
        },
        mutation: () =>
          new Promise((_resolve, reject) => {
            rejectMutation = reject;
          }),
      });
    });

    // While the save is in flight the item gets invalidated (e.g. by a
    // real-time event). On a partial-resources store this clears the loaded
    // fields to `[]`, and the refetch it schedules is deferred until the
    // mutation settles. Make that deferred refetch fail so no fresh fetch
    // metadata masks what the rollback leaves behind.
    env.serverTable.setNextFetchError(itemPayload, 'refetch offline');
    act(() => {
      env.apiStore.invalidateItem(itemPayload);
    });

    // A regular flush runs mid-mutation. The invalidation only marks the item
    // as stale: the persisted entry keeps listing the fields its snapshot
    // holds, so the cache stays usable if the tab is reloaded right now.
    await advanceTime(1100);
    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Optimistic' }
      lf: ['id', 'name']
      p: 'users||1'
    `);

    // The save fails: the rollback only reverts what the optimistic update
    // changed (the name). The invalidation happened independently of the
    // mutation, so its cleared loaded fields stay, just like they would have
    // without the mutation.
    rejectMutation(new Error('save failed'));
    await act(async () => {
      await mutationResult;
    });
    await advanceTime(1100);
    await flushAllTimers();

    // The invalidation is still pending in state (nothing was refetched), and
    // the follow-up flush persists the reverted data with the fields the
    // snapshot holds.
    expect(
      env.store.state.itemLoadedFields[storeItemKey('users', 1)],
    ).toMatchInlineSnapshot(`[]`);
    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Client draft' }
      lf: ['id', 'name']
      p: 'users||1'
    `);
  });

  test('partial-resource persistence stores each item with its own loaded fields', async () => {
    const storeName = 'lq-partial-multiple-item-fields';
    const sessionKey = 'sess1';

    const env = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [
          { id: 1, name: 'Alice', age: 31, email: 'alice@site.test' },
          { id: 2, name: 'Bob', age: 42, email: 'bob@site.test' },
        ],
      },
    });

    // Each item is fetched through the public item API with a different field set.
    env.apiStore.scheduleItemFetch('highPriority', rawItemPayload('users', 1), {
      fields: ['id', 'name'],
    });
    env.apiStore.scheduleItemFetch('highPriority', rawItemPayload('users', 2), {
      fields: ['id', 'name', 'age'],
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Alice' }
      lf: ['id', 'name']
      p: 'users||1'
    `);
    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 2),
      ),
    ).toMatchInlineSnapshot(`
      d: { age: 42, id: 2, name: 'Bob' }
      lf: ['age', 'id', 'name']
      p: 'users||2'
    `);
  });

  test('hydration keeps extra persisted fields visible even when loadedFields is narrower', async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-partial-extra-data-visible';
    const sessionKey = 'sess1';

    // Seed a realistic persisted entry where the data snapshot is richer than
    // the saved partial-resource metadata.
    persistentStore
      .scope(storeName, sessionKey)
      .listQuery.seedItem(
        'users',
        1,
        { id: 1, name: 'Cached', email: 'cached@site.test' },
        { loadedFields: ['id', 'name'] },
      );

    const env = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', email: 'fresh@site.test' }],
      },
    });

    const renders = createLoggerStore();

    // The hook asks for email too. Cached email remains visible immediately,
    // but loadedFields is narrower, so the item should revalidate.
    renderHook(() => {
      const { data, status } = env.apiStore.useItem(itemPayload, {
        fields: ['id', 'name', 'email'],
        returnRefetchingStatus: true,
      });

      renders.add({
        status,
        name: data?.name ?? null,
        email: data?.email ?? null,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: Cached ⋅ email: cached@site.test
      -> status: refetching ⋅ name: Cached ⋅ email: cached@site.test
      -> status: success ⋅ name: Fresh ⋅ email: fresh@site.test
      "
    `);
    // The revalidation fetches the complete field set requested by the mounted
    // hook, not just the narrower metadata restored from storage.
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['email', 'id', 'name']
            itemId: 'users||1'
      `);
  });

  test('later partial saves keep extra fields already present in persisted item data', async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-partial-keep-extra-fields-on-save';
    const sessionKey = 'sess1';

    // Seed a cached item whose data has email, while loadedFields says future
    // partial fetches only need to keep id/name fresh.
    persistentStore
      .scope(storeName, sessionKey)
      .listQuery.seedItem(
        'users',
        1,
        { id: 1, name: 'Cached', email: 'cached@site.test' },
        { loadedFields: ['id', 'name'] },
      );

    const env = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', email: 'fresh@site.test' }],
      },
    });

    // Mounting with id/name triggers the normal hydration revalidation for the
    // same partial field set.
    renderHook(() => {
      env.apiStore.useItem(itemPayload, { fields: ['id', 'name'] });
    });

    await flushAllTimers();

    // Save new partial data for the same item. The persisted snapshot should
    // keep the older extra field instead of cleaning it up.
    env.apiStore.scheduleItemFetch('highPriority', itemPayload, {
      fields: ['id', 'name'],
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { email: 'cached@site.test', id: 1, name: 'Fresh' }
      lf: ['id', 'name']
      p: 'users||1'
    `);
  });

  test('hydrated partial-resource items keep loading until missing fields are fetched', async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-item-partial-missing-fields';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Cached', age: 20, email: 'cached@site.test' }],
      },
    });

    renderHook(() => {
      writerEnv.apiStore.useItem(itemPayload, {
        fields: ['id', 'name', 'age'],
      });
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', age: 21, email: 'fresh@site.test' }],
      },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = readerEnv.apiStore.useItem(itemPayload, {
        fields: ['id', 'name', 'age', 'email'],
        returnRefetchingStatus: true,
      });

      renders.add({
        status,
        name: data?.name ?? null,
        age: data?.age ?? null,
        email: data?.email ?? null,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ name: null ⋅ age: null ⋅ email: null
      -> status: success ⋅ name: Fresh ⋅ age: 21 ⋅ email: fresh@site.test
      "
    `);
    expect(
      readerEnv.serverTable.getRequestHistory('item').map((entry) => {
        const { time: _time, ...request } = entry;
        return request;
      }),
    ).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['age', 'email', 'id', 'name']
          itemId: 'users||1'
    `);
    expect(readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        ['age', 'email', 'id', 'name']
      `);
  });

  test('a hydrated fields:"*" hook does not report success from a partial persisted snapshot', async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-item-partial-full-hook';
    const sessionKey = 'sess1';

    // Persisted entry only holds a partial field set (id/name). This config's
    // inferFields never returns '*', so the fallback snapshot is genuinely
    // incomplete — a fields:'*' hook must not trust it.
    persistentStore
      .scope(storeName, sessionKey)
      .listQuery.seedItem(
        'users',
        1,
        { id: 1, name: 'Cached' },
        { loadedFields: ['id', 'name'] },
      );

    const env = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', age: 21, email: 'fresh@site.test' }],
      },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = env.apiStore.useItem(itemPayload, {
        fields: '*',
        returnRefetchingStatus: true,
      });

      renders.add({
        status,
        name: data?.name ?? null,
        age: data?.age ?? null,
        email: data?.email ?? null,
      });
    });

    await flushAllTimers();

    // The fields:'*' hook must revalidate: it may not surface `success` from the
    // partial persisted fallback (which lacks age/email). Previously the
    // fallback render treated any fields:'*' request as satisfied.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ name: null ⋅ age: null ⋅ email: null
      -> status: success ⋅ name: Fresh ⋅ age: 21 ⋅ email: fresh@site.test
      "
    `);

    // A full-item fetch is issued to complete the missing fields.
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload: { itemId: 'users||1' }
      `);
  });

  test('hydrating an item persisted without loadedFields metadata does not fabricate metadata from object keys', async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-item-metadata-free-hydration';
    const sessionKey = 'sess1';

    // A client-created item is persisted. `addItemToState` sets no
    // `itemLoadedFields`, so the persisted entry carries no `lf` metadata —
    // `inferFields` is the designed authority for such snapshots.
    const writerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
    });

    // No hooks are mounted on the writer env; no act() wrapper needed.
    writerEnv.apiStore.addItemToState(itemPayload, {
      id: 1,
      name: 'Created',
      email: 'created@site.test',
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    // The persisted entry has no `lf` key.
    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { email: 'created@site.test', id: 1, name: 'Created' }
      p: 'users||1'
    `);

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', email: 'fresh@site.test' }],
      },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = readerEnv.apiStore.useItem(itemPayload, {
        fields: ['id', 'name'],
        returnRefetchingStatus: true,
      });

      renders.add({ status, name: data?.name ?? null });
    });

    await flushAllTimers();

    // Cached data is visible immediately and the mount revalidation refreshes
    // the requested fields.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: Created
      -> status: refetching ⋅ name: Created
      -> status: success ⋅ name: Fresh
      "
    `);

    // Only the fields actually fetched become loaded-field metadata. Previously
    // hydration fabricated `['email', 'id', 'name']` from the snapshot's object
    // keys — the shallow inference the partial-resources design forbids — and
    // the never-fetched email was falsely marked as loaded/fresh.
    expect(readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        ['id', 'name']
      `);
  });

  test('hydrated partial-resource queries refetch when hooks request fields missing from storage', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-partial-missing-fields';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Cached', age: 20, email: 'cached@site.test' }],
      },
    });

    renderHook(() => {
      writerEnv.apiStore.useListQuery(usersQuery, {
        fields: ['id', 'name', 'age'],
      });
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', age: 21, email: 'fresh@site.test' }],
      },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        fields: ['id', 'name', 'age', 'email'],
        returnRefetchingStatus: true,
      });

      const firstItem = items[0];

      renders.add({
        status,
        item:
          firstItem === undefined
            ? null
            : {
                name: firstItem.name,
                age: firstItem.age ?? null,
                email: firstItem.email ?? null,
              },
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ item: null
      -> status: success ⋅ item: {name:Fresh, age:21, email:fresh@site.test}
      "
    `);
    expect(
      readerEnv.serverTable.getRequestHistory('list').map((entry) => {
        const { time: _time, ...request } = entry;
        return request;
      }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['age', 'email', 'id', 'name']
          pos: { limit: 50, offset: 0 }
        returned_items: 1
    `);
    expect(readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        ['age', 'email', 'id', 'name']
      `);
  });

  test('a list requesting more fields than a loaded query holds shows a loading state, not an empty list, while the missing fields are fetched', async () => {
    const usersQuery = { tableId: 'users' };
    const env = createEnv({
      storeName: 'lq-wider-fields-unrestorable-rows',
      sessionKey: 'sess1',
      partialResources: partialResourcesConfig,
      serverData: {
        users: [
          { id: 1, name: 'Ada', age: 30 },
          { id: 2, name: 'Grace', age: 40 },
        ],
      },
    });
    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ showMoreColumns }: { showMoreColumns: boolean }) => {
        // The list as first shown: only ids. Rows holding only `id` are saved
        // to storage but cannot be restored from it, since the storage schema
        // requires `name` — so storage has the query without any usable row.
        const idsOnly = env.apiStore.useListQuery(usersQuery, {
          fields: ['id'],
        });
        // The same query read with more columns, mounted later.
        const moreColumns = env.apiStore.useListQuery(
          showMoreColumns && usersQuery,
          { fields: ['id', 'name', 'age'] },
        );
        // Same, but opting into showing the cached columns meanwhile.
        const moreColumnsKeepingRows = env.apiStore.useListQuery(
          showMoreColumns && usersQuery,
          { fields: ['id', 'name', 'age'], showPartialAsRefetching: true },
        );

        renders.add({
          idsOnly: `${idsOnly.status} ${JSON.stringify(idsOnly.items)}`,
          moreColumns: `${moreColumns.status} (isLoading: ${moreColumns.isLoading}) ${JSON.stringify(moreColumns.items)}`,
          moreColumnsKeepingRows: `${moreColumnsKeepingRows.status} (loadingFields: ${moreColumnsKeepingRows.loadingFields?.join(',') ?? 'none'}) ${JSON.stringify(moreColumnsKeepingRows.items)}`,
        });
      },
      { initialProps: { showMoreColumns: false } },
    );
    await flushAllTimers();

    renders.addMark('more columns are shown');
    act(() => {
      rerender({ showMoreColumns: true });
    });
    await flushAllTimers();

    // While `name` and `age` are fetched the wider list must not report
    // `success` with no rows (an empty state): it is `loading`, or keeps the
    // cached rows with `showPartialAsRefetching`. The ids-only list is not
    // disturbed.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ idsOnly: loading []
      ⋅ moreColumns: idle (isLoading: false) []
      ⋅ moreColumnsKeepingRows: idle (loadingFields: none) []
      └─
      ┌─
      ⋅ idsOnly: success [{"id":1},{"id":2}]
      ⋅ moreColumns: idle (isLoading: false) []
      ⋅ moreColumnsKeepingRows: idle (loadingFields: none) []
      └─

      >>> more columns are shown

      ┌─
      ⋅ idsOnly: success [{"id":1},{"id":2}]
      ⋅ moreColumns: loading (isLoading: true) []
      ⋅ moreColumnsKeepingRows: success (loadingFields: name,age) [{"id":1},{"id":2}]
      └─
      ┌─
      ⋅ idsOnly: success [{"id":1},{"id":2}]
      ⋅ moreColumns: success (isLoading: false) [{"id":1,"name":"Ada","age":30},{"id":2,"name":"Grace","age":40}]
      ⋅ moreColumnsKeepingRows: success (loadingFields: none) [{"id":1,"name":"Ada","age":30},{"id":2,"name":"Grace","age":40}]
      └─
      "
    `);
    // One fetch for the first list, one for the columns that were missing.
    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: ['id']
            pos: { limit: 50, offset: 0 }
          returned_items: 2
        - _type: 'list'
          payload:
            fields: ['age', 'id', 'name']
            pos: { limit: 50, offset: 0 }
          returned_items: 2
      `);
  });

  test('a list requesting more fields than a loaded query holds keeps loading when storage can restore the rows already loaded', async () => {
    const usersQuery = { tableId: 'users' };
    const env = createEnv({
      storeName: 'lq-wider-fields-restorable-rows',
      sessionKey: 'sess1',
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Ada', age: 30 }] },
    });
    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ showMoreColumns }: { showMoreColumns: boolean }) => {
        // `id` and `name` satisfy the storage schema, so these rows can be
        // restored from storage — but they still lack `age`.
        const fewColumns = env.apiStore.useListQuery(usersQuery, {
          fields: ['id', 'name'],
        });
        const moreColumns = env.apiStore.useListQuery(
          showMoreColumns && usersQuery,
          { fields: ['id', 'name', 'age'] },
        );

        renders.add({
          fewColumns: `${fewColumns.status} ${JSON.stringify(fewColumns.items)}`,
          moreColumns: `${moreColumns.status} ${JSON.stringify(moreColumns.items)}`,
        });
      },
      { initialProps: { showMoreColumns: false } },
    );
    await flushAllTimers();

    renders.addMark('more columns are shown');
    act(() => {
      rerender({ showMoreColumns: true });
    });
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> fewColumns: loading [] ⋅ moreColumns: idle []
      -> fewColumns: success [{"id":1,"name":"Ada"}] ⋅ moreColumns: idle []

      >>> more columns are shown

      -> fewColumns: success [{"id":1,"name":"Ada"}] ⋅ moreColumns: loading []
      ┌─
      ⋅ fewColumns: success [{"id":1,"name":"Ada"}]
      ⋅ moreColumns: success [{"id":1,"name":"Ada","age":30}]
      └─
      "
    `);
  });

  test('a list requesting more fields does not show only the rows another hook already loaded in full', async () => {
    const usersQuery = { tableId: 'users' };
    const env = createEnv({
      storeName: 'lq-wider-fields-truncated-rows',
      sessionKey: 'sess1',
      partialResources: partialResourcesConfig,
      serverData: {
        users: [
          { id: 1, name: 'Ada', age: 30 },
          { id: 2, name: 'Grace', age: 40 },
        ],
      },
    });
    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ showMoreColumns }: { showMoreColumns: boolean }) => {
        // The list holds only ids, and a details view loaded the first user
        // with every column the wider list will need. Storage can restore
        // that user only: the row of the second user holds just `id`, which
        // the storage schema rejects.
        const idsOnly = env.apiStore.useListQuery(usersQuery, {
          fields: ['id'],
        });
        env.apiStore.useItem('users||1', { fields: ['id', 'name', 'age'] });
        const moreColumns = env.apiStore.useListQuery(
          showMoreColumns && usersQuery,
          { fields: ['id', 'name', 'age'] },
        );

        renders.add({
          idsOnly: `${idsOnly.status} ${JSON.stringify(idsOnly.items)}`,
          moreColumns: `${moreColumns.status} ${JSON.stringify(moreColumns.items)}`,
        });
      },
      { initialProps: { showMoreColumns: false } },
    );
    await flushAllTimers();

    renders.addMark('more columns are shown');
    act(() => {
      rerender({ showMoreColumns: true });
    });
    await flushAllTimers();

    // The wider list must not report `success` with the first user alone
    // while the columns of the second user are fetched.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> idsOnly: loading [] ⋅ moreColumns: idle []
      -> idsOnly: success [{"id":1},{"id":2}] ⋅ moreColumns: idle []

      >>> more columns are shown

      -> idsOnly: success [{"id":1},{"id":2}] ⋅ moreColumns: loading []
      ┌─
      ⋅ idsOnly: success [{"id":1},{"id":2}]
      ⋅ moreColumns: success [{"id":1,"name":"Ada","age":30},{"id":2,"name":"Grace","age":40}]
      └─
      "
    `);
  });

  test('useMultipleListQueries: adding an entry with more fields for a loaded query shows it loading, not as an empty list', async () => {
    const usersQuery = { tableId: 'users' };
    const env = createEnv({
      storeName: 'lq-wider-fields-multiple-queries',
      sessionKey: 'sess1',
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Ada', age: 30 }] },
    });
    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ showMoreColumns }: { showMoreColumns: boolean }) => {
        // Rows holding only `id` cannot be restored from storage (the storage
        // schema requires `name`).
        const [idsOnly, moreColumns] = env.apiStore.useMultipleListQueries([
          { payload: usersQuery, fields: ['id'] },
          ...(showMoreColumns
            ? [{ payload: usersQuery, fields: ['id', 'name', 'age'] }]
            : []),
        ]);

        renders.add({
          idsOnly: `${idsOnly?.status} ${JSON.stringify(idsOnly?.items)}`,
          moreColumns: moreColumns
            ? `${moreColumns.status} (isLoading: ${moreColumns.isLoading}) ${JSON.stringify(moreColumns.items)}`
            : 'not requested',
        });
      },
      { initialProps: { showMoreColumns: false } },
    );
    await flushAllTimers();

    renders.addMark('more columns are shown');
    act(() => {
      rerender({ showMoreColumns: true });
    });
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> idsOnly: loading [] ⋅ moreColumns: not requested
      -> idsOnly: success [{"id":1}] ⋅ moreColumns: not requested

      >>> more columns are shown

      -> idsOnly: success [{"id":1}] ⋅ moreColumns: loading (isLoading: true) []
      ┌─
      ⋅ idsOnly: success [{"id":1}]
      ⋅ moreColumns: success (isLoading: false) [{"id":1,"name":"Ada","age":30}]
      └─
      "
    `);
  });
});
