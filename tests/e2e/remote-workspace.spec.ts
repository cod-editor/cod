import { expect, test } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ChatApp, type Chat } from "./helpers/chat-fixture/harness";
import { modifier } from "./helpers/workspace-app";
import type { AppState } from "../../src/types";
import { invokeCommand } from "../../src/command-client";

async function readUnpairedWatch(socketPath: string): Promise<AppState> {
  const peer = connect(socketPath);
  peer.setEncoding("utf8");
  peer.once("connect", () => peer.write('{"op":"workspace.watch"}\n'));
  try {
    let input = "";
    for await (const chunk of peer) {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline !== -1) {
        const frame = JSON.parse(input.slice(0, newline));
        expect(frame.type).toBe("state");
        return frame.value;
      }
    }
    throw new Error("Linux workspace did not send state");
  } finally {
    peer.destroy();
  }
}

async function installWorkspaceRelay(
  desktop: ChatApp,
  dropReply?: string,
  discoverySocket?: string,
) {
  const forwarder = path.resolve("tests/e2e/helpers/unix-socket-forward.mjs");
  await desktop.app!.evaluate(
    (_electron, { fixture, dropReply, discoverySocket }) => {
      const childProcess = process.getBuiltinModule(
        "node:child_process",
      ) as typeof import("node:child_process");
      const original = childProcess.spawn;
      if (discoverySocket) {
        const { promisify } = process.getBuiltinModule(
          "node:util",
        ) as typeof import("node:util");
        const exec = promisify(childProcess.execFile);
        // Bind the callable so the original immutable promisifier stays intact.
        childProcess.execFile = new Proxy(childProcess.execFile.bind(null), {
          get(target, property, receiver) {
            if (property !== promisify.custom)
              return Reflect.get(target, property, receiver);
            return (
              command: string,
              args: string[],
              options: import("node:child_process").ExecFileOptions,
            ) => {
              if (command !== "/usr/bin/ssh")
                return exec(command, args, options);
              const host = args.at(-2);
              const checkedArguments =
                args.at(-1) ===
                  'exec "$HOME/.local/bin/cod-workspace-host" endpoint' &&
                [
                  "BatchMode=yes",
                  "StrictHostKeyChecking=yes",
                  "ForwardAgent=no",
                  "ForwardX11=no",
                  "ClearAllForwardings=yes",
                  "PermitLocalCommand=no",
                ].every((option) => args.includes(option)) &&
                options.maxBuffer === 4_096 &&
                options.timeout === 12_000 &&
                options.signal instanceof AbortSignal;
              const fixture = !checkedArguments
                ? 'process.stderr.write("Unexpected discovery invocation"); process.exitCode = 2'
                : host === "missing-linux"
                  ? "process.exitCode = 127"
                  : host === "invalid-linux"
                    ? 'process.stdout.write(JSON.stringify({ socketPath: "/invalid:forward" }))'
                    : host === "waiting-linux"
                      ? "setTimeout(() => {}, 10_000)"
                      : `process.stdout.write(${JSON.stringify(JSON.stringify({ socketPath: discoverySocket }))})`;
              return exec(process.execPath, ["-e", fixture], {
                ...options,
                env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
              });
            };
          },
        });
      }
      let pid = 0;
      childProcess.spawn = ((
        command: string,
        args: string[],
        options: import("node:child_process").SpawnOptions,
      ) => {
        if (
          command !== "/usr/bin/ssh" ||
          !["invented-linux", "replacement-linux"].includes(args.at(-1) ?? "")
        ) {
          return original(command, args, options);
        }
        const forward = args[args.indexOf("-L") + 1];
        const relay = original(
          process.execPath,
          [fixture, forward, dropReply || ""],
          {
            ...options,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          },
        );
        pid = relay.pid!;
        return relay;
      }) as typeof original;
      process.on("cod-test-stop-forward", () => process.kill(pid, "SIGTERM"));
    },
    { fixture: forwarder, dropReply, discoverySocket },
  );
}

async function connectWorkspace(
  desktop: ChatApp,
  socket: string,
  key?: string,
) {
  await desktop.command("Connect to Linux workspace");
  const connect = desktop.page.getByRole("dialog", {
    name: "Connect to Linux workspace",
  });
  await expect(
    connect.getByRole("textbox", { name: "SSH host alias" }),
  ).toBeFocused();
  await connect
    .getByRole("textbox", { name: "SSH host alias" })
    .fill("invented-linux");
  await connect.getByText("Connection options", { exact: true }).click();
  await connect
    .getByRole("textbox", { name: "Linux socket path (optional)" })
    .fill(socket);
  if (key)
    await connect
      .getByRole("textbox", {
        name: "SSH public key for private review (optional)",
      })
      .fill(key);
  await connect.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(connect).not.toBeVisible();
}

test("A saved Codex chat moves to Linux once after a lost reply and restart", async ({}, info) => {
  test.skip(process.platform !== "linux", "The workspace host requires Linux");
  test.setTimeout(90_000);
  const desktop = new ChatApp();
  const linux = new ChatApp();
  await desktop.prepare();
  await linux.prepare();
  for (const runtime of [desktop, linux]) {
    runtime.environment.CODEX_HOME = path.join(
      runtime.temporary,
      "isolated-native",
    );
    await runtime.configure({ codex: { portableRollout: true } });
  }
  linux.socket = path.join(linux.data, "cod.sock");
  linux.environment.COD_SOCKET_PATH = linux.socket;
  const startHost = () =>
    spawn(process.execPath, ["dist/workspace-host.cjs", linux.data], {
      env: linux.environment,
      stdio: "ignore",
    });
  let host = startHost();
  const stopHost = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (host.exitCode !== null || host.signalCode !== null) return;
    const exited = once(host, "exit");
    host.kill(signal);
    await exited;
  };
  try {
    await expect
      .poll(async () => (await linux.raw("capabilities")).code)
      .toBe(0);
    const destination = await linux.cli<{ id: string }>(
      "workspace",
      "prepare",
      "--name",
      "Invented Linux project",
      "--folders",
      JSON.stringify(linux.folders),
    );
    // Keep an attached folder whose directory is no longer available.
    await rm(linux.folders[1], { recursive: true });
    await desktop.start();
    const source = await desktop.create("Invented desktop project");
    const chat = await desktop.newChat(source, "codex");
    await desktop.send(chat.id, "Invented transfer history");
    await expect
      .poll(async () => (await desktop.inspect(chat.id)).status)
      .toBe("ready");

    const key = path.join(desktop.temporary, "invented-transfer-key");
    execFileSync("/usr/bin/ssh-keygen", [
      "-q",
      "-N",
      "",
      "-t",
      "ed25519",
      "-f",
      key,
    ]);
    await writeFile(
      path.join(linux.data, "desktop-signers"),
      'cod-desktop namespaces="cod-review" ' +
        (await readFile(key + ".pub", "utf8")),
      { mode: 0o600 },
    );
    const dropReply = path.join(desktop.temporary, "drop-transfer-reply");
    await installWorkspaceRelay(desktop, dropReply);
    const move = (cwd: string) => [
      "conversation",
      "transfer",
      "--id",
      chat.id,
      "--workspace",
      destination.id,
      "--cwd",
      cwd,
    ];
    await connectWorkspace(desktop, linux.socket);
    expect((await desktop.raw(...move(linux.folders[0]))).stderr).toContain(
      "Connect and pair",
    );
    expect(
      (await desktop.cli<AppState>("state")).conversations[0].transfer,
    ).toBeUndefined();
    await connectWorkspace(desktop, linux.socket, key + ".pub");
    const unavailable = await desktop.raw(...move(linux.folders[1]));
    expect(unavailable.code).toBe(1);
    expect(
      (await desktop.cli<AppState>("state")).conversations[0].transfer,
    ).toBeUndefined();
    expect((await linux.cli<AppState>("state")).conversations).toHaveLength(0);
    const rolloutName = path.join(
      "sessions",
      "2026",
      "01",
      "01",
      `rollout-2026-01-01T12-00-00-${chat.nativeId}.jsonl`,
    );
    const localRollout = path.join(desktop.environment.CODEX_HOME, rolloutName);
    const destinationCollision = path.join(
      linux.environment.CODEX_HOME,
      rolloutName,
    );
    await mkdir(path.dirname(destinationCollision), { recursive: true });
    await writeFile(destinationCollision, "An independently existing file", {
      mode: 0o600,
    });
    expect((await desktop.raw(...move(linux.folders[0]))).code).toBe(1);
    expect(await readFile(destinationCollision, "utf8")).toBe(
      "An independently existing file",
    );
    expect(
      (await desktop.cli<AppState>("state")).conversations[0].transfer,
    ).toBeUndefined();
    await unlink(destinationCollision);
    await desktop.send(chat.id, "Invented retry kept source usable");
    await expect
      .poll(async () => (await desktop.inspect(chat.id)).status)
      .toBe("ready");
    const originalBytes = await readFile(localRollout);

    await desktop.cli(
      "conversation",
      "composer",
      "--workspace",
      source,
      "--pane-id",
      chat.paneId,
      "--text",
      "Invented unsent draft",
    );
    await desktop.app!.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(760, 560);
    });
    const overview = await desktop.overview();
    await overview
      .locator(`button[data-navigation-key="conversation:${chat.id}"]`)
      .hover();
    await overview.getByRole("combobox").press("Shift+F10");
    await desktop.page
      .locator(".context-menu")
      .getByRole("button", { name: "Move to workspace...", exact: true })
      .click();
    const picker = desktop.page.getByRole("dialog", {
      name: "Move conversation to workspace",
    });
    const chosen = picker
      .getByRole("button", { name: /Invented Linux project/ })
      .filter({ hasText: path.basename(linux.folders[0]) });
    await expect(chosen).toBeVisible();
    await desktop.page.screenshot({
      path: info.outputPath("linux-move-picker.png"),
    });
    await picker.getByRole("textbox").fill(path.basename(linux.folders[0]));
    await picker.getByRole("textbox").press("Enter");
    const confirm = desktop.page.getByRole("dialog", {
      name: "Move conversation to Linux?",
    });
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(confirm).toContainText(linux.folders[0]);
    await desktop.page.screenshot({
      path: info.outputPath("linux-move-confirm.png"),
    });
    await confirm.press("Escape");
    await expect(picker).toBeVisible();
    expect((await linux.cli<AppState>("state")).conversations).toHaveLength(0);
    await linux.configure({
      codex: { portableRollout: true, holdPortableResume: true },
    });
    await chosen.click();
    await confirm.getByRole("button", { name: "Move conversation" }).click();
    await expect
      .poll(async () =>
        (await linux.records()).some(
          (record) => record.message?.method === "thread/resume",
        ),
      )
      .toBe(true);
    expect((await linux.cli<AppState>("state")).conversations).toHaveLength(0);
    await stopHost("SIGKILL");
    await expect(confirm.getByRole("alert")).toContainText("did not confirm");
    const held = (await desktop.cli<AppState>("state")).conversations[0];
    expect(held.transfer?.cwd).toBe(linux.folders[0]);
    expect(
      (
        await desktop.raw(
          "conversation",
          "send",
          "--id",
          chat.id,
          "--text",
          "Blocked second writer",
        )
      ).stderr,
    ).toContain("pending move");
    await confirm.press("Escape");
    await picker.getByRole("textbox").press("Escape");
    await (
      await desktop.overview()
    )
      .getByRole("combobox")
      .fill("Invented desktop project");
    await desktop.row("Invented desktop project").click();
    const heldPane = desktop.pane(chat.paneId);
    await expect(
      heldPane.getByRole("status", { name: "Conversation status" }),
    ).toContainText("Move to invented-linux pending");
    await expect(
      heldPane.getByRole("textbox", { name: "Message", exact: true }),
    ).not.toBeEditable();
    await desktop.page.screenshot({
      path: info.outputPath("linux-move-pending.png"),
    });

    await desktop.stop();
    await linux.configure({ codex: { portableRollout: true } });
    host = startHost();
    await expect
      .poll(async () => (await linux.raw("capabilities")).code)
      .toBe(0);
    await desktop.start();
    await installWorkspaceRelay(desktop, dropReply);
    await connectWorkspace(desktop, linux.socket, key + ".pub");
    await writeFile(dropReply, "conversation.accept-transfer");
    expect((await desktop.raw(...move(linux.folders[0]))).stderr).toContain(
      "did not confirm",
    );
    expect((await linux.cli<AppState>("state")).conversations).toHaveLength(1);
    expect(
      (await desktop.cli<AppState>("state")).conversations[0].transfer,
    ).toBeDefined();

    await desktop.stop();
    await stopHost();
    host = startHost();
    await expect
      .poll(async () => (await linux.raw("capabilities")).code)
      .toBe(0);
    await desktop.start();
    await installWorkspaceRelay(desktop, dropReply);
    await connectWorkspace(desktop, linux.socket, key + ".pub");
    const receipt = await desktop.cli<Chat>(...move(linux.folders[0]));
    expect(receipt.nativeId).toBe(chat.nativeId);
    expect((await desktop.cli<AppState>("state")).conversations).toHaveLength(
      0,
    );
    const after = await linux.cli<AppState>("state");
    expect(after.conversations).toHaveLength(1);
    expect(after.conversations[0]).toMatchObject({
      id: receipt.id,
      cwd: linux.folders[0],
      nativeId: chat.nativeId,
    });
    expect(JSON.stringify(after.conversations[0].messages)).toContain(
      "Invented transfer history",
    );
    expect(
      after.workspaces.find((workspace) => workspace.id === destination.id)
        ?.chatDrafts?.[receipt.paneId]?.text,
    ).toBe("Invented unsent draft");
    await expect(
      desktop
        .pane(receipt.paneId)
        .getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("Invented unsent draft");
    expect(await linux.prompts()).toHaveLength(0);
    await linux.send(receipt.id, "Invented Linux follow-up");
    await expect
      .poll(async () => (await linux.inspect(receipt.id)).status)
      .toBe("ready");
    expect(await linux.prompts()).toHaveLength(1);
    expect(await desktop.prompts()).toHaveLength(2);
    expect(await readFile(localRollout)).toEqual(originalBytes);
    expect(
      (
        await desktop.raw(
          "conversation",
          "resume",
          "--workspace",
          source,
          "--provider",
          "codex",
          "--native-id",
          chat.nativeId,
          "--cwd",
          desktop.folders[0],
        )
      ).stderr,
    ).toContain("moved to Linux");
  } finally {
    await desktop.cleanup();
    await stopHost();
    await linux.cleanup();
  }
});

