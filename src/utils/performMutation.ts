import { awaitDebounce } from '@ls-stack/utils/awaitDebounce';
import { Result, type Result as TResult } from 't-result';
import { mutationSkipped, type MutationSkipped } from './storeShared';

export type BlockWindowCloseHandler = () => { unblock: () => void };

export type MutationDebounce = {
  context: string;
  payload: unknown;
  ms: number;
};

type ResultError =
  | Error
  | Record<string, unknown>
  | unknown[]
  | readonly unknown[];

type MutationLifecycleOptions<T, TError extends ResultError> = {
  startMutation: () => () => unknown;
  mutation: () => Promise<T>;
  onError: (exception: unknown) => TError;
  optimisticUpdate: (() => void | boolean) | undefined;
  onSuccess: ((result: Awaited<T>) => void) | undefined;
  debounce: MutationDebounce | undefined;
  blockWindowClose: BlockWindowCloseHandler | null | undefined;
};

export async function performMutationWithLifecycle<
  T,
  TError extends ResultError,
>({
  startMutation,
  mutation,
  onError,
  optimisticUpdate,
  onSuccess,
  debounce,
  blockWindowClose,
}: MutationLifecycleOptions<T, TError>): Promise<
  TResult<Awaited<T>, TError | MutationSkipped>
> {
  const endMutation = startMutation();

  if (optimisticUpdate?.() === false) {
    endMutation();
    return Result.err(mutationSkipped);
  }

  let unblockWindowClose: VoidFunction | null = null;

  try {
    if (debounce) {
      unblockWindowClose = blockWindowClose?.().unblock ?? null;

      const debounceResult = await awaitDebounce({
        callId: [debounce.context, debounce.payload],
        debounce: debounce.ms,
      });

      if (debounceResult === 'skip') {
        endMutation();
        return Result.err(mutationSkipped);
      }
    }

    const result = await mutation();

    endMutation();
    onSuccess?.(result);

    return Result.ok(result);
  } catch (exception) {
    endMutation();

    return Result.err(onError(exception));
  } finally {
    unblockWindowClose?.();
  }
}
