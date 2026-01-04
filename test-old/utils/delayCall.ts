import { sleep } from './sleep';

export async function delayCall(delay: number, callback: () => void) {
  await sleep(delay);

  callback();
}

export async function waitTimeline(
  calls: [number, () => void][],
  waitUntil = 0,
): Promise<void> {
  const startTime = Date.now();
  const promisses: Promise<void>[] = [];

  for (const [delay, callback] of calls) {
    promisses.push(delayCall(delay, callback));
  }

  await Promise.all(promisses);

  if (waitUntil) {
    await sleep(waitUntil - (Date.now() - startTime));
  }
}
