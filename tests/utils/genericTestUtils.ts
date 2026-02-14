import { act } from '@testing-library/react';
import { vi } from 'vitest';
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
    await vi.runAllTimersAsync();
  });
}

export async function advanceTime(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
