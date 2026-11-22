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
 * `onPersistentStorageError`) it is only kept in memory until the page reloads.
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
    };

/** Outcome of resolving the dependency uploads of a direct run. */
type DirectMutationUploadsResolution =
  | { failedUploadId?: undefined; refs: Record<string, ValidPayload> }
  | { failedUploadId: string; error: unknown };

export type PreparedOfflineMutation = {
  initialAction: 'run' | 'queue';
  /** `afterDirectAttempt`: the direct request failed, so it may have been applied */
  queueMutation: (afterDirectAttempt: boolean) => Promise<void>;
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
   * Marks the dependency uploads `failed` when a failed upload was not queued,
   * including the ones still being sent that fail too
   */
  markUploadsFailed: () => Promise<void>;
  /** Also releases the dependency uploads the direct request consumed */
  handleDirectSuccess: () => Promise<void>;
  /**
   * The direct run ended: it succeeded, failed, or fell back to the queue and
   * the queue write settled
   */
  finishDirectRun: () => void;
};

export type OfflineAwareMutationController<
  TOperations extends Record<string, OfflineOperationSchemaShape>,
> = {
  canQueueMutation: () => boolean;
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
  resolvedRefsById: Record<string, ValidPayload>,
): OfflineDirectMutationContext {
  return { uploads: { resolvedRefsById } };
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
    await prepared.queueMutation(false);
    return { kind: 'queued' };
  }

  // Set when resolving a dependency upload failed, which means the direct
  // request was never sent.
  let failedUploadId: string | undefined;

  try {
    let resolvedRefsById: Record<string, ValidPayload> = {};
    if (prepared.resolveDirectUploads) {
      const resolution = await prepared.resolveDirectUploads();
      if (resolution.failedUploadId !== undefined) {
        failedUploadId = resolution.failedUploadId;
        throw resolution.error;
      }
      resolvedRefsById = resolution.refs;
    }

    const data = await directMutation(
      createDirectMutationContext(resolvedRefsById),
    );
    await prepared.handleDirectSuccess();
    return { kind: 'online', data };
  } catch (error) {
    const shouldQueue = await prepared.classifyError(error, failedUploadId);
    if (!shouldQueue) {
      if (failedUploadId !== undefined) await prepared.markUploadsFailed();
      throw error;
    }

    // The queued mutation keeps declaring its uploads, so they stay staged
    // for the replay.
    await prepared.queueMutation(failedUploadId === undefined);
    return { kind: 'queued' };
  } finally {
    prepared.finishDirectRun();
  }
}
