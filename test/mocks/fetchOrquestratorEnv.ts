import {
  createFetchOrquestrator,
  FetchType,
  ShouldAbortFetch,
} from '../../src/fetchOrquestrator';
import { sleep } from '../utils/sleep';

type Data = number | 'error' | null;

type AddAction = (action: string, value?: Data) => void;

function serverEmulator(initialData: Data, addAction: AddAction) {
  const serverDataHistory: Data[] = [initialData];

  async function mutateData(
    newData: Data,
    {
      preTime = 50,
      postTime = 10,
    }: { preTime?: number; postTime?: number } = {},
  ) {
    addAction(`mutation-started`, newData);

    await sleep(preTime);

    serverDataHistory.push(newData);

    await sleep(postTime);

    addAction(`mutation-finished`, newData);
  }

  return {
    mutateData,
    get current() {
      return serverDataHistory.at(-1)!;
    },
    history: serverDataHistory,
  };
}

function uiEmulator(initialData: Data, addAction: AddAction) {
  const uiHistory: Data[] = [initialData];

  function setUi(value: number, reason: 'optimistic' | 'fetch') {
    uiHistory.push(value);
    addAction(`${reason}-ui-commit`, value);
  }

  return {
    setUi,
    history: uiHistory,
    get changesHistory() {
      const historyWithoutDuplicates: Data[] = [];

      for (const value of uiHistory) {
        if (value !== historyWithoutDuplicates.at(-1)) {
          historyWithoutDuplicates.push(value);
        }
      }

      return historyWithoutDuplicates;
    },
    get current() {
      return uiHistory.at(-1)!;
    },
  };
}

export function createTestStore(
  serverInitialData: Data,
  {
    uiInitialData = 0,
  }: {
    serverInitialData?: Data;
    uiInitialData?: Data;
  } = {},
) {
  const actionsHistory: {
    action: string;
    time: number;
    value: Data | undefined;
  }[] = [];
  const initialTime = Date.now();

  function getRelativeTime() {
    const relativeTime = Date.now() - initialTime;

    return Math.round(relativeTime / 10) * 10;
  }

  const addAction: AddAction = (action, value) => {
    actionsHistory.push({
      action,
      time: getRelativeTime(),
      value,
    });
  };

  const server = serverEmulator(serverInitialData, addAction);
  const ui = uiEmulator(uiInitialData, addAction);
  let numOfFetchs = 0;

  async function mockFetch(shouldAbortResult: ShouldAbortFetch, ms: number) {
    await sleep(ms);

    numOfFetchs++;

    const serverResponse = server.current;

    if (serverResponse === 'error') {
      addAction('fetch-error');
      return false;
    }

    if (shouldAbortResult()) {
      addAction(`fetch-aborted`, serverResponse);
      return false;
    }

    addAction(`fetch-finished`, serverResponse);
    ui.setUi(serverResponse, 'fetch');

    return true;
  }

  async function waitForNoPendingRequests() {
    while (
      fetchOrquestrator.hasPendingFetch ||
      fetchOrquestrator.mutationIsInProgress
    ) {
      await sleep(10);
    }
  }

  const fetchOrquestrator = createFetchOrquestrator({
    fetchFn: mockFetch,
    on(event) {
      addAction(event);
    },
  });

  /** default duration = 40 */
  function scheduleFetch(priority: FetchType, duration = 40) {
    const result = fetchOrquestrator.scheduleFetch(priority, duration);

    if (result === 'started') {
      addAction('fetch-started');
    }

    if (result === 'skipped') {
      addAction('fetch-skipped');
    }

    if (result === 'scheduled') {
      addAction('fetch-scheduled');
    }
  }

  return {
    ui,
    server,
    get timeline(): string {
      const timeline: string[] = [];

      for (const { action, time, value } of actionsHistory) {
        const lastAction = timeline.at(-1);

        let actionText = action;

        if (value) {
          actionText = `${stringFromLength(
            value === 'error' ? 0 : (value - 1) * 2,
          )}${value} - ${action}`;
        }

        if (lastAction?.startsWith(`${time}ms:`)) {
          timeline.push(`${time}ms:--${actionText}`);
        } else {
          timeline.push(`${time}ms: ${actionText}`);
        }
      }

      const maxTimeLength = Math.max(
        ...timeline.map((action) => action.split(':')[0]!.length),
      );

      const timelineWithBalancedStart = timeline.map((action) => {
        const [time, actionType] = action.split(':');

        return `${stringFromLength(
          maxTimeLength - time!.length,
        )}${time}:${actionType}`;
      });

      return `\n${timelineWithBalancedStart
        .map((action) => {
          if (action.includes('--')) {
            const [time, actionType] = action.split(':--');

            return ` ${stringFromLength(time!.length - 1)}: ${actionType}`;
          }

          return action;
        })
        .join('\n')}\n`;
    },
    get actions() {
      return [
        '\n',
        actionsHistory
          .map(({ action, value }) => {
            let actionText = action;

            if (value) {
              actionText = `${stringFromLength(
                value === 'error' ? 0 : (value - 1) * 2,
              )}${value} - ${action}`;
            }

            return actionText;
          })
          .join('\n'),
        '\n',
      ].join('');
    },
    scheduleFetch,
    get numOfFetchs() {
      return numOfFetchs;
    },
    mutateData: server.mutateData,
    optimisticUpdate(value: number) {
      ui.setUi(value, 'optimistic');
    },
    waitForNoPendingRequests,
    startMutation: fetchOrquestrator.startMutation,
  };
}

export type TestStore = ReturnType<typeof createTestStore>;

function stringFromLength(length: number, string = ' ') {
  return Array.from({ length })
    .map((_) => string)
    .join('');
}
