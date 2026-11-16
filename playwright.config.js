import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:3210",
    viewport: { width: 1440, height: 900 },
    headless: true,
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/start-browser-server.mjs",
    url: "http://127.0.0.1:3210/api/health",
    reuseExistingServer: false,
  },
  reporter: "list",
});
