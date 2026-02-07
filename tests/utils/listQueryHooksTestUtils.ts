import { act } from '@testing-library/react';
import { produce } from 'immer';
import { vi } from 'vitest';
import {
  createListQueryStoreTestEnv,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';

export function shouldNotSkip(scheduleResult: string) {
  if (scheduleResult === 'skipped') {
    throw new Error('Should not skip');
  }
}

function flattenTables(tables: Tables): Record<string, Tables[string][number]> {
  const flatItems: Record<string, Tables[string][number]> = {};

  for (const [tableId, rows] of Object.entries(tables)) {
    for (const row of rows) {
      flatItems[`${tableId}||${row.id}`] = row;
    }
  }

  return flatItems;
}

function parseTableState(
  flatItems: Record<string, Tables[string][number]>,
): Tables {
  const tables: Tables = {};

  for (const [itemId, data] of Object.entries(flatItems)) {
    const [tableId] = itemId.split('||');

    if (!tableId) continue;

    tables[tableId] ??= [];
    tables[tableId].push(data);
  }

  for (const tableRows of Object.values(tables)) {
    tableRows.sort((row1, row2) => row1.id - row2.id);
  }

  return tables;
}

export type ListQueryTestEnv = ReturnType<typeof createListQueryStoreTestEnv>;

export function produceServerData(
  env: ListQueryTestEnv,
  recipe: (draft: Tables) => void,
) {
  const nextTables = produce(parseTableState(env.serverTable.getAll()), recipe);
  const nextFlat = flattenTables(nextTables);
  const currentFlat = env.serverTable.getAll();

  for (const itemId of Object.keys(currentFlat)) {
    if (!nextFlat[itemId]) {
      env.serverTable.removeItem(itemId);
    }
  }

  for (const [itemId, data] of Object.entries(nextFlat)) {
    env.serverTable.setItem(itemId, data);
  }
}

export function getFetchCountFromHere(env: ListQueryTestEnv) {
  const startCount = env.serverTable.numOfFinishedFetches;
  return () => env.serverTable.numOfFinishedFetches - startCount;
}

export async function flushAllTimers() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

export async function advanceTime(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
