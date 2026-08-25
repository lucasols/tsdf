import { useOnEvtmitterEvent } from '@evtmitter/react';
import { useConst } from '@ls-stack/react-utils/useConst';
import { useOnChange } from '@ls-stack/react-utils/useOnChange';
import { evtmitter } from 'evtmitter';
import { useMemo, useState } from 'react';

type RequireFreshDataResultModifier = <
  T extends { isLoading: boolean; status: string },
>(
  result: T,
) => T;

export function useRequireFreshData(
  requireFreshData: boolean | undefined,
  enabled: boolean,
  forceFetch: () => void,
): readonly [RequireFreshDataResultModifier, () => void] {
  const refreshSettledEvtEmitter = useConst(() =>
    evtmitter<{ refreshSettled: boolean }>(),
  );

  const [isWaitingForRefresh, setIsWaitingForRefresh] = useState(true);

  useOnChange(
    requireFreshData && isWaitingForRefresh && enabled,
    ({ current }) => {
      if (current) {
        forceFetch();
      }
    },
    { callOnMount: true },
  );

  useOnEvtmitterEvent(
    refreshSettledEvtEmitter,
    'refreshSettled',
    ({ payload: refreshSettled }) => {
      if (requireFreshData && enabled && refreshSettled) {
        setIsWaitingForRefresh(false);
      }
    },
  );

  function useModifyResult<T extends { isLoading: boolean; status: string }>(
    result: T,
  ): T {
    return useGetModifyResult<T>(
      result,
      requireFreshData,
      enabled,
      isWaitingForRefresh,
    );
  }

  return [
    useModifyResult,
    () => refreshSettledEvtEmitter.emit('refreshSettled', true),
  ] as const;
}

function useGetModifyResult<T extends { isLoading: boolean; status: string }>(
  result: T,
  requireFreshData: boolean | undefined,
  enabled: boolean,
  isWaitingForRefresh: boolean,
) {
  return useMemo(() => {
    if (requireFreshData) {
      const newStatus =
        enabled && isWaitingForRefresh ? 'loading' : result.status;

      return {
        ...result,
        isLoading: newStatus === 'loading',
        status: newStatus,
      };
    }

    return result;
  }, [requireFreshData, isWaitingForRefresh, result, enabled]);
}
