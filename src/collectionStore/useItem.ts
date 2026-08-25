import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { useMemo } from 'react';
import { Store, useSubscribeToStore } from 't-state';
import { FetchType } from '../requestScheduler';
import { assertNoRequireFreshDataWithDebouncePayload } from '../utils/payloadDebounce';
import {
  ValidPayload,
  ValidStoreState,
  invalidPayloadError,
} from '../utils/storeShared';
import { useRequireFreshData } from '../utils/useRequireFreshData';
import type {
  CollectionUseMultipleItemsQuery,
  TSFDCollectionState,
  TSFDUseCollectionItemReturn,
} from './collectionStore';
import { UseMultipleItemsOptions } from './useMultipleItems';

export type UseItemOptions<
  ItemState extends ValidStoreState,
  Selected,
> = UseMultipleItemsOptions<ItemState, Selected> & {
  /**
   * Unconditionally schedules a high-priority fetch on mount and reports
   * `loading` until that refresh succeeds or fails, even when cached data
   * exists. Use sparingly because each mount can cause an extra request.
   * Cannot be combined with `debouncePayload`.
   */
  requireFreshData?: boolean;
};

export function useItem<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  Selected = ItemState | null,
>(
  payload: ItemPayload | undefined | false | null,
  {
    omitPayload,
    selector,
    requireFreshData,
    returnRefetchingStatus,
    disableRefetches,
    disableRefetchOnMount,
    returnIdleStatus,
    isOffScreen,
    debouncePayload,
  }: UseItemOptions<ItemState, Selected>,
  store: Store<TSFDCollectionState<ItemState, ItemPayload>>,
  scheduleFetch: (fetchType: FetchType, payload: ItemPayload) => void,
  useMultipleItems: <S = ItemState | null>(
    items: CollectionUseMultipleItemsQuery<ItemPayload, undefined>[],
    options: UseMultipleItemsOptions<ItemState, S>,
  ) => readonly TSFDUseCollectionItemReturn<S, ItemPayload, undefined>[],
): TSFDUseCollectionItemReturn<Selected, ItemPayload> {
  const isInvalidPayload = payload === '';
  const hasPayload =
    payload !== false &&
    payload !== null &&
    payload !== undefined &&
    payload !== '';

  assertNoRequireFreshDataWithDebouncePayload(
    'useItem',
    requireFreshData,
    debouncePayload,
  );

  const query = useMemo(
    (): CollectionUseMultipleItemsQuery<ItemPayload, undefined>[] =>
      hasPayload
        ? [
            {
              payload,
              omitPayload,
              returnRefetchingStatus,
              disableRefetches,
              disableRefetchOnMount,
              returnIdleStatus,
              isOffScreen,
            },
          ]
        : [],
    [
      disableRefetches,
      disableRefetchOnMount,
      hasPayload,
      isOffScreen,
      omitPayload,
      payload,
      returnIdleStatus,
      returnRefetchingStatus,
    ],
  );

  const item = useMultipleItems(query, { selector, debouncePayload });

  const result = useMemo(
    (): TSFDUseCollectionItemReturn<Selected, ItemPayload> =>
      item[0] ??
      (isInvalidPayload
        ? {
            payload: undefined,
            data: selector
              ? selector(null)
              : // WORKAROUND: Runtime selector presence does not narrow the generic Selected type, but the fallback branch returns the raw null state.
                __LEGIT_CAST__<Selected, null>(null),
            error: invalidPayloadError,
            status: 'error',
            itemStateKey: '',
            isLoading: false,
            pendingSync: false,
            queryMetadata: undefined,
          }
        : {
            payload: undefined,
            data: selector
              ? selector(null)
              : // WORKAROUND: Runtime selector presence does not narrow the generic Selected type, but the fallback branch returns the raw null state.
                __LEGIT_CAST__<Selected, null>(null),
            error: null,
            status: 'idle',
            itemStateKey: '',
            isLoading: false,
            pendingSync: false,
            queryMetadata: undefined,
          }),
    [isInvalidPayload, item, selector],
  );

  const fetchQuery = hasPayload ? query[0] : undefined;

  const [useModifyResult, markRefreshSettled] = useRequireFreshData(
    requireFreshData,
    hasPayload,
    () => {
      if (fetchQuery) {
        scheduleFetch('highPriority', fetchQuery.payload);
      }
    },
  );

  useSubscribeToStore(store, ({ observe }) => {
    if (!requireFreshData || !hasPayload || !result.itemStateKey) {
      return;
    }

    observe
      .ifSelector((state) => {
        return state[result.itemStateKey]?.status;
      })
      .change.then(({ current }) => {
        if (current === 'success' || current === 'error') {
          markRefreshSettled();
        }
      });
  });

  return useModifyResult(result);
}
