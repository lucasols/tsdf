import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

function getBatchKey(itemId: string): string {
  const prefix = itemId.split('-')[0];
  if (!prefix) throw new Error(`Invalid itemId: ${itemId}`);
  return prefix;
}

describe('batch key grouping', () => {
  test('items with same batch key are batched together', async () => {
    const env = createCollectionStoreTestEnv(
      {
        'api1-item1': { v: 1 },
        'api1-item2': { v: 2 },
        'api1-item3': { v: 3 },
      },
      {
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
        getItemsBatchKey: (payload) => getBatchKey(payload),
      },
    );

    env.scheduleFetch('highPriority', 'api1-item1');
    env.scheduleFetch('highPriority', 'api1-item2');
    env.scheduleFetch('highPriority', 'api1-item3');

    await vi.runAllTimersAsync();

    expect(env.apiStore.getItemState('api1-item1')?.data?.value).toEqual({
      v: 1,
    });
    expect(env.apiStore.getItemState('api1-item2')?.data?.value).toEqual({
      v: 2,
    });
    expect(env.apiStore.getItemState('api1-item3')?.data?.value).toEqual({
      v: 3,
    });

    // All items with same batch key should be in one batch
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: 'api1'
        itemIds: ['api1-item1', 'api1-item2', 'api1-item3']
        results:
          - data: { v: 1 }
            itemId: 'api1-item1'
          - data: { v: 2 }
            itemId: 'api1-item2'
          - data: { v: 3 }
            itemId: 'api1-item3'
        type: 'list'
    `);
  });

  test('items with different batch keys go to separate batches', async () => {
    const env = createCollectionStoreTestEnv(
      {
        'api1-item1': { v: 1 },
        'api1-item2': { v: 2 },
        'api2-item1': { v: 10 },
        'api2-item2': { v: 20 },
      },
      {
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
        getItemsBatchKey: (payload) => getBatchKey(payload),
      },
    );

    env.scheduleFetch('highPriority', 'api1-item1');
    env.scheduleFetch('highPriority', 'api1-item2');
    env.scheduleFetch('highPriority', 'api2-item1');
    env.scheduleFetch('highPriority', 'api2-item2');

    await vi.runAllTimersAsync();

    expect(env.apiStore.getItemState('api1-item1')?.data?.value).toEqual({
      v: 1,
    });
    expect(env.apiStore.getItemState('api2-item1')?.data?.value).toEqual({
      v: 10,
    });

    // Items should be split into two separate batch fetches
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: 'api1'
        itemIds: ['api1-item1', 'api1-item2']
        results:
          - data: { v: 1 }
            itemId: 'api1-item1'
          - data: { v: 2 }
            itemId: 'api1-item2'
        type: 'list'
      - batchKey: 'api2'
        itemIds: ['api2-item1', 'api2-item2']
        results:
          - data: { v: 10 }
            itemId: 'api2-item1'
          - data: { v: 20 }
            itemId: 'api2-item2'
        type: 'list'
    `);
  });

  test('false batch key falls back to individual fetchFn', async () => {
    const env = createCollectionStoreTestEnv(
      {
        'api1-item1': { v: 1 },
        'api1-item2': { v: 2 },
        'api2-item1': { v: 10 },
      },
      {
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
        getItemsBatchKey: (payload) => {
          const id = payload;
          // api2 items should not be batched
          if (id.startsWith('api2-')) return false;
          return getBatchKey(id);
        },
      },
    );

    env.scheduleFetch('highPriority', 'api1-item1');
    env.scheduleFetch('highPriority', 'api1-item2');
    env.scheduleFetch('highPriority', 'api2-item1');

    await vi.runAllTimersAsync();

    expect(env.apiStore.getItemState('api1-item1')?.data?.value).toEqual({
      v: 1,
    });
    expect(env.apiStore.getItemState('api2-item1')?.data?.value).toEqual({
      v: 10,
    });

    // api1 items batched, api2-item1 individual fetch
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: 'api1'
        itemIds: ['api1-item1', 'api1-item2']
        results:
          - data: { v: 1 }
            itemId: 'api1-item1'
          - data: { v: 2 }
            itemId: 'api1-item2'
        type: 'list'
      - itemId: 'api2-item1'
        result: { v: 10 }
        type: 'fetch'
    `);
  });

//   test('mixed: some items batched by key, some individual', async () => {
//     const env = createCollectionStoreTestEnv(
//       {
//         'api1-item1': { v: 1 },
//         'api1-item2': { v: 2 },
//         'api2-item1': { v: 10 },
//         'api2-item2': { v: 20 },
//       },
//       {
//         baseCoalescingWindowMs: 50,
//         useBatchFetch: true,
//         getItemsBatchKey: (payload) => {
//           const id = payload;
//           // api2 items fall back to individual fetch
//           if (id.startsWith('api2-')) return false;
//           return getBatchKey(id);
//         },
//       },
//     );

//     env.scheduleFetch('highPriority', 'api1-item1');
//     env.scheduleFetch('highPriority', 'api2-item1');
//     env.scheduleFetch('highPriority', 'api1-item2');
//     env.scheduleFetch('highPriority', 'api2-item2');

//     await vi.runAllTimersAsync();

//     expect(env.apiStore.getItemState('api1-item1')?.data?.value).toEqual({
//       v: 1,
//     });
//     expect(env.apiStore.getItemState('api1-item2')?.data?.value).toEqual({
//       v: 2,
//     });
//     expect(env.apiStore.getItemState('api2-item1')?.data?.value).toEqual({
//       v: 10,
//     });
//     expect(env.apiStore.getItemState('api2-item2')?.data?.value).toEqual({
//       v: 20,
//     });

//     // api1 items batched, api2 items fetched individually
//     expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
//       - batchKey: 'api1'
//         itemIds: ['api1-item1', 'api1-item2']
//         results:
//           - data: { v: 1 }
//             itemId: 'api1-item1'
//           - data: { v: 2 }
//             itemId: 'api1-item2'
//         type: 'list'
//       - itemId: 'api2-item1'
//         result: { v: 10 }
//         type: 'fetch'
//       - itemId: 'api2-item2'
//         result: { v: 20 }
//         type: 'fetch'
//     `);
//   });

//   test('backward compat: no getItemsBatchKey + useBatchFetch → all items batched', async () => {
//     const env = createCollectionStoreTestEnv(
//       {
//         'api1-item1': { v: 1 },
//         'api1-item2': { v: 2 },
//         'api2-item1': { v: 10 },
//       },
//       {
//         baseCoalescingWindowMs: 50,
//         useBatchFetch: true,
//         // No getItemsBatchKey provided
//       },
//     );

//     env.scheduleFetch('highPriority', 'api1-item1');
//     env.scheduleFetch('highPriority', 'api1-item2');
//     env.scheduleFetch('highPriority', 'api2-item1');

//     await vi.runAllTimersAsync();

//     // All items should go into a single batch (default key)
//     expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
//       - batchKey: '__default__'
//         itemIds: ['api1-item1', 'api1-item2', 'api2-item1']
//         results:
//           - data: { v: 1 }
//             itemId: 'api1-item1'
//           - data: { v: 2 }
//             itemId: 'api1-item2'
//           - data: { v: 10 }
//             itemId: 'api2-item1'
//         type: 'list'
//     `);
//   });

//   test('single item in a batch key group uses fetchFn', async () => {
//     const env = createCollectionStoreTestEnv(
//       { 'api1-item1': { v: 1 } },
//       {
//         baseCoalescingWindowMs: 50,
//         useBatchFetch: true,
//         getItemsBatchKey: (payload) => getBatchKey(payload),
//       },
//     );

//     env.scheduleFetch('highPriority', 'api1-item1');

//     await vi.runAllTimersAsync();

//     // Single item uses fetchFn, not batchFetchFn
//     expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
//       - itemId: 'api1-item1'
//         result: { v: 1 }
//         type: 'fetch'
//     `);
//   });
// });
