import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  rc_literals,
  rc_number,
  rc_object,
  rc_parse,
  rc_record,
  rc_string,
  rc_union,
  rc_unknown,
} from 'runcheck';
import type { ValidPayload } from '../utils/storeShared';
import type { OfflineStoredUploadRecord } from './offlineUploadTypes';

const uploadProgressSchema = rc_object({
  loadedBytes: rc_number.optionalKey(),
  totalBytes: rc_number.optionalKey(),
  progress: rc_number,
});

const validPayloadSchema = rc_union(
  rc_string,
  rc_number,
  rc_record(rc_unknown),
);

const lastErrorSchema = rc_object({ message: rc_string });

const compactUploadMetadataRecordSchema = rc_object({
  i: rc_string,
  k: rc_string,
  o: rc_literals('manual', 'mutation'),
  t: rc_literals('pending', 'uploading', 'uploaded', 'failed'),
  n: rc_string,
  m: rc_string,
  z: rc_number,
  c: rc_number,
  u: rc_number,
  r: validPayloadSchema.optionalKey(),
  p: uploadProgressSchema.optionalKey(),
  e: lastErrorSchema.optionalKey(),
  g: rc_number.optionalKey(),
  l: rc_number,
  d: validPayloadSchema.optionalKey(),
});

/** Stored upload record without the file object, which adapters persist separately. */
export type PersistedUploadMetadataRecord<
  TResolvedRef extends ValidPayload = ValidPayload,
> = Omit<OfflineStoredUploadRecord<TResolvedRef>, 'file'>;

/** Converts upload metadata to the compact shape shared by the built-in upload adapters. */
export function toCompactUploadMetadataRecord(
  record: PersistedUploadMetadataRecord,
): Record<string, unknown> {
  return {
    i: record.id,
    k: record.sessionKey,
    o: record.source,
    t: record.state,
    n: record.fileName,
    m: record.mimeType,
    z: record.sizeBytes,
    c: record.createdAt,
    u: record.updatedAt,
    ...(record.resolvedRef !== undefined ? { r: record.resolvedRef } : {}),
    ...(record.progress !== undefined ? { p: record.progress } : {}),
    ...(record.lastError !== undefined ? { e: record.lastError } : {}),
    ...(record.lastOnlineSessionStartedAt !== undefined
      ? { g: record.lastOnlineSessionStartedAt }
      : {}),
    l: record.lastModified,
    ...(record.metadata !== undefined ? { d: record.metadata } : {}),
  };
}

/** Validates compact upload metadata read back from storage, returning `null` when it is not usable. */
export function parseCompactUploadMetadataRecord<
  TResolvedRef extends ValidPayload = ValidPayload,
>(value: unknown): PersistedUploadMetadataRecord<TResolvedRef> | null {
  const compactRecord = rc_parse(
    value,
    compactUploadMetadataRecordSchema,
  ).unwrapOrNull();

  if (compactRecord === null) return null;

  return {
    id: compactRecord.i,
    sessionKey: compactRecord.k,
    source: compactRecord.o,
    state: compactRecord.t,
    fileName: compactRecord.n,
    mimeType: compactRecord.m,
    sizeBytes: compactRecord.z,
    createdAt: compactRecord.c,
    updatedAt: compactRecord.u,
    ...(compactRecord.r !== undefined
      ? {
          // WORKAROUND: Persisted upload metadata is validated only at the
          // shared ValidPayload boundary, and hydration rebinds that known-safe
          // value back to the caller's compile-time upload-ref generic.
          resolvedRef: __LEGIT_CAST__<TResolvedRef, ValidPayload>(
            compactRecord.r,
          ),
        }
      : {}),
    ...(compactRecord.p !== undefined ? { progress: compactRecord.p } : {}),
    ...(compactRecord.e !== undefined ? { lastError: compactRecord.e } : {}),
    ...(compactRecord.g !== undefined
      ? { lastOnlineSessionStartedAt: compactRecord.g }
      : {}),
    lastModified: compactRecord.l,
    ...(compactRecord.d !== undefined ? { metadata: compactRecord.d } : {}),
  };
}