test("agents prepare a task on the explicit host and follow the existing Linux chat", async () => {
  test.skip(
    process.platform !== "linux",
    "The production workspace host runs on Linux",
  );
  test.setTimeout(60_000);
  const desktop = new ChatApp();
  const linux = new ChatApp();
  await desktop.prepare();
  await linux.prepare();
  linux.socket = path.join(linux.data, "cod.sock");
  linux.environment.COD_SOCKET_PATH = linux.socket;

  const host = spawn(
    process.execPath,
    ["dist/workspace-host.cjs", linux.data],
    {
      env: linux.environment,
      stdio: "ignore",
    },
  );
  const exited = once(host, "exit");
  const prepare = (
    location: "local" | "linux",
    name: string,
    folders: string[] = [],
  ) => [
    "workspace",
    "prepare",
    "--location",
    location,
    "--name",
    name,
    "--folders",
    JSON.stringify(folders),
  ];
  const header = () =>
    desktop.page.getByRole("button", { name: "Overview", exact: true });
  const context = (runtime: ChatApp, id: string) =>
    runtime.cli<{
      location: string;
      workspace: { id: string; folders: string[] };
      conversation: { nativeId: string; cwd: string };
    }>("context", "--conversation", id);
  const focusWorkspace = async (name: string) => {
    await desktop.overview();
    await desktop.row(name).click();
  };

  try {
    await expect
      .poll(async () => (await linux.raw("capabilities")).code)
      .toBe(0);
    await desktop.start();

    const local = await desktop.cli<{ id: string }>(
      ...prepare("local", "Desktop intake", [desktop.folders[0]]),
    );
    await expect(header()).toHaveText("Desktop intake");
    const origin = await desktop.newChat(local.id, "codex");
    await desktop.send(origin.id, "Invented desktop task request");
    await expect
      .poll(async () => (await desktop.inspect(origin.id)).status)
      .toBe("ready");
    expect(await context(desktop, origin.id)).toMatchObject({
      location: "local",
      workspace: { id: local.id },
      conversation: { nativeId: origin.nativeId },
    });

    const absent = await desktop.raw(...prepare("linux", "Linux task"));
    expect(absent.code).toBe(1);
    expect(absent.stderr).toContain(
      "Connect to a Linux workspace from Commands",
    );
    expect(
      (await desktop.state()).workspaces.map(({ name }) => name),
    ).not.toContain("Linux task");

    const dropReply = path.join(desktop.temporary, "drop-reply");
    await installWorkspaceRelay(desktop, dropReply);
    await connectWorkspace(desktop, linux.socket);
    // A saved target is usable through the explicit CLI after restarting the
    // desktop. Ordinary startup itself leaves the user in the local workspace.
    await desktop.stop();
    await desktop.start();
    await expect(header()).toHaveText("Desktop intake");
    await installWorkspaceRelay(desktop, dropReply);

    const remoteFolders = [linux.folders[0], linux.folders[1]];
    const request = prepare("linux", "Linux task", remoteFolders);
    const prepared = await desktop.cli<{
      id: string;
      location: string;
      folders: string[];
    }>(...request);
    expect(prepared).toMatchObject({
      location: "linux",
      folders: remoteFolders,
    });
    await expect(header()).toHaveText("Linux task (invented-linux)");
    expect((await linux.cli<AppState>("state")).conversations).toHaveLength(0);
    expect(
      (await desktop.cli<AppState>("state")).conversations.map(({ id }) => id),
    ).toEqual([origin.id]);
    expect((await context(desktop, origin.id)).workspace.id).toBe(local.id);

    // Ctrl+N uses the visible workspace on either side of the connection.
    const previousPane = (await linux.workspace(prepared.id)).activePaneId;
    await desktop.page.keyboard.press(`${modifier}+n`);
    await expect
      .poll(async () => (await linux.workspace(prepared.id)).activePaneId)
      .not.toBe(previousPane);
    await expect(header()).toHaveText("Linux task (invented-linux)");
    expect((await linux.state()).activeWorkspaceId).toBe(prepared.id);
    expect((await linux.cli<AppState>("state")).conversations).toHaveLength(0);

    const rejected = await desktop.raw(...request, "--conversation", origin.id);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("cannot move to a Linux workspace");
    const invalid = await desktop.raw(
      ...prepare("linux", "Missing folder task", [
        linux.folders[0],
        path.join(linux.temporary, "missing"),
      ]),
    );
    expect(invalid.code).toBe(1);
    expect(
      (await linux.state()).workspaces.map(({ name }) => name),
    ).not.toContain("Missing folder task");

    await focusWorkspace("Desktop intake");
    await expect(header()).toHaveText("Desktop intake");
    await desktop.cli("workspace", "create", "--name", "Unrelated desktop");
    const hold = dropReply + ".hold";
    await writeFile(hold, "workspace.prepare");
    const delayed = desktop.cli<{ id: string }>(
      ...prepare("linux", "Delayed Linux task"),
    );
    try {
      await expect
        .poll(() =>
          readFile(hold + ".seen").then(
            () => true,
            () => false,
          ),
        )
        .toBe(true);
      await focusWorkspace("Unrelated desktop");
      await expect(header()).toHaveText("Unrelated desktop");
    } finally {
      await unlink(hold);
    }
    const completed = await delayed;
    expect((await linux.workspace(completed.id)).name).toBe(
      "Delayed Linux task",
    );
    await expect(header()).toHaveText("Unrelated desktop");
    await focusWorkspace("Desktop intake");
    const uncertain = prepare("linux", "Reply lost once", [linux.folders[0]]);
    await writeFile(dropReply, "workspace.prepare");
    const lost = await desktop.raw(...uncertain);
    expect(lost.code).toBe(1);
    expect(lost.stderr).toContain("did not confirm");
    const committed = (await linux.state()).workspaces.filter(
      ({ name }) => name === "Reply lost once",
    );
    expect(committed).toHaveLength(1);
    await expect
      .poll(() =>
        desktop.page.evaluate(async () => {
          const state = await window.cod.invoke<AppState>({ op: "state" });
          return state.remoteWorkspace?.connected;
        }),
      )
      .toBe(false);
    const retry = await desktop.cli<{ id: string }>(...uncertain);
    expect(retry.id).toBe(committed[0]!.id);
    await expect(header()).toHaveText("Reply lost once (invented-linux)");
    expect(
      (await linux.state()).workspaces.filter(
        ({ name }) => name === "Reply lost once",
      ),
    ).toHaveLength(1);

    for (let attempt = 0; attempt < 2; attempt++)
      await linux.cli("workspace", "create", "--name", "Ambiguous task");
    const ambiguous = await desktop.raw(...prepare("linux", "Ambiguous task"));
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain("More than one workspace");
    await expect(header()).toHaveText("Reply lost once (invented-linux)");

    const hosted = await linux.newChat(prepared.id, "codex");
    await linux.send(hosted.id, "[hold] Invented Linux task");
    await expect
      .poll(async () => (await linux.inspect(hosted.id)).status)
      .toBe("working");
    await focusWorkspace("Linux task");
    await expect(header()).toHaveText("Linux task (invented-linux)");
    const destination = await linux.cli<{ id: string }>(
      ...prepare("linux", "Moved Linux chat", [linux.folders[1]]),
      "--conversation",
      hosted.id,
    );
    await expect(header()).toHaveText("Moved Linux chat (invented-linux)");
    await expect(desktop.pane(hosted.paneId)).toBeVisible();
    expect(await context(linux, hosted.id)).toMatchObject({
      location: "linux",
      workspace: { id: destination.id, folders: [linux.folders[1]] },
      conversation: { nativeId: hosted.nativeId, cwd: linux.folders[0] },
    });
    expect(await linux.inspect(hosted.id)).toMatchObject({
      paneId: hosted.paneId,
      nativeId: hosted.nativeId,
      status: "working",
      messages: expect.arrayContaining([
        expect.objectContaining({ text: "[hold] Invented Linux task" }),
      ]),
    });
    expect((await linux.cli<AppState>("state")).conversations).toHaveLength(1);

    // A Linux origin can only follow within that host. When the user has
    // already navigated back to the desktop, the remote follow stays there.
    await focusWorkspace("Desktop intake");
    await expect(header()).toHaveText("Desktop intake");
    await linux.cli(
      ...prepare("linux", "Background Linux task"),
      "--conversation",
      hosted.id,
    );
    const movedAgain = await context(linux, hosted.id);
    expect(movedAgain.workspace.id).not.toBe(destination.id);
    await expect(header()).toHaveText("Desktop intake");
    const crossHost = await linux.raw(
      ...prepare("local", "Forbidden desktop task"),
    );
    expect(crossHost.code).toBe(1);
    expect(crossHost.stderr).toContain("runs on the Linux workspace host");
    expect(
      (await desktop.cli<AppState>("state")).conversations.map(({ id }) => id),
    ).toEqual([origin.id]);
    expect(await desktop.inspect(origin.id)).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ text: "Invented desktop task request" }),
      ]),
    });
  } finally {
    try {
      await desktop.cleanup();
    } finally {
      host.kill("SIGTERM");
      await exited;
      await linux.cleanup();
    }
  }
});

