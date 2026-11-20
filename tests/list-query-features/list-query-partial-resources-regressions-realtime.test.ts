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
          fields: ['address', 'id', 'name']
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
      2.62s | 🟠 <fetch-finished (value: {"address":"Address 1","name":"User 1"})
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

  test('an escalated field invalidation does not strand stale fields owed to other mounted hooks', async () => {
    const env = createRealtimeEnv();

    // Two independent components display different fields of the same item.
    const nameHook = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['name'] }),
    );
    const addressHook = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['address'] }),
    );
    await flushAllTimers();
    env.clearTimeline();

    // A realtime record-change event fully invalidates the item inside the
    // throttle window — both hooks' stale fields ride on a single delayed
    // refetch scheduled at the throttle boundary.
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

    // While that refetch is still waiting, the app explicitly invalidates
    // only 'name' at highPriority. The immediate escalated fetch replaces the
    // delayed one — which was also carrying the address hook's stale field.
    await advanceTime(50);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'highPriority',
        fields: ['name'],
      });
    });

    await flushAllTimers();

    // The address hook's owed field must ride along on the escalated fetch —
    // one immediate request covering both hooks' stale fields. Without this,
    // the cancelled delayed fetch was the only carrier of 'address' and the
    // address hook would show the stale value forever.
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
    expect(nameHook.result.current.data?.name).toBe('New User 1');
    expect(addressHook.result.current.data?.address).toBe('New Address 1');
  });

  test('stale fields owed to other hooks are preserved regardless of hook registration order', async () => {
    const env = createRealtimeEnv();

    // Same scenario as above, but the hook that does NOT match the escalated
    // event's fields registers first — so its handler runs first and becomes
    // the one scheduling the immediate fetch, while the name hook's handler
    // contributes afterwards.
    const addressHook = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['address'] }),
    );
    const nameHook = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['name'] }),
    );
    await flushAllTimers();
    env.clearTimeline();

    // Full realtime invalidation inside the throttle window...
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

    // ...escalated by an explicit high-priority 'name' invalidation.
    await advanceTime(50);
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'highPriority',
        fields: ['name'],
      });
    });

    await flushAllTimers();

    // Still a single immediate fetch covering both hooks' stale fields.
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
    expect(nameHook.result.current.data?.name).toBe('New User 1');
    expect(addressHook.result.current.data?.address).toBe('New Address 1');
  });

  test('successive realtime field invalidations inside the throttle window all land in the delayed refetch', async () => {
    const env = createRealtimeEnv();

    // Two independent components display different fields of the same item.
    const nameHook = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['name'] }),
    );
    const addressHook = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['address'] }),
    );
    await flushAllTimers();
    env.clearTimeline();
    env.serverTable.clearFetchHistory();

    // A realtime event invalidates 'name' inside the throttle window — the
    // refetch is scheduled at the throttle boundary.
    await advanceTime(100);
    env.serverTable.updateItem('users||1', { name: 'New User 1' });
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'realtimeUpdate',
        fields: ['name'],
      });
    });

    // A second realtime event invalidates 'address' while that delayed fetch
    // is still pending. Both fields must ride on the same delayed fetch.
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

    await flushAllTimers();

    // A single delayed refetch fires at the throttle boundary carrying BOTH
    // invalidated fields — the delayed fetch must execute with the payload
    // coalesced across the whole wait, not the payload captured when it was
    // first scheduled (which only carried 'name', leaving 'address' stale
    // forever).
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['address', 'name']
            itemId: 'users||1'
      `);

    expect(nameHook.result.current.data?.name).toBe('New User 1');
    expect(addressHook.result.current.data?.address).toBe('New Address 1');
  });

  test("a full high-priority invalidation of a '*'-loaded item does not disable throttling of later realtime invalidations", async () => {
    const env = createRealtimeEnv();

    // A detail view loaded the full item at some point (fields: '*'), then
    // closed — no '*' hook stays mounted afterwards.
    const preload = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: '*',
    });
    await flushAllTimers();
    await preload;

    // A list grid stays mounted with a fixed set of fields.
    renderHook(() =>
      env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name', 'address'] },
      ),
    );
    await flushAllTimers();

    // Idle long enough for the realtime throttle window to pass.
    await advanceTime(2_000);
    env.clearTimeline();
    env.serverTable.clearFetchHistory();

    // After a mutation the app fully invalidates the mutated record at
    // highPriority — the list refetches immediately, which is expected.
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'highPriority',
      });
    });
    // The refetch (800ms) settles; we are now 200ms after it — well inside
    // the realtime throttle window of that fetch.
    await advanceTime(1_000);
    expect(env.serverTable.getRequestHistory('list').length).toBe(1);

    env.addTimelineComments('beforeNextAction', ['realtime event arrives']);

    // A realtime record-change event arrives shortly after (e.g. an
    // automation side effect). The high-priority refetch only reloaded the
    // list's fields, so the item's '*' full-invalidation marker is still
    // unresolved — that leftover obligation must NOT escalate this realtime
    // invalidation to an immediate high-priority refetch.
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: () => true,
        itemPayload: () => true,
        type: 'realtimeUpdate',
      });
    });

    // The refetch must stay delayed until the throttle boundary — no
    // cancellation of the scheduled realtime fetch, no immediate fetch.
    await flushAllTimers();
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      3.62s | -- timeline-cleared
      3.63s | 🟡 >list-fetch-started
      4.43s | 🟡 <list-fetch-finished (value: {"count":5})
      4.62s | -- realtime event arrives
      .     | rt-fetch-scheduled (delay: 810ms)
      5.43s | scheduled-rt-fetch-started
      5.44s | 🟢 >list-fetch-started
      6.24s | 🟢 <list-fetch-finished (value: {"count":5})
      "
    `);
  });

  test('leftover stale fields from a wider-loaded item do not disable throttling of later realtime invalidations', async () => {
    const env = createRealtimeEnv();

    // The item was loaded with MORE named fields than the list displays
    // (e.g. an expanded row view), then that view closed.
    const preload = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: ['name', 'address', 'age', 'country'],
    });
    await flushAllTimers();
    await preload;

    // A list grid stays mounted with a narrower set of fields.
    renderHook(() =>
      env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name', 'address'] },
      ),
    );
    await flushAllTimers();

    // Idle long enough for the realtime throttle window to pass.
    await advanceTime(2_000);
    env.clearTimeline();
    env.serverTable.clearFetchHistory();

    // Full high-priority invalidation of the record: every loaded field goes
    // stale, but the immediate list refetch only reloads the list's fields —
    // 'age' and 'country' remain pending at highPriority with no mounted
    // hook to ever refetch them.
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'highPriority',
      });
    });
    await advanceTime(1_000);
    expect(env.serverTable.getRequestHistory('list').length).toBe(1);

    env.addTimelineComments('beforeNextAction', ['realtime event arrives']);

    // A realtime record-change event arrives inside the throttle window. The
    // leftover high-priority fields ('age'/'country') are not displayed by
    // any hook — they must not escalate the list's realtime refetch.
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: () => true,
        itemPayload: () => true,
        type: 'realtimeUpdate',
      });
    });

    // The refetch must stay delayed until the throttle boundary — no
    // cancellation of the scheduled realtime fetch, no immediate fetch.
    await flushAllTimers();
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      3.62s | -- timeline-cleared
      3.63s | 🟡 >list-fetch-started
      4.43s | 🟡 <list-fetch-finished (value: {"count":5})
      4.62s | -- realtime event arrives
      .     | rt-fetch-scheduled (delay: 810ms)
      5.43s | scheduled-rt-fetch-started
      5.44s | 🟢 >list-fetch-started
      6.24s | 🟢 <list-fetch-finished (value: {"count":5})
      "
    `);
  });

  test("a leftover high-priority obligation on a '*'-loaded item's undisplayed field must not escalate a later realtime full invalidation", async () => {
    const env = createRealtimeEnv();

    // The item was fully loaded ('*') via a detail view (e.g. an edit form),
    // then that view closed.
    const preload = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: '*',
    });
    await flushAllTimers();
    await preload;

    // A list grid stays mounted with fields that do NOT include 'age'.
    renderHook(() =>
      env.apiStore.useListQuery(
        { tableId: 'users' },
        { fields: ['id', 'name', 'address'] },
      ),
    );
    await flushAllTimers();

    // Idle long enough for the realtime throttle window to pass.
    await advanceTime(2_000);
    env.clearTimeline();
    env.serverTable.clearFetchHistory();

    // Per-field HIGH invalidation of 'age' — a field no mounted hook
    // displays. The item is '*'-loaded, so this records a pending
    // {age: highPriority} entry while `loadedFields` stays '*'. Nothing
    // displays 'age', so no refetch happens and the obligation stays
    // pending.
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        fields: ['age'],
        type: 'highPriority',
      });
    });

    // A query-only high invalidation gives the realtime throttle a fresh
    // baseline fetch (it does not touch item invalidation tracking).
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: { tableId: 'users' },
        itemPayload: false,
        type: 'highPriority',
      });
    });
    await advanceTime(1_000);
    expect(env.serverTable.getRequestHistory('list').length).toBe(1);

    env.addTimelineComments('beforeNextAction', ['realtime event arrives']);

    // A realtime record-change event arrives inside the throttle window.
    // The leftover high-priority 'age' obligation must NOT fold into the
    // item's full-invalidation marker and escalate the list's realtime
    // refetch past the throttle.
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: () => true,
        itemPayload: () => true,
        type: 'realtimeUpdate',
      });
    });

    // The refetch must stay delayed until the throttle boundary — no
    // cancellation of the scheduled realtime fetch, no immediate fetch.
    await flushAllTimers();
    expect(env.timelineString).not.toContain('rt-fetch-cancelled');
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      3.62s | -- timeline-cleared
      3.63s | 🟡 >list-fetch-started
      4.43s | 🟡 <list-fetch-finished (value: {"count":5})
      4.62s | -- realtime event arrives
      .     | rt-fetch-scheduled (delay: 810ms)
      5.43s | scheduled-rt-fetch-started
      5.44s | 🟢 >list-fetch-started
      6.24s | 🟢 <list-fetch-finished (value: {"count":5})
      "
    `);
  });

  test("fields reloaded since a high-priority '*'-vouched marker stay throttled on a later realtime full invalidation", async () => {
    // Same failure mode as the tests above, but with an `inferFields` that
    // vouches '*' once the item snapshot is complete (the docs' shape for
    // manually inserted / persisted rows). With a complete snapshot in state,
    // EVERY full invalidation takes the '*' marker path — including ones on
    // an item whose tracked `itemLoadedFields` is a narrow array. Fields
    // reloaded since a high-priority marker are owed only at the incoming
    // priority, and must not fall back to the marker's high priority once
    // `itemLoadedFields` is cleared.
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: starInferFieldsConfig,
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 1000,
    });

    // The item is fully loaded ('*') via a detail view, then that view
    // closes.
    const preload = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: '*',
    });
    await flushAllTimers();
    await preload;

    // A narrow hook (e.g. a kanban card) stays mounted.
    renderHook(() => env.apiStore.useItem('users||1', { fields: ['name'] }));
    await flushAllTimers();

    // Idle long enough for the realtime throttle window to pass.
    await advanceTime(2_000);
    env.clearTimeline();
    env.serverTable.clearFetchHistory();

    // A full high-priority invalidation records the '*' marker; the mounted
    // hook refetches 'name' immediately, which is expected. 'name' is now
    // reloaded SINCE the high marker, but the marker itself survives (the
    // item never returns to '*'-loaded).
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'highPriority',
      });
    });
    // The refetch (800ms) settles; we are now 200ms after it — well inside
    // the realtime throttle window of that fetch.
    await advanceTime(1_000);
    expect(env.serverTable.getRequestHistory('item').length).toBe(1);

    env.addTimelineComments('beforeNextAction', ['realtime event arrives']);

    // A realtime record-change event arrives inside the throttle window. The
    // snapshot is still complete, so this full invalidation also takes the
    // '*' marker path. 'name' is owed only at `realtimeUpdate` — the
    // leftover high-priority marker must not escalate its refetch to an
    // immediate high-priority fetch.
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'realtimeUpdate',
      });
    });

    // The refetch must stay delayed until the throttle boundary — no
    // cancellation of the scheduled realtime fetch, no immediate fetch.
    await flushAllTimers();
    expect(env.timelineString).not.toContain('rt-fetch-cancelled');
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      2.81s | -- timeline-cleared
      2.82s | 🟠 >fetch-started
      3.62s | 🟠 <fetch-finished (value: {"name":"User 1"})
      3.81s | -- realtime event arrives
      .     | rt-fetch-scheduled (delay: 810ms)
      4.62s | scheduled-rt-fetch-started
      4.63s | 🟡 >fetch-started
      5.43s | 🟡 <fetch-finished (value: {"name":"User 1"})
      "
    `);
  });

  test('a throttled realtime refetch of other fields survives the retry of a fetch aborted by a mutation', async () => {
    const env = createRealtimeEnv();

    // Two hooks load different fields of the same item
    const nameHook = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['name'] }),
    );
    const ageHook = renderHook(() =>
      env.apiStore.useItem('users||1', { fields: ['age'] }),
    );
    await flushAllTimers();
    await advanceTime(5000);
    env.clearTimeline();

    // A 'name' refetch starts...
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'highPriority',
        fields: ['name'],
      });
    });

    // ...and while it is in flight 'age' changes on the server and its
    // realtime invalidation arrives, to be refetched after the throttle
    await advanceTime(100);
    env.serverTable.updateItem('users||1', { age: 11 });
    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||1',
        type: 'realtimeUpdate',
        fields: ['age'],
      });
    });

    // A 'name' mutation aborts the in-flight 'name' refetch
    await advanceTime(100);
    env.addTimelineComments('beforeNextAction', ['name mutation starts']);
    act(() => {
      void env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', (draft) => {
            draft.name = 'Renamed';
          });
        },
        mutation: () =>
          env.serverTable.delayedUpdateItem('users||1', { name: 'Renamed' }),
      });
    });

    await flushAllTimers();

    // The retried 'name' fetch starts before the throttled 'age' refetch and
    // supersedes it, so it must also fetch 'age' instead of leaving it stale
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      5.81s | -- timeline-cleared
      5.82s | 🟠 >fetch-started
      5.91s | server-data-changed (value: {"age":11})
      6.01s | -- name mutation starts
      .     | 🟠 <fetch-aborted 🚫
      6.62s | rt-fetch-scheduled (delay: 1000ms)
      7.21s | server-data-changed (value: {"name":"Renamed"})
      7.22s | rt-fetch-cancelled
      .     | 🟡 >fetch-started
      8.02s | 🟡 <fetch-finished (value: {"age":11,"name":"Renamed"})
      "
    `);
    expect(ageHook.result.current.data?.age).toBe(11);
    expect(nameHook.result.current.data?.name).toBe('Renamed');
  });
});
