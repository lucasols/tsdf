import { renderHook } from '@testing-library/react';
import { test } from 'vitest';
import {
  Tables,
  createDefaultListQueryStore,
} from './utils/createDefaultListQueryStore';
import { range } from './utils/range';
import { createRenderLogger } from './utils/storeUtils';

const createTestEnv = createDefaultListQueryStore;

const initialServerData: Tables = {
  users: range(1, 50).map((id) => ({
    id,
    name: `User ${id}`,
    type: id % 2 === 0 ? 'admin' : 'user',
    address: `Address ${id}`,
    age: id,
    city: `City ${id}`,
    country: `Country ${id}`,
    createdAt: 12345678,
    createdBy: `User ${id}`,
    email: `email@${id}.com`,
    phone: `+${id}`,
    postalCode: `1234${id}`,
    updatedAt: 12345678,
    updatedBy: `User ${id}`,
  })),
};

test.concurrent('should load only the selected fields', async () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
    emulateRTU: true,
    disableInitialDataInvalidation: true,
  });

  const renders = createRenderLogger();

  renderHook(() => {
    const result = env.store.useItem('users||1', {
      fields: ['id', 'name', 'address'],
      returnRefetchingStatus: true,
    });

    renders.add(result);
  });

  await env.serverMock.waitFetchIdle();


});
