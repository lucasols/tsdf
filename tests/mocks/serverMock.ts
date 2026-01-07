import { evtmitter } from 'evtmitter';
import { sleep } from '../../test-old/utils/sleep';

export const DEFAULT_FETCH_DURATION_MS = 800;
export const DEFAULT_MUTATION_DURATION_MS = 1200;
export const DEFAULT_RTU_DELAY_MS = 50;

export function createServerMock<Data>(
  initialData: Data,
  listenForActions?: (
    action: string,
    data?: Data,
    id?: string | number,
  ) => void,
) {
  const serverDataHistory: Data[] = [initialData];
  const wsEvents = evtmitter<{ data_changed: undefined }>();
  const customFetchDurations: number[] = [];

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
    listenForActions?.('>mutation-started', newData, mutationId);

    await sleep(setDataAt);

    serverDataHistory.push(newData);

    if (addServerDataChangeAction) {
      listenForActions?.('server-data-changed', newData);
    }

    if (triggerRTUEvent) {
      void sleep(DEFAULT_RTU_DELAY_MS).then(() => {
        wsEvents.emit('data_changed', undefined);
      });
    }

    // "mutation-finished" marks when server data is applied (setDataAt), not promise resolution.
    listenForActions?.('<mutation-data-persisted', newData, mutationId);

    await sleep(duration - setDataAt);

    if (addMutationResolvedAction) {
      listenForActions?.('<mutation-resolved', newData, mutationId);
    }
  }

  return {
    mutateData,
    wsEvents,
    setData(value: Data) {
      listenForActions?.('server-data-changed', value);
      serverDataHistory.push(value);
    },
    get current() {
      return serverDataHistory.at(-1)!;
    },
    history: serverDataHistory,
    fetch: async (duration = DEFAULT_FETCH_DURATION_MS) => {
      const actualDuration = customFetchDurations.shift() ?? duration;
      await sleep(actualDuration);
      return serverDataHistory.at(-1)!;
    },
    setFetchDurations(...durations: number[]) {
      customFetchDurations.push(...durations);
    },
  };
}
