const ignore = {
  _ignore: Symbol(),
};

export function filterAndMap<T>(
  arr: T[],
  fn: (item: T, ignoreItem: typeof ignore) => T | typeof ignore,
) {
  const result: T[] = [];

  for (const item of arr) {
    const mappedItem = fn(item, ignore);

    if (mappedItem !== ignore) {
      result.push(mappedItem as T);
    }
  }

  return result;
}
