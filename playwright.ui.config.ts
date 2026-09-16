// FRACTAL: covers project | type e2e | scope harness
// Phase-9 UI capture config. Reuses the shipped webServer contract from playwright.config.ts.
import base from './playwright.config';
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  ...base,
  testDir: 'e2e/uipass',
  projects: [{ name: 'uipass', use: { ...devices['Desktop Chrome'] } }],
  reporter: [['list']],
});
