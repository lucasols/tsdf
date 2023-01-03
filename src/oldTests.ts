import {
  TestStore,
  sleep,
  delay,
  TestMultiQueryStore,
} from './apiStoreUpdateManagerTestUtils';

// FIX: remove file

async function defaultAction(
  store: TestStore,
  value: number,
  { mutationMs, fetchMs }: { mutationMs?: number; fetchMs?: number } = {},
) {
  store.optimisticUpdate(value); // 0ms
  const endMutation = store.startMutation();
  await store.apiMutation(value, mutationMs); // 300ms

  endMutation();

  await store.fetch({ ms: fetchMs, type: 'forceUpdate' }); // 200ms
}

describe('default updates', () => {
  test('its working', async () => {
    const store = new TestStore(0, false);

    await defaultAction(store, 1);

    expect(store.uiHistory).toStrictEqual([0, 1]);
  });

  test('normal update', async () => {
    const store = new TestStore(0, false);

    await defaultAction(store, 1);

    await sleep(10);

    await defaultAction(store, 2);

    expect(store.uiHistory).toStrictEqual([0, 1, 2]);
  });

  test('concurrent updates', async () => {
    const store = new TestStore(0, false);

    const promises = [
      defaultAction(store, 1),
      delay(350, () => defaultAction(store, 2)),
    ];

    await Promise.all(promises);

    expect(store.uiHistory).toStrictEqual([0, 1, 2]);
  });

  test('concurrent mutations', async () => {
    const store = new TestStore(0, false);

    const promises = [
      delay(0, () => defaultAction(store, 1)),
      delay(295, () => defaultAction(store, 2)),
    ];

    await Promise.all(promises);

    expect(store.uiHistory).toStrictEqual([0, 1, 2]);
    expect(store.serverHistory).toStrictEqual([0, 1, 2]);
  });

  test('multiples mutations with fetch between', async () => {
    const store = new TestStore(0, false);

    const promises = [
      defaultAction(store, 1),
      delay(320, () => defaultAction(store, 2)),
      delay(380, () => store.fetch({ type: 'fetch' })),
    ];

    await Promise.all(promises);

    expect(store.uiHistory).toStrictEqual([0, 1, 2]);
  });

  test('overfetching', async () => {
    const store = new TestStore(0, false);

    const promises = [
      delay(10, () => store.fetch({ type: 'fetch' })),
      delay(20, () => store.fetch({ type: 'fetch' })),
      delay(30, () => store.fetch({ type: 'fetch' })),
      delay(40, () => store.fetch({ type: 'fetch' })),
    ];

    await Promise.all(promises);

    expect(store.fetchs).toStrictEqual(1);
  });

  test('slow mutation then fetch', async () => {
    const store = new TestStore(0, false);

    const promises = [
      defaultAction(store, 1, { mutationMs: 1000 }),
      delay(600, () => store.fetch({ type: 'realtimeUpdate' })),
    ];

    await Promise.all(promises);

    expect(store.uiHistory).toStrictEqual([0, 1]);
    expect(store.fetchs).toStrictEqual(1);
  });

  test('slow fetch then mutation', async () => {
    const store = new TestStore(0, false);

    const promises = [
      defaultAction(store, 1, { fetchMs: 1000 }),
      delay(400, () => defaultAction(store, 2)),
    ];

    await Promise.all(promises);

    expect(store.actionsHistory).toStrictEqual([
      'optmistic/mutation-updated: 1',
      'mutation-finished: 1',
      'fetch-started',
      'optmistic/mutation-updated: 2',
      'mutation-finished: 2',
      'fetch-started',
      'fetch-finished: 2',
      'ui-update-skipped: 1',
    ]);
    expect(store.uiHistory).toStrictEqual([0, 1, 2]);
    expect(store.fetchs).toStrictEqual(2);
    expect(store.commits).toStrictEqual(1);
  });
});

async function realtimeAction(store: TestStore, value: number, ms?: number) {
  const endMutation = store.startMutation();
  store.optimisticUpdate(value); // 0ms
  await store.apiMutation(value, ms); // 350ms

  endMutation();
}

async function actionWithoutOptimisticUpdate(
  store: TestStore,
  value: number,
  ms?: number,
) {
  const endMutation = store.startMutation();
  await store.apiMutation(value, ms);

  endMutation();

  void store.fetch({ type: 'forceUpdate' });
}

