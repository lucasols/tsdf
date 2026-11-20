import { createLoggerStore } from '@ls-stack/utils/testUtils';
import '@testing-library/react/dont-cleanup-after-each';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  listInferFieldsConfig,
  starInferFieldsConfig,
  initialServerData,
} from './listQueryPartialResourcesRegressionsShared';

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

afterAll(() => {
  cleanup();
});

describe('partial resources: imperative getters with ignoreStaleState honor pending invalidations', () => {
  // Finding 5 (P2): `getItemFromStateOrFetch` / `getQueryFromStateOrFetch`
  // with `ignoreStaleState: true` (= "require fresh data") only consulted the
  // state-level per-field invalidation record. A FULL invalidation deletes
  // that record and tracks the obligation in the pending-full-invalidation
  // marker instead — which the getters ignored, so they returned stale cached
  // data as if it were fresh.

  /** Fully loads item 1 ('*'), refetches only 'name' after a full invalidation,
   * leaving 'address' stale while the full-invalidation marker is unresolved. */
  async function setupStaleAddressAfterFullInvalidation(options?: {
    preloadQuery?: boolean;
  }) {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: starInferFieldsConfig,
    });

    if (options?.preloadQuery) {
      // Load the list query first so a cached query exists when the
      // invalidation happens.
      const queryPreload = env.apiStore.getQueryFromStateOrFetch(
        { tableId: 'users' },
        { fields: '*' },
      );
      await flushAllTimers();
      await queryPreload;
    }

    const preload = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: '*',
    });
    await flushAllTimers();
    await preload;

    // A mounted name hook resolves the invalidation refetch for 'name' only.
    const nameHook = renderHook(() =>
      env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['name'],
      }),
    );
    await flushAllTimers();

    env.serverTable.updateItem('users||1', {
      name: 'Renamed User 1',
      address: 'Relocated Address 1',
    });

    act(() => {
      env.apiStore.invalidateItem('users||1');
    });
    await flushAllTimers();

    // Sanity: only 'name' was refetched — 'address' in state is still stale.
    expect(nameHook.result.current.data?.name).toBe('Renamed User 1');
    nameHook.unmount();

    return env;
  }

  test('getItemFromStateOrFetch refetches stale fields instead of returning them from cache', async () => {
    const env = await setupStaleAddressAfterFullInvalidation();
    env.serverTable.clearFetchHistory();

    // Require-fresh read of the still-stale 'address' field: must hit the
    // server, not the cache.
    const addressResultPromise = env.apiStore.getItemFromStateOrFetch(
      'users||1',
      { fields: ['address'], ignoreStaleState: true },
    );
    await flushAllTimers();
    const addressResult = await addressResultPromise;
    expect(addressResult.ok ? addressResult.value.address : null).toBe(
      'Relocated Address 1',
    );

    // Require-fresh read of the full item while the full-invalidation marker
    // is still unresolved: must trigger a full refetch.
    const fullResultPromise = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: '*',
      ignoreStaleState: true,
    });
    await flushAllTimers();
    const fullResult = await fullResultPromise;
    expect(fullResult.ok ? fullResult.value.address : null).toBe(
      'Relocated Address 1',
    );

    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['address']
            itemId: 'users||1'
        - _type: 'item'
          payload: { itemId: 'users||1' }
      `);
  });

  test('getQueryFromStateOrFetch refetches when an item has stale fields from a full invalidation', async () => {
    const env = await setupStaleAddressAfterFullInvalidation({
      preloadQuery: true,
    });
    env.serverTable.clearFetchHistory();

    // Require-fresh query read of the stale 'address' field: item 1 still has
    // an unresolved full invalidation, so the query must refetch.
    const queryResultPromise = env.apiStore.getQueryFromStateOrFetch(
      { tableId: 'users' },
      { fields: ['address'], ignoreStaleState: true },
    );
    await flushAllTimers();
    const queryResult = await queryResultPromise;
    expect(
      queryResult.ok ? queryResult.value.items[0]?.data.address : null,
    ).toBe('Relocated Address 1');

    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: ['address']
            pos: { limit: 50, offset: 0 }
          returned_items: 5
      `);
  });
});

