import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { useMemo } from 'react';
import { Store, useSubscribeToStore } from 't-state';
import { FetchType, ScheduleFetchResults } from '../requestScheduler';
import { assertNoRequireFreshDataWithDebouncePayload } from '../utils/payloadDebounce';
import {
  ValidPayload,
  ValidStoreState,
  invalidPayloadError,
} from '../utils/storeShared';
import { useRequireFreshData } from '../utils/useRequireFreshData';
import type {
  FieldsInput,
  ListQueryUseMultipleItemsQuery,
  TSFDListQueryState,
  TSFDUseListItemReturn,
} from './types';
import type { UseMultipleItemsOptions } from './useMultipleItems';

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
  /**
   * Partial-resource fields to request for this item.
   *
   * Pass `'*'` to fetch the complete item. This option is required when
   * `partialResources` is enabled and optional otherwise.
   */
  fields?: FieldsInput;
  /**
   * When requested fields are missing but cached partial data exists, return
   * `refetching` instead of `loading`.
   */
  showPartialAsRefetching?: boolean;
};

export function useItem<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  Selected = ItemState | null,
>(
  itemPayload: ItemPayload | false | null | undefined,
  {
    selector,
    requireFreshData,
    loadFromStateOnly,
    disableRefetches,
    disableRefetchOnMount,
    returnIdleStatus,
    returnRefetchingStatus,
    showPartialAsRefetching,
    isOffScreen,
    fields,
    debouncePayload,
  }: UseItemOptions<ItemState, Selected>,
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  scheduleItemFetch: (
    fetchType: FetchType,
    payload: ItemPayload,
    options?: { fields?: FieldsInput },
  ) => ScheduleFetchResults,
  useMultipleItems: <S = ItemState | null>(
    items: ListQueryUseMultipleItemsQuery<ItemPayload, undefined>[],
    options: UseMultipleItemsOptions<ItemState, S>,
  ) => readonly TSFDUseListItemReturn<S, ItemPayload, undefined>[],
): TSFDUseListItemReturn<Selected, ItemPayload> {
  const isInvalidPayload = itemPayload === '';
  const hasPayload =
    itemPayload !== false &&
    itemPayload !== null &&
    itemPayload !== undefined &&
    itemPayload !== '';

  assertNoRequireFreshDataWithDebouncePayload(
    'useItem',
    requireFreshData,
    debouncePayload,
  );

  const query = useMemo(
    (): ListQueryUseMultipleItemsQuery<ItemPayload, undefined>[] =>
      hasPayload
        ? [
            {
              payload: itemPayload,
              fields,
              disableRefetches,
              disableRefetchOnMount,
              isOffScreen,
              returnIdleStatus,
              returnRefetchingStatus,
              showPartialAsRefetching,
            },
          ]
        : [],
    [
      itemPayload,
      fields,
      disableRefetches,
      disableRefetchOnMount,
      hasPayload,
      isOffScreen,
      returnIdleStatus,
      returnRefetchingStatus,
      showPartialAsRefetching,
    ],
  );

  const queryResult = useMultipleItems<Selected>(query, {
    selector,
    loadFromStateOnly,
    debouncePayload,
  });

  const result = useMemo(
    (): TSFDUseListItemReturn<Selected, ItemPayload> =>
      queryResult[0] ??
      (isInvalidPayload
        ? {
            error: invalidPayloadError,
            isLoading: false,
            status: 'error',
            data: selector
              ? selector(null, null)
              : // WORKAROUND: Runtime selector presence does not narrow the generic Selected type, but the fallback branch returns the raw null state.
                __LEGIT_CAST__<Selected, null>(null),
            payload: itemPayload || null,
            itemStateKey: '',
            pendingSync: false,
            queryMetadata: undefined,
          }
        : {
            error: null,
            isLoading: false,
            status: 'idle',
            data: selector
              ? selector(null, null)
              : // WORKAROUND: Runtime selector presence does not narrow the generic Selected type, but the fallback branch returns the raw null state.
                __LEGIT_CAST__<Selected, null>(null),
            payload: itemPayload || null,
            itemStateKey: '',
            pendingSync: false,
            queryMetadata: undefined,
          }),
    [isInvalidPayload, itemPayload, queryResult, selector],
  );

  const fetchQuery = hasPayload ? query[0] : undefined;

  const [useModifyResult, markRefreshSettled] = useRequireFreshData(
    requireFreshData,
    hasPayload,
    () => {
      if (fetchQuery) {
        scheduleItemFetch('highPriority', fetchQuery.payload, {
          fields: fetchQuery.fields,
        });
      }
    },
  );

  useSubscribeToStore(store, ({ observe }) => {
    if (!requireFreshData || !hasPayload || !result.itemStateKey) {
      return;
    }

    observe
      .ifSelector((state) => {
        return state.itemQueries[result.itemStateKey]?.status;
      })
      .change.then(({ current }) => {
        if (current === 'success' || current === 'error') {
          markRefreshSettled();
        }
      });
  });

  return useModifyResult(result);
}
