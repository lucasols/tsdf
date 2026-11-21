import { expect, test } from 'vitest';
import { createOfflineNetworkMock } from '../../src/testing';

test('a test that ends offline does not leave the next test offline when the mock is shared', () => {
  // The documented setup: one mock for the whole file, `install()` in
  // `beforeEach` and `uninstall()` in `afterEach`.
  const network = createOfflineNetworkMock();

  function readNetwork() {
    return {
      mockIsOnline: network.isOnline(),
      navigatorOnLine: window.navigator.onLine,
      // What a session configured with `network.config` reads.
      configReportsOffline: network.config.getIsOffline?.(),
    };
  }

  // First test: it goes offline and ends (or fails) before going back online.
  network.install();
  network.goOffline();

  expect(readNetwork()).toMatchInlineSnapshot(`
    configReportsOffline: '✅'
    mockIsOnline: '❌'
    navigatorOnLine: '❌'
  `);

  network.uninstall();

  // Between tests the real `navigator.onLine` is back.
  expect(window.navigator.onLine).toBe(true);

  // Next test: it starts from the initial (online) status again.
  network.install();

  expect(readNetwork()).toMatchInlineSnapshot(`
    configReportsOffline: '❌'
    mockIsOnline: '✅'
    navigatorOnLine: '✅'
  `);

  network.uninstall();
});