test("Default task host applies from either selected workspace and fails without local fallback", async ({}, info) => {
  test.skip(
    process.platform !== "linux",
    "The production workspace host runs on Linux",
  );
  test.setTimeout(60_000);
  const desktop = new ChatApp();
  const linux = new ChatApp();
  await desktop.prepare();
  await linux.prepare();
  linux.socket = path.join(linux.data, "cod.sock");
  linux.environment.COD_SOCKET_PATH = linux.socket;

  let host: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  const startHost = async () => {
    host = spawn(process.execPath, ["dist/workspace-host.cjs", linux.data], {
      env: linux.environment,
      stdio: "ignore",
    });
    exited = once(host, "exit");
    await expect
      .poll(async () => (await linux.raw("capabilities")).code)
      .toBe(0);
  };
  const stopHost = async () => {
    host?.kill("SIGTERM");
    await exited;
    host = undefined;
  };
  const prepare = (name: string) => ["workspace", "prepare", "--name", name];
  const header = () =>
    desktop.page.getByRole("button", { name: "Overview", exact: true });
  const desktopState = () =>
    desktop.page.evaluate(() => window.cod.invoke<AppState>({ op: "state" }));
  const openSetting = async () => {
    await desktop.page.keyboard.press(`${modifier}+,`);
    const dialog = desktop.page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    const search = dialog.getByRole("searchbox", {
      name: "Search settings",
      exact: true,
    });
    await search.fill("default task host");
    const group = dialog.getByRole("region", {
      name: "Workspaces settings",
      exact: true,
    });
    const choice = group.getByRole("combobox", {
      name: "Workspaces Default task host",
      exact: true,
    });
    const reset = group.getByRole("button", {
      name: "Reset Workspaces Default task host",
      exact: true,
    });
    await search.press("Tab");
    await expect(choice).toBeFocused();
    return { dialog, choice, reset };
  };
  const expectHost = (value: string) =>
    expect
      .poll(
        async () =>
          (
            await desktop.cli<{ values: Record<string, string> }>(
              "settings",
              "get",
            )
          ).values["workspace.defaultHost"],
      )
      .toBe(value);

  try {
    await desktop.start();
    const intake = await desktop.cli<{ id: string; location: string }>(
      ...prepare("Desktop intake"),
    );
    expect(intake.location).toBe("local");
    await expect(header()).toHaveText("Desktop intake");
    const setting = await openSetting();
    await expect(setting.choice.locator("option:checked")).toHaveText("Local");
    await expect(setting.reset).toBeHidden();
    await desktop.page.setViewportSize({ width: 1280, height: 800 });
    await desktop.page.screenshot({
      path: info.outputPath("default-task-host-local.png"),
    });
    await setting.choice.selectOption("linux");
    await expectHost("linux");
    await expect(setting.choice.locator("option:checked")).toHaveText("Linux");
    await expect(setting.reset).toBeEnabled();
    await desktop.page.setViewportSize({ width: 390, height: 650 });
    const controlBounds = await setting.choice.boundingBox();
    const dialogBounds = await setting.dialog.boundingBox();
    expect(controlBounds!.x + controlBounds!.width).toBeLessThanOrEqual(
      dialogBounds!.x + dialogBounds!.width,
    );
    await desktop.page.screenshot({
      path: info.outputPath("default-task-host-linux-narrow.png"),
    });
    await setting.dialog
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await desktop.page.setViewportSize({ width: 1280, height: 800 });

    const missing = await desktop.raw(...prepare("Missing host task"));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      "Connect to a Linux workspace from Commands",
    );
    const invalid = await desktop.raw(
      ...prepare("Invalid host task"),
      "--location",
      "remote",
    );
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("location must be local or linux");
    expect(
      (await desktop.state()).workspaces.map(({ name }) => name),
    ).not.toContain("Missing host task");
    const localPane = (await desktop.workspace(intake.id)).activePaneId;
    const composer = desktop
      .pane(localPane)
      .getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Invented unsent local draft");
    await expect
      .poll(
        async () =>
          (await desktopState()).workspaces.find(
            (workspace) => workspace.id === intake.id,
          )?.chatDrafts?.[localPane]?.text,
      )
      .toBe("Invented unsent local draft");
    await composer.press(`${modifier}+n`);
    await expect
      .poll(async () => (await desktop.workspace(intake.id)).activePaneId)
      .not.toBe(localPane);
    await expect(header()).toHaveText("Desktop intake");

    await startHost();
    await installWorkspaceRelay(desktop);
    await connectWorkspace(desktop, linux.socket);
    await desktop.stop();
    await desktop.start();
    await expectHost("linux");
    expect((await desktopState()).remoteWorkspace).toBeUndefined();
    await expect(header()).toHaveText("Desktop intake");
    await installWorkspaceRelay(desktop);

    const first = await desktop.cli<{
      id: string;
      location: string;
      folders: string[];
    }>(
      ...prepare("Linux from desktop"),
      "--folders",
      JSON.stringify([linux.folders[0]]),
    );
    expect(first).toMatchObject({
      location: "linux",
      folders: [linux.folders[0]],
    });
    await expect(header()).toHaveText("Linux from desktop (invented-linux)");
    expect((await linux.workspace(first.id)).name).toBe("Linux from desktop");
    const linuxPane = (await linux.workspace(first.id)).activePaneId;
    await desktop.page.keyboard.press(`${modifier}+n`);
    await expect
      .poll(async () => (await linux.workspace(first.id)).activePaneId)
      .not.toBe(linuxPane);
    await expect(header()).toHaveText("Linux from desktop (invented-linux)");

    const second = await desktop.cli<{ id: string; location: string }>(
      ...prepare("Linux from Linux view"),
    );
    expect(second.location).toBe("linux");
    await expect(header()).toHaveText("Linux from Linux view (invented-linux)");
    expect((await linux.workspace(second.id)).name).toBe(
      "Linux from Linux view",
    );
    const direct = await linux.cli<{ id: string; location: string }>(
      ...prepare("Direct Linux"),
    );
    expect(direct.location).toBe("linux");
    expect((await linux.workspace(direct.id)).name).toBe("Direct Linux");

    const local = await desktop.cli<{ id: string; location: string }>(
      ...prepare("Explicit local task"),
      "--location",
      "local",
    );
    expect(local.location).toBe("local");
    await expect(header()).toHaveText("Explicit local task");
    await expectHost("linux");
    await stopHost();
    await expect
      .poll(async () => (await desktopState()).remoteWorkspace?.connected)
      .toBe(false);

    const unavailable = await desktop.raw(...prepare("Recover on Linux"));
    expect(unavailable.code).toBe(1);
    const error = JSON.parse(unavailable.stderr) as { error: string };
    expect(error.error).toContain(
      'Could not connect to the Linux workspace host "invented-linux"',
    );
    await expect(header()).toHaveText("Explicit local task");
    const localNames = (await desktop.state()).workspaces.map(
      ({ name }) => name,
    );
    expect(localNames).not.toContain("Linux from desktop");
    expect(localNames).not.toContain("Linux from Linux view");
    expect(localNames).not.toContain("Recover on Linux");

    await startHost();
    const recovered = await desktop.cli<{ id: string; location: string }>(
      ...prepare("Recover on Linux"),
    );
    expect(recovered.location).toBe("linux");
    await expect(header()).toHaveText("Recover on Linux (invented-linux)");
    expect((await linux.workspace(recovered.id)).name).toBe("Recover on Linux");
    const reopened = await openSetting();
    await expect(reopened.choice).toHaveValue("linux");
    await reopened.reset.click();
    await expectHost("local");
    await expect(reopened.choice).toHaveValue("local");
    await expect(reopened.reset).toBeHidden();
    await expect(header()).toHaveText("Recover on Linux (invented-linux)");
    await reopened.dialog
      .getByRole("button", { name: "Close", exact: true })
      .click();
    const reset = await desktop.cli<{ location: string }>(
      ...prepare("Local after reset"),
    );
    expect(reset.location).toBe("local");
    await expect(header()).toHaveText("Local after reset");
  } finally {
    try {
      await desktop.cleanup();
    } finally {
      await stopHost();
      await linux.cleanup();
    }
  }
});

