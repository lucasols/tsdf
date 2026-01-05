import { deepEqual } from 't-state';

export function reusePrevIfEqual<T>({
  prev,
  current,
  equalityFn_ = deepEqual,
}: {
  prev: T | undefined;
  current: T;
  equalityFn_?: (prev: unknown, current: unknown) => boolean;
}): T {
  if (prev === undefined) return current;

  if (equalityFn_(prev, current)) {
    return prev;
  }

  return current;
}
