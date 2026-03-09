import { deepEqual } from '@ls-stack/utils/deepEqual';
import { findAndMap } from '@ls-stack/utils/arrayUtils';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { Store } from 't-state';
import { useRegisterActiveKeys } from '../cacheLimits/useRegisterActiveKeys';
import { ValidPayload, ValidStoreState } from '../utils/storeShared';
import type { TSFDListQueryState } from './types';

export function useFindItem<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  SelectedItem = ItemState | null,
>(
  findItemFn: (item: ItemState, itemPayload: ItemPayload) => boolean,
  {
    selector,
  }: { selector?: (data: ItemState, id: ItemPayload) => SelectedItem },
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  registerActiveItems: (itemKeys: string[]) => () => void,
  touchItems: (itemKeys: string[]) => void,
): SelectedItem | null {
  const selectedItem = store.useSelectorRC(
    (state) => {
      const matchedItem = findAndMap(
        Object.entries(state.items),
        ([itemKey, item]) => {
          if (!item) return false;

          const itemQuery = state.itemQueries[itemKey];

          if (!itemQuery) return false;

          if (findItemFn(item, itemQuery.payload)) {
            return { itemKey, item, itemQuery };
          }

          return false;
        },
      );

      if (!matchedItem) return null;

      return {
        itemKey: matchedItem.itemKey,
        value: selector
          ? selector(matchedItem.item, matchedItem.itemQuery.payload)
          : __LEGIT_CAST__<SelectedItem, ItemState>(matchedItem.item),
      };
    },
    { equalityFn: deepEqual },
  );

  useRegisterActiveKeys(
    selectedItem?.itemKey ? [selectedItem.itemKey] : [],
    registerActiveItems,
    touchItems,
  );

  return selectedItem?.value ?? null;
}
