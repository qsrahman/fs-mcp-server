import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      // A floor just under the current numbers (97% lines, 94% branches),
      // so a refactor that leaves code untested fails. index.ts main() runs in a
      // child process in cli.test.ts, which v8 coverage does not follow.
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 92 },
    },
  },
})
