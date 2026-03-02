import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createStorageAdapter } from '../../src/persistentStorage/storageAdapter';
import type { StorageAdapter } from '../../src/persistentStorage/types';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
});

describe('localStorage adapter', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createStorageAdapter('localStorage');
  });

  test('read returns null for missing key', async () => {
    const result = await adapter.read('nonexistent');
    expect(result).toBeNull();
  });

  test('write and read roundtrip', async () => {
    await adapter.write('test-key', { name: 'Alice', age: 30 });
    const result = await adapter.read('test-key');

    expect(result).toMatchInlineSnapshot(`
      age: 30
      name: 'Alice'
    `);
  });

  test('remove deletes key', async () => {
    await adapter.write('to-remove', { value: 42 });
    await adapter.remove('to-remove');

    const result = await adapter.read('to-remove');
    expect(result).toBeNull();
  });

  test('removeByPrefix removes all matching keys', async () => {
    await adapter.write('tsdf.session1.store1', { a: 1 });
    await adapter.write('tsdf.session1.store2', { b: 2 });
    await adapter.write('tsdf.session2.store1', { c: 3 });

    await adapter.removeByPrefix('tsdf.session1.');

    const result1 = await adapter.read('tsdf.session1.store1');
    const result2 = await adapter.read('tsdf.session1.store2');
    const result3 = await adapter.read('tsdf.session2.store1');

    expect(result1).toBeNull();
    expect(result2).toBeNull();
    expect(result3).toMatchInlineSnapshot(`c: 3`);
  });

  test('listKeys returns matching keys', async () => {
    await adapter.write('tsdf.s1.a', 1);
    await adapter.write('tsdf.s1.b', 2);
    await adapter.write('tsdf.s2.a', 3);

    const keys = await adapter.listKeys('tsdf.s1.');

    expect(keys.sort()).toMatchInlineSnapshot(`['tsdf.s1.a', 'tsdf.s1.b']`);
  });

  test('read handles invalid JSON gracefully', async () => {
    localStorage.setItem('bad-json', '{invalid');

    const result = await adapter.read('bad-json');
    expect(result).toBeNull();
  });

  test('write handles quota exceeded gracefully', async () => {
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const setItemSpy = vi
      .spyOn(localStorage, 'setItem')
      .mockImplementation((key: string, value: string) => {
        if (key === 'quota-test') {
          throw new DOMException('QuotaExceededError');
        }
        originalSetItem(key, value);
      });

    // Should not throw
    await adapter.write('quota-test', { large: 'data' });

    const result = await adapter.read('quota-test');
    expect(result).toBeNull();

    setItemSpy.mockRestore();
  });
});
