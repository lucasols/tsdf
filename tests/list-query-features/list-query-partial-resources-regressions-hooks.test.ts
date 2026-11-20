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

describe('partial resources: query invalidations with multiple same-payload hooks', () => {
  // Finding: the `invalidateQuery` event handler dedups per query key, so
  // with two hook instances watching the same query with different field
  // subsets only the first instance's fields were scheduled on invalidation —
  // the other instance's fields were never refetched and kept showing stale
  // data forever.
  test('a query invalidation refetches the fields of every mounted hook watching the query', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
    });

    // Two components watch the same list with different field subsets.
    const nameHook = renderHook(() =>
      env.apiStore.useListQuery({ tableId: 'users' }, { fields: ['name'] }),
    );
    const addressHook = renderHook(() =>
      env.apiStore.useListQuery({ tableId: 'users' }, { fields: ['address'] }),
    );
    await flushAllTimers();
    env.clearTimeline();
    env.serverTable.clearFetchHistory();

    // The server data changes and the app invalidates the query.
    env.serverTable.updateItem('users||1', {
      name: 'New User 1',
      address: 'New Address 1',
    });
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: { tableId: 'users' },
        itemPayload: false,
        type: 'highPriority',
      });
    });
    await flushAllTimers();

    // A single coalesced refetch must cover both hooks' field subsets — the
    // per-instance schedules merge in the scheduler's coalescing window.
    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: ['address', 'name']
            pos: { limit: 50, offset: 0 }
          returned_items: 5
      `);

    // Both hooks must show the fresh values — with the buggy per-key dedup
    // the second hook's fields were dropped and it kept the stale address
    // forever.
    expect(nameHook.result.current.items[0]?.name).toBe('New User 1');
    expect(addressHook.result.current.items[0]?.address).toBe('New Address 1');
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

  test('an off-screen query instance still refetches its fields after an on-screen instance consumed the query invalidation', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
    });

    // Two components watch the same list with different field subsets; the
    // address one later goes off-screen (e.g. a collapsed panel).
    const nameHook = renderHook(() =>
      env.apiStore.useListQuery({ tableId: 'users' }, { fields: ['name'] }),
    );
    const addressHook = renderHook(
      ({ isOffScreen }: { isOffScreen: boolean }) =>
        env.apiStore.useListQuery(
          { tableId: 'users' },
          { fields: ['address'], isOffScreen },
        ),
      { initialProps: { isOffScreen: false } },
    );
    await flushAllTimers();
    env.clearTimeline();
    env.serverTable.clearFetchHistory();

    addressHook.rerender({ isOffScreen: true });

    // The server data changes and the app invalidates the query while the
    // address instance is off-screen.
    env.serverTable.updateItem('users||1', {
      name: 'New User 1',
      address: 'New Address 1',
    });
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: { tableId: 'users' },
        itemPayload: false,
        type: 'highPriority',
      });
    });
    await flushAllTimers();

    // Only the on-screen instance refetches, with its own fields — off-screen
    // instances must not fetch.
    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: ['name']
            pos: { limit: 50, offset: 0 }
          returned_items: 5
      `);
    expect(addressHook.result.current.items[0]?.address).toBe('Address 1');

    // Back on-screen: the instance's fields are still owed a refetch — the
    // visible instance consuming the invalidation (clearing the query's
    // shared `refetchOnMount`) must not have discarded this instance's
    // obligation.
    addressHook.rerender({ isOffScreen: false });
    await flushAllTimers();

    expect(addressHook.result.current.items[0]?.address).toBe('New Address 1');
    // Exactly one extra fetch, scoped to the returning instance's fields.
    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: ['name']
            pos: { limit: 50, offset: 0 }
          returned_items: 5
        - _type: 'list'
          payload:
            fields: ['address']
            pos: { limit: 50, offset: 0 }
          returned_items: 5
      `);
    // The on-screen instance keeps its fresh value too.
    expect(nameHook.result.current.items[0]?.name).toBe('New User 1');
  });
});

describe("partial resources: invalidations arriving during a field's first fetch", () => {
  // Finding: a per-field invalidation of a never-loaded field is not recorded
  // as stale — correct on its own, since the field's first load must run
  // immediately instead of being throttled as a stale refetch (see the
  // throttle suite above). But when the field's FIRST fetch is already in
  // flight, the in-flight response predates the invalidation and commits
  // possibly-stale data as fresh. With the invalidation discarded, no
  // follow-up refetch is owed and the stale value sticks forever.

  function createRealtimeEnv() {
    return createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 1000,
    });
  }

  test("an invalidation arriving during a field's first item fetch still produces a follow-up refetch", async () => {
    const env = createRealtimeEnv();

    // The first-ever fetch of the item starts (no field was loaded before).
    const { result } = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['age'] }),
    );

    // While that fetch is in flight, the value changes on the server and the
    // realtime invalidation for the field arrives. The in-flight response was
    // produced before the change, so it will still carry the old value.
    await advanceTime(100);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'realtimeUpdate',
        fields: ['age'],
      });
    });

    // The in-flight fetch settles with the pre-invalidation value...
    await advanceTime(800);
    expect(result.current.data?.age).toBe(10);

    // ...and only fetches from here on can observe the changed value.
    act(() => {
      env.serverTable.updateItem('users||1', { age: 99 });
    });

    await flushAllTimers();

    // The invalidation must survive the in-flight first fetch: a follow-up
    // refetch (still throttled — it is a realtime refetch of now-stale data)
    // picks up the changed value.
    expect(result.current.data?.age).toBe(99);
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['age']
            itemId: 'users||1'
        - _type: 'item'
          payload:
            fields: ['age']
            itemId: 'users||1'
      `);
  });

  test("an invalidation arriving during a field's first list fetch still produces a follow-up refetch", async () => {
    const env = createRealtimeEnv();

    // The first-ever list fetch starts, loading 'name' for all items.
    const { result } = renderHook(() =>
      env.apiStore.useListQuery({ tableId: 'users' }, { fields: ['name'] }),
    );

    // While the list fetch is in flight, item 1's name changes on the server
    // and its realtime invalidation arrives — 'name' was never loaded, so the
    // invalidation has no displayable value to mark stale yet.
    await advanceTime(100);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'realtimeUpdate',
        fields: ['name'],
      });
    });

    // The in-flight list fetch settles with the pre-invalidation value...
    await advanceTime(800);
    expect(result.current.items[0]?.name).toBe('User 1');

    // ...and only fetches from here on can observe the changed value.
    act(() => {
      env.serverTable.updateItem('users||1', { name: 'Renamed User 1' });
    });

    await flushAllTimers();

    // The list fetch committing 'name' must not swallow the invalidation that
    // arrived while it was in flight — a follow-up refetch picks up the
    // changed value.
    expect(result.current.items[0]?.name).toBe('Renamed User 1');
  });

  test('a failed optimistic delete during the first list fetch keeps an invalidation that arrived before it', async () => {
    const env = createRealtimeEnv();

    // The first-ever list fetch starts, loading 'name' for all items.
    const { result } = renderHook(() =>
      env.apiStore.useListQuery({ tableId: 'users' }, { fields: ['name'] }),
    );

    // While the list fetch is in flight, item 1's name changes on the server
    // and its realtime invalidation arrives, so a follow-up refetch is owed.
    await advanceTime(100);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'realtimeUpdate',
        fields: ['name'],
      });
    });

    // Item 1 is then optimistically deleted, but the delete fails while the
    // list fetch is still in flight
    let rejectMutation: (error: Error) => void = () => {};
    let mutationResult: Promise<unknown> = Promise.resolve();
    act(() => {
      mutationResult = env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.deleteItemState('users||1');
        },
        mutation: () =>
          new Promise((_resolve, reject) => {
            rejectMutation = reject;
          }),
      });
    });
    await advanceTime(100);
    await act(async () => {
      rejectMutation(new Error('delete failed'));
      await mutationResult;
    });

    // The in-flight list fetch settles with the pre-invalidation value...
    await advanceTime(800);
    expect(result.current.items[0]?.name).toBe('User 1');

    // ...and only fetches from here on can observe the changed value.
    act(() => {
      env.serverTable.updateItem('users||1', { name: 'Renamed User 1' });
    });

    await flushAllTimers();

    // Rolling back the failed delete must not drop the invalidation it had
    // cleared: a follow-up refetch still picks up the changed value
    expect(result.current.items[0]?.name).toBe('Renamed User 1');
  });
});

