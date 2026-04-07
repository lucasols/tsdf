import { isObject } from '@ls-stack/utils/typeGuards';
import { rc_parse_json, rc_unknown } from 'runcheck';

export type CompactLocalStorageEntryValue = Record<string, unknown>;

export function createCompactLocalStorageEntry(
  value: CompactLocalStorageEntryValue,
  version: number | undefined,
): CompactLocalStorageEntryValue {
  if ('v' in value && value.v !== undefined) {
    throw new Error(
      '[TSDF] Compact localStorage entries cannot use the reserved "v" key.',
    );
  }

  if (version === undefined) return value;

  return { ...value, v: version };
}

export type ParsedCompactLocalStorageEntry = {
  value: CompactLocalStorageEntryValue;
  version?: number;
};

export function parseCompactLocalStorageEntry(
  raw: string | null,
): ParsedCompactLocalStorageEntry | null {
  if (raw === null) return null;

  const value = rc_parse_json(raw, rc_unknown).unwrapOrNull();
  if (value === null) return null;

  if (!isObject(value) || !('d' in value)) {
    return null;
  }

  if ('v' in value && value.v !== undefined && typeof value.v !== 'number') {
    return null;
  }

  return {
    value,
    ...(typeof value.v === 'number' ? { version: value.v } : {}),
  };
}
