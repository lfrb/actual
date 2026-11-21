import path from 'node:path';

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e/remote',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'register',
      grep: /reads existing screens/,
      use: { baseURL: 'http://127.0.0.1:21306' },
    },
    {
      name: 'revocation',
      grep: /handles revocation/,
      use: { baseURL: 'http://127.0.0.1:21307' },
    },
    {
      name: 'local-mode',
      grep: /desktop-width requirement/,
      use: { baseURL: 'http://127.0.0.1:21308' },
    },
  ],
  // Each browser starts with a fresh migration cache. Give each scenario
  // its own server so those requests don't share a rate-limit window.
  webServer: [21306, 21307, 21308].map(port => ({
    cwd: path.join(__dirname, '..', '..'),
    command: `node packages/sync-server/test-support/launch-remote-ui.mjs ${port}`,
    url: `http://127.0.0.1:${port}/info`,
    reuseExistingServer: false,
    timeout: 120_000,
  })),
});
