import { createDocumentStore } from '../../src/documentStore';
import type { FetchType } from '../../src/requestScheduler';
import { arrayWithPrev } from '../../test-old/utils/arrayUtils';
import { createServerMock } from './serverMock';

type Action = {
  action: string;
  time: number;
  value: any;
};

export function createDocumentStoreTestEnv<D>(
  serverInitialData: D,
  {
    forceInitialDataInvalidation,
    dynamicRealtimeThrottleMs,
  }: {
    forceInitialDataInvalidation?: boolean;
    dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  } = {},
) {
  const actionsHistory: Action[] = [];
  let numOfFetches = 0;
  let numOfStartedFetches = 0;
  let fetchIdCounter = 0;
  let nextFetchError: string | null = null;

  const uiChanges: (number | undefined)[] = [];
  let lastTrackedValue: number | undefined;

  const initialTime = Date.now();

  function getRelativeTime() {
    return Date.now() - initialTime;
  }

  function addAction(action: string, value?: unknown) {
    actionsHistory.push({
      action,
      time: getRelativeTime(),
      value,
    });
  }

  const serverMock = createServerMock<D>(serverInitialData, addAction);

  const documentStore = createDocumentStore<{ value: D }, { error: string }>({
    errorNormalizer(exception) {
      return { error: exception.message };
    },
    fetchFn: async (signal) => {
      const fetchId = ++fetchIdCounter;
      addAction(`fetch-started #${fetchId}`);

      numOfStartedFetches++;

      if (nextFetchError) {
        numOfFetches++;
        const error = nextFetchError;
        nextFetchError = null;
        addAction(`fetch-error #${fetchId}`, 'error');
        throw new Error(error);
      }

      const value = await serverMock.fetch();

      if (signal.aborted) {
        addAction(`fetch-aborted #${fetchId}`);
        throw new Error('Aborted');
      }

      numOfFetches++;
      addAction(`fetch-finished #${fetchId}`, value);
      return { value };
    },
    disableInitialDataInvalidation: !forceInitialDataInvalidation,
    getInitialData:
      !forceInitialDataInvalidation ?
        () => ({ value: serverInitialData })
      : undefined,
    disableRefetchOnMount: !forceInitialDataInvalidation,
    dynamicRealtimeThrottleMs,
  });

  serverMock.wsEvents.on('data_changed', () => {
    documentStore.invalidateData('realtimeUpdate');
  });

  return {
    useDocument: documentStore.useDocument,
    get numOfFinishedFetches() {
      return numOfFetches;
    },
    get numOfStartedFetches() {
      return numOfStartedFetches;
    },
    get uiChanges() {
      return uiChanges;
    },
    trackUIChanges: (value: number | undefined) => {
      if (value !== lastTrackedValue) {
        lastTrackedValue = value;
        uiChanges.push(value);

        if (value !== undefined) {
          addAction(
            uiChanges.length === 1 ? 'ui-initialized' : 'ui-changed',
            value,
          );
        }
      }
    },
    scheduleFetch: (fetchType: FetchType) => {
      const result = documentStore.scheduleFetch(fetchType);

      if (result === 'skipped') {
        addAction('fetch-skipped');
      }

      if (result === 'scheduled') {
        addAction('fetch-scheduled');
      }

      if (result === 'rt-scheduled') {
        addAction('rt-fetch-scheduled');
      }

      return result;
    },
    /** default duration: 1200ms */
    performClientUpdateAction: (
      newValue: D,
      {
        withRevalidation,
        withOptimisticUpdate,
        duration,
        triggerRTU,
      }: {
        withRevalidation?: boolean;
        withOptimisticUpdate?: boolean;
        duration?: number;
        triggerRTU?: boolean;
      } = {},
    ) => {
      return documentStore.performMutation({
        optimisticUpdate:
          withOptimisticUpdate ?
            () => {
              documentStore.updateState((draft) => {
                draft.value = newValue;
              });
              addAction('optimistic-ui-commit', newValue);
            }
          : undefined,
        mutation: async () => {
          return {
            value: await serverMock.mutateData(newValue, {
              duration,
              triggerRTUEvent: triggerRTU,
            }),
          };
        },
        revalidateOnSuccess: withRevalidation,
      });
    },
    get actionsString() {
      return getActionsString(actionsHistory);
    },
    timeline(groupByTime = 10, startAt = 0): string {
      return getTimelineString(actionsHistory, groupByTime, startAt);
    },
    get serverHistory() {
      return serverMock.history;
    },
    errorInNextFetch(error = 'Fetch error') {
      nextFetchError = error;
    },
    setNextFetchDurations(...durations: number[]) {
      serverMock.setFetchDurations(...durations);
    },
    emulateExternalRTU(value: D, fetchDuration?: number) {
      serverMock.setData(value);

      if (fetchDuration !== undefined) {
        serverMock.setFetchDurations(fetchDuration);
      }

      serverMock.wsEvents.emit('data_changed', undefined);
    },
  };
}

function getActionsString(actionsHistory: Action[]) {
  let lastIndentation = '';

  return [
    '\n',
    actionsHistory
      .map(({ action, value }) => {
        if (value !== undefined) {
          lastIndentation = stringFromLength(
            value === 'error' ? 0 : (value - 1) * 2,
          );

          return `${lastIndentation}${typeof value === 'object' ? JSON.stringify(value) : value} - ${action}`;
        } else {
          return `${lastIndentation}${action}`;
        }
      })
      .join('\n'),
    '\n',
  ].join('');
}

function stringFromLength(length: number, string = ' ') {
  return Array.from({ length })
    .map((_) => string)
    .join('');
}

function getTimelineString(
  actionsHistory: Action[],
  groupByTime: number,
  startAt: number,
) {
  const timeline: string[] = [];
  let lastIndentation = '';
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
      lastIndentation = stringFromLength(
        value === 'error' ? 0 : (value - 1) * 2,
      );

      actionText = `${lastIndentation}${value} - ${action}`;
    } else {
      actionText = `${lastIndentation}${action}`;
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
