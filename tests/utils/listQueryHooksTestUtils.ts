import { act } from '@testing-library/react';
import { vi } from 'vitest';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';

export function shouldNotSkip(scheduleResult: string) {
  if (scheduleResult === 'skipped') {
    throw new Error('Should not skip');
  }
}

export type ListQueryTestEnv = ReturnType<typeof createListQueryStoreTestEnv>;

export function getFetchCountFromHere(env: ListQueryTestEnv) {
  const startCount = env.serverTable.numOfFinishedFetches;
  return () => env.serverTable.numOfFinishedFetches - startCount;
}

export async function flushAllTimers() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

export async function advanceTime(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
