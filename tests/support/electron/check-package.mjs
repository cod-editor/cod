import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

const execute = promisify(execFile);
const artifact = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || process.platform !== "darwin")
  throw new Error("Usage on macOS: node check-package.mjs PACKAGE_DIRECTORY");
const bundle = path.join(artifact, "Cod.app");
const app = path.join(bundle, "Contents/Resources/app");
const executable = path.join(bundle, "Contents/MacOS/Electron");
await execute("codesign", ["--verify", "--deep", "--strict", bundle]);
const { stdout: plistJson } = await execute("plutil", [
  "-convert",
  "json",
  "-o",
  "-",
  path.join(bundle, "Contents/Info.plist"),
]);
const plist = JSON.parse(plistJson);
const expectedVersion = process.argv[3];
const manifest = JSON.parse(
  await readFile(path.join(app, "package.json"), "utf8"),
);
if (
  expectedVersion &&
  (manifest.version !== expectedVersion ||
    plist.CFBundleShortVersionString !== expectedVersion.split("-")[0] ||
    plist.CFBundleVersion !== expectedVersion.split("-")[0])
)
  throw new Error(
    "Packaged application version does not match the release tag",
  );
const schemes = (plist.CFBundleURLTypes ?? []).flatMap(
  (entry) => entry.CFBundleURLSchemes ?? [],
);
if (!schemes.includes("http") || !schemes.includes("https"))
  throw new Error("Packaged browser does not declare both web URL schemes");
for (const key of [
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
  "NSLocationUsageDescription",
])
  if (typeof plist[key] !== "string" || !plist[key].trim())
    throw new Error(`Missing permission description: ${key}`);

const { stdout: help } = await execute(
  path.join(artifact, "codctl"),
  ["--help"],
  {
    timeout: 10000,
  },
);
if (!help.includes("conversation handoff") || !help.includes("page open"))
  throw new Error("Packaged CLI misses implemented commands");
const png = await readFile(path.join(app, "dist/cod-icon.png"));
const logoHash = createHash("sha256").update(png).digest("hex");
if (
  logoHash !==
  "bb82c4ce6cc59e896861a6813d114b26c2b1eb9d7735169420017e45997a65f3"
)
  throw new Error(
    "Packaged logo differs from the original Zed-based Cod asset",
  );
await access(path.join(bundle, "Contents/Resources/cod.icns"));
const skill = await readFile(
  path.join(app, "plugins/cod/skills/cod/SKILL.md"),
  "utf8",
);
if (!skill.includes("COD_NODE_PATH"))
  throw new Error("Packaged skill is stale");
await access(path.join(app, "plugins/cod/hooks/status-hook.mjs"));
const ptyScript = `
const pty = require(${JSON.stringify(path.join(app, "node_modules/@homebridge/node-pty-prebuilt-multiarch"))});
const terminal = pty.spawn('/bin/sh', ['-c', 'test -t 0 && test -t 1 && test -t 2 && printf COD_PACKAGE_PTY_OK'], { cols: 80, rows: 24, env: process.env });
let text = '';
const timer = setTimeout(() => { terminal.kill(); process.exit(2); }, 5000);
terminal.onData(chunk => { text += chunk; });
terminal.onExit(() => { clearTimeout(timer); if (!text.includes('COD_PACKAGE_PTY_OK')) process.exit(3); console.log('PASS native PTY'); });
`;
await execute(executable, ["-e", ptyScript], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  timeout: 10000,
});
const profile = await mkdtemp(path.join(tmpdir(), "cod-package-state-"));
try {
  const file = path.join(profile, "workspace.sqlite");
  const worker = path.join(app, "dist/sqlite-state-worker.cjs");
  const sqliteScript = `
const { Worker } = require('node:worker_threads');
const db = new Worker(${JSON.stringify(worker)}, { workerData: ${JSON.stringify(file)} });
db.postMessage({ id: 1, request: { operation: 'load' } });
db.on('message', ({ value, error }) => {
  if (error || !Array.isArray(value) || value.length) throw new Error(error || 'Invalid state');
  void db.terminate();
});
`;
  await execute(executable, ["-e", sqliteScript], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 10000,
  });
  if ((await readFile(file)).subarray(0, 16).toString() !== "SQLite format 3\0")
    throw new Error(
      "Packaged workspace worker did not create a SQLite database",
    );
} finally {
  await rm(profile, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      artifact,
      signature: "PASS local ad-hoc codesign --verify --deep --strict",
      cli: "PASS real packaged Electron-as-Node CLI help",
      pty: "PASS packaged native PTY with three TTY descriptors",
      workspaceState: "PASS packaged SQLite worker opens a workspace profile",
      originalLogoSha256: logoHash,
      agentPlugin: "PASS included",
      macOSGui: "BLOCKED: active desktop must not be used",
      notarization: "NOT_PERFORMED",
    },
    null,
    2,
  ),
);
