import { sleep } from '../utils/sleep';

export function mockServerResource<Data>({
  initialData = null,
}: {
  initialData?: Data | null;
} = {}) {
  let data = initialData;
  let timeout = 30;
  let error: Error | string | null = null;

  async function fetch(): Promise<Data> {
    await sleep(timeout);

    if (error) {
      throw typeof error === 'string' ? new Error(error) : error;
    }

    if (!data) {
      throw new Error('No data');
    }

    return data;
  }

  function mutateData(newData: Data) {
    data = newData;
  }

  function setTimeout(newTimeout: number) {
    timeout = newTimeout;
  }

  function trhowErrorInNextFetch(newError: Error | string) {
    error = newError;
  }

  return {
    fetch,
    mutateData,
    setTimeout,
    trhowErrorInNextFetch,
    get timeout() {
      return timeout;
    },
  };
}
