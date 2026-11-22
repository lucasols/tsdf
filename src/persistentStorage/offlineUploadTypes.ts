import type { ValidPayload } from '../utils/storeShared';
import type { StandardSchemaLike } from './types';

/**
 * Lifecycle state for a session-scoped offline upload.
 *
 * - `pending`: staged and waiting to be uploaded. An upload whose transport
 *   failed with a failure TSDF retries on its own (during replay: session
 *   went offline, or the failure was classified as retryable; during a direct
 *   run of a dependent mutation: the mutation was queued) goes back to
 *   `pending` with `lastError` set.
 * - `uploading`: the `upload` transport is running.
 * - `uploaded`: the transport returned the final ref (`resolvedRef`).
 * - `failed`: the last transport attempt failed and TSDF will not retry on
 *   its own: the dependent operation was moved to manual resolution, the
 *   direct run of a dependent mutation failed without being queued, or the
 *   upload was started through `resolveOfflineUpload(s)`. A failed upload is
 *   not blocked: it is uploaded again when a dependent operation is replayed
 *   (resolution `retry`) or run again, or `resolveOfflineUpload(s)` is called
 *   again.
 */
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
 *   staged, deleted, expired, or already consumed by its mutation). When the
 *   upload was sent and then deleted with the queued work that used it,
 *   `resolvedRef` holds its server ref: render the uploaded file from it
 *   instead of uploading the file again.
 * - `error`: reading the staged file from the upload adapter failed.
 */
export type OfflineUploadFile<
  TResolvedRef extends ValidPayload = ValidPayload,
> =
  | {
      /** Current read status of the staged file. */
      status: 'idle' | 'loading';
      /** Managed object URL of the staged file, only set on `success`. */
      url: null;
      /** Staged file, only set on `success`. */
      file: null;
      /** Read failure, only set on `error`. */
      error: null;
      /** Server ref of an upload released after it was sent, only set on `missing`. */
      resolvedRef: null;
    }
  | {
      /** No upload with this id is staged in the active session. */
      status: 'missing';
      /** Managed object URL of the staged file, only set on `success`. */
      url: null;
      /** Staged file, only set on `success`. */
      file: null;
      /** Read failure, only set on `error`. */
      error: null;
      /**
       * Server ref the upload resolved to, when it was sent and then deleted
       * because the queued work that used it left the queue. It is the ref
       * `resolveOfflineUpload(id)` returns, kept in memory for the rest of the
       * app session in every tab open when the upload was deleted. `null` when
       * the id is unknown: never staged, deleted before it was sent, deleted
       * with `deleteOfflineUpload`, expired, or released before a reload.
       */
      resolvedRef: TResolvedRef | null;
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
      /** Server ref of an upload released after it was sent, only set on `missing`. */
      resolvedRef: null;
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
      /** Server ref of an upload released after it was sent, only set on `missing`. */
      resolvedRef: null;
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
  /**
   * Message of the latest failed upload attempt. It stays set while the upload
   * is retried and is cleared once the upload succeeds.
   */
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
  /**
   * Store whose queued mutation attached this file, set on uploads with
   * `source: 'mutation'`. Custom adapters must persist it: the file is removed
   * once that store's queue no longer uses it.
   */
  storeName?: string;
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
   *
   * Reject (throw) to report a failure. When the upload runs as a dependency
   * of a replayed operation, the thrown error goes through the session's
   * `classifyFailure` / `classifyRetryableFailure` hooks with `ctx.uploadId`
   * set, exactly like a failed `execute`: classify connection problems as
   * `'network'` / `'outage'` (or as retryable) so they are retried, and leave
   * permanent ones (file too large, type not accepted) unclassified so the
   * operation goes to manual resolution. Throw errors those hooks can tell
   * apart.
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

/**
 * Uploads passed to the `mutation` of a `performMutation(...)` call with an
 * `offline` descriptor when it runs directly (online), instead of being
 * queued.
 */
export type OfflineDirectMutationUploadsContext<
  TResolvedRef extends ValidPayload = ValidPayload,
> = {
  /**
   * Final uploaded refs by upload id, for the ids the operation's
   * `dependsOnUploads` returns for the mutation input. TSDF uploads them
   * before `mutation` is called, the same way it does before `execute` on
   * replay, and deletes the staged uploads once `mutation` succeeds. Empty
   * when the operation declares no uploads.
   */
  resolvedRefsById: Record<string, TResolvedRef>;
};

/**
 * Extra context passed to the `mutation` of a `performMutation(...)` call
 * with an `offline` descriptor.
 */
export type OfflineDirectMutationContext<
  TResolvedRef extends ValidPayload = ValidPayload,
> = {
  /** Uploads the operation declares with `dependsOnUploads`, already resolved. */
  uploads: OfflineDirectMutationUploadsContext<TResolvedRef>;
};
