export function getObjectKeyOrInsert<
  T extends Record<string, any>,
  K extends keyof T,
>(obj: T, key: K, defaultValue: () => T[K]): T[K] {
  if (obj[key] === undefined) {
    obj[key] = defaultValue();
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return obj[key] as T[K];
}
