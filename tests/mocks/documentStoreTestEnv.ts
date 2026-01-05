import { createDocumentStore } from '../../src/documentStore';
import type { FetchType } from '../../src/requestScheduler';
import { arrayWithPrev } from '../../test-old/utils/arrayUtils';
import { createServerMock } from './serverMock';

type Action = {
  action: string;
  time: number;
  value: number | 'error' | undefined;
};

export function createDocumentStoreTestEnv(
  serverInitialData: number,
  {
    forceInitialDataInvalidation,
  }: { forceInitialDataInvalidation?: boolean } = {},
) {
  const actionsHistory: Action[] = [];
  let numOfFetches = 0;
  let fetchIdCounter = 0;

  const initialTime = Date.now();

  function getRelativeTime() {
    return Date.now() - initialTime;
  }

  function addAction(action: string, value?: number) {
    actionsHistory.push({
      action,
      time: getRelativeTime(),
      value,
    });
  }

  const serverMock = createServerMock<number>(serverInitialData, addAction);

  const documentStore = createDocumentStore<
    { value: number },
    { error: string }
  >({
    errorNormalizer(exception) {
      return { error: exception.message };
    },
    fetchFn: async () => {
      const fetchId = ++fetchIdCounter;
      addAction(`fetch-started #${fetchId}`);
      const value = await serverMock.fetch();
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
  });

  serverMock.wsEvents.on('data_changed', () => {
    documentStore.invalidateData('realtimeUpdate');
  });

  return {
    useDocument: documentStore.useDocument,
    get numOfFetches() {
      return numOfFetches;
    },
    scheduleFetch: (fetchType: FetchType) => {
      const result = documentStore.scheduleFetch(fetchType);

      if (result === 'skipped') {
        addAction('fetch-skipped');
      }

      if (result === 'rt-scheduled') {
        addAction('rt-fetch-scheduled');
      }
    },
    performClientUpdateAction: (
      newValue: number,
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
  };
}

function getActionsString(actionsHistory: Action[]) {
  let lastIndentation = '';

  return [
    '\n',
    actionsHistory
      .map(({ action, value }) => {
        if (value) {
          lastIndentation = stringFromLength(
            value === 'error' ? 0 : (value - 1) * 2,
          );

          return `${lastIndentation}${value} - ${action}`;
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
