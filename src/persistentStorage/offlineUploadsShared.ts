import { isPromise } from '@ls-stack/utils/typeGuards';
import type { ValidPayload } from '../utils/storeShared';
import type {
  OfflineStoredUploadRecord,
  OfflineUpload,
  OfflineUploadProgress,
  OfflineUploadRefSchema,
  OfflineUploadSource,
  OfflineUploadState,
} from './offlineUploadTypes';

/**
 * Parses an upload ref that came from storage or from another tab.
 *
 * @returns The parsed ref, or `undefined` when it does not match the schema.
 */
export function parseRestoredUploadRef<TResolvedRef extends ValidPayload>(
  schema: OfflineUploadRefSchema<TResolvedRef>,
  resolvedRef: unknown,
): TResolvedRef | undefined {
  if ('~standard' in schema) {
    const result = schema['~standard'].validate(resolvedRef);

    // Async schemas are not supported
    if (isPromise(result) || result.issues) return undefined;

    return result.value;
  }

  const result = schema.parse(resolvedRef);

  return result.ok ? result.value : undefined;
}

/**
 * Applies the outcome of {@link parseRestoredUploadRef} to a restored upload.
 *
 * An upload whose ref failed the schema goes back to `pending` without the
 * ref, so its staged file is uploaded again the next time the ref is needed.
 */
export function applyRestoredUploadRef<TUpload extends OfflineUpload>(
  upload: TUpload,
  parsedRef: ValidPayload | undefined,
): TUpload {
  if (parsedRef !== undefined) {
    return parsedRef === upload.resolvedRef
      ? upload
      : { ...upload, resolvedRef: parsedRef };
  }

  const pendingUpload = { ...upload, state: 'pending' as const };
  delete pendingUpload.resolvedRef;
  delete pendingUpload.progress;
  return pendingUpload;
}

export function stripStoredUploadFile<
  TResolvedRef extends ValidPayload = ValidPayload,
>(
  record: OfflineStoredUploadRecord<TResolvedRef>,
): OfflineUpload<TResolvedRef> {
  const {
    file: _file,
    lastOnlineSessionStartedAt: _lastOnlineSessionStartedAt,
    lastModified: _lastModified,
    storeName: _storeName,
    ...upload
  } = record;
  return upload;
}

export function createStoredUploadRecord<
  TResolvedRef extends ValidPayload = ValidPayload,
>(
  id: string,
  sessionKey: string,
  fileInput: Blob | File,
  source: OfflineUploadSource,
  state?: OfflineUploadState,
  createdAtInput?: number,
  progress?: OfflineUploadProgress,
  resolvedRef?: TResolvedRef,
  lastError?: OfflineStoredUploadRecord<TResolvedRef>['lastError'],
  lastOnlineSessionStartedAt?: number,
  metadata?: ValidPayload,
  storeName?: string,
): OfflineStoredUploadRecord<TResolvedRef> {
  const file = normalizeUploadFile(fileInput, id);
  const now = Date.now();
  const createdAt = createdAtInput ?? now;
  const updatedAt = now;

  return {
    id,
    sessionKey,
    source,
    state: state ?? 'pending',
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    createdAt,
    updatedAt,
    ...(resolvedRef !== undefined ? { resolvedRef } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
    ...(lastOnlineSessionStartedAt !== undefined
      ? { lastOnlineSessionStartedAt }
      : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    file,
    lastModified: file.lastModified,
    ...(storeName !== undefined ? { storeName } : {}),
  };
}

function normalizeUploadFile(file: Blob | File, fallbackName: string): File {
  if (file instanceof File) return file;

  return new File([file], fallbackName, {
    lastModified: Date.now(),
    type: file.type,
  });
}
