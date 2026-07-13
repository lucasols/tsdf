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

    // A single refetch coalesced both mounted hooks' fields (same as the
    // metadata-tracked case above) — no serialized per-hook refetches and no
    // over-broad ('*') fetch.
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['address', 'name']
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

  // Finding: a full invalidation of a fully-loaded ('*') item resets
  // `itemLoadedFields` to `[]` while the (still complete, now stale) item data
  // stays in state. The '*' hook status selector only checked
  // `snapshotIsFullyLoaded`, so for apps whose `inferFields` reports a key
  // list (never '*') the stale-but-complete snapshot was treated as a NEW
  // load: data hidden (`data: null`, status `loading`) until the refetch
  // resolved. Array-field hooks already kept stale data visible through the
  // same invalidation — a full invalidation of complete data is a refetch,
  // not a load.
  test("a '*' hook keeps stale data visible while a full invalidation refetch is in flight", async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
    });

    const refetchingRenders = createLoggerStore();
    const defaultRenders = createLoggerStore();

    // Two '*' hooks: one exposing refetches, one with the default status
    // mapping (refetching -> success) — the common app usage where a `null`
    // data blip is user-visible (e.g. a form resetting its fields).
    renderHook(() => {
      const refetchingHook = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: '*',
      });
      const defaultHook = env.apiStore.useItem('users||1', { fields: '*' });

      refetchingRenders.add({
        status: refetchingHook.status,
        name: refetchingHook.data?.name ?? null,
      });
      defaultRenders.add({
        status: defaultHook.status,
        name: defaultHook.data?.name ?? null,
      });
    });

    await flushAllTimers();

    refetchingRenders.addMark('full invalidation');
    defaultRenders.addMark('full invalidation');

    // Server data changes, then the whole item is invalidated.
    env.serverTable.updateItem('users||1', { name: 'Renamed User 1' });

    act(() => {
      env.apiStore.invalidateItem('users||1');
    });

    await flushAllTimers();

    // The stale (still complete) data stays visible with a `refetching`
    // status until the fresh value arrives. Previously the data blipped to
    // `null` with a `loading` status for the whole refetch.
    expect(refetchingRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ name: null
      -> status: success ⋅ name: User 1

      >>> full invalidation

      -> status: refetching ⋅ name: User 1
      -> status: success ⋅ name: Renamed User 1
      "
    `);

    // With the default status mapping the refetch is completely invisible:
    // no loading state and no data blip — matching how invalidation behaves
    // in non-partial-resources stores.
    expect(defaultRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ name: null
      -> status: success ⋅ name: User 1

      >>> full invalidation

      -> status: success ⋅ name: User 1
      -> status: success ⋅ name: Renamed User 1
      "
    `);

    // Initial full load plus a single full refetch for the invalidation.
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload: { itemId: 'users||1' }
        - _type: 'item'
          payload: { itemId: 'users||1' }
      `);
  });

  // Same stale-vs-missing conflation through the late-mount flow: the item is
  // fully invalidated while no hook is mounted (e.g. the user navigates away
  // and an external update invalidates the record), then a '*' hook mounts.
  // The cached complete snapshot must be shown as a refetch, not hidden as a
  // new load.
  test("a '*' hook mounting after a full invalidation shows the cached data as refetching", async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
    });

    // Fully load the item ('*') without any hook mounted.
    const preload = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: '*',
    });
    await flushAllTimers();
    await preload;

    // Server data changes, then the whole item is invalidated while unmounted.
    env.serverTable.updateItem('users||1', { name: 'Renamed User 1' });

    act(() => {
      env.apiStore.invalidateItem('users||1');
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { status, data } = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: '*',
      });

      renders.add({ status, name: data?.name ?? null });
    });

    await flushAllTimers();

    // The hook mounts straight into a refetch over the visible cached data.
    // Previously it mounted as `loading` with `data: null` even though the
    // complete (stale) snapshot was cached.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: refetching ⋅ name: User 1
      -> status: success ⋅ name: Renamed User 1
      "
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

describe('partial resources: invalidating previously loaded absent fields', () => {
  const dataWithAbsentAddress: Tables = {
    users: initialServerData.users!.map((item) =>
      item.id === 1 ? { ...item, address: undefined } : item,
    ),
  };

  test('a list keeps cached items visible while an absent requested field refetches', async () => {
    const env = createListQueryStoreTestEnv(dataWithAbsentAddress, {
      partialResources: listInferFieldsConfig,
    });

    const defaultRenders = createLoggerStore();
    const refetchingRenders = createLoggerStore();

    // Both hooks request an absent-but-valid field. The completed request's
    // loaded-field metadata is the only proof that `address` was loaded.
    const { result } = renderHook(() => {
      const defaultResult = env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name', 'address'] },
      );
      const refetchingResult = env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name', 'address'], returnRefetchingStatus: true },
      );

      defaultRenders.add({
        status: defaultResult.status,
        itemsCount: defaultResult.items.length,
        address: defaultResult.items[0]?.address ?? null,
      });
      refetchingRenders.add({
        status: refetchingResult.status,
        itemsCount: refetchingResult.items.length,
        address: refetchingResult.items[0]?.address ?? null,
      });

      return { defaultResult, refetchingResult };
    });

    await flushAllTimers();
    defaultRenders.addMark('full item invalidation');
    refetchingRenders.addMark('full item invalidation');

    // Keep the refetch pending after invalidation so the stale UI state is
    // observable before the server supplies the formerly absent field.
    env.serverTable.updateItem('users||1', { address: 'New Address 1' });
    act(() => env.apiStore.invalidateItem('users||1'));
    await advanceTime(100);

    // An ordinary invalidation maps refetching to success and never blanks the
    // list merely because `inferFields` cannot infer an undefined value.
    expect({
      defaultStatus: result.current.defaultResult.status,
      defaultIsLoading: result.current.defaultResult.isLoading,
      defaultItemsCount: result.current.defaultResult.items.length,
      refetchingStatus: result.current.refetchingResult.status,
      refetchingIsLoading: result.current.refetchingResult.isLoading,
      refetchingItemsCount: result.current.refetchingResult.items.length,
    }).toMatchInlineSnapshot(`
      defaultIsLoading: '❌'
      defaultItemsCount: 5
      defaultStatus: 'success'
      refetchingIsLoading: '❌'
      refetchingItemsCount: 5
      refetchingStatus: 'refetching'
    `);
    expect(defaultRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ itemsCount: 0 ⋅ address: null
      -> status: success ⋅ itemsCount: 5 ⋅ address: null

      >>> full item invalidation

      -> status: success ⋅ itemsCount: 5 ⋅ address: null
      "
    `);
    expect(refetchingRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ itemsCount: 0 ⋅ address: null
      -> status: success ⋅ itemsCount: 5 ⋅ address: null

      >>> full item invalidation

      -> status: refetching ⋅ itemsCount: 5 ⋅ address: null
      "
    `);

    // Finish the pending request and verify the fresh value replaces the
    // visible stale snapshot.
    await flushAllTimers();
    expect(defaultRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ itemsCount: 0 ⋅ address: null
      -> status: success ⋅ itemsCount: 5 ⋅ address: null

      >>> full item invalidation

      -> status: success ⋅ itemsCount: 5 ⋅ address: null
      ⋅⋅⋅
      -> status: success ⋅ itemsCount: 5 ⋅ address: New Address 1
      "
    `);
    expect(refetchingRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ itemsCount: 0 ⋅ address: null
      -> status: success ⋅ itemsCount: 5 ⋅ address: null

      >>> full item invalidation

      -> status: refetching ⋅ itemsCount: 5 ⋅ address: null
      ⋅⋅⋅
      -> status: success ⋅ itemsCount: 5 ⋅ address: New Address 1
      "
    `);
  });

  test('an item keeps cached data visible while an absent requested field refetches', async () => {
    const env = createListQueryStoreTestEnv(dataWithAbsentAddress, {
      partialResources: listInferFieldsConfig,
    });

    // Load the complete resource first so this path also proves that an array
    // hook understands pending invalidation metadata derived from `'*'`.
    const preload = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: '*',
    });
    await flushAllTimers();
    await preload;

    const defaultRenders = createLoggerStore();
    const refetchingRenders = createLoggerStore();

    // Array-field consumers mount over the fully loaded snapshot. Once it is
    // invalidated, only pending metadata proves the undefined address is stale.
    const { result } = renderHook(() => {
      const defaultResult = env.apiStore.useItem('users||1', {
        fields: ['id', 'name', 'address'],
      });
      const refetchingResult = env.apiStore.useItem('users||1', {
        fields: ['id', 'name', 'address'],
        returnRefetchingStatus: true,
      });

      defaultRenders.add({
        status: defaultResult.status,
        name: defaultResult.data?.name ?? null,
        address: defaultResult.data?.address ?? null,
      });
      refetchingRenders.add({
        status: refetchingResult.status,
        name: refetchingResult.data?.name ?? null,
        address: refetchingResult.data?.address ?? null,
      });

      return { defaultResult, refetchingResult };
    });

    await flushAllTimers();
    defaultRenders.addMark('full item invalidation');
    refetchingRenders.addMark('full item invalidation');

    // Invalidate the fully requested item and leave its refetch unresolved.
    env.serverTable.updateItem('users||1', { address: 'New Address 1' });
    act(() => env.apiStore.invalidateItem('users||1'));
    await advanceTime(100);

    // Cached item data remains usable during an ordinary invalidation; callers
    // opting into refetching status see that distinction without `isLoading`.
    expect({
      defaultStatus: result.current.defaultResult.status,
      defaultIsLoading: result.current.defaultResult.isLoading,
      defaultName: result.current.defaultResult.data?.name ?? null,
      refetchingStatus: result.current.refetchingResult.status,
      refetchingIsLoading: result.current.refetchingResult.isLoading,
      refetchingName: result.current.refetchingResult.data?.name ?? null,
    }).toMatchInlineSnapshot(`
      defaultIsLoading: '❌'
      defaultName: 'User 1'
      defaultStatus: 'success'
      refetchingIsLoading: '❌'
      refetchingName: 'User 1'
      refetchingStatus: 'refetching'
    `);
    expect(defaultRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: User 1 ⋅ address: null

      >>> full item invalidation

      -> status: success ⋅ name: User 1 ⋅ address: null
      "
    `);
    expect(refetchingRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: User 1 ⋅ address: null

      >>> full item invalidation

      -> status: success ⋅ name: User 1 ⋅ address: null
      -> status: refetching ⋅ name: User 1 ⋅ address: null
      "
    `);

    // Resolve the request and confirm the newly defined field is exposed.
    await flushAllTimers();
    expect(defaultRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: User 1 ⋅ address: null

      >>> full item invalidation

      -> status: success ⋅ name: User 1 ⋅ address: null
      ⋅⋅⋅
      -> status: success ⋅ name: User 1 ⋅ address: New Address 1
      "
    `);
    expect(refetchingRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: User 1 ⋅ address: null

      >>> full item invalidation

      -> status: success ⋅ name: User 1 ⋅ address: null
      -> status: refetching ⋅ name: User 1 ⋅ address: null
      ⋅⋅⋅
      -> status: success ⋅ name: User 1 ⋅ address: New Address 1
      "
    `);
  });

  test('a list keeps cached items visible when a fully loaded item with an absent field refetches', async () => {
    const env = createListQueryStoreTestEnv(dataWithAbsentAddress, {
      partialResources: listInferFieldsConfig,
    });

    // Load item 1 as a complete ('*') resource first. Its full invalidation
    // below then leaves only the durable full-invalidation marker (there is no
    // enumerable pending field list for a '*' snapshot) as the proof that the
    // undefined `address` is stale rather than absent.
    const preload = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: '*',
    });
    await flushAllTimers();
    await preload;

    const renders = createLoggerStore();

    const { result } = renderHook(() => {
      const listResult = env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name', 'address'], returnRefetchingStatus: true },
      );

      renders.add({
        status: listResult.status,
        itemsCount: listResult.items.length,
        address: listResult.items[0]?.address ?? null,
      });

      return listResult;
    });

    await flushAllTimers();
    renders.addMark('full item invalidation');

    // Invalidate the fully ('*') loaded item and leave its refetch unresolved.
    env.serverTable.updateItem('users||1', { address: 'New Address 1' });
    act(() => env.apiStore.invalidateItem('users||1'));
    await advanceTime(100);

    // The list must not blank while the marker-only invalidation refetches:
    // the marker proves item 1 was complete when invalidated, so its undefined
    // `address` is stale, not absent.
    expect({
      status: result.current.status,
      isLoading: result.current.isLoading,
      itemsCount: result.current.items.length,
    }).toMatchInlineSnapshot(`
      isLoading: '❌'
      itemsCount: 5
      status: 'refetching'
    `);

    // Finish the pending request and verify the fresh value replaces the
    // visible stale snapshot.
    await flushAllTimers();
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ itemsCount: 0 ⋅ address: null
      -> status: success ⋅ itemsCount: 5 ⋅ address: null

      >>> full item invalidation

      -> status: refetching ⋅ itemsCount: 5 ⋅ address: null
      -> status: success ⋅ itemsCount: 5 ⋅ address: New Address 1
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

describe('partial resources: realtime invalidations keep the scheduler throttle', () => {
  // Finding: a full realtime invalidation resets `itemLoadedFields` to `[]`
  // while the (stale) item data stays in state. The auto-fetch effect then
  // classified every previously loaded field as "missing requested data" and
  // promoted the refetch from `realtimeUpdate` to `highPriority` — cancelling
  // the scheduler's delayed realtime fetch and firing an immediate duplicate
  // request. Previously loaded fields owed after an invalidation are STALE,
  // not missing: they must refetch at the tracked invalidation priority so
  // the realtime throttle stays effective.

  function createRealtimeEnv() {
    return createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 1000,
    });
  }

  /** Mounts a list query hook and resolves the initial load so the realtime
   * throttle has a baseline fetch. */
  async function primeMountedListQuery(
    env: ReturnType<typeof createRealtimeEnv>,
  ) {
    renderHook(() => {
      env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name', 'address'] },
      );
    });
    await flushAllTimers();
    env.clearTimeline();
  }

  /** The shape a realtime record-change event produces: a full invalidation
   * of the query and its items at `realtimeUpdate` priority. */
  function invalidateAllAsRealtimeUpdate(
    env: ReturnType<typeof createRealtimeEnv>,
  ) {
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: { tableId: 'users' },
        itemPayload: (item) => item.startsWith('users||'),
        type: 'realtimeUpdate',
      });
    });
  }

  test('a realtime full invalidation refetches once, delayed by the throttle, without an immediate duplicate fetch', async () => {
    const env = createRealtimeEnv();
    await primeMountedListQuery(env);

    // A realtime record-change event fully invalidates the query and its
    // items inside the throttle window.
    await advanceTime(100);
    invalidateAllAsRealtimeUpdate(env);

    await flushAllTimers();

    // The refetch must stay delayed by the throttle: one rt-fetch-scheduled,
    // no rt-fetch-cancelled, and a single list fetch at the throttle
    // boundary. Previously the auto-fetch effect promoted the stale fields to
    // `highPriority`, cancelling the delayed fetch and firing immediately.
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | -- timeline-cleared
      910ms | rt-fetch-scheduled (delay: 900ms)
      1.81s | scheduled-rt-fetch-started
      1.82s | 🟠 >list-fetch-started
      2.62s | 🟠 <list-fetch-finished (value: {"count":5})
      "
    `);

    // Exactly one refetch after the initial load — fired at the throttle
    // boundary, not at invalidation time.
    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name', 'address']
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'list'
        payload:
          fields: ['id', 'name', 'address']
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '1.82s -> 2.62s | duration: 800ms'
    `);
  });

  test('repeated realtime invalidations inside the throttle window coalesce into one delayed refetch', async () => {
    const env = createRealtimeEnv();
    await primeMountedListQuery(env);

    // Two realtime record-change events arrive inside the same throttle
    // window.
    await advanceTime(100);
    invalidateAllAsRealtimeUpdate(env);

    await advanceTime(200);
    invalidateAllAsRealtimeUpdate(env);

    await flushAllTimers();

    // Both invalidations coalesce into a single delayed realtime refetch —
    // no cancellation, no immediate fetches, one refetch request total.
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | -- timeline-cleared
      910ms | rt-fetch-scheduled (delay: 900ms)
      1.81s | scheduled-rt-fetch-started
      1.82s | 🟠 >list-fetch-started
      2.62s | 🟠 <list-fetch-finished (value: {"count":5})
      "
    `);

    expect(env.serverTable.getRequestHistory('list').length).toBe(2);
  });

  test('a genuinely missing requested field still fetches immediately instead of waiting for a throttle', async () => {
    const env = createRealtimeEnv();
    await primeMountedListQuery(env);

    // A second hook on the same query requests a field that was never loaded
    // ('age'). This is genuinely missing data — the fetch must run
    // immediately (promoted past the lowPriority mount default), not wait for
    // any throttle.
    await advanceTime(100);
    const { result } = renderHook(() =>
      env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name', 'age'] },
      ),
    );

    await flushAllTimers();

    // The missing field is fetched immediately and resolves with data.
    expect(result.current.status).toBe('success');
    expect(result.current.items[0]?.age).toBe(10);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | -- timeline-cleared
      920ms | 🟠 >list-fetch-started
      1.72s | 🟠 <list-fetch-finished (value: {"count":5})
      "
    `);
  });

  test('mixed stale + genuinely missing fields fetch immediately, covering both', async () => {
    const env = createRealtimeEnv();
    await primeMountedListQuery(env);

    // A realtime invalidation marks the loaded fields stale (delayed refetch
    // scheduled)...
    await advanceTime(100);
    invalidateAllAsRealtimeUpdate(env);

    // ...then a hook mounts requesting a genuinely never-loaded field ('age')
    // alongside the now-stale ones.
    await advanceTime(50);
    const { result } = renderHook(() =>
      env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name', 'address', 'age'] },
      ),
    );

    await flushAllTimers();

    // Genuinely missing data justifies an immediate required fetch. It covers
    // the stale fields too, superseding the delayed realtime refetch — so
    // only one refetch happens in total.
    expect(result.current.status).toBe('success');
    expect(result.current.items[0]?.age).toBe(10);
    expect(env.serverTable.getRequestHistory('list').length).toBe(2);
  });

  test('invalidating a never-loaded field does not delay its first load behind the throttle', async () => {
    const env = createRealtimeEnv();

    // Load some of the item's fields so the item scheduler has a baseline
    // fetch for the throttle — but never load 'age'.
    renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['name', 'address'] }),
    );
    await flushAllTimers();
    env.clearTimeline();

    // A realtime event invalidates a field that was never loaded, inside the
    // throttle window. There is no cached 'age' value that could go stale.
    await advanceTime(100);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'realtimeUpdate',
        fields: ['age'],
      });
    });

    // A hook mounts requesting the never-loaded field: this is genuinely
    // missing data with nothing to display — it must fetch immediately
    // instead of waiting out the realtime throttle as if it were stale.
    await advanceTime(50);
    const { result } = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['age'] }),
    );

    await flushAllTimers();

    expect(result.current.data?.age).toBe(10);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | -- timeline-cleared
      970ms | 🟠 >fetch-started
      1.77s | 🟠 <fetch-finished (value: {"age":10})
      "
    `);
  });

  test('a realtime full item invalidation on a mounted item hook stays throttled', async () => {
    const env = createRealtimeEnv();

    // Load an item through a mounted field hook so the item scheduler has a
    // baseline fetch for the throttle.
    renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['name', 'address'] }),
    );
    await flushAllTimers();
    env.clearTimeline();

    // A realtime record-change event fully invalidates the item inside the
    // throttle window.
    await advanceTime(100);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'realtimeUpdate',
      });
    });

    await flushAllTimers();

    // Same contract as the list query: the item refetch stays delayed by the
    // throttle instead of being promoted to an immediate highPriority fetch.
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | -- timeline-cleared
      910ms | rt-fetch-scheduled (delay: 900ms)
      1.81s | scheduled-rt-fetch-started
      1.82s | 🟠 >fetch-started
      2.62s | 🟠 <fetch-finished (value: {"name":"User 1","address":"Address 1"})
      "
    `);

    expect(env.serverTable.getRequestHistory('item').length).toBe(2);
  });

  test('an explicit high-priority field invalidation escalates past a pending throttled full invalidation', async () => {
    const env = createRealtimeEnv();

    // Load an item through a mounted field hook so the item scheduler has a
    // baseline fetch for the throttle.
    const { result } = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['name', 'address'] }),
    );
    await flushAllTimers();
    env.clearTimeline();

    // A realtime record-change event fully invalidates the item inside the
    // throttle window — its refetch is scheduled at the throttle boundary.
    await advanceTime(100);
    env.serverTable.updateItem('users||1', {
      name: 'New User 1',
      address: 'New Address 1',
    });
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'realtimeUpdate',
      });
    });

    // While that refetch is still waiting, the app explicitly invalidates one
    // field at highPriority (e.g. a mutation response says 'name' changed).
    await advanceTime(50);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'highPriority',
        fields: ['name'],
      });
    });

    // The high-priority field must refetch immediately instead of being
    // dropped and left to wait out the realtime throttle with the rest. The
    // immediate fetch replaces (cancels) the pending throttled refetch that
    // was carrying the other stale field ('address'), so it must carry that
    // owed field along — a single fetch covering both.
    await advanceTime(100);

    await flushAllTimers();
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | -- timeline-cleared
      910ms | server-data-changed (value: {"name":"New User 1","address":"New Address 1"})
      .     | rt-fetch-scheduled (delay: 900ms)
      970ms | rt-fetch-cancelled
      .     | 🟠 >fetch-started
      1.77s | 🟠 <fetch-finished (value: {"address":"New Address 1","name":"New User 1"})
      "
    `);
    expect(env.serverTable.getRequestHistory('item').length).toBe(2);

    // Both the escalated field and the field owed to the cancelled throttled
    // refetch end up fresh.
    expect(result.current.data).toMatchInlineSnapshot(`
      address: 'New Address 1'
      name: 'New User 1'
    `);
  });
});

