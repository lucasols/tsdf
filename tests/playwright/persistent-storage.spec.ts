import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const SAVE_DEBOUNCE_MS = 1000;



async function openScenario(
  context: BrowserContext,
  scenario: 'persist-document' | 'persist-collection' | 'persist-list',
  pageId: string,
  options: {
    storeId: string;
    adapterKey: AdapterCase['adapterKey'];
    sessionKey?: string;
  },
) {
  const page = await context.newPage();
  const searchParams = new URLSearchParams({
    scenario,
    pageId,
    storeId: options.storeId,
    adapter: options.adapterKey,
  });

  if (options.sessionKey) {
    searchParams.set('sessionKey', options.sessionKey);
  }

  await page.goto(`/?${searchParams.toString()}`);
  return page;
}

async function waitForDebounce(page: Page): Promise<void> {
  await page.waitForTimeout(SAVE_DEBOUNCE_MS + 200);
}

type AdapterCase = {
  adapterKey: 'localStorage' | 'opfs';
  label: 'localStorage' | 'opfs';
};

for (const adapterCase of [
  { adapterKey: 'localStorage', label: 'localStorage' },
  { adapterKey: 'opfs', label: 'opfs' },
] as const satisfies readonly AdapterCase[]) {
  test.describe(`persistent storage — ${adapterCase.label}`, () => {
    test.beforeEach(async ({ request }) => {
      await request.post('/api/test/reset');
    });

    test('document store persists data and restores on reload', async ({
      browser,
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(context, 'persist-document', 'page-a', {
        storeId: `doc-${adapterCase.label}-basic`,
        adapterKey: adapterCase.adapterKey,
      });

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
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(context, 'persist-document', 'page-a', {
        storeId: `doc-${adapterCase.label}-mutate`,
        adapterKey: adapterCase.adapterKey,
      });

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
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(context, 'persist-document', 'page-a', {
        storeId: `doc-${adapterCase.label}-clear`,
        adapterKey: adapterCase.adapterKey,
      });

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
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(context, 'persist-collection', 'page-a', {
        storeId: `col-${adapterCase.label}-basic`,
        adapterKey: adapterCase.adapterKey,
      });

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
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(context, 'persist-collection', 'page-a', {
        storeId: `col-${adapterCase.label}-mutate`,
        adapterKey: adapterCase.adapterKey,
      });

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
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(context, 'persist-collection', 'page-a', {
        storeId: `col-${adapterCase.label}-clear`,
        adapterKey: adapterCase.adapterKey,
      });

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
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(context, 'persist-list', 'page-a', {
        storeId: `list-${adapterCase.label}-basic`,
        adapterKey: adapterCase.adapterKey,
      });

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
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(context, 'persist-list', 'page-a', {
        storeId: `list-${adapterCase.label}-mutate`,
        adapterKey: adapterCase.adapterKey,
      });

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
    }) => {
      const context = await browser.newContext();
      const page = await openScenario(context, 'persist-list', 'page-a', {
        storeId: `list-${adapterCase.label}-clear`,
        adapterKey: adapterCase.adapterKey,
      });

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
