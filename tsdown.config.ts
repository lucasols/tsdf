import { defineConfig } from 'tsdown';

export default defineConfig({
  deps: { skipNodeModulesBundle: true },
  entry: {
    main: 'src/main.ts',
    'async-storage': 'src/async-storage.ts',
    'indexed-db-storage': 'src/indexed-db-storage.ts',
    'opfs-storage': 'src/opfs-storage.ts',
  },
  clean: true,
  env: { TEST: false },
  minify: true,
  dts: true,
  fixedExtension: false,
  format: 'esm',
  target: false,
});
