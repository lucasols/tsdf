import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
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
import type { ItemLoadedFields } from '../../src/listQueryStore/types';
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import {
  createListQueryStoreTestEnv,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, range } from '../utils/genericTestUtils';

const mergeAndSelect = {
  mergeItems: (prev: Row | undefined, fetched: Row) => {
    if (!prev) return fetched;
    return { ...prev, ...fetched };
  },
  selectFields: (fields: readonly string[], item: Row) => {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in item) {
        result[field] = item[field];
      }
    }
    return __LEGIT_CAST__<Row, Record<string, unknown>>(result);
  },
} satisfies Pick<PartialResourcesConfig<Row>, 'mergeItems' | 'selectFields'>;

const ALL_FIELDS = ['id', 'name', 'address', 'age', 'country'] as const;

/** `inferFields` that reports the concrete list of defined fields (never `'*'`). */
const listInferFieldsConfig: PartialResourcesConfig<Row> = {
  ...mergeAndSelect,
  inferFields: (item) =>
    Object.entries(item)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field),
};

/**
 * `inferFields` that returns the `'*'` sentinel once every field is present —
 * the shape the docs describe for manually inserted / offline / persisted rows.
 */
const starInferFieldsConfig: PartialResourcesConfig<Row> = {
  ...mergeAndSelect,
  inferFields: (item): ItemLoadedFields => {
    const isComplete = ALL_FIELDS.every((field) => item[field] !== undefined);
    if (isComplete) return '*';
    return Object.entries(item)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field);
  },
};

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({
    id,
    name: `User ${id}`,
    address: `Address ${id}`,
    age: id * 10,
    country: `Country ${id}`,
  })),
};

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

