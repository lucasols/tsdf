import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';

async function resetFixture(request: APIRequestContext): Promise<void> {
  await request.post('/api/test/reset');
}

async function resetHistory(request: APIRequestContext): Promise<void> {
  await request.post('/api/test/history/reset');
}

type RequestHistoryEntry = {
  method: string;
  path: string;
  pageId: string | null;
  timestamp: number;
};

async function getHistory(
  request: APIRequestContext,
): Promise<RequestHistoryEntry[]> {
  const response = await request.get('/api/test/history');
  const body = __LEGIT_CAST__<{ history: RequestHistoryEntry[] }, unknown>(
    await response.json(),
  );
  return body.history;
}

function countRequests(
  history: RequestHistoryEntry[],
  options: { pageId?: string; path: string; method?: string },
): number {
  return history.filter((entry) => {
    if (options.pageId && entry.pageId !== options.pageId) {
      return false;
    }

    if (options.method && entry.method !== options.method) {
      return false;
    }

    return entry.path === options.path;
  }).length;
}

async function openScenario(
  context: BrowserContext,
  scenario: 'document' | 'collection' | 'list',
  pageId: string,
  options?: { storeId?: string },
) {
  const page = await context.newPage();
  const searchParams = new URLSearchParams({
    scenario,
    pageId,
  });

  if (options?.storeId) {
    searchParams.set('storeId', options.storeId);
  }

  await page.goto(`/?${searchParams.toString()}`);
  return page;
}

async function waitForPageSettle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  });
}

async function setAllPagesBackgroundInOrder(
  pages: Array<{
    page: Page;
    prefix: 'document' | 'collection' | 'list';
  }>,
): Promise<void> {
  for (const { page, prefix } of pages) {
    await page.getByTestId(`${prefix}-focus-background`).click();
  }

  for (const { page, prefix } of pages) {
    await page.getByTestId(`${prefix}-focus-active`).click();
    await page.getByTestId(`${prefix}-focus-background`).click();
  }
}

test.beforeEach(async ({ request }) => {
  await resetFixture(request);
});

