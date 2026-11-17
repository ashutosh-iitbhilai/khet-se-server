import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // One in-memory MongoDB replica set for the whole run (real transactions);
    // each test file gets its own database.
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setupEnv.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
