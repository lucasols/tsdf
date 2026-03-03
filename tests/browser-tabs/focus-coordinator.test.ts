import { expect, test } from 'vitest';
import {
  createFocusChangeCoordinator,
  setupBrowserTabsTestLifecycle,
} from './browser-tabs-test-helpers';

setupBrowserTabsTestLifecycle();

test('focusTab with no previous tab sets flag to true', async () => {
  const tabs = createFocusChangeCoordinator(['a', 'b']);

  await tabs.focusTab('a');

  expect(tabs.getWindowIsFocused('a')()).toBe(true);
  expect(tabs.getWindowIsFocused('b')()).toBe(false);
});

test('focusTab switching tabs blurs old flag and focuses new flag, others unchanged', async () => {
  const tabs = createFocusChangeCoordinator(['a', 'b', 'c']);

  await tabs.focusTab('a');
  await tabs.focusTab('b');

  expect(tabs.getWindowIsFocused('a')()).toBe(false);
  expect(tabs.getWindowIsFocused('b')()).toBe(true);
  expect(tabs.getWindowIsFocused('c')()).toBe(false);
});

test('focusTab on already-focused tab is a no-op', async () => {
  const tabs = createFocusChangeCoordinator(['a']);
  const events: string[] = [];
  const binding = tabs.bind('a');
  binding.onWindowFocus(() => {
    events.push('focus');
  });
  binding.onWindowBlur(() => {
    events.push('blur');
  });

  await tabs.focusTab('a');
  const eventCountAfterFirstFocus = events.length;

  await tabs.focusTab('a');

  expect(events.length).toBe(eventCountAfterFirstFocus);
  expect(tabs.getWindowIsFocused('a')()).toBe(true);
});

test('blur after focus sets flag to false', async () => {
  const tabs = createFocusChangeCoordinator(['a']);

  await tabs.focusTab('a');
  await tabs.blur();

  expect(tabs.getWindowIsFocused('a')()).toBe(false);
});

test('blur when nothing focused is a no-op', async () => {
  const tabs = createFocusChangeCoordinator(['a']);
  const events: string[] = [];
  const binding = tabs.bind('a');
  binding.onWindowFocus(() => {
    events.push('focus');
  });
  binding.onWindowBlur(() => {
    events.push('blur');
  });

  await tabs.blur();

  expect(events.length).toBe(0);
  expect(tabs.getWindowIsFocused('a')()).toBe(false);
});

test('focusTab after blur does not blur before focusing (no previous tab to blur)', async () => {
  const tabs = createFocusChangeCoordinator(['a', 'b']);

  await tabs.focusTab('a');
  await tabs.blur();

  expect(tabs.getWindowIsFocused('a')()).toBe(false);

  await tabs.focusTab('b');

  expect(tabs.getWindowIsFocused('a')()).toBe(false);
  expect(tabs.getWindowIsFocused('b')()).toBe(true);
});

test('full 3-tab ranking sequence produces correct flag states at each step', async () => {
  const tabs = createFocusChangeCoordinator(['a', 'b', 'c']);

  await tabs.focusTab('c');
  expect(tabs.getWindowIsFocused('a')()).toBe(false);
  expect(tabs.getWindowIsFocused('b')()).toBe(false);
  expect(tabs.getWindowIsFocused('c')()).toBe(true);

  await tabs.focusTab('b');
  expect(tabs.getWindowIsFocused('a')()).toBe(false);
  expect(tabs.getWindowIsFocused('b')()).toBe(true);
  expect(tabs.getWindowIsFocused('c')()).toBe(false);

  await tabs.focusTab('a');
  expect(tabs.getWindowIsFocused('a')()).toBe(true);
  expect(tabs.getWindowIsFocused('b')()).toBe(false);
  expect(tabs.getWindowIsFocused('c')()).toBe(false);

  await tabs.blur();
  expect(tabs.getWindowIsFocused('a')()).toBe(false);
  expect(tabs.getWindowIsFocused('b')()).toBe(false);
  expect(tabs.getWindowIsFocused('c')()).toBe(false);
});

test('initialFocused sets the initial flag state', () => {
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');

  expect(tabs.getWindowIsFocused('a')()).toBe(true);
  expect(tabs.getWindowIsFocused('b')()).toBe(false);
});

test('per-tab listeners fire only for the correct tab', async () => {
  const tabs = createFocusChangeCoordinator(['a', 'b']);
  const events: string[] = [];

  const bindingA = tabs.bind('a');
  bindingA.onWindowFocus(() => {
    events.push('a:focus');
  });
  bindingA.onWindowBlur(() => {
    events.push('a:blur');
  });

  const bindingB = tabs.bind('b');
  bindingB.onWindowFocus(() => {
    events.push('b:focus');
  });
  bindingB.onWindowBlur(() => {
    events.push('b:blur');
  });

  await tabs.focusTab('a');
  expect(events).toMatchInlineSnapshot(`['a:focus']`);

  await tabs.focusTab('b');
  expect(events).toMatchInlineSnapshot(`['a:focus', 'a:blur', 'b:focus']`);

  await tabs.blur();
  expect(events).toMatchInlineSnapshot(
    `['a:focus', 'a:blur', 'b:focus', 'b:blur']`,
  );
});

test('cleanup function removes the listener', async () => {
  const tabs = createFocusChangeCoordinator(['a']);
  const events: string[] = [];

  const binding = tabs.bind('a');
  const cleanup = binding.onWindowFocus(() => {
    events.push('focus');
  });

  await tabs.focusTab('a');
  expect(events).toMatchInlineSnapshot(`['focus']`);

  cleanup();

  await tabs.blur();
  await tabs.focusTab('a');
  expect(events).toMatchInlineSnapshot(`['focus']`);
});
