import { sleep } from '../utils/sleep';

export function mockServerResource<Data, S = Data>({
  initialData,
  fetchSelector = (data) => data as unknown as S,
}: {
  initialData: Data;
  fetchSelector?: (data: Data | null, params: string) => S;
}) {
  let data = initialData;
  let timeout = 30;
  let error: Error | string | null = null;
  let numOfFetchs = 0;

  const dbReadAt = 0.62;

  async function fetch(params: string): Promise<S> {
    numOfFetchs += 1;

    await sleep(timeout * dbReadAt);

    if (error) {
      throw typeof error === 'string' ? new Error(error) : error;
    }

    const response = fetchSelector(data, params);

    await sleep(timeout * (1 - dbReadAt));

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

  function setTimeout(newTimeout: number) {
    timeout = newTimeout;
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
    get numOfFetchs() {
      return numOfFetchs;
    },
    get timeout() {
      return timeout;
    },
  };
}

export type ServerMock<Data> = ReturnType<typeof mockServerResource<Data>>;
