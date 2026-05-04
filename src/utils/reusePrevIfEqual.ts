import { deepEqual } from '@ls-stack/utils/deepEqual';

export function reusePrevIfEqual<T>(prev: T | undefined, current: T): T {
  if (prev === undefined) return current;

  if (deepEqual(prev, current)) return prev;

  return current;
}
