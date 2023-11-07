/* eslint-disable @typescript-eslint/no-unsafe-return */
import { filterAndMap } from './filterAndMap';
import { isObject } from './isObject';

export function getCacheId(input: unknown, maxDepth = 3): string {
  if (typeof input === 'string') return String(input);

  if (!input || typeof input !== 'object') return `#$${input}$#`;

  return JSON.stringify(sortValues(input, maxDepth, 0));
}

function sortValues(input: unknown, maxDepth: number, depth: number): any {
  if (depth >= maxDepth) return input;

  if (Array.isArray(input)) {
    return input.map((v) => sortValues(v, maxDepth, depth + 1));
  }

  if (isObject(input)) {
    return orderedProps(input, (v) => sortValues(v, maxDepth, depth + 1));
  }

  return input;
}

const emptyObject = {};

function orderedProps(
  obj: Record<string, unknown>,
  mapValue: (value: unknown) => any,
) {
  const keys = Object.keys(obj);

  if (keys.length === 0) return emptyObject;

  if (keys.length === 1) {
    const value = obj[keys[0]!];

    if (value === undefined) return emptyObject;

    return { [keys[0]!]: mapValue(value) };
  }

  // eslint-disable-next-line no-restricted-syntax
  const mappedValues = filterAndMap(keys.sort(), (k, ignore) => {
    const value = obj[k];

    if (value === undefined) return ignore;

    return { [k]: mapValue(value) };
  });

  if (mappedValues.length === 0) return emptyObject;

  if (mappedValues.length === 1) return mappedValues[0];

  return mappedValues;
}
