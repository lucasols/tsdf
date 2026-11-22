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

/**
 * Identifies a debounced mutation group: the `context` and `payload` passed
 * to the `debounce` option of `performMutation`.
 */
export type MutationDebounceKey = Pick<MutationDebounce, 'context' | 'payload'>;

function getDebounceKey(debounce: MutationDebounceKey): string {
  return getCompositeKey([debounce.context, debounce.payload]);
}

/**
 * The call of a debounce group waiting for its debounce window, holding the
 * rollbacks of the calls it superseded.
 */
export type PendingDebouncedMutation<TRollback> = {
  rollbacks: TRollback[];
  timer: ReturnType<typeof setTimeout>;
  /** Skips the call, which a newer call of the group superseded */
  skip: () => void;
  /** Ends the call and reverts the optimistic updates of the group */
  cancel: () => void;
};

/**
 * Cancels the call of a debounce group that is waiting for its debounce
 * window, reverting the optimistic updates of the group. Returns whether a
 * call was cancelled.
 */
export function cancelPendingDebouncedMutation<TRollback>(
  pendingDebounces: Map<string, PendingDebouncedMutation<TRollback>>,
  debounce: MutationDebounceKey,
): boolean {
  const debounceKey = getDebounceKey(debounce);
  const pending = pendingDebounces.get(debounceKey);

  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingDebounces.delete(debounceKey);
  pending.cancel();

  return true;
}

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
  pendingDebounces: Map<string, PendingDebouncedMutation<TRollback>>,
  revertCancelledDebounce: (rollbacks: TRollback[]) => void,
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

    // Blocks window close for the whole pending mutation (debounce wait and
    // request), so closing or reloading the tab doesn't drop it
    unblockWindowClose = blockWindowClose?.().unblock ?? null;

    if (debounce) {
      // Superseded calls never send their mutation, so their optimistic
      // changes are handed to the call that superseded them, which reverts
      // all of them if it fails or is cancelled, or completes them if it
      // succeeds
      const debounceKey = getDebounceKey(debounce);
      const superseded = pendingDebounces.get(debounceKey);
      const groupRollbacks = superseded
        ? [...superseded.rollbacks, ...rollbacks]
        : rollbacks;

      if (superseded) {
        clearTimeout(superseded.timer);
        superseded.skip();
      }

      const debounceResult = await new Promise<
        'continue' | 'skip' | 'cancelled'
      >((resolve) => {
        pendingDebounces.set(debounceKey, {
          rollbacks: groupRollbacks,
          timer: setTimeout(() => {
            pendingDebounces.delete(debounceKey);
            resolve('continue');
          }, debounce.ms),
          skip: () => resolve('skip'),
          // Runs synchronously, so a mutation started right after the
          // cancellation (e.g. a delete) starts from the reverted state
          cancel: () => {
            try {
              endMutation();
              revertCancelledDebounce(groupRollbacks);
            } finally {
              resolve('cancelled');
            }
          },
        });
      });

      if (debounceResult !== 'continue') {
        if (debounceResult === 'skip') endMutation();
        return Result.err(mutationSkipped);
      }

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
