import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // some integration tests hit real APIs
    hookTimeout: 15000,
    env: {
      NODE_ENV: 'test',
      PAYMENT_MODE: 'mock',
    },
  },
});
