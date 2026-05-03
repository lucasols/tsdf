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
    await resetFixture(request, fixtureScopeId);
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

async function resetFixture(
  request: APIRequestContext,
  fixtureScopeId: string,
): Promise<void> {
  await request.post('/api/test/reset', {
    headers: scopeHeaders(fixtureScopeId),
  });
}

async function resetHistory(
  request: APIRequestContext,
  fixtureScopeId: string,
): Promise<void> {
  await request.post('/api/test/history/reset', {
    headers: scopeHeaders(fixtureScopeId),
  });
}

type RequestHistoryEntry = {
  method: string;
  path: string;
  pageId: string | null;
  timestamp: number;
};

async function getHistory(
  request: APIRequestContext,
  fixtureScopeId: string,
): Promise<RequestHistoryEntry[]> {
  const response = await request.get('/api/test/history', {
    headers: scopeHeaders(fixtureScopeId),
  });
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
  fixtureScopeId: string,
  options?: { storeId?: string; sessionKey?: string; debug?: boolean },
) {
  const page = await context.newPage();
  const searchParams = new URLSearchParams({
    scenario,
    pageId,
    scopeId: fixtureScopeId,
  });

  if (options?.storeId) {
    searchParams.set('storeId', options.storeId);
  }

  if (options?.sessionKey) {
    searchParams.set('sessionKey', options.sessionKey);
  }

  if (options?.debug) {
    searchParams.set('debug', '1');
  }

  await page.goto(`/?${searchParams.toString()}`);
  return page;
}

type DebugLogSummary = {
  area: string;
  operation: string;
  messageKind: unknown;
};

async function readDebugLogSummaries(page: Page): Promise<DebugLogSummary[]> {
  return page.evaluate(() => {
    const logs = window.__tsdfDebugLogs ?? [];

    return logs.map((entry) => ({
      area: entry.area,
      messageKind: entry.details?.messageKind,
      operation: entry.operation,
    }));
  });
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
  pages: Array<{ page: Page; prefix: 'document' | 'collection' | 'list' }>,
): Promise<void> {
  for (const { page, prefix } of pages) {
    await page.getByTestId(`${prefix}-focus-background`).click();
  }

  for (const { page, prefix } of pages) {
    await page.getByTestId(`${prefix}-focus-active`).click();
    await page.getByTestId(`${prefix}-focus-background`).click();
  }
}

