/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
export function pick<T, K extends keyof T>(
  obj: T | undefined,
  keys: K[],
  rename?: Partial<Record<K, string>>,
): Record<string, unknown> {
  const result: any = {};

  if (!obj) {
    return result;
  }

  for (const key of keys) {
    result[rename?.[key] || key] = obj[key];
  }
  return result;
}

export function omit<T>(
  obj: T | undefined,
  keys: (keyof T)[],
): Record<string, unknown> {
  const result: any = {};

  if (!obj) {
    return result;
  }

  for (const key of Object.keys(obj)) {
    if (!keys.includes(key as keyof T)) {
      result[key] = obj[key as keyof T];
    }
  }

  return result;
}
