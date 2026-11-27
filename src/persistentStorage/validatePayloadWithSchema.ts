import type { PersistentStorageSchema } from './types';
import { isValidForSchema } from './validateWithSchema.typeGuards';

/**
 * Validates a persisted payload against its schema and returns the persisted
 * value itself instead of the schema output.
 *
 * Store keys are derived from payloads, and a schema output can differ from
 * its input (runcheck rebuilds objects in schema key order and drops
 * undeclared keys), so the parsed payload could stop matching the key it was
 * persisted under.
 *
 * @returns The persisted payload if valid, or null if validation fails.
 */
export function validatePayloadWithSchema<T>(
  schema: PersistentStorageSchema<T>,
  data: unknown,
): T | null {
  return isValidForSchema(schema, data) ? data : null;
}
