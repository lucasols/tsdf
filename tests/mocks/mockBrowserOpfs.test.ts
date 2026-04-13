import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { advanceTime, resolveAfterAllTimers } from '../utils/genericTestUtils';
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

  test('file handles stop reading once the file is deleted', async () => {
    const mockBrowserOpfs = createMockBrowserOpfs();
    const root = await resolveAfterAllTimers(navigator.storage.getDirectory());
    const docsDir = await resolveAfterAllTimers(
      root.getDirectoryHandle('docs', { create: true }),
    );
    const file = await resolveAfterAllTimers(
      docsDir.getFileHandle('entry.json', { create: true }),
    );
    const writable = await resolveAfterAllTimers(file.createWritable());
    await resolveAfterAllTimers(writable.write('{"value":"test"}'));
    await resolveAfterAllTimers(writable.close());

    const savedFile = await resolveAfterAllTimers(file.getFile());
    await resolveAfterAllTimers(docsDir.removeEntry('entry.json'));

    const textPromise = savedFile.text();
    const rejectedRead = expect(textPromise).rejects.toMatchInlineSnapshot(`
      Error#:
        message: 'A requested file or directory could not be found at the time an operation was processed.'
        name: 'NotFoundError'
    `);
    await advanceTime(2);
    await rejectedRead;

    expect(
      mockBrowserOpfs.operations.map((operation) => ({
        time: operation.time,
        type: operation.type,
      })),
    ).toMatchInlineSnapshot(`
      - { time: 2, type: 'ensureDir' }
      - { time: 3, type: 'ensureFile' }
      - { time: 7, type: 'writeFile' }
      - { time: 9, type: 'deleteFile' }
    `);
  });

  test('files returned by getFile stop reading after the file is overwritten', async () => {
    const mockBrowserOpfs = createMockBrowserOpfs();
    const root = await resolveAfterAllTimers(navigator.storage.getDirectory());
    const docsDir = await resolveAfterAllTimers(
      root.getDirectoryHandle('docs', { create: true }),
    );
    const file = await resolveAfterAllTimers(
      docsDir.getFileHandle('entry.json', { create: true }),
    );

    const firstWritable = await resolveAfterAllTimers(file.createWritable());
    await resolveAfterAllTimers(firstWritable.write('{"value":"first"}'));
    await resolveAfterAllTimers(firstWritable.close());

    const savedFile = await resolveAfterAllTimers(file.getFile());

    const secondWritable = await resolveAfterAllTimers(file.createWritable());
    await resolveAfterAllTimers(secondWritable.write('{"value":"second"}'));
    await resolveAfterAllTimers(secondWritable.close());

    const textPromise = savedFile.text();
    const rejectedRead = expect(textPromise).rejects.toMatchInlineSnapshot(`
      Error#:
        message: 'The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.'
        name: 'NotReadableError'
    `);
    await advanceTime(2);
    await rejectedRead;

    expect(
      mockBrowserOpfs.operations.map((operation) => ({
        time: operation.time,
        type: operation.type,
      })),
    ).toMatchInlineSnapshot(`
      - { time: 2, type: 'ensureDir' }
      - { time: 3, type: 'ensureFile' }
      - { time: 7, type: 'writeFile' }
      - { time: 12, type: 'writeFile' }
    `);
  });

  test('independent directory handle calls can start in parallel', async () => {
    const mockBrowserOpfs = createMockBrowserOpfs();
    const root = await resolveAfterAllTimers(navigator.storage.getDirectory());
    const docsDir = await resolveAfterAllTimers(
      root.getDirectoryHandle('docs', { create: true }),
    );
    await resolveAfterAllTimers(
      docsDir.getFileHandle('a.json', { create: true }),
    );
    await resolveAfterAllTimers(
      docsDir.getFileHandle('b.json', { create: true }),
    );

    mockBrowserOpfs.clearInstrumentation();

    await resolveAfterAllTimers(
      Promise.all([
        docsDir.getFileHandle('a.json'),
        docsDir.getFileHandle('b.json'),
        docsDir.removeEntry('a.json'),
        docsDir.removeEntry('b.json'),
      ]),
    );

    expect(
      mockBrowserOpfs.operations.map((operation) => ({
        path: operation.path,
        startedTime: operation.startedTime,
        time: operation.time,
        type: operation.type,
      })),
    ).toMatchInlineSnapshot(`
      - { path: 'docs/a.json', startedTime: 4, time: 5, type: 'openFile' }
      - { path: 'docs/b.json', startedTime: 4, time: 5, type: 'openFile' }
      - { path: 'docs/a.json', startedTime: 4, time: 5, type: 'deleteFile' }
      - { path: 'docs/b.json', startedTime: 4, time: 5, type: 'deleteFile' }
    `);
  });

  test('independent file handle snapshots can start in parallel', async () => {
    const mockBrowserOpfs = createMockBrowserOpfs();
    const root = await resolveAfterAllTimers(navigator.storage.getDirectory());
    const docsDir = await resolveAfterAllTimers(
      root.getDirectoryHandle('docs', { create: true }),
    );
    const file = await resolveAfterAllTimers(
      docsDir.getFileHandle('entry.json', { create: true }),
    );
    const writable = await resolveAfterAllTimers(file.createWritable());
    await resolveAfterAllTimers(writable.write('{"value":"test"}'));
    await resolveAfterAllTimers(writable.close());

    mockBrowserOpfs.clearInstrumentation();

    const [firstSnapshot, secondSnapshot] = await resolveAfterAllTimers(
      Promise.all([file.getFile(), file.getFile()]),
    );
    await resolveAfterAllTimers(
      Promise.all([firstSnapshot.text(), secondSnapshot.text()]),
    );

    expect(
      mockBrowserOpfs.operations.map((operation) => ({
        path: operation.path,
        startedTime: operation.startedTime,
        time: operation.time,
        type: operation.type,
      })),
    ).toMatchInlineSnapshot(`
      - { path: 'docs/entry.json', startedTime: 7, time: 10, type: 'readFile' }
      - { path: 'docs/entry.json', startedTime: 7, time: 10, type: 'readFile' }
    `);
  });
});
