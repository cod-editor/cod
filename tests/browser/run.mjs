import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, access } from "node:fs/promises";
import path from "node:path";
await access("src/browser/index.ts").catch(() => {
  console.error("BLOCKED: BrowserService implementation not present");
  process.exit(2);
});
await mkdir("artifacts/services/browser", { recursive: true });
const output = await mkdtemp(path.resolve("artifacts/services/browser/run-"));
const entry = path.join(output, "entry.cjs");
await build({
  entryPoints: ["tests/browser/entry.ts"],
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
const child = spawn(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config=tests/browser/playwright.config.ts",
    `--output=${path.join(output, "results")}`,
  ],
  { env: { ...process.env, COD_BROWSER_TEST_ENTRY: entry }, stdio: "inherit" },
);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
