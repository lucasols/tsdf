import { useOnEvtmitterEvent } from '@evtmitter/react';
import { useConst } from '@ls-stack/react-utils/useConst';
import { useOnChange } from '@ls-stack/react-utils/useOnChange';
import { evtmitter } from 'evtmitter';
import { useMemo, useState } from 'react';
import type { RequireFreshData } from './storeShared';

type RequireFreshDataResultModifier = <
  T extends { isLoading: boolean; status: string },
>(
  result: T,
) => T;

export function useRequireFreshData(
  requireFreshData: RequireFreshData | undefined,
  enabled: boolean,
  targetKey: string,
  isRestoredFromStorage: boolean,
  /**
   * Schedules the fetch, or calls `skipRefresh` when there is nothing to fetch
   * (e.g. an item that only exists locally), so the result stops loading
   */
  forceFetch: (skipRefresh: () => void) => void,
): readonly [RequireFreshDataResultModifier, () => void] {
  const refreshSettledEvtEmitter = useConst(() =>
    evtmitter<{ refreshSettled: boolean }>(),
  );

  // `true` requires one settled refresh per mount, while `'ifFromStorage'`
  // tracks it per target so switching to other restored data waits again
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const isWaitingForRefresh =
    requireFreshData === true ? settledKey === null : settledKey !== targetKey;
  const required =
    requireFreshData === true ||
    (requireFreshData === 'ifFromStorage' && isRestoredFromStorage);
  const waitsForRefresh = required && isWaitingForRefresh && enabled;

  useOnChange(
    waitsForRefresh && (requireFreshData === true || targetKey),
    ({ current }) => {
      if (current !== false) {
        // the skip can be reported after the target changed, so it settles
        // the target the fetch was scheduled for
        const scheduledKey = targetKey;
        forceFetch(() => setSettledKey(scheduledKey));
      }
    },
    { callOnMount: true },
  );

  useOnEvtmitterEvent(
    refreshSettledEvtEmitter,
    'refreshSettled',
    ({ payload: refreshSettled }) => {
      if (required && enabled && refreshSettled) {
        setSettledKey(targetKey);
      }
    },
  );

  function useModifyResult<T extends { isLoading: boolean; status: string }>(
    result: T,
  ): T {
    return useGetModifyResult<T>(
      result,
      required,
      enabled,
      isWaitingForRefresh,
    );
  }

  return [
    useModifyResult,
    () => refreshSettledEvtEmitter.emit('refreshSettled', true),
  ] as const;
}

/**
 * Whether a status change settles the `requireFreshData` refresh: a fetch
 * ending, or fresh data received from another tab. Data read back from storage
 * also becomes `success`, but only from no state or `idle`, and isn't fresh,
 * e.g. while the refresh waits for the queued offline work to be read.
 */
export function settlesRefresh(
  prev: string | undefined,
  current: string | undefined,
  isRestoredFromStorage: () => boolean,
): boolean {
  if (current !== 'success' && current !== 'error') return false;
  if (prev !== undefined && prev !== 'idle') return true;

  return !isRestoredFromStorage();
}

function useGetModifyResult<T extends { isLoading: boolean; status: string }>(
  result: T,
  required: boolean,
  enabled: boolean,
  isWaitingForRefresh: boolean,
) {
  return useMemo(() => {
    if (required) {
      const newStatus =
        enabled && isWaitingForRefresh ? 'loading' : result.status;

      return {
        ...result,
        isLoading: newStatus === 'loading',
        status: newStatus,
      };
    }

    return result;
  }, [required, isWaitingForRefresh, result, enabled]);
}
