import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const execute = promisify(execFile);
const artifact = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || process.platform !== "darwin")
  throw new Error("Usage on macOS: node check-package.mjs PACKAGE_DIRECTORY");
const bundle = path.join(artifact, "Cod.app");
const app = path.join(bundle, "Contents/Resources/app");
const executable = path.join(bundle, "Contents/MacOS/Electron");
await execute("codesign", ["--verify", "--deep", "--strict", bundle]);
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
  path.join(app, "runtime-skills/cod/SKILL.md"),
  "utf8",
);
if (!skill.includes("COD_NODE_PATH"))
  throw new Error("Packaged skill is stale");
await access(path.join(app, "runtime-plugins/cod/status-hook.mjs"));
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
console.log(
  JSON.stringify(
    {
      artifact,
      signature: "PASS local ad-hoc codesign --verify --deep --strict",
      cli: "PASS real packaged Electron-as-Node CLI help",
      pty: "PASS packaged native PTY with three TTY descriptors",
      originalLogoSha256: logoHash,
      runtimeSkillAndPlugin: "PASS included",
      macOSGui: "BLOCKED: active desktop must not be used",
      notarization: "NOT_PERFORMED",
    },
    null,
    2,
  ),
);
