import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createBrowserTabsPriority } from '../../src/utils/browserTabsPriority';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function createPriority(getWindowIsFocused: () => boolean) {
  return createBrowserTabsPriority({
    enabled: true,
    tabId: 'local-tab',
    getWindowIsFocused,
    publishStatus() {},
  });
}

test('browser tabs priority assigns the first delayed coalescing slot to a single background tab', () => {
  const priority = createPriority(() => false);

  expect(priority.getPriorityRank()).toBe(1);
  expect(priority.getCoalescingWindowMs(20)).toBe(1_020);

  priority.close();
});

test('browser tabs priority keeps focused tabs on the base coalescing window', () => {
  const priority = createPriority(() => true);

  expect(priority.getPriorityRank()).toBe(1);
  expect(priority.getCoalescingWindowMs(20)).toBe(20);

  priority.close();
});

test('browser tabs priority preserves background fallback ordering when every tab is hidden', () => {
  const priority = createPriority(() => false);

  priority.onTabStatusMessage('remote-tab', {
    kind: 'tab-status',
    isFocused: false,
    lastFocusedAt: 1_000,
    lastPresenceAt: 1_000,
  });

  expect(priority.getPriorityRank()).toBe(2);
  expect(priority.getCoalescingWindowMs(20)).toBe(2_020);

  priority.close();
});

test('browser tabs priority keeps the first background tab behind a focused sibling on the 1 second slot', () => {
  const priority = createPriority(() => false);

  priority.onTabStatusMessage('remote-focused-tab', {
    kind: 'tab-status',
    isFocused: true,
    lastFocusedAt: 1_000,
    lastPresenceAt: 1_000,
  });

  expect(priority.getPriorityRank()).toBe(2);
  expect(priority.getCoalescingWindowMs(20)).toBe(1_020);

  priority.close();
});
