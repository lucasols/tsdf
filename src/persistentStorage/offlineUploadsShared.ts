import type { ValidPayload } from '../utils/storeShared';
import type {
  OfflineStoredUploadRecord,
  OfflineUpload,
  OfflineUploadFile,
  OfflineUploadProgress,
  OfflineUploadSource,
  OfflineUploadState,
} from './offlineUploadTypes';

function createEmptyUploadFile(
  status: 'idle' | 'loading' | 'missing',
): OfflineUploadFile {
  return { status, url: null, file: null, error: null };
}

export const idleUploadFile = createEmptyUploadFile('idle');
export const loadingUploadFile = createEmptyUploadFile('loading');
export const missingUploadFile = createEmptyUploadFile('missing');

export function stripStoredUploadFile<
  TResolvedRef extends ValidPayload = ValidPayload,
>(
  record: OfflineStoredUploadRecord<TResolvedRef>,
): OfflineUpload<TResolvedRef> {
  const {
    file: _file,
    lastOnlineSessionStartedAt: _lastOnlineSessionStartedAt,
    lastModified: _lastModified,
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
  };
}

function normalizeUploadFile(file: Blob | File, fallbackName: string): File {
  if (file instanceof File) return file;

  return new File([file], fallbackName, {
    lastModified: Date.now(),
    type: file.type,
  });
}
