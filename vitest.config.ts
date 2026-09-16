import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const shared = {
  globals: true,
  environment: 'node' as const,
  environmentMatchGlobs: [['tests/ui/**', 'jsdom'] as [string, string]],
  setupFiles: ['tests/setup.ts'],
  testTimeout: 30000,
  hookTimeout: 30000,
};

export default defineConfig({
  test: {
    /**
     * WHY: coverage is a diagnostic, not a gate. It is off by default (`npm run test:coverage`
     * turns it on) and it runs the unit project only: V8 instrumentation inflates wall-clock
     * enough to trip the perf project's budgets, which would make a coverage run report a
     * latency regression that is not there. No thresholds: a number CI does not enforce is a number
     * nobody has to game, and the reporters are here so a contributor can see which lines a
     * change left untested rather than to produce a badge.
     */
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
      exclude: ['**/*.d.ts', 'src/**/shapes.ts'],
    },
    /**
     * WHY: the perf suite measures wall-clock latency and event-loop responsiveness, so it
     * cannot share a machine with dozens of parallel forks — under full-battery load the
     * H15 heartbeat probe failed on contention, not on a regression. Perf runs last, alone,
     * in a single worker. Loosening the budgets instead would have made the check unable
     * to say no, which is worse than not having it.
     */
    projects: [
      {
        plugins: [react()],
        resolve: { alias: { '@': path.resolve(process.cwd(), 'src') } },
        test: {
          ...shared,
          name: 'unit',
          include: ['tests/**/*.test.{ts,tsx}'],
          exclude: ['tests/perf/**'],
          pool: 'forks',
          sequence: { groupOrder: 0 },
        },
      },
      {
        plugins: [react()],
        resolve: { alias: { '@': path.resolve(process.cwd(), 'src') } },
        test: {
          ...shared,
          name: 'perf',
          include: ['tests/perf/**/*.test.{ts,tsx}'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
