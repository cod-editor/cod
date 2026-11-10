import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  // Whole journeys may start/restart sandboxed Electron several times on a limited VM.
  // Individual assertions and CLI requests retain their independent 10-second bounds.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    trace: "retain-on-failure",
  },
});
