import {
  TestStore,
  sleep,
  delay,
  TestMultiQueryStore,
} from './apiStoreUpdateManagerTestUtils';

// FIX: remove file

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
