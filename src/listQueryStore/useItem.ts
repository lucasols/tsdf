import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { useMemo } from 'react';
import { Store, useSubscribeToStore } from 't-state';
import { FetchType, ScheduleFetchResults } from '../requestScheduler';
import { ValidPayload, ValidStoreState } from '../utils/storeShared';
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
  ensureIsLoaded?: boolean;
  fields?: FieldsInput;
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
    disableRefetchOnMount,
    returnIdleStatus,
    returnRefetchingStatus,
    isOffScreen,
    fields,
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
  const query = useMemo(
    (): ListQueryUseMultipleItemsQuery<ItemPayload, undefined>[] =>
      itemPayload === false || itemPayload === null || itemPayload === undefined
        ? []
        : [
            {
              payload: itemPayload,
              fields,
              disableRefetchOnMount,
              isOffScreen,
              returnIdleStatus,
              returnRefetchingStatus,
            },
          ],
    [
      itemPayload,
      fields,
      disableRefetchOnMount,
      isOffScreen,
      returnIdleStatus,
      returnRefetchingStatus,
    ],
  );

  const queryResult = useMultipleItems<Selected>(query, {
    selector,
    loadFromStateOnly,
  });

  const result = useMemo(
    (): TSFDUseListItemReturn<Selected, ItemPayload> =>
      queryResult[0] ?? {
        error: null,
        isLoading: false,
        status: 'idle',
        data: selector
          ? selector(null, null)
          : __LEGIT_CAST__<Selected, null>(null),
        payload: itemPayload || null,
        itemStateKey: '',
        queryMetadata: undefined,
      },
    [itemPayload, queryResult, selector],
  );

  const [useModifyResult, emitIsLoadedEvt] = useEnsureIsLoaded(
    ensureIsLoaded,
    !!itemPayload,
    () => {
      if (itemPayload) {
        scheduleItemFetch('highPriority', itemPayload, { fields });
      }
    },
  );

  useSubscribeToStore(store, ({ observe }) => {
    if (!ensureIsLoaded || !result.itemStateKey) return;

    observe
      .ifSelector((state) => state.itemQueries[result.itemStateKey]?.status)
      .change.then(({ current }) => {
        if (current === 'success' || current === 'error') {
          emitIsLoadedEvt();
        }
      });
  });

  return useModifyResult(result);
}
