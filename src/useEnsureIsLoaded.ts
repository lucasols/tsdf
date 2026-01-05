import { useOnEvtmitterEvent } from '@evtmitter/react';
import { useConst } from '@ls-stack/react-utils/useConst';
import { useOnChange } from '@ls-stack/react-utils/useOnChange';
import { evtmitter } from 'evtmitter';
import { useMemo, useState } from 'react';

export function useEnsureIsLoaded(
  ensureIsLoaded: boolean | undefined,
  enabled: boolean,
  forceFetch: () => void,
) {
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

  return [useModifyResult, isLoadedEvtEmitter.emit] as const;
}
