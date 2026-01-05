import { evtmitter } from 'evtmitter';
import { sleep } from '../../test-old/utils/sleep';

export function createServerMock<Data>(
  initialData: Data,
  listenForActions?: (
    action: 'mutation-started' | 'mutation-finished' | 'server-data-changed',
    data?: Data,
  ) => void,
) {
  const serverDataHistory: Data[] = [initialData];
  const wsEvents = evtmitter<{ data_changed: undefined }>();
  const customFetchDurations: number[] = [];

  /** default duration: 1200ms */
  async function mutateData(
    newData: Data,
    {
      duration = 1200,
      setDataAt = duration * 0.7,
      triggerRTUEvent,
      addServerDataChangeAction,
    }: {
      duration?: number;
      setDataAt?: number;
      triggerRTUEvent?: boolean;
      addServerDataChangeAction?: boolean;
    } = {},
  ) {
    listenForActions?.('mutation-started', newData);

    await sleep(setDataAt);

    serverDataHistory.push(newData);

    if (addServerDataChangeAction) {
      listenForActions?.('server-data-changed', newData);
    }

    if (triggerRTUEvent) {
      sleep(100).then(() => {
        wsEvents.emit('data_changed', undefined);
      });
    }

    listenForActions?.('mutation-finished', newData);

    await sleep(duration - setDataAt);
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
    fetch: async (duration = 1200) => {
      const actualDuration = customFetchDurations.shift() ?? duration;
      await sleep(actualDuration);
      return serverDataHistory.at(-1)!;
    },
    setFetchDurations(...durations: number[]) {
      customFetchDurations.push(...durations);
    },
  };
}
