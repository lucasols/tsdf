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

/** Arguments for staging a session-scoped offline upload. */
export type SaveOfflineUploadArgs = {
  /** Stable upload id referenced by offline operation inputs. */
  id: string;
  /** File to stage until it can be uploaded. */
  file: Blob | File;
  /**
   * App-defined, JSON-serializable metadata persisted with the upload. It is
   * handed to the session `upload` transport and exposed on the `OfflineUpload`
   * status entries. Saving over an existing id stores exactly this value, so
   * omitting it leaves the upload without metadata.
   */
  metadata?: ValidPayload;
};

/** Arguments for replacing the file of a staged session-scoped offline upload. */
export type ReplaceOfflineUploadArgs = {
  /** Id of the staged upload to replace. */
  id: string;
  /** New file for the upload. */
  file: Blob | File;
  /**
   * New metadata for the upload. Omit it to keep the metadata already saved
   * for this id.
   */
  metadata?: ValidPayload;
};

/**
 * File of a staged upload, as returned by
 * `storeManager.useOfflineUploadFile(id)`.
 *
 * `url` is an object URL managed by TSDF: it is created once per staged file
 * while at least one component uses the id, shared by every component using
 * that id, and revoked shortly after the last one stops using it or as soon
 * as the upload is replaced, deleted or leaves the session. Render it directly
 * (e.g. `<img src={url}>`), never revoke it, and do not keep it outside of
 * render: always use the latest value returned by the hook.
 *
 * Narrow on `status`:
 *
 * - `idle`: the hook was called with a falsy id.
 * - `loading`: the staged file is being read. Files the session already holds
 *   skip this state and are returned on the first render.
 * - `success`: the file is staged; `url` and `file` are available.
 * - `missing`: no upload with this id is staged in the active session (never
 *   staged, deleted, expired, or already consumed by its mutation).
 * - `error`: reading the staged file from the upload adapter failed.
 */
export type OfflineUploadFile =
  | {
      /** Current read status of the staged file. */
      status: 'idle' | 'loading' | 'missing';
      /** Managed object URL of the staged file, only set on `success`. */
      url: null;
      /** Staged file, only set on `success`. */
      file: null;
      /** Read failure, only set on `error`. */
      error: null;
    }
  | {
      /** The file is staged and ready to render. */
      status: 'success';
      /** Managed object URL of the staged file. Do not revoke it. */
      url: string;
      /**
       * Staged file, for reading its contents. Use `url` to render it instead
       * of creating another object URL from this file.
       */
      file: File;
      /** Read failure, only set on `error`. */
      error: null;
    }
  | {
      /** Reading the staged file from the upload adapter failed. */
      status: 'error';
      /** Managed object URL of the staged file, only set on `success`. */
      url: null;
      /** Staged file, only set on `success`. */
      file: null;
      /** Failure reported by the upload adapter. */
      error: Error;
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
  /**
   * App-defined metadata saved with the upload through `saveOfflineUpload` /
   * `replaceOfflineUpload`. It is persisted with the upload record, so it is
   * restored from storage after a reload and must be narrowed before use.
   */
  metadata?: ValidPayload;
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
  /**
   * App-defined metadata saved with this upload, for request parameters that
   * differ per upload (target kind, parent ids, ...). `undefined` when the
   * upload was staged without metadata, which is always the case for files
   * attached directly to a mutation with its `upload` option.
   *
   * The value is restored from storage, so it is typed as an unvalidated
   * JSON-safe payload: parse it (e.g. with a `runcheck` schema) before use.
   */
  metadata?: ValidPayload;
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
