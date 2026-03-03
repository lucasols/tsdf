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

export type FocusControllerBinding = {
  getWindowIsFocused: () => boolean;
  /** Per-tab focus subscription. Calls the handler when this tab receives focus. */
  onWindowFocus: (handler: () => void) => () => void;
  /** Per-tab blur subscription. Calls the handler when this tab loses focus. */
  onWindowBlur: (handler: () => void) => () => void;
};

export interface FocusChangeCoordinator<T extends string> {
  /** Returns a `getWindowIsFocused` getter for the given tab, for use in store env creation. */
  getWindowIsFocused(tab: T): () => boolean;
  /** Returns a binding for use as `bindFocusController` in test env options. Provides per-tab `getWindowIsFocused`, `onWindowFocus`, and `onWindowBlur`. */
  bind(tab: T): FocusControllerBinding;
  /** Focus a tab. If another tab was focused, it gets blurred first (like a real browser tab switch). */
  focusTab(tab: T): Promise<void>;
  /** Blur all tabs (simulates window going to background). No-op if nothing is focused. */
  blur(): Promise<void>;
}

export function createFocusChangeCoordinator<T extends string>(
  tabs: readonly T[],
  initialFocused: T | null,
): FocusChangeCoordinator<T> {
  const flags = new Map<
    string,
    { get: () => boolean; set: (v: boolean) => void }
  >();
  const focusListeners = new Map<string, Set<() => void>>();
  const blurListeners = new Map<string, Set<() => void>>();
  let currentFocused: string | null = initialFocused ?? null;

  for (const tab of tabs) {
    const flag = createFocusFlag(tab === currentFocused);
    flags.set(tab, flag);
    focusListeners.set(tab, new Set());
    blurListeners.set(tab, new Set());
  }

  function getFlag(tab: string) {
    const flag = flags.get(tab);
    if (!flag) {
      throw new Error(`Unknown tab "${tab}"`);
    }
    return flag;
  }

  function notifyFocus(tab: string) {
    const listeners = focusListeners.get(tab);
    if (listeners) {
      for (const listener of listeners) {
        listener();
      }
    }
  }

  function notifyBlur(tab: string) {
    const listeners = blurListeners.get(tab);
    if (listeners) {
      for (const listener of listeners) {
        listener();
      }
    }
  }

  return {
    getWindowIsFocused(tab) {
      return getFlag(tab).get;
    },

    bind(tab) {
      return {
        getWindowIsFocused: getFlag(tab).get,
        onWindowFocus(handler) {
          const listeners = focusListeners.get(tab);
          if (!listeners) {
            throw new Error(`Unknown tab "${tab}"`);
          }
          listeners.add(handler);
          return () => {
            listeners.delete(handler);
          };
        },
        onWindowBlur(handler) {
          const listeners = blurListeners.get(tab);
          if (!listeners) {
            throw new Error(`Unknown tab "${tab}"`);
          }
          listeners.add(handler);
          return () => {
            listeners.delete(handler);
          };
        },
      };
    },

    async focusTab(tab) {
      if (currentFocused === tab) return;

      if (currentFocused !== null) {
        getFlag(currentFocused).set(false);
        notifyBlur(currentFocused);
        await advanceTime(5);
      }

      getFlag(tab).set(true);
      notifyFocus(tab);
      await advanceTime(5);
      currentFocused = tab;
    },

    async blur() {
      if (currentFocused === null) return;

      getFlag(currentFocused).set(false);
      notifyBlur(currentFocused);
      await advanceTime(5);
      currentFocused = null;
    },
  };
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