describe('partial resources: full invalidation of a fully-loaded item', () => {
  // Finding 1 (P1): a full `invalidateItem` on a `'*'`-loaded item must keep
  // *every* mounted field hook obligated to refetch. Only one hook actually
  // schedules the refetch (deduplicated via the shared invalidation trigger
  // set); the rest rely on the durable full-invalidation marker so they don't
  // keep trusting the now-stale snapshot via `inferFields`.
  test('all mounted field hooks refetch their own fields after a full invalidation', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
    });

    // Fully load the item ('*') without keeping a '*' hook mounted, so the
    // refetch obligation can only be satisfied by the array-field hooks below.
    const preload = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: '*',
    });
    await flushAllTimers();
    await preload;

    // Two independent hooks each read a different field from the '*' snapshot.
    const { result } = renderHook(() => {
      const nameHook = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['name'],
      });
      const addressHook = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['address'],
      });

      return { name: nameHook, address: addressHook };
    });

    await flushAllTimers();

    // Both hooks see the loaded data as success (no fetch needed yet).
    expect(result.current.name.status).toBe('success');
    expect(result.current.address.status).toBe('success');

    // Server data changes for both fields, then the whole item is invalidated.
    env.serverTable.updateItem('users||1', {
      name: 'Renamed User 1',
      address: 'Relocated Address 1',
    });

    act(() => {
      env.apiStore.invalidateItem('users||1');
    });

    await flushAllTimers();

    // Both hooks must end up with the fresh server values. Previously the
    // address hook kept the stale 'Address 1' because the full-invalidation
    // obligation was dropped once the name hook's partial refetch resolved.
    expect(result.current.name.data?.name).toBe('Renamed User 1');
    expect(result.current.address.data?.address).toBe('Relocated Address 1');
    expect(result.current.name.status).toBe('success');
    expect(result.current.address.status).toBe('success');

    // Exactly one preload ('*') plus a single coalesced refetch covering both
    // mounted hooks' fields — no duplicate requests and no over-broad ('*')
    // refetch.
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload: { itemId: 'users||1' }
        - _type: 'item'
          payload:
            fields: ['address', 'name']
            itemId: 'users||1'
      `);
  });

  // Finding: `invalidateItem` derived the invalidation baseline only from
  // `itemLoadedFields`. A client-created (metadata-free) item vouched as
  // complete by `inferFields` recorded NO durable staleness marker, so after
  // one partial refetch consumed `refetchOnMount`, other field hooks kept
  // trusting the stale snapshot via `inferFields` forever.
  test('field hooks refetch after a full invalidation of a client-created (metadata-free) item', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: starInferFieldsConfig,
    });

    // A complete item is inserted directly into state (e.g. created on the
    // client). It has no `itemLoadedFields` metadata — `inferFields` reports it
    // as complete ('*').
    act(() => {
      env.apiStore.addItemToState('users||1', {
        id: 1,
        name: 'User 1',
        address: 'Address 1',
        age: 10,
        country: 'Country 1',
      });
    });

    // Two independent hooks each read a different field; both trust the
    // inferred-complete snapshot, so no fetch happens.
    const { result } = renderHook(() => {
      const nameHook = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['name'],
      });
      const addressHook = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['address'],
      });

      return { name: nameHook, address: addressHook };
    });

    await flushAllTimers();

    expect(result.current.name.status).toBe('success');
    expect(result.current.address.status).toBe('success');
    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(
      `[]`,
    );

    // Server data changes for both fields, then the whole item is invalidated.
    env.serverTable.updateItem('users||1', {
      name: 'Renamed User 1',
      address: 'Relocated Address 1',
    });

    act(() => {
      env.apiStore.invalidateItem('users||1');
    });

    await flushAllTimers();

    // Both hooks must end up with the fresh server values. Previously only the
    // name hook refetched (via `refetchOnMount`); the address hook kept the
    // stale 'Address 1' because no durable full-invalidation marker existed for
    // the metadata-free item, letting `inferFields` vouch for the stale field.
    expect(result.current.name.data?.name).toBe('Renamed User 1');
    expect(result.current.address.data?.address).toBe('Relocated Address 1');
    expect(result.current.name.status).toBe('success');
    expect(result.current.address.status).toBe('success');

    // Each refetch requested only its own field — no duplicate or full fetches.
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['name']
            itemId: 'users||1'
        - _type: 'item'
          payload:
            fields: ['address']
            itemId: 'users||1'
      `);
  });

  // Finding 3 (P2): resolving a fetch while a per-field invalidation was still
  // unresolved *replaced* the item's pending invalidation fields with only the
  // per-field ones, silently dropping the fields still owed from an earlier
  // full invalidation. Hooks for the dropped fields then trusted the stale
  // snapshot via `inferFields` and never refetched.
  test('a per-field invalidation does not erase the refetch obligation of an earlier full invalidation', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
    });

    // Load name + address, then leave the item unmounted so the invalidations
    // below are only satisfied by later mounts.
    const preload = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: ['name', 'address'],
    });
    await flushAllTimers();
    await preload;

    // Server data changes, then: a FULL invalidation (owes name + address)
    // followed by a per-field invalidation of 'age'.
    env.serverTable.updateItem('users||1', {
      name: 'Renamed User 1',
      address: 'Relocated Address 1',
    });

    act(() => {
      env.apiStore.invalidateItem('users||1');
      env.apiStore.invalidateQueryAndItems({
        itemPayload: 'users||1',
        queryPayload: false,
        fields: ['age'],
      });
    });

    // A name hook mounts and refetches; resolving it prunes the invalidation
    // tracking while the 'age' per-field invalidation is still unresolved —
    // this is where the 'address' obligation used to be dropped.
    const nameHook = renderHook(() =>
      env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['name'],
      }),
    );
    await flushAllTimers();
    expect(nameHook.result.current.data?.name).toBe('Renamed User 1');
    nameHook.unmount();

    // An age hook mounts and resolves the per-field invalidation.
    const ageHook = renderHook(() =>
      env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['age'],
      }),
    );
    await flushAllTimers();
    expect(ageHook.result.current.status).toBe('success');
    ageHook.unmount();

    // The address field is still owed from the full invalidation: a mounting
    // address hook must refetch it instead of trusting the stale snapshot.
    const addressHook = renderHook(() =>
      env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['address'],
      }),
    );
    await flushAllTimers();

    expect(addressHook.result.current.status).toBe('success');
    // Previously stayed 'Address 1' (stale) with no refetch.
    expect(addressHook.result.current.data?.address).toBe(
      'Relocated Address 1',
    );
    addressHook.unmount();

    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['name', 'address']
            itemId: 'users||1'
        - _type: 'item'
          payload:
            fields: ['name']
            itemId: 'users||1'
        - _type: 'item'
          payload:
            fields: ['age']
            itemId: 'users||1'
        - _type: 'item'
          payload:
            fields: ['address']
            itemId: 'users||1'
      `);
  });
});

describe('partial resources: status and fetch decisions agree on inferFields', () => {
  // Finding 1 (P1): the result selector decided "is this field available?"
  // by checking raw object keys, while the fetch effect trusted
  // `inferFields`. When fields are logical names (per docs, fields do NOT
  // need to be raw item keys), the two disagreed: the hook was stuck on
  // `loading` forever while no fetch was ever scheduled.
  test('a logical (non-key) field vouched by inferFields resolves to success without any fetch', async () => {
    // Fields are logical names resolved by the API — `inferFields` vouches for
    // complete client-created rows, and `selectFields` exposes the row as-is.
    const logicalFieldsConfig: PartialResourcesConfig<Row> = {
      mergeItems: mergeAndSelect.mergeItems,
      selectFields: (_fields, item) => item,
      inferFields: () => '*',
    };

    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: logicalFieldsConfig,
    });

    // Client-created item without loaded-fields metadata.
    act(() => {
      env.apiStore.addItemToState('users||1', {
        id: 1,
        name: 'User 1',
        address: 'Address 1',
        age: 10,
        country: 'Country 1',
      });
    });

    const renders = createLoggerStore();

    // 'contactInfo' is a logical field — it is not a raw key of the item, but
    // `inferFields` vouches the snapshot is complete, so it is covered.
    renderHook(() => {
      const { status, data } = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['contactInfo'],
      });

      renders.add({ status, name: data?.name });
    });

    await flushAllTimers();

    // Previously: stuck on `loading` forever (status selector saw the raw key
    // missing) while the fetch effect (trusting inferFields) never fetched.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: User 1
      "
    `);
    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(
      `[]`,
    );
  });

  // Mirror of the same disagreement: a raw key being present must not show
  // unvouched placeholder data as `success` when `inferFields` says the field
  // was never actually loaded — the fetch effect refetches it, so the status
  // must be `loading` (data hidden) until the fetch resolves.
  test('a present-but-unvouched field shows loading and fetches instead of exposing placeholder data', async () => {
    // Only id/name are trustworthy on locally created rows; other keys may
    // hold placeholder values that were never loaded from the server.
    const placeholderAwareConfig: PartialResourcesConfig<Row> = {
      ...mergeAndSelect,
      inferFields: () => ['id', 'name'],
    };

    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: placeholderAwareConfig,
    });

    // Client-created row with a placeholder address key present.
    act(() => {
      env.apiStore.addItemToState('users||1', {
        id: 1,
        name: 'User 1',
        address: 'Draft address',
      });
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { status, data } = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['address'],
      });

      renders.add({ status, address: data?.address ?? null });
    });

    await flushAllTimers();

    // Previously the placeholder was exposed as `success` (raw key present)
    // before the refetch resolved. Now the unvouched field is treated as
    // missing: loading (data hidden) until the real value arrives.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ address: null
      -> status: success ⋅ address: Address 1
      "
    `);
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['address']
            itemId: 'users||1'
      `);
  });
});

