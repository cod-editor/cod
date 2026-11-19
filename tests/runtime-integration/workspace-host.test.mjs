import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const hostEntry = path.resolve("dist/workspace-host.cjs");
const cliEntry = path.resolve("dist/cli.cjs");

test(
  "Linux workspace host retains files, layout and a native PTY across independent CLI clients",
  { skip: process.platform !== "linux", timeout: 15000 },
  async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "cod-host-"));
    const profile = path.join(fixture, "profile");
    const socketPath = path.join(profile, "cod.sock");
    const repository = path.join(fixture, "fixture");
    const file = path.join(repository, "spec.md");
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
      const saved = JSON.parse(
        await readFile(path.join(profile, "state.json"), "utf8"),
      );
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
