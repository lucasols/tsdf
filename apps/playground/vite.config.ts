import { fileURLToPath, URL } from 'node:url';
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const sourceFile = (path: string) =>
  fileURLToPath(new URL(`../../src/${path}`, import.meta.url));

const compilerPreset = reactCompilerPreset();

compilerPreset.rolldown.filter = {
  ...compilerPreset.rolldown.filter,
  id: /\/apps\/playground\/src\/.*\.[jt]sx?$/,
};

export default defineConfig({
  plugins: [react(), babel({ presets: [compilerPreset] })],
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
