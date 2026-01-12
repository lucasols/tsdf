import { findAndMap } from '@ls-stack/utils/arrayUtils';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { Store } from 't-state';
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
  }: {
    selector?: (data: ItemState, id: ItemPayload) => SelectedItem;
  },
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
): SelectedItem | null {
  return store.useSelector((state) => {
    const selectedItem = findAndMap(
      Object.entries(state.items),
      ([itemKey, item]) => {
        if (!item) return false;

        const itemQuery = state.itemQueries[itemKey];

        if (!itemQuery) return false;

        if (findItemFn(item, itemQuery.payload)) {
          return { item, itemQuery };
        }

        return false;
      },
    );

    if (!selectedItem) return null;

    if (selector) {
      return selector(selectedItem.item, selectedItem.itemQuery.payload);
    }

    return __LEGIT_CAST__<SelectedItem>(selectedItem.item);
  });
}
