import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    // Node by default; the console's component tests opt into jsdom with a
    // per-file `@vitest-environment` comment.
    environment: 'node',
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    // Integration tests share one Postgres instance and reset schemas between
    // files, so files must not run concurrently against each other.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
