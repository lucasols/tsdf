export function pick<T, K extends keyof T>(
  obj: T,
  keys: K[],
  rename?: Partial<Record<K, string>>,
): Record<string, unknown> {
  const result: any = {};

  for (const key of keys) {
    result[rename?.[key] || key] = obj[key];
  }
  return result;
}
