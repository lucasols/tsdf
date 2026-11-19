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
 * Forced offline mode in a real browser: the network stays up the whole time
 * (the fixture server keeps answering), only the offline session is told to
 * behave as if it were offline.
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

/** Requests the fixture server received, as `METHOD path (pageId)`. */
async function getServerRequests(
  request: APIRequestContext,
  fixtureScopeId: string,
): Promise<string[]> {
  const response = await request.get('/api/test/history', {
    headers: scopeHeaders(fixtureScopeId),
  });
  const body = __LEGIT_CAST__<{ history: RequestHistoryEntry[] }, unknown>(
    await response.json(),
  );

  return body.history.map(
    (entry) => `${entry.method} ${entry.path} (${entry.pageId ?? 'unknown'})`,
  );
}

async function resetServerRequests(
  request: APIRequestContext,
  fixtureScopeId: string,
): Promise<void> {
  await request.post('/api/test/history/reset', {
    headers: scopeHeaders(fixtureScopeId),
  });
}

async function openOfflineDocument(
  context: BrowserContext,
  pageId: string,
  fixtureScopeId: string,
  storeId: string,
): Promise<Page> {
  const page = await context.newPage();
  const searchParams = new URLSearchParams({
    scenario: 'offline-document',
    pageId,
    scopeId: fixtureScopeId,
    storeId,
    sessionKey: 'forced-offline-session',
  });

  await page.goto(`/?${searchParams.toString()}`);
  return page;
}

/**
 * The document cache is saved with a debounce. Offline boots can only render
 * what is already in storage, so wait for it before reloading or opening tabs.
 */
async function waitForDocumentCache(
  page: Page,
  storeId: string,
): Promise<void> {
  await page.waitForFunction(
    (cachedStoreId) =>
      Object.keys(localStorage).some((key) =>
        key.endsWith(`.${cachedStoreId}`),
      ),
    storeId,
  );
}

async function expectOfflineState(
  page: Page,
  expected: {
    mode: 'online' | 'offline';
    forced: 'forced' | 'not-forced';
    value: string;
    pending: string;
  },
): Promise<void> {
  await expect(page.getByTestId('offline-doc-forced')).toHaveText(
    expected.forced,
  );
  await expect(page.getByTestId('offline-doc-offline-mode')).toHaveText(
    expected.mode,
  );
  await expect(page.getByTestId('offline-doc-value')).toHaveText(
    expected.value,
  );
  await expect(page.getByTestId('offline-doc-pending')).toHaveText(
    expected.pending,
  );
}

/** Long enough for a fetch, a replay or a recovery to have happened. */
async function waitForBackgroundWork(page: Page): Promise<void> {
  await page.waitForTimeout(750);
}

test('forced offline mode survives a reload, queues edits and replays them once released', async ({
  context,
  request,
  fixtureScopeId,
}) => {
  const storeId = 'forced-offline-reload-doc';
  const page = await openOfflineDocument(
    context,
    'page-a',
    fixtureScopeId,
    storeId,
  );

  // Online boot: the document is fetched and cached.
  await expect(page.getByTestId('offline-doc-status')).toHaveText('success');
  await expectOfflineState(page, {
    mode: 'online',
    forced: 'not-forced',
    value: '0',
    pending: '0',
  });

  await waitForDocumentCache(page, storeId);

  // Force offline and wait for the flag to be persisted before reloading.
  await page.getByTestId('offline-doc-force-offline').click();
  await expect(page.getByTestId('offline-doc-persisted-toggles')).toHaveText(
    '1',
  );
  await resetServerRequests(request, fixtureScopeId);

  await page.reload();

  // The reloaded page boots offline and renders the cached document.
  await expectOfflineState(page, {
    mode: 'offline',
    forced: 'forced',
    value: '0',
    pending: '0',
  });
  await expect(page.getByTestId('offline-doc-status')).toHaveText('success');

  // An edit made while forced offline is queued.
  await page.getByTestId('offline-doc-mutate').click();
  await expectOfflineState(page, {
    mode: 'offline',
    forced: 'forced',
    value: '1',
    pending: '1',
  });

  // Neither the boot fetch nor the edit reached the server, even though the
  // real network was up the whole time.
  await waitForBackgroundWork(page);
  expect(await getServerRequests(request, fixtureScopeId)).toEqual([]);

  // Releasing forced mode recovers like a reconnect: the edit is replayed.
  await page.getByTestId('offline-doc-release-offline').click();
  await expectOfflineState(page, {
    mode: 'online',
    forced: 'not-forced',
    value: '1',
    pending: '0',
  });
  expect(
    (await getServerRequests(request, fixtureScopeId)).filter((entry) =>
      entry.startsWith('POST '),
    ),
  ).toEqual(['POST /api/document/mutate (page-a)']);

  // The released state is persisted too: the next reload boots online.
  await expect(page.getByTestId('offline-doc-persisted-toggles')).toHaveText(
    '1',
  );
  await page.reload();
  await expect(page.getByTestId('offline-doc-status')).toHaveText('success');
  await expectOfflineState(page, {
    mode: 'online',
    forced: 'not-forced',
    value: '1',
    pending: '0',
  });
});

