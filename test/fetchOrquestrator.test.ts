import { describe, expect, test } from 'vitest';
import { createTestStore, TestStore } from './mocks/fetchOrquestratorEnv';
import { delayCall, waitTimeline } from './utils/delayCall';
import { sleep } from './utils/sleep';

/** default time 60ms */
async function action(
  store: TestStore,
  newValue: number,
  {
    withRevalidation,
    withOptimisticUpdate,
    duration,
    revalidationDuration,
    triggerRTU,
  }: {
    withRevalidation?: boolean;
    withOptimisticUpdate?: boolean;
    duration?: number;
    revalidationDuration?: number;
    triggerRTU?: boolean;
  } = {},
) {
  if (withOptimisticUpdate) {
    store.optimisticUpdate(newValue);
  }

  const endMutation = store.startMutation();

  await store.mutateData(newValue, {
    duration,
    onServerDataChange: triggerRTU
      ? async () => {
          await sleep(5);

          store.fetch('realtimeUpdate', revalidationDuration);
        }
      : undefined,
    addServerDataChangeAction: triggerRTU,
  });

  endMutation();

  if (withRevalidation && !triggerRTU) {
    store.fetch('highPriority', revalidationDuration);
  }
}

test.concurrent(
  'simple mutation with revalidation and optimistic update',
  async () => {
    const store = createTestStore(0);

    await action(store, 1, {
      withRevalidation: true,
      withOptimisticUpdate: true,
    });

    await store.waitForNoPendingRequests();

    expect(store.ui.history).toEqual([0, 1, 1]);

    expect(store.actions).toMatchTimeline(`
    "
    1 - optimistic-ui-commit
    1 - mutation-started
    1 - mutation-finished
    fetch-started : 1
    1 - fetch-finished : 1
    1 - fetch-ui-commit
    "
  `);
  },
);

test.concurrent('simple mutation with optimistic update', async () => {
  const store = createTestStore(0);

  await action(store, 1, {
    withOptimisticUpdate: true,
  });

  await store.waitForNoPendingRequests();

  expect(store.ui.history).toEqual([0, 1]);

  expect(store.actions).toMatchTimeline(`
    "
    1 - optimistic-ui-commit
    1 - mutation-started
    1 - mutation-finished
    "
  `);
});

test.concurrent('simple mutation without optimistic update', async () => {
  const store = createTestStore(0);

  await action(store, 1, {
    withRevalidation: true,
  });

  await store.waitForNoPendingRequests();

  expect(store.ui.history).toEqual([0, 1]);

  expect(store.actions).toMatchTimeline(`
    "
    1 - mutation-started
    1 - mutation-finished
    fetch-started : 1
    1 - fetch-finished : 1
    1 - fetch-ui-commit
    "
  `);
});

test.concurrent('prevent overfetch of low priority fetchs', async () => {
  const store = createTestStore(0);

  const promises = [
    delayCall(0, () => store.fetch('lowPriority')),
    delayCall(10, () => store.fetch('lowPriority')),
    delayCall(20, () => store.fetch('lowPriority')),
    delayCall(30, () => store.fetch('lowPriority')),
  ];

  await Promise.all(promises);

  await store.waitForNoPendingRequests();

  expect(store.numOfFetchs).toBe(1);
  expect(store.actions).toMatchTimeline(`
    "
    fetch-started : 1
    fetch-skipped
    fetch-skipped
    fetch-skipped
    fetch-finished : 1
    fetch-ui-commit
    "
  `);
});

test.concurrent(
  'multiple mutations with revalidation in sequence',
  async () => {
    const store = createTestStore(0);

    const promises = [
      delayCall(0, () =>
        action(store, 1, {
          withOptimisticUpdate: true,
          withRevalidation: true,
        }),
      ),
      delayCall(110, () =>
        action(store, 2, {
          withOptimisticUpdate: true,
          withRevalidation: true,
        }),
      ),
    ];

    await Promise.all(promises);

    await store.waitForNoPendingRequests();

    expect(store.ui.changesHistory).toEqual([0, 1, 2]);
    expect(store.actions).toMatchTimeline(`
    "
    1 - optimistic-ui-commit
    1 - mutation-started
    1 - mutation-finished
    fetch-started : 1
    1 - fetch-finished : 1
    1 - fetch-ui-commit
      2 - optimistic-ui-commit
      2 - mutation-started
      2 - mutation-finished
      fetch-started : 2
      2 - fetch-finished : 2
      2 - fetch-ui-commit
    "
  `);
  },
);

