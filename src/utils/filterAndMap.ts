const ignore = Symbol();

export function filterAndMap<T, R>(
  arr: T[],
  fn: (item: T, ignoreItem: symbol, index: number) => R | symbol,
): R[] {
  const result: R[] = [];
  let i = 0;
  for (const item of arr) {
    const mappedItem = fn(item, ignore, i);

    if (mappedItem !== ignore) {
      result.push(mappedItem as R);
    }

    i++;
  }

  return result;
}
