/* eslint-disable @typescript-eslint/ban-types */
import { produce } from 'immer';
import { randomInt } from '../utils/math';
import { sleep } from '../utils/sleep';
import { simplifyArraySnapshot } from '../utils/storeUtils';

export function mockServerResource<Data, S = Data>({
  initialData,
  randomTimeout,
  logFetchs,
  fetchSelector = (data) => data as unknown as S,
}: {
  initialData: Data;
  logFetchs?: boolean;
  randomTimeout?: [number, number] | true;
  fetchSelector?: (data: Data | null, params: string) => S | 'notFound';
}) {
  type Timeout = number | [number, number] | ((param: string) => number);

  let data = initialData;
  let timeout: Timeout = randomTimeout ? [30, 100] : 30;
  let lastTimeout: Timeout = timeout;
  let lastTimeoutMs = 0;
  let error: Error | string | null = null;
  let numOfFetchs = 0;
  let waitNextFetchCompleteCall = 0;
  let onUpdateServerData:
    | ((prevAndData: { prev: Data; data: Data }) => void)
    | null = null;
  let fetchs: {
    result?: Data;
    error?: string;
    time: { start: number; end: number };
    params: string;
    started: number;
    duration: number;
  }[] = [];

  let startTime = Date.now();

  function reset() {
    data = initialData;
    timeout = randomTimeout ? [30, 100] : 30;
    lastTimeout = timeout;
    lastTimeoutMs = 0;
    fetchs = [];
    error = null;
    numOfFetchs = 0;
    startTime = Date.now();
    onUpdateServerData = null;
    waitNextFetchCompleteCall = 0;
  }

  const dbReadAt = 0.62;

  const fetchsInProgress = new Set<symbol>();

  async function fetch(params: string): Promise<S> {
    const fetchStartTime = Date.now() - startTime;
    const fetchId = Symbol();

    fetchsInProgress.add(fetchId);

    let duration = 0;

    if (Array.isArray(timeout)) {
      duration = randomInt(timeout[0], timeout[1]);
    } else if (typeof timeout === 'function') {
      duration = timeout(params);
    } else {
      duration = timeout;
    }

    if (logFetchs) {
      // eslint-disable-next-line no-console
      console.log(
        `${numOfFetchs} - fetch${params ? ` ${params}` : ''} - started ${
          Date.now() - startTime
        }ms - duration: ${duration}ms`,
      );
    }

    lastTimeoutMs = duration;

    await sleep(duration * dbReadAt);

    try {
      if (error) {
        throw typeof error === 'string' ? new Error(error) : error;
      }

      const response = fetchSelector(data, params);

      if (response === 'notFound') {
        throw new Error('Not found');
      }

      await sleep(duration * (1 - dbReadAt));

      if (!response) {
        throw new Error('No data');
      }

      fetchs.push({
        started: numOfFetchs,
        result: response as any,
        params,
        duration,
        time: { start: fetchStartTime, end: Date.now() - startTime },
      });

      return response;
    } catch (e) {
      fetchs.push({
        started: numOfFetchs,
        error: JSON.stringify(e),
        params,
        duration,
        time: { start: fetchStartTime, end: Date.now() - startTime },
      });
      throw e;
    } finally {
      fetchsInProgress.delete(fetchId);
      numOfFetchs += 1;
    }
  }

  async function fetchWitoutSelector() {
    return fetch('');
  }

  function mutateData(newData: Partial<Data>) {
    const prev = data;
    data = { ...data, ...newData };
    setTimeout(() => {
      onUpdateServerData?.({ prev, data });
    }, 8);
  }

  function produceData(recipe: (draft: Data) => void) {
    const prev = data;
    data = produce(data, recipe);
    setTimeout(() => {
      onUpdateServerData?.({ prev, data });
    }, 8);
  }

  function setFetchDuration(newTimeout: typeof timeout) {
    lastTimeout = timeout;
    timeout = newTimeout;
  }

  function undoTimeoutChange() {
    timeout = lastTimeout;
  }

  function setFetchError(newError: Error | string | null) {
    error = newError;
  }

  /** default duration: 60 */
  async function emulateMutation(
    newData: Partial<Data> | ((draft: Data) => void),
    {
      duration = 60,
      setDataAt = duration * 0.8,
      emulateError,
    }: {
      duration?: number;
      setDataAt?: number;
      emulateError?: Error | string;
    } = {},
  ) {
    if (logFetchs) {
      // eslint-disable-next-line no-console
      console.log(
        `mutation - started ${
          Date.now() - startTime
        }ms - duration: ${duration}ms`,
      );
    }

    await sleep(setDataAt);

    if (emulateError) {
      throw typeof emulateError === 'string'
        ? new Error(emulateError)
        : emulateError;
    }

    if (!data) {
      throw new Error('No data');
    }

    if (typeof newData === 'function') {
      produceData(newData);
    } else {
      mutateData(newData);
    }

    await sleep(duration - setDataAt);

    return data;
  }

  async function waitFetchIdle(extraWait = 0, maxWait = 1000) {
    waitNextFetchCompleteCall++;
    const startWaitTime = Date.now();

    const currentWaitNextFetchCompleteCall = waitNextFetchCompleteCall;

    function checkTimeout() {
      if (Date.now() - startWaitTime > maxWait) {
        throw new Error(
          `Wait for fetch idle ${currentWaitNextFetchCompleteCall} timeout`,
        );
      }
    }

    if (fetchsInProgress.size === 0) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (fetchsInProgress.size === 0) {
        await sleep(5);

        checkTimeout();
      }
    }

    async function waitUntilFetchsInProgressSizeIsZero() {
      while (fetchsInProgress.size > 0) {
        await sleep(10);

        checkTimeout();
      }
    }

    await waitUntilFetchsInProgressSizeIsZero();

    await sleep(extraWait);

    if (fetchsInProgress.size > 0) {
      await waitUntilFetchsInProgressSizeIsZero();
    }
  }

  return {
    fetch,
    mutateData,
    fetchWitoutSelector,
    waitFetchIdle,
    produceData,
    setFetchDuration,
    get data() {
      return data;
    },
    reset,
    setFetchError,
    addOnUpdateServerData(
      listener: (prevAndData: { prev: Data; data: Data }) => void,
    ) {
      onUpdateServerData = listener;
    },
    emulateMutation,
    undoTimeoutChange,
    get fetchsCount() {
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
    fetchsSequence(
      simplifyArray: 'all' | { firstNItems: number } | 'length' = {
        firstNItems: 1,
      },
    ) {
      return simplifyArraySnapshot(
        fetchs.map(({ time, duration, ...item }) => ({
          ...item,
        })),
        simplifyArray,
      );
    },
    get fetchs() {
      return fetchs;
    },
  };
}

export type ServerMock<Data> = ReturnType<typeof mockServerResource<Data>>;