test("Desktop connects by SSH alias from Commands and codctl, then reconnects to the same host", async ({}, info) => {
  test.skip(process.platform !== "linux", "The workspace host requires Linux");
  test.setTimeout(70_000);
  const desktop = new ChatApp();
  const linux = new ChatApp();
  await desktop.prepare();
  await linux.prepare();
  linux.socket = path.join(linux.data, "cod.sock");
  linux.environment.COD_SOCKET_PATH = linux.socket;
  const host = spawn(
    process.execPath,
    ["dist/workspace-host.cjs", linux.data],
    { env: linux.environment, stdio: "ignore" },
  );
  const exited = once(host, "exit");
  const title = () =>
    desktop.page.getByRole("button", { name: "Overview", exact: true });
  const dialog = () =>
    desktop.page.getByRole("dialog", { name: "Connect to Linux workspace" });
  const alias = () => dialog().getByRole("textbox", { name: "SSH host alias" });
  const connect = () =>
    dialog().getByRole("button", { name: "Connect", exact: true });
  const openDialog = () => desktop.command("Connect to Linux workspace");
  const focusLocal = async () => {
    await desktop.overview();
    await desktop.row("Desktop source").click();
    await expect(title()).toHaveText("Desktop source");
  };
  const savedTarget = path.join(desktop.data, "workspace-host.json");

  try {
    await expect
      .poll(async () => (await linux.raw("capabilities")).code)
      .toBe(0);
    const remote = await linux.cli<{ id: string }>(
      "workspace",
      "prepare",
      "--name",
      "Linux fixture",
    );
    const localCapabilities = await linux.cli<{ operations: string[] }>(
      "capabilities",
    );
    expect(localCapabilities.operations).not.toContain("workspace.connect");
    await desktop.start();
    const desktopCapabilities = await desktop.cli<{ operations: string[] }>(
      "capabilities",
    );
    expect(desktopCapabilities.operations).toContain("workspace.connect");
    await installWorkspaceRelay(desktop, undefined, linux.socket);
    const source = await desktop.create("Desktop source");
    const paneId = (await desktop.workspace(source)).activePaneId;
    const composer = () =>
      desktop
        .pane(paneId)
        .getByRole("textbox", { name: "Message", exact: true });
    await desktop.page.getByRole("button", { name: "Not now" }).click();
    await composer().fill("Invented local draft");

    await desktop.cli(
      "settings",
      "update",
      "--values",
      JSON.stringify({ "ui.fontSize": 13 }),
    );
    await expect(desktop.page.locator("html")).toHaveCSS("font-size", "13px");
    await openDialog();
    await expect(alias()).toBeFocused();
    const socket = () =>
      dialog().getByRole("textbox", { name: "Linux socket path (optional)" });
    await expect(socket()).toHaveCount(0);
    await alias().fill("invented-linux");
    await desktop.page.screenshot({
      path: info.outputPath("ssh-alias-connection.png"),
    });
    await alias().press("Tab");
    const options = dialog().getByText("Connection options", { exact: true });
    await expect(options).toBeFocused();
    await options.press("Enter");
    await expect(socket()).toBeVisible();
    await options.press("Enter");
    await expect(socket()).toHaveCount(0);

    await desktop.app!.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(760, 650);
    });
    await expect.poll(() => desktop.page.evaluate(() => innerWidth)).toBe(760);
    await alias().fill("missing-linux");
    await connect().click();
    await expect(
      dialog().getByText(
        'Set up the Cod workspace host on "missing-linux" first.',
        { exact: false },
      ),
    ).toBeVisible();
    await expect(title()).toHaveText("Desktop source");
    await expect(readFile(savedTarget, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await desktop.page.screenshot({
      path: info.outputPath("ssh-alias-narrow-error.png"),
    });

    await alias().fill("waiting-linux");
    await connect().click();
    await expect(connect()).toBeDisabled();
    await alias().press("Escape");
    await expect(dialog()).toHaveCount(0);
    await expect(composer()).toBeFocused();
    await expect(composer()).toHaveValue("Invented local draft");
    await expect(readFile(savedTarget, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await openDialog();
    await alias().fill("invented-linux");
    await alias().press("Enter");
    await expect(dialog()).toHaveCount(0);
    await expect(title()).toHaveText("Linux fixture (invented-linux)");
    expect(JSON.parse(await readFile(savedTarget, "utf8"))).toEqual({
      alias: "invented-linux",
    });

    const invalid = await desktop.raw(
      "workspace",
      "connect",
      "--alias",
      "invalid-linux",
    );
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain(
      "The Linux workspace host returned an invalid endpoint",
    );
    await expect(title()).toHaveText("Linux fixture (invented-linux)");
    expect(JSON.parse(await readFile(savedTarget, "utf8"))).toEqual({
      alias: "invented-linux",
    });

    // Pause after the new alias has been written to a private staging file,
    // then cancel before it can replace the remembered and displayed host.
    await desktop.app!.evaluate(() => {
      const files = process.getBuiltinModule(
        "node:fs/promises",
      ) as typeof import("node:fs/promises");
      const write = files.writeFile;
      files.writeFile = async (...args) => {
        await write(...args);
        if (!/workspace-host\.json\..+\.tmp$/.test(String(args[0]))) return;
        files.writeFile = write;
        await new Promise<void>((done) =>
          process.once("cod-test-release-staged-workspace-target", done),
        );
      };
    });
    const pendingSelections = async () =>
      (await readdir(desktop.data)).filter((name) =>
        /^workspace-host\.json\..+\.tmp$/.test(name),
      );
    await openDialog();
    await alias().fill("replacement-linux");
    await connect().click();
    await expect.poll(pendingSelections).toHaveLength(1);
    await alias().press("Escape");
    await expect(dialog()).toHaveCount(0);
    await desktop.app!.evaluate(() =>
      process.emit("cod-test-release-staged-workspace-target"),
    );
    await expect.poll(pendingSelections).toHaveLength(0);
    await expect(title()).toHaveText("Linux fixture (invented-linux)");
    expect(JSON.parse(await readFile(savedTarget, "utf8"))).toEqual({
      alias: "invented-linux",
    });

    await desktop.command("Disconnect Linux workspace");
    await focusLocal();
    const connectResult = await desktop.cli(
      "workspace",
      "connect",
      "--alias",
      "invented-linux",
    );
    expect(connectResult).toEqual({
      alias: "invented-linux",
      workspaceId: remote.id,
      reviewAccess: false,
    });
    await expect(title()).toHaveText("Linux fixture (invented-linux)");
    // Use the raw ordinary socket to exercise the main-process trust boundary
    // directly, independently of the CLI grammar rejecting the reserved flag.
    expect(
      await invokeCommand(desktop.socket, {
        op: "workspace.connect",
        alias: "invented-linux",
        publicKey: "/invented/explicit-pairing-key.pub",
      }),
    ).toMatchObject({ reviewAccess: false });
    expect(JSON.parse(await readFile(savedTarget, "utf8"))).toEqual({
      alias: "invented-linux",
    });
    await focusLocal();
    const prepared = await desktop.cli<{ id: string; location: string }>(
      "workspace",
      "prepare",
      "--name",
      "Remote task from non-General",
      "--location",
      "linux",
    );
    expect(prepared.location).toBe("linux");
    expect((await linux.workspace(prepared.id)).name).toBe(
      "Remote task from non-General",
    );
    await expect(title()).toHaveText(
      "Remote task from non-General (invented-linux)",
    );

    await desktop.stop();
    await desktop.start();
    await installWorkspaceRelay(desktop, undefined, linux.socket);
    await expect(title()).toHaveText("Desktop source");
    await desktop.command("Reconnect to Linux workspace");
    await expect(title()).toHaveText(
      "Remote task from non-General (invented-linux)",
    );
    await desktop.command("Disconnect Linux workspace");
    expect(await desktop.cli("workspace", "reconnect")).toEqual({
      alias: "invented-linux",
      workspaceId: prepared.id,
      reviewAccess: false,
    });
    await expect(title()).toHaveText(
      "Remote task from non-General (invented-linux)",
    );
    await focusLocal();
    await expect(composer()).toHaveValue("Invented local draft");
  } catch (error) {
    await desktop.page.screenshot({
      path: info.outputPath("ssh-alias-failure.png"),
    });
    throw error;
  } finally {
    await desktop.cleanup();
    host.kill("SIGTERM");
    await exited;
    await linux.cleanup();
  }
});

test("Linux connection keeps the native browser context and aligns dialog actions", async ({}, info) => {
  const desktop = new ChatApp();
  await desktop.prepare();
  try {
    await desktop.start();
    await writeFile(
      path.join(desktop.data, "workspace-host.json"),
      JSON.stringify({ alias: "saved-linux", socketPath: "/tmp/saved.sock" }),
    );
    await desktop.app!.evaluate(({ ipcMain }) => {
      const channel = "cod:invoke";
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<
            string,
            (
              event: Electron.IpcMainInvokeEvent,
              request: { op: string },
            ) => unknown
          >;
        }
      )._invokeHandlers;
      const original = handlers.get(channel)!;
      ipcMain.removeHandler(channel);
      const gate = new Promise<void>((resolve) => {
        process.once("cod-test-release-remote-target", resolve);
      });
      ipcMain.handle(channel, async (event, request) => {
        const result = await original(event, request);
        if (request.op === "remote.target") await gate;
        return result;
      });
    });
    const workspace = await desktop.create("Invented browser workspace");
    const fixture = path.join(desktop.folders[0], "connection-context.html");
    await writeFile(
      fixture,
      `<!doctype html><title>Invented connection page</title>
       <style>body {background:#147dc1;height:250vh}
       input {position:fixed;left:12px;top:12px}</style>
       <input value="Invented native draft">
       <script>
         window.clicks = 0;
         addEventListener("click", () => window.clicks++);
       </script>`,
    );
    const url = pathToFileURL(fixture).href;
    const browser = await desktop.cli<{ id: string; paneId: string }>(
      "browser",
      "open",
      "--workspace",
      workspace,
      "--url",
      url,
    );
    const nativePage = () =>
      desktop
        .app!.context()
        .pages()
        .find((page) => page.url() === url);
    await expect.poll(() => !!nativePage()).toBe(true);
    const site = nativePage()!;
    await site.evaluate(() => window.scrollTo(0, 240));
    await site.locator("input").focus();
    await site.locator("input").evaluate((input: HTMLInputElement) => {
      input.setSelectionRange(3, 11);
    });

    const palette = desktop.page.getByRole("dialog", {
      name: "Command palette",
    });
    const dialog = desktop.page.getByRole("dialog", {
      name: "Connect to Linux workspace",
    });
    const backdrop = desktop
      .pane(browser.paneId)
      .locator(".browser-overview-backdrop");
    const openNativeCommands = () =>
      desktop.app!.evaluate(({ webContents }, fixtureUrl) => {
        const contents = webContents
          .getAllWebContents()
          .find((wc) => wc.getURL() === fixtureUrl)!;
        contents.focus();
        const modifiers: ("meta" | "control" | "shift")[] = [
          process.platform === "darwin" ? "meta" : "control",
          "shift",
        ];
        contents.sendInputEvent({ type: "keyDown", keyCode: "P", modifiers });
        contents.sendInputEvent({ type: "keyUp", keyCode: "P", modifiers });
      }, url);
    const filter = palette.getByRole("textbox", { name: "Filter commands" });
    const openConnection = palette.getByRole("button", {
      name: "Connect to Linux workspace",
      exact: true,
    });
    for (const width of [1280, 760]) {
      await desktop.app!.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0].setContentSize(size, 700);
      }, width);
      await expect
        .poll(() => desktop.page.evaluate(() => innerWidth))
        .toBe(width);
      if (width === 760) {
        await desktop.cli(
          "settings",
          "update",
          "--values",
          JSON.stringify({ "ui.fontSize": 20 }),
        );
        await expect(desktop.page.locator("html")).toHaveCSS(
          "font-size",
          "20px",
        );
      }
      await openNativeCommands();
      await expect(filter).toBeFocused();
      await expect(backdrop).not.toBeVisible();
      await filter.fill("Connect to Linux workspace");
      if (width === 1280) await filter.press("Enter");
      else await openConnection.click();
      const alias = dialog.getByRole("textbox", { name: "SSH host alias" });
      const cancel = dialog.getByRole("button", { name: "Cancel" });
      const connect = dialog.getByRole("button", {
        name: "Connect",
        exact: true,
      });
      await expect(alias).toBeFocused();
      const socket = dialog.getByRole("textbox", {
        name: "Linux socket path (optional)",
        includeHidden: true,
      });
      if (width === 1280) {
        await expect(backdrop).toBeVisible();
        await expect(socket).toHaveValue("");
        await alias.fill("typed-linux");
        await desktop.app!.evaluate(() =>
          process.emit("cod-test-release-remote-target"),
        );
        await expect(socket).toHaveValue("");
        await expect(alias).toHaveValue("typed-linux");
        await alias.fill("saved-linux");
        await expect(socket).toHaveValue("/tmp/saved.sock");
      } else {
        await expect(alias).toHaveValue("saved-linux");
        await expect(socket).toHaveValue("/tmp/saved.sock");
      }
      await expect(cancel.locator("kbd")).toHaveText("Esc");
      await expect(connect.locator("kbd")).toHaveText("Enter");
      const geometry = await dialog.evaluate((element) => ({
        fits: element.scrollWidth === element.clientWidth,
        actions: [...element.querySelectorAll(".ui-dialog-actions button")].map(
          (button) => {
            const label = document.createRange();
            label.selectNode(button.firstChild!);
            const buttonRect = button.getBoundingClientRect();
            const labelRect = label.getBoundingClientRect();
            const hintRect = button
              .querySelector("kbd")!
              .getBoundingClientRect();
            return {
              top: buttonRect.top,
              height: buttonRect.height,
              labelCenter:
                labelRect.top - buttonRect.top + labelRect.height / 2,
              hintCenter: hintRect.top - buttonRect.top + hintRect.height / 2,
              outlined:
                getComputedStyle(button).borderTopColor !== "rgba(0, 0, 0, 0)",
            };
          },
        ),
      }));
      await info.attach(`dialog-geometry-${width}.json`, {
        body: JSON.stringify(geometry),
        contentType: "application/json",
      });
      expect(geometry.fits).toBe(true);
      const [cancelBox, connectBox] = geometry.actions;
      expect(cancelBox.top).toBe(connectBox.top);
      expect(cancelBox.height).toBe(connectBox.height);
      expect(cancelBox.outlined).toBe(false);
      for (const button of geometry.actions) {
        expect(Math.abs(button.labelCenter - button.height / 2)).toBeLessThan(
          2,
        );
        expect(Math.abs(button.hintCenter - button.height / 2)).toBeLessThan(2);
      }
      await expect(backdrop).toBeVisible();
      const imageUrl = await backdrop.evaluate(
        (image: HTMLImageElement) => image.src,
      );
      await expect
        .poll(() =>
          backdrop.evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBeGreaterThan(0);
      const box = (await backdrop.boundingBox())!;
      const sample = {
        x: Math.floor(box.x + 20),
        y: Math.floor(box.y + box.height - 20),
      };
      await expect
        .poll(() =>
          desktop.app!.evaluate(
            async (
              { BrowserWindow, WebContentsView },
              { point, fixtureUrl },
            ) => {
              const window = BrowserWindow.getAllWindows()[0];
              const view = window.contentView.children.find(
                (child) =>
                  child instanceof WebContentsView &&
                  child.webContents.getURL() === fixtureUrl,
              );
              const image = await window.webContents.capturePage({
                ...point,
                width: 1,
                height: 1,
              });
              const [blue, green, red] = image.toBitmap();
              return {
                nativeVisible: view?.getVisible(),
                bluePage: blue > green + 20 && green > red + 40,
              };
            },
            { point: sample, fixtureUrl: url },
          ),
        )
        .toEqual({ nativeVisible: false, bluePage: true });
      await desktop.page.screenshot({
        path: info.outputPath(`linux-connect-${width}.png`),
      });
      await desktop.page.mouse.click(sample.x, sample.y);
      await expect(dialog).toBeVisible();
      expect(
        await site.evaluate(
          () => (window as Window & { clicks?: number }).clicks,
        ),
      ).toBe(0);
      if (width === 1280) await alias.press("Escape");
      else await cancel.click();
      await expect(dialog).toHaveCount(0);
      await expect(backdrop).toHaveCount(0);
      expect(
        await desktop.page.evaluate(
          async (objectUrl) =>
            fetch(objectUrl).then(
              () => false,
              () => true,
            ),
          imageUrl,
        ),
      ).toBe(true);
      await expect
        .poll(() =>
          desktop.app!.evaluate(({ webContents }) =>
            webContents.getFocusedWebContents()?.getURL(),
          ),
        )
        .toBe(url);
      expect(
        await site.locator("input").evaluate((input: HTMLInputElement) => ({
          scroll: window.scrollY,
          start: input.selectionStart,
          end: input.selectionEnd,
        })),
      ).toEqual({ scroll: 240, start: 3, end: 11 });
    }

    // Delay a real native frame past cancellation and the next dialog opening.
    // A retired Commands session must never paint its frame in that dialog.
    await desktop.app!.evaluate(({ webContents }, fixtureUrl) => {
      const contents = webContents
        .getAllWebContents()
        .find((wc) => wc.getURL() === fixtureUrl)!;
      const capture = contents.capturePage.bind(contents);
      let release: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const control = { captured: false, release: release! };
      Object.assign(globalThis, { connectionBackdropTest: control });
      contents.capturePage = async (...args) => {
        contents.capturePage = capture;
        const frame = await capture(...args);
        control.captured = true;
        await gate;
        return frame;
      };
    }, url);
    await openNativeCommands();
    await expect(filter).toBeFocused();
    await expect
      .poll(() =>
        desktop.app!.evaluate(
          () =>
            (
              globalThis as unknown as {
                connectionBackdropTest: { captured: boolean };
              }
            ).connectionBackdropTest.captured,
        ),
      )
      .toBe(true);
    await filter.press("Escape");
    await expect(palette).toHaveCount(0);
    await desktop.command("Connect to Linux workspace");
    await expect(dialog).toBeVisible();
    await desktop.app!.evaluate(() =>
      (
        globalThis as unknown as {
          connectionBackdropTest: { release: () => void };
        }
      ).connectionBackdropTest.release(),
    );
    await desktop.page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    await expect(backdrop).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // A new connection may capture again, but navigation invalidates the old page.
    await openNativeCommands();
    await expect(filter).toBeFocused();
    await filter.fill("Connect to Linux workspace");
    await filter.press("Enter");
    await expect(backdrop).toBeVisible();
    const nextPage = path.join(desktop.folders[0], "connection-next.html");
    await writeFile(nextPage, "<title>Another invented page</title>");
    const nextUrl = pathToFileURL(nextPage).href;
    await desktop.cli(
      "browser",
      "navigate",
      "--id",
      browser.id,
      "--url",
      nextUrl,
    );
    await expect(backdrop).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    const emptyWorkspace = await desktop.create("Invented empty workspace");
    await desktop.cli(
      "browser",
      "open",
      "--workspace",
      emptyWorkspace,
      "--url",
      "about:blank",
    );
    const address = desktop.page.getByRole("combobox", { name: "Address" });
    await address.focus();
    await desktop.command("Connect to Linux workspace");
    await expect(dialog).toBeVisible();
    await expect(
      desktop.page.locator(".browser-overview-backdrop"),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(address).toBeFocused();
  } finally {
    await desktop.cleanup();
  }
});

