import { sleep } from '../../test-old/utils/sleep';

export function createServerMock<Data>(
  initialData: Data,
  listenForActions?: (
    action: 'mutation-started' | 'mutation-finished' | 'server-data-changed',
    data?: Data,
  ) => void,
) {
  const serverDataHistory: Data[] = [initialData];

  /** default duration: 1200ms */
  async function mutateData(
    newData: Data,
    {
      duration = 1200,
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
    listenForActions?.('mutation-started');

    await sleep(setDataAt);

    serverDataHistory.push(newData);

    if (addServerDataChangeAction) {
      listenForActions?.('server-data-changed', newData);
    }

    onServerDataChange?.();

    listenForActions?.('mutation-finished');

    await sleep(duration - setDataAt);
  }

  return {
    mutateData,
    setData(value: Data) {
      listenForActions?.('server-data-changed', value);
      serverDataHistory.push(value);
    },
    get current() {
      return serverDataHistory.at(-1)!;
    },
    history: serverDataHistory,
    fetch: async (duration = 1200) => {
      await sleep(duration);
      return serverDataHistory.at(-1)!;
    },
  };
}