describe('partial resources: mounting a fields:"*" hook during an in-flight fetch', () => {
  // Finding 2 (P1): a `fields: '*'` hook that mounts while another fetch for the
  // same item is already in flight must still refetch the full item once that
  // fetch settles, instead of getting stuck on `loading` forever because the
  // mount-once guard swallowed its only fetch opportunity.
  test('the full-item hook recovers to success after the in-flight partial fetch settles', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
    });

    // Start a partial fetch and leave it in flight (fetch duration is 800ms).
    const { result, rerender } = renderHook(
      ({ mountFullHook }: { mountFullHook: boolean }) => {
        const partialHook = env.apiStore.useItem('users||1', {
          returnRefetchingStatus: true,
          fields: ['name'],
        });

        const fullHook = env.apiStore.useItem(
          mountFullHook ? 'users||1' : false,
          { returnRefetchingStatus: true, fields: '*' },
        );

        return { partial: partialHook, full: fullHook };
      },
      { initialProps: { mountFullHook: false } },
    );

    // Let the partial fetch start but not finish.
    await advanceTime(400);
    expect(result.current.partial.status).toBe('loading');

    // Mount the full-item hook while the partial fetch is still active.
    act(() => {
      rerender({ mountFullHook: true });
    });

    await flushAllTimers();

    // The full-item hook must reach success with the complete item, not stay
    // stuck on loading with null data.
    expect(result.current.full.status).toBe('success');
    expect(result.current.full.data).toMatchInlineSnapshot(`
      address: 'Address 1'
      age: 10
      country: 'Country 1'
      id: 1
      name: 'User 1'
    `);

    // The full-item fetch ('*') was issued once the in-flight partial fetch for
    // 'name' settled — not swallowed by the mount-once guard.
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['name']
            itemId: 'users||1'
        - _type: 'item'
          payload: { itemId: 'users||1' }
      `);
  });
});

describe('partial resources: client-created items inside list queries', () => {
  // Finding 6 (P3): the query-hook array-fields paths must consult `inferFields`
  // like the item-hook paths do. A client-created item appended to a query has
  // no `itemLoadedFields` metadata, but its data already contains the requested
  // fields — the mounted query hook must not schedule a spurious list refetch
  // (which would drop the client-created item, since the server doesn't know it).
  test('appending a complete client-created item to a loaded query does not trigger a refetch', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
    });

    const renders = createLoggerStore();

    // A partial list query is loaded and stays mounted.
    renderHook(() => {
      const { status, items } = env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name'], returnRefetchingStatus: true },
      );

      renders.add({ status, ids: items.map((item) => item.id).join(',') });
    });

    await flushAllTimers();
    renders.addMark('item created on client');

    // The client creates a new item (not on the server yet) and appends it to
    // the query — e.g. an optimistic create. `addItemToState` sets no
    // `itemLoadedFields`, so only `inferFields` can vouch for its data.
    act(() => {
      env.apiStore.addItemToState(
        'users||6',
        {
          id: 6,
          name: 'User 6',
          address: 'Address 6',
          age: 60,
          country: 'Country 6',
        },
        {
          addItemToQueries: { queries: { tableId: 'users' }, appendTo: 'end' },
        },
      );
    });

    await flushAllTimers();

    // The new item shows up in the query, and no refetch is triggered:
    // `inferFields` confirms the item data already has the requested fields.
    // Previously the metadata-free item counted as "missing requested fields",
    // scheduling a required list refetch that removed the client-created item.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ ids: ''
      -> status: success ⋅ ids: 1,2,3,4,5

      >>> item created on client

      -> status: success ⋅ ids: 1,2,3,4,5,6
      "
    `);
    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: ['id', 'name']
            pos: { limit: 50, offset: 0 }
          returned_items: 5
      `);
  });
});

describe('partial resources: per-field invalidation on a fully loaded ("*") item', () => {
  // Finding 8 (P3): `getStaleOrMissingRequestedFields` early-returned `[]` for
  // '*'-loaded items before consulting the pending invalidation fields, so an
  // array-fields list hook over a '*' item never surfaced the immediate
  // `refetching` status override nor `loadingFields` while an invalidated
  // requested field was being refetched.
  test('array-fields list hook reports refetching and loadingFields while an invalidated field refetches', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
    });

    // Load the list without field selection so every item is tracked as fully
    // loaded ('*').
    const preload = env.apiStore.getQueryFromStateOrFetch(
      { tableId: 'users' },
      { fields: '*' },
    );
    await flushAllTimers();
    await preload;

    const renders = createLoggerStore();

    // Array-fields hook over the '*'-loaded items; no fetch is needed yet.
    renderHook(() => {
      const { status, items, loadingFields } = env.apiStore.useListQuery(
        { tableId: 'users' },
        {
          fields: ['name'],
          returnRefetchingStatus: true,
          showPartialAsRefetching: true,
        },
      );

      renders.add({
        status,
        loadingFields: loadingFields ?? null,
        firstName: items[0]?.name,
      });
    });

    await flushAllTimers();
    renders.addMark('invalidate name field');

    // Server data changes, then the (still '*'-loaded) item has the requested
    // 'name' field invalidated.
    env.serverTable.updateItem('users||1', { name: 'Renamed User 1' });

    act(() => {
      env.apiStore.invalidateQueryAndItems({
        itemPayload: 'users||1',
        queryPayload: false,
        fields: ['name'],
      });
    });

    await flushAllTimers();

    // The hook must expose the refetch window: status flips to `refetching`
    // with `loadingFields: [name]` as soon as the field is invalidated (the
    // item stays '*'-loaded, so only the pending invalidation reveals it), and
    // resolves with the fresh value. Previously the whole window was invisible
    // (status stayed success-shaped with no loadingFields).
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ loadingFields: null ⋅ firstName: User 1

      >>> invalidate name field

      -> status: refetching ⋅ loadingFields: [name] ⋅ firstName: User 1
      -> status: success ⋅ loadingFields: null ⋅ firstName: Renamed User 1
      "
    `);
  });
});

