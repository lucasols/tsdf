import { rc_parse_json, rc_string, rc_tuple } from 'runcheck';
import type {
  AsyncStorageEntryMetadata,
  AsyncStorageMetadataOrder,
  AsyncStorageNamespaceScope,
  AsyncStorageNamespaceStaticPolicy,
  AsyncStorageProtectedEntryRef,
} from './types';
import { parseAsyncStorageNamespaceKind } from './types';

export const PAYLOAD_RECORD_PREFIX = '__tsdf_payload__:';
export const ASYNC_NAMESPACE_INDEX_RECORD_KEY = '_i';

export function getNamespaceId(scope: AsyncStorageNamespaceScope): string {
  return JSON.stringify([scope.sessionKey, scope.storeName, scope.kind]);
}

export function getPayloadRecordKey(key: string): string {
  return `${PAYLOAD_RECORD_PREFIX}${key}`;
}

export function serializeProtectedRef(
  ref: AsyncStorageProtectedEntryRef,
): string {
  return JSON.stringify([ref.sessionKey, ref.storeName, ref.kind, ref.key]);
}

export function parseProtectedRef(
  value: string,
): AsyncStorageProtectedEntryRef | null {
  const parsed = rc_parse_json(
    value,
    rc_tuple([rc_string, rc_string, rc_string, rc_string]),
  ).unwrapOrNull();
  if (parsed === null) return null;

  const [sessionKey, storeName, rawKind, key] = parsed;
  const kind = parseAsyncStorageNamespaceKind(rawKind);
  if (kind === null) return null;

  return { sessionKey, storeName, kind, key };
}

export function parseAsyncStorageRecordKey(
  key: string,
):
  | { recordKind: 'payload'; userKey: string }
  | { rawKey: string; recordKind: 'raw' } {
  if (key.startsWith(PAYLOAD_RECORD_PREFIX)) {
    return {
      recordKind: 'payload',
      userKey: key.slice(PAYLOAD_RECORD_PREFIX.length),
    };
  }

  return { rawKey: key, recordKind: 'raw' };
}

export function normalizeStaticPolicy(
  policy: AsyncStorageNamespaceStaticPolicy | null | undefined,
): AsyncStorageNamespaceStaticPolicy | null {
  if (policy === undefined || policy === null) return null;

  const maxEntries =
    typeof policy.maxEntries === 'number' &&
    Number.isInteger(policy.maxEntries) &&
    policy.maxEntries >= 0
      ? policy.maxEntries
      : undefined;
  const pinnedKeys = Array.isArray(policy.pinnedKeys)
    ? [...new Set(policy.pinnedKeys)].sort((left, right) =>
        left.localeCompare(right),
      )
    : [];

  if (maxEntries === undefined && pinnedKeys.length === 0) {
    return null;
  }

  return {
    ...(maxEntries !== undefined ? { maxEntries } : {}),
    ...(pinnedKeys.length > 0 ? { pinnedKeys } : {}),
  };
}

export function compareMetadata(
  left: AsyncStorageEntryMetadata<Record<string, unknown>>,
  right: AsyncStorageEntryMetadata<Record<string, unknown>>,
  order: AsyncStorageMetadataOrder,
): number {
  if (order === 'key') {
    return left.key.localeCompare(right.key);
  }

  if (left.lastAccessAt !== right.lastAccessAt) {
    return order === 'lru-asc'
      ? left.lastAccessAt - right.lastAccessAt
      : right.lastAccessAt - left.lastAccessAt;
  }

  return left.key.localeCompare(right.key);
}
