import { filterAndMap } from './filterAndMap';
import { isObject } from './isObject';

export function getCacheId(input: any) {
  return typeof input === 'string'
    ? input
    : JSON.stringify(input && isObject(input) ? orderedProps(input) : input);
}

function orderedProps(obj: Record<string, unknown>) {
  // eslint-disable-next-line no-restricted-syntax
  return filterAndMap(Object.keys(obj).sort(), (k, ignore) => {
    const value = obj[k];

    if (value === undefined) return ignore;

    return { [k]: obj[k] };
  });
}
