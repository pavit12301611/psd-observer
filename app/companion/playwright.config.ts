import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', fullyParallel: true, workers: 2, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote'] } : {} },
  reporter: [['list'], ['html', { open: 'never' }]],
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 960 } } },
    { name: 'a53-standard', use: { viewport: { width: 393, height: 873 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.75 } },
    { name: 'a53-large', use: { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 } },
    { name: 'compact', use: { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true } },
    { name: 'landscape', use: { viewport: { width: 873, height: 393 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: 'npm run dev', port: 5173, reuseExistingServer: !process.env.CI, timeout: 30_000 },
});
