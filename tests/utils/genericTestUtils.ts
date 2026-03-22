import { act } from '@testing-library/react';
import { vi } from 'vitest';
import {
  flushMockBrowserOpfsLatenciesForTests,
  hasPendingMockBrowserOpfsLatenciesForTests,
} from '../mocks/mockBrowserOpfs';

const MAX_TEST_SETTLE_PASSES = 20;

export function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => index + start);
}

export function pick<T extends Record<string, unknown>, K extends keyof T>(
  obj: T | undefined,
  keys: K[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (!obj) return result;

  for (const key of keys) {
    result[String(key)] = obj[key];
  }

  return result;
}

export async function flushAllTimers() {
  await act(async () => {
    for (let pass = 0; pass < MAX_TEST_SETTLE_PASSES; pass++) {
      await vi.runAllTimersAsync();
      await flushMockBrowserOpfsLatenciesForTests();
      await vi.advanceTimersByTimeAsync(0);

      if (
        vi.getTimerCount() === 0 &&
        !hasPendingMockBrowserOpfsLatenciesForTests()
      ) {
        return;
      }
    }
  });
}

export async function advanceTime(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);

    let previousTimerCount = vi.getTimerCount();
    for (let pass = 0; pass < MAX_TEST_SETTLE_PASSES; pass++) {
      await vi.advanceTimersByTimeAsync(0);
      const nextTimerCount = vi.getTimerCount();

      if (nextTimerCount === previousTimerCount) return;

      previousTimerCount = nextTimerCount;
    }
  });
}

export async function resolveAfterAllTimers<T>(
  promise: Promise<T>,
): Promise<T> {
  const pendingResult = Symbol('pendingResult');
  let didSettle = false;

  const settledResultPromise = promise.then(
    (value) => {
      didSettle = true;
      return { status: 'resolved' as const, value };
    },
    (error) => {
      didSettle = true;
      return { status: 'rejected' as const, error };
    },
  );

  await act(async () => {
    for (let pass = 0; pass < MAX_TEST_SETTLE_PASSES * 10; pass++) {
      if (didSettle) return;

      if (vi.getTimerCount() > 0) {
        await vi.advanceTimersToNextTimerAsync();
      } else {
        await Promise.resolve();
      }
    }
  });

  const settledResult = await Promise.race([
    settledResultPromise,
    Promise.resolve(pendingResult),
  ]);

  if (settledResult === pendingResult) {
    throw new Error('Promise did not settle while advancing fake timers.');
  }

  if (settledResult.status === 'rejected') {
    throw settledResult.error;
  }

  return settledResult.value;
}

export async function waitForScheduledCleanup(delayMs = 2100) {
  await advanceTime(delayMs);
  await flushAllTimers();
}
