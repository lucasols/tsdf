/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import { pick } from './utils/objectUtils';
import { sleep } from './utils/sleep';
import { createDefaultDocumentStore } from './utils/storeUtils';

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
