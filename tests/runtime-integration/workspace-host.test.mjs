import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { readWorkspaceState } from "../support/workspace-state.ts";

const execute = promisify(execFile);
const hostEntry = path.resolve("dist/workspace-host.cjs");
const cliEntry = path.resolve("dist/cli.cjs");

test(
  "Linux installer creates a discoverable service and retains sessions on reinstall",
  { skip: process.platform !== "linux", timeout: 20000 },
  async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cod-installed-"));
    const shim = path.join(home, "shim");
    const launcher = path.join(home, ".local/bin/cod-workspace-host");
    const service = path.join(
      home,
      ".config/systemd/user/cod-workspace-host.service",
    );
    const activePid = path.join(home, "pid");
    const commands = path.join(home, "systemctl.log");
    const socketPath = path.join(home, ".local/state/cod-host/cod.sock");
    const env = {
      ...process.env,
      HOME: home,
      PATH: shim + path.delimiter + process.env.PATH,
      COD_SOCKET_PATH: socketPath,
      COD_TERMINAL_SHELL: "/bin/sh",
      COD_TERMINAL_ARGS: '["-i"]',
    };
    const install = () =>
      execute(process.execPath, ["scripts/install-workspace-host.mjs"], {
        env,
        timeout: 10000,
      });
    await mkdir(shim);
    await writeFile(
      path.join(shim, "loginctl"),
      '#!/bin/sh\ncat "$HOME/linger"\n',
      { mode: 0o700 },
    );
    await writeFile(
      path.join(shim, "systemctl"),
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$HOME/systemctl.log"
case "$*" in
  "--user show --property=Version --value" | "--user daemon-reload") exit 0 ;;
  "--user show --property=FragmentPath --value cod-workspace-host.service")
    unit="$HOME/.config/systemd/user/cod-workspace-host.service"
    if [ -f "$unit" ]; then printf '%s\\n' "$unit"; fi ;;
  "--user enable --now cod-workspace-host.service")
    if [ ! -f "$HOME/pid" ]; then
      "$HOME/.local/bin/cod-workspace-host" serve </dev/null >"$HOME/host.log" 2>&1 &
      echo "$!" >"$HOME/pid"
    fi ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o700 },
    );
    try {
      await writeFile(path.join(home, "linger"), "no\n");
      await assert.rejects(install(), /needs systemd lingering/);
      await assert.rejects(stat(launcher), { code: "ENOENT" });
      await writeFile(path.join(home, "linger"), "yes\n");
      const unrelated = "[Service]\nExecStart=/bin/false\n";
      await mkdir(path.dirname(service), { recursive: true });
      await writeFile(service, unrelated);
      await assert.rejects(
        install(),
        /An unrelated cod-workspace-host.service/,
      );
      assert.equal(await readFile(service, "utf8"), unrelated);
      await assert.rejects(stat(launcher), { code: "ENOENT" });
      await assert.rejects(stat(activePid), { code: "ENOENT" });
      await unlink(service);
      assert.match((await install()).stdout, /workspace host is ready/);
      assert.match(
        await readFile(service, "utf8"),
        /cod-workspace-host" serve/,
      );
      assert.deepEqual(
        JSON.parse((await execute(launcher, ["endpoint"], { env })).stdout),
        { socketPath },
      );
      const revision = path.join(home, ".local/lib/cod-workspace-host/current");
      const firstRelease = await readlink(revision);
      const firstPid = await readFile(activePid, "utf8");
      const cli = async (...args) =>
        JSON.parse(
          (
            await execute(process.execPath, [cliEntry, ...args], {
              env,
              timeout: 3000,
            })
          ).stdout,
        );
      const workspace = (await cli("state")).workspaces[0].id;
      const terminal = await cli("terminal", "open", "--workspace", workspace);
      const shellPid = (await cli("terminal", "inspect", "--id", terminal.id))
        .pid;
      assert(shellPid > 0);
      const customized = (await readFile(service, "utf8")).replace(
        "Restart=on-failure",
        "Restart=on-failure\nRestartSec=3",
      );
      await writeFile(service, customized);
      await install();
      assert.equal(await readFile(service, "utf8"), customized);
      assert.equal(await readFile(activePid, "utf8"), firstPid);
      assert.equal(await readlink(revision), firstRelease);
      const reopened = await cli("terminal", "inspect", "--id", terminal.id);
      assert.equal(reopened.pid, shellPid);
      assert.equal(reopened.status, "running");
      assert.deepEqual((await readFile(commands, "utf8")).trim().split("\n"), [
        "--user show --property=Version --value",
        "--user show --property=Version --value",
        "--user show --property=FragmentPath --value cod-workspace-host.service",
        "--user show --property=Version --value",
        "--user show --property=FragmentPath --value cod-workspace-host.service",
        "--user daemon-reload",
        "--user show --property=FragmentPath --value cod-workspace-host.service",
        "--user enable --now cod-workspace-host.service",
        "--user show --property=Version --value",
        "--user show --property=FragmentPath --value cod-workspace-host.service",
        "--user daemon-reload",
        "--user show --property=FragmentPath --value cod-workspace-host.service",
        "--user enable --now cod-workspace-host.service",
      ]);
    } finally {
      const pid = Number(await readFile(activePid, "utf8").catch(() => ""));
      if (pid > 1) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        for (let attempt = 0; attempt < 40; attempt++) {
          if (!(await stat(socketPath).catch(() => undefined))) break;
          await delay(25);
        }
      }
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  "Linux workspace host retains files, layout and a native PTY across independent CLI clients",
  { skip: process.platform !== "linux", timeout: 15000 },
  async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "cod-host-"));
    const profile = path.join(fixture, "profile");
    const socketPath = path.join(profile, "cod.sock");
    const repository = path.join(fixture, "fixture");
    const file = path.join(repository, "spec.md");
    const inputrc = path.join(fixture, "inputrc");
    // The fixture uses a real shell, including systems where /bin/sh is bash.
    await writeFile(inputrc, "set enable-bracketed-paste off\n");
    const endpoint = () =>
      execute(process.execPath, [hostEntry, "--endpoint", profile], {
        timeout: 3000,
      });
    await assert.rejects(endpoint(), /No ready Linux workspace host/);
    await assert.rejects(stat(profile), { code: "ENOENT" });
    await mkdir(repository);
    await writeFile(file, "# Invented document\n");
    const git = (...args) => execute("git", ["-C", repository, ...args]);
    await git("init", "-q");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Invented starting document",
    );
    const host = spawn(process.execPath, [hostEntry, profile], {
      env: {
        ...process.env,
        COD_TERMINAL_SHELL: "/bin/sh",
        COD_TERMINAL_ARGS: '["-i"]',
        INPUTRC: inputrc,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = once(host, "exit");
    let errors = "";
    host.stderr.setEncoding("utf8").on("data", (chunk) => {
      errors += chunk;
    });
    const cli = async (...args) => {
      const result = await execute(process.execPath, [cliEntry, ...args], {
        env: { ...process.env, COD_SOCKET_PATH: socketPath },
        timeout: 3000,
      });
      return JSON.parse(result.stdout);
    };
    try {
      let capability;
      for (let attempt = 0; attempt < 50 && !capability; attempt++) {
        if (host.exitCode !== null) break;
        try {
          capability = await cli("capabilities");
        } catch {
          await delay(30);
        }
      }
      assert(capability, "Host did not start: " + errors);
      assert(capability.operations.includes("file.read"));
      assert(!capability.operations.includes("browser.open"));
      assert.equal((await stat(profile)).mode & 0o777, 0o700);
      assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse((await endpoint()).stdout), { socketPath });
      await chmod(socketPath, 0o666);
      await assert.rejects(endpoint(), /workspace host socket is not private/);
      await chmod(socketPath, 0o600);
      const otherProfile = path.join(fixture, "other");
      await mkdir(otherProfile, { mode: 0o700 });
      await symlink(socketPath, path.join(otherProfile, "cod.sock"));
      await assert.rejects(
        execute(process.execPath, [hostEntry, "--endpoint", otherProfile]),
        /workspace host socket is not private/,
      );

      await assert.rejects(
        execute(process.execPath, [hostEntry, profile], { timeout: 2000 }),
        /already controls this socket/,
      );
      const workspace = (await cli("state")).workspaces[0].id;
      await cli(
        "workspace",
        "add-folder",
        "--id",
        workspace,
        "--path",
        repository,
      );
      const { paneId } = await cli(
        "file",
        "open",
        "--workspace",
        workspace,
        "--path",
        file,
      );
      await cli(
        "file",
        "save",
        "--workspace",
        workspace,
        "--pane-id",
        paneId,
        "--content",
        "# Edited document\n",
        "--expected-content",
        "# Invented document\n",
      );
      assert.equal(await readFile(file, "utf8"), "# Edited document\n");
      assert.match(
        (await git("diff", "--", "spec.md")).stdout,
        /\+# Edited document/,
      );
      await cli(
        "pane",
        "pin",
        "--workspace",
        workspace,
        "--id",
        paneId,
        "--pinned",
        "true",
      );
      const left = (await cli("state")).workspaces[0].activeGroupId;
      const { groupId } = await cli(
        "group",
        "ensure",
        "--workspace",
        workspace,
        "--side",
        "right",
      );
      assert.notEqual(groupId, left);
      const terminal = await cli(
        "terminal",
        "open",
        "--workspace",
        workspace,
        "--group",
        groupId,
        "--cwd",
        repository,
      );
      const processInfo = await cli("terminal", "inspect", "--id", terminal.id);
      assert(processInfo.pid > 0);
      await cli(
        "terminal",
        "write",
        "--id",
        terminal.id,
        "--data",
        "sleep 0.2; printf '%s\\n' INVENTED_HOST_OUTPUT; : > terminal-finished\n",
      );
      // Wait for the Linux terminal to finish while no CLI client is attached.
      const finished = path.join(repository, "terminal-finished");
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await stat(finished).catch(() => false)) break;
        await delay(40);
      }
      await stat(finished);
      const observed = await cli("terminal", "inspect", "--id", terminal.id);
      assert.equal(observed.pid, processInfo.pid);
      assert.match(observed.output, /\nINVENTED_HOST_OUTPUT\r?\n/);

      const current = (await cli("state")).workspaces[0];
      assert.equal(current.groupLayout.type, "split");
      assert.equal(current.activeGroupId, groupId);
      assert(
        current.groups
          .find((group) => group.id === left)
          .paneIds.includes(paneId),
      );
      assert(
        current.groups
          .find((group) => group.id === groupId)
          .paneIds.includes(terminal.paneId),
      );
      assert.equal(
        current.panes.find((pane) => pane.id === paneId).pinned,
        true,
      );
      const saved = readWorkspaceState(profile);
      assert.deepEqual(saved.workspaces[0].groups, current.groups);

      const socket = connect(socketPath);
      socket.setEncoding("utf8");
      socket.write(
        JSON.stringify({
          op: "review.detail",
          id: "fixture",
          trustedUi: true,
        }) + "\n",
      );
      let reply = "";
      for await (const chunk of socket) reply += chunk;
      const response = JSON.parse(reply);
      assert.equal(response.ok, false);
      assert.match(response.error, /trusted desktop UI/);
    } finally {
      if (host.exitCode === null) host.kill("SIGTERM");
      await exited;
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
