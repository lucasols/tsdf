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
  return createBrowserTabsPriority(
    true,
    () => true,
    'local-tab',
    getWindowIsFocused,
    undefined,
    () => {},
    undefined,
    undefined,
  );
}

test('browser tabs priority assigns the first delayed coalescing slot to a single background tab', () => {
  const priority = createPriority(() => false);

  expect(priority.getPriorityRank()).toBe(1);
  expect(priority.getCoalescingWindowMs(20)).toBe(1_020);

  priority.close();
});

test('browser tabs priority falls back to standalone ranking when sync is disabled', () => {
  const priority = createBrowserTabsPriority(
    true,
    () => false,
    'local-tab',
    () => false,
    undefined,
    () => {},
    undefined,
    undefined,
  );

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

test('browser tabs priority keeps last known background ranks after quiet periods', () => {
  const priority = createPriority(() => false);

  priority.onTabStatusMessage('older-background-tab', {
    kind: 'tab-status',
    isFocused: false,
    lastFocusedAt: 0,
    lastPresenceAt: 1_000,
  });
  priority.onTabStatusMessage('newer-background-tab', {
    kind: 'tab-status',
    isFocused: false,
    lastFocusedAt: 0,
    lastPresenceAt: 2_000,
  });

  vi.advanceTimersByTime(60_000);

  expect(priority.getPriorityRank()).toBe(3);
  expect(priority.getCoalescingWindowMs(20)).toBe(3_020);

  priority.close();
});

test('browser tabs priority immediately promotes a newly focused tab over stale background ranks', () => {
  const leaderChanges: string[] = [];
  const priority = createBrowserTabsPriority(
    true,
    () => true,
    'local-tab',
    () => false,
    undefined,
    () => {},
    undefined,
    (details) => {
      leaderChanges.push(details.leaderTabId);
    },
  );

  priority.onTabStatusMessage('previous-background-leader', {
    kind: 'tab-status',
    isFocused: false,
    lastFocusedAt: 1_000,
    lastPresenceAt: 1_000,
  });
  priority.onTabStatusMessage('newer-background-tab', {
    kind: 'tab-status',
    isFocused: false,
    lastFocusedAt: 0,
    lastPresenceAt: 2_000,
  });

  vi.advanceTimersByTime(60_000);

  expect(priority.getPriorityRank()).toBe(3);
  expect(priority.getCoalescingWindowMs(20)).toBe(3_020);

  priority.onTabStatusMessage('newly-focused-tab', {
    kind: 'tab-status',
    isFocused: true,
    lastFocusedAt: 62_000,
    lastPresenceAt: 62_000,
  });

  expect(priority.getPriorityRank()).toBeGreaterThan(1);
  expect(priority.getCoalescingWindowMs(20)).toBeGreaterThan(20);
  expect(leaderChanges.at(-1)).toBe('newly-focused-tab');

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

test('browser tabs priority publishes local status only when focus state changes', () => {
  let isFocused = true;
  const published: number[] = [];
  const priority = createBrowserTabsPriority(
    true,
    () => true,
    'local-tab',
    () => isFocused,
    undefined,
    () => {
      published.push(Date.now());
    },
    undefined,
    undefined,
  );

  // Initial publish happens synchronously during construction.
  expect(published).toMatchInlineSnapshot(`[0]`);

  // Keeping the same focus state should not produce timer-based status traffic.
  vi.advanceTimersByTime(60_000);
  expect(published).toMatchInlineSnapshot(`[0]`);

  // A real focus-state transition is still announced immediately.
  isFocused = false;
  priority.noteLocalFocusState();
  expect(published).toMatchInlineSnapshot(`[0, 60000]`);

  vi.advanceTimersByTime(60_000);
  expect(published).toMatchInlineSnapshot(`[0, 60000]`);

  isFocused = true;
  priority.noteLocalFocusState();
  expect(published).toMatchInlineSnapshot(`[0, 60000, 120000]`);

  priority.close();
  vi.advanceTimersByTime(5_000);
  expect(published).toMatchInlineSnapshot(`[0, 60000, 120000]`);
});

test('browser tabs priority ignores stale remote tab status messages', () => {
  const priority = createPriority(() => false);

  // Seed the remote tab with a newer status first.
  priority.onTabStatusMessage('remote-tab', {
    kind: 'tab-status',
    isFocused: true,
    lastFocusedAt: 2_000,
    lastPresenceAt: 2_000,
  });

  // A late stale status from the same tab must not overwrite the newer state.
  priority.onTabStatusMessage('remote-tab', {
    kind: 'tab-status',
    isFocused: false,
    lastFocusedAt: 500,
    lastPresenceAt: 500,
  });

  expect(priority.getPriorityRank()).toBe(2);
  expect(priority.getCoalescingWindowMs(20)).toBe(1_020);

  priority.close();
});

test('browser tabs priority expires remote fetch leases after their configured ttl', () => {
  const priority = createPriority(() => false);

  priority.noteRemoteFetchStart('users', 'remote-tab', 0, 200);

  expect(priority.getRemoteLeaseState('users')).toMatchInlineSnapshot(`
    expiresAt: 10000
    ownerTabId: 'remote-tab'
    startedAt: 0
  `);

  vi.setSystemTime(10_001);

  expect(priority.getRemoteLeaseState('users')).toBeNull();

  priority.close();
});

test('browser tabs priority keeps a newer remote lease when an older success arrives later', () => {
  const priority = createPriority(() => false);

  // A remote tab starts one fetch, then starts a newer retry for the same target.
  priority.noteRemoteFetchStart('users', 'remote-tab', 100, 200);
  priority.noteRemoteFetchStart('users', 'remote-tab', 300, 200);

  // The older success should not clear the newer in-flight lease.
  priority.noteRemoteFetchSuccess('users', 'remote-tab', 100, 200);

  expect(priority.getRemoteLeaseState('users')).toMatchInlineSnapshot(`
    expiresAt: 10300
    ownerTabId: 'remote-tab'
    startedAt: 300
  `);

  priority.close();
});