test.concurrent(
  'multiple mutations with revalidation in sequence 2',
  async () => {
    const store = createTestStore(0);

    const mutateValue = (value: number, revalidationDuration: number) =>
      action(store, value, {
        withOptimisticUpdate: true,
        withRevalidation: true,
        duration: 60,
        revalidationDuration,
      });

    const promises = [
      delayCall(0, () => store.fetch('lowPriority', 438)),
      delayCall(7, () => mutateValue(1, 400)),
      delayCall(283, () => mutateValue(2, 476)),
      delayCall(536, () => mutateValue(3, 400)),
      delayCall(781, () => mutateValue(4, 407)),
      delayCall(1_030, () => mutateValue(4, 233)),
    ];

    await Promise.all(promises);

    await store.waitForNoPendingRequests();

    await sleep(200);

    expect(store.ui.changesHistory).toEqual([0, 1, 2, 3, 4]);
    expect(store.actions).toMatchTimeline(`
      "
      fetch-started : 1

      1 - optimistic-ui-commit
      1 - mutation-started
      1 - mutation-finished

        fetch-started : 2

          2 - optimistic-ui-commit
          2 - mutation-started
          2 - mutation-finished

            fetch-started : 3
      fetch-aborted : 1
        fetch-aborted : 2

            3 - optimistic-ui-commit
            3 - mutation-started
            3 - mutation-finished

              fetch-started : 4

                4 - optimistic-ui-commit
                4 - mutation-started
                ---
                fetch-aborted : 3
                4 - mutation-finished
                OR
                4 - mutation-finished
                fetch-aborted : 3
                ---

                fetch-started : 5
              fetch-aborted : 4

              4 - optimistic-ui-commit
              4 - mutation-started
              4 - mutation-finished

                  fetch-started : 6
                fetch-aborted : 5
                  4 - fetch-finished : 6
                  4 - fetch-ui-commit
      "
    `);

    expect(store.numOfFetchs).toBe(6);
  },
);

test.concurrent(
  'multiple mutations with revalidation in sequence 3',
  async () => {
    const store = createTestStore(0);

    const mutateValue = (value: number, revalidationDuration: number) =>
      action(store, value, {
        withOptimisticUpdate: true,
        withRevalidation: true,
        duration: 60,
        revalidationDuration,
      });

    const promises = [
      delayCall(10, () => mutateValue(1, 400)),
      delayCall(283, () => mutateValue(2, 476)),
      delayCall(536, () => mutateValue(3, 400)),
      delayCall(781, () => mutateValue(4, 407)),
      delayCall(1_030, () => mutateValue(4, 233)),
    ];

    await Promise.all(promises);

    await store.waitForNoPendingRequests(10);

    await sleep(200);

    expect(store.ui.changesHistory).toEqual([0, 1, 2, 3, 4]);
    expect(store.actions).toMatchTimeline(`
      "
      1 - optimistic-ui-commit
      1 - mutation-started
      1 - mutation-finished

        fetch-started : 1

        2 - optimistic-ui-commit
        2 - mutation-started
        2 - mutation-finished

          fetch-started : 2
        fetch-aborted : 1

          3 - optimistic-ui-commit
          3 - mutation-started
          3 - mutation-finished

            fetch-started : 3

            4 - optimistic-ui-commit
            4 - mutation-started
            ---
          fetch-aborted : 2
            4 - mutation-finished
            OR
            4 - mutation-finished
          fetch-aborted : 2
            ---

              fetch-started : 4
            fetch-aborted : 3

            4 - optimistic-ui-commit
            4 - mutation-started
            4 - mutation-finished

                fetch-started : 5
              fetch-aborted : 4
                4 - fetch-finished : 5
                4 - fetch-ui-commit
      "
    `);
  },
);