test('document optimistic mutation updates a sibling page without sibling network work', async ({
  browser,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(context, 'document', 'page-a');
  const pageB = await openScenario(context, 'document', 'page-b');

  await expect(pageA.getByTestId('document-value')).toHaveText('0');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  await resetHistory(request);
  await pageA.getByTestId('document-mutate-optimistic').click();

  await expect(pageA.getByTestId('document-value')).toHaveText('1');
  await expect(pageB.getByTestId('document-value')).toHaveText('1');

  const history = await getHistory(request);
  expect(
    countRequests(history, { pageId: 'page-a', path: '/api/document/mutate' }),
  ).toBe(1);
  expect(
    countRequests(history, {
      pageId: 'page-b',
      path: '/api/document',
      method: 'GET',
    }),
  ).toBe(0);

  await context.close();
});

test('document realtime updates stay in the active page and sync to the background page', async ({
  browser,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(context, 'document', 'page-a');
  const pageB = await openScenario(context, 'document', 'page-b');

  await expect(pageA.getByTestId('document-value')).toHaveText('0');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  await pageA.getByTestId('document-focus-active').click();
  await pageB.getByTestId('document-focus-background').click();

  await resetHistory(request);
  await pageA.getByTestId('document-trigger-rtu').click();

  await expect(pageA.getByTestId('document-value')).toHaveText('2');
  await expect(pageB.getByTestId('document-value')).toHaveText('2');

  const history = await getHistory(request);
  expect(
    countRequests(history, {
      pageId: 'page-a',
      path: '/api/document',
      method: 'GET',
    }),
  ).toBe(1);
  expect(
    countRequests(history, {
      pageId: 'page-b',
      path: '/api/document',
      method: 'GET',
    }),
  ).toBe(0);

  await context.close();
});

test('document realtime updates do not sync across different store ids', async ({
  browser,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(context, 'document', 'page-a', {
    storeId: 'document-store-a',
  });
  const pageB = await openScenario(context, 'document', 'page-b', {
    storeId: 'document-store-b',
  });

  await expect(pageA.getByTestId('document-value')).toHaveText('0');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  await pageA.getByTestId('document-focus-active').click();
  await pageB.getByTestId('document-focus-background').click();

  await resetHistory(request);
  await pageA.getByTestId('document-trigger-rtu').click();

  await expect(pageA.getByTestId('document-value')).toHaveText('2');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  const history = await getHistory(request);
  expect(
    countRequests(history, {
      pageId: 'page-a',
      path: '/api/document',
      method: 'GET',
    }),
  ).toBe(1);
  expect(
    countRequests(history, {
      pageId: 'page-b',
      path: '/api/document',
      method: 'GET',
    }),
  ).toBe(0);

  await context.close();
});

test('collection optimistic mutations propagate without sibling refetches', async ({
  browser,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(context, 'collection', 'page-a');
  const pageB = await openScenario(context, 'collection', 'page-b');

  await expect(pageA.getByTestId('collection-item1-name')).toHaveText('Item 1');
  await expect(pageB.getByTestId('collection-item1-name')).toHaveText('Item 1');
  await waitForPageSettle(pageA);
  await waitForPageSettle(pageB);

  await resetHistory(request);
  await pageA.getByTestId('collection-item1-mutate').click();

  await expect(pageA.getByTestId('collection-item1-name')).toHaveText(
    'Updated',
  );
  await expect(pageB.getByTestId('collection-item1-name')).toHaveText(
    'Updated',
  );

  const history = await getHistory(request);
  expect(
    countRequests(history, {
      pageId: 'page-a',
      path: '/api/collection/item1/mutate',
    }),
  ).toBe(1);
  expect(
    countRequests(history, {
      pageId: 'page-b',
      path: '/api/collection/item1',
      method: 'GET',
    }),
  ).toBe(0);

  await context.close();
});

test('document realtime updates are deduplicated when every page is backgrounded and the last active page leads', async ({
  browser,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(context, 'document', 'page-a');
  const pageB = await openScenario(context, 'document', 'page-b');

  await expect(pageA.getByTestId('document-value')).toHaveText('0');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  await setAllPagesBackgroundInOrder([
    { page: pageB, prefix: 'document' },
    { page: pageA, prefix: 'document' },
  ]);

  await resetHistory(request);
  await pageA.getByTestId('document-trigger-rtu').click();

  await expect(pageA.getByTestId('document-value')).toHaveText('2');
  await expect(pageB.getByTestId('document-value')).toHaveText('2');

  const history = await getHistory(request);
  expect(
    countRequests(history, {
      pageId: 'page-a',
      path: '/api/document',
      method: 'GET',
    }),
  ).toBe(1);
  expect(
    countRequests(history, {
      pageId: 'page-b',
      path: '/api/document',
      method: 'GET',
    }),
  ).toBe(0);

  await context.close();
});

test('document realtime updates remain isolated across different store ids while every page is backgrounded', async ({
  browser,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(context, 'document', 'page-a', {
    storeId: 'document-store-a',
  });
  const pageB = await openScenario(context, 'document', 'page-b', {
    storeId: 'document-store-b',
  });

  await expect(pageA.getByTestId('document-value')).toHaveText('0');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  await setAllPagesBackgroundInOrder([
    { page: pageB, prefix: 'document' },
    { page: pageA, prefix: 'document' },
  ]);

  await resetHistory(request);
  await pageA.getByTestId('document-trigger-rtu').click();

  await expect(pageA.getByTestId('document-value')).toHaveText('2');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  const history = await getHistory(request);
  expect(
    countRequests(history, {
      pageId: 'page-a',
      path: '/api/document',
      method: 'GET',
    }),
  ).toBe(1);
  expect(
    countRequests(history, {
      pageId: 'page-b',
      path: '/api/document',
      method: 'GET',
    }),
  ).toBe(0);

  await context.close();
});

test('collection realtime updates are deduplicated when every page is backgrounded', async ({
  browser,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(context, 'collection', 'page-a');
  const pageB = await openScenario(context, 'collection', 'page-b');

  await expect(pageA.getByTestId('collection-item1-name')).toHaveText('Item 1');
  await expect(pageB.getByTestId('collection-item1-name')).toHaveText('Item 1');

  await setAllPagesBackgroundInOrder([
    { page: pageB, prefix: 'collection' },
    { page: pageA, prefix: 'collection' },
  ]);

  await resetHistory(request);
  await pageA.getByTestId('collection-trigger-rtu').click();

  await expect(pageA.getByTestId('collection-item1-name')).toHaveText(
    'Updated',
  );
  await expect(pageB.getByTestId('collection-item1-name')).toHaveText(
    'Updated',
  );

  const history = await getHistory(request);
  expect(
    countRequests(history, {
      pageId: 'page-a',
      path: '/api/collection/item1',
      method: 'GET',
    }),
  ).toBe(1);
  expect(
    countRequests(history, {
      pageId: 'page-b',
      path: '/api/collection/item1',
      method: 'GET',
    }),
  ).toBe(0);

  await context.close();
});

test('list query realtime updates are deduplicated when every page is backgrounded', async ({
  browser,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(context, 'list', 'page-a');
  const pageB = await openScenario(context, 'list', 'page-b');

  await expect(pageA.getByTestId('list-query-order')).toHaveText(
    'users||1,users||2',
  );
  await expect(pageB.getByTestId('list-query-order')).toHaveText(
    'users||1,users||2',
  );

  await setAllPagesBackgroundInOrder([
    { page: pageB, prefix: 'list' },
    { page: pageA, prefix: 'list' },
  ]);

  await resetHistory(request);
  await pageA.getByTestId('list-trigger-rtu').click();

  await expect(pageA.getByTestId('list-item1-name')).toHaveText('Zoe');
  await expect(pageB.getByTestId('list-item1-name')).toHaveText('Zoe');

  const history = await getHistory(request);
  expect(
    countRequests(history, {
      pageId: 'page-a',
      path: '/api/list',
      method: 'GET',
    }),
  ).toBe(1);
  expect(
    countRequests(history, {
      pageId: 'page-b',
      path: '/api/list',
      method: 'GET',
    }),
  ).toBe(0);

  await context.close();
});

test('document scheduler timing sync suppresses redundant low-priority requests in sibling pages', async ({
  browser,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(context, 'document', 'page-a');
  const pageB = await openScenario(context, 'document', 'page-b');

  await expect(pageA.getByTestId('document-value')).toHaveText('0');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  await resetHistory(request);
  await pageA.getByTestId('document-fetch-high').click();
  await expect
    .poll(async () => {
      const history = await getHistory(request);
      return countRequests(history, {
        pageId: 'page-a',
        path: '/api/document',
        method: 'GET',
      });
    })
    .toBe(1);

  await pageB.getByTestId('document-fetch-low').click();
  await expect(pageB.getByTestId('document-last-schedule-result')).toHaveText(
    'skipped',
  );

  const history = await getHistory(request);
  expect(
    countRequests(history, {
      pageId: 'page-b',
      path: '/api/document',
      method: 'GET',
    }),
  ).toBe(0);

  await context.close();
});
