import { publishPackage } from "./release-retention.mjs";
import { bitwardenRelease, extractBitwarden } from "./bitwarden-release.mjs";
// Local host-platform packaging from prebuilt Electron; ad-hoc macOS signing only.
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  lstat,
  chmod,
  rm,
  access,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log(
    "Usage: node scripts/package.mjs [--dist PATH]\nPackages the host platform using installed prebuilt Electron and fresh locked production dependencies. Does not build, publish or launch. macOS bundles receive a local ad-hoc signature.",
  );
  process.exit(0);
}
if (argv.length && (argv.length !== 2 || argv[0] !== "--dist"))
  throw new Error("Expected optional --dist PATH");
if (!["darwin", "linux"].includes(process.platform))
  throw new Error("Only macOS and Linux host packaging is supported");
const dist = path.resolve(root, argv[1] ?? "dist");
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const electron = JSON.parse(
  await readFile(path.join(root, "node_modules/electron/package.json"), "utf8"),
);
const electronDist = path.join(root, "node_modules/electron/dist");
const allowed = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".html",
  ".css",
  ".json",
  ".wasm",
  ".svg",
  ".png",
  ".ico",
  ".woff",
  ".woff2",
]);
async function files(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new Error(`Symlink in application input: ${entry.name}`);
    if (entry.name.startsWith("."))
      throw new Error("Hidden files are not permitted in app input");
    const relative = path.join(prefix, entry.name),
      absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(absolute, relative)));
    else if (entry.isFile() && entry.name.endsWith(".map")) continue;
    else if (entry.isFile() && allowed.has(path.extname(entry.name)))
      result.push(relative);
    else throw new Error(`Unexpected application input: ${relative}`);
  }
  return result.sort();
}
const digest = async (directory, names) =>
  Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(path.join(directory, name)))
          .digest("hex"),
      ]),
    ),
  );
const names = await files(dist);
for (const name of [
  "main.cjs",
  "preload.cjs",
  "cli.cjs",
  "renderer.js",
  "index.html",
  "styles.css",
])
  if (!names.includes(name)) throw new Error(`Missing built input: ${name}`);
