#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildInfoName, sourceHash } from "./build-info.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const service = "cod-workspace-host.service";
const pty = "@homebridge/node-pty-prebuilt-multiarch";
const files = ["workspace-host.cjs", "cli.cjs", "sqlite-state-worker.cjs"];
const ownedLauncher = "# Installed by Cod's Linux workspace host installer";
const serviceCommand = 'ExecStart="%h/.local/bin/cod-workspace-host" serve';

async function run(command, args, options = {}) {
  return (
    await execute(command, args, {
      timeout: 10000,
      maxBuffer: 32768,
      ...options,
    })
  ).stdout;
}

async function absent(file) {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function useRelease(directory, destination) {
  if (!(await absent(destination))) return;
  const staging = await mkdtemp(path.join(directory, ".install-"));
  try {
    for (const file of files)
      await copyFile(path.join(root, "dist", file), path.join(staging, file));
    await mkdir(path.join(staging, "node_modules", "@homebridge"), {
      recursive: true,
    });
    for (const dependency of [pty, "node-addon-api"])
      await cp(
        path.join(root, "node_modules", dependency),
        path.join(staging, "node_modules", dependency),
        { recursive: true },
      );
    try {
      await rename(staging, destination);
    } catch (error) {
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function verifyBuild(directory, outputs) {
  for (const file of files) {
    const digest = createHash("sha256")
      .update(await readFile(path.join(directory, file)))
      .digest("hex");
    if (digest !== outputs[file])
      throw new Error(
        "The workspace host build changed. Run npm run build again.",
      );
  }
}

async function assertManagedUnit(unit) {
  const info = await lstat(unit);
  const error = new Error(
    "An unrelated cod-workspace-host.service already exists",
  );
  if (!info.isFile() || info.uid !== process.getuid()) throw error;
  const commands = (await readFile(unit, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^ExecStart\s*=/.test(line));
  if (commands.length !== 1 || commands[0] !== serviceCommand) throw error;
}

async function main() {
  if (process.argv.length !== 2)
    throw new Error("Usage: node scripts/install-workspace-host.mjs");
  if (
    process.platform !== "linux" ||
    !(await import("node:sqlite").catch(() => undefined))?.DatabaseSync
  )
    throw new Error(
      "Installing the workspace host requires Linux and Node.js with built-in SQLite enabled (Node.js 24 recommended)",
    );
  const home = homedir();
  const profile = path.join(home, ".local/state/cod-host");
  const socket = path.join(profile, "cod.sock");
  if (Buffer.byteLength(socket) > 107 || /[:\u0000-\u001f\u007f]/.test(socket))
    throw new Error(
      "The account's home does not allow a usable workspace host socket path",
    );
  const control = (...args) => run("systemctl", ["--user", ...args]);
  await control("show", "--property=Version", "--value").catch(() => {
    throw new Error(
      "Start a systemd user manager before installing the workspace host",
    );
  });
  const linger = await run("loginctl", [
    "show-user",
    String(process.getuid()),
    "--property=Linger",
    "--value",
  ]).catch(() => "");
  if (linger.trim() !== "yes")
    throw new Error(
      "The Linux account needs systemd lingering to keep Cod alive after logout. Enable it for this account with loginctl enable-linger, then retry.",
    );
  const metadata = JSON.parse(
    await readFile(path.join(root, "dist", buildInfoName), "utf8").catch(() => {
      throw new Error(
        "Build the checked Linux checkout with npm run build first",
      );
    }),
  );
  const revision = await sourceHash(root);
  if (metadata.schema !== 1 || metadata.build?.sourceHash !== revision)
    throw new Error(
      "The workspace host build is stale. Run npm run build again.",
    );
  await verifyBuild(path.join(root, "dist"), metadata.outputs);

  const runtime = path.join(home, ".local/lib/cod-workspace-host");
  const versions = path.join(runtime, "versions");
  const release = path.join(versions, revision);
  const launcher = path.join(home, ".local/bin/cod-workspace-host");
  const unit = path.join(home, ".config/systemd/user", service);
  const unitFragment = async () =>
    (
      await control("show", "--property=FragmentPath", "--value", service)
    ).trim();
  const existingUnit = await unitFragment();
  if (existingUnit && existingUnit !== unit)
    throw new Error("An unrelated cod-workspace-host.service already exists");
  if (!(await absent(unit))) await assertManagedUnit(unit);
  if (!(await absent(launcher))) {
    const info = await lstat(launcher);
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      !(await readFile(launcher, "utf8")).startsWith(
        `#!/bin/sh\n${ownedLauncher}\n`,
      )
    )
      throw new Error(
        "An unrelated cod-workspace-host launcher already exists",
      );
  }
  await mkdir(versions, { recursive: true, mode: 0o700 });
  await useRelease(versions, release);
  await verifyBuild(release, metadata.outputs);
  await run(process.execPath, ["-e", `require(${JSON.stringify(pty)})`], {
    cwd: release,
    timeout: 5000,
  });

  await mkdir(path.dirname(launcher), { recursive: true });
  await mkdir(path.dirname(unit), { recursive: true });
  const script = `#!/bin/sh
${ownedLauncher}
set -eu
export PATH="$HOME/.local/bin":${shellQuote(path.dirname(process.execPath))}:"$PATH"
profile="$HOME/.local/state/cod-host"
runtime="$HOME/.local/lib/cod-workspace-host/current"
if [ "$#" -eq 1 ] && [ "$1" = serve ]; then
    exec ${shellQuote(process.execPath)} "$runtime/workspace-host.cjs" "$profile"
fi
if [ "$#" -eq 1 ] && [ "$1" = endpoint ]; then
    exec ${shellQuote(process.execPath)} "$runtime/workspace-host.cjs" --endpoint "$profile"
fi
printf 'Usage: cod-workspace-host endpoint | serve\\n' >&2
exit 2
`;
  const nextLauncher = `${launcher}.${randomUUID()}.tmp`;
  const nextRelease = path.join(runtime, `.current-${randomUUID()}`);
  try {
    await writeFile(nextLauncher, script, { flag: "wx", mode: 0o700 });
    await symlink(path.relative(runtime, release), nextRelease);
    await rename(nextRelease, path.join(runtime, "current"));
    await rename(nextLauncher, launcher);
  } finally {
    await unlink(nextLauncher).catch(() => undefined);
    await unlink(nextRelease).catch(() => undefined);
  }
  await writeFile(
    unit,
    `[Unit]
Description=Cod workspace host

[Service]
${serviceCommand}
Restart=on-failure

[Install]
WantedBy=default.target
`,
    { flag: "wx", mode: 0o600 },
  ).catch(async (error) => {
    if (error.code !== "EEXIST") throw error;
    await assertManagedUnit(unit);
  });
  try {
    await control("daemon-reload");
    if ((await unitFragment()) !== unit)
      throw new Error(
        "systemd did not load this account's Cod workspace service",
      );
    // Asking systemd to start an already active unit leaves its process and PTYs intact.
    await control("enable", "--now", service);
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await run(launcher, ["endpoint"], { timeout: 2500 });
        console.log(
          "Cod workspace host is ready. Connect using this account's SSH alias.",
        );
        return;
      } catch {
        await delay(250);
      }
    }
  } catch (cause) {
    console.error(cause.stderr?.trim() || cause.message);
  }
  throw new Error(
    "The workspace host is not ready. Inspect journalctl --user -u cod-workspace-host.service.",
  );
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
