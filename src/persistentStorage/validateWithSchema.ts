import { isPromise } from '@ls-stack/utils/typeGuards';
import { rc_parse } from 'runcheck';
import type { PersistentStorageSchema } from './types';

/**
 * Validates data against a schema.
 * Supports runcheck (RcType) and Standard Schema v1 (~standard.validate()).
 *
 * @returns The validated data if valid, or null if validation fails.
 */
export function validateWithSchema<T>(
  schema: PersistentStorageSchema<T>,
  data: unknown,
): T | null {
  if ('~standard' in schema) {
    const result = schema['~standard'].validate(data);

    if (isPromise(result)) {
      // Async schemas are not supported
      return null;
    }

    if (result.issues) return null;

    return result.value;
  }

  const result = rc_parse(data, schema);

  return result.ok ? result.value : null;
}
