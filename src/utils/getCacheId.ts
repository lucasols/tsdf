import { isObject } from './isObject';

export function getCacheId(input: any) {
  return typeof input === 'string'
    ? input
    : JSON.stringify(input && isObject(input) ? orderedProps(input) : input);
}

function orderedProps(obj: any) {
  // eslint-disable-next-line no-restricted-syntax
  return Object.keys(obj)
    .sort()
    .map((k) => ({ [k]: obj[k] }));
}
