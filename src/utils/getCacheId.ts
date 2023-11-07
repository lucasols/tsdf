/* eslint-disable @typescript-eslint/no-unsafe-return */
import { filterAndMap } from './filterAndMap';
import { isObject } from './isObject';

export function getCacheId(input: unknown, maxDepth = 3): string {
  return JSON.stringify(sortValues(input, maxDepth, 0));
}

function sortValues(input: unknown, maxDepth: number, depth: number): any {
  const inputType = typeof input;

  if (!input || inputType !== 'object') return input;

  if (depth >= maxDepth) return input;

  if (Array.isArray(input)) {
    return input.map((v) => sortValues(v, maxDepth, depth + 1));
  }

  if (isObject(input)) {
    return orderedProps(input, (v) => sortValues(v, maxDepth, depth + 1));
  }

  return input;
}

function orderedProps(
  obj: Record<string, unknown>,
  mapValue: (value: unknown) => any,
) {
  // eslint-disable-next-line no-restricted-syntax
  return filterAndMap(Object.keys(obj).sort(), (k, ignore) => {
    const value = obj[k];

    if (value === undefined) return ignore;

    return { [k]: mapValue(value) };
  });
}
