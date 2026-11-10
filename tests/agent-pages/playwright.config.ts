import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "service.spec.ts",
  testIgnore: "**/artifacts/**",
  workers: 1,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: "list",
});
