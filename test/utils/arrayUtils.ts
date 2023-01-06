export function arrayWithPrev<T>(array: T[]): [current: T, prev: T | null][] {
  return array.map((item, i) => [item, array[i - 1] ?? null]);
}
