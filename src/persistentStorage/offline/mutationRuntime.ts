import type { OfflineMutationUploadsInput } from '../offlineUploadTypes';
import type {
  OfflineMutationInput,
  OfflineOperationSchemaShape,
} from './types';

/**
 * Successful result of an offline-enabled mutation attempt.
 *
 * `online` means the direct request completed and returned the server payload.
 * `queued` means the mutation was durably persisted for offline replay.
 */
export type OfflineMutationResult<T> =
  | { kind: 'online'; data: Awaited<T> }
  | { kind: 'queued' };

export type PreparedOfflineMutation = {
  initialAction: 'run' | 'queue';
  queueMutation: () => Promise<void>;
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
>({
  controller,
  offline,
  upload,
  directMutation,
}: {
  controller?: OfflineAwareMutationController<TOperations> | null;
  offline?: OfflineMutationInput<TOperations, TName> | undefined;
  upload?: OfflineMutationUploadsInput | undefined;
  directMutation: () => Promise<T>;
}): Promise<OfflineMutationResult<T>> {
  if (!offline || !controller) {
    throw new Error(
      'runHybridOfflineMutation requires an offline mutation and controller',
    );
  }

  const prepared = await controller.prepareForMutation({ offline, upload });

  if (prepared.initialAction === 'queue') {
    await prepared.queueMutation();
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

    await prepared.queueMutation();
    return { kind: 'queued' };
  }
}
