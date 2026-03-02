import type { PersistentStorageSchema } from './types';

/**
 * Validates data against a schema using duck typing to detect the schema type.
 * Supports runcheck (.parse()) and Standard Schema v1 (~standard.validate()).
 *
 * @returns The validated data if valid, or null if validation fails.
 */
export function validateWithSchema<T>(
  schema: PersistentStorageSchema<T>,
  data: unknown,
): T | null {
  if ('~standard' in schema) {
    const result = schema['~standard'].validate(data);

    if (result instanceof Promise) {
      // Async schemas are not supported
      return null;
    }

    if (result.issues) return null;

    return result.value;
  }

  const result = schema.parse(data);

  return result.ok ? result.value : null;
}
