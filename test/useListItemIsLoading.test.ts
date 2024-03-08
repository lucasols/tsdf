import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { useListItemIsLoading } from '../src/useListItemIsLoading';
import { Store } from 't-state';
import { sleep } from './utils/sleep';
import { createRenderStore } from './utils/storeUtils';

function emulateSuccesRefetching(
  storeState: Store<{
    itemId: string;
    listIsLoading: boolean;
    itemExists: boolean;
    isRefetching: boolean;
  }>,
) {
  return async () => {
    storeState.setPartialState({
      listIsLoading: false,
      itemExists: true,
      isRefetching: true,
    });

    await sleep(100);

    storeState.setPartialState({
      listIsLoading: false,
      itemExists: false,
      isRefetching: false,
    });
  };
}

function emulateFailedRefetching(
  storeState: Store<{
    itemId: string;
    listIsLoading: boolean;
    itemExists: boolean;
    isRefetching: boolean;
  }>,
) {
  return async () => {
    storeState.setPartialState({
      listIsLoading: false,
      itemExists: true,
      isRefetching: true,
    });

    await sleep(100);

    storeState.setPartialState({
      listIsLoading: false,
      itemExists: true,
      isRefetching: false,
    });
  };
}

describe.concurrent('useListItemIsLoading', () => {
  test('do not return true if not loading', () => {
    const { result } = renderHook(() => {
      const isLoadingItem = useListItemIsLoading({
        itemId: '1',
        listIsLoading: false,
        itemExists: false,
        isRefetching: false,
        loadItemFallback: () => {},
      });

      return isLoadingItem;
    });

    expect(result.current).toBe(false);
  });

  test('rendering a component that is not found and then refreshing the resource', async () => {
    const storeState = new Store({
      state: {
        itemId: '1',
        listIsLoading: false,
        itemExists: true,
        isRefetching: false,
      },
    });

    const rendersResult = createRenderStore();

    const loadItemFallbackMock = vi.fn();

    renderHook(() => {
      const itemResourceState = storeState.useState();

      const isLoadingItem = useListItemIsLoading({
        ...itemResourceState,
        loadItemFallback: loadItemFallbackMock,
      });

      rendersResult.add({
        isLoadingItem,
        notFound: itemResourceState.itemExists && !isLoadingItem,
      });
    });

    await sleep(10);

    storeState.setState({
      itemId: '1',
      listIsLoading: false,
      itemExists: true,
      isRefetching: true,
    });

    await sleep(100);

    act(() => {
      storeState.setState({
        itemId: '1',
        listIsLoading: false,
        itemExists: false,
        isRefetching: false,
      });
    });

    expect(loadItemFallbackMock).not.toBeCalled();

    expect(rendersResult.snapshot).toMatchInlineSnapshotString(`
    "
    isLoadingItem: true -- notFound: false
    isLoadingItem: true -- notFound: false
    isLoadingItem: true -- notFound: false
    isLoadingItem: false -- notFound: false
    "
  `);
  });

  test('return loading if resource is loading', async () => {
    const storeState = new Store({
      state: {
        itemId: '1',
        listIsLoading: true,
        itemExists: true,
        isRefetching: false,
      },
    });

    const rendersResult = createRenderStore();

    renderHook(() => {
      const itemResourceState = storeState.useState();

      const isLoadingItem = useListItemIsLoading({
        ...itemResourceState,
        loadItemFallback: emulateSuccesRefetching(storeState),
      });

      rendersResult.add({
        isLoadingItem,
        notFound: itemResourceState.itemExists && !isLoadingItem,
      });
    });

    await sleep(100);

    act(() => {
      storeState.setState({
        itemId: '1',
        listIsLoading: false,
        itemExists: false,
        isRefetching: false,
      });
    });

    expect(rendersResult.snapshot).toMatchInlineSnapshotString(`
    "
    isLoadingItem: true -- notFound: false
    isLoadingItem: false -- notFound: false
    "
  `);
  });

  test('retry loading if resource is never refetched', async () => {
    const storeState = new Store({
      state: {
        itemId: '1',
        listIsLoading: false,
        itemExists: true,
        isRefetching: false,
      },
    });

    const rendersResult = createRenderStore();

    renderHook(() => {
      const itemResourceState = storeState.useState();

      const isLoadingItem = useListItemIsLoading({
        ...itemResourceState,
        loadItemFallback: emulateSuccesRefetching(storeState),
      });

      rendersResult.add({
        isLoadingItem,
        notFound: itemResourceState.itemExists && !isLoadingItem,
      });
    });

    await sleep(1300);

    expect(rendersResult.changesSnapshot).toMatchInlineSnapshotString(`
    "
    isLoadingItem: true -- notFound: false
    isLoadingItem: false -- notFound: false
    "
  `);
  });

  test('load a new item in the component', async () => {
    const storeState = new Store({
      state: {
        itemId: '1',
        listIsLoading: false,
        itemExists: false,
        isRefetching: false,
      },
    });

    const rendersResult = createRenderStore();

    const loadItemFallbackMock = vi.fn();

    renderHook(() => {
      const itemResourceState = storeState.useState();

      const isLoadingItem = useListItemIsLoading({
        ...itemResourceState,
        loadItemFallback: loadItemFallbackMock,
      });

      rendersResult.add({
        itemId: itemResourceState.itemId,
        isLoadingItem,
        notFound: itemResourceState.itemExists && !isLoadingItem,
      });
    });

    await sleep(100);

    expect(loadItemFallbackMock).not.toBeCalled();

    // new item is loading

    storeState.setState({
      itemId: '2',
      listIsLoading: false,
      itemExists: true,
      isRefetching: false,
    });

    storeState.setState({
      itemId: '2',
      listIsLoading: false,
      itemExists: true,
      isRefetching: true,
    });

    await sleep(100);

    // new item is loaded

    storeState.setState({
      itemId: '2',
      listIsLoading: false,
      itemExists: false,
      isRefetching: false,
    });

    await sleep(10);

    expect(loadItemFallbackMock).not.toBeCalled();

    expect(rendersResult.snapshot).toMatchInlineSnapshotString(`
    "
    itemId: 1 -- isLoadingItem: false -- notFound: false
    itemId: 2 -- isLoadingItem: true -- notFound: false
    itemId: 2 -- isLoadingItem: true -- notFound: false
    itemId: 2 -- isLoadingItem: false -- notFound: false
    "
  `);
  });

  test('load a new item in the component but fail, external refetch', async () => {
    const storeState = new Store({
      state: {
        itemId: '1',
        listIsLoading: false,
        itemExists: false,
        isRefetching: false,
      },
    });

    const rendersResult = createRenderStore();

    const loadItemFallbackMock = vi.fn();

    renderHook(() => {
      const itemResourceState = storeState.useState();

      const isLoadingItem = useListItemIsLoading({
        ...itemResourceState,
        loadItemFallback: loadItemFallbackMock,
      });

      rendersResult.add({
        itemId: itemResourceState.itemId,
        isLoadingItem,
        notFound: itemResourceState.itemExists && !isLoadingItem,
      });
    });

    await sleep(100);

    // new item is loading

    storeState.setState({
      itemId: '2',
      listIsLoading: false,
      itemExists: true,
      isRefetching: false,
    });

    storeState.setState({
      itemId: '2',
      listIsLoading: false,
      itemExists: true,
      isRefetching: true,
    });

    await sleep(100);

    // resource is refetched but not found

    storeState.setState({
      itemId: '2',
      listIsLoading: false,
      itemExists: true,
      isRefetching: false,
    });

    await sleep(100);

    expect(loadItemFallbackMock).not.toBeCalled();

    expect(rendersResult.snapshot).toMatchInlineSnapshotString(`
    "
    itemId: 1 -- isLoadingItem: false -- notFound: false
    itemId: 2 -- isLoadingItem: true -- notFound: false
    itemId: 2 -- isLoadingItem: true -- notFound: false
    itemId: 2 -- isLoadingItem: false -- notFound: true
    "
  `);
  });

  test('fail to load not found item with fallback loading', async () => {
    const storeState = new Store({
      state: {
        itemId: '1',
        listIsLoading: false,
        itemExists: true,
        isRefetching: false,
      },
    });

    const rendersResult = createRenderStore();

    renderHook(() => {
      const itemResourceState = storeState.useState();

      const isLoadingItem = useListItemIsLoading({
        ...itemResourceState,
        loadItemFallback: emulateFailedRefetching(storeState),
      });

      rendersResult.add({
        isLoadingItem,
        notFound: itemResourceState.itemExists && !isLoadingItem,
      });
    });

    await sleep(500);

    expect(rendersResult.snapshot).toMatchInlineSnapshotString(`
    "
    isLoadingItem: true -- notFound: false
    isLoadingItem: true -- notFound: false
    isLoadingItem: true -- notFound: false
    isLoadingItem: false -- notFound: true
    "
  `);
  });
});
