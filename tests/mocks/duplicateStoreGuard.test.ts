import { expect, test } from 'vitest';
import { setupBrowserTabsTestLifecycle } from '../browser-tabs/browser-tabs-test-helpers';
import { createCollectionStoreTestEnv } from './collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from './documentStoreTestEnv';
import { createListQueryStoreTestEnv } from './listQueryStoreTestEnv';

setupBrowserTabsTestLifecycle();

test('document envs reject duplicate store ids in the default test tab', () => {
  expect(() => {
    createDocumentStoreTestEnv(1, { id: 'dup-doc', testBrowserTabId: 'tab-a' });
    createDocumentStoreTestEnv(1, { id: 'dup-doc', testBrowserTabId: 'tab-a' });
  }).toThrowError(
    '[tests] Duplicate document store "dup-doc" created in the same test tab. Reuse the existing env, choose a different id, or bind each env to a different focus controller when simulating multiple tabs.',
  );
});

test('collection envs reject duplicate store ids in the default test tab', () => {
  expect(() => {
    createCollectionStoreTestEnv(
      { a: { name: 'A' } },
      { id: 'dup-collection', testBrowserTabId: 'tab-a' },
    );
    createCollectionStoreTestEnv(
      { a: { name: 'A' } },
      { id: 'dup-collection', testBrowserTabId: 'tab-a' },
    );
  }).toThrowError(
    '[tests] Duplicate collection store "dup-collection" created in the same test tab. Reuse the existing env, choose a different id, or bind each env to a different focus controller when simulating multiple tabs.',
  );
});

test('list query envs reject duplicate store ids in the default test tab', () => {
  expect(() => {
    createListQueryStoreTestEnv(
      { users: [] },
      { id: 'dup-list-query', testBrowserTabId: 'tab-a' },
    );
    createListQueryStoreTestEnv(
      { users: [] },
      { id: 'dup-list-query', testBrowserTabId: 'tab-a' },
    );
  }).toThrowError(
    '[tests] Duplicate listQuery store "dup-list-query" created in the same test tab. Reuse the existing env, choose a different id, or bind each env to a different focus controller when simulating multiple tabs.',
  );
});

test('same store id is allowed when envs are bound to different tabs', () => {
  expect(() => {
    createDocumentStoreTestEnv(1, {
      id: 'shared-doc',
      testBrowserTabId: 'tab-a',
    });
    createDocumentStoreTestEnv(1, {
      id: 'shared-doc',
      testBrowserTabId: 'tab-b',
    });
  }).not.toThrow();
});
