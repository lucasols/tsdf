import { defineConfig } from 'tsdown';

export default defineConfig({
  deps: { neverBundle: ['runcheck'] },
  entry: ['src/main.ts'],
  clean: true,
  minify: true,
  dts: true,
  fixedExtension: false,
  format: 'esm',
  target: false,
});
