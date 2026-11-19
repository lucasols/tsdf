import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  expect,
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';

/**
 * Offline replay with several tabs of the same session open, in a real
 * browser: the connection is really cut and restored, and every tab runs its
 * own copy of the app over the same storage.
 *
 * Only the leading tab replays. Playwright pages are all visible, so the tab
 * opened last leads (most recently focused), and the others follow.
 */

const test = base.extend<{ fixtureScopeId: string }>({
  fixtureScopeId: async ({ request }, run, testInfo) => {
    const fixtureScopeId = createFixtureScopeId(testInfo);
    await request.post('/api/test/reset', {
      headers: scopeHeaders(fixtureScopeId),
    });
    await run(fixtureScopeId);
  },
});

function createFixtureScopeId(testInfo: TestInfo): string {
  return encodeURIComponent(
    [
      testInfo.project.name,
      String(testInfo.workerIndex),
      String(testInfo.repeatEachIndex),
      String(testInfo.retry),
      ...testInfo.titlePath,
    ].join('/'),
  );
}

function scopeHeaders(fixtureScopeId: string): Record<string, string> {
  return { 'x-scope-id': fixtureScopeId };
}

type RequestHistoryEntry = {
  method: string;
  path: string;
  pageId: string | null;
  timestamp: number;
};

/**
 * Mutations the fixture server received, as `pageId` of the sending tab, in
 * arrival order (e.g. `page-b, page-b`). Empty when nothing was sent.
 */
async function getSentMutations(
  request: APIRequestContext,
  fixtureScopeId: string,
): Promise<string> {
  const response = await request.get('/api/test/history', {
    headers: scopeHeaders(fixtureScopeId),
  });
  const body = __LEGIT_CAST__<{ history: RequestHistoryEntry[] }, unknown>(
    await response.json(),
  );

  return body.history
    .filter((entry) => entry.path === '/api/document/mutate')
    .map((entry) => entry.pageId ?? 'unknown')
    .join(', ');
}

async function getServerValue(
  request: APIRequestContext,
  fixtureScopeId: string,
): Promise<number> {
  const response = await request.get('/api/document', {
    headers: scopeHeaders(fixtureScopeId),
  });
  const body = __LEGIT_CAST__<{ value: number }, unknown>(
    await response.json(),
  );

  return body.value;
}

async function openTab(
  context: BrowserContext,
  pageId: string,
  fixtureScopeId: string,
  storeId: string,
  /** How long the server takes to answer each replayed edit. */
  replayDelayMs = 0,
): Promise<Page> {
  const page = await context.newPage();
  const searchParams = new URLSearchParams({
    scenario: 'offline-document',
    pageId,
    scopeId: fixtureScopeId,
    storeId,
    sessionKey: `offline-replay-${storeId}`,
    replayDelayMs: String(replayDelayMs),
  });

  await page.goto(`/?${searchParams.toString()}`);
  await expect(page.getByTestId('offline-doc-status')).toHaveText('success');
  return page;
}

async function goOffline(
  context: BrowserContext,
  pages: Page[],
): Promise<void> {
  await context.setOffline(true);
  for (const page of pages) {
    await expect(page.getByTestId('offline-doc-offline-mode')).toHaveText(
      'offline',
    );
  }
}

/** Edits the document in a tab. While offline the edit is queued. */
async function editValue(page: Page, value: number): Promise<void> {
  await page.getByTestId('offline-doc-next-value').fill(String(value));
  await page.getByTestId('offline-doc-set-value').click();
  await expect(page.getByTestId('offline-doc-value')).toHaveText(String(value));
}

async function expectTabState(
  page: Page,
  expected: {
    mode: 'online' | 'offline';
    value: string;
    pendingMutations: string;
    sync: 'pending-sync' | 'synced';
  },
): Promise<void> {
  await expect(page.getByTestId('offline-doc-offline-mode')).toHaveText(
    expected.mode,
  );
  await expect(page.getByTestId('offline-doc-value')).toHaveText(
    expected.value,
  );
  await expect(page.getByTestId('offline-doc-pending-mutations')).toHaveText(
    expected.pendingMutations,
  );
  await expect(page.getByTestId('offline-doc-pending-sync')).toHaveText(
    expected.sync,
  );
}