describe('partial resources: inferFields reporting a complete snapshot', () => {
  // Finding 3 (P2): when `inferFields` reports `'*'` for a snapshot that carries
  // no field metadata (e.g. a manually inserted item), a `fields: '*'` hook must
  // treat it as fully loaded and render success without an extra fetch.
  test('a fields:"*" hook trusts a manually inserted complete item without refetching', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: starInferFieldsConfig,
    });

    // Insert a complete item directly into state. `addItemToState` does not set
    // `itemLoadedFields`, so the snapshot is only "complete" via `inferFields`.
    act(() => {
      env.apiStore.addItemToState('users||1', {
        id: 1,
        name: 'User 1',
        address: 'Address 1',
        age: 10,
        country: 'Country 1',
      });
    });

    const { result } = renderHook(() => {
      return env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: '*',
      });
    });

    await flushAllTimers();

    // The hook trusts the inferred-complete snapshot: success, no server fetch.
    expect(result.current.status).toBe('success');
    expect(result.current.data?.name).toBe('User 1');
    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(
      `[]`,
    );
  });

  // `itemLoadedFields` metadata only records what fetches delivered, so it is
  // a lower bound on what a snapshot holds. When a mutation writes the
  // remaining fields into a partially fetched item, `inferFields` vouches for
  // the data beyond the tracked metadata — hooks must trust it instead of
  // refetching fields that are already present.
  test('hooks trust fields written beyond the tracked metadata without refetching', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: starInferFieldsConfig,
    });

    // The item is partially fetched: metadata tracks only ['id', 'name'].
    const preload = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: ['id', 'name'],
    });
    await flushAllTimers();
    await preload;

    // A client mutation fills in the remaining fields (e.g. a confirmed
    // mutation response merged into state). The tracked metadata is not
    // updated — only `inferFields` can vouch for the written fields.
    act(() => {
      env.apiStore.updateItemState('users||1', (draft) => {
        draft.address = 'Client Address 1';
        draft.age = 10;
        draft.country = 'Country 1';
      });
    });
    const storeItemKey = env.getStoreItemKeyFromRaw('users||1');
    expect(
      env.store.state.itemLoadedFields[storeItemKey],
    ).toMatchInlineSnapshot(`['id', 'name']`);

    // One hook reads a mutation-written field, another reads the full item.
    const { result } = renderHook(() => {
      const addressHook = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['address'],
      });
      const fullHook = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: '*',
      });
      return { address: addressHook, full: fullHook };
    });

    await flushAllTimers();

    // Both hooks trust the snapshot (`inferFields` reports it complete):
    // success with the client-written data, and no fetch beyond the initial
    // partial load.
    expect(result.current.address.status).toBe('success');
    expect(result.current.address.data?.address).toBe('Client Address 1');
    expect(result.current.full.status).toBe('success');
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['id', 'name']
            itemId: 'users||1'
      `);
  });
});

describe('partial resources: invalidating fields vouched beyond the tracked metadata', () => {
  // Finding: the invalidation staleness baseline consulted `inferFields` only
  // when the `itemLoadedFields` metadata entry was entirely absent. But hooks
  // display any field `inferFields` vouches for — including fields a mutation
  // wrote beyond the tracked metadata (see the "hooks trust fields written
  // beyond the tracked metadata" test above). A field is invalidatable
  // exactly when it is displayable, so the baseline must be the UNION of the
  // tracked metadata and `inferFields`, or invalidations of vouched-only
  // fields are silently dropped and hooks show the stale value forever.

  test('invalidating a mutation-written field beyond the tracked metadata refetches it', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: starInferFieldsConfig,
    });

    // The item is partially fetched: metadata tracks only ['id', 'name'].
    const preload = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: ['id', 'name'],
    });
    await flushAllTimers();
    await preload;

    // A client mutation fills in the remaining fields — only `inferFields`
    // vouches for them, the tracked metadata is not updated.
    act(() => {
      env.apiStore.updateItemState('users||1', (draft) => {
        draft.address = 'Client Address 1';
        draft.age = 10;
        draft.country = 'Country 1';
      });
    });

    // A hook displays the mutation-written field without fetching.
    const { result } = renderHook(() =>
      env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['address'],
      }),
    );
    await flushAllTimers();
    expect(result.current.data?.address).toBe('Client Address 1');
    expect(env.serverTable.getRequestHistory('item').length).toBe(1);

    // The server has newer data and the app invalidates exactly that field.
    env.serverTable.updateItem('users||1', { address: 'Server Address 1' });
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'highPriority',
        fields: ['address'],
      });
    });
    await flushAllTimers();

    // The hook must refetch the invalidated field even though it is not part
    // of the tracked metadata — it is displayed, so it can be stale.
    expect(result.current.status).toBe('success');
    expect(result.current.data?.address).toBe('Server Address 1');
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['id', 'name']
            itemId: 'users||1'
        - _type: 'item'
          payload:
            fields: ['address']
            itemId: 'users||1'
      `);
  });

  test('a full invalidation marks mutation-written fields stale for hooks that mount later', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
    });

    // The item is partially fetched through a mounted hook: metadata tracks
    // only ['name']. A client mutation then writes 'address' beyond it.
    renderHook(() => env.apiStore.useItem('users||1', { fields: ['name'] }));
    await flushAllTimers();
    act(() => {
      env.apiStore.updateItemState('users||1', (draft) => {
        draft.address = 'Client Address 1';
      });
    });

    // The server has newer data and a full invalidation fires. The mounted
    // ['name'] hook consumes the invalidation event and refetches its own
    // field right away.
    env.serverTable.updateItem('users||1', { address: 'Server Address 1' });
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'highPriority',
      });
    });
    await flushAllTimers();

    // A hook for the mutation-written field mounts only after the
    // invalidation settled: the field must still be owed a refetch — the full
    // invalidation covered everything displayable, not just the tracked
    // metadata fields.
    const lateHook = renderHook(() =>
      env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['address'],
      }),
    );
    await flushAllTimers();

    expect(lateHook.result.current.status).toBe('success');
    expect(lateHook.result.current.data?.address).toBe('Server Address 1');
  });
});