test.concurrent(
  'multiple mutations with revalidation in sequence, causing concurrent updates',
  async () => {
    const store = createTestStore(0);

    const promises = [
      delayCall(0, () =>
        action(store, 1, {
          withOptimisticUpdate: true,
          withRevalidation: true,
        }),
      ),
      delayCall(70, () =>
        action(store, 2, {
          withOptimisticUpdate: true,
          withRevalidation: true,
        }),
      ),
    ];

    await Promise.all(promises);

    await store.waitForNoPendingRequests();

    expect(store.ui.changesHistory).toEqual([0, 1, 2]);
    expect(store.actions).toMatchTimeline(`
    "
    1 - optimistic-ui-commit
    1 - mutation-started
    1 - mutation-finished
    fetch-started : 1
      2 - optimistic-ui-commit
      2 - mutation-started
    fetch-aborted : 1
      2 - mutation-finished
      fetch-started : 2
      2 - fetch-finished : 2
      2 - fetch-ui-commit
    "
  `);
  },
);

test.concurrent(
  'multiple concurrent mutations with revalidation ',
  async () => {
    const store = createTestStore(0);

    const promises = [
      delayCall(0, () =>
        action(store, 1, {
          withOptimisticUpdate: true,
          withRevalidation: true,
        }),
      ),
      delayCall(50, () =>
        action(store, 2, {
          withOptimisticUpdate: true,
          withRevalidation: true,
        }),
      ),
    ];

    await Promise.all(promises);

    await store.waitForNoPendingRequests();

    expect(store.numOfFetchs).toBe(1);

    expect(store.ui.changesHistory).toEqual([0, 1, 2]);
    expect(store.server.history).toEqual([0, 1, 2]);
    expect(store.actions).toMatchTimeline(`
    "
    1 - optimistic-ui-commit
    1 - mutation-started
    1 - mutation-finished
      2 - optimistic-ui-commit
      2 - mutation-started
      fetch-scheduled
      2 - mutation-finished
      scheduled-fetch-started : 1
      fetch-skipped
      2 - fetch-finished : 1
      2 - fetch-ui-commit
    "
  `);
  },
);

test.concurrent('multiple high priority fetchs', async () => {
  const store = createTestStore(0);

  const promises = [
    delayCall(0, () => store.fetch('highPriority')),
    delayCall(5, () => store.fetch('highPriority')),
    delayCall(8, () => store.fetch('highPriority')),
    delayCall(15, () => store.fetch('highPriority')),
    delayCall(20, () => store.fetch('highPriority')),
  ];

  await Promise.all(promises);

  await store.waitForNoPendingRequests();

  expect(store.numOfFetchs).toBe(2);
  expect(store.actions).toMatchTimeline(`
    "
    fetch-started : 1
    fetch-skipped
    fetch-skipped
    fetch-scheduled
    fetch-scheduled
    fetch-finished : 1
    fetch-ui-commit
    scheduled-fetch-started : 2
    fetch-finished : 2
    fetch-ui-commit
    "
  `);
});

test.concurrent('throttle low priority updates', async () => {
  const store = createTestStore(0);

  const promises = [
    delayCall(0, () => store.fetch('lowPriority')),
    delayCall(100, () => store.fetch('lowPriority')),
    delayCall(110, () => store.fetch('lowPriority')),
    delayCall(120, () => store.fetch('lowPriority')),
    delayCall(210, () => store.fetch('lowPriority')),
  ];

  await Promise.all(promises);

  await store.waitForNoPendingRequests();

  expect(store.numOfFetchs).toBe(2);

  expect(store.actions).toMatchTimeline(`
    "
    fetch-started : 1
    fetch-finished : 1
    fetch-ui-commit
    fetch-skipped
    fetch-skipped
    fetch-skipped
    fetch-started : 2
    fetch-finished : 2
    fetch-ui-commit
    "
  `);
});

