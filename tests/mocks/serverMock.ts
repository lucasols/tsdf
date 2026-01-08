import { notNullish } from '@ls-stack/utils/assertions';
import { evtmitter } from 'evtmitter';
import type { StoreError } from '../../src/storeShared';
import { sleep } from '../../test-old/utils/sleep';
import { FetchError } from './testEnvUtils';

export const DEFAULT_FETCH_DURATION_MS = 800;
export const DEFAULT_MUTATION_DURATION_MS = 1200;
export const DEFAULT_RTU_DELAY_MS = 50;

export type FetchErrorConfig = {
  message: string;
  path?: string;
  method?: StoreError['method'];
  code?: number;
};

const fetchEmojis = ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚫', '⚪'];

export type AddActionFn = (
  action: string,
  options?: { id?: string | number; actionValue?: unknown },
) => void;

export function createServerMock<Data>(
  initialData: Data,
  addAction?: AddActionFn,
) {
  const serverDataHistory: Data[] = [initialData];
  const wsEvents = evtmitter<{ data_changed: undefined }>();
  const customFetchDurations: number[] = [];
  let nextFetchError: FetchErrorConfig | null = null;

  // Fetch tracking state
  let numOfStartedFetches = 0;
  let numOfFinishedFetches = 0;
  let fetchIdCounter = 0;

  function getFetchId() {
    return notNullish(fetchEmojis[fetchIdCounter++ % fetchEmojis.length]);
  }

  /** default duration: 1200ms */
  async function mutateData(
    newData: Data,
    {
      duration = DEFAULT_MUTATION_DURATION_MS,
      setDataAt = duration * 0.7,
      triggerRTUEvent,
      addServerDataChangeAction,
      mutationId,
      addMutationResolvedAction,
    }: {
      duration?: number;
      setDataAt?: number;
      triggerRTUEvent?: boolean;
      addServerDataChangeAction?: boolean;
      addMutationResolvedAction?: boolean;
      mutationId?: string | number;
    } = {},
  ) {
    addAction?.('>mutation-started', { actionValue: newData, id: mutationId });

    await sleep(setDataAt);

    serverDataHistory.push(newData);

    if (addServerDataChangeAction) {
      addAction?.('server-data-changed', { actionValue: newData });
    }

    if (triggerRTUEvent) {
      void sleep(DEFAULT_RTU_DELAY_MS).then(() => {
        wsEvents.emit('data_changed', undefined);
      });
    }

    // "mutation-finished" marks when server data is applied (setDataAt), not promise resolution.
    addAction?.('<mutation-data-persisted', {
      actionValue: newData,
      id: mutationId,
    });

    await sleep(duration - setDataAt);

    if (addMutationResolvedAction) {
      addAction?.('<mutation-resolved', {
        actionValue: newData,
        id: mutationId,
      });
    }
  }

  return {
    mutateData,
    wsEvents,
    setData(value: Data) {
      addAction?.('server-data-changed', { actionValue: value });
      serverDataHistory.push(value);
    },
    get current(): Data {
      const last = serverDataHistory.at(-1);
      if (last === undefined) {
        throw new Error('Server data history is empty');
      }
      return last;
    },
    history: serverDataHistory,
    fetch: async (
      signal?: AbortSignal,
      duration = DEFAULT_FETCH_DURATION_MS,
    ): Promise<Data> => {
      const fetchId = addAction ? getFetchId() : undefined;

      if (addAction) {
        addAction('>fetch-started', { id: fetchId });
        numOfStartedFetches++;
      }

      let abortLogged = false;
      function onAbort() {
        if (!addAction || abortLogged) return;
        abortLogged = true;
        addAction('<fetch-aborted 🚫', { id: fetchId });
      }
      signal?.addEventListener('abort', onAbort);

      // Check for scheduled error first (simulates immediate request failure)
      if (nextFetchError) {
        signal?.removeEventListener('abort', onAbort);
        if (addAction) {
          numOfFinishedFetches++;
          addAction('<fetch-error', { actionValue: 'error', id: fetchId });
        }

        const errorConfig = nextFetchError;
        nextFetchError = null;

        if (errorConfig.path) {
          throw new FetchError(errorConfig.message, {
            path: errorConfig.path,
            method: errorConfig.method,
            code: errorConfig.code,
          });
        }
        throw new Error(errorConfig.message);
      }

      const actualDuration = customFetchDurations.shift() ?? duration;
      await sleep(actualDuration);

      signal?.removeEventListener('abort', onAbort);

      // Check for abort after network delay
      if (signal?.aborted) {
        onAbort();
        // Note: Don't increment numOfFinishedFetches for aborted fetches
        // to match test expectations (only successful fetches count)
        throw new Error('Aborted');
      }

      const last = serverDataHistory.at(-1);
      if (last === undefined) {
        throw new Error('Server data history is empty');
      }

      if (addAction) {
        numOfFinishedFetches++;
        addAction('<fetch-finished', { actionValue: last, id: fetchId });
      }

      return last;
    },
    setFetchDurations(...durations: number[]) {
      customFetchDurations.push(...durations);
    },
    setNextFetchError(error: FetchErrorConfig | string) {
      nextFetchError = typeof error === 'string' ? { message: error } : error;
    },
    get numOfStartedFetches() {
      return numOfStartedFetches;
    },
    get numOfFinishedFetches() {
      return numOfFinishedFetches;
    },
  };
}
