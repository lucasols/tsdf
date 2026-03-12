import {
  rc_array,
  rc_discriminated_union,
  rc_literals,
  rc_number,
  rc_object,
  rc_string,
  rc_unknown,
} from 'runcheck';
import { vi } from 'vitest';
import type { PersistentStorageSchema } from '../../src/persistentStorage/types';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import type { ListQueryParams } from '../mocks/listQueryStoreTestEnv';
import type { FilterOperator } from '../mocks/serverTableMock';

export const docSchema: PersistentStorageSchema<{ value: number }> = rc_object({
  value: rc_number,
});

export const docMutationInputSchema: PersistentStorageSchema<{
  value: number;
}> = rc_object({ value: rc_number });

export const docConflictSchema: PersistentStorageSchema<{ reason: string }> =
  rc_object({ reason: rc_string });

export const collectionCreateInputSchema: PersistentStorageSchema<{
  name: string;
}> = rc_object({ name: rc_string });

export const collectionSchema = rc_object({
  value: rc_object({ name: rc_string }),
});

const filterOperatorSchema: PersistentStorageSchema<FilterOperator> =
  rc_discriminated_union('op', {
    eq: { op: rc_literals('eq'), field: rc_string, value: rc_unknown },
    neq: { op: rc_literals('neq'), field: rc_string, value: rc_unknown },
    gt: { op: rc_literals('gt'), field: rc_string, value: rc_number },
    gte: { op: rc_literals('gte'), field: rc_string, value: rc_number },
    lt: { op: rc_literals('lt'), field: rc_string, value: rc_number },
    lte: { op: rc_literals('lte'), field: rc_string, value: rc_number },
    range: {
      op: rc_literals('range'),
      field: rc_string,
      min: rc_number,
      max: rc_number,
    },
    in: {
      op: rc_literals('in'),
      field: rc_string,
      values: rc_array(rc_unknown),
    },
    startsWith: {
      op: rc_literals('startsWith'),
      field: rc_string,
      value: rc_string,
    },
  });

export const listQueryQueryPayloadSchema: PersistentStorageSchema<ListQueryParams> =
  rc_object({
    tableId: rc_string,
    filters: rc_array(filterOperatorSchema).optionalKey(),
  });

export function toRecord(
  value: unknown,
  errorMessage: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(errorMessage);
  }

  return Object.fromEntries(Object.entries(value));
}

export function parsePersistedObject(raw: string): Record<string, unknown> {
  return toRecord(
    JSON.parse(raw),
    'Expected persisted storage entry to be an object',
  );
}

export function setupOfflineTestRuntime() {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  localStorage.clear();

  const network = createOfflineNetworkMock();
  network.install();

  return { network };
}
