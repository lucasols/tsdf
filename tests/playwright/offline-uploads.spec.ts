import { expect, test, type BrowserContext, type Page } from '@playwright/test';

type UploadAdapterKey = 'indexedDb' | 'opfs';

async function openUploadsPage(
  context: BrowserContext,
  uploadAdapter: UploadAdapterKey,
  sessionKey: string,
): Promise<Page> {
  const page = await context.newPage();
  const searchParams = new URLSearchParams({
    scenario: 'offline-uploads',
    uploadAdapter,
    sessionKey,
  });

  await page.goto(`/?${searchParams.toString()}`);
  // The list renders `empty` or the hydrated uploads once the page is ready
  await expect(page.getByTestId('upload-list')).not.toHaveText('');

  return page;
}

// Bytes that are not valid UTF-8, so a text-based round trip would corrupt them
const BINARY_BYTES = [0x00, 0xff, 0x10, 0x80, 0xfe, 0x7f, 0x0a, 0x00];

const photoFile = {
  name: 'photo.bin',
  mimeType: 'application/octet-stream',
  buffer: Buffer.from(BINARY_BYTES),
};

const notesFile = {
  name: 'notes.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('hello'),
};

// Files are described as `name | type | lastModified | size | bytes in hex`
const PHOTO_FILE_DESCRIPTION =
  /^photo\.bin \| application\/octet-stream \| \d+ \| 8 \| 00 ff 10 80 fe 7f 0a 00$/;
const NOTES_FILE_DESCRIPTION =
  /^notes\.txt \| text\/plain \| \d+ \| 5 \| 68 65 6c 6c 6f$/;

/**
 * Picks a file in the given input and returns the description of the `File`
 * the page received, including the last-modified date the browser gave it.
 */
async function pickFile(
  page: Page,
  input: 'save' | 'replace',
  file: typeof photoFile,
  expectedDescription: RegExp,
): Promise<string> {
  await page.getByTestId(`upload-${input}-input`).setInputFiles(file);
  await expect(page.getByTestId('upload-last-result')).toHaveText(
    `${input}: ok`,
  );
  await expect(page.getByTestId('upload-picked-file')).toHaveText(
    expectedDescription,
  );

  return page.getByTestId('upload-picked-file').innerText();
}

/** Loads the staged upload through `loadOfflineUpload` and waits for the result. */
async function loadStagedFile(page: Page): Promise<void> {
  await page.getByTestId('upload-load').click();
  await expect(page.getByTestId('upload-loaded-file')).not.toHaveText(
    'not-loaded',
  );
}

