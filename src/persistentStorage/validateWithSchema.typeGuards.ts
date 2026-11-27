import type { PersistentStorageSchema } from './types';
import { parseWithSchema } from './validateWithSchema';

export function isValidForSchema<T>(
  schema: PersistentStorageSchema<T>,
  data: unknown,
): data is T {
  return parseWithSchema(schema, data).ok;
}
