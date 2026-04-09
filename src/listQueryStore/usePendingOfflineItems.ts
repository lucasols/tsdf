import { deepEqual } from '@ls-stack/utils/deepEqual';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { Store } from 't-state';

import { useRegisterActiveKeys } from '../cacheLimits/useRegisterActiveKeys';
import { shouldApplyOfflineOverlay } from '../persistentStorage/offline/entityMetadata';
import type { InternalGlobalOfflineEntity } from '../persistentStorage/offline/types';
import { ValidPayload, ValidStoreState } from '../utils/storeShared';
import type {
  ListQueryOfflineOverlay,
  TSFDListQueryState,
  TSFDUsePendingOfflineItemsReturn,
} from './types';

export type UsePendingOfflineItemsOptions<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  SelectedItem,
> = {
  /** Maps each visible pending item before it is returned from the hook. */
  selector?: (data: ItemState, payload: ItemPayload) => SelectedItem;
  /** Narrows the hook output using the tracked item payload, before selection. */
  filterPayload?: (payload: ItemPayload) => boolean;
  /** Includes entities currently blocked in manual resolution. */
  includeResolutionRequired?: boolean;
};

export function usePendingOfflineItems<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  SelectedItem = ItemState,
>(
  {
    selector,
    filterPayload,
    includeResolutionRequired = false,
  }: UsePendingOfflineItemsOptions<ItemState, ItemPayload, SelectedItem>,
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  registerActiveItems: (itemKeys: string[]) => () => void,
  touchItems: (itemKeys: string[]) => void,
  preloadItems: ((itemKeys: string[]) => Promise<boolean[]>) | undefined,
  preloadItemsBeforePaint: boolean,
  readHydratedItem:
    | ((
        itemKey: string,
      ) =>
        | {
            item: ItemState | null | undefined;
            itemQuery: { payload: ItemPayload } | null | undefined;
            loadedFields: string[] | undefined;
          }
        | undefined)
    | undefined,
  offlineEntities: readonly InternalGlobalOfflineEntity[],
  offlineOverlays: Readonly<
    Record<string, ListQueryOfflineOverlay<ItemState, ItemPayload>>
  >,
): TSFDUsePendingOfflineItemsReturn<SelectedItem, ItemPayload> {
  const [preloadedItemPresenceByKey, setPreloadedItemPresenceByKey] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const eligibleEntities = useMemo(() => {
    return offlineEntities.filter((entity) => {
      if (entity.entityKind !== 'item') return false;
      if (!includeResolutionRequired && entity.requiresResolution) return false;
      return true;
    });
  }, [includeResolutionRequired, offlineEntities]);
  const { eligibleItemKeys, preloadableItemKeys } = useMemo(() => {
    const allKeys: string[] = [];
    const preloadKeys: string[] = [];
    for (const entity of eligibleEntities) {
      allKeys.push(entity.entityKey);
      if (entity.kind !== 'delete') {
        preloadKeys.push(entity.entityKey);
      }
    }
    return { eligibleItemKeys: allKeys, preloadableItemKeys: preloadKeys };
  }, [eligibleEntities]);

  useRegisterActiveKeys(eligibleItemKeys, registerActiveItems, touchItems);

  const rememberPreloadResults = useCallback(
    (itemKeys: readonly string[], results: readonly boolean[]) => {
      setPreloadedItemPresenceByKey((current) => {
        const next: Record<string, boolean> = {};

        for (const itemKey of preloadableItemKeys) {
          const currentPresence = current[itemKey];
          if (currentPresence !== undefined) {
            next[itemKey] = currentPresence;
          }
        }

        let changed = Object.keys(next).length !== Object.keys(current).length;

        for (const [index, itemKey] of itemKeys.entries()) {
          const result = results[index];
          if (result === undefined || next[itemKey] === result) continue;

          next[itemKey] = result;
          changed = true;
        }

        return changed ? next : current;
      });
    },
    [preloadableItemKeys],
  );

  useLayoutEffect(() => {
    let cancelled = false;

    if (
      !preloadItemsBeforePaint ||
      !preloadItems ||
      preloadableItemKeys.length < 1
    ) {
      return () => {
        cancelled = true;
      };
    }

    void preloadItems(preloadableItemKeys).then((results) => {
      if (cancelled) return;
      rememberPreloadResults(preloadableItemKeys, results);
    });

    return () => {
      cancelled = true;
    };
  }, [
    preloadableItemKeys,
    preloadItems,
    preloadItemsBeforePaint,
    rememberPreloadResults,
  ]);

  useEffect(() => {
    let cancelled = false;

    if (
      preloadItemsBeforePaint ||
      !preloadItems ||
      preloadableItemKeys.length < 1
    ) {
      return () => {
        cancelled = true;
      };
    }

    void preloadItems(preloadableItemKeys).then((results) => {
      if (cancelled) return;
      rememberPreloadResults(preloadableItemKeys, results);
    });

    return () => {
      cancelled = true;
    };
  }, [
    preloadableItemKeys,
    preloadItems,
    preloadItemsBeforePaint,
    rememberPreloadResults,
  ]);

  const resultSelector = useCallback(
    (state: TSFDListQueryState<ItemState, QueryPayload, ItemPayload>) => {
      const items: SelectedItem[] = [];
      const deletedItems: ItemPayload[] = [];

      for (const entity of eligibleEntities) {
        const itemKey = entity.entityKey;
        const rawOverlay = offlineOverlays[itemKey];
        const visibleOverlay =
          rawOverlay !== undefined &&
          shouldApplyOfflineOverlay(entity, rawOverlay)
            ? rawOverlay
            : undefined;
        const hasStateItem = Object.hasOwn(state.items, itemKey);
        const hasStateItemQuery = Object.hasOwn(state.itemQueries, itemKey);
        const isDeletedByKind = entity.kind === 'delete';
        const hydratedItem =
          isDeletedByKind || (hasStateItem && hasStateItemQuery)
            ? undefined
            : readHydratedItem?.(itemKey);
        const normalizedStringItemKey = itemKey.startsWith('"')
          ? itemKey.slice(1)
          : itemKey;
        const entityPayload =
          entity.payload === undefined
            ? undefined
            : // WORKAROUND: Internal offline entities store payloads under the
              // shared ValidPayload contract, so the list-query hook narrows
              // them back to its concrete ItemPayload generic here.
              __LEGIT_CAST__<ItemPayload, ValidPayload>(entity.payload);
        const itemPayload =
          visibleOverlay?.itemPayload ??
          rawOverlay?.itemPayload ??
          (hasStateItemQuery
            ? state.itemQueries[itemKey]?.payload
            : undefined) ??
          hydratedItem?.itemQuery?.payload ??
          entityPayload ??
          (entity.tempId !== undefined
            ? // WORKAROUND: Offline temp ids are valid payloads by contract,
              // but this hook only knows the store's generic payload type at
              // runtime, so a direct type-safe narrowing is not available here.
              __LEGIT_CAST__<ItemPayload, ValidPayload>(entity.tempId)
            : // WORKAROUND: Persisted pending deletes no longer keep their
              // original item payload in list-query item storage, so string
              // payload stores have to fall back to the stable item key here.
              __LEGIT_CAST__<ItemPayload, string>(normalizedStringItemKey));
        const missingPersistedItemSnapshot =
          !isDeletedByKind &&
          !hasStateItem &&
          !hasStateItemQuery &&
          hydratedItem === undefined &&
          (preloadItemsBeforePaint ||
            preloadedItemPresenceByKey[itemKey] === false);

        if (filterPayload && !filterPayload(itemPayload)) {
          continue;
        }

        const isDeleted =
          isDeletedByKind ||
          rawOverlay?.item === null ||
          (hasStateItemQuery && state.itemQueries[itemKey] === null) ||
          missingPersistedItemSnapshot;
        if (isDeleted) {
          deletedItems.push(itemPayload);
          continue;
        }

        const item =
          visibleOverlay?.item ??
          (hasStateItem ? state.items[itemKey] : hydratedItem?.item);
        if (item == null) continue;

        items.push(
          selector
            ? selector(item, itemPayload)
            : // WORKAROUND: When no selector is provided, the public API
              // guarantees `SelectedItem` defaults to `ItemState`, but that
              // defaulted generic relationship is not expressible to TS here.
              __LEGIT_CAST__<SelectedItem, ItemState>(item),
        );
      }

      return { items, deletedItems };
    },
    [
      eligibleEntities,
      filterPayload,
      offlineOverlays,
      preloadItemsBeforePaint,
      preloadedItemPresenceByKey,
      readHydratedItem,
      selector,
    ],
  );

  return store.useSelectorRC(resultSelector, { equalityFn: deepEqual });
}
