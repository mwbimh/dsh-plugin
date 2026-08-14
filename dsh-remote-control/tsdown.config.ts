import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/invariant.ts'],
  format: ['esm'],
  fixedExtension: false,
  dts: true,
  clean: true,
  outDir: 'lib',
  sourcemap: false,
  deps: {
    neverBundle: ['@deepseek-ai/cordis'],
  },
})
