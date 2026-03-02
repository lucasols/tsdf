import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { afterEach, beforeEach, vi } from 'vitest';
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import type { Row } from '../mocks/listQueryStoreTestEnv';
import { advanceTime } from '../utils/genericTestUtils';

export function setupBrowserTabsTestLifecycle(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', {
      value: false,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createFocusFlag(initialValue: boolean) {
  let current = initialValue;
  return {
    get: () => current,
    set: (value: boolean) => {
      current = value;
    },
  };
}

export type FocusFlag = ReturnType<typeof createFocusFlag>;
export type FocusEventEnv = {
  simulateWindowFocus(): void;
  simulateWindowBlur(): void;
};

export async function setFocusedTab(
  env: FocusEventEnv,
  focusFlags: FocusFlag[],
  focusedTabIndex: number | null,
): Promise<void> {
  for (const [index, focusFlag] of focusFlags.entries()) {
    focusFlag.set(index === focusedTabIndex);
  }

  if (focusedTabIndex === null) {
    env.simulateWindowBlur();
  } else {
    env.simulateWindowFocus();
  }

  await advanceTime(5);
}

export async function markLastActiveTab(
  env: FocusEventEnv,
  focusFlags: FocusFlag[],
  activeTabIndex: number,
): Promise<void> {
  await setFocusedTab(env, focusFlags, activeTabIndex);
  await setFocusedTab(env, focusFlags, null);
}

export function countFetchHistoryEntries<
  TEntry extends {
    type: string;
  },
>(history: TEntry[], type: TEntry['type']): number {
  return history.filter((entry) => entry.type === type).length;
}

export const partialResourcesConfig: PartialResourcesConfig<Row> = {
  mergeItems: (prev, fetched) => {
    if (!prev) return fetched;
    return { ...prev, ...fetched };
  },
  selectFields: (fields, item) => {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in item) {
        result[field] = item[field];
      }
    }
    return __LEGIT_CAST__<Row, Record<string, unknown>>(result);
  },
};

export function getPublisherTabIds(
  messages: Array<{ message: unknown }>,
): Set<string> {
  return new Set(
    messages.map((entry) => {
      const message = __LEGIT_CAST__<{ tabId: string }, unknown>(entry.message);
      return message.tabId;
    }),
  );
}

export function getMessageKinds(
  messages: Array<{ message: unknown }>,
): string[] {
  return messages.map((entry) => {
    const message = __LEGIT_CAST__<{ kind: string }, unknown>(entry.message);
    return message.kind;
  });
}

export function getNonStatusMessages(messages: Array<{ message: unknown }>) {
  return messages.filter((entry) => {
    const message = __LEGIT_CAST__<{ kind: string }, unknown>(entry.message);
    return message.kind !== 'tab-status';
  });
}

export function createCollectionItems() {
  return {
    item1: { name: 'Item 1' },
    item2: { name: 'Item 2' },
  };
}

export function createUsersTable() {
  return {
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ],
  };
}

export function createThreeUsersTable() {
  return {
    users: [
      { id: 1, name: 'User 1' },
      { id: 2, name: 'User 2' },
      { id: 3, name: 'User 3' },
    ],
  };
}

export function createOptimisticSortConfig() {
  return [
    {
      queries: { tableId: 'users' },
      sort: {
        sortBy: (item: { name: string }) => item.name,
        order: 'asc' as const,
      },
    },
  ];
}