test.concurrent(
  'multiple mutations with low priority fetch between',
  async () => {
    const store = createTestStore(0);

    const promises = [
      delayCall(0, () =>
        action(store, 1, {
          withOptimisticUpdate: true,
          withRevalidation: true,
        }),
      ),
      delayCall(50, () =>
        action(store, 2, {
          withOptimisticUpdate: true,
          withRevalidation: true,
        }),
      ),
      delayCall(70, () => store.fetch('lowPriority')),
    ];

    await Promise.all(promises);

    await store.waitForNoPendingRequests();

    expect(store.ui.changesHistory).toEqual([0, 1, 2]);
    expect(store.numOfFetchs).toBe(1);
    expect(store.actions).toMatchTimeline(`
    "
    1 - optimistic-ui-commit
    1 - mutation-started
    1 - mutation-finished
      2 - optimistic-ui-commit
      2 - mutation-started
    ---
    fetch-scheduled
    fetch-skipped
    OR
    fetch-skipped
    fetch-scheduled
    ---

      2 - mutation-finished
      scheduled-fetch-started : 1
      fetch-skipped
      2 - fetch-finished : 1
      2 - fetch-ui-commit
    "
  `);
  },
);

test.concurrent(
  'very slow mutation with revalidation then mutation',
  async () => {
    const store = createTestStore(0);

    await waitTimeline([
      [
        0,
        () =>
          action(store, 1, {
            withOptimisticUpdate: true,
            withRevalidation: true,
            revalidationDuration: 400,
          }),
      ],
      [
        100,
        () =>
          action(store, 2, {
            withOptimisticUpdate: true,
            withRevalidation: true,
          }),
      ],
    ]);

    await store.waitForNoPendingRequests();

    await sleep(400);

    expect(store.ui.changesHistory).toEqual([0, 1, 2]);
    expect(store.numOfFetchs).toBe(2);
    expect(store.actions).toMatchTimeline(`
    "
    1 - optimistic-ui-commit
    1 - mutation-started
    1 - mutation-finished

    fetch-started : 1
      2 - optimistic-ui-commit
      2 - mutation-started
      2 - mutation-finished
      fetch-started : 2
      2 - fetch-finished : 2
      2 - fetch-ui-commit
    fetch-aborted : 1
    "
  `);
  },
);

test.concurrent('fetch error', async () => {
  const store = createTestStore(0);

  await waitTimeline(
    [
      [0, () => store.fetch('lowPriority')],
      [50, () => store.errorInNextFetch()],
      [220, () => store.fetch('lowPriority')],
    ],
    300,
  );

  expect(store.server.history).toEqual([0, 'error']);
  expect(store.ui.changesHistory).toEqual([0, 'error']);
  expect(store.numOfFetchs).toBe(2);
  expect(store.actions).toMatchTimeline(`
    "
    fetch-started : 1
    fetch-finished : 1
    fetch-ui-commit
    error - server-data-changed
    fetch-started : 2
    fetch-error : 2
    error - fetch-ui-commit
    "
  `);
});

const defaultRTUMutation = {
  withOptimisticUpdate: true,
  duration: 200 as const,
  triggerRTU: true,
};

