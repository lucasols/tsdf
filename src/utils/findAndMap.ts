export function findAndMap<T, R>(
  arr: T[],
  findFn: (item: T, index: number) => R | false,
): R | undefined {
  let i = 0;
  for (const item of arr) {
    const mappedItem = findFn(item, i);

    if (mappedItem !== false) {
      return mappedItem;
    }

    i++;
  }

  return undefined;
}
