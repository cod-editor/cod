import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "service.spec.ts",
  testIgnore: "**/artifacts/**",
  workers: 1,
  timeout: 45000,
  expect: { timeout: 7000 },
  reporter: "list",
  outputDir: "../../artifacts/services/browser/results",
});