describe('realtime updates', () => {
  test('concurrent updates', async () => {
    const store = new TestStore(0, true);

    const promises = [
      realtimeAction(store, 1),
      delay(420, () => realtimeAction(store, 2)),
    ];

    await Promise.all(promises);

    await sleep(1000);

    expect(store.actionsHistory).toStrictEqual([
      'optmistic/mutation-updated: 1', // 0ms
      'mutation-finished: 1', // 350ms
      'fetch-started', // 400ms
      'optmistic/mutation-updated: 2', // 400ms
      'ui-update-schedule: 1', // 600ms
      'mutation-finished: 2', // 750ms
      'fetch-started', // 800ms
      'fetch-skipped',
      'fetch-finished: 2',
      // scheduled update
      'fetch-started',
      'fetch-finished: 2',
    ]);

    expect(store.uiHistory).toStrictEqual([0, 1, 2]);
  });

  test('concurrent mutations', async () => {
    const store = new TestStore(0, true);

    const promises = [
      realtimeAction(store, 1),
      delay(300, () => realtimeAction(store, 2)),
    ];

    await Promise.all(promises);

    await sleep(1000);
    expect(store.uiHistory).toStrictEqual([0, 1, 2]);
    expect(store.actionsHistory).toStrictEqual([
      'optmistic/mutation-updated: 1', // 0ms
      'optmistic/mutation-updated: 2', // 0ms
      'mutation-finished: 1', // 350ms
      'fetch-skipped', // 400ms
      'mutation-finished: 2', // 750ms
      'fetch-started',
      'fetch-skipped',
      'fetch-finished: 2',
      'fetch-started',
      'fetch-finished: 2',
    ]);
  });

  test('receive update while mutation is in progress', async () => {
    const store = new TestStore(0, true);

    const promises = [
      realtimeAction(store, 1),
      delay(200, () => store.fetch({ type: 'realtimeUpdate' })),
    ];

    await Promise.all(promises);

    await sleep(1000);
    expect(store.uiHistory).toStrictEqual([0, 1]);
  });

  test('fetch update is missing', async () => {
    const store = new TestStore(0, true, true);

    const promises = [
      actionWithoutOptimisticUpdate(store, 1),
      delay(380, () => actionWithoutOptimisticUpdate(store, 2)),
    ];

    await Promise.all(promises);

    await sleep(1000);
    expect(store.uiHistory).toStrictEqual([0, 2]);
  });

  test('overfetching realtime updates', async () => {
    const store = new TestStore(0, false);

    const promises = [
      delay(10, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(20, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(30, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(40, () => store.fetch({ type: 'realtimeUpdate' })),
    ];

    await Promise.all(promises);

    await sleep(500);

    expect(store.fetchs).toStrictEqual(2);
  });

  test('throttle realtime updates', async () => {
    const store = new TestStore(0, false);

    const slowDuration = 1600;

    const promises = [
      delay(0, () => store.fetch({ type: 'realtimeUpdate', ms: slowDuration })),
      delay(slowDuration + 20, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(slowDuration + 30 + 220, () =>
        store.fetch({ type: 'realtimeUpdate' }),
      ),
      delay(slowDuration + 40 + 220 * 2, () =>
        store.fetch({ type: 'realtimeUpdate' }),
      ),
    ];

    await Promise.all(promises);

    await sleep(1700);

    expect(store.fetchs).toStrictEqual(2);
  });

  test('skip background updates', async () => {
    const store = new TestStore(0, false);

    const promises = [
      delay(10, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(20, async () => {
        store.setPageIsHidden(true);
      }),
      delay(1000, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(1400, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(1900, () => store.fetch({ type: 'realtimeUpdate' })),
    ];

    await Promise.all(promises);

    await sleep(500);

    expect(store.fetchs).toStrictEqual(1);
  });

  test('schedule background updates', async () => {
    const store = new TestStore(0, false);

    const promises = [
      delay(10, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(20, async () => {
        store.setPageIsHidden(true);
      }),
      delay(1000, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(1400, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(1900, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(2000, async () => {
        store.setPageIsHidden(false);
      }),
    ];

    await Promise.all(promises);

    await sleep(500);

    expect(store.fetchs).toStrictEqual(2);
  });

  test('schedule background updates are not duplicated', async () => {
    const store = new TestStore(0, false);

    const promises = [
      delay(20, async () => {
        store.setPageIsHidden(true);
      }),
      delay(1000, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(1400, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(1900, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(2000, async () => {
        store.setPageIsHidden(false);
      }),
      delay(2400, async () => {
        store.setPageIsHidden(true);
      }),
      delay(2500, () => store.fetch({ type: 'realtimeUpdate' })),
      delay(2600, async () => {
        store.setPageIsHidden(false);
      }),
    ];

    await Promise.all(promises);

    await sleep(500);

    expect(store.fetchs).toStrictEqual(2);
  });
});

describe('stores with query fetchs', () => {
  test('fetchs with different ids do not cancel each other', async () => {
    const store = new TestMultiQueryStore({ a: 0, b: 0 }, false, false, {
      a: 1,
      b: 1,
    });

    const promises = [
      delay(10, () => store.fetch({ type: 'fetch', key: 'a' })),
      delay(20, () => store.fetch({ type: 'fetch', key: 'b' })),
    ];

    await Promise.all(promises);

    await sleep(500);

    expect(store.commits).toStrictEqual(2);
    expect(store.uiHistory).toStrictEqual([
      { a: 0, b: 0 },
      { a: 1, b: 0 },
      { a: 1, b: 1 },
    ]);
  });
});
