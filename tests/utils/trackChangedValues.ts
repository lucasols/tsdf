import { deepEqual } from '@ls-stack/utils/deepEqual';

export function trackChangedValues<T = unknown>() {
  const changes: T[] = [];

  return {
    track(value: T) {
      if (!deepEqual(changes.at(-1), value)) {
        changes.push(value);
      }
    },
    get changes() {
      return changes;
    },
  };
}
