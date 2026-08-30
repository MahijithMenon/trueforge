import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    // Integration tests share one Postgres instance and reset schemas between
    // files, so files must not run concurrently against each other.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
