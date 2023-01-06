import { randomInt } from '../utils/math';
import { sleep } from '../utils/sleep';

export function mockServerResource<Data, S = Data>({
  initialData,
  randomTimeout,
  fetchSelector = (data) => data as unknown as S,
}: {
  initialData: Data;
  randomTimeout?: [number, number] | true;
  fetchSelector?: (data: Data | null, params: string) => S;
}) {
  type Timeout = number | [number, number] | ((param: string) => number);

  let data = initialData;
  let timeout: Timeout = randomTimeout ? [30, 100] : 30;
  let lastTimeout: Timeout = timeout;
  let lastTimeoutMs = 0;
  let error: Error | string | null = null;
  let numOfFetchs = 0;

  const dbReadAt = 0.62;

  async function fetch(params: string): Promise<S> {
    let timeoutToUse = 0;

    if (Array.isArray(timeout)) {
      timeoutToUse = randomInt(timeout[0], timeout[1]);
    } else if (typeof timeout === 'function') {
      timeoutToUse = timeout(params);
    } else {
      timeoutToUse = timeout;
    }

    lastTimeoutMs = timeoutToUse;

    numOfFetchs += 1;

    await sleep(timeoutToUse * dbReadAt);

    if (error) {
      throw typeof error === 'string' ? new Error(error) : error;
    }

    const response = fetchSelector(data, params);

    await sleep(timeoutToUse * (1 - dbReadAt));

    if (!response) {
      throw new Error('No data');
    }

    return response;
  }

  async function fetchWitoutSelector() {
    return fetch('');
  }

  function mutateData(newData: Partial<Data>) {
    data = { ...data, ...newData };
  }

  function setTimeout(newTimeout: typeof timeout) {
    lastTimeout = timeout;
    timeout = newTimeout;
  }

  function undoTimeoutChange() {
    timeout = lastTimeout;
  }

  function trhowErrorInNextFetch(newError: Error | string) {
    error = newError;
  }

  async function emulateMutation(
    newData: Partial<Data>,
    {
      duration = 60,
      setDataAt = duration * 0.7,
      triggerRTU,
      emulateError,
    }: {
      duration?: number;
      setDataAt?: number;
      triggerRTU?: boolean;
      emulateError?: Error | string;
    } = {},
  ) {
    await sleep(setDataAt);

    if (emulateError) {
      throw typeof emulateError === 'string'
        ? new Error(emulateError)
        : emulateError;
    }

    if (!data) {
      throw new Error('No data');
    }

    data = { ...data, ...newData };

    await sleep(duration - setDataAt);

    return data;
  }

  return {
    fetch,
    mutateData,
    fetchWitoutSelector,
    setTimeout,
    trhowErrorInNextFetch,
    emulateMutation,
    undoTimeoutChange,
    get numOfFetchs() {
      return numOfFetchs;
    },
    get timeout() {
      return lastTimeoutMs;
    },
    numOfFetchsFromHere() {
      const currentNumOfFetchs = numOfFetchs;
      return () => numOfFetchs - currentNumOfFetchs;
    },
  };
}

export type ServerMock<Data> = ReturnType<typeof mockServerResource<Data>>;