describe('realtime updates', () => {
  test.concurrent('dynamically throttle realtime updates', async () => {
    const store = createTestStore(0);

    const slowDuration = 300;

    await waitTimeline([
      [0, () => store.emulateExternalRTU(1, slowDuration)],
      [slowDuration + 20, () => store.emulateExternalRTU(2)],
      [slowDuration + 30, () => store.emulateExternalRTU(3)],
      [slowDuration + 360, () => store.emulateExternalRTU(4)],
    ]);

    await sleep(400);

    expect(store.ui.changesHistory).toEqual([0, 1, 3, 4]);

    expect(store.numOfFetchs).toStrictEqual(3);
    expect(store.actions).toMatchTimeline(`
      "
      1 - server-data-changed
      fetch-started : 1
      1 - fetch-finished : 1
      1 - fetch-ui-commit
        2 - server-data-changed
        rt-fetch-scheduled
          3 - server-data-changed
          rt-fetch-scheduled

          scheduled-rt-fetch-started : 2

          ---
            rt-fetch-scheduled
            4 - server-data-changed
            3 - fetch-finished : 2
            3 - fetch-ui-commit
            scheduled-rt-fetch-started : 3
          OR
            3 - fetch-finished : 2
            3 - fetch-ui-commit
            4 - server-data-changed
            rt-fetch-scheduled
            scheduled-rt-fetch-started : 3
          OR
            4 - server-data-changed
            3 - fetch-finished : 2
            3 - fetch-ui-commit
            rt-fetch-scheduled
            scheduled-rt-fetch-started : 3
          OR
            4 - server-data-changed
            rt-fetch-scheduled
            3 - fetch-finished : 2
            3 - fetch-ui-commit
            scheduled-rt-fetch-started : 3
          OR
            3 - fetch-finished : 2
            3 - fetch-ui-commit
            4 - server-data-changed
            fetch-started : 3
          ---

            4 - fetch-finished : 3
            4 - fetch-ui-commit
      "
    `);
  });

  test.concurrent(
    'dynamically throttle multiple realtime updates at same time with delay inferior to debounce 2',
    async () => {
      const store = createTestStore(0, {
        dynamicRealtimeThrottleMs(lastFetch) {
          return lastFetch < 100 ? 10 : 200;
        },
      });

      await waitTimeline([
        [0, () => store.emulateExternalRTU(1)],
        [
          50,
          () => {
            store.emulateExternalRTU(2, 100);
          },
        ],
        [
          50 + 30,
          () => {
            store.emulateExternalRTU(3, 40, 4);
          },
        ],
      ]);

      await sleep(400);

      expect(store.actions).toMatchTimeline(`
        "
        1 - server-data-changed
        fetch-started : 1
        1 - fetch-finished : 1
        1 - fetch-ui-commit

          2 - server-data-changed
          rt-fetch-scheduled
          scheduled-rt-fetch-started : 2
              3 - server-data-changed
            rt-fetch-scheduled
            rt-fetch-scheduled
            rt-fetch-scheduled
            rt-fetch-scheduled
              3 - fetch-finished : 2
              3 - fetch-ui-commit
            scheduled-rt-fetch-started : 3
              3 - fetch-finished : 3
              3 - fetch-ui-commit
        "
      `);

      expect(store.ui.changesHistory).toEqual([0, 1, 3]);

      expect(store.numOfFetchs).toStrictEqual(3);
    },
    { retry: 2 },
  );

  test.concurrent('simple mutation that triggers a RTU', async () => {
    const store = createTestStore(0);

    await waitTimeline(
      [
        [0, () => store.fetch('lowPriority', 20)],
        [
          110,
          () =>
            action(store, 1, {
              withOptimisticUpdate: true,
              duration: 200,
              triggerRTU: true,
            }),
        ],
      ],
      600,
    );

    expect(store.server.history).toEqual([0, 1]);
    expect(store.ui.changesHistory).toEqual([0, 1]);
    expect(store.numOfFetchs).toEqual(2);

    expect(store.actions).toMatchTimeline(`
      "
      .
      1 - optimistic-ui-commit
      1 - mutation-started
      1 - server-data-changed
      1 - mutation-finished

      rt-fetch-scheduled
      scheduled-rt-fetch-started : 2
      1 - fetch-finished : 2
      1 - fetch-ui-commit
      "
    `);
  });

  test.concurrent(
    'slow mutation then external RTU while mutation RTU is running',
    async () => {
      const store = createTestStore(0);

      await waitTimeline(
        [
          [0, () => store.fetch('lowPriority', 20)],
          [110, () => action(store, 1, defaultRTUMutation)],
          [340, () => store.emulateExternalRTU(2)],
        ],
        510,
      );

      expect(store.server.history).toEqual([0, 1, 2]);
      expect(store.ui.changesHistory).toEqual([0, 1, 2]);
      expect(store.numOfFetchs).toEqual(3);

      expect(store.actions).toMatchTimeline(`
        "
        .
        1 - optimistic-ui-commit
        1 - mutation-started
        1 - server-data-changed
        1 - mutation-finished
        rt-fetch-scheduled
        scheduled-rt-fetch-started : 2
          2 - server-data-changed
          rt-fetch-scheduled

        ---
        2 - fetch-finished : 2
        2 - fetch-ui-commit
        OR
        1 - fetch-finished : 2
        1 - fetch-ui-commit
        ---

          scheduled-rt-fetch-started : 3
          2 - fetch-finished : 3
          2 - fetch-ui-commit
        "
    `);
    },
  );

  test.concurrent(
    'slow mutation then new mutation while prev mutation RTU is running',
    async () => {
      const store = createTestStore(0);

      await waitTimeline(
        [
          [0, () => store.fetch('lowPriority', 20)],
          [110, () => action(store, 1, defaultRTUMutation)],
          [340, () => action(store, 2, defaultRTUMutation)],
        ],
        600,
      );

      expect(store.server.history).toEqual([0, 1, 2]);
      expect(store.ui.changesHistory).toEqual([0, 1, 2]);
      expect(store.numOfFetchs).toEqual(3);

      expect(store.actions).toMatchTimeline(`
        "
        .
        1 - optimistic-ui-commit
        1 - mutation-started
        1 - server-data-changed
        1 - mutation-finished
        rt-fetch-scheduled

        scheduled-rt-fetch-started : 2

          2 - optimistic-ui-commit
          2 - mutation-started

        fetch-aborted : 2

          2 - server-data-changed
          2 - mutation-finished
          rt-fetch-scheduled

          scheduled-rt-fetch-started : 3
          2 - fetch-finished : 3
          2 - fetch-ui-commit
        "
    `);
    },
  );

  test.concurrent(
    'slow mutation then new mutation while prev mutation is running',
    async () => {
      const store = createTestStore(0);

      await waitTimeline(
        [
          [0, () => store.fetch('lowPriority', 20)],
          [110, () => action(store, 1, defaultRTUMutation)],
          [200, () => action(store, 2, defaultRTUMutation)],
        ],
        600,
      );

      expect(store.server.history).toEqual([0, 1, 2]);
      expect(store.ui.changesHistory).toEqual([0, 1, 2]);
      expect(store.numOfFetchs).toEqual(2);

      expect(store.actions).toMatchTimeline(`
      "
      .
      1 - optimistic-ui-commit
      1 - mutation-started
        2 - optimistic-ui-commit
        2 - mutation-started
      1 - server-data-changed
      1 - mutation-finished
      rt-fetch-scheduled
        2 - server-data-changed
        2 - mutation-finished
        rt-fetch-scheduled
        scheduled-rt-fetch-started : 2
        2 - fetch-finished : 2
        2 - fetch-ui-commit
      "
    `);
    },
  );

  test.concurrent('rtu mutations without optimistic updates', async () => {
    const store = createTestStore(0);

    const rtuWithoutOptimisticUpdate = {
      withOptimisticUpdate: false,
      duration: 200,
      triggerRTU: true,
    };

    await waitTimeline(
      [
        [0, () => store.fetch('lowPriority', 20)],
        [110, () => action(store, 1, rtuWithoutOptimisticUpdate)],
        [110 + 220, () => action(store, 2, rtuWithoutOptimisticUpdate)],
      ],
      1000,
    );

    expect(store.server.history).toEqual([0, 1, 2]);
    expect(store.ui.changesHistory).toEqual([0, 2]);

    expect(store.numOfFetchs).toEqual(3);

    expect(store.actions).toMatchTimeline(`
      "
      fetch-started : 1
      fetch-finished : 1
      fetch-ui-commit
      1 - mutation-started
      1 - server-data-changed
      1 - mutation-finished
      rt-fetch-scheduled
      scheduled-rt-fetch-started : 2
        2 - mutation-started
      fetch-aborted : 2
        2 - server-data-changed
        2 - mutation-finished
        rt-fetch-scheduled
        scheduled-rt-fetch-started : 3
        2 - fetch-finished : 3
        2 - fetch-ui-commit
      "
    `);
  });

  test.concurrent(
    'schedule rtu updates then schedulle a fetch right before the rtu starts',
    async () => {
      const store = createTestStore(0, {
        dynamicRealtimeThrottleMs() {
          return 300;
        },
      });

      await waitTimeline(
        [
          [0, () => store.fetch('lowPriority', 20)],
          [110, () => store.emulateExternalRTU(1)],
          [110 + 190, () => store.fetch('lowPriority', 20)],
        ],
        800,
      );

      expect(store.server.history).toEqual([0, 1]);
      expect(store.ui.changesHistory).toEqual([0, 1]);

      expect(store.numOfFetchs).toEqual(2);

      expect(store.actions).toMatchTimeline(`
      "
      fetch-started : 1
      fetch-finished : 1
      fetch-ui-commit
      1 - server-data-changed
      rt-fetch-scheduled
      fetch-started : 2
      1 - fetch-finished : 2
      1 - fetch-ui-commit
      "
    `);
    },
  );
});
