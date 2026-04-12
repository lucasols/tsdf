import type { ValidPayload } from '../utils/storeShared';
import type {
  OfflineStoredUploadRecord,
  OfflineUpload,
  OfflineUploadProgress,
  OfflineUploadSource,
  OfflineUploadState,
} from './offlineUploadTypes';

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
>(args: {
  id: string;
  sessionKey: string;
  file: Blob | File;
  source: OfflineUploadSource;
  state?: OfflineUploadState;
  createdAt?: number;
  progress?: OfflineUploadProgress;
  resolvedRef?: TResolvedRef;
  lastError?: OfflineStoredUploadRecord<TResolvedRef>['lastError'];
  lastOnlineSessionStartedAt?: number;
}): OfflineStoredUploadRecord<TResolvedRef> {
  const file = normalizeUploadFile(args.file, args.id);
  const now = Date.now();
  const createdAt = args.createdAt ?? now;
  const updatedAt = now;

  return {
    id: args.id,
    sessionKey: args.sessionKey,
    source: args.source,
    state: args.state ?? 'pending',
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    createdAt,
    updatedAt,
    ...(args.resolvedRef !== undefined
      ? { resolvedRef: args.resolvedRef }
      : {}),
    ...(args.progress !== undefined ? { progress: args.progress } : {}),
    ...(args.lastError !== undefined ? { lastError: args.lastError } : {}),
    ...(args.lastOnlineSessionStartedAt !== undefined
      ? { lastOnlineSessionStartedAt: args.lastOnlineSessionStartedAt }
      : {}),
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
