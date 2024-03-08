import { useState } from 'react';
import { useOnChange } from './utils/hooks';

export function useListItemIsDeleted({
  itemExists,
  listIsLoading,
  onDelete,
  itemId,
}: {
  itemId: string;
  itemExists: boolean;
  listIsLoading: boolean;
  onDelete?: () => void;
}) {
  const [isDeleted, setIsDeleted] = useState<string | undefined>();

  useOnChange({ itemExists, itemId }, ({ current, prev }) => {
    if (current.itemId !== itemId) return;

    if (listIsLoading || !prev) return;

    const isDeleted = !current.itemExists && !!prev.itemExists;

    if (isDeleted) {
      onDelete?.();
      setIsDeleted(itemId);
    }
  });

  return isDeleted === itemId;
}
