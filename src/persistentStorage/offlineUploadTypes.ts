import type { ValidPayload } from '../utils/storeShared';

export type OfflineUploadState =
  | 'pending'
  | 'uploading'
  | 'uploaded'
  | 'failed';

export type OfflineUploadSource = 'manual' | 'mutation';

export type OfflineUploadProgress = {
  progress: number;
  loadedBytes?: number;
  totalBytes?: number;
};

export type OfflineUpload<TResolvedRef extends ValidPayload = ValidPayload> = {
  id: string;
  sessionKey: string;
  source: OfflineUploadSource;
  state: OfflineUploadState;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
  resolvedRef?: TResolvedRef;
  progress?: OfflineUploadProgress;
  lastError?: { message: string };
};

export type OfflineStoredUploadRecord<
  TResolvedRef extends ValidPayload = ValidPayload,
> = OfflineUpload<TResolvedRef> & {
  file: File;
  lastOnlineSessionStartedAt?: number;
  lastModified: number;
};

export type OfflineUploadAdapter = {
  save<TResolvedRef extends ValidPayload>(
    sessionKey: string,
    id: string,
    record: OfflineStoredUploadRecord<TResolvedRef>,
  ): Promise<void>;
  load<TResolvedRef extends ValidPayload>(
    sessionKey: string,
    id: string,
  ): Promise<OfflineStoredUploadRecord<TResolvedRef> | null>;
  list<TResolvedRef extends ValidPayload>(
    sessionKey: string,
  ): Promise<OfflineStoredUploadRecord<TResolvedRef>[]>;
  remove(sessionKey: string, id: string): Promise<void>;
  clearSession(sessionKey: string): Promise<void>;
  resetForTests?(): void;
};

export type OfflineUploadTransportContext = {
  id: string;
  sessionKey: string;
  file: File;
  onProgress: (progress: OfflineUploadProgress) => void;
};

export type OfflineSessionUploadsConfig<
  TResolvedRef extends ValidPayload = ValidPayload,
> = {
  adapter: OfflineUploadAdapter;
  upload: (ctx: OfflineUploadTransportContext) => Promise<TResolvedRef>;
  concurrency?: number;
};

export type OfflineMutationUploadsInput = Record<string, Blob | File>;

export type OfflineAttachedUploadIds = Record<string, string>;

export type OfflineOperationUploadsContext<
  TResolvedRef extends ValidPayload = ValidPayload,
> = {
  filesById: Record<string, File>;
  resolvedRefsById: Record<string, TResolvedRef>;
};