const extensionArchive = path.join(
  root,
  "artifacts/bitwarden",
  `bitwarden-${bitwardenRelease.version}.zip`,
);
try {
  await access(extensionArchive);
} catch {
  throw new Error(
    "Official Bitwarden archive missing. Run npm run prepare:bitwarden before packaging.",
  );
}
const before = await digest(dist, names);
const release = path.join(root, "release");
await mkdir(release, { recursive: true });
const stage = await mkdtemp(path.join(release, ".cod-stage-"));
try {
  // A separate install area prevents bundling repository dev dependencies/configuration.
  const install = path.join(stage, "install");
  await mkdir(install);
  await writeFile(
    path.join(install, "package.json"),
    JSON.stringify({ ...manifest, scripts: {} }, null, 2),
  );
  await cp(
    path.join(root, "package-lock.json"),
    path.join(install, "package-lock.json"),
  );
  await run(
    "npm",
    [
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--fetch-retries=1",
      "--fetch-timeout=30000",
    ],
    { cwd: install, timeout: 180000, maxBuffer: 1024 * 1024 },
  );
  const output = path.join(stage, "artifact");
  await mkdir(output);
  let resources, executable;
  if (process.platform === "darwin") {
    await cp(
      path.join(electronDist, "Electron.app"),
      path.join(output, "Cod.app"),
      { recursive: true, verbatimSymlinks: true },
    );
    resources = path.join(output, "Cod.app/Contents/Resources");
    executable = "Cod.app/Contents/MacOS/Electron";
    await cp(
      path.join(root, "assets/cod.icns"),
      path.join(resources, "cod.icns"),
    );
    const plist = path.join(output, "Cod.app/Contents/Info.plist");
    for (const [key, value] of Object.entries({
      CFBundleName: "Cod",
      CFBundleDisplayName: "Cod",
      CFBundleIdentifier: "dev.cod.desktop",
      CFBundleIconFile: "cod.icns",
    }))
      await run("/usr/libexec/PlistBuddy", [
        "-c",
        `Set :${key} ${value}`,
        plist,
      ]);
    // Declare browser capability without changing the user's default browser.
    await run("/usr/libexec/PlistBuddy", [
      "-c",
      "Add :CFBundleURLTypes array",
      plist,
    ]);
    for (const command of [
      "Add :CFBundleURLTypes:0 dict",
      "Add :CFBundleURLTypes:0:CFBundleURLName string Web URLs",
      "Add :CFBundleURLTypes:0:CFBundleTypeRole string Viewer",
      "Add :CFBundleURLTypes:0:LSHandlerRank string Alternate",
      "Add :CFBundleURLTypes:0:CFBundleURLSchemes array",
      "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string http",
      "Add :CFBundleURLTypes:0:CFBundleURLSchemes:1 string https",
    ])
      await run("/usr/libexec/PlistBuddy", ["-c", command, plist]);
    // Re-sign the changed local bundle ad hoc; this is not notarization or distribution signing.
  } else {
    await cp(electronDist, output, { recursive: true, verbatimSymlinks: true });
    resources = path.join(output, "resources");
    executable = "electron";
  }
  await rm(path.join(resources, "default_app.asar"), { force: true });
  const app = path.join(resources, "app");
  await mkdir(path.join(app, "dist"), { recursive: true });
  await extractBitwarden(
    extensionArchive,
    path.join(app, "extensions/bitwarden"),
  );
  for (const name of names) {
    await mkdir(path.dirname(path.join(app, "dist", name)), {
      recursive: true,
    });
    await cp(path.join(dist, name), path.join(app, "dist", name));
  }
  if (
    JSON.stringify(before) !==
    JSON.stringify(await digest(dist, await files(dist)))
  )
    throw new Error("Dist changed while packaging; use a frozen build");
  await cp(
    path.join(root, "runtime-skills"),
    path.join(app, "runtime-skills"),
    {
      recursive: true,
      filter: async (source) => {
        if ((await lstat(source)).isSymbolicLink())
          throw new Error("Runtime skill symlinks are not permitted");
        return !path.basename(source).startsWith(".");
      },
    },
  );
  await cp(
    path.join(root, "runtime-plugins"),
    path.join(app, "runtime-plugins"),
    { recursive: true },
  );
  await cp(path.join(install, "node_modules"), path.join(app, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await writeFile(
    path.join(app, "package.json"),
    JSON.stringify(
      {
        name: "cod",
        productName: "Cod",
        version: manifest.version,
        private: true,
        main: "dist/main.cjs",
        dependencies: manifest.dependencies ?? {},
      },
      null,
      2,
    ) + "\n",
  );
  // npm scripts are disabled: repair only the already shipped native helper permission.
  const native = path.join(
    app,
    "node_modules/@homebridge/node-pty-prebuilt-multiarch/prebuilds",
    `${process.platform}-${process.arch}`,
  );
  await access(native);
  for (const file of await readdir(native))
    if (file === "spawn-helper") await chmod(path.join(native, file), 0o755);
  await chmod(path.join(output, executable), 0o755);
  await writeFile(
    path.join(output, "codctl"),
    `#!/bin/sh\nset -eu\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec env ELECTRON_RUN_AS_NODE=1 "$base/${executable}" "$base/${path.relative(output, path.join(app, "dist/cli.cjs"))}" "$@"\n`,
    { mode: 0o755 },
  );
  const launcher = path.join(output, "codctl");
  if ((await readFile(launcher, "utf8")).split("\n")[0] !== "#!/bin/sh")
    throw new Error("Packaged CLI launcher has an invalid shebang");
  await run("sh", ["-n", launcher], { timeout: 10000 });
  await writeFile(
    path.join(output, "package-evidence.json"),
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        electron: electron.version,
        applicationVersion: manifest.version,
        signedByThisScript: process.platform === "darwin",
        signingIdentity: process.platform === "darwin" ? "ad-hoc" : null,
        notarized: false,
        asar: false,
        sourceHashes: before,
        includedAppRoots: [
          "dist",
          "runtime-skills",
          "runtime-plugins",
          "package.json",
          "node_modules",
        ],
        verification: "Packaging only; launch/PTY/CLI/MCP smoke required",
      },
      null,
      2,
    ) + "\n",
  );
  const destination = path.join(
    release,
    `cod-${process.platform}-${process.arch}-${Date.now()}`,
  );
  await publishPackage(output, destination, async (stagedOutput) => {
    if (process.platform === "darwin")
      await run(
        "codesign",
        [
          "--force",
          "--deep",
          "--sign",
          "-",
          path.join(stagedOutput, "Cod.app"),
        ],
        { timeout: 120000, maxBuffer: 1024 * 1024 },
      );
  });
  console.log(
    JSON.stringify({
      artifact: destination,
      executable: path.join(destination, executable),
      cli: path.join(destination, "codctl"),
      verified: false,
    }),
  );
} finally {
  // stage was generated by this invocation under release; never delete caller paths.
  await rm(stage, { recursive: true, force: true });
}
