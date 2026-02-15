import { awaitDebounce } from '@ls-stack/utils/awaitDebounce';
import { Result, type Result as TResult } from 't-result';

export type MutationDebounce = {
  context: string;
  payload: unknown;
  ms: number;
};

type ResultError =
  | Error
  | Record<string, unknown>
  | unknown[]
  | readonly unknown[]
  | true;

type MutationLifecycleOptions<T, TError extends ResultError> = {
  startMutation: () => () => unknown;
  mutation: () => Promise<T>;
  onError: (exception: unknown) => TError;
  optimisticUpdate?: () => void | boolean;
  onSuccess?: (result: Awaited<T>) => void;
  debounce?: MutationDebounce;
  blockWindowClose?: () => { unblock: () => void };
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
  TResult<Awaited<T>, TError | true>
> {
  const endMutation = startMutation();

  if (optimisticUpdate?.() === false) {
    endMutation();
    return Result.err(true);
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
        return Result.err(true);
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
