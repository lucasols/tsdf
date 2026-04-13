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
    transportEnabled: true,
    getIsEnabled: () => true,
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

test('browser tabs priority falls back to standalone ranking when sync is disabled', () => {
  const priority = createBrowserTabsPriority({
    transportEnabled: true,
    getIsEnabled: () => false,
    tabId: 'local-tab',
    getWindowIsFocused: () => false,
    publishStatus() {},
  });

  priority.onTabStatusMessage('remote-tab', {
    kind: 'tab-status',
    isFocused: true,
    lastFocusedAt: 1_000,
    lastPresenceAt: 1_000,
  });

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

test('browser tabs priority republishes local status on each heartbeat until close', () => {
  // An explicit heartbeatMs is required to enable the heartbeat interval in
  // tests — the default otherwise suppresses it via import.meta.env.TEST.
  const published: number[] = [];
  const priority = createBrowserTabsPriority({
    transportEnabled: true,
    getIsEnabled: () => true,
    tabId: 'local-tab',
    getWindowIsFocused: () => true,
    publishStatus() {
      published.push(Date.now());
    },
    timings: { heartbeatMs: 1_000 },
  });

  // Initial publish happens synchronously during construction.
  expect(published).toMatchInlineSnapshot(`[0]`);

  // Advancing past the heartbeat interval should trigger a republish each tick.
  vi.advanceTimersByTime(2_500);
  expect(published).toMatchInlineSnapshot(`[0, 1000, 2000]`);

  // close() must stop the interval so no further ticks fire.
  priority.close();
  vi.advanceTimersByTime(5_000);
  expect(published).toMatchInlineSnapshot(`[0, 1000, 2000]`);
});
