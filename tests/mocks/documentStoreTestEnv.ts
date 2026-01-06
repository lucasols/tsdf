import { createDocumentStore } from '../../src/documentStore';
import type { FetchType } from '../../src/requestScheduler';
import { createServerMock } from './serverMock';

const fetchEmojis = ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚫', '⚪'];
const mutationEmojis = ['⬜', '⬛', '🟫', '🟪', '🟦', '🟩', '🟨', '🟧', '🟥'];

type Action = {
  action: string;
  time: number;
  uiValue: unknown;
  actionValue?: unknown;
  id?: string | number;
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
  let mutationIdCounter = 0;

  function getFetchEmoji() {
    return fetchEmojis[fetchIdCounter++ % fetchEmojis.length];
  }

  function getMutationEmoji() {
    return mutationEmojis[mutationIdCounter++ % mutationEmojis.length];
  }
  let nextFetchError: string | null = null;

  const uiChanges: (number | 'error' | undefined)[] = [];
  let lastTrackedValue: number | 'error' | undefined;

  const initialTime = Date.now();

  function getRelativeTime() {
    return Date.now() - initialTime;
  }

  function addAction(
    action: string,
    {
      uiValue,
      actionValue,
      time = getRelativeTime(),
      id,
    }: {
      uiValue?: unknown;
      actionValue?: unknown;
      time?: number;
      id?: string | number;
    } = {},
  ) {
    if (action === 'scheduled-fetch-started') {
      const relatedFetchStartAction = actionsHistory.find(
        (a) => a.action === '>fetch-started' && time === a.time,
      );

      if (relatedFetchStartAction) {
        relatedFetchStartAction.action =
          '>fetch-started-from-manual-scheduling';
        return;
      }
    }

    actionsHistory.push({
      action,
      time,
      uiValue,
      actionValue,
      id,
    });
  }

  const serverMock = createServerMock<D>(
    serverInitialData,
    (action, data, id) => {
      addAction(action, {
        actionValue: data,
        id,
      });
    },
  );

  const documentStore = createDocumentStore<{ value: D }, { error: string }>({
    errorNormalizer(exception) {
      return { error: exception.message };
    },
    lowPriorityThrottleMs: 200,
    mediumPriorityThrottleMs: 10,
    fetchFn: async (signal) => {
      const fetchId = getFetchEmoji();
      addAction(`>fetch-started`, { id: fetchId });

      numOfStartedFetches++;

      if (nextFetchError) {
        numOfFetches++;
        const error = nextFetchError;
        nextFetchError = null;
        addAction(`<fetch-error`, { actionValue: 'error', id: fetchId });
        throw new Error(error);
      }

      const value = await serverMock.fetch();

      if (signal.aborted) {
        addAction(`<fetch-aborted 🚫`, { id: fetchId });
        throw new Error('Aborted');
      }

      numOfFetches++;
      addAction(`<fetch-finished`, { actionValue: value, id: fetchId });
      return { value };
    },
    disableInitialDataInvalidation: !forceInitialDataInvalidation,
    getInitialData:
      !forceInitialDataInvalidation ?
        () => ({ value: serverInitialData })
      : undefined,
    disableRefetchOnMount: !forceInitialDataInvalidation,
    dynamicRealtimeThrottleMs,
    onSchedulerEvent: (event) => {
      switch (event) {
        case 'scheduled-rt-fetch-started':
          addAction('scheduled-rt-fetch-started');
          break;
      }
    },
  });

  serverMock.wsEvents.on('data_changed', () => {
    addAction('received-ws-data-change-event');
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
    get actions() {
      return actionsHistory;
    },
    trackUIChanges: (value: number | 'error' | undefined) => {
      if (value !== lastTrackedValue) {
        lastTrackedValue = value;
        uiChanges.push(value);

        if (value !== undefined) {
          const time = getRelativeTime();
          if (
            actionsHistory.some(
              (action) =>
                action.action === 'optimistic-ui-commit'
                && action.time === time
                && action.uiValue === value,
            )
          ) {
            return;
          }

          addAction(uiChanges.length === 1 ? 'ui-initialized' : 'ui-changed', {
            uiValue: value,
          });
        }
      }
    },
    addTimelineComment: (
      comment: string,
      time?: number | `+${number}` | `-${number}`,
    ) => {
      let resolvedTime: number;
      if (time === undefined) {
        resolvedTime = getRelativeTime();
      } else if (typeof time === 'string') {
        resolvedTime = getRelativeTime() + parseInt(time, 10);
      } else {
        resolvedTime = time;
      }
      addAction(`-- ${comment}`, { time: resolvedTime });
    },
    scheduleFetch: (fetchType: FetchType) => {
      const result = documentStore.scheduleFetch(fetchType);

      switch (result) {
        case 'started':
          addAction('scheduled-fetch-started');
          break;
        case 'skipped':
          addAction('scheduled-fetch-skipped');
          break;
        case 'scheduled':
          addAction('scheduled-fetch-scheduled');
          break;
        case 'rt-scheduled':
          addAction('rt-fetch-scheduled');
          break;
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
        addServerDataChangeAction,
      }: {
        withRevalidation?: boolean;
        withOptimisticUpdate?: boolean;
        duration?: number;
        triggerRTU?: boolean;
        addServerDataChangeAction?: boolean;
      } = {},
    ) => {
      const mutationId = getMutationEmoji();

      return documentStore.performMutation({
        optimisticUpdate:
          withOptimisticUpdate ?
            () => {
              documentStore.updateState((draft) => {
                draft.value = newValue;
              });
              addAction('optimistic-ui-commit', {
                uiValue: newValue,
                id: mutationId,
              });
            }
          : undefined,
        mutation: async () => {
          return {
            value: await serverMock.mutateData(newValue, {
              duration,
              triggerRTUEvent: triggerRTU,
              addServerDataChangeAction,
              mutationId,
            }),
          };
        },
        revalidateOnSuccess: withRevalidation,
      });
    },
    get timelineString() {
      return getTimelineString(actionsHistory);
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

const secondsFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
});

function formatTime(ms: number, prevMs: number | undefined): string {
  if (prevMs !== undefined && ms === prevMs) return '.';
  if (ms === 0) return '0';
  if (ms >= 1000) return `${secondsFormatter.format(ms / 1000)}s`;
  return `${ms}ms`;
}

function formatId(id: string | number | undefined): string {
  if (id === undefined) return '';
  return `${id} `;
}

function getTimelineString(actionsHistory: Action[]): string {
  if (actionsHistory.length === 0) return '\n\n';

  // Sort actions by time, preserving insertion order for same-time events
  const sortedActions = [...actionsHistory].sort((a, b) => a.time - b.time);

  let currentUI: unknown = undefined;
  let prevTime: number | undefined = undefined;

  const rows: Array<{ cols: string[] }> = [{ cols: ['time', 'ui', ''] }];

  for (const { action, time, uiValue, actionValue, id } of sortedActions) {
    if (uiValue !== undefined) currentUI = uiValue;

    const timeStr = formatTime(time, prevTime);
    const uiStr = currentUI !== undefined ? JSON.stringify(currentUI) : '-';

    const idStr = formatId(id);
    let actionStr = `${idStr}${action}`;
    if (actionValue !== undefined) {
      actionStr += ` (value: ${JSON.stringify(actionValue)})`;
    }

    rows.push({ cols: [timeStr, uiStr, actionStr] });
    prevTime = time;
  }

  return ['\n', formatTableString(rows), '\n'].join('');
}

function formatTableString(
  rows: Array<{ cols: string[]; separator?: string }>,
): string {
  if (rows.length === 0) return '';

  const colWidths: number[] = [];
  for (const { cols } of rows) {
    for (const [i, col] of cols.entries()) {
      colWidths[i] = Math.max(colWidths[i] ?? 0, col.length);
    }
  }

  return rows
    .map(({ cols, separator = '|' }) =>
      cols
        .map((col, i) => col.padEnd(colWidths[i] ?? 0))
        .join(` ${separator} `)
        .trimEnd(),
    )
    .join('\n');
}