test('forced offline mode is shared by every tab of the session', async ({
  context,
  request,
  fixtureScopeId,
}) => {
  const storeId = 'forced-offline-tabs-doc';
  const pageA = await openOfflineDocument(
    context,
    'page-a',
    fixtureScopeId,
    storeId,
  );
  const pageB = await openOfflineDocument(
    context,
    'page-b',
    fixtureScopeId,
    storeId,
  );

  for (const page of [pageA, pageB]) {
    await expect(page.getByTestId('offline-doc-status')).toHaveText('success');
    await expectOfflineState(page, {
      mode: 'online',
      forced: 'not-forced',
      value: '0',
      pending: '0',
    });
  }

  await waitForDocumentCache(pageA, storeId);

  // Forcing offline in one tab takes the already-open sibling offline too.
  await pageA.getByTestId('offline-doc-force-offline').click();
  await expect(pageA.getByTestId('offline-doc-persisted-toggles')).toHaveText(
    '1',
  );
  for (const page of [pageA, pageB]) {
    await expectOfflineState(page, {
      mode: 'offline',
      forced: 'forced',
      value: '0',
      pending: '0',
    });
  }

  // A tab opened afterwards boots forced offline from the persisted flag.
  const pageC = await openOfflineDocument(
    context,
    'page-c',
    fixtureScopeId,
    storeId,
  );
  await expectOfflineState(pageC, {
    mode: 'offline',
    forced: 'forced',
    value: '0',
    pending: '0',
  });
  await resetServerRequests(request, fixtureScopeId);

  // An edit is queued, and every tab sees it pending. It is made in the last
  // opened tab because that is the tab leading the session: replay is done by
  // the leader, from its own queue.
  await pageC.getByTestId('offline-doc-mutate').click();
  for (const page of [pageA, pageB, pageC]) {
    await expectOfflineState(page, {
      mode: 'offline',
      forced: 'forced',
      value: '1',
      pending: '1',
    });
  }

  // No tab talks to the server while the session is forced offline.
  await waitForBackgroundWork(pageC);
  expect(await getServerRequests(request, fixtureScopeId)).toEqual([]);

  // Releasing from a tab that neither forced it nor queued the edit brings
  // every tab back online, and the leader replays the edit.
  await pageB.getByTestId('offline-doc-release-offline').click();
  for (const page of [pageA, pageB, pageC]) {
    await expectOfflineState(page, {
      mode: 'online',
      forced: 'not-forced',
      value: '1',
      pending: '0',
    });
  }

  // The queued edit was sent exactly once.
  await waitForBackgroundWork(pageC);
  expect(
    (await getServerRequests(request, fixtureScopeId)).filter((entry) =>
      entry.startsWith('POST '),
    ),
  ).toEqual(['POST /api/document/mutate (page-c)']);
});
