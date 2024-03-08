import { act, renderHook } from '@testing-library/react';
import { Store } from 't-state';
import { describe, expect, test, vi } from 'vitest';
import { useListItemIsDeleted } from '../src/useListItemIsDeleted';

function createInitialStore() {
  const store = new Store({
    state: {
      itemId: '1',
      listIsLoading: true,
      itemExists: false,
    },
  });

  return {
    useState: () => store.useState(),
    emulateLoadingEnd: (type: 'success' | 'failed') => {
      act(() => {
        store.setPartialState({
          listIsLoading: false,
          itemExists: type === 'success' ? true : false,
        });
      });
    },
    deleteItem: () => {
      act(() => {
        store.setPartialState({
          itemExists: false,
        });
      });
    },
    startLoadingAnotherItem: (itemId: string) => {
      act(() => {
        store.setPartialState({
          itemId,
          listIsLoading: true,
          itemExists: false,
        });
      });
    },
    changeToLoadedItem: (itemId: string) => {
      act(() => {
        store.setPartialState({
          itemId,
          listIsLoading: false,
          itemExists: true,
        });
      });
    },
  };
}

describe.concurrent('useListItemIsDeleted', () => {
  test('do not return true if not loading', () => {
    const storeState = createInitialStore();

    const { result } = renderHook(() => {
      const itemState = storeState.useState();

      const isDeleted = useListItemIsDeleted(itemState);

      return isDeleted;
    });

    expect(result.current).toBe(false);

    storeState.emulateLoadingEnd('success');

    expect(result.current).toBe(false);
  });

  test('do not return true if loading failed and item is not found', () => {
    const storeState = createInitialStore();

    const { result } = renderHook(() => {
      const itemState = storeState.useState();

      const isDeleted = useListItemIsDeleted(itemState);

      return isDeleted;
    });

    expect(result.current).toBe(false);

    storeState.emulateLoadingEnd('failed');

    expect(result.current).toBe(false);
  });

  test('delete item', () => {
    const storeState = createInitialStore();

    const onDelete = vi.fn();

    const { result } = renderHook(() => {
      const itemState = storeState.useState();

      const isDeleted = useListItemIsDeleted({
        ...itemState,
        onDelete: onDelete,
      });

      return isDeleted;
    });

    expect(result.current).toBe(false);

    storeState.emulateLoadingEnd('success');

    expect(result.current).toBe(false);

    storeState.deleteItem();

    expect(result.current).toBe(true);

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  test('changing item id should not trigger isDeleted', () => {
    const storeState = createInitialStore();

    const { result } = renderHook(() => {
      const itemState = storeState.useState();

      const isDeleted = useListItemIsDeleted(itemState);

      return [isDeleted, itemState.itemId];
    });

    expect(result.current).toEqual([false, '1']);

    storeState.emulateLoadingEnd('success');

    expect(result.current).toEqual([false, '1']);

    storeState.startLoadingAnotherItem('2');

    expect(result.current).toEqual([false, '2']);

    storeState.emulateLoadingEnd('success');

    expect(result.current).toEqual([false, '2']);

    storeState.deleteItem();

    expect(result.current).toEqual([true, '2']);
  });

  test('delete item and then start loading another item', () => {
    const storeState = createInitialStore();

    const { result } = renderHook(() => {
      const itemState = storeState.useState();

      const isDeleted = useListItemIsDeleted(itemState);

      return isDeleted;
    });

    storeState.emulateLoadingEnd('success');

    expect(result.current).toBe(false);

    storeState.deleteItem();

    expect(result.current).toBe(true);

    storeState.startLoadingAnotherItem('2');

    expect(result.current).toBe(false);

    storeState.emulateLoadingEnd('success');

    expect(result.current).toBe(false);
  });

  test('delete item and then change to another already loaded item', () => {
    const storeState = createInitialStore();

    const { result } = renderHook(() => {
      const itemState = storeState.useState();

      const isDeleted = useListItemIsDeleted(itemState);

      return [isDeleted, itemState.itemId];
    });

    storeState.emulateLoadingEnd('success');

    expect(result.current).toEqual([false, '1']);

    storeState.deleteItem();

    expect(result.current).toEqual([true, '1']);

    storeState.changeToLoadedItem('2');

    expect(result.current).toEqual([false, '2']);
  });
});
