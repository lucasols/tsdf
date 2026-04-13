import {
  rc_array,
  rc_boolean,
  rc_number,
  rc_object,
  rc_parse_json,
  rc_string,
  rc_unknown,
} from 'runcheck';

const compactListQueryLocalStorageEntrySchema = rc_object({
  a: rc_number,
  i: rc_array(rc_string).withFallback([]),
  o: rc_boolean.withFallback(false).optionalKey(),
  p: rc_unknown,
  h: rc_boolean.withFallback(false).optionalKey(),
  v: rc_number.optionalKey(),
});

export function isCompactListQueryLocalStorageKey(storageKey: string): boolean {
  return storageKey.startsWith('tsdf.') && storageKey.includes('.lq.');
}

export type CompactListQueryLocalStorageEntry = {
  hasMore: boolean;
  items: string[];
  lastAccessAt: number;
  offlineProtected: boolean;
  payload: unknown;
  version?: number;
};

export function parseCompactListQueryLocalStorageEntry(
  raw: string | null,
): CompactListQueryLocalStorageEntry | null {
  if (raw === null) return null;

  const parsedRaw = rc_parse_json(raw, rc_unknown).unwrapOrNull();
  if (parsedRaw === null) return null;

  const parsed = compactListQueryLocalStorageEntrySchema
    .parse(parsedRaw)
    .unwrapOrNull();
  if (parsed === null) return null;

  return {
    lastAccessAt: parsed.a,
    items: parsed.i,
    offlineProtected: parsed.o === true,
    payload: parsed.p,
    hasMore: parsed.h === true,
    version: parsed.v,
  };
}

export function createCompactListQueryLocalStorageEntry(
  entry: CompactListQueryLocalStorageEntry,
): Record<string, unknown> {
  return {
    a: entry.lastAccessAt,
    i: entry.items,
    p: entry.payload,
    ...(entry.hasMore ? { h: true } : {}),
    ...(entry.offlineProtected ? { o: true } : {}),
    ...(entry.version !== undefined ? { v: entry.version } : {}),
  };
}