describe('partial resources: unresolved invalidations only affect their own fields', () => {
  // Finding 10 (P3): while ANY per-field invalidation was unresolved, the
  // fetch effect stopped trusting `inferFields` for ALL fields of the item —
  // hooks for unaffected, vouched fields spuriously refetched them.
  test('a hook for an unaffected vouched field does not refetch while another field is pending invalidation', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: starInferFieldsConfig,
    });

    // Client-created complete item — no loaded-fields metadata, vouched by
    // `inferFields`.
    act(() => {
      env.apiStore.addItemToState('users||1', {
        id: 1,
        name: 'User 1',
        address: 'Address 1',
        age: 10,
        country: 'Country 1',
      });
    });

    // Only 'age' becomes stale (no hooks mounted yet).
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        itemPayload: 'users||1',
        queryPayload: false,
        fields: ['age'],
      });
    });

    // Hooks for unaffected fields mount. 'name' and 'address' are vouched by
    // `inferFields` and NOT affected by the pending 'age' invalidation — they
    // must resolve from state without any fetch. Previously the unresolved
    // 'age' invalidation disabled `inferFields` for every field, causing
    // spurious refetches of both.
    const nameHook = renderHook(() =>
      env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['name'],
      }),
    );
    await flushAllTimers();
    expect(nameHook.result.current.status).toBe('success');
    nameHook.unmount();

    const addressHook = renderHook(() =>
      env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['address'],
      }),
    );
    await flushAllTimers();
    expect(addressHook.result.current.status).toBe('success');
    addressHook.unmount();

    // The pending 'age' invalidation is still owed: an age hook must refetch.
    const ageHook = renderHook(() =>
      env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['age'],
      }),
    );
    await flushAllTimers();
    expect(ageHook.result.current.status).toBe('success');
    ageHook.unmount();

    // Only the invalidated 'age' field was ever fetched.
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['age']
            itemId: 'users||1'
      `);
  });
});

describe('partial resources: invalidating an item of a mounted fields:"*" list query', () => {
  // Finding 4 (P2): `invalidateItem` on any item of a mounted `fields: '*'`
  // list query blanked the whole list to `loading` with `items: []`, because
  // the status selector treated "complete but stale" the same as "data
  // absent". Stale-but-complete items must stay visible as `refetching`.
  test('the list keeps its items visible as refetching instead of blanking to loading', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { status, items } = env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: '*', returnRefetchingStatus: true },
      );

      renders.add({
        status,
        itemsCount: items.length,
        firstName: items[0]?.name ?? null,
      });
    });

    await flushAllTimers();
    renders.addMark('invalidate item 1');

    // Server data changes, then one item of the list is fully invalidated.
    env.serverTable.updateItem('users||1', { name: 'Renamed User 1' });

    act(() => {
      env.apiStore.invalidateItem('users||1');
    });

    await flushAllTimers();

    // The loaded list must never blank out: it stays visible with a
    // `refetching` status while the stale item refetches, then settles with
    // the fresh value. Previously the list flipped to `loading` with 0 items.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ itemsCount: 0 ⋅ firstName: null
      -> status: success ⋅ itemsCount: 5 ⋅ firstName: User 1

      >>> invalidate item 1

      -> status: refetching ⋅ itemsCount: 5 ⋅ firstName: User 1
      -> status: success ⋅ itemsCount: 5 ⋅ firstName: Renamed User 1
      "
    `);
  });
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
});
