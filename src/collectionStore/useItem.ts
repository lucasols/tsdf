import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { useMemo } from 'react';
import { Store, useSubscribeToStore } from 't-state';

import type {
  CollectionUseMultipleItemsQuery,
  TSFDCollectionState,
  TSFDUseCollectionItemReturn,
} from './collectionStore';

import { FetchType } from '../requestScheduler';
import { assertNoEnsureIsLoadedWithDebouncePayload } from '../utils/payloadDebounce';
import {
  ValidPayload,
  ValidStoreState,
  invalidPayloadError,
} from '../utils/storeShared';
import { useEnsureIsLoaded } from '../utils/useEnsureIsLoaded';
import { UseMultipleItemsOptions } from './useMultipleItems';

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

  assertNoEnsureIsLoadedWithDebouncePayload(
    'useItem',
    ensureIsLoaded,
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
            queryMetadata: undefined,
          }),
    [isInvalidPayload, item, selector],
  );

  const fetchQuery = hasPayload ? query[0] : undefined;
  const isPayloadReadyForFetch = hasPayload;

  const [useModifyResult, emitIsLoadedEvt] = useEnsureIsLoaded(
    ensureIsLoaded,
    hasPayload && isPayloadReadyForFetch,
    () => {
      if (fetchQuery && isPayloadReadyForFetch) {
        scheduleFetch('highPriority', fetchQuery.payload);
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
      .ifSelector((state) => state[result.itemStateKey]?.status)
      .change.then(({ current }) => {
        if (current === 'success' || current === 'error') {
          emitIsLoadedEvt();
        }
      });
  });

  return useModifyResult(result);
}
