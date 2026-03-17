import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { useMemo } from 'react';
import { Store, useSubscribeToStore } from 't-state';
import { FetchType, ScheduleFetchResults } from '../requestScheduler';
import { assertNoEnsureIsLoadedWithDebouncePayload } from '../utils/payloadDebounce';
import {
  ValidPayload,
  ValidStoreState,
  invalidPayloadError,
} from '../utils/storeShared';
import { useEnsureIsLoaded } from '../utils/useEnsureIsLoaded';
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
   * Forces a high-priority fetch on mount and keeps the hook in `loading`
   * until the current payload finishes loading. Cannot be combined with
   * `debouncePayload`.
   */
  ensureIsLoaded?: boolean;
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
    ensureIsLoaded,
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

  assertNoEnsureIsLoadedWithDebouncePayload(
    'useItem',
    ensureIsLoaded,
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
              : __LEGIT_CAST__<Selected, null>(null),
            payload: itemPayload || null,
            itemStateKey: '',
            isPendingOfflineSync: false,
            queryMetadata: undefined,
          }
        : {
            error: null,
            isLoading: false,
            status: 'idle',
            data: selector
              ? selector(null, null)
              : __LEGIT_CAST__<Selected, null>(null),
            payload: itemPayload || null,
            itemStateKey: '',
            isPendingOfflineSync: false,
            queryMetadata: undefined,
          }),
    [isInvalidPayload, itemPayload, queryResult, selector],
  );

  const fetchQuery = hasPayload ? query[0] : undefined;
  const isPayloadReadyForFetch = hasPayload;

  const [useModifyResult, emitIsLoadedEvt] = useEnsureIsLoaded(
    ensureIsLoaded,
    hasPayload && isPayloadReadyForFetch,
    () => {
      if (fetchQuery && isPayloadReadyForFetch) {
        scheduleItemFetch('highPriority', fetchQuery.payload, {
          fields: fetchQuery.fields,
        });
      }
    },
  );

  useSubscribeToStore(store, ({ observe }) => {
    if (
      !ensureIsLoaded ||
      !hasPayload ||
      !isPayloadReadyForFetch ||
      !result.itemStateKey
    ) {
      return;
    }

    observe
      .ifSelector((state) => {
        return state.itemQueries[result.itemStateKey]?.status;
      })
      .change.then(({ current }) => {
        if (current === 'success' || current === 'error') {
          emitIsLoadedEvt();
        }
      });
  });

  return useModifyResult(result);
}
