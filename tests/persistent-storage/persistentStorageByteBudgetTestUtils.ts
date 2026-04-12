import { createCompactListQueryLocalStorageEntry } from '../../src/persistentStorage/compactListQueryLocalStorageEntry';
import { createCompactLocalStorageEntry } from '../../src/persistentStorage/compactLocalStorageEntry';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';

const utf8Encoder = new TextEncoder();

function getUtf8ByteSize(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function getDefaultTimestamp(): number {
  return TEST_INITIAL_TIME.valueOf();
}

export function sumPersistedEntryBytes(...sizes: number[]): number {
  return sizes.reduce((total, size) => total + size, 0);
}

export function getLocalCollectionEntrySizeBytes<T>(
  payload: string,
  data: T,
  version?: number,
): number {
  return getUtf8ByteSize(
    JSON.stringify(
      createCompactLocalStorageEntry({ d: data, p: payload }, version),
    ),
  );
}

export function getAsyncCollectionEntrySizeBytes<T>(
  payload: string,
  data: T,
): number {
  return (
    getUtf8ByteSize(JSON.stringify({ d: data, p: payload })) +
    getUtf8ByteSize(JSON.stringify({ a: getDefaultTimestamp(), p: payload }))
  );
}

function getAsyncMetadataSizeBytes(payload: unknown): number {
  return getUtf8ByteSize(
    JSON.stringify({ a: getDefaultTimestamp(), p: payload }),
  );
}

export function getLocalListItemEntrySizeBytes<T>(
  payload: string,
  data: T,
  options: { loadedFields?: string[]; version?: number } = {},
): number {
  return getUtf8ByteSize(
    JSON.stringify(
      createCompactLocalStorageEntry(
        {
          d: data,
          p: payload,
          ...(options.loadedFields !== undefined
            ? { lf: options.loadedFields }
            : {}),
        },
        options.version,
      ),
    ),
  );
}

export function getAsyncListItemEntrySizeBytes<T>(
  payload: string,
  data: T,
  options: { loadedFields?: string[] } = {},
): number {
  return (
    getUtf8ByteSize(
      JSON.stringify({
        d: data,
        p: payload,
        ...(options.loadedFields !== undefined
          ? { lf: options.loadedFields }
          : {}),
      }),
    ) + getAsyncMetadataSizeBytes(payload)
  );
}

export function getLocalListQueryEntrySizeBytes(
  payload: unknown,
  items: string[],
  options: { hasMore?: boolean; lastAccessAt?: number; version?: number } = {},
): number {
  return getUtf8ByteSize(
    JSON.stringify(
      createCompactListQueryLocalStorageEntry({
        items,
        payload,
        hasMore: options.hasMore ?? false,
        lastAccessAt: options.lastAccessAt ?? getDefaultTimestamp(),
        offlineProtected: false,
        ...(options.version !== undefined ? { version: options.version } : {}),
      }),
    ),
  );
}

export function getAsyncListQueryEntrySizeBytes(
  payload: unknown,
  items: string[],
  options: { hasMore?: boolean } = {},
): number {
  return (
    getUtf8ByteSize(
      JSON.stringify({
        i: items,
        ...(options.hasMore === true ? { h: true } : {}),
      }),
    ) + getAsyncMetadataSizeBytes(payload)
  );
}
