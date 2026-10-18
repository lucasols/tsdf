import { awaitDebounce } from '@ls-stack/utils/awaitDebounce';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { Result, type Result as TResult } from 't-result';
import { mutationSkipped, type MutationSkipped } from './storeShared';

/** Starts a temporary window-close block while a mutation is in progress. */
export type BlockWindowCloseHandler = () => {
  /** Releases the window-close block. */
  unblock: () => void;
};

/** Debounce settings for mutation calls sharing a logical context and payload. */
export type MutationDebounce = {
  /** Logical namespace for the debounced mutation group. */
  context: string;
  /** Payload compared with the context to decide which calls supersede each other. */
  payload: unknown;
  /** Debounce window in milliseconds. */
  ms: number;
};

type ResultError =
  | Error
  | Record<string, unknown>
  | unknown[]
  | readonly unknown[];

export async function performMutationWithLifecycle<
  T,
  TError extends ResultError,
  TRollback,
>(
  startMutation: () => () => unknown,
  mutation: () => Promise<T>,
  onError: (exception: unknown, rollbacks: TRollback[]) => TError,
  optimisticUpdate:
    | ((addRollback: (rollback: TRollback) => void) => void | boolean)
    | undefined,
  onSuccess: ((result: Awaited<T>, rollbacks: TRollback[]) => void) | undefined,
  debounce: MutationDebounce | undefined,
  blockWindowClose: BlockWindowCloseHandler | null | undefined,
  pendingDebounceRollbacks: Map<string, TRollback[]>,
): Promise<TResult<Awaited<T>, TError | MutationSkipped>> {
  const endMutation = startMutation();

  let unblockWindowClose: VoidFunction | null = null;
  let rollbacks: TRollback[] = [];
  let mutationSucceeded = false;

  try {
    if (
      optimisticUpdate?.((rollback) => {
        rollbacks.push(rollback);
      }) === false
    ) {
      endMutation();
      return Result.err(mutationSkipped);
    }

    if (debounce) {
      unblockWindowClose = blockWindowClose?.().unblock ?? null;

      // Superseded calls never send their mutation, so their optimistic
      // changes are handed to the call that superseded them, which reverts
      // all of them if it fails, or completes them if it succeeds
      const debounceKey = getCompositeKey([debounce.context, debounce.payload]);
      const groupRollbacks = pendingDebounceRollbacks.get(debounceKey) ?? [];
      groupRollbacks.push(...rollbacks);
      pendingDebounceRollbacks.set(debounceKey, groupRollbacks);

      const debounceResult = await awaitDebounce({
        callId: debounceKey,
        debounce: debounce.ms,
      });

      if (debounceResult === 'skip') {
        endMutation();
        return Result.err(mutationSkipped);
      }

      pendingDebounceRollbacks.delete(debounceKey);
      rollbacks = groupRollbacks;
    }

    const result = await mutation();
    mutationSucceeded = true;

    endMutation();
    onSuccess?.(result, rollbacks);

    return Result.ok(result);
  } catch (exception) {
    endMutation();

    // The server accepted the mutation if only `onSuccess` threw, so its
    // optimistic updates are kept
    return Result.err(onError(exception, mutationSucceeded ? [] : rollbacks));
  } finally {
    unblockWindowClose?.();
  }
}
