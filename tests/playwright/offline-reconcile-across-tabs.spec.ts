import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  expect,
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';

const test = base.extend<{ fixtureScopeId: string }>({
  fixtureScopeId: async ({ request }, run, testInfo) => {
    const fixtureScopeId = createFixtureScopeId(testInfo);
    await request.post('/api/test/reset', {
      headers: { 'x-scope-id': fixtureScopeId },
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

/**
 * The tabs that sent a "create user" request to the server, in order and
 * separated by commas.
 */
async function getCreateRequestPages(
  request: APIRequestContext,
  fixtureScopeId: string,
): Promise<string> {
  const response = await request.get('/api/test/history', {
    headers: { 'x-scope-id': fixtureScopeId },
  });
  const body = __LEGIT_CAST__<
    { history: Array<{ path: string; pageId: string | null }> },
    unknown
  >(await response.json());

  return body.history
    .filter((entry) => entry.path === '/api/item/users/create')
    .map((entry) => entry.pageId)
    .join(',');
}

/**
 * Opens a tab of the offline list app. All tabs of a test share the browser
 * context, so they share the session, the persisted data and the channel
 * between tabs.
 */
async function openOfflineList(
  context: BrowserContext,
  pageId: string,
  fixtureScopeId: string,
  storeId: string,
): Promise<Page> {
  const page = await context.newPage();
  const searchParams = new URLSearchParams({
    scenario: 'offline-list-reconcile',
    pageId,
    scopeId: fixtureScopeId,
    storeId,
  });

  await page.goto(`/?${searchParams.toString()}`);
  await expect(page.getByTestId('offline-list-status')).toHaveText('success');
  return page;
}

const SERVER_ROWS = 'users||1=Alice,users||2=Bob';
const ROWS_WITH_TEMP_CAROL = `${SERVER_ROWS},temp:Carol=Carol`;
const ROWS_WITH_SAVED_CAROL = `${SERVER_ROWS},users||3=Carol`;

test.describe('a record created offline is saved while several tabs are open', () => {
  test('the tab that did not send the creation keeps the record, follows it to its final id and can resolve the temporary id', async ({
    browser,
    request,
    fixtureScopeId,
  }) => {
    const context = await browser.newContext();
    const storeId = 'offline-reconcile-two-tabs';
    const pageB = await openOfflineList(
      context,
      'page-b',
      fixtureScopeId,
      storeId,
    );
    // Tab A is the one the user opened last and works in: it is the tab that
    // sends the queued changes of the session.
    const pageA = await openOfflineList(
      context,
      'page-a',
      fixtureScopeId,
      storeId,
    );
    await expect(pageA.getByTestId('offline-list-leader')).toHaveText('leader');
    await expect(pageB.getByTestId('offline-list-leader')).toHaveText(
      'follower',
    );

    // The connection drops for the whole browser.
    await pageA.getByTestId('offline-list-go-offline').click();
    await expect(pageA.getByTestId('offline-list-mode')).toHaveText('offline');
    await expect(pageB.getByTestId('offline-list-mode')).toHaveText('offline');

    // The user creates Carol in tab A. Tab B shows the new row too, and the
    // user opens the record there: tab B only knows its temporary id.
    await pageA.getByTestId('offline-list-create-carol').click();
    await expect(pageA.getByTestId('offline-list-rows')).toHaveText(
      ROWS_WITH_TEMP_CAROL,
    );
    await expect(pageB.getByTestId('offline-list-rows')).toHaveText(
      ROWS_WITH_TEMP_CAROL,
    );
    await pageB.getByTestId('offline-list-open-carol').click();
    await expect(pageB.getByTestId('offline-list-opened-record')).toHaveText(
      'temp:Carol=Carol',
    );
    await expect(pageB.getByTestId('offline-list-resolved-carol')).toHaveText(
      'temp:Carol',
    );

    // Back online: tab A sends the creation.
    await pageA.getByTestId('offline-list-go-online').click();

    for (const page of [pageA, pageB]) {
      // Every tab is told which final id replaced the temporary one...
      await expect(page.getByTestId('offline-list-reconciled')).toHaveText(
        'temp:Carol->users||3',
      );
      // ...shows the saved record in the list...
      await expect(page.getByTestId('offline-list-rows')).toHaveText(
        ROWS_WITH_SAVED_CAROL,
      );
      // ...and can resolve the temporary id later.
      await expect(page.getByTestId('offline-list-resolved-carol')).toHaveText(
        'users||3',
      );
    }

    // The page open on the record in tab B followed it instead of losing it.
    await expect(pageB.getByTestId('offline-list-opened-record')).toHaveText(
      'users||3=Carol',
    );
    // The creation reached the server once.
    expect(await getCreateRequestPages(request, fixtureScopeId)).toBe('page-a');

    await context.close();
  });

  test('a record created in one tab and sent by a tab opened later keeps its row in the tab that created it', async ({
    browser,
    request,
    fixtureScopeId,
  }) => {
    const context = await browser.newContext();
    const storeId = 'offline-reconcile-late-tab';
    const creatorPage = await openOfflineList(
      context,
      'page-creator',
      fixtureScopeId,
      storeId,
    );

    await creatorPage.getByTestId('offline-list-go-offline').click();
    await expect(creatorPage.getByTestId('offline-list-mode')).toHaveText(
      'offline',
    );
    await creatorPage.getByTestId('offline-list-create-carol').click();
    await creatorPage.getByTestId('offline-list-open-carol').click();
    await expect(
      creatorPage.getByTestId('offline-list-opened-record'),
    ).toHaveText('temp:Carol=Carol');

    // A tab opened later starts from what is saved on the device, so wait
    // until the new record is saved there.
    await expect
      .poll(() =>
        creatorPage.evaluate(() =>
          Object.keys(window.localStorage).some((key) =>
            key.includes('temp:Carol'),
          ),
        ),
      )
      .toBe(true);

    // The user opens the app in a second tab while still offline. It starts
    // with the creation that is waiting to be sent, and from now on it is the
    // tab that sends the queued changes of the session.
    const latePage = await openOfflineList(
      context,
      'page-late',
      fixtureScopeId,
      storeId,
    );
    await expect(latePage.getByTestId('offline-list-mode')).toHaveText(
      'offline',
    );
    await expect(latePage.getByTestId('offline-list-rows')).toHaveText(
      ROWS_WITH_TEMP_CAROL,
    );
    await expect(latePage.getByTestId('offline-list-leader')).toHaveText(
      'leader',
    );

    await latePage.getByTestId('offline-list-go-online').click();

    // The creation was sent by the tab opened later, yet the tab that
    // created the record keeps its row, in place, and the page open on the
    // record follows it.
    await expect(creatorPage.getByTestId('offline-list-reconciled')).toHaveText(
      'temp:Carol->users||3',
    );
    await expect(creatorPage.getByTestId('offline-list-rows')).toHaveText(
      ROWS_WITH_SAVED_CAROL,
    );
    await expect(
      creatorPage.getByTestId('offline-list-opened-record'),
    ).toHaveText('users||3=Carol');
    await expect(latePage.getByTestId('offline-list-reconciled')).toHaveText(
      'temp:Carol->users||3',
    );
    await expect(latePage.getByTestId('offline-list-rows')).toHaveText(
      ROWS_WITH_SAVED_CAROL,
    );

    // The creation reached the server once, sent by the tab opened later.
    expect(await getCreateRequestPages(request, fixtureScopeId)).toBe(
      'page-late',
    );

    await context.close();
  });
});
