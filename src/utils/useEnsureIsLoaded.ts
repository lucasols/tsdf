import { useOnEvtmitterEvent } from '@evtmitter/react';
import { useConst } from '@ls-stack/react-utils/useConst';
import { useOnChange } from '@ls-stack/react-utils/useOnChange';
import { evtmitter } from 'evtmitter';
import { useMemo, useState } from 'react';

type EnsureIsLoadedResultModifier = <
  T extends { isLoading: boolean; status: string },
>(
  result: T,
) => T;

export function useEnsureIsLoaded(
  ensureIsLoaded: boolean | undefined,
  enabled: boolean,
  forceFetch: () => void,
): readonly [EnsureIsLoadedResultModifier, () => void] {
  const isLoadedEvtEmitter = useConst(() => evtmitter<{ isLoaded: boolean }>());

  const [isForceLoading, setIsForceLoading] = useState(true);

  useOnChange(
    ensureIsLoaded && isForceLoading && enabled,
    ({ current }) => {
      if (current) {
        forceFetch();
      }
    },
    { callOnMount: true },
  );

  useOnEvtmitterEvent(
    isLoadedEvtEmitter,
    'isLoaded',
    ({ payload: isLoaded }) => {
      if (ensureIsLoaded && enabled && isLoaded) {
        setIsForceLoading(false);
      }
    },
  );

  function useModifyResult<T extends { isLoading: boolean; status: string }>(
    result: T,
  ): T {
    return useGetModifyResult<T>(
      result,
      ensureIsLoaded,
      enabled,
      isForceLoading,
    );
  }

  return [
    useModifyResult,
    () => isLoadedEvtEmitter.emit('isLoaded', true),
  ] as const;
}

function useGetModifyResult<T extends { isLoading: boolean; status: string }>(
  result: T,
  ensureIsLoaded: boolean | undefined,
  enabled: boolean,
  isForceLoading: boolean,
) {
  return useMemo(() => {
    if (ensureIsLoaded) {
      const newStatus = enabled && isForceLoading ? 'loading' : result.status;

      return {
        ...result,
        isLoading: newStatus === 'loading',
        status: newStatus,
      };
    }

    return result;
  }, [ensureIsLoaded, isForceLoading, result, enabled]);
}
