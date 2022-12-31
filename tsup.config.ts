import { defineConfig } from 'tsup';
import glob from 'tiny-glob'


export default defineConfig({
  entry: await glob('./src/**/!(*.d|*.spec).ts'),
  clean: true,
  format: ['cjs', 'esm'],
  esbuildOptions(options) {
    options.mangleProps = /[^_]_$/;
  },
});
