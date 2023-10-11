import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import { useListItemIsLoading } from '../src/useListItemIsLoading';
import { Store } from 't-state';
import { sleep } from './utils/sleep';
import { createRenderStore } from './utils/storeUtils';

test('do not return true if not loading', () => {
  const { result } = renderHook(() => {
    const isLoadingItem = useListItemIsLoading({
      isLoading: false,
      isNotFound: false,
      isRefetching: false,
    });

    return isLoadingItem;
  });

  expect(result.current).toBe(false);
});

test('rendering a component that is not found and then refreshing the resource', async () => {
  const storeState = new Store({
    state: {
      isLoading: false,
      isNotFound: true,
      isRefetching: false,
    },
  });

  const rendersResult = createRenderStore();

  renderHook(() => {
    const itemResourceState = storeState.useState();

    const isLoadingItem = useListItemIsLoading(itemResourceState);

    rendersResult.add({
      isLoadingItem,
      notFound: itemResourceState.isNotFound && !isLoadingItem,
    });
  });

  await sleep(10);

  storeState.setState({
    isLoading: false,
    isNotFound: true,
    isRefetching: true,
  });

  await sleep(100);

  act(() => {
    storeState.setState({
      isLoading: false,
      isNotFound: false,
      isRefetching: false,
    });
  });

  expect(rendersResult.snapshot).toMatchInlineSnapshot(`
    "
    isLoadingItem: true -- notFound: false
    isLoadingItem: true -- notFound: false
    isLoadingItem: false -- notFound: false
    "
  `);
});

test('return loading if resource is loading', async () => {
  const storeState = new Store({
    state: {
      isLoading: true,
      isNotFound: true,
      isRefetching: false,
    },
  });

  const rendersResult = createRenderStore();

  renderHook(() => {
    const itemResourceState = storeState.useState();

    const isLoadingItem = useListItemIsLoading(itemResourceState);

    rendersResult.add({
      isLoadingItem,
      notFound: itemResourceState.isNotFound && !isLoadingItem,
    });
  });

  await sleep(100);

  act(() => {
    storeState.setState({
      isLoading: false,
      isNotFound: false,
      isRefetching: false,
    });
  });

  expect(rendersResult.snapshot).toMatchInlineSnapshot(`
    "
    isLoadingItem: true -- notFound: false
    isLoadingItem: false -- notFound: false
    "
  `);
});

test('reset loading if resource is never refetched', async () => {
  const storeState = new Store({
    state: {
      isLoading: false,
      isNotFound: true,
      isRefetching: false,
    },
  });

  const rendersResult = createRenderStore();

  renderHook(async () => {
    const itemResourceState = storeState.useState();

    const isLoadingItem = useListItemIsLoading(itemResourceState);

    rendersResult.add({
      isLoadingItem,
      notFound: itemResourceState.isNotFound && !isLoadingItem,
    });
  });

  await sleep(1100);

  expect(rendersResult.snapshot).toMatchInlineSnapshot(`
    "
    isLoadingItem: true -- notFound: false
    isLoadingItem: false -- notFound: true
    "
  `);
});

test.concurrent('load a new item in the component', () => {
  const storeState = new Store({
    state: {
      isLoading: false,
      isNotFound: false,
      isRefetching: false,
    },
  });

  const rendersResult = createRenderStore();

  renderHook(() => {
    const itemResourceState = storeState.useState();

    const isLoadingItem = useListItemIsLoading(itemResourceState);

    rendersResult.add({
      isLoadingItem,
      notFound: itemResourceState.isNotFound && !isLoadingItem,
    });
  });

  await sleep(100);

  // new item is loading

  storeState.setState({
    isLoading: false,
    isNotFound: true,
    isRefetching: false,
  });

  storeState.setState({
    isLoading: false,
    isNotFound: true,
    isRefetching: true,
  });

  await sleep(100);

  // new item is loaded

  storeState.setState({
    isLoading: false,
    isNotFound: false,
    isRefetching: false,
  });

  await sleep(10);

  expect(rendersResult.snapshot).toMatchInlineSnapshot(`
    "
    isLoadingItem: false -- notFound: false
    isLoadingItem: true -- notFound: false
    isLoadingItem: true -- notFound: false
    isLoadingItem: false -- notFound: false
    "
  `);
});
