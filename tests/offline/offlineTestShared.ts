import {
  rc_array,
  rc_discriminated_union,
  rc_literals,
  rc_number,
  rc_object,
  rc_string,
  rc_unknown,
} from 'runcheck';

import type { OfflineResolutionRecord } from '../../src/main';
import { getGlobalOfflineStatus } from '../../src/main';
import type { PersistentStorageSchema } from '../../src/persistentStorage/types';
import type { ListQueryParams } from '../mocks/listQueryStoreTestEnv';
import type { FilterOperator } from '../mocks/serverTableMock';
import { pick } from '../utils/genericTestUtils';

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

export const quickRecoveryProbe = {
  initialIntervalMs: 1,
  maxIntervalMs: 1,
  backoffMultiplier: 1,
  jitterRatio: 0,
} as const;

export function classifyMutationOutage(error: unknown, phase: string): boolean {
  return (
    phase === 'mutation' &&
    error instanceof Error &&
    error.message === 'offline-fallback'
  );
}

export function classifyRetryableReplayFailure(
  error: unknown,
  phase: string,
): boolean {
  return phase === 'sync' && error instanceof Error;
}

export async function waitForMicrotaskCondition(
  condition: () => boolean,
  maxTurns = 20,
): Promise<void> {
  for (let turn = 0; turn < maxTurns && !condition(); turn += 1) {
    await Promise.resolve();
  }
}

/**
 * Compact summary of a resolution record for test snapshots.
 *
 * Only includes fields that carry signal — no `'none'` fillers, no derived
 * UI labels. Dependency counts (`blockedBy`, `blocks`) and `tempIds` are
 * omitted when zero/absent.
 */
export function summarizeResolution(resolution: OfflineResolutionRecord) {
  return {
    kind: resolution.kind,
    op: resolution.operation,
    on: resolution.entityRefs
      .map((ref) => `${ref.entityKind}:${normalizeEntityKey(ref.entityKey)}`)
      .join(', '),
    ...(resolution.kind === 'conflict'
      ? { reason: extractReason(resolution.conflict) }
      : { error: resolution.lastReplayError.message }),
    input: formatCompactValue(resolution.input),
    ...(resolution.blockedResolutionCount > 0
      ? { blockedBy: resolution.blockedResolutionCount }
      : {}),
    ...(resolution.childResolutionCount > 0
      ? { blocks: resolution.childResolutionCount }
      : {}),
    ...(resolution.tempIds !== undefined
      ? {
          tempIds: resolution.tempIds.map((id) =>
            typeof id === 'string'
              ? normalizeEntityKey(id)
              : formatCompactValue(id),
          ),
        }
      : {}),
  };
}

function formatCompactValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => formatCompactValue(item)).join(', ');
  }

  if (value && typeof value === 'object') {
    return Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${key}: ${formatCompactValue(v)}`)
      .join(', ');
  }

  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function extractReason(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return value == null ? 'none' : formatCompactValue(value);
  }

  if ('reason' in value && typeof value.reason === 'string') {
    return value.reason;
  }

  if ('message' in value && typeof value.message === 'string') {
    return value.message;
  }

  return formatCompactValue(value);
}

export function getGlobalOfflineStatusSummary(sessionKey: string) {
  return pick(getGlobalOfflineStatus(sessionKey), [
    'isOfflineMode',
    'network',
    'outage',
    'sessionKey',
  ]);
}

function normalizeEntityKey(value: string) {
  return value.startsWith('"') ? value.slice(1) : value;
}
