import type { OfflineMutationUploadsInput } from '../offlineUploadTypes';
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

export type PreparedOfflineMutation = {
  initialAction: 'run' | 'queue';
  /** `afterDirectAttempt`: the direct request failed, so it may have been applied */
  queueMutation: (afterDirectAttempt: boolean) => Promise<void>;
  classifyError: (error: unknown) => Promise<boolean>;
  handleDirectSuccess: () => Promise<void>;
};

export type OfflineAwareMutationController<
  TOperations extends Record<string, OfflineOperationSchemaShape>,
> = {
  canQueueMutation: () => boolean;
  prepareForMutation: <TName extends keyof TOperations & string>(args: {
    offline: OfflineMutationInput<TOperations, TName>;
    upload?: OfflineMutationUploadsInput;
  }) => Promise<PreparedOfflineMutation>;
};

export async function runHybridOfflineMutation<
  T,
  TOperations extends Record<string, OfflineOperationSchemaShape>,
  TName extends keyof TOperations & string,
>(
  controller: OfflineAwareMutationController<TOperations> | null | undefined,
  offline: OfflineMutationInput<TOperations, TName> | undefined,
  upload: OfflineMutationUploadsInput | undefined,
  directMutation: () => Promise<T>,
): Promise<OfflineMutationResult<T>> {
  if (!offline || !controller) {
    throw new Error(
      'runHybridOfflineMutation requires an offline mutation and controller',
    );
  }

  const prepared = await controller.prepareForMutation({ offline, upload });

  if (prepared.initialAction === 'queue') {
    await prepared.queueMutation(false);
    return { kind: 'queued' };
  }

  try {
    const data = await directMutation();
    await prepared.handleDirectSuccess();
    return { kind: 'online', data };
  } catch (error) {
    const shouldQueue = await prepared.classifyError(error);
    if (!shouldQueue) {
      throw error;
    }

    await prepared.queueMutation(true);
    return { kind: 'queued' };
  }
}
