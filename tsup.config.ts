import { defineConfig } from 'tsup';
import glob from 'tiny-glob'


export default defineConfig({
  entry: ['src/main.ts'],
  clean: true,
  format: ['cjs', 'esm'],
  esbuildOptions(options) {
    options.mangleProps = /[^_]_$/;
  },
});
