import { build } from "esbuild";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const require = createRequire(import.meta.url);
try {
  await access(path.join(root, "src/terminals/index.ts"));
} catch {
  console.error("BLOCKED: TerminalService implementation is not present");
  process.exit(2);
}
const nativeRoot = path.dirname(
  require.resolve("@homebridge/node-pty-prebuilt-multiarch/package.json"),
);
const electron = require(path.join(root, "node_modules/electron"));
await mkdir(path.join(root, "artifacts/terminals"), { recursive: true });
const output = await mkdtemp(path.join(root, "artifacts/terminals/service-"));
const suite = path.join(output, "service-tests.cjs");
await build({
  entryPoints: [path.join(root, "tests/terminals/service.spec.ts")],
  outfile: suite,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  sourcemap: true,
});
const child = spawn(
  electron,
  [
    path.join(root, "tests/terminals/electron-entry.cjs"),
    `--user-data-dir=${path.join(output, "electron-profile")}`,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      COD_TEST_PTY_ROOT: nativeRoot,
      COD_TEST_TERMINAL_SUITE: suite,
    },
    stdio: "inherit",
  },
);
const timer = setTimeout(() => {
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }, 3000).unref();
}, 60000);
child.on("error", (error) => {
  clearTimeout(timer);
  console.error(error.message);
  process.exitCode = 1;
});
child.on("close", (code) => {
  clearTimeout(timer);
  process.exitCode = code ?? 1;
});
