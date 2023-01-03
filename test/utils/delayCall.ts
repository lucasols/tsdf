import { sleep } from './sleep';

export async function delayCall(delay: number, callback: () => void) {
  await sleep(delay);

  callback();
}
