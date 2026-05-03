import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const sourceFile = (path: string) =>
  fileURLToPath(new URL(`../../src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^tsdf$/, replacement: sourceFile('main.ts') },
      {
        find: /^tsdf\/async-storage$/,
        replacement: sourceFile('async-storage.ts'),
      },
      {
        find: /^tsdf\/indexed-db-storage$/,
        replacement: sourceFile('indexed-db-storage.ts'),
      },
      {
        find: /^tsdf\/opfs-storage$/,
        replacement: sourceFile('opfs-storage.ts'),
      },
    ],
  },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:5174' } },
});
