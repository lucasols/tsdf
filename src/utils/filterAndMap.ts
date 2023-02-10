export function filterAndMap<T, R>(
  arr: T[],
  fn: (item: T, ignoreItem: false, index: number) => R | false,
): R[] {
  const result: R[] = [];
  let i = 0;
  for (const item of arr) {
    const mappedItem = fn(item, false, i);

    if (mappedItem !== false) {
      result.push(mappedItem);
    }

    i++;
  }

  return result;
}
