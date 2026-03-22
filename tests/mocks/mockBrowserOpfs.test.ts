import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { advanceTime } from '../utils/genericTestUtils';
import {
  createMockBrowserOpfs,
  resetMockBrowserOpfsForTests,
} from './mockBrowserOpfs';

describe('mockBrowserOpfs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetMockBrowserOpfsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMockBrowserOpfsForTests();
  });

  test('async handle operations do not settle immediately and advance operation time', async () => {
    const mockBrowserOpfs = createMockBrowserOpfs();

    const rootPromise = navigator.storage.getDirectory();
    let rootResolved = false;
    void rootPromise.then(() => {
      rootResolved = true;
    });
    expect(rootResolved).toBe(false);
    await advanceTime(1);

    const root = await rootPromise;

    const dirPromise = root.getDirectoryHandle('docs', { create: true });
    let dirResolved = false;
    void dirPromise.then(() => {
      dirResolved = true;
    });
    expect(dirResolved).toBe(false);
    await advanceTime(1);

    const dir = await dirPromise;
    const filePromise = dir.getFileHandle('entry.json', { create: true });
    await advanceTime(1);
    const file = await filePromise;

    const writablePromise = file.createWritable();
    await advanceTime(1);
    const writable = await writablePromise;

    const writePromise = writable.write('{"value":"test"}');
    await advanceTime(1);
    await writePromise;

    const closePromise = writable.close();
    await advanceTime(2);
    await closePromise;

    const savedFilePromise = file.getFile();
    await advanceTime(1);
    const savedFile = await savedFilePromise;

    const textPromise = savedFile.text();
    await advanceTime(2);
    await textPromise;

    expect(
      mockBrowserOpfs.operations.map((operation) => ({
        time: operation.time,
        type: operation.type,
      })),
    ).toMatchInlineSnapshot(`
      - { time: 2, type: 'ensureDir' }
      - { time: 3, type: 'ensureFile' }
      - { time: 7, type: 'writeFile' }
      - { time: 10, type: 'readFile' }
    `);
  });
});