test('debug logger records browser-tab sync operations', async ({
  browser,
  fixtureScopeId,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(
    context,
    'document',
    'page-a',
    fixtureScopeId,
    { storeId: 'debug-browser-tabs-document', debug: true },
  );
  const pageB = await openScenario(
    context,
    'document',
    'page-b',
    fixtureScopeId,
    { storeId: 'debug-browser-tabs-document', debug: true },
  );

  await expect(pageA.getByTestId('document-value')).toHaveText('0');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  await pageA.getByTestId('document-mutate-optimistic').click();
  await expect(pageB.getByTestId('document-value')).toHaveText('1');

  await expect
    .poll(async () => {
      const logs = await readDebugLogSummaries(pageA);
      const openedTransport = logs.some(
        (entry) =>
          entry.area === 'browser-tabs' && entry.operation === 'transport-open',
      );
      const publishedSnapshot = logs.some(
        (entry) =>
          entry.area === 'browser-tabs' &&
          entry.operation === 'publish' &&
          entry.messageKind === 'document-snapshot',
      );

      return `${openedTransport}:${publishedSnapshot}`;
    })
    .toBe('true:true');

  await expect
    .poll(async () => {
      const logs = await readDebugLogSummaries(pageB);

      return logs.some(
        (entry) =>
          entry.area === 'browser-tabs' &&
          entry.operation === 'receive' &&
          entry.messageKind === 'document-snapshot',
      );
    })
    .toBe(true);

  await context.close();
});

test('document optimistic mutation updates a sibling page without sibling network work', async ({
  browser,
  fixtureScopeId,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(
    context,
    'document',
    'page-a',
    fixtureScopeId,
  );
  const pageB = await openScenario(
    context,
    'document',
    'page-b',
    fixtureScopeId,
  );

  await expect(pageA.getByTestId('document-value')).toHaveText('0');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  await resetHistory(request, fixtureScopeId);
  await pageA.getByTestId('document-mutate-optimistic').click();

  await expect(pageA.getByTestId('document-value')).toHaveText('1');
  await expect(pageB.getByTestId('document-value')).toHaveText('1');

  const history = await getHistory(request, fixtureScopeId);
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
  fixtureScopeId,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(
    context,
    'document',
    'page-a',
    fixtureScopeId,
  );
  const pageB = await openScenario(
    context,
    'document',
    'page-b',
    fixtureScopeId,
  );

  await expect(pageA.getByTestId('document-value')).toHaveText('0');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  await pageA.getByTestId('document-focus-active').click();
  await pageB.getByTestId('document-focus-background').click();

  await resetHistory(request, fixtureScopeId);
  await pageA.getByTestId('document-trigger-rtu').click();

  await expect(pageA.getByTestId('document-value')).toHaveText('2');
  await expect(pageB.getByTestId('document-value')).toHaveText('2');

  const history = await getHistory(request, fixtureScopeId);
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
  fixtureScopeId,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(
    context,
    'document',
    'page-a',
    fixtureScopeId,
    { storeId: 'document-store-a' },
  );
  const pageB = await openScenario(
    context,
    'document',
    'page-b',
    fixtureScopeId,
    { storeId: 'document-store-b' },
  );

  await expect(pageA.getByTestId('document-value')).toHaveText('0');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  await pageA.getByTestId('document-focus-active').click();
  await pageB.getByTestId('document-focus-background').click();

  await resetHistory(request, fixtureScopeId);
  await pageA.getByTestId('document-trigger-rtu').click();

  await expect(pageA.getByTestId('document-value')).toHaveText('2');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  const history = await getHistory(request, fixtureScopeId);
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

test('document browser-tabs sync stays isolated across different session keys', async ({
  browser,
  fixtureScopeId,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(
    context,
    'document',
    'page-a',
    fixtureScopeId,
    { storeId: 'document-store-shared', sessionKey: 'account-a' },
  );
  const pageB = await openScenario(
    context,
    'document',
    'page-b',
    fixtureScopeId,
    { storeId: 'document-store-shared', sessionKey: 'account-b' },
  );

  await expect(pageA.getByTestId('document-value')).toHaveText('0');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  await resetHistory(request, fixtureScopeId);
  await pageA.getByTestId('document-mutate-optimistic').click();

  await expect(pageA.getByTestId('document-value')).toHaveText('1');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  const history = await getHistory(request, fixtureScopeId);
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

test('collection optimistic mutations propagate without sibling refetches', async ({
  browser,
  fixtureScopeId,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(
    context,
    'collection',
    'page-a',
    fixtureScopeId,
  );
  const pageB = await openScenario(
    context,
    'collection',
    'page-b',
    fixtureScopeId,
  );

  await expect(pageA.getByTestId('collection-item1-name')).toHaveText('Item 1');
  await expect(pageB.getByTestId('collection-item1-name')).toHaveText('Item 1');
  await waitForPageSettle(pageA);
  await waitForPageSettle(pageB);

  await resetHistory(request, fixtureScopeId);
  await pageA.getByTestId('collection-item1-mutate').click();

  await expect(pageA.getByTestId('collection-item1-name')).toHaveText(
    'Updated',
  );
  await expect(pageB.getByTestId('collection-item1-name')).toHaveText(
    'Updated',
  );

  const history = await getHistory(request, fixtureScopeId);
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
  fixtureScopeId,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(
    context,
    'document',
    'page-a',
    fixtureScopeId,
  );
  const pageB = await openScenario(
    context,
    'document',
    'page-b',
    fixtureScopeId,
  );

  await expect(pageA.getByTestId('document-value')).toHaveText('0');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  await setAllPagesBackgroundInOrder([
    { page: pageB, prefix: 'document' },
    { page: pageA, prefix: 'document' },
  ]);

  await resetHistory(request, fixtureScopeId);
  await pageA.getByTestId('document-trigger-rtu').click();

  await expect(pageA.getByTestId('document-value')).toHaveText('2');
  await expect(pageB.getByTestId('document-value')).toHaveText('2');

  const history = await getHistory(request, fixtureScopeId);
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
  fixtureScopeId,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(
    context,
    'document',
    'page-a',
    fixtureScopeId,
    { storeId: 'document-store-a' },
  );
  const pageB = await openScenario(
    context,
    'document',
    'page-b',
    fixtureScopeId,
    { storeId: 'document-store-b' },
  );

  await expect(pageA.getByTestId('document-value')).toHaveText('0');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  await setAllPagesBackgroundInOrder([
    { page: pageB, prefix: 'document' },
    { page: pageA, prefix: 'document' },
  ]);

  await resetHistory(request, fixtureScopeId);
  await pageA.getByTestId('document-trigger-rtu').click();

  await expect(pageA.getByTestId('document-value')).toHaveText('2');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  const history = await getHistory(request, fixtureScopeId);
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
  fixtureScopeId,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(
    context,
    'collection',
    'page-a',
    fixtureScopeId,
  );
  const pageB = await openScenario(
    context,
    'collection',
    'page-b',
    fixtureScopeId,
  );

  await expect(pageA.getByTestId('collection-item1-name')).toHaveText('Item 1');
  await expect(pageB.getByTestId('collection-item1-name')).toHaveText('Item 1');

  await setAllPagesBackgroundInOrder([
    { page: pageB, prefix: 'collection' },
    { page: pageA, prefix: 'collection' },
  ]);

  await resetHistory(request, fixtureScopeId);
  await pageA.getByTestId('collection-trigger-rtu').click();

  await expect(pageA.getByTestId('collection-item1-name')).toHaveText(
    'Updated',
  );
  await expect(pageB.getByTestId('collection-item1-name')).toHaveText(
    'Updated',
  );

  const history = await getHistory(request, fixtureScopeId);
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
  fixtureScopeId,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(context, 'list', 'page-a', fixtureScopeId);
  const pageB = await openScenario(context, 'list', 'page-b', fixtureScopeId);

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

  await resetHistory(request, fixtureScopeId);
  await pageA.getByTestId('list-trigger-rtu').click();

  await expect(pageA.getByTestId('list-item1-name')).toHaveText('Zoe');
  await expect(pageB.getByTestId('list-item1-name')).toHaveText('Zoe');

  const history = await getHistory(request, fixtureScopeId);
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
  fixtureScopeId,
  request,
}) => {
  const context = await browser.newContext();
  const pageA = await openScenario(
    context,
    'document',
    'page-a',
    fixtureScopeId,
  );
  const pageB = await openScenario(
    context,
    'document',
    'page-b',
    fixtureScopeId,
  );

  await expect(pageA.getByTestId('document-value')).toHaveText('0');
  await expect(pageB.getByTestId('document-value')).toHaveText('0');

  await resetHistory(request, fixtureScopeId);
  await pageA.getByTestId('document-fetch-high').click();
  await expect
    .poll(async () => {
      const history = await getHistory(request, fixtureScopeId);
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

  const history = await getHistory(request, fixtureScopeId);
  expect(
    countRequests(history, {
      pageId: 'page-b',
      path: '/api/document',
      method: 'GET',
    }),
  ).toBe(0);

  await context.close();
});