for (const uploadAdapter of ['indexedDb', 'opfs'] as const) {
  test.describe(`offline uploads — ${uploadAdapter} adapter`, () => {
    test('a staged file is restored byte for byte after a page reload', async ({
      browser,
    }) => {
      const context = await browser.newContext();
      const page = await openUploadsPage(context, uploadAdapter, 'user-a');
      await expect(page.getByTestId('upload-list')).toHaveText('empty');

      const pickedFileDescription = await pickFile(
        page,
        'save',
        photoFile,
        PHOTO_FILE_DESCRIPTION,
      );

      // Reload: only what the adapter persisted survives. The upload list is
      // asserted after the reload only, because a file staged while the
      // session is still hydrating is saved but can be missing from the
      // in-memory list until the next page load.
      await page.reload();

      // The session hydrates the pending upload on startup
      await expect(page.getByTestId('upload-list')).toHaveText(
        'attachment | pending | photo.bin | no-ref',
      );

      // The restored file has the same name, type, last-modified date and
      // bytes as the file that was picked
      await loadStagedFile(page);
      await expect(page.getByTestId('upload-loaded-file')).toHaveText(
        pickedFileDescription,
      );

      await context.close();
    });

    test('replacing and deleting a staged file persist across reloads', async ({
      browser,
    }) => {
      const context = await browser.newContext();
      const page = await openUploadsPage(context, uploadAdapter, 'user-a');

      await pickFile(page, 'save', photoFile, PHOTO_FILE_DESCRIPTION);

      // Replace the staged file with another one
      const replacementDescription = await pickFile(
        page,
        'replace',
        notesFile,
        NOTES_FILE_DESCRIPTION,
      );

      await page.reload();

      // Only the replacement is restored
      await expect(page.getByTestId('upload-list')).toHaveText(
        'attachment | pending | notes.txt | no-ref',
      );
      await loadStagedFile(page);
      await expect(page.getByTestId('upload-loaded-file')).toHaveText(
        replacementDescription,
      );

      // Delete it and reload again
      await page.getByTestId('upload-delete').click();
      await expect(page.getByTestId('upload-last-result')).toHaveText(
        'delete: ok',
      );
      await expect(page.getByTestId('upload-list')).toHaveText('empty');

      await page.reload();

      // Nothing comes back, and loading the missing id gives `null`
      await expect(page.getByTestId('upload-list')).toHaveText('empty');
      await loadStagedFile(page);
      await expect(page.getByTestId('upload-loaded-file')).toHaveText('null');

      await context.close();
    });

    test('a file restored after a reload is sent intact through the upload transport', async ({
      browser,
    }) => {
      const context = await browser.newContext();
      const page = await openUploadsPage(context, uploadAdapter, 'user-a');

      await pickFile(page, 'save', photoFile, PHOTO_FILE_DESCRIPTION);
      await page.reload();
      await expect(page.getByTestId('upload-list')).toHaveText(
        'attachment | pending | photo.bin | no-ref',
      );

      // Upload the restored file: the transport sends it as a request body
      await page.getByTestId('upload-resolve').click();
      await expect(page.getByTestId('upload-last-result')).toHaveText(
        'resolve: ok',
      );

      // The server ref echoes the name, type and bytes it received
      await expect(page.getByTestId('upload-list')).toHaveText(
        'attachment | uploaded | photo.bin | server:photo.bin:application/octet-stream:00ff1080fe7f0a00',
      );

      // The uploaded state and its server ref are persisted too
      await page.reload();
      await expect(page.getByTestId('upload-list')).toHaveText(
        'attachment | uploaded | photo.bin | server:photo.bin:application/octet-stream:00ff1080fe7f0a00',
      );

      await context.close();
    });

    test('uploads with the same id are isolated between session keys', async ({
      browser,
    }) => {
      const context = await browser.newContext();

      // Two users of the same browser profile stage a file under the same id
      const userAPage = await openUploadsPage(context, uploadAdapter, 'user-a');
      const userAFileDescription = await pickFile(
        userAPage,
        'save',
        photoFile,
        PHOTO_FILE_DESCRIPTION,
      );
      await userAPage.close();

      const userBPage = await openUploadsPage(context, uploadAdapter, 'user-b');
      // User B does not see user A's upload
      await expect(userBPage.getByTestId('upload-list')).toHaveText('empty');
      await loadStagedFile(userBPage);
      await expect(userBPage.getByTestId('upload-loaded-file')).toHaveText(
        'null',
      );
      await pickFile(userBPage, 'save', notesFile, NOTES_FILE_DESCRIPTION);

      // Deleting user B's upload must not touch user A's file
      await userBPage.getByTestId('upload-delete').click();
      await expect(userBPage.getByTestId('upload-last-result')).toHaveText(
        'delete: ok',
      );
      await userBPage.close();

      const userAPageAfter = await openUploadsPage(
        context,
        uploadAdapter,
        'user-a',
      );
      await expect(userAPageAfter.getByTestId('upload-list')).toHaveText(
        'attachment | pending | photo.bin | no-ref',
      );
      await loadStagedFile(userAPageAfter);
      await expect(userAPageAfter.getByTestId('upload-loaded-file')).toHaveText(
        userAFileDescription,
      );

      await context.close();
    });
  });
}