describe("partial resources: a fields:'*' query mounting over genuinely missing data", () => {
  // Finding: the `'*'` branch of the query auto-fetch effect adopted the
  // tracked invalidation priority whenever any pending invalidation existed —
  // even when the hook's items were genuinely missing data (fields never
  // loaded, not merely stale). A first load of missing data must run
  // immediately; only refetches of still-displayable stale data may wait out
  // the realtime throttle. The item-side `'*'` branch already distinguishes
  // these.

  test('a full-resource hook mounting with never-loaded fields fetches immediately despite a pending realtime invalidation', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 1000,
    });

    // Prime the query with a subset of fields — 'address', 'age' and
    // 'country' are never loaded.
    renderHook(() =>
      env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name'] },
      ),
    );
    await flushAllTimers();
    env.clearTimeline();

    // A realtime invalidation of the loaded field arrives: its refetch is
    // correctly throttled (stale data is still displayable).
    await advanceTime(100);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: (itemKey) => itemKey.startsWith('users||'),
        type: 'realtimeUpdate',
        fields: ['name'],
      });
    });

    // A full-resource hook mounts on the same query: most of its fields were
    // never loaded, so this is a first load of missing data — it must fetch
    // immediately instead of inheriting the pending realtime priority and
    // waiting out the throttle.
    await advanceTime(50);
    const { result } = renderHook(() =>
      env.apiStore.useListQuery({ tableId: 'users' }, { fields: '*' }),
    );

    // Enough time for an immediate fetch to finish, but before the throttled
    // alternative (throttle boundary ~1.81s) would even have started fetching.
    await advanceTime(850);
    expect(result.current.status).toBe('success');
    expect(result.current.items[0]?.age).toBe(10);

    await flushAllTimers();

    // A single full fetch serves both the missing data and the pending 'name'
    // invalidation — no separate throttled refetch remains.
    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: ['id', 'name']
            pos: { limit: 50, offset: 0 }
          returned_items: 5
        - _type: 'list'
          payload:
            fields: '*'
            pos: { limit: 50, offset: 0 }
          returned_items: 5
      `);
  });
});

describe('partial resources: a hook mounting after a realtime invalidation must not throttle missing data', () => {
  // Finding: a full invalidation arriving while no hook is mounted records
  // its priority in `refetchOnMount`. A hook mounting later consumed that
  // record as its fetch priority even when it requested fields that were
  // NEVER loaded — so a first load of missing data (nothing displayable)
  // waited out the realtime throttle as if it were a refetch of stale data.
  // Real-world shape: a kanban card loads a narrow field selection, a
  // websocket record-change event invalidates the item at `realtimeUpdate`
  // priority, then the user opens an edit form needing more fields — the
  // form hung on the throttle (potentially minutes) with no data to show.

  function createRealtimeEnv() {
    return createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 1000,
    });
  }

  test('never-loaded fields requested by a late-mounting hook fetch immediately', async () => {
    const env = createRealtimeEnv();

    // A narrow hook (e.g. a kanban card) loads a subset of the item's
    // fields, then unmounts.
    const narrowHook = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['id', 'name'] }),
    );
    await flushAllTimers();
    narrowHook.unmount();
    env.clearTimeline();

    // A realtime record-change event fully invalidates the item while no
    // hook is mounted — the obligation is recorded in `refetchOnMount` at
    // `realtimeUpdate` priority.
    await advanceTime(100);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'realtimeUpdate',
      });
    });

    // A wider hook mounts (e.g. an edit form): 'address' was never loaded —
    // genuinely missing data with nothing to display.
    await advanceTime(50);
    const { result } = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['id', 'name', 'address'] }),
    );

    // Enough time for an immediate fetch to finish (~816ms), but before the
    // throttled alternative (throttle boundary ~1.81s) would even have
    // started fetching.
    await advanceTime(850);
    expect(result.current.data?.address).toBe('Address 1');

    await flushAllTimers();

    // One immediate fetch covers the missing field and the stale invalidated
    // fields together — no separate throttled refetch remains.
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['id', 'name']
            itemId: 'users||1'
        - _type: 'item'
          payload:
            fields: ['id', 'name', 'address']
            itemId: 'users||1'
      `);
  });

  test("a '*' hook mounting over a partially loaded invalidated item fetches immediately", async () => {
    const env = createRealtimeEnv();

    // Only a subset of the item's fields was ever loaded.
    const narrowHook = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['id', 'name'] }),
    );
    await flushAllTimers();
    narrowHook.unmount();
    env.clearTimeline();

    // A realtime full invalidation arrives while no hook is mounted.
    await advanceTime(100);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'realtimeUpdate',
      });
    });

    // A full-resource hook mounts: most fields were never loaded, so this is
    // a first load of missing data — it must not wait out the throttle.
    await advanceTime(50);
    const { result } = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: '*' }),
    );

    // Same timing contract as the array-fields case: an immediate fetch has
    // finished by now, the throttled alternative would not even have started.
    await advanceTime(850);
    expect(result.current.data?.country).toBe('Country 1');

    await flushAllTimers();
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['id', 'name']
            itemId: 'users||1'
        - _type: 'item'
          payload: { itemId: 'users||1' }
      `);
  });

  test('a hook remounting with only previously loaded fields stays throttled', async () => {
    const env = createRealtimeEnv();

    // Load the fields the hook will request again later, then unmount.
    const firstMount = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['name', 'address'] }),
    );
    await flushAllTimers();
    firstMount.unmount();
    env.clearTimeline();

    // The record changes on the server and a realtime full invalidation
    // arrives while no hook is mounted.
    await advanceTime(100);
    env.serverTable.updateItem('users||1', { name: 'New User 1' });
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'realtimeUpdate',
      });
    });

    // The hook remounts requesting only fields it already has stale data
    // for: this is a refetch of displayable stale data, so the realtime
    // throttle must stay effective (no immediate promotion to highPriority).
    await advanceTime(50);
    const { result } = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['name', 'address'] }),
    );

    // The stale value stays visible while the throttled refetch is pending.
    expect(result.current.data?.name).toBe('User 1');

    await flushAllTimers();

    // The refetch fired at the throttle boundary and picked up the change.
    expect(result.current.data?.name).toBe('New User 1');
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | -- timeline-cleared
      910ms | server-data-changed (value: {"name":"New User 1"})
      960ms | rt-fetch-scheduled (delay: 850ms)
      1.81s | scheduled-rt-fetch-started
      1.82s | 🟠 >fetch-started
      2.62s | 🟠 <fetch-finished (value: {"name":"New User 1","address":"Address 1"})
      "
    `);
  });

  test('a query hook mounting with never-loaded fields after a realtime invalidation fetches immediately', async () => {
    const env = createRealtimeEnv();

    // A narrow list (e.g. a kanban) loads a subset of fields, then unmounts.
    const narrowHook = renderHook(() =>
      env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name'] },
      ),
    );
    await flushAllTimers();
    narrowHook.unmount();
    env.clearTimeline();

    // A realtime record-change event fully invalidates the query and its
    // items while nothing is mounted — recorded in the query's
    // `refetchOnMount` at `realtimeUpdate` priority.
    await advanceTime(100);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: { tableId: 'users' },
        itemPayload: (itemKey) => itemKey.startsWith('users||'),
        type: 'realtimeUpdate',
      });
    });

    // A wider query hook mounts: 'age' was never loaded — missing data that
    // must fetch immediately instead of inheriting the throttled priority.
    await advanceTime(50);
    const { result } = renderHook(() =>
      env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name', 'age'] },
      ),
    );

    // An immediate fetch has finished by now; the throttled alternative
    // would not even have started.
    await advanceTime(850);
    expect(result.current.items[0]?.age).toBe(10);

    await flushAllTimers();
    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: ['id', 'name']
            pos: { limit: 50, offset: 0 }
          returned_items: 5
        - _type: 'list'
          payload:
            fields: ['id', 'name', 'age']
            pos: { limit: 50, offset: 0 }
          returned_items: 5
      `);
  });

  test('a late-mounting hook requesting a field owed at high priority fetches immediately despite a later realtime invalidation', async () => {
    const env = createRealtimeEnv();

    // The item's fields load through a hook that then unmounts.
    const firstMount = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['name', 'age'] }),
    );
    await flushAllTimers();
    firstMount.unmount();
    env.clearTimeline();

    // A high-priority per-field invalidation of 'age' arrives while no hook
    // is mounted — the obligation stays pending at `highPriority`.
    await advanceTime(100);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        fields: ['age'],
        type: 'highPriority',
      });
    });

    // A later realtime full invalidation overwrites `refetchOnMount` with
    // `realtimeUpdate` — but the per-field tracking still owes 'age' at
    // `highPriority`.
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'realtimeUpdate',
      });
    });

    // The server value changes; the cached age (10) is genuinely stale.
    env.serverTable.updateItem('users||1', { age: 99 });

    // A hook mounts requesting 'age': the field is owed at `highPriority`,
    // so the mount fetch must run immediately instead of inheriting the
    // throttled realtime priority from `refetchOnMount`.
    await advanceTime(50);
    const { result } = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['age'] }),
    );

    // An immediate fetch has finished by now (~1.77s); the throttled
    // alternative would only start fetching at the throttle boundary.
    await advanceTime(850);
    expect(result.current.data?.age).toBe(99);

    await flushAllTimers();
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | -- timeline-cleared
      910ms | server-data-changed (value: {"age":99})
      970ms | 🟠 >fetch-started
      1.77s | 🟠 <fetch-finished (value: {"age":99})
      "
    `);
  });

  test('a late-mounting query hook displaying a field owed at high priority fetches immediately despite a later realtime invalidation', async () => {
    const env = createRealtimeEnv();

    // The list's fields load through a hook that then unmounts.
    const firstMount = renderHook(() =>
      env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name', 'age'] },
      ),
    );
    await flushAllTimers();
    firstMount.unmount();
    env.clearTimeline();

    // A high-priority per-field invalidation of 'age' on the items arrives
    // while nothing is mounted.
    await advanceTime(100);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: (itemKey) => itemKey.startsWith('users||'),
        fields: ['age'],
        type: 'highPriority',
      });
    });

    // A later realtime full invalidation overwrites the query's
    // `refetchOnMount` with `realtimeUpdate` — but the items' per-field
    // tracking still owes 'age' at `highPriority`.
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: { tableId: 'users' },
        itemPayload: (itemKey) => itemKey.startsWith('users||'),
        type: 'realtimeUpdate',
      });
    });

    // The server value changes; the cached age (10) is genuinely stale.
    env.serverTable.updateItem('users||1', { age: 99 });

    // The query hook remounts displaying 'age': owed at `highPriority`, so
    // the mount fetch must run immediately, not throttled.
    await advanceTime(50);
    const { result } = renderHook(() =>
      env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name', 'age'] },
      ),
    );

    // An immediate fetch has finished by now (~1.77s); the throttled
    // alternative would only start fetching at the throttle boundary.
    await advanceTime(850);
    expect(result.current.items[0]?.age).toBe(99);

    await flushAllTimers();
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | -- timeline-cleared
      910ms | server-data-changed (value: {"age":99})
      970ms | 🟠 >list-fetch-started
      1.77s | 🟠 <list-fetch-finished (value: {"count":5})
      "
    `);
  });
});

describe('partial resources: failed optimistic deletes keep pending invalidation tracking', () => {
  // Finding: `deleteItemState` clears the item's durable full-invalidation
  // marker, but the mutation rollback snapshot never captured it — a failed
  // optimistic delete restored the stale snapshot without the marker, so
  // `inferFields` vouched the stale data as complete indefinitely and hooks
  // never refetched the still-owed fields.

  test('fields still owed by a full invalidation refetch after a failed optimistic delete', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: listInferFieldsConfig,
    });

    // The item is fully loaded ('*') via a detail view, then that view
    // closes.
    const preload = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: '*',
    });
    await flushAllTimers();
    await preload;

    // A full high-priority invalidation records the durable
    // full-invalidation marker (the '*' snapshot has no field list to
    // enumerate).
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'highPriority',
      });
    });

    // A narrow hook consumes the invalidation for its own field only —
    // 'age' stays owed by the marker while its stale value remains in state
    // (without the marker, `inferFields` would vouch for it as fresh).
    const narrowHook = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['name'] }),
    );
    await flushAllTimers();
    narrowHook.unmount();

    // The server value changes; the cached age (10) is genuinely stale.
    env.serverTable.updateItem('users||1', { age: 99 });

    // Optimistically delete the item, then the mutation fails and rolls
    // back the deletion.
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.deleteItemState('users||1');
        },
        mutation: () => Promise.reject(new Error('boom')),
      });
    });
    await flushAllTimers();
    env.clearTimeline();

    // A hook mounts requesting 'age' — still owed by the restored
    // full-invalidation marker, so it must refetch instead of trusting the
    // stale rolled-back value.
    const { result } = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['age'] }),
    );
    await flushAllTimers();

    expect(result.current.data?.age).toBe(99);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      1.62s | -- timeline-cleared
      1.63s | 🟡 >fetch-started
      2.43s | 🟡 <fetch-finished (value: {"age":99})
      "
    `);
  });
});
