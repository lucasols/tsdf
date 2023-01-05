const ignore = Symbol();

export function filterAndMap<T, R>(
  arr: T[],
  fn: (item: T, ignoreItem: symbol) => R | symbol,
): R[] {
  const result: R[] = [];

  for (const item of arr) {
    const mappedItem = fn(item, ignore);

    if (mappedItem !== ignore) {
      result.push(mappedItem as R);
    }
  }

  return result;
}
