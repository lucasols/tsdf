import {
  createFetchOrquestrator,
  FetchType,
  FetchContext,
} from '../../src/fetchOrquestrator';
import { arrayWithPrev } from '../utils/arrayUtils';
import { sleep } from '../utils/sleep';

type Data = number | 'error' | null;

type AddAction = (action: string, value?: Data) => void;

function serverEmulator(initialData: Data, addAction: AddAction) {
  const serverDataHistory: Data[] = [initialData];
  /** default duration: 60 */
  async function mutateData(
    newData: Data,
    {
      duration = 60,
      setDataAt = duration * 0.7,
      onServerDataChange,
      addServerDataChangeAction,
    }: {
      duration?: number;
      setDataAt?: number;
      onServerDataChange?: () => void;
      addServerDataChangeAction?: boolean;
    } = {},
  ) {
    addAction(`mutation-started`, newData);

    await sleep(setDataAt);

    serverDataHistory.push(newData);

    if (addServerDataChangeAction) {
      addAction(`server-data-changed`, newData);
    }

    onServerDataChange?.();

    addAction(`mutation-finished`, newData);

    await sleep(duration - setDataAt);
  }

  return {
    mutateData,
    setData(value: Data) {
      addAction(`server-data-changed`, value);
      serverDataHistory.push(value);
    },
    get current() {
      return serverDataHistory.at(-1)!;
    },
    history: serverDataHistory,
  };
}

function uiEmulator(initialData: Data, addAction: AddAction) {
  const uiHistory: Data[] = [initialData];

  function setUi(value: number | 'error', reason: 'optimistic' | 'fetch') {
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
    return Date.now() - initialTime;
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

  const dbReadAt = 0.62;

  let fetchId = 0;

  async function mockFetch(fetchCtx: FetchContext, ms: number) {
    fetchId++;

    const fetchIdLocal = fetchId;

    await sleep(ms * dbReadAt);

    const serverResponse = server.current;

    await sleep(ms * (1 - dbReadAt));

    numOfFetchs++;

    if (serverResponse === 'error') {
      addAction(`fetch-error : ${fetchIdLocal}`);
      ui.setUi('error', 'fetch');
      return false;
    }

    if (fetchCtx.shouldAbort()) {
      addAction(`fetch-aborted : ${fetchIdLocal}`);

      return false;
    }

    addAction(`fetch-finished : ${fetchIdLocal}`, serverResponse);
    ui.setUi(serverResponse, 'fetch');

    return true;
  }

  async function waitForNoPendingRequests(chekcInterval = 10) {
    while (
      fetchOrquestrator.hasPendingFetch ||
      fetchOrquestrator.mutationIsInProgress
    ) {
      await sleep(chekcInterval);
    }
  }

  const fetchOrquestrator = createFetchOrquestrator({
    fetchFn: mockFetch,
    on(event) {
      if (event === 'scheduled-fetch-started') {
        addAction(`scheduled-fetch-started : ${fetchId + 1}`);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      } else if (event === 'scheduled-rt-fetch-started') {
        addAction(`scheduled-rt-fetch-started : ${fetchId + 1}`);
      } else {
        addAction(event);
      }
    },
    dynamicRealtimeThrottleMs: getDynamicRealtimeThrottleMs,
  });

  /** default duration = 40 */
  function fetch(fetchType: FetchType, duration = 40) {
    const result = fetchOrquestrator.scheduleFetch(fetchType, duration);

    if (result === 'started') {
      addAction(`fetch-started : ${fetchId}`);
    }

    if (result === 'skipped') {
      addAction('fetch-skipped');
    }

    if (result === 'scheduled') {
      addAction('fetch-scheduled');
    }

    if (result === 'rt-scheduled') {
      addAction('rt-fetch-scheduled');
    }
  }

  async function emulateExternalRTU(newServerValue: number, duration = 40) {
    server.setData(newServerValue);

    await sleep(5);

    fetch('realtimeUpdate', duration);
  }

  return {
    ui,
    server,
    timeline(groupByTime = 10, startAt = 0): string {
      return getTimeline(actionsHistory, groupByTime, startAt);
    },
    get actions() {
      return getActions(actionsHistory);
    },
    fetch,
    get numOfFetchs() {
      return numOfFetchs;
    },
    mutateData: server.mutateData,
    optimisticUpdate(value: number) {
      ui.setUi(value, 'optimistic');
    },
    errorInNextFetch() {
      server.setData('error');
    },
    waitForNoPendingRequests,
    addAction,
    emulateExternalRTU,
    startMutation: fetchOrquestrator.startMutation,
  };
}

export type TestStore = ReturnType<typeof createTestStore>;

function getActions(
  actionsHistory: { action: string; time: number; value: Data | undefined }[],
) {
  let lastIdentation = '';

  return [
    '\n',
    actionsHistory
      .map(({ action, value }) => {
        if (value) {
          lastIdentation = stringFromLength(
            value === 'error' ? 0 : (value - 1) * 2,
          );

          return `${lastIdentation}${value} - ${action}`;
        } else {
          return `${lastIdentation}${action}`;
        }
      })
      .join('\n'),
    '\n',
  ].join('');
}

type Action = {
  action: string;
  time: number;
  value: Data | undefined;
};

function getTimeline(
  actionsHistory: Action[],
  groupByTime: number,
  startAt: number,
) {
  const timeline: string[] = [];
  let lastIdentation = '';
  let lastAction = '';

  const dividerText = '.';

  const actionsWithNormalizedTime: Action[] = [];

  actionsHistory.forEach((action) => {
    if (action.time < startAt) {
      return;
    }

    let time = action.time;

    time = time - (time % groupByTime);

    actionsWithNormalizedTime.push({
      ...action,
      time,
    });
  });

  for (const [{ action, time, value }, prev] of arrayWithPrev(
    actionsWithNormalizedTime,
  )) {
    if (prev) {
      const timeDiff = time - prev.time;

      if (timeDiff > 50) {
        timeline.push(dividerText);
      }
    }

    let actionText: string;

    if (value) {
      lastIdentation = stringFromLength(
        value === 'error' ? 0 : (value - 1) * 2,
      );

      actionText = `${lastIdentation}${value} - ${action}`;
    } else {
      actionText = `${lastIdentation}${action}`;
    }

    if (lastAction.startsWith(`${time}ms:`)) {
      lastAction = `${time}ms:--${actionText}`;
    } else {
      lastAction = `${time}ms: ${actionText}`;
    }

    timeline.push(lastAction);
  }

  const maxTimeLength = Math.max(
    ...timeline.map((action) =>
      action.includes(':') ? action.split(':')[0]!.length : 0,
    ),
  );

  const timelineWithBalancedStart = timeline.map((action) => {
    if (action.startsWith(dividerText)) {
      return `${stringFromLength(maxTimeLength)}-`;
    }

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
}

function stringFromLength(length: number, string = ' ') {
  return Array.from({ length })
    .map((_) => string)
    .join('');
}

function getDynamicRealtimeThrottleMs(lastDuration: number): number {
  if (lastDuration > 300) {
    return 300;
  }

  return 100;
}
