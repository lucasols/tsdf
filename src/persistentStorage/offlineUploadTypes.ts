import type { ValidPayload } from '../utils/storeShared';

/** Lifecycle state for a session-scoped offline upload. */
export type OfflineUploadState =
  | 'pending'
  | 'uploading'
  | 'uploaded'
  | 'failed';

/** Source that created a staged offline upload. */
export type OfflineUploadSource = 'manual' | 'mutation';

/** Progress snapshot reported while uploading a staged file. */
export type OfflineUploadProgress = {
  /** Normalized progress from `0` to `1`. */
  progress: number;
  /** Loaded byte count, when available from the transport. */
  loadedBytes?: number;
  /** Total byte count, when available from the transport. */
  totalBytes?: number;
};

/** Public metadata for a file staged for offline mutation replay. */
export type OfflineUpload<TResolvedRef extends ValidPayload = ValidPayload> = {
  /** Stable upload id used by offline operation inputs. */
  id: string;
  /** Session key that owns this upload. */
  sessionKey: string;
  /** Source that created this upload. */
  source: OfflineUploadSource;
  /** Current upload lifecycle state. */
  state: OfflineUploadState;
  /** Original file name. */
  fileName: string;
  /** MIME type recorded for the staged file. */
  mimeType: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Epoch timestamp when the upload was staged. */
  createdAt: number;
  /** Epoch timestamp for the latest upload metadata change. */
  updatedAt: number;
  /** Final server-side reference after upload completes. */
  resolvedRef?: TResolvedRef;
  /** Latest upload progress snapshot. */
  progress?: OfflineUploadProgress;
  /** Last upload failure message, when any. */
  lastError?: { message: string };
};

/** Persisted offline upload record including the staged file object. */
export type OfflineStoredUploadRecord<
  TResolvedRef extends ValidPayload = ValidPayload,
> = OfflineUpload<TResolvedRef> & {
  /** Staged file blob restored from the upload adapter. */
  file: File;
  /** Last online session start time seen before the upload was stored. */
  lastOnlineSessionStartedAt?: number;
  /** File last-modified timestamp. */
  lastModified: number;
};

/** Storage backend contract for session-scoped offline upload files. */
export type OfflineUploadAdapter = {
  /** Saves or replaces one staged upload record. */
  save<TResolvedRef extends ValidPayload>(
    sessionKey: string,
    id: string,
    record: OfflineStoredUploadRecord<TResolvedRef>,
  ): Promise<void>;
  /** Loads one staged upload record by id. */
  load<TResolvedRef extends ValidPayload>(
    sessionKey: string,
    id: string,
  ): Promise<OfflineStoredUploadRecord<TResolvedRef> | null>;
  /** Lists all staged upload records for a session. */
  list<TResolvedRef extends ValidPayload>(
    sessionKey: string,
  ): Promise<OfflineStoredUploadRecord<TResolvedRef>[]>;
  /** Removes one staged upload record. */
  remove(sessionKey: string, id: string): Promise<void>;
  /** Removes all staged upload records for a session. */
  clearSession(sessionKey: string): Promise<void>;
  /** Test-only reset hook used by TSDF internals. */
  resetForTests?(): void;
};

/** Context passed to the configured offline upload transport. */
export type OfflineUploadTransportContext = {
  /** Stable upload id being transported. */
  id: string;
  /** Session key that owns this upload. */
  sessionKey: string;
  /** File to upload. */
  file: File;
  /** Reports upload progress back to TSDF. */
  onProgress: (progress: OfflineUploadProgress) => void;
};

/** Upload handling config for an offline session. */
export type OfflineSessionUploadsConfig<
  TResolvedRef extends ValidPayload = ValidPayload,
> = {
  /** Adapter used to persist staged files until replay can upload them. */
  adapter: OfflineUploadAdapter;
  /** Upload transport that returns the final server-side file reference. */
  upload: (ctx: OfflineUploadTransportContext) => Promise<TResolvedRef>;
  /** Maximum number of concurrent upload transports. */
  concurrency?: number;
};

/** Files attached to an offline-capable mutation call, keyed by upload id. */
export type OfflineMutationUploadsInput = Record<string, Blob | File>;

export type OfflineAttachedUploadIds = Record<string, string>;

/** Resolved upload files and references available while an offline operation replays. */
export type OfflineOperationUploadsContext<
  TResolvedRef extends ValidPayload = ValidPayload,
> = {
  /** Locally staged files by upload id. */
  filesById: Record<string, File>;
  /** Final uploaded refs by upload id. */
  resolvedRefsById: Record<string, TResolvedRef>;
};