describe('partial resources: invalidations arriving while a hook is off-screen', () => {
  // Finding: the `invalidateItem` event handler returned early when all of a
  // hook's instances were off-screen — before re-opening the mount-once
  // refetch gate. Per-field invalidations never set `refetchOnMount`, so
  // nothing else could rescue the instance: back on-screen it kept showing
  // the stale field with `status: 'success'` and never refetched.

  function createOffScreenRealtimeEnv() {
    return createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 1000,
    });
  }

  test('a field invalidated while its hook is off-screen refetches when the hook returns on-screen', async () => {
    const env = createOffScreenRealtimeEnv();

    // Load the item's fields through a mounted hook...
    const { result, rerender } = renderHook(
      ({ isOffScreen }: { isOffScreen: boolean }) =>
        env.apiStore.useItem('users||1', {
          fields: ['name', 'address'],
          isOffScreen,
        }),
      { initialProps: { isOffScreen: false } },
    );
    await flushAllTimers();
    env.clearTimeline();

    // ...then move it off-screen (e.g. the row scrolled out of a virtualized
    // list).
    rerender({ isOffScreen: true });

    // The address changes on the server, and a realtime event invalidates
    // only that field while the hook is off-screen.
    await advanceTime(100);
    env.serverTable.updateItem('users||1', { address: 'New Address 1' });
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'realtimeUpdate',
        fields: ['address'],
      });
    });

    // The whole realtime throttle window passes while still off-screen —
    // off-screen hooks must not fetch.
    await flushAllTimers();
    expect(env.serverTable.getRequestHistory('item').length).toBe(1);
    expect(result.current.data?.address).toBe('Address 1');

    // Back on-screen: the stale field must refetch and show the fresh value.
    rerender({ isOffScreen: false });
    await flushAllTimers();

    expect(result.current.status).toBe('success');
    expect(result.current.data?.address).toBe('New Address 1');
    // One initial load plus one refetch of only the stale field.
    expect(env.serverTable.getRequestHistory('item').length).toBe(2);
  });

  test('an off-screen hook still refetches after an on-screen hook consumed the same full invalidation', async () => {
    const env = createOffScreenRealtimeEnv();

    // Two hooks on the same item: one stays on-screen with its own field,
    // the other loads a different field and then goes off-screen.
    renderHook(() => env.apiStore.useItem('users||1', { fields: ['name'] }));
    const offScreenHook = renderHook(
      ({ isOffScreen }: { isOffScreen: boolean }) =>
        env.apiStore.useItem('users||1', { fields: ['address'], isOffScreen }),
      { initialProps: { isOffScreen: false } },
    );
    await flushAllTimers();
    env.clearTimeline();

    offScreenHook.rerender({ isOffScreen: true });

    // A realtime record-change event fully invalidates the item. The
    // on-screen hook consumes the event (it schedules its own refetch and
    // clears `refetchOnMount`), the off-screen hook cannot react yet.
    await advanceTime(100);
    act(() => {
      env.serverTable.setItem(
        'users||1',
        {
          id: 1,
          name: 'New User 1',
          address: 'New Address 1',
          age: 10,
          country: 'Country 1',
        },
        { triggerRTUEvent: true },
      );
    });

    // The on-screen hook's throttled refetch of its own field resolves while
    // the other hook is still off-screen.
    await flushAllTimers();
    expect(offScreenHook.result.current.data?.address).toBe('Address 1');

    // Back on-screen: the hook's own stale field must refetch too — the
    // other hook's consumption of the invalidation event must not have
    // discarded this hook's refetch obligation.
    offScreenHook.rerender({ isOffScreen: false });
    await flushAllTimers();

    expect(offScreenHook.result.current.status).toBe('success');
    expect(offScreenHook.result.current.data?.address).toBe('New Address 1');
  });
});
