import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { useMemo } from 'react';
import { Store, useSubscribeToStore } from 't-state';
import { FetchType } from '../requestScheduler';
import {
  ValidPayload,
  ValidStoreState,
  invalidPayloadError,
} from '../utils/storeShared';
import { useEnsureIsLoaded } from '../utils/useEnsureIsLoaded';
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
  ensureIsLoaded?: boolean;
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
    ensureIsLoaded,
    returnRefetchingStatus,
    disableRefetches,
    disableRefetchOnMount,
    returnIdleStatus,
    isOffScreen,
  }: UseItemOptions<ItemState, Selected>,
  store: Store<TSFDCollectionState<ItemState, ItemPayload>>,
  scheduleFetch: (fetchType: FetchType, payload: ItemPayload) => void,
  useMultipleItems: <S = ItemState | null>(
    items: CollectionUseMultipleItemsQuery<ItemPayload, undefined>[],
    options: UseMultipleItemsOptions<ItemState, S>,
  ) => readonly TSFDUseCollectionItemReturn<S, ItemPayload, undefined>[],
): TSFDUseCollectionItemReturn<Selected, ItemPayload> {
  const isInvalidPayload = payload === '';

  const query = useMemo(
    () =>
      payload === false ||
      payload === null ||
      payload === undefined ||
      payload === ''
        ? []
        : [
            {
              payload,
              omitPayload,
              returnRefetchingStatus,
              disableRefetches,
              disableRefetchOnMount,
              returnIdleStatus,
              isOffScreen,
            },
          ],
    [
      disableRefetches,
      disableRefetchOnMount,
      isOffScreen,
      omitPayload,
      returnIdleStatus,
      returnRefetchingStatus,
      payload,
    ],
  );

  const item = useMultipleItems(query, {
    selector,
  });

  const result = useMemo(
    (): TSFDUseCollectionItemReturn<Selected, ItemPayload> =>
      item[0] ??
      (isInvalidPayload
        ? {
            payload: undefined,
            data: selector
              ? selector(null)
              : __LEGIT_CAST__<Selected, null>(null),
            error: invalidPayloadError,
            status: 'error',
            itemStateKey: '',
            isLoading: false,
            queryMetadata: undefined,
          }
        : {
            payload: undefined,
            data: selector
              ? selector(null)
              : __LEGIT_CAST__<Selected, null>(null),
            error: null,
            status: 'idle',
            itemStateKey: '',
            isLoading: false,
            queryMetadata: undefined,
          }),
    [item, selector, isInvalidPayload],
  );

  const [useModifyResult, emitIsLoadedEvt] = useEnsureIsLoaded(
    ensureIsLoaded,
    !!payload,
    () => {
      if (payload) {
        scheduleFetch('highPriority', payload);
      }
    },
  );

  useSubscribeToStore(store, ({ observe }) => {
    if (!ensureIsLoaded) return;

    observe
      .ifSelector((state) => state[result.itemStateKey]?.status)
      .change.then(({ current }) => {
        if (current === 'success' || current === 'error') {
          emitIsLoadedEvt();
        }
      });
  });

  return useModifyResult(result);
}
