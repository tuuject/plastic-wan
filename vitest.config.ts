import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'apps/admin-next/src/**/*.test.ts', 'packages/image-service/test/**/*.test.ts'],
    setupFiles: ['test/setup/pin-browser-language.ts'],
    // bun test ran files sequentially; keep the same execution semantics so
    // SQLite fixtures, temp directories and shared ports stay deterministic.
    fileParallelism: false,
  },
});
