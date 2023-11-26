import { evtmitter } from 'evtmitter';
import { useOnEvtmitterEvent } from 'evtmitter/react';
import { useMemo, useState } from 'react';
import { useConst, useOnChange } from './utils/hooks';

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

  useOnEvtmitterEvent(isLoadedEvtEmitter, 'isLoaded', (isLoaded) => {
    if (ensureIsLoaded && enabled && isLoaded) {
      setIsForceLoading(false);
    }
  });

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
      // eslint-disable-next-line @lucasols/extended-lint/exhaustive-deps
    }, [ensureIsLoaded, isForceLoading, result]);
  }

  return [useModifyResult, isLoadedEvtEmitter.emit] as const;
}
