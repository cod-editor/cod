import { build } from "esbuild";
import { mkdir, mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
await mkdir("artifacts/services/agent-pages", { recursive: true });
const output = await mkdtemp(
  path.resolve("artifacts/services/agent-pages/run-"),
);
const entry = path.join(output, "entry.cjs"),
  preload = path.join(output, "preload.cjs");
await Promise.all([
  build({
    entryPoints: ["tests/agent-pages/entry.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    entryPoints: ["src/agent-pages/preload.ts"],
    outfile: preload,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  }),
]);
const child = spawn(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config=tests/agent-pages/playwright.config.ts",
    `--output=${path.join(output, "results")}`,
  ],
  {
    env: { ...process.env, COD_AGENT_ENTRY: entry, COD_AGENT_PRELOAD: preload },
    stdio: "inherit",
  },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => (process.exitCode = code ?? 1));
