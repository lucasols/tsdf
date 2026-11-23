import type { ValidPayload } from '../../utils/storeShared';
import type {
  OfflineDirectMutationContext,
  OfflineMutationUploadsInput,
} from '../offlineUploadTypes';
import type {
  OfflineMutationInput,
  OfflineOperationSchemaShape,
} from './types';

/**
 * Successful result of an offline-enabled mutation attempt.
 *
 * `online` means the direct request completed and returned the server payload.
 * `queued` means the mutation was queued for offline replay. It is normally
 * persisted, but if the queue write failed (reported through
 * `onPersistentStorageError`) it is only kept in memory (`inMemoryOnly`) until
 * the page reloads.
 */
export type OfflineMutationResult<T> =
  | {
      /** The direct online mutation completed successfully. */
      kind: 'online';
      /** Server payload returned by the direct mutation. */
      data: Awaited<T>;
    }
  | {
      /**
       * The mutation was queued for offline replay. If the queue write failed
       * (reported through `onPersistentStorageError`), it is only kept in
       * memory until the page reloads.
       */
      kind: 'queued';
      /**
       * Set (to `true`) when the queue write failed, so the mutation is only
       * kept in memory: it is still synced, but reloading or closing the tab
       * before that loses it. Only describes the moment the mutation was
       * queued: follow `inMemoryOnlyMutations` in the offline status (or
       * `isInMemoryOnly` on the offline entities) to know when a later write
       * stored it or it synced.
       */
      inMemoryOnly?: true;
    };

/** Outcome of resolving the dependency uploads of a direct run. */
type DirectMutationUploadsResolution =
  | {
      failedUploadId?: undefined;
      refs: Record<string, ValidPayload>;
      refusedUploadErrorsById: Record<string, unknown>;
    }
  | {
      failedUploadId: string;
      error: unknown;
      /**
       * `classifyError` result for this failure when it was already
       * classified (an optional upload), so it is not classified again.
       */
      shouldQueue: boolean | undefined;
    };

export type PreparedOfflineMutation = {
  initialAction: 'run' | 'queue';
  /**
   * `afterDirectAttempt`: the direct request failed, so it may have been
   * applied. Resolves with whether the queued work is only held in memory.
   */
  queueMutation: (afterDirectAttempt: boolean) => Promise<boolean>;
  /** `uploadId`: the failure came from resolving that dependency upload */
  classifyError: (
    error: unknown,
    uploadId: string | undefined,
  ) => Promise<boolean>;
  /**
   * Uploads the operation's dependency uploads before the direct request.
   * `null` when the operation declares none for this input.
   */
  resolveDirectUploads: (() => Promise<DirectMutationUploadsResolution>) | null;
  /**
   * The validated `offline` input for the direct request, with the temp
   * payloads of creations saved since the call replaced by their final ones
   */
  getDirectInput: () => unknown;
  /**
   * Marks the dependency uploads `failed` when a failed upload was not queued,
   * including the ones still being sent that fail too
   */
  markUploadsFailed: () => Promise<void>;
  /**
   * Also releases the dependency uploads the direct request consumed, which
   * excludes the refused optional ones
   */
  handleDirectSuccess: () => Promise<void>;
  /**
   * The mutation no longer holds its reserved queue position: it was queued
   * (the queue write settled), or its direct run succeeded or failed without
   * being queued
   */
  releaseQueueOrder: () => void;
};

export type OfflineAwareMutationController<
  TOperations extends Record<string, OfflineOperationSchemaShape>,
> = {
  canQueueMutation: () => boolean;
  /** The final payload of a temp entity whose creation was saved */
  resolveEntityRef: <TRef extends ValidPayload>(entityRef: TRef) => TRef;
  prepareForMutation: <TName extends keyof TOperations & string>(args: {
    offline: OfflineMutationInput<TOperations, TName>;
    upload?: OfflineMutationUploadsInput;
  }) => Promise<PreparedOfflineMutation>;
  /**
   * Runs the direct request of a mutation that can't be queued (session gate
   * closed), with the dependency uploads resolved before it and released
   * after it succeeds.
   */
  runUnqueuedMutation: <T, TName extends keyof TOperations & string>(
    offline: OfflineMutationInput<TOperations, TName>,
    directMutation: (ctx: OfflineDirectMutationContext) => Promise<T>,
  ) => Promise<T>;
};

export function createDirectMutationContext(
  offlineInput: unknown,
  resolvedRefsById: Record<string, ValidPayload> = {},
  refusedUploadErrorsById: Record<string, unknown> = {},
): OfflineDirectMutationContext {
  return {
    uploads: { resolvedRefsById, refusedUploadErrorsById },
    offlineInput,
  };
}

export async function runHybridOfflineMutation<
  T,
  TOperations extends Record<string, OfflineOperationSchemaShape>,
  TName extends keyof TOperations & string,
>(
  controller: OfflineAwareMutationController<TOperations>,
  offline: OfflineMutationInput<TOperations, TName>,
  upload: OfflineMutationUploadsInput | undefined,
  directMutation: (ctx: OfflineDirectMutationContext) => Promise<T>,
): Promise<OfflineMutationResult<T>> {
  // Without an active offline session (no session key, or the session gate
  // is closed) it runs as a plain online mutation
  if (!controller.canQueueMutation()) {
    return {
      kind: 'online',
      data: await controller.runUnqueuedMutation(offline, directMutation),
    };
  }

  const prepared = await controller.prepareForMutation({ offline, upload });

  if (prepared.initialAction === 'queue') {
    try {
      return toQueuedResult(await prepared.queueMutation(false));
    } finally {
      prepared.releaseQueueOrder();
    }
  }

  // Set when resolving a dependency upload failed, which means the direct
  // request was never sent.
  let failedUploadId: string | undefined;
  let classifiedShouldQueue: boolean | undefined;

  try {
    let resolvedRefsById: Record<string, ValidPayload> = {};
    let refusedUploadErrorsById: Record<string, unknown> = {};
    if (prepared.resolveDirectUploads) {
      const resolution = await prepared.resolveDirectUploads();
      if (resolution.failedUploadId !== undefined) {
        failedUploadId = resolution.failedUploadId;
        classifiedShouldQueue = resolution.shouldQueue;
        throw resolution.error;
      }
      resolvedRefsById = resolution.refs;
      refusedUploadErrorsById = resolution.refusedUploadErrorsById;
    }

    const data = await directMutation(
      createDirectMutationContext(
        // Rewritten right before the request, as the item payloads `mutation`
        // receives are
        prepared.getDirectInput(),
        resolvedRefsById,
        refusedUploadErrorsById,
      ),
    );
    await prepared.handleDirectSuccess();
    return { kind: 'online', data };
  } catch (error) {
    const shouldQueue =
      classifiedShouldQueue ??
      (await prepared.classifyError(error, failedUploadId));
    if (!shouldQueue) {
      if (failedUploadId !== undefined) await prepared.markUploadsFailed();
      throw error;
    }

    // The queued mutation keeps declaring its uploads, so they stay staged
    // for the replay.
    return toQueuedResult(
      await prepared.queueMutation(failedUploadId === undefined),
    );
  } finally {
    prepared.releaseQueueOrder();
  }
}

function toQueuedResult(inMemoryOnly: boolean): {
  kind: 'queued';
  inMemoryOnly?: true;
} {
  return inMemoryOnly
    ? { kind: 'queued', inMemoryOnly: true }
    : { kind: 'queued' };
}
