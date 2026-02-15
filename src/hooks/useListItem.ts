import { useListItemIsDeleted } from './useListItemIsDeleted';
import { useListItemIsLoading } from './useListItemIsLoading';

/** Combined hook that composes {@link useListItemIsLoading} and {@link useListItemIsDeleted},
 * returning `{ isLoading, isDeleted, data }` for a single item within a list/collection. */
export function useListItem<Data>({
  itemId,
  isRefetching,
  listIsLoading,
  itemExists,
  loadItemFallback,
  data,
  onDelete,
}: {
  /** Unique identifier of the item */
  itemId: string;
  /** Whether the parent list/collection is currently refetching */
  isRefetching: boolean;
  /** Whether the parent list/collection is in the initial loading state */
  listIsLoading: boolean;
  /** Whether the item exists in the current data */
  itemExists: boolean;
  /** Called after a timeout if the item is still missing and no refetch is in progress */
  loadItemFallback: () => void;
  /** The selected/mapped data for this item */
  data: Data;
  /** Called once when the deletion is detected */
  onDelete?: () => void;
}): { isLoading: boolean; isDeleted: boolean; data: Data } {
  const isLoading = useListItemIsLoading({
    itemId,
    isRefetching,
    listIsLoading,
    itemExists,
    loadItemFallback,
  });

  const isDeleted = useListItemIsDeleted({
    itemId,
    itemExists,
    listIsLoading,
    onDelete,
  });

  return { isLoading, isDeleted, data };
}
