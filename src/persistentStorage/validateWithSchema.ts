import { isPromise } from '@ls-stack/utils/typeGuards';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { rc_parse } from 'runcheck';
import { Result, type Result as ResultType } from 't-result';

import type { PersistentStorageSchema } from './types';

export type SchemaValidationError =
  | readonly string[]
  | StandardSchemaV1.FailureResult['issues'];

export function parseWithSchema<T>(
  schema: PersistentStorageSchema<T>,
  data: unknown,
): ResultType<T, SchemaValidationError> {
  if ('~standard' in schema) {
    const result = schema['~standard'].validate(data);

    if (isPromise(result)) {
      // Async schemas are not supported
      return Result.err(['Async schemas are not supported']);
    }

    if (result.issues) return Result.err(result.issues);

    return Result.ok(result.value);
  }

  const result = rc_parse(data, schema);

  return result.ok ? Result.ok(result.value) : Result.err(result.errors);
}

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
  const result = parseWithSchema(schema, data);
  return result.ok ? result.value : null;
}
