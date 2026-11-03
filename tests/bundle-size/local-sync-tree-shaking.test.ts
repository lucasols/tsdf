import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build as buildPackage } from 'tsdown';
import { build as buildApp, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/**
 * These tests bundle the published `dist` output the same way a consumer app
 * does, so they catch leaks caused by how tsdown groups modules into chunks
 * (which a bundle built straight from `src/` would not show).
 */

const repoRoot = path.resolve(import.meta.dirname, '../..');

// Strings that only exist inside the code we expect to be tree-shaken away
const managedAsyncAdapterMarker = 'tsdf-async-write:';
const opfsDriverMarker = 'Failed to open OPFS store directory';

let consumerDir = '';

beforeAll(async () => {
  consumerDir = await mkdtemp(path.join(tmpdir(), 'tsdf-tree-shaking-'));
  const installedPackageDir = path.join(consumerDir, 'node_modules/tsdf');
  await mkdir(installedPackageDir, { recursive: true });

  // Build the package with the real tsdown config, as it is published
  await buildPackage({
    cwd: repoRoot,
    outDir: path.join(installedPackageDir, 'dist'),
    dts: false,
    logLevel: 'silent',
  });
  await cp(
    path.join(repoRoot, 'package.json'),
    path.join(installedPackageDir, 'package.json'),
  );
}, 60_000);

afterAll(async () => {
  if (consumerDir) await rm(consumerDir, { recursive: true, force: true });
});

async function bundleConsumerApp(entryCode: string): Promise<string> {
  const entryPath = path.join(consumerDir, 'entry.js');
  await writeFile(entryPath, entryCode);

  const result = await buildApp({
    configFile: false,
    logLevel: 'silent',
    root: consumerDir,
    resolve: { preserveSymlinks: true },
    build: {
      write: false,
      minify: true,
      rollupOptions: {
        input: entryPath,
        // Only tsdf's own code matters here, its dependencies stay external
        external: (id) =>
          !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('tsdf'),
      },
    },
  });

  const outputs: Rolldown.RolldownOutput[] = Array.isArray(result)
    ? result
    : 'output' in result
      ? [result]
      : [];

  return outputs
    .flatMap((output) => output.output)
    .map((chunk) => (chunk.type === 'chunk' ? chunk.code : ''))
    .join('\n');
}

describe('apps that only use local-sync persistence', () => {
  test('do not bundle the async storage adapter or the OPFS driver', async () => {
    // Every runtime export an app with only `local-sync` stores needs
    const bundle = await bundleConsumerApp(`
      import {
        createCollectionStore,
        createDocumentStore,
        createListQueryStore,
        createStoreManager,
        IsOffScreenContext,
        fetchTypePriority,
        mutationSkipped,
      } from 'tsdf';

      globalThis.tsdfExports = [
        createCollectionStore,
        createDocumentStore,
        createListQueryStore,
        createStoreManager,
        IsOffScreenContext,
        fetchTypePriority,
        mutationSkipped,
      ];
    `);

    // Sanity check: the store code itself is in the bundle
    expect(bundle).toContain('Duplicate store id');

    // The managed async adapter is only needed when an async adapter is created
    expect(bundle).not.toContain(managedAsyncAdapterMarker);
    // The OPFS driver is only needed when `tsdf/opfs-storage` is imported
    expect(bundle).not.toContain(opfsDriverMarker);
  }, 30_000);
});

test('apps using the OPFS adapter still bundle the async adapter and the OPFS driver', async () => {
  // Confirms the markers above really identify that code, so the negative
  // assertions cannot pass vacuously
  const bundle = await bundleConsumerApp(`
    import { opfsPersistentStorage } from 'tsdf/opfs-storage';

    globalThis.tsdfExports = [opfsPersistentStorage];
  `);

  expect(bundle).toContain(managedAsyncAdapterMarker);
  expect(bundle).toContain(opfsDriverMarker);
}, 30_000);