/** Long enough for a late duplicate request to have reached the server. */
async function waitForStrayRequests(page: Page): Promise<void> {
  await page.waitForTimeout(1_500);
}

/**
 * Makes a tab report itself as hidden or visible, like the user switching
 * browser tabs. Playwright keeps every page visible, so this is the only way
 * to move leadership between two open tabs.
 */
async function setTabHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((isHidden) => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => isHidden,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('an edit queued in a background tab is sent after reconnecting, without a reload', async ({
  context,
  request,
  fixtureScopeId,
}) => {
  const storeId = 'follower-queued-doc';
  const followerTab = await openTab(context, 'page-a', fixtureScopeId, storeId);
  const leaderTab = await openTab(context, 'page-b', fixtureScopeId, storeId);

  await expect(followerTab.getByTestId('offline-doc-leadership')).toHaveText(
    'follower',
  );
  await expect(leaderTab.getByTestId('offline-doc-leadership')).toHaveText(
    'leader',
  );

  await goOffline(context, [followerTab, leaderTab]);

  // The edit is made in the tab that does not lead the session.
  await editValue(followerTab, 5);

  // Both tabs show it as pending.
  for (const tab of [followerTab, leaderTab]) {
    await expectTabState(tab, {
      mode: 'offline',
      value: '5',
      pendingMutations: '1',
      sync: 'pending-sync',
    });
  }
  expect(await getSentMutations(request, fixtureScopeId)).toBe('');

  await context.setOffline(false);

  // The pending state settles in both tabs...
  for (const tab of [followerTab, leaderTab]) {
    await expectTabState(tab, {
      mode: 'online',
      value: '5',
      pendingMutations: '0',
      sync: 'synced',
    });
  }

  // ...because the leading tab sent the edit queued by the other tab, once.
  await waitForStrayRequests(leaderTab);
  expect(await getSentMutations(request, fixtureScopeId)).toBe('page-b');
  expect(await getServerValue(request, fixtureScopeId)).toBe(5);
});

test('edits queued in different tabs for the same document are sent in the order they were made', async ({
  context,
  request,
  fixtureScopeId,
}) => {
  const storeId = 'both-tabs-queued-doc';
  const followerTab = await openTab(context, 'page-a', fixtureScopeId, storeId);
  const leaderTab = await openTab(context, 'page-b', fixtureScopeId, storeId);

  // Round 1: the follower edits first, the leader last.
  await goOffline(context, [followerTab, leaderTab]);
  await editValue(followerTab, 5);
  await editValue(leaderTab, 7);

  // Each tab knows about both queued edits. (While offline a tab keeps
  // showing its own latest edit, so only the pending count is shared here.)
  for (const tab of [followerTab, leaderTab]) {
    await expect(tab.getByTestId('offline-doc-pending-mutations')).toHaveText(
      '2',
    );
  }

  await context.setOffline(false);

  for (const tab of [followerTab, leaderTab]) {
    await expectTabState(tab, {
      mode: 'online',
      value: '7',
      pendingMutations: '0',
      sync: 'synced',
    });
  }

  // Both edits were sent and the last one made is the one that sticks.
  expect(await getSentMutations(request, fixtureScopeId)).toBe(
    'page-b, page-b',
  );
  expect(await getServerValue(request, fixtureScopeId)).toBe(7);

  // Round 2, the other way around: the leader edits first, the follower last.
  // Sending "own edits first" would leave the server with the wrong value in
  // one of the two rounds.
  await goOffline(context, [followerTab, leaderTab]);
  await editValue(leaderTab, 11);
  await editValue(followerTab, 13);
  for (const tab of [followerTab, leaderTab]) {
    await expect(tab.getByTestId('offline-doc-pending-mutations')).toHaveText(
      '2',
    );
  }

  await context.setOffline(false);

  for (const tab of [followerTab, leaderTab]) {
    await expectTabState(tab, {
      mode: 'online',
      value: '13',
      pendingMutations: '0',
      sync: 'synced',
    });
  }

  await waitForStrayRequests(leaderTab);
  expect(await getSentMutations(request, fixtureScopeId)).toBe(
    'page-b, page-b, page-b, page-b',
  );
  expect(await getServerValue(request, fixtureScopeId)).toBe(13);
});

test('the remaining tab takes over and sends its queued edit when the leading tab goes away', async ({
  context,
  request,
  fixtureScopeId,
}) => {
  const storeId = 'leader-gone-doc';
  const remainingTab = await openTab(
    context,
    'page-a',
    fixtureScopeId,
    storeId,
  );
  const leaderTab = await openTab(context, 'page-b', fixtureScopeId, storeId);

  await goOffline(context, [remainingTab, leaderTab]);
  await editValue(remainingTab, 5);
  await expectTabState(leaderTab, {
    mode: 'offline',
    value: '5',
    pendingMutations: '1',
    sync: 'pending-sync',
  });

  // The leading tab goes away while offline. It leaves the app by navigating
  // instead of `page.close()`: closing a page tears down Playwright's offline
  // emulation first, which fires a browser `online` event in the closing page
  // that a real tab close does not.
  await leaderTab.goto('about:blank');

  // The remaining tab now leads the session, still offline.
  await expect(remainingTab.getByTestId('offline-doc-leadership')).toHaveText(
    'leader',
  );
  await expectTabState(remainingTab, {
    mode: 'offline',
    value: '5',
    pendingMutations: '1',
    sync: 'pending-sync',
  });

  await context.setOffline(false);

  await expectTabState(remainingTab, {
    mode: 'online',
    value: '5',
    pendingMutations: '0',
    sync: 'synced',
  });
  await waitForStrayRequests(remainingTab);
  expect(await getSentMutations(request, fixtureScopeId)).toBe('page-a');
  expect(await getServerValue(request, fixtureScopeId)).toBe(5);
});

test('an edit is sent only once when the user switches tabs while it is being replayed', async ({
  context,
  request,
  fixtureScopeId,
}) => {
  const storeId = 'handoff-doc';
  // The server takes a while to answer, so the replay is still in flight when
  // leadership moves.
  const otherTab = await openTab(
    context,
    'page-a',
    fixtureScopeId,
    storeId,
    1_500,
  );
  const leaderTab = await openTab(
    context,
    'page-b',
    fixtureScopeId,
    storeId,
    1_500,
  );

  await goOffline(context, [otherTab, leaderTab]);
  await editValue(leaderTab, 5);
  await expectTabState(otherTab, {
    mode: 'offline',
    value: '5',
    pendingMutations: '1',
    sync: 'pending-sync',
  });

  await context.setOffline(false);

  // The leader started sending the edit...
  await expect
    .poll(() => getSentMutations(request, fixtureScopeId))
    .toBe('page-b');

  // ...and the user switches to the other tab before the server answers. Both
  // tabs hold the same queued edit, and the new leader must not send it again.
  await setTabHidden(leaderTab, true);
  await expect(otherTab.getByTestId('offline-doc-leadership')).toHaveText(
    'leader',
  );

  for (const tab of [otherTab, leaderTab]) {
    await expectTabState(tab, {
      mode: 'online',
      value: '5',
      pendingMutations: '0',
      sync: 'synced',
    });
  }

  await waitForStrayRequests(otherTab);
  expect(await getSentMutations(request, fixtureScopeId)).toBe('page-b');
  expect(await getServerValue(request, fixtureScopeId)).toBe(5);
});

test('an edit is sent only once when a new tab opens while it is being replayed', async ({
  context,
  request,
  fixtureScopeId,
}) => {
  const storeId = 'tab-opened-during-replay-doc';
  const firstTab = await openTab(
    context,
    'page-a',
    fixtureScopeId,
    storeId,
    1_500,
  );

  await goOffline(context, [firstTab]);
  await editValue(firstTab, 5);

  await context.setOffline(false);
  await expect
    .poll(() => getSentMutations(request, fixtureScopeId))
    .toBe('page-a');

  // A new tab boots while the request is in flight. It loads the same queued
  // edit from storage and becomes the leader, but must not send it again.
  const newTab = await openTab(
    context,
    'page-b',
    fixtureScopeId,
    storeId,
    1_500,
  );
  await expect(newTab.getByTestId('offline-doc-leadership')).toHaveText(
    'leader',
  );

  for (const tab of [firstTab, newTab]) {
    await expectTabState(tab, {
      mode: 'online',
      value: '5',
      pendingMutations: '0',
      sync: 'synced',
    });
  }

  await waitForStrayRequests(newTab);
  expect(await getSentMutations(request, fixtureScopeId)).toBe('page-a');
  expect(await getServerValue(request, fixtureScopeId)).toBe(5);
});

/**
 * Cuts or restores the connection of a single tab. Other tabs keep theirs,
 * which is what lets a new tab load the app while this one is still offline.
 */
async function setTabOffline(
  context: BrowserContext,
  page: Page,
  offline: boolean,
): Promise<void> {
  const session = await context.newCDPSession(page);
  await session.send('Network.emulateNetworkConditions', {
    offline,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await session.detach();
}

async function openListTab(
  context: BrowserContext,
  pageId: string,
  fixtureScopeId: string,
  storeId: string,
): Promise<Page> {
  const page = await context.newPage();
  const searchParams = new URLSearchParams({
    scenario: 'offline-list',
    pageId,
    scopeId: fixtureScopeId,
    storeId,
    sessionKey: `offline-replay-${storeId}`,
  });

  await page.goto(`/?${searchParams.toString()}`);
  await expect(page.getByTestId('offline-list-status')).toHaveText('success');
  return page;
}

/** Names of the users the fixture server has, in creation order. */
async function getServerUserNames(
  request: APIRequestContext,
  fixtureScopeId: string,
): Promise<string> {
  const response = await request.get('/api/list?tableId=users', {
    headers: scopeHeaders(fixtureScopeId),
  });
  const body = __LEGIT_CAST__<{ items: { data: { name: string } }[] }, unknown>(
    await response.json(),
  );

  return body.items.map((item) => item.data.name).join(', ');
}

/** Tabs that sent a create request to the fixture server, in arrival order. */
async function getSentCreations(
  request: APIRequestContext,
  fixtureScopeId: string,
): Promise<string> {
  const response = await request.get('/api/test/history', {
    headers: scopeHeaders(fixtureScopeId),
  });
  const body = __LEGIT_CAST__<{ history: RequestHistoryEntry[] }, unknown>(
    await response.json(),
  );

  return body.history
    .filter((entry) => entry.path === '/api/item/users/create')
    .map((entry) => entry.pageId ?? 'unknown')
    .join(', ');
}

test('a record created offline is not created twice when another tab already sent it', async ({
  context,
  request,
  fixtureScopeId,
}) => {
  const storeId = 'duplicate-creation-list';
  const creatingTab = await openListTab(
    context,
    'page-a',
    fixtureScopeId,
    storeId,
  );

  // Tab 1 loses its connection and creates a record, which is queued.
  await setTabOffline(context, creatingTab, true);
  await expect(creatingTab.getByTestId('offline-list-offline-mode')).toHaveText(
    'offline',
  );
  await creatingTab.getByTestId('offline-list-new-user-name').fill('Linus');
  await creatingTab.getByTestId('offline-list-create-user').click();
  await expect(
    creatingTab.getByTestId('offline-list-pending-mutations'),
  ).toHaveText('1');

  // Tab 2 opens afterwards with a working connection. It loads the queued
  // creation from storage, leads the session and sends it.
  const secondTab = await openListTab(
    context,
    'page-b',
    fixtureScopeId,
    storeId,
  );
  await expect(secondTab.getByTestId('offline-list-leadership')).toHaveText(
    'leader',
  );
  await expect
    .poll(() => getSentCreations(request, fixtureScopeId))
    .toBe('page-b');
  await expect(
    secondTab.getByTestId('offline-list-pending-mutations'),
  ).toHaveText('0');

  // The user goes back to tab 1, which reconnects and leads the session
  // again. Its creation was already sent, so it must not send it again.
  await setTabHidden(secondTab, true);
  await setTabOffline(context, creatingTab, false);
  await expect(creatingTab.getByTestId('offline-list-leadership')).toHaveText(
    'leader',
  );
  await expect(creatingTab.getByTestId('offline-list-offline-mode')).toHaveText(
    'online',
  );
  await expect(
    creatingTab.getByTestId('offline-list-pending-mutations'),
  ).toHaveText('0');

  await waitForStrayRequests(creatingTab);
  expect(await getSentCreations(request, fixtureScopeId)).toBe('page-b');
  expect(await getServerUserNames(request, fixtureScopeId)).toBe(
    'Alice, Bob, Linus',
  );
});