test("Linux workspace reconnect preserves host files, Codex chat and a running terminal", async ({}) => {
  test.skip(
    process.platform !== "linux",
    "The production workspace host runs on Linux",
  );
  const desktop = new ChatApp();
  const linux = new ChatApp();
  let host: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  await desktop.prepare();
  await linux.prepare();
  await linux.configure({
    codex: {
      options: true,
      multipleModels: true,
      reasoningOptions: true,
      alternateReasoning: true,
      configuredDraftModel: "fixture-alternate",
      configuredDraftReasoning: "xhigh",
      draftOptionsCwd: linux.folders[0],
    },
  });
  try {
    linux.socket = path.join(linux.data, "cod.sock");
    linux.environment.COD_SOCKET_PATH = linux.socket;
    linux.environment.COD_TERMINAL_SHELL = "/bin/sh";
    linux.environment.COD_TERMINAL_ARGS = '["-i"]';
    linux.environment.HISTFILE = "/dev/null";
    host = spawn(process.execPath, ["dist/workspace-host.cjs", linux.data], {
      env: linux.environment,
      stdio: "ignore",
    });
    exited = once(host, "exit");
    await expect
      .poll(async () => (await linux.raw("capabilities")).code)
      .toBe(0);
    const workspace = (await linux.state()).activeWorkspaceId!;
    await linux.cli(
      "workspace",
      "rename",
      "--id",
      workspace,
      "--name",
      "Remote fixture",
    );
    await linux.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      linux.folders[0],
    );
    const { paneId: filePane } = await linux.cli<{ paneId: string }>(
      "file",
      "open",
      "--workspace",
      workspace,
      "--path",
      linux.file,
    );
    const terminal = await linux.cli<{
      id: string;
      paneId: string;
      pid: number;
    }>("terminal", "open", "--workspace", workspace, "--cwd", linux.folders[0]);
    const inspectTerminal = () =>
      linux.cli<{ pid: number; output: string }>(
        "terminal",
        "inspect",
        "--id",
        terminal.id,
      );
    const terminalPid = (await inspectTerminal()).pid;
    expect(terminalPid).toBeGreaterThan(0);

    await desktop.start();
    const local = await desktop.create("Local fixture");
    await desktop.command("New chat");
    const draft = desktop.page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await draft.fill("Unsaved desktop draft");
    const desktopCatalogs = async () =>
      (await desktop.records()).filter(
        ({ message }) => message?.method === "model/list",
      );
    await expect
      .poll(async () => (await desktopCatalogs()).length)
      .toBeGreaterThan(0);
    const localCatalogs = await desktopCatalogs();

    const dropReply = path.join(desktop.temporary, "drop-reply");
    await installWorkspaceRelay(desktop, dropReply);
    await connectWorkspace(desktop, linux.socket);
    const header = desktop.page.getByRole("button", {
      name: "Overview",
      exact: true,
    });
    await expect(header).toHaveText("Remote fixture (invented-linux)");

    await desktop.overview();
    await expect(desktop.row("Remote fixture")).toContainText("invented-linux");
    await desktop.page.keyboard.press("Escape");
    await desktop.page
      .getByRole("tab", { name: "spec.md", exact: true })
      .click();
    const editor = desktop.page.getByRole("textbox", {
      name: "File contents",
      exact: true,
    });
    await expect(editor).toHaveValue(
      "# Invented specification\n\nInitial text.\n",
    );
    await editor.fill("# Edited on the host\n");
    await editor.press(`${modifier}+s`);
    await expect
      .poll(() => readFile(linux.file, "utf8"))
      .toBe("# Edited on the host\n");
    expect(await readFile(desktop.file, "utf8")).toContain("Initial text.");

    await desktop.command("New chat");
    await expect(draft).toBeVisible();
    const remoteModel = desktop.page.getByRole("button", {
      name: "Model",
      exact: true,
    });
    const remoteEffort = desktop.page.getByRole("button", {
      name: "Reasoning effort",
      exact: true,
    });
    const choices = desktop.page.getByRole("dialog", {
      name: "Actions",
      exact: true,
    });
    await expect(remoteModel).toHaveText("Alternate fixture");
    await expect(remoteEffort).toHaveText("Extra high");
    expect(
      (await linux.records()).some(
        ({ message }) =>
          message?.method === "config/read" &&
          message.params?.cwd === linux.folders[0],
      ),
    ).toBe(true);
    await remoteModel.click();
    await choices
      .getByRole("button", { name: "Alternate fixture", exact: true })
      .click();
    await expect(remoteModel).toHaveText("Alternate fixture");
    await expect(remoteEffort).toHaveAttribute("aria-busy", "false");
    await remoteEffort.click();
    await choices
      .getByRole("button", { name: "Extra high", exact: true })
      .click();
    await expect(remoteEffort).toHaveText("Extra high");
    await expect(remoteEffort).toHaveAttribute("aria-busy", "false");
    expect((await linux.cli<AppState>("state")).conversations).toHaveLength(0);
    expect(await linux.prompts()).toHaveLength(0);
    expect(await desktopCatalogs()).toEqual(localCatalogs);
    const message = "Invented remote chat input";
    await draft.fill(message);
    await draft.press("Enter");
    await expect(
      desktop.page.getByText("DONE " + message, { exact: true }),
    ).toBeVisible();
    expect((await linux.prompts())[0].message?.params).toMatchObject({
      model: "fixture-alternate",
      effort: "xhigh",
    });
    expect((await desktop.raw("state")).stdout).not.toContain(message);
    expect((await linux.raw("state")).stdout).toContain(message);

    const hosted = (
      await linux.cli<{ conversations: Chat[] }>("state")
    ).conversations.find((conversation) =>
      conversation.messages.some((item) => item.text === message),
    )!;
    await expect
      .poll(async () => (await linux.inspect(hosted.id)).status)
      .toBe("ready");
    await linux.cli("conversation", "show", "--id", hosted.id);
    await desktop.overview();
    const completedRow = desktop.page.locator(
      `.overview-row[data-navigation-key="conversation:${hosted.id}"]`,
    );
    await expect(completedRow).toHaveAttribute("data-status", "ready");
    await completedRow.locator(".overview-item").click();
    await expect(draft).toBeFocused();
    await desktop.overview();
    await expect(completedRow).toHaveAttribute("data-status", "");
    await desktop.page.keyboard.press("Escape");

    await linux.send(hosted.id, "[hold] Another active Linux turn");
    await expect
      .poll(async () => (await linux.inspect(hosted.id)).status)
      .toBe("working");
    const followUp = "Unsent while the host is busy";
    await draft.fill(followUp);
    await draft.press("Enter");
    await expect(
      desktop.page.getByRole("status", { name: "Conversation status" }),
    ).toHaveText("Wait for the active or queued Codex work before sending");
    await expect(draft).toHaveValue(followUp);
    expect(
      (await linux.prompts()).map((record) => JSON.stringify(record)),
    ).not.toContainEqual(expect.stringContaining(followUp));
    await linux.cli("conversation", "interrupt", "--id", hosted.id);

    await expect
      .poll(async () => (await linux.inspect(hosted.id)).status)
      .toBe("ready");
    const admitted = "Accepted by the host before the connection dropped";
    await draft.fill(admitted);
    await writeFile(dropReply, "conversation.send");
    await draft.press("Enter");
    await expect(header).toHaveText(
      "Remote fixture (invented-linux, disconnected)",
    );
    await expect(draft).toHaveValue(admitted);
    const unknown = desktop.page.getByRole("status", {
      name: "Conversation status",
    });
    await expect(unknown).toContainText(
      "The Linux host did not confirm this message.",
    );
    await draft.press("Enter");
    await expect(draft).toHaveValue(admitted);
    const nextDraft = "A different draft typed while disconnected";
    await draft.fill(nextDraft);
    await desktop.command("Reconnect to Linux workspace");
    await expect(draft).toHaveValue(nextDraft);
    await expect(unknown).toBeHidden();
    await expect
      .poll(async () => (await linux.raw("state")).stdout)
      .toContain(nextDraft);
    await draft.press("Enter");
    await expect(
      desktop.page.getByText("DONE " + nextDraft, { exact: true }),
    ).toBeVisible();
    expect(
      (await linux.inspect(hosted.id)).messages.filter(
        (item) => item.role === "user" && item.text === admitted,
      ),
    ).toHaveLength(1);

    await desktop.overview();
    await desktop.row("Local fixture").click();
    await expect(header).toHaveText("Local fixture");
    await expect(draft).toHaveValue("Unsaved desktop draft");
    expect((await desktop.state()).activeWorkspaceId).toBe(local);

    await desktop.overview();
    await desktop.row("Remote fixture").click();
    await expect(header).toHaveText("Remote fixture (invented-linux)");
    await linux.cli(
      "terminal",
      "write",
      "--id",
      terminal.id,
      "--data",
      "stty -echo; while [ ! -e release-terminal ]; do sleep .05; done; printf '\\nINVENTED_RECONNECTED_PTY\\n'\n",
    );
    await desktop.app!.evaluate(() => process.emit("cod-test-stop-forward"));
    await expect(header).toHaveText(
      "Remote fixture (invented-linux, disconnected)",
    );
    await linux.cli(
      "file",
      "save",
      "--workspace",
      workspace,
      "--pane-id",
      filePane,
      "--content",
      "# Changed while disconnected\n",
      "--expected-content",
      "# Edited on the host\n",
    );
    await writeFile(path.join(linux.folders[0], "release-terminal"), "");
    await expect.poll(inspectTerminal).toEqual(
      expect.objectContaining({
        pid: terminalPid,
        output: expect.stringMatching(/\nINVENTED_RECONNECTED_PTY\r?\n/),
      }),
    );

    await desktop.command("Reconnect to Linux workspace");
    await expect(header).toHaveText("Remote fixture (invented-linux)");
    await desktop.overview();
    const remoteTerminal = desktop.page
      .getByRole("dialog", { name: "Overview", exact: true })
      .locator(
        `button.overview-item[data-navigation-key="terminal:${terminal.id}"]`,
      );
    await remoteTerminal.click();
    await expect(
      desktop
        .pane(terminal.paneId)
        .getByRole("region", { name: "Terminal output" }),
    ).toContainText("INVENTED_RECONNECTED_PTY");
    await desktop.page
      .getByRole("tab", { name: "spec.md", exact: true })
      .click();
    await expect(editor).toHaveValue("# Changed while disconnected\n");
  } finally {
    await desktop.cleanup();
    if (host?.exitCode === null) host.kill("SIGTERM");
    await exited;
    await linux.cleanup();
  }
});

