import { useOnChange } from '@ls-stack/react-utils/useOnChange';
import { useState } from 'react';

/** Detects when a list item has been deleted by tracking transitions from
 * existing to non-existing state. Does not trigger during initial loading —
 * only fires after the item was previously found and then disappears. */
export function useListItemIsDeleted({
  itemExists,
  listIsLoading,
  onDelete,
  itemId,
}: {
  /** Unique identifier of the item */
  itemId: string;
  /** Whether the item exists in the current data — if the list hasn't loaded yet, the item won't exist in memory */
  itemExists: boolean;
  /** Whether the parent list/collection is in the initial loading state */
  listIsLoading: boolean;
  /** Called once when the deletion is detected */
  onDelete?: () => void;
}) {
  const [isDeleted, setIsDeleted] = useState<string | undefined>();

  useOnChange({ itemExists, itemId }, ({ current, prev }) => {
    if (listIsLoading || !prev || prev.itemId !== current.itemId) return;

    const wasItemDeleted = !current.itemExists && !!prev.itemExists;

    if (wasItemDeleted) {
      onDelete?.();
      setIsDeleted(current.itemId);
    }
  });

  return isDeleted === itemId;
}
