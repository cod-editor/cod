import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChatApp, type Chat } from "./helpers/chat-fixture/harness";
import { modifier } from "./helpers/workspace-app";

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

    const forwarder = path.resolve("tests/e2e/helpers/unix-socket-forward.mjs");
    const stopForward = await desktop.app!.evaluate((_electron, fixture) => {
      const childProcess = process.getBuiltinModule(
        "node:child_process",
      ) as typeof import("node:child_process");
      const original = childProcess.spawn;
      let pid = 0;
      childProcess.spawn = ((
        command: string,
        args: string[],
        options: import("node:child_process").SpawnOptions,
      ) => {
        if (command !== "/usr/bin/ssh" || args.at(-1) !== "invented-linux") {
          return original(command, args, options);
        }
        const forward = args[args.indexOf("-L") + 1];
        const relay = original(process.execPath, [fixture, forward], {
          ...options,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        });
        pid = relay.pid!;
        return relay;
      }) as typeof original;
      process.on("cod-test-stop-forward", () => process.kill(pid, "SIGTERM"));
      return true;
    }, forwarder);
    expect(stopForward).toBe(true);

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
    await connect
      .getByRole("textbox", { name: "Linux socket path" })
      .fill(linux.socket);
    await connect.getByRole("button", { name: "Connect", exact: true }).click();
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
    const message = "Invented remote chat input";
    await draft.fill(message);
    await draft.press("Enter");
    await expect(
      desktop.page.getByText("DONE " + message, { exact: true }),
    ).toBeVisible();
    expect((await desktop.raw("state")).stdout).not.toContain(message);
    expect((await linux.raw("state")).stdout).toContain(message);

    const hosted = (
      await linux.cli<{ conversations: Chat[] }>("state")
    ).conversations.find((conversation) =>
      conversation.messages.some((item) => item.text === message),
    )!;
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
