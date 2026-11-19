import type { ValidPayload } from '../utils/storeShared';
import type { StandardSchemaLike } from './types';

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
  /**
   * Final server-side reference after upload completes, as returned by the
   * session `upload` transport.
   */
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
   * upload was staged without metadata.
   *
   * The value is restored from storage, so it is typed as an unvalidated
   * JSON-safe payload: parse it (e.g. with a `runcheck` schema) before use.
   */
  metadata?: ValidPayload;
  /** Reports upload progress back to TSDF. */
  onProgress: (progress: OfflineUploadProgress) => void;
};

/**
 * Schema accepted by `offlineSession.uploads.resolvedRefSchema`.
 *
 * Takes the same schemas as an operation `inputSchema`: a `runcheck` type or a
 * Standard Schema v1 (zod, valibot, ...). It is typed only by what the schema
 * outputs, which keeps a store manager with a typed upload ref assignable to
 * the default `StoreManager`.
 */
export type OfflineUploadRefSchema<
  TResolvedRef extends ValidPayload = ValidPayload,
> =
  | StandardSchemaLike<TResolvedRef>
  | {
      /** `runcheck` schemas are matched through their `parse` method. */
      parse: (
        input: unknown,
      ) => { ok: true; value: TResolvedRef } | { ok: false; errors: string[] };
    };

/** Upload handling config for an offline session. */
export type OfflineSessionUploadsConfig<
  TResolvedRef extends ValidPayload = ValidPayload,
> = {
  /** Adapter used to persist staged files until replay can upload them. */
  adapter: OfflineUploadAdapter;
  /**
   * Upload transport that returns the final server-side file reference.
   *
   * Its return type is the upload ref type of the whole session:
   * `createStoreManager` infers it, so `resolveOfflineUpload(s)` and the
   * `OfflineUpload` entries of that manager are typed with it.
   */
  upload: (ctx: OfflineUploadTransportContext) => Promise<TResolvedRef>;
  /**
   * Schema for the ref returned by `upload`.
   *
   * Refs returned by `upload` are trusted, but a ref can also come back from
   * the upload adapter after a reload or from another browser tab, possibly
   * written by a different app version. When this schema is set, those refs
   * are parsed once when they enter the session. A ref that fails is dropped
   * and its upload goes back to `pending`, so the still-staged file is uploaded
   * again the next time the ref is needed instead of a malformed ref reaching
   * `execute`, `resolveOfflineUpload(s)`, or the upload status APIs.
   *
   * Without a schema, restored refs are exposed as they were stored. Async
   * Standard Schemas are not supported: every restored ref fails them.
   */
  resolvedRefSchema?: OfflineUploadRefSchema<TResolvedRef>;
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
  /**
   * Final uploaded refs by upload id, for the ids returned by
   * `dependsOnUploads`. Typed with the upload ref type of the operation
   * definition.
   */
  resolvedRefsById: Record<string, TResolvedRef>;
};