test("Quick Terminal keeps independent Local and Linux PTYs through disconnect and workspace close", async ({}, info) => {
  test.skip(
    process.platform !== "linux",
    "The production workspace host requires Linux",
  );
  test.setTimeout(45_000);
  const desktop = new ChatApp();
  const linux = new ChatApp();
  await desktop.prepare();
  await linux.prepare();
  let host: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  const home = path.join(desktop.temporary, "local-home");
  await mkdir(home);
  for (const app of [desktop, linux]) {
    app.environment.COD_TERMINAL_SHELL = "/bin/sh";
    app.environment.COD_TERMINAL_ARGS = '["-i"]';
    app.environment.HISTFILE = "/dev/null";
  }
  desktop.environment.HOME = home;
  try {
    linux.socket = path.join(linux.data, "cod.sock");
    linux.environment.COD_SOCKET_PATH = linux.socket;
    host = spawn(process.execPath, ["dist/workspace-host.cjs", linux.data], {
      env: linux.environment,
      stdio: "ignore",
    });
    exited = once(host, "exit");
    await expect
      .poll(async () => (await linux.raw("capabilities")).code)
      .toBe(0);
    const workspace = (await linux.cli<AppState>("state")).activeWorkspaceId!;
    await linux.cli(
      "workspace",
      "rename",
      "--id",
      workspace,
      "--name",
      "Invented Linux workspace",
    );
    await linux.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      linux.folders[0],
    );
    const original = (await linux.cli<AppState>("state")).workspaces.find(
      (item) => item.id === workspace,
    )!;
    await desktop.start();
    const local = await desktop.create("Invented Local workspace");
    await installWorkspaceRelay(desktop);
    await connectWorkspace(desktop, linux.socket);
    const dialog = desktop.page.getByRole("dialog", { name: "Quick Terminal" });
    const input = dialog.getByRole("textbox", { name: "Terminal input" });
    const output = dialog.getByRole("region", { name: "Terminal output" });
    const select = dialog.getByRole("combobox", {
      name: "Quick Terminal host",
    });
    const toggle = () => desktop.page.keyboard.press("Control+Backquote");
    const inspect = (app: ChatApp, id: string) =>
      app.cli<{ id: string; pid: number; cwd: string; output: string }>(
        "terminal",
        "inspect",
        "--id",
        id,
      );
    const enter = async (line: string) => {
      await expect(input).toBeFocused();
      await desktop.page.keyboard.type(line);
      await input.press("Enter");
    };
    await toggle();
    await expect(input).toBeFocused();
    await expect(select).toHaveValue("linux");
    await expect(select.locator("selectedcontent")).toHaveText(
      "invented-linux",
    );
    expect(
      (await linux.cli<AppState>("state")).workspaces.find(
        (item) => item.id === workspace,
      ),
    ).toEqual(original);
    const remoteId = (await linux.cli<AppState>("state")).quickTerminals![0]!
      .id;
    const remote = await inspect(linux, remoteId);
    expect(remote.cwd).toBe(linux.folders[0]);
    await enter("printf 'SSH_QUICK_OUTPUT\\n'");
    await expect(output).toContainText("SSH_QUICK_OUTPUT");
    await desktop.page.screenshot({
      path: info.outputPath("quick-terminal-linux.png"),
    });

    await select.focus();
    await desktop.page.keyboard.press("Space");
    await expect
      .poll(() => select.evaluate((control) => control.matches(":open")))
      .toBe(true);
    await desktop.page.keyboard.press("ArrowUp");
    await desktop.page.keyboard.press("Enter");
    await expect(select).toHaveValue("local");
    await enter("printf 'LOCAL_QUICK_OUTPUT\\n'");
    await expect(output).toContainText("LOCAL_QUICK_OUTPUT");
    await expect(output).not.toContainText("SSH_QUICK_OUTPUT");
    const companionId = (
      await desktop.cli<AppState>("state")
    ).quickTerminals!.find(
      ({ id, workspaceId }) => workspaceId === workspace && id !== remoteId,
    )!.id;
    const companion = await inspect(desktop, companionId);
    expect(companion.cwd).toBe(home);
    await toggle();
    await expect(dialog).toHaveCount(0);
    await desktop.page.evaluate(
      (id) => window.cod.invoke({ op: "workspace.focus", id }),
      local,
    );
    await expect(desktop.page.locator("#workspace-selector")).toHaveText(
      "Invented Local workspace",
    );
    await toggle();
    await expect(dialog.getByText("Local", { exact: true })).toBeVisible();
    await expect(select).toHaveCount(0);
    await toggle();
    await desktop.page.evaluate(
      (id) => window.cod.invoke({ op: "workspace.focus", id }),
      workspace,
    );
    await expect(desktop.page.locator("#workspace-selector")).toHaveText(
      "Invented Linux workspace (invented-linux)",
    );
    await toggle();
    await expect(select).toHaveValue("local");
    await expect(output).toContainText("LOCAL_QUICK_OUTPUT");

    await select.selectOption("linux");
    await expect(output).toContainText("SSH_QUICK_OUTPUT");
    await desktop.app!.evaluate(() => process.emit("cod-test-stop-forward"));
    await expect(dialog.getByRole("status")).toContainText(
      "Disconnected from invented-linux",
    );
    await expect(output).toContainText("SSH_QUICK_OUTPUT");
    await desktop.page.screenshot({
      path: info.outputPath("quick-terminal-disconnected.png"),
    });
    await linux.cli(
      "terminal",
      "write",
      "--id",
      remoteId,
      "--data",
      "printf 'MISSED_QUICK_OUTPUT\\n'\n",
    );
    await select.selectOption("local");
    await enter("printf 'LOCAL_OFFLINE_OUTPUT\\n'");
    await expect(output).toContainText("LOCAL_OFFLINE_OUTPUT");
    expect((await inspect(desktop, companion.id)).pid).toBe(companion.pid);
    await select.selectOption("linux");
    await dialog
      .getByRole("button", { name: "Reconnect", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Reconnect", exact: true }),
    ).toHaveCount(0);
    await expect(output).toContainText("MISSED_QUICK_OUTPUT");
    expect((await inspect(linux, remote.id)).pid).toBe(remote.pid);
    await select.selectOption("local");
    await expect(output).toContainText("LOCAL_OFFLINE_OUTPUT");
    expect((await inspect(desktop, companion.id)).pid).toBe(companion.pid);
    await desktop.stop();
    await expect
      .poll(() => {
        try {
          process.kill(companion.pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
    expect((await inspect(linux, remote.id)).pid).toBe(remote.pid);
    const savedState = JSON.parse(
      await readFile(path.join(desktop.data, "state.json"), "utf8"),
    );
    expect(savedState).not.toHaveProperty("quickTerminals");

    await desktop.start();
    await installWorkspaceRelay(desktop);
    await desktop.command("Reconnect to Linux workspace");
    await expect(desktop.page.locator("#workspace-selector")).toHaveText(
      "Invented Linux workspace (invented-linux)",
    );
    const restarted = desktop.page.getByRole("dialog", {
      name: "Quick Terminal",
    });
    const newInput = restarted.getByRole("textbox", { name: "Terminal input" });
    const newSelect = restarted.getByRole("combobox", {
      name: "Quick Terminal host",
    });
    await toggle();
    await expect(newInput).toBeFocused();
    await expect(newSelect).toHaveValue("linux");
    await expect(
      restarted.getByRole("region", { name: "Terminal output" }),
    ).toContainText("MISSED_QUICK_OUTPUT");
    await newSelect.selectOption("local");
    await expect(newInput).toBeFocused();
    const restartedId = (
      await desktop.cli<AppState>("state")
    ).quickTerminals!.find(({ workspaceId }) => workspaceId === workspace)!.id;
    const restartedCompanion = await inspect(desktop, restartedId);
    expect(restartedCompanion.id).not.toBe(companion.id);
    await linux.cli("workspace", "close", "--id", workspace, "--force", "true");
    await expect(restarted).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await desktop.raw("terminal", "inspect", "--id", restartedId)).code,
      )
      .toBe(1);
    await expect
      .poll(
        async () =>
          (await linux.raw("terminal", "inspect", "--id", remote.id)).code,
      )
      .toBe(1);
    for (const pid of [remote.pid, restartedCompanion.pid])
      expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await desktop.cleanup();
    if (host?.exitCode === null) host.kill("SIGTERM");
    await exited;
    await linux.cleanup();
  }
});

test("Paired Linux review and approval preserve privacy, draft and exactly-once native feedback", async ({}) => {
  test.skip(
    process.platform !== "linux",
    "The production workspace host runs on Linux",
  );
  const desktop = new ChatApp();
  const linux = new ChatApp();
  let host: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  await desktop.prepare();
  await linux.prepare();
  try {
    linux.socket = path.join(linux.data, "cod.sock");
    linux.environment.COD_SOCKET_PATH = linux.socket;
    host = spawn(process.execPath, ["dist/workspace-host.cjs", linux.data], {
      env: linux.environment,
      stdio: "ignore",
    });
    exited = once(host, "exit");
    await expect
      .poll(async () => (await linux.raw("capabilities")).code)
      .toBe(0);
    const workspace = (await linux.state()).activeWorkspaceId!;
    await linux.cli(
      "workspace",
      "rename",
      "--id",
      workspace,
      "--name",
      "Remote review fixture",
    );
    const repo = linux.folders[0];
    const source = path.join(repo, "unified.txt");
    await writeFile(source, "header\nold anchor\nend\n");
    execFileSync("git", ["add", "unified.txt"], { cwd: repo });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "Invented baseline",
      ],
      { cwd: repo },
    );
    await writeFile(source, "header\nnew anchor\nend\n");
    await linux.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      repo,
    );
    const chat = await linux.newChat(workspace, "codex");
    const other = await linux.newChat(workspace, "codex");
    await linux.cli("conversation", "show", "--id", chat.id);
    const prompt = "Invented permission [approve]";
    await linux.send(chat.id, prompt);
    await expect
      .poll(async () => (await linux.inspect(chat.id)).status)
      .toBe("waiting");

    await desktop.start();
    const key = path.join(desktop.temporary, "invented-desktop");
    execFileSync("/usr/bin/ssh-keygen", [
      "-q",
      "-N",
      "",
      "-t",
      "ed25519",
      "-f",
      key,
    ]);
    const signer = path.join(linux.data, "desktop-signers");
    const pairedSigner =
      'cod-desktop namespaces="cod-review" ' +
      (await readFile(key + ".pub", "utf8"));
    await writeFile(signer, pairedSigner, { mode: 0o600 });
    const dropReply = path.join(desktop.temporary, "drop-next-submit");
    await installWorkspaceRelay(desktop, dropReply);
    const chatPane = desktop.pane(chat.paneId);
    await connectWorkspace(desktop, linux.socket);
    await expect(
      chatPane.getByText("Pair this desktop to respond to the approval."),
    ).toBeVisible();
    await expect(
      chatPane.getByRole("button", { name: "Deny", exact: true }),
    ).toHaveCount(0);

    await connectWorkspace(desktop, linux.socket, key + ".pub");
    await chatPane.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(
      chatPane.getByText("DENIED " + prompt, { exact: true }),
    ).toBeVisible();
    await linux.send(chat.id, "[hold] Continue the same native turn");
    await expect(
      chatPane.getByRole("status", { name: "Turn activity", exact: true }),
    ).toContainText("Working");
    const liveFollowUp = "Changed direction from the paired desktop";
    const composer = chatPane.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.fill(liveFollowUp);
    await writeFile(dropReply, "conversation.send");
    await composer.press("Enter");
    const overview = desktop.page.getByRole("button", {
      name: "Overview",
      exact: true,
    });
    await expect(overview).toHaveText(
      "Remote review fixture (invented-linux, disconnected)",
    );
    await expect(
      chatPane.getByRole("status", { name: "Conversation status" }),
    ).toContainText("The Linux host did not confirm this message.");
    await expect(composer).toHaveValue(liveFollowUp);
    await composer.press("Enter");
    await desktop.command("Reconnect to Linux workspace");
    await expect(composer).toHaveValue("");
    await expect
      .poll(
        async () =>
          (await linux.records()).filter(
            (entry) => entry.message?.method === "turn/steer",
          ).length,
      )
      .toBe(1);
    expect(
      (await linux.inspect(chat.id)).messages.filter(
        (item) => item.role === "user" && item.text === liveFollowUp,
      ),
    ).toHaveLength(1);
    await linux.cli("conversation", "interrupt", "--id", chat.id);
    await expect
      .poll(async () => (await linux.inspect(chat.id)).status)
      .toBe("ready");

    const review = await linux.cli<{
      id: string;
      paneId: string;
      roundId: string;
    }>(
      "review",
      "open-diff",
      "--workspace",
      workspace,
      "--repo-root",
      repo,
      "--conversation",
      chat.id,
    );
    const reviewPane = desktop.pane(review.paneId);
    const addComment = async () => {
      await reviewPane
        .getByRole("button", { name: `Old line 2 ${source}`, exact: true })
        .focus();
      await desktop.page.keyboard.press(`${modifier}+Shift+M`);
      const input = reviewPane.getByRole("textbox", {
        name: "Comment",
        exact: true,
      });
      await expect(input).toBeFocused();
      return input;
    };
    const message = "Keep the invented old anchor in the design";
    const input = await addComment();
    await input.fill(message);
    await writeFile(signer, "");
    await input.press(`${modifier}+Enter`);
    await expect(
      reviewPane.getByText("Pair this desktop to open private review."),
    ).toBeVisible();
    expect((await linux.raw("state")).stdout).not.toContain(message);
    expect(await linux.prompts()).toHaveLength(2);

    await writeFile(signer, pairedSigner);
    await desktop.command("Reconnect to Linux workspace");
    await expect(input).toHaveValue(message);
    await input.press(`${modifier}+Enter`);
    await expect(
      reviewPane.getByLabel("Draft comment", { exact: true }),
    ).toContainText(message);
    expect(await linux.prompts()).toHaveLength(2);
    const beforeSubmit = await readUnpairedWatch(linux.socket);
    expect(JSON.stringify(beforeSubmit)).not.toContain(message);
    expect(
      beforeSubmit.reviews?.find((item) => item.id === review.id)?.rounds.at(-1)
        ?.commentCount,
    ).toBe(1);
    expect(
      (await linux.raw("review", "inspect", "--id", review.id)).stdout,
    ).not.toContain(message);

    await writeFile(dropReply, "review.submit");
    await reviewPane
      .getByRole("button", { name: "Send feedback", exact: true })
      .click();
    await expect(overview).toHaveText(
      "Remote review fixture (invented-linux, disconnected)",
    );
    await desktop.command("Reconnect to Linux workspace");
    await expect(overview).toHaveText("Remote review fixture (invented-linux)");
    await expect(
      reviewPane.getByLabel("Sent comment", { exact: true }),
    ).toContainText(message);
    await expect(
      reviewPane.getByRole("button", { name: "Send feedback", exact: true }),
    ).toHaveCount(0);
    await expect.poll(async () => (await linux.prompts()).length).toBe(3);
    expect(
      (await linux.inspect(chat.id)).messages.filter(
        (item) => item.role === "user" && item.text.includes(message),
      ),
    ).toHaveLength(1);
    const state = await readUnpairedWatch(linux.socket);
    expect(JSON.stringify(state.reviews)).not.toContain(message);
    expect(
      state.reviews?.find((item) => item.id === review.id)?.rounds.at(-1)
        ?.submission?.envelope,
    ).toBe("");
    expect((await linux.inspect(other.id)).messages).toHaveLength(0);
  } finally {
    await desktop.cleanup();
    if (host?.exitCode === null) host.kill("SIGTERM");
    await exited;
    await linux.cleanup();
  }
});
