import {
  expect,
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';

const SAVE_DEBOUNCE_MS = 1000;

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

async function resetFixture(
  request: APIRequestContext,
  fixtureScopeId: string,
): Promise<void> {
  await request.post('/api/test/reset', {
    headers: { 'x-scope-id': fixtureScopeId },
  });
}

async function openScenario(
  context: BrowserContext,
  scenario: 'persist-document' | 'persist-collection' | 'persist-list',
  pageId: string,
  fixtureScopeId: string,
  options: {
    storeId: string;
    adapterKey: AdapterCase['adapterKey'];
    sessionKey?: string;
    debug?: boolean;
  },
) {
  const page = await context.newPage();
  const searchParams = new URLSearchParams({
    scenario,
    pageId,
    scopeId: fixtureScopeId,
    storeId: options.storeId,
    adapter: options.adapterKey,
  });

  if (options.sessionKey) {
    searchParams.set('sessionKey', options.sessionKey);
  }

  if (options.debug) {
    searchParams.set('debug', '1');
  }

  await page.goto(`/?${searchParams.toString()}`);
  return page;
}

type PersistentStorageDebugLogSummary = {
  adapter: unknown;
  area: string;
  durationType: string;
  operation: string;
  status: unknown;
  storeName: unknown;
};

async function readPersistentStorageDebugLogSummaries(
  page: Page,
): Promise<PersistentStorageDebugLogSummary[]> {
  return page.evaluate(() => {
    const logs = window.__tsdfDebugLogs ?? [];

    return logs.map((entry) => ({
      adapter: entry.details?.adapter,
      area: entry.area,
      durationType: typeof entry.details?.durationMs,
      operation: entry.operation,
      status: entry.details?.status,
      storeName: entry.details?.storeName,
    }));
  });
}

async function waitForDebounce(page: Page): Promise<void> {
  await page.waitForTimeout(SAVE_DEBOUNCE_MS + 200);
}

test.describe('persistent storage debug logging', () => {
  test('debug logger records sync persistent storage operations', async ({
    browser,
    fixtureScopeId,
  }) => {
    const context = await browser.newContext();
    const storeId = 'debug-local-persistence-document';
    const page = await openScenario(
      context,
      'persist-document',
      'page-a',
      fixtureScopeId,
      { adapterKey: 'localStorage', debug: true, storeId },
    );

    await expect(page.getByTestId('persist-doc-status')).toHaveText('success');
    await waitForDebounce(page);

    await expect
      .poll(async () => {
        const logs = await readPersistentStorageDebugLogSummaries(page);
        const scheduledSave = logs.some(
          (entry) =>
            entry.adapter === 'local-sync' &&
            entry.area === 'persistent-storage' &&
            entry.operation === 'schedule-save' &&
            entry.status === 'success' &&
            entry.storeName === storeId,
        );
        const syncLoad = logs.some(
          (entry) =>
            entry.adapter === 'local-sync' &&
            entry.area === 'persistent-storage' &&
            entry.operation === 'sync-load' &&
            entry.storeName === storeId,
        );
        const write = logs.some(
          (entry) =>
            entry.adapter === 'local-sync' &&
            entry.area === 'persistent-storage' &&
            entry.operation === 'write' &&
            entry.status === 'success' &&
            entry.storeName === storeId,
        );

        return `${syncLoad}:${scheduledSave}:${write}`;
      })
      .toBe('true:true:true');

    await context.close();
  });

  test('debug logger records async persistent storage timings', async ({
    browser,
    fixtureScopeId,
  }) => {
    const context = await browser.newContext();
    const storeId = 'debug-async-persistence-document';
    const page = await openScenario(
      context,
      'persist-document',
      'page-a',
      fixtureScopeId,
      { adapterKey: 'opfs', debug: true, storeId },
    );

    await expect(page.getByTestId('persist-doc-status')).toHaveText('success');
    await waitForDebounce(page);

    await expect
      .poll(async () => {
        const logs = await readPersistentStorageDebugLogSummaries(page);
        const loadWithTiming = logs.some(
          (entry) =>
            entry.adapter === 'async' &&
            entry.area === 'persistent-storage' &&
            entry.durationType === 'number' &&
            entry.operation === 'load' &&
            entry.storeName === storeId,
        );
        const writeWithTiming = logs.some(
          (entry) =>
            entry.adapter === 'async' &&
            entry.area === 'persistent-storage' &&
            entry.durationType === 'number' &&
            entry.operation === 'write' &&
            entry.status === 'success' &&
            entry.storeName === storeId,
        );

        return `${loadWithTiming}:${writeWithTiming}`;
      })
      .toBe('true:true');

    await context.close();
  });
});

type AdapterCase = {
  adapterKey: 'indexedDb' | 'localStorage' | 'opfs';
  label: 'indexedDb' | 'localStorage' | 'opfs';
};

for (const adapterCase of [
  { adapterKey: 'indexedDb', label: 'indexedDb' },
  { adapterKey: 'localStorage', label: 'localStorage' },
  { adapterKey: 'opfs', label: 'opfs' },
] as const satisfies readonly AdapterCase[]) {
  test.describe(`persistent storage — ${adapterCase.label}`, () => {
    test('document store persists data and restores on reload', async ({
      browser,
      fixtureScopeId,
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(
        context,
        'persist-document',
        'page-a',
        fixtureScopeId,
        {
          storeId: `doc-${adapterCase.label}-basic`,
          adapterKey: adapterCase.adapterKey,
        },
      );

      await expect(page.getByTestId('persist-doc-status')).toHaveText(
        'success',
      );
      await expect(page.getByTestId('persist-doc-value')).toHaveText('0');

      // Wait for debounced save
      await waitForDebounce(page);

      // Reload — store should hydrate from storage
      await page.reload();

      await expect(page.getByTestId('persist-doc-value')).toHaveText('0');
      await expect(page.getByTestId('persist-doc-status')).toHaveText(
        'success',
      );

      await context.close();
    });

    test('document store restores mutated data after reload', async ({
      browser,
      fixtureScopeId,
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(
        context,
        'persist-document',
        'page-a',
        fixtureScopeId,
        {
          storeId: `doc-${adapterCase.label}-mutate`,
          adapterKey: adapterCase.adapterKey,
        },
      );

      await expect(page.getByTestId('persist-doc-status')).toHaveText(
        'success',
      );

      // Mutate
      await page.getByTestId('persist-doc-mutate').click();
      await expect(page.getByTestId('persist-doc-value')).toHaveText('1');

      // Wait for debounced save
      await waitForDebounce(page);

      // Reload
      await page.reload();

      await expect(page.getByTestId('persist-doc-value')).toHaveText('1');
      await expect(page.getByTestId('persist-doc-status')).toHaveText(
        'success',
      );

      await context.close();
    });

    test('document store does not restore data after clearing storage', async ({
      browser,
      fixtureScopeId,
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(
        context,
        'persist-document',
        'page-a',
        fixtureScopeId,
        {
          storeId: `doc-${adapterCase.label}-clear`,
          adapterKey: adapterCase.adapterKey,
        },
      );

      await expect(page.getByTestId('persist-doc-status')).toHaveText(
        'success',
      );
      await waitForDebounce(page);

      // Clear storage then reload
      await page.getByTestId('persist-doc-clear-storage').click();
      // Give clear time to complete (especially for opfs async)
      await page.waitForTimeout(200);

      await page.reload();

      // Should start from idle with no cached data
      await expect(page.getByTestId('persist-doc-value')).toHaveText('null');

      await context.close();
    });

    test('collection store persists item data and restores on reload', async ({
      browser,
      fixtureScopeId,
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(
        context,
        'persist-collection',
        'page-a',
        fixtureScopeId,
        {
          storeId: `col-${adapterCase.label}-basic`,
          adapterKey: adapterCase.adapterKey,
        },
      );

      await expect(page.getByTestId('persist-col-item1-status')).toHaveText(
        'success',
      );
      await expect(page.getByTestId('persist-col-item1-name')).toHaveText(
        'Item 1',
      );

      await waitForDebounce(page);

      await page.reload();

      await expect(page.getByTestId('persist-col-item1-name')).toHaveText(
        'Item 1',
      );
      await expect(page.getByTestId('persist-col-item1-status')).toHaveText(
        'success',
      );

      await context.close();
    });

    test('collection store restores mutated item data after reload', async ({
      browser,
      fixtureScopeId,
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(
        context,
        'persist-collection',
        'page-a',
        fixtureScopeId,
        {
          storeId: `col-${adapterCase.label}-mutate`,
          adapterKey: adapterCase.adapterKey,
        },
      );

      await expect(page.getByTestId('persist-col-item1-status')).toHaveText(
        'success',
      );

      await page.getByTestId('persist-col-item1-mutate').click();
      await expect(page.getByTestId('persist-col-item1-name')).toHaveText(
        'Persisted',
      );

      await waitForDebounce(page);

      await page.reload();

      await expect(page.getByTestId('persist-col-item1-name')).toHaveText(
        'Persisted',
      );
      await expect(page.getByTestId('persist-col-item1-status')).toHaveText(
        'success',
      );

      await context.close();
    });

    test('collection store does not restore data after clearing storage', async ({
      browser,
      fixtureScopeId,
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(
        context,
        'persist-collection',
        'page-a',
        fixtureScopeId,
        {
          storeId: `col-${adapterCase.label}-clear`,
          adapterKey: adapterCase.adapterKey,
        },
      );

      await expect(page.getByTestId('persist-col-item1-status')).toHaveText(
        'success',
      );
      await waitForDebounce(page);

      await page.getByTestId('persist-col-clear-storage').click();
      await page.waitForTimeout(200);

      await page.reload();

      await expect(page.getByTestId('persist-col-item1-name')).toHaveText(
        'null',
      );

      await context.close();
    });

    test('list query store persists list data and restores on reload', async ({
      browser,
      fixtureScopeId,
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(
        context,
        'persist-list',
        'page-a',
        fixtureScopeId,
        {
          storeId: `list-${adapterCase.label}-basic`,
          adapterKey: adapterCase.adapterKey,
        },
      );

      await expect(page.getByTestId('persist-list-status')).toHaveText(
        'success',
      );
      await expect(page.getByTestId('persist-list-names')).toHaveText(
        'Alice,Bob',
      );

      await waitForDebounce(page);
      await page.reload();

      await expect(page.getByTestId('persist-list-status')).toHaveText(
        'success',
      );
      await expect(page.getByTestId('persist-list-names')).toHaveText(
        'Alice,Bob',
      );

      await context.close();
    });

    test('list query store restores mutated data after reload', async ({
      browser,
      fixtureScopeId,
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(
        context,
        'persist-list',
        'page-a',
        fixtureScopeId,
        {
          storeId: `list-${adapterCase.label}-mutate`,
          adapterKey: adapterCase.adapterKey,
        },
      );

      await expect(page.getByTestId('persist-list-status')).toHaveText(
        'success',
      );

      await page.getByTestId('persist-list-mutate-user1').click();
      await expect(page.getByTestId('persist-list-names')).toHaveText(
        'Persisted,Bob',
      );

      await waitForDebounce(page);
      await page.reload();

      await expect(page.getByTestId('persist-list-status')).toHaveText(
        'success',
      );
      await expect(page.getByTestId('persist-list-names')).toHaveText(
        'Persisted,Bob',
      );

      await context.close();
    });

    test('list query store does not restore data after clearing storage', async ({
      browser,
      fixtureScopeId,
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(
        context,
        'persist-list',
        'page-a',
        fixtureScopeId,
        {
          storeId: `list-${adapterCase.label}-clear`,
          adapterKey: adapterCase.adapterKey,
        },
      );

      await expect(page.getByTestId('persist-list-status')).toHaveText(
        'success',
      );
      await waitForDebounce(page);

      await page.getByTestId('persist-list-clear-storage').click();
      await page.waitForTimeout(200);
      await page.reload();

      await expect(page.getByTestId('persist-list-names')).toHaveText('null');

      await context.close();
    });
  });
}
