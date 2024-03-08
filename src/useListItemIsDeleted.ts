import { useState } from 'react';
import { useOnChange } from './utils/hooks';

export function useListItemIsDeleted({
  itemExists,
  listIsLoading,
  onDelete,
  itemId,
}: {
  itemId: string;
  /** true if item exists in any condition, ex: if list is not loaded item not exists in memory yet */
  itemExists: boolean;
  listIsLoading: boolean;
  onDelete?: () => void;
}) {
  const [isDeleted, setIsDeleted] = useState<string | undefined>();

  useOnChange({ itemExists, itemId }, ({ current, prev }) => {
    if (current.itemId !== itemId) return;

    if (listIsLoading || !prev) return;

    const wasItemDeleted = !current.itemExists && !!prev.itemExists;

    if (wasItemDeleted) {
      onDelete?.();
      setIsDeleted(itemId);
    }
  });

  return isDeleted === itemId;
}
