import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['dsh-*/tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['dsh-*/src/**/*.ts'],
      exclude: ['dsh-*/src/types.ts'],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      reporter: process.env.CI ? ['text'] : ['text', 'html'],
    },
  },
})
