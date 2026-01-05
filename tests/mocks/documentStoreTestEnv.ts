import { sleep } from '@ls-stack/utils/sleep';
import { createDocumentStore } from '../../src/documentStore';
import { createServerMock } from './serverMock';

export function createDocumentStoreTestEnv(serverInitialData: number) {
  const actionsHistory: {
    action: string;
    time: number;
    value: number | undefined;
  }[] = [];
  let numOfFetches = 0;

  const initialTime = Date.now();

  function getRelativeTime() {
    return Date.now() - initialTime;
  }

  const serverMock = createServerMock<number>(
    serverInitialData,
    (action, value) => {
      actionsHistory.push({
        action,
        time: getRelativeTime(),
        value,
      });
    },
  );

  const documentStore = createDocumentStore<
    { value: number },
    { error: string }
  >({
    errorNormalizer(exception) {
      return { error: exception.message };
    },
    fetchFn: async () => {
      const value = await serverMock.fetch();
      numOfFetches++;
      return { value };
    },
  });

  const storeHistory: number[] = [];
  const storeHistoryWithActions: {
    value: number;
    action: string | { type: string };
  }[] = [];

  documentStore.store.subscribe(({ current, action }) => {
    if (current.data) {
      storeHistory.push(current.data.value);
      actionsHistory.push({
        action: 'fetch-ui-commit',
        time: getRelativeTime(),
        value: current.data.value,
      });
    }
    if (action) {
      storeHistoryWithActions.push({
        value: current.data?.value ?? 0,
        action: action,
      });
    }
  });

  return {
    storeHistory,
    storeHistoryWithActions,
    get numOfFetches() {
      return numOfFetches;
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
            }
          : undefined,
        mutation: async () => {
          return {
            value: await serverMock.mutateData(newValue, {
              duration,
              onServerDataChange:
                triggerRTU ?
                  async () => {
                    await sleep(20);

                    documentStore.invalidateData('realtimeUpdate');
                  }
                : undefined,
            }),
          };
        },
        revalidateOnSuccess: withRevalidation,
      });
    },
    get actions() {
      return getActions(actionsHistory);
    },
  };
}

function getActions(
  actionsHistory: { action: string; time: number; value: number | undefined }[],
) {
  let lastIndentation = '';

  return [
    '\n',
    actionsHistory
      .map(({ action, value }) => {
        if (value) {
          lastIndentation = stringFromLength(
            typeof value !== 'number' ? 0 : (value - 1) * 2,
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
