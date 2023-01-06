import { randomInt } from '../utils/math';
import { sleep } from '../utils/sleep';

export function mockServerResource<Data, S = Data>({
  initialData,
  randomTimeout,
  logFetchs,
  fetchSelector = (data) => data as unknown as S,
}: {
  initialData: Data;
  logFetchs?: boolean;
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
  let waitNextFetchCompleteCall = 0;

  let startTime = Date.now();

  function reset() {
    data = initialData;
    timeout = randomTimeout ? [30, 100] : 30;
    lastTimeout = timeout;
    lastTimeoutMs = 0;
    error = null;
    numOfFetchs = 0;
    startTime = Date.now();
    waitNextFetchCompleteCall = 0;
  }

  let onFetchComplete: (() => void) | null = null;

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

    if (logFetchs) {
      // eslint-disable-next-line no-console
      console.log(
        `${numOfFetchs} - fetch${params ? ` ${params}` : ''} - started ${
          Date.now() - startTime
        }ms - duration: ${timeoutToUse}ms`,
      );
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

    if (onFetchComplete) {
      onFetchComplete();
      onFetchComplete = null;
    }

    return response;
  }

  async function fetchWitoutSelector() {
    return fetch('');
  }

  function mutateData(newData: Partial<Data>) {
    data = { ...data, ...newData };
  }

  function setFetchDuration(newTimeout: typeof timeout) {
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

  async function waitNextFetchComplete(extraWait = 0, maxWait = 500) {
    waitNextFetchCompleteCall++;

    const currentWaitNextFetchCompleteCall = waitNextFetchCompleteCall;

    if (onFetchComplete) {
      return;
    }

    const errorObj = new Error(
      `Wait for next fetch complete ${currentWaitNextFetchCompleteCall} timeout`,
    );

    return new Promise<true>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        onFetchComplete = null;
        reject(errorObj);
      }, maxWait);

      onFetchComplete = () => {
        clearTimeout(timeoutId);

        setTimeout(() => {
          resolve(true);
        }, 10 + extraWait);
      };
    });
  }

  return {
    fetch,
    mutateData,
    fetchWitoutSelector,
    waitNextFetchComplete,
    setFetchDuration,
    get data() {
      return data;
    },
    reset,
    trhowErrorInNextFetch,
    emulateMutation,
    undoTimeoutChange,
    get numOfFetchs() {
      return numOfFetchs;
    },
    get fetchDuration() {
      return lastTimeoutMs;
    },
    relativeTime() {
      return Date.now() - startTime;
    },
    numOfFetchsFromHere() {
      const currentNumOfFetchs = numOfFetchs;
      return () => numOfFetchs - currentNumOfFetchs;
    },
  };
}

export type ServerMock<Data> = ReturnType<typeof mockServerResource<Data>>;
