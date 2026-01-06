import { createDocumentStore } from '../../src/documentStore';
import type { FetchType } from '../../src/requestScheduler';
import { createServerMock } from './serverMock';

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
    dynamicRealtimeThrottleMs = getDynamicRealtimeThrottleMs,
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
    actionsHistory.push({
      action,
      time,
      uiValue,
      actionValue: actionValue,
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
    fetchFn: async (signal) => {
      const fetchId = `F#${++fetchIdCounter}`;
      addAction(`fetch-started`, { id: fetchId });

      numOfStartedFetches++;

      if (nextFetchError) {
        numOfFetches++;
        const error = nextFetchError;
        nextFetchError = null;
        addAction(`fetch-error`, { actionValue: 'error', id: fetchId });
        throw new Error(error);
      }

      const value = await serverMock.fetch();

      if (signal.aborted) {
        addAction(`fetch-aborted`, { id: fetchId });
        throw new Error('Aborted');
      }

      numOfFetches++;
      addAction(`fetch-finished`, { actionValue: value, id: fetchId });
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
      if (event === 'scheduled-rt-fetch-started') {
        addAction('scheduled-rt-fetch-started', { id: `F#${fetchIdCounter + 1}` });
      }
    },
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
    addTimelineComment: (comment: string) => {
      addAction(`-- ${comment}`);
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
        addServerDataChangeAction,
      }: {
        withRevalidation?: boolean;
        withOptimisticUpdate?: boolean;
        duration?: number;
        triggerRTU?: boolean;
        addServerDataChangeAction?: boolean;
      } = {},
    ) => {
      const mutationId = `M#${++mutationIdCounter}`;

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
      serverMock.setData('error' as D);
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

function formatTime(ms: number, prevMs: number | undefined): string {
  if (prevMs !== undefined && ms === prevMs) return '.';
  if (ms === 0) return '0';
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatId(id: string | number | undefined): string {
  if (id === undefined) return '';
  return `${id} `;
}

function getTimelineString(actionsHistory: Action[]): string {
  if (actionsHistory.length === 0) return '\n\n';

  let currentUI: unknown = undefined;
  let prevTime: number | undefined = undefined;

  const rows: Array<{ cols: string[] }> = [{ cols: ['time', 'ui', ''] }];

  for (const { action, time, uiValue, actionValue, id } of actionsHistory) {
    if (uiValue !== undefined) currentUI = uiValue;

    const timeStr = formatTime(time, prevTime);
    const uiStr = currentUI !== undefined ? String(currentUI) : '-';

    const idStr = formatId(id);
    let actionStr = `${idStr}${action}`;
    if (actionValue !== undefined && action.includes('fetch-finished')) {
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
    cols.forEach((col, i) => {
      colWidths[i] = Math.max(colWidths[i] ?? 0, col.length);
    });
  }

  return rows
    .map(({ cols, separator = '|' }) =>
      cols
        .map((col, i) => col.padEnd(colWidths[i] ?? 0))
        .join(` ${separator} `),
    )
    .join('\n');
}

function getDynamicRealtimeThrottleMs(lastDuration: number): number {
  if (lastDuration > 300) {
    return 300;
  }

  return 100;
}
