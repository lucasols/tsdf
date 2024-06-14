import { renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import { pick } from './utils/objectUtils';
import { sleep } from './utils/sleep';
import {
  createDefaultDocumentStore,
  createRenderStore,
} from './utils/storeUtils';

const createTestEnv = createDefaultDocumentStore;

test.concurrent('emulate realidateOnWindowFocus behaviour', async () => {
  const env = createTestEnv({
    initialServerData: 'test',
    useLoadedSnapshot: true,
    emulateRTU: true,
    disableInitialDataInvalidation: false,
  });

  function emulateWindowFocus() {
    env.store.invalidateData('lowPriority');
  }

  function getState() {
    return pick(env.store.store.state, ['refetchOnMount', 'status'], {
      refetchOnMount: 'rom',
    });
  }

  expect(getState()).toEqual({
    rom: 'lowPriority',
    status: 'success',
  });

  renderHook(() => {
    env.store.useDocument();
  });

  await env.serverMock.waitFetchIdle(); // initial invalidation

  await sleep(1000);

  expect(getState()).toEqual({ rom: false, status: 'success' });

  emulateWindowFocus(); // this should not be skipped

  expect(getState()).toEqual({ rom: false, status: 'refetching' });

  await env.serverMock.waitFetchIdle();

  expect(getState()).toEqual({ rom: false, status: 'success' });

  emulateWindowFocus(); // this should be skipped by the throttle

  // as the query is active we should not change the revalidateOnMount state
  expect(getState()).toEqual({ rom: false, status: 'success' });

  await sleep(1000);

  emulateWindowFocus(); // this should not be skipped

  await env.serverMock.waitFetchIdle();

  expect(env.serverMock.fetchsCount).toBe(3);
});

test.concurrent(
  'disable should keep the selected data and not be affected by invalidation',
  async () => {
    const env = createTestEnv({
      useLoadedSnapshot: true,
      emulateRTU: true,
      disableInitialDataInvalidation: true,
    });

    const renders = createRenderStore();

    const { rerender } = renderHook(
      ({ disabled }: { disabled: boolean }) => {
        const result = env.store.useDocument({
          isOffScreen: disabled,
          returnRefetchingStatus: true,
          disableRefetchOnMount: true,
        });

        renders.add(result);
      },
      { initialProps: { disabled: false } },
    );

    await sleep(100);

    renders.addMark('first update (✅)');
    env.serverMock.mutateData({ hello: '✅' });

    await sleep(200);

    renders.addMark('set disabled');
    rerender({ disabled: true });

    await sleep(100);

    renders.addMark('ignored update (❌)');
    env.serverMock.mutateData({ hello: '❌' });

    await sleep(200);

    renders.addMark('enabled again');
    rerender({ disabled: false });

    await sleep(200);

    expect(renders.snapshot).toMatchInlineSnapshotString(`
      "
      data: {hello:world} -- error: null -- status: success -- isLoading: false

      >>> first update (✅)

      data: {hello:world} -- error: null -- status: refetching -- isLoading: false
      data: {hello:✅} -- error: null -- status: success -- isLoading: false

      >>> set disabled

      data: {hello:✅} -- error: null -- status: success -- isLoading: false

      >>> ignored update (❌)

      >>> enabled again

      data: {hello:✅} -- error: null -- status: success -- isLoading: false
      data: {hello:✅} -- error: null -- status: refetching -- isLoading: false
      data: {hello:❌} -- error: null -- status: success -- isLoading: false
      "
    `);
  },
);

//// FIX: add test to other stores
test.concurrent(
  'useDocument with selector should not trigger a rerender',
  async () => {
    const env = createTestEnv({
      useLoadedSnapshot: true,
      emulateRTU: true,
      disableInitialDataInvalidation: true,
    });

    const renders = createRenderStore();

    let prevData: any;

    const { rerender } = renderHook(() => {
      const { data, status } = env.store.useDocument({
        selector: () => ({}),
      });

      renders.add({ status, changed: prevData !== data });
      prevData = data;
    });

    await env.serverMock.waitFetchIdle();

    renders.addMark('Rerenders');

    rerender();
    rerender();
    rerender();

    expect(renders.snapshot).toMatchInlineSnapshotString(`
      "
      status: success -- changed: true

      >>> Rerenders

      status: success -- changed: false
      status: success -- changed: false
      status: success -- changed: false
      "
    `);
  },
);
