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
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import {
  createListQueryStoreTestEnv,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  mergeAndSelect,
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

describe('partial resources: full invalidation of a fully-loaded item', () => {
  test("multiple fields:'*' subscribers refetch successfully when a field invalidation follows a full invalidation", async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
    });

    // Two independent full-item consumers are mounted, matching multiple
    // components that subscribe to the same record in a real application.
    renderHook(() =>
      env.apiStore.useItem('users||1', {
        fields: '*',
        returnRefetchingStatus: true,
      }),
    );
    renderHook(() =>
      env.apiStore.useItem('users||1', {
        fields: '*',
        returnRefetchingStatus: true,
      }),
    );
    await flushAllTimers();
    env.serverTable.clearFetchHistory();

    // The field invalidation arrives before the full invalidation's refetch
    // runs. Both hooks must contribute a full fetch without converting the
    // public '*' sentinel into a missing fields option.
    expect(() => {
      act(() => {
        env.apiStore.invalidateItem('users||1');
        env.apiStore.invalidateQueryAndItems({
          queryPayload: false,
          itemPayload: 'users||1',
          fields: ['name'],
          type: 'highPriority',
        });
      });
    }).not.toThrow();

    await flushAllTimers();

    // The coalesced request remains a deliberate full fetch. The test env
    // omits `fields` from its request history when TSDF normalizes '*'.
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload: { itemId: 'users||1' }
      `);
  });

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
