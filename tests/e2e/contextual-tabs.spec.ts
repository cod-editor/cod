import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { modifier } from "./helpers/workspace-app";
import { ChatApp } from "./helpers/chat-fixture/harness";
import type { AppState } from "../../src/types";

let app: ChatApp, workspace: string;
test.beforeEach(async () => {
  app = new ChatApp();
  await app.prepare();
  await app.start();
  workspace = await app.create("Contextual tabs fixture");
  await app.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    app.folders[0],
  );
});
test.afterEach(async () => app.cleanup());
const state = async () => await app.cli<AppState>("state");
const editor = (id: string) =>
  app.pane(id).getByRole("textbox", { name: "File contents", exact: true });
async function untitled() {
  const result = await app.cli<{ paneId: string }>(
    "file",
    "new",
    "--workspace",
    workspace,
    "--focus",
    "true",
  );
  await expect(editor(result.paneId)).toBeEnabled();
  return result.paneId;
}

test("Untitled text keeps its identity, pin and content through group moves, close and restart", async () => {
  const id = await untitled();
  await editor(id).fill("Unsaved invented text\nSecond line");
  await expect
    .poll(
      async () =>
        (
          await app.cli<{ draft?: { content: string } }>(
            "file",
            "read",
            "--workspace",
            workspace,
            "--pane-id",
            id,
          )
        ).draft?.content,
    )
    .toBe("Unsaved invented text\nSecond line");
  await app.cli(
    "pane",
    "pin",
    "--workspace",
    workspace,
    "--id",
    id,
    "--pinned",
    "true",
  );
  const right = await app.cli<{ groupId: string }>(
    "group",
    "ensure",
    "--workspace",
    workspace,
    "--side",
    "right",
  );
  await app.cli(
    "pane",
    "move",
    "--workspace",
    workspace,
    "--id",
    id,
    "--group",
    right.groupId,
  );
  await expect(editor(id)).toHaveValue("Unsaved invented text\nSecond line");
  await app.cli("pane", "close", "--workspace", workspace, "--id", id);
  await expect(editor(id)).toBeVisible();
  await app.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    id,
    "--include-pinned",
    "true",
  );
  await app.cli("pane", "reopen", "--workspace", workspace);
  await expect(editor(id)).toHaveValue("Unsaved invented text\nSecond line");
  const next = await untitled();
  expect(next).not.toBe(id);
  const ws = (await state()).workspaces.find((w) => w.id === workspace)!;
  expect(ws.panes.find((p) => p.id === id)).toMatchObject({
    kind: "untitled",
    name: "Untitled 1",
    pinned: true,
  });
  expect(ws.panes.find((p) => p.id === next)).toMatchObject({
    kind: "untitled",
    name: "Untitled 2",
  });
  await app.stop();
  await app.start();
  await app.cli("pane", "focus", "--workspace", workspace, "--id", id);
  await expect(editor(id)).toHaveValue("Unsaved invented text\nSecond line");
});

test("Untitled Save As cancellation and a changed destination retain the buffer", async () => {
  const id = await untitled(),
    target = path.join(app.folders[0], "invented-save.txt");
  await editor(id).fill("Keep this buffer");
  await app.app!.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({
      canceled: true,
      filePath: "",
    });
  });
  await editor(id).press(`${modifier}+s`);
  await expect(editor(id)).toHaveValue("Keep this buffer");
  expect(
    (await state()).workspaces
      .find((w) => w.id === workspace)!
      .panes.find((p) => p.id === id)?.kind,
  ).toBe("untitled");
  await writeFile(target, "External text");
  const result = await app.cli<{ saved: boolean; conflict: boolean }>(
    "file",
    "save-as",
    "--workspace",
    workspace,
    "--pane-id",
    id,
    "--path",
    target,
    "--content",
    "Keep this buffer",
  );
  expect(result).toEqual({ saved: false, conflict: true });
  expect(await readFile(target, "utf8")).toBe("External text");
  await expect(editor(id)).toHaveValue("Keep this buffer");
});

test("New typing during an untitled save becomes a normal unsaved file revision", async () => {
  const id = await untitled(),
    target = path.join(app.folders[0], "invented-save.ts");
  await editor(id).fill("const before = 1;");
  await app.app!.evaluate(async ({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    const fs = process.getBuiltinModule("node:fs/promises")!,
      link = fs.link;
    Object.assign(globalThis, {
      fileWriteWaiting: false,
      fileWriteReleased: false,
    });
    fs.link = async (from, to) => {
      if (String(to) === target) {
        (globalThis as any).fileWriteWaiting = true;
        while (!(globalThis as any).fileWriteReleased)
          await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return link(from, to);
    };
  }, target);
  try {
    await editor(id).press(`${modifier}+s`);
    await expect
      .poll(() => app.app!.evaluate(() => (globalThis as any).fileWriteWaiting))
      .toBe(true);
    await editor(id).press("End");
    await editor(id).pressSequentially(" // newer");
    await expect(editor(id)).toHaveValue("const before = 1; // newer");
  } finally {
    await app.app!.evaluate(() => {
      (globalThis as any).fileWriteReleased = true;
    });
  }
  await expect
    .poll(
      async () =>
        (await state()).workspaces
          .find((w) => w.id === workspace)!
          .panes.find((p) => p.id === id)?.kind,
    )
    .toBe("document");
  await expect(editor(id)).toHaveValue("const before = 1; // newer");
  await expect(app.pane(id).locator(".pane-message")).toHaveCount(0);
  expect(await readFile(target, "utf8")).toBe("const before = 1;");
  await editor(id).evaluate((element) => {
    Object.assign(globalThis, { syntaxFrames: [] });
    element.addEventListener("input", () => {
      (globalThis as any).syntaxFrames.push(
        element
          .closest(".highlighted-editor")!
          .querySelectorAll(".hljs-keyword").length,
      );
    });
  });
  await editor(id).press("End");
  await editor(id).press("Enter");
  await editor(id).pressSequentially("const next = 2;");
  expect(
    await app.page.evaluate(() => (globalThis as any).syntaxFrames.at(-1)),
  ).toBe(2);
  await editor(id).press(`${modifier}+s`);
  await expect
    .poll(() => readFile(target, "utf8"))
    .toBe("const before = 1; // newer\nconst next = 2;");
  await app.stop();
  await app.start();
  await expect(editor(id)).toHaveValue(
    "const before = 1; // newer\nconst next = 2;",
  );
});

async function active() {
  return (await state()).workspaces.find((w) => w.id === workspace)!;
}
async function selectedAfter(source: string) {
  // Input dispatch does not await resource creation and its guarded pane.focus.
  // Wait for the observable selection before capturing the new tab's stable ID.
  await expect.poll(async () => (await active()).activePaneId).not.toBe(source);
  return (await active()).activePaneId;
}
const plus = (group: string) =>
  app.page.locator(`[data-group-id="${group}"] [data-action="new-tab"]`);
const menu = () =>
  app.page.getByRole("dialog", { name: "Actions", exact: true });

test("Plus chooses a type without creating a tab; cancellation returns focus and selected types stay in the source pane", async ({}, info) => {
  const id = await untitled();
  await editor(id).fill("Existing text");
  await editor(id).evaluate((input: HTMLTextAreaElement) =>
    input.setSelectionRange(2, 7),
  );
  await editor(id).press(`${modifier}+p`);
  await app.page
    .getByRole("dialog", { name: "Open file", exact: true })
    .getByRole("textbox", { name: "Open file", exact: true })
    .press("Escape");
  await expect(editor(id)).toBeFocused();
  expect(
    await editor(id).evaluate((input: HTMLTextAreaElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([2, 7]);
  const initial = await active(),
    group = initial.groups!.find((g) => g.paneIds.includes(id))!;
  await plus(group.id).focus();
  await plus(group.id).press("Enter");
  await expect(
    menu().getByRole("button", { name: "New file", exact: true }),
  ).toBeFocused();
  expect((await active()).panes).toHaveLength(initial.panes.length);
  await menu().screenshot({ path: info.outputPath("new-tab-type-menu.png") });
  await app.page.keyboard.press("Escape");
  await expect(plus(group.id)).toBeFocused();
  await plus(group.id).click();
  await app.page.keyboard.press("ArrowDown");
  await app.page.keyboard.press("Enter");
  const browserPane = await selectedAfter(id);
  await expect(
    app
      .pane(browserPane)
      .getByRole("textbox", { name: "Address", exact: true }),
  ).toBeFocused();
  expect(
    (await active()).panes.find((p) => p.id === browserPane),
  ).toMatchObject({ kind: "browser" });
  expect(
    (await active()).groups!.find((g) => g.id === group.id)!.paneIds,
  ).toContain(browserPane);
  await plus(group.id).click();
  await menu().getByRole("button", { name: "Chat", exact: true }).click();
  const chatPane = await selectedAfter(browserPane);
  await expect(
    app.pane(chatPane).getByRole("textbox", { name: "Message", exact: true }),
  ).toBeFocused();
  expect((await state()).conversations).toHaveLength(0);
  await plus(group.id).click();
  await menu().getByRole("button", { name: "Terminal", exact: true }).click();
  const terminalPane = await selectedAfter(chatPane);
  await expect(
    app.pane(terminalPane).locator(".xterm-helper-textarea"),
  ).toBeFocused();
  expect((await active()).groups).toHaveLength(initial.groups!.length);
  await plus(group.id).click();
  await menu()
    .getByRole("button", { name: "New file", exact: true })
    .press("Enter");
  const filePane = await selectedAfter(terminalPane);
  await expect(editor(filePane)).toBeFocused();
  await expect(editor(filePane)).toHaveValue("");
  expect((await active()).panes.find((p) => p.id === filePane)).toMatchObject({
    kind: "untitled",
  });
  expect(
    (await active()).groups!.find((g) => g.id === group.id)!.paneIds,
  ).toContain(filePane);
});

test("Contextual new file is blank, unpinned and adjacent while CLI creation leaves foreground selection unchanged", async () => {
  const source = await untitled();
  await editor(source).fill("Do not copy content");
  await app.cli(
    "pane",
    "pin",
    "--workspace",
    workspace,
    "--id",
    source,
    "--pinned",
    "true",
  );
  await editor(source).press(`${modifier}+t`);
  const child = await selectedAfter(source),
    current = await active();
  expect(child).not.toBe(source);
  expect(current.panes.find((p) => p.id === child)).toMatchObject({
    kind: "untitled",
  });
  expect(current.panes.find((p) => p.id === child)?.pinned).not.toBe(true);
  await expect(editor(child)).toBeFocused();
  await expect(editor(child)).toHaveValue("");
  const group = current.groups!.find((g) => g.paneIds.includes(source))!;
  expect(group.paneIds.indexOf(child)).toBe(group.paneIds.indexOf(source) + 1);
  const next = await app.cli<{ paneId: string }>(
    "pane",
    "new",
    "--workspace",
    workspace,
    "--same-as",
    source,
    "--group",
    group.id,
  );
  expect(next.paneId).not.toBe(child);
  expect((await active()).activePaneId).toBe(child);
  await expect(editor(child)).toBeFocused();
  await app.stop();
  await app.start();
  expect((await active()).panes.find((p) => p.id === next.paneId)?.kind).toBe(
    "untitled",
  );
});

test("Double click creates exactly one contextual tab only on free tab bar space", async () => {
  const source = await untitled(),
    group = (await active()).groups!.find((g) => g.paneIds.includes(source))!;
  await editor(source).fill("Preserve source");
  const tabs = app.page.locator(`[data-group-id="${group.id}"] .tabs`),
    box = await tabs.boundingBox();
  expect(box).not.toBeNull();
  const before = (await active()).panes.length;
  const point = { x: box!.width - 3, y: box!.height / 2 };
  await tabs.click({ position: point });
  expect((await active()).panes).toHaveLength(before);
  await tabs.dblclick({ position: point });
  await expect.poll(async () => (await active()).panes.length).toBe(before + 1);
  const child = await selectedAfter(source);
  await expect(editor(child)).toBeFocused();
  await expect(editor(child)).toHaveValue("");
  await app.page
    .locator(`[role="tab"][data-tab-id="${source}"] .tab-label`)
    .dblclick();
  expect((await active()).panes).toHaveLength(before + 1);
  await plus(group.id).dblclick();
  expect((await active()).panes).toHaveLength(before + 1);
});

test("Contextual terminal starts a fresh shell in the live directory after cd", async () => {
  const directory = path.join(app.folders[0], "nested folder \u03b1");
  await mkdir(directory);
  const terminal = await app.cli<{ id: string; paneId: string }>(
    "terminal",
    "open",
    "--workspace",
    workspace,
  );
  const input = app.pane(terminal.paneId).locator(".xterm-helper-textarea");
  await expect(input).toBeEnabled();
  await input.focus();
  // Real PTY input accepts Unicode paths; Playwright's per-key text driver does not.
  await app.cli(
    "terminal",
    "write",
    "--id",
    terminal.id,
    "--data",
    `cd '${directory}' && printf '__CD_READY__\\n'\r`,
  );
  await expect
    .poll(
      async () =>
        (
          await app.cli<{ output: string }>(
            "terminal",
            "inspect",
            "--id",
            terminal.id,
          )
        ).output,
    )
    .toContain("__CD_READY__\r\n");
  await input.press(`${modifier}+t`);
  await expect
    .poll(async () => (await active()).activePaneId)
    .not.toBe(terminal.paneId);
  const child = (await active()).activePaneId;
  await expect(app.pane(child).locator(".xterm-helper-textarea")).toBeFocused();
  const record = (await state()).terminals.find((t) => t.paneId === child)!;
  expect(record.id).not.toBe(terminal.id);
  expect(record.cwd).toBe(directory);
  expect(record.nativeConversationId).toBeUndefined();
  expect(
    (await state()).terminals.find((t) => t.id === terminal.id)?.status,
  ).toBe("running");
  await app.cli("terminal", "write", "--id", terminal.id, "--data", "exit\r");
  await expect
    .poll(
      async () =>
        (await state()).terminals.find((t) => t.id === terminal.id)?.status,
    )
    .toBe("exited");
  const fresh = await app.cli<{ paneId: string }>(
    "pane",
    "new",
    "--workspace",
    workspace,
    "--same-as",
    terminal.paneId,
  );
  expect(
    (await state()).terminals.find((t) => t.paneId === fresh.paneId)?.cwd,
  ).toBe(directory);
  expect((await active()).activePaneId).toBe(child);
});

for (const provider of ["codex", "kimi"] as const) {
  test(`Contextual ${provider} chat inherits selection without interrupting or copying the source`, async () => {
    await app.configure({
      [provider]: {
        options: true,
        multipleModels: true,
        reasoningOptions: true,
      },
    });
    const source = await app.newChat(workspace, provider);
    await app.cli(
      "conversation",
      "option",
      "--id",
      source.id,
      "--option",
      "model",
      "--value",
      provider === "codex" ? "fixture-model" : "fixture-alternate",
    );
    const options = await app.cli<{ reasoning: Array<{ value: string }> }>(
      "conversation",
      "options",
      "--id",
      source.id,
    );
    const reasoning = options.reasoning.at(-1)?.value;
    if (reasoning)
      await app.cli(
        "conversation",
        "option",
        "--id",
        source.id,
        "--option",
        "reasoning",
        "--value",
        reasoning,
      );
    const message = app
      .pane(source.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
    await message.fill("[approve] Source keeps working");
    await message.press("Enter");
    await expect
      .poll(async () => (await app.inspect(source.id)).status)
      .toBe("waiting");
    const records = await app.records();
    await message.press(`${modifier}+t`);
    const child = await selectedAfter(source.paneId);
    const input = app
      .pane(child)
      .getByRole("textbox", { name: "Message", exact: true });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("");
    expect((await state()).conversations).toHaveLength(1);
    expect((await app.inspect(source.id)).status).toBe("waiting");
    expect(
      (await app.records()).filter((r) => r.event === "started"),
    ).toHaveLength(records.filter((r) => r.event === "started").length);
    const draft = (await active()).chatDrafts![child];
    expect(draft.provider).toBe(provider);
    expect(draft.initialSelection).toMatchObject({
      model: provider === "codex" ? "fixture-model" : "fixture-alternate",
      ...(reasoning ? { reasoning } : {}),
    });
    await input.fill("Child request");
    await expect
      .poll(async () => (await active()).chatDrafts![child]?.text)
      .toBe("Child request");
    await app.stop();
    await app.start();
    const restoredInput = app
      .pane(child)
      .getByRole("textbox", { name: "Message", exact: true });
    await expect(restoredInput).toHaveValue("Child request");
    await restoredInput.press("Enter");
    await expect.poll(async () => (await state()).conversations.length).toBe(2);
    await expect.poll(async () => (await app.prompts()).length).toBe(2);
    const childChat = (await state()).conversations.find(
      (c) => c.paneId === child,
    )!;
    expect(childChat.nativeId).not.toBe(source.nativeId);
    await expect
      .poll(async () => (await app.inspect(childChat.id)).status)
      .toBe("ready");
    const childOptions = await app.cli<{
      current: Record<string, string>;
      pending?: Record<string, string>;
    }>("conversation", "options", "--id", childChat.id);
    expect({ ...childOptions.current, ...childOptions.pending }).toMatchObject({
      model: provider === "codex" ? "fixture-model" : "fixture-alternate",
      ...(reasoning ? { reasoning } : {}),
    });
    expect(
      childChat.messages.filter((m) => m.role === "user").map((m) => m.text),
    ).toEqual(["Child request"]);
  });
}

test("Native Save As chooses a real path and cancellation preserves the selected buffer", async ({}, info) => {
  test.skip(
    process.platform !== "linux",
    "Native chooser automation runs only on isolated X11",
  );
  const execute = promisify(execFile),
    id = await untitled(),
    target = path.join(app.folders[0], "saved by chooser.txt");
  await editor(id).fill("Native chooser text");
  const chooserWindow = async () => {
    try {
      return (
        await execute("xdotool", [
          "search",
          "--onlyvisible",
          "--name",
          "Save file",
        ])
      ).stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .at(-1);
    } catch {
      return undefined;
    }
  };
  await editor(id).press(`${modifier}+s`);
  let native: string | undefined;
  try {
    await expect
      .poll(async () => !!(native = await chooserWindow()))
      .toBe(true);
    const capture = await app.app!.evaluate(async ({ desktopCapturer }) => {
      const screens = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1280, height: 1024 },
      });
      return screens[0]?.thumbnail.toPNG().toString("base64");
    });
    if (capture)
      await writeFile(
        info.outputPath("native-save-as.png"),
        Buffer.from(capture, "base64"),
      );
    await execute("xdotool", ["windowfocus", "--sync", native!]);
    await execute("xdotool", ["key", "--clearmodifiers", "Escape"]);
    native = undefined;
    await expect(editor(id)).toBeFocused();
    await expect(editor(id)).toHaveValue("Native chooser text");
    await editor(id).press(`${modifier}+s`);
    await expect
      .poll(async () => !!(native = await chooserWindow()))
      .toBe(true);
    await execute("xdotool", ["windowfocus", "--sync", native!]);
    await execute("xdotool", ["key", "--clearmodifiers", "ctrl+a"]);
    await execute("xdotool", [
      "type",
      "--clearmodifiers",
      "--delay",
      "5",
      path.basename(target),
    ]);
    await execute("xdotool", ["key", "--clearmodifiers", "alt+s"]);
    await expect
      .poll(() => readFile(target, "utf8").catch(() => ""))
      .toBe("Native chooser text");
    native = undefined;
    await expect(editor(id)).toBeFocused();
    expect((await active()).panes.find((p) => p.id === id)?.kind).toBe(
      "document",
    );
  } finally {
    if (native)
      await execute("xdotool", ["key", "--window", native, "Escape"]).catch(
        () => undefined,
      );
  }
});

test("Unsaved buffers survive the ordinary closed-tab cache and workspace recovery", async () => {
  const id = await untitled();
  await editor(id).fill("Recover this unsaved buffer");
  await expect
    .poll(
      async () =>
        (
          await app.cli<{ draft?: { content: string } }>(
            "file",
            "read",
            "--workspace",
            workspace,
            "--pane-id",
            id,
          )
        ).draft?.content,
    )
    .toBe("Recover this unsaved buffer");
  await app.cli("pane", "close", "--workspace", workspace, "--id", id);
  await app.page.evaluate(async (workspace) => {
    for (let i = 0; i < 51; i++) {
      const { paneId } = await window.cod.invoke<{ paneId: string }>({
        op: "pane.new",
        workspace,
      });
      await window.cod.invoke({ op: "pane.close", workspace, id: paneId });
    }
  }, workspace);
  expect((await active()).closedTabs).toHaveLength(51);
  expect((await active()).closedTabs!.some((r) => r.pane.id === id)).toBe(true);
  await app.cli("workspace", "close", "--id", workspace);
  await app.stop();
  await app.start();
  await app.cli("workspace", "reopen", "--id", workspace);
  await app.page.evaluate(async (workspace) => {
    for (let i = 0; i < 51; i++)
      await window.cod.invoke({ op: "pane.reopen", workspace });
  }, workspace);
  await expect(editor(id)).toHaveValue("Recover this unsaved buffer");
});

test("Type menu retains the background group target and rejects a moved source when creating a file", async ({}, info) => {
  const left = await untitled(),
    leftGroup = (await active()).groups!.find((g) => g.paneIds.includes(left))!;
  const right = await app.cli<{ groupId: string }>(
    "group",
    "ensure",
    "--workspace",
    workspace,
    "--side",
    "right",
  );
  await plus(right.groupId).click();
  await menu().getByRole("button", { name: "Browser", exact: true }).click();
  await expect
    .poll(async () => (await active()).activeGroupId)
    .toBe(right.groupId);
  const source = (await active()).activePaneId;
  await expect(
    app.pane(source).getByRole("textbox", { name: "Address", exact: true }),
  ).toBeFocused();
  await app.cli("pane", "focus", "--workspace", workspace, "--id", left);
  await app.page.setViewportSize({ width: 720, height: 650 });
  await app.cli(
    "settings",
    "update",
    "--values",
    JSON.stringify({ "ui.fontSize": 18 }),
  );
  await plus(right.groupId).click();
  const bounds = await menu().boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(720);
  await menu().screenshot({ path: info.outputPath("narrow-new-tab-menu.png") });
  await menu().getByRole("button", { name: "New file", exact: true }).click();
  const note = await selectedAfter(source);
  await expect(editor(note)).toBeFocused();
  await expect(editor(note)).toHaveValue("");
  expect((await active()).activeGroupId).toBe(right.groupId);
  await plus(right.groupId).click();
  await app.cli(
    "pane",
    "move",
    "--workspace",
    workspace,
    "--id",
    note,
    "--group",
    leftGroup.id,
  );
  const before = (await active()).panes.map((p) => p.id);
  await menu().getByRole("button", { name: "New file", exact: true }).click();
  await expect(
    app.page
      .getByRole("status")
      .filter({ hasText: "source tab closed or moved" }),
  ).toBeVisible();
  expect((await active()).panes.map((p) => p.id)).toEqual(before);
});

test("Preview creates a text buffer while review and unchosen tabs retain the chooser fallback", async () => {
  const origin = await app.newChat(workspace, "codex");
  const preview = await app.cli<{ paneId: string }>(
    "preview",
    "open",
    "--workspace",
    workspace,
    "--path",
    app.file,
  );
  await app.page
    .locator(`[role="tab"][data-tab-id="${preview.paneId}"]`)
    .focus();
  await app.page.keyboard.press(`${modifier}+t`);
  await expect
    .poll(async () => (await active()).activePaneId)
    .not.toBe(preview.paneId);
  const text = (await active()).activePaneId;
  await expect(editor(text)).toBeFocused();
  await expect(editor(text)).toHaveValue("");
  const review = await app.cli<{ paneId: string }>(
    "review",
    "open-document",
    "--workspace",
    workspace,
    "--path",
    app.file,
    "--conversation",
    origin.id,
  );
  await app.page
    .locator(`[role="tab"][data-tab-id="${review.paneId}"]`)
    .focus();
  await app.page.keyboard.press(`${modifier}+t`);
  const chooser = app.page.getByRole("region", {
    name: "New tab",
    exact: true,
  });
  await expect(
    chooser.getByRole("button", { name: "New file", exact: true }),
  ).toBeFocused();
  const first = (await active()).activePaneId;
  await app.page.keyboard.press(`${modifier}+t`);
  await expect.poll(async () => (await active()).activePaneId).not.toBe(first);
  await expect(
    app
      .pane((await active()).activePaneId)
      .getByRole("button", { name: "New file", exact: true }),
  ).toBeFocused();
});

test("Contextual New tab remaps live and through restart without changing the type-menu action", async () => {
  const source = await untitled(),
    config = path.join(app.data, "keymap.json");
  await writeFile(config, JSON.stringify({ "tab.new": ["Alt+Y"] }));
  await expect
    .poll(
      async () =>
        (await app.page.evaluate(() => window.cod.getKeymap())).overrides[
          "tab.new"
        ],
    )
    .toEqual(["Alt+Y"]);
  await editor(source).press("Alt+y");
  await expect.poll(async () => (await active()).activePaneId).not.toBe(source);
  const child = (await active()).activePaneId;
  await expect(editor(child)).toBeFocused();
  await app.stop();
  await app.start();
  await editor(child).press("Alt+y");
  await expect.poll(async () => (await active()).activePaneId).not.toBe(child);
  const next = (await active()).activePaneId;
  await expect(editor(next)).toBeFocused();
  await writeFile(config, "{}");
  await expect
    .poll(
      async () =>
        (await app.page.evaluate(() => window.cod.getKeymap())).overrides[
          "tab.new"
        ],
    )
    .toBeUndefined();
  await editor(next).press(`${modifier}+t`);
  await expect.poll(async () => (await active()).activePaneId).not.toBe(next);
});

for (const provider of ["codex", "kimi"] as const) {
  test(`Inherited ${provider} selection survives idle native startup before the first prompt`, async () => {
    await app.configure({
      [provider]: {
        options: true,
        multipleModels: true,
        reasoningOptions: true,
      },
    });
    const source = await app.newChat(workspace, provider);
    await app.cli(
      "conversation",
      "option",
      "--id",
      source.id,
      "--option",
      "model",
      "--value",
      "fixture-alternate",
    );
    const child = await app.cli<{ paneId: string }>(
      "pane",
      "new",
      "--workspace",
      workspace,
      "--same-as",
      source.paneId,
      "--focus",
      "true",
    );
    const started = await app.cli<{ id: string }>(
      "conversation",
      "start",
      "--workspace",
      workspace,
      "--pane-id",
      child.paneId,
      "--provider",
      provider,
    );
    const options = await app.cli<{
      current: Record<string, string>;
      pending?: Record<string, string>;
    }>("conversation", "options", "--id", started.id);
    expect({ ...options.current, ...options.pending }).toMatchObject({
      model: "fixture-alternate",
    });
    expect(
      (await state()).conversations.find((c) => c.id === started.id)
        ?.initialSelection,
    ).toEqual({ model: "fixture-alternate" });
    await app.stop();
    await app.start();
    await app.send(started.id, "First request after idle startup");
    await expect
      .poll(async () => (await app.inspect(started.id)).status)
      .toBe("ready");
    const selected = await app.cli<{
      current: Record<string, string>;
      pending?: Record<string, string>;
    }>("conversation", "options", "--id", started.id);
    expect({ ...selected.current, ...selected.pending }).toMatchObject({
      model: "fixture-alternate",
    });
    expect(
      (await state()).conversations.find((c) => c.id === started.id)
        ?.initialSelection,
    ).toBeUndefined();
  });
}

test("Changing a new chat's provider clears inherited model overrides without copying source content", async () => {
  await app.configure({ kimi: { options: true, multipleModels: true } });
  const source = await app.newChat(workspace, "kimi");
  await app.cli(
    "conversation",
    "option",
    "--id",
    source.id,
    "--option",
    "model",
    "--value",
    "fixture-alternate",
  );
  const child = await app.cli<{ paneId: string }>(
    "pane",
    "new",
    "--workspace",
    workspace,
    "--same-as",
    source.paneId,
    "--focus",
    "true",
  );
  await app
    .pane(child.paneId)
    .getByRole("button", { name: "Provider", exact: true })
    .click();
  await menu().getByRole("button", { name: "Codex", exact: true }).click();
  await expect
    .poll(async () => (await active()).chatDrafts![child.paneId]?.provider)
    .toBe("codex");
  expect(
    (await active()).chatDrafts![child.paneId]?.initialSelection,
  ).toBeUndefined();
  expect((await state()).conversations).toHaveLength(1);
});

test("Large recoverable buffers stay out of navigation snapshots and do not delay a fresh editor", async () => {
  const source = await untitled(),
    text = ("Invented buffer paragraph ".repeat(80) + "\n").repeat(1000);
  // Recover a real large buffer; native multi-megabyte insertion is a separate
  // measured Chromium limitation (#187), not this navigation/storage check.
  await app.stop();
  const statePath = path.join(app.data, "state.json");
  const saved = JSON.parse(await readFile(statePath, "utf8")) as AppState;
  saved.drafts[`untitled:${source}`] = {
    content: text,
    expectedContent: "",
    version: "large-recovery-fixture",
  };
  await writeFile(statePath, JSON.stringify(saved));
  await app.start();
  await expect
    .poll(() =>
      editor(source).evaluate(
        (input: HTMLTextAreaElement) => input.value.length,
      ),
    )
    .toBe(text.length);
  await app.page.evaluate(() => {
    Object.assign(window, { fileStateSizes: [] });
    window.cod.onState((state) => {
      const sizes = (window as any).fileStateSizes;
      if (sizes.length < 10)
        sizes.push({
          bytes: JSON.stringify(state).length,
          drafts: Object.keys(state.drafts).length,
        });
    });
  });
  const started = Date.now();
  await editor(source).press(`${modifier}+t`);
  await expect.poll(async () => (await active()).activePaneId).not.toBe(source);
  const child = (await active()).activePaneId;
  await expect(editor(child)).toBeFocused();
  expect(Date.now() - started).toBeLessThan(2000);
  await editor(child).evaluate((input) => {
    Object.assign(window, { fileInputFrames: [] });
    input.addEventListener("input", () => {
      const start = performance.now();
      requestAnimationFrame(() =>
        (window as any).fileInputFrames.push(performance.now() - start),
      );
    });
  });
  await editor(child).pressSequentially(
    "New buffer remains responsive while old text is recoverable",
  );
  for (let i = 0; i < 30; i++) await editor(child).press("Backspace");
  await expect
    .poll(() => app.page.evaluate(() => (window as any).fileInputFrames.length))
    .toBeGreaterThanOrEqual(80);
  const samples = await app.page.evaluate(
    () => (window as any).fileInputFrames as number[],
  );
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  expect(p95).toBeLessThan(200);
  const snapshots = await app.page.evaluate(
    () =>
      (window as any).fileStateSizes as Array<{
        bytes: number;
        drafts: number;
      }>,
  );
  expect(snapshots.length).toBeGreaterThan(0);
  expect(snapshots.every((s) => s.drafts === 0 && s.bytes < 100000)).toBe(true);
  console.log(
    JSON.stringify({
      fixture: "large-recoverable-buffer",
      bytes: text.length,
      samples: samples.length,
      inputToFrameP95Ms: p95,
    }),
  );
});

test("Failed Save As metadata commit restores the observed untitled view and its newer text", async () => {
  const id = await untitled(),
    target = path.join(app.folders[0], "failed-commit.txt"),
    statePath = path.join(app.data, "state.json");
  await editor(id).fill("Retained before failure");
  await app.app!.evaluate(
    async ({ dialog, BrowserWindow }, args) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: args.target,
      });
      const fs = process.getBuiltinModule("node:fs/promises")!,
        rename = fs.rename;
      Object.assign(globalThis, {
        pendingFileCommit: false,
        releaseFileCommit: false,
      });
      let fail = true;
      fs.rename = async (from, to) => {
        if (
          fail &&
          String(to) === args.statePath &&
          (await fs.stat(args.target).then(
            () => true,
            () => false,
          ))
        ) {
          fail = false;
          const saved = JSON.parse(await fs.readFile(from, "utf8"));
          // A native event can publish an in-flight state while persistence waits.
          BrowserWindow.getAllWindows()[0].webContents.send("cod:state", {
            ...saved,
            drafts: {},
          });
          (globalThis as any).pendingFileCommit = true;
          while (!(globalThis as any).releaseFileCommit)
            await new Promise((r) => setTimeout(r, 5));
          throw new Error("Invented metadata commit failure");
        }
        return rename(from, to);
      };
    },
    { target, statePath },
  );
  try {
    await editor(id).press(`${modifier}+s`);
    await expect
      .poll(() =>
        app.app!.evaluate(() => (globalThis as any).pendingFileCommit),
      )
      .toBe(true);
    await expect(
      app.page.locator(`[role="tab"][data-tab-id="${id}"]`),
    ).toContainText("failed-commit.txt");
    await editor(id).press("End");
    await editor(id).pressSequentially(" and newer");
  } finally {
    await app.app!.evaluate(() => {
      (globalThis as any).releaseFileCommit = true;
    });
  }
  await expect(app.pane(id).getByRole("status")).toContainText(
    "Save did not complete",
  );
  expect((await active()).panes.find((p) => p.id === id)?.kind).toBe(
    "untitled",
  );
  await expect(
    app.page.locator(`[role="tab"][data-tab-id="${id}"]`),
  ).toContainText("Untitled 1");
  await expect(editor(id)).toHaveValue("Retained before failure and newer");
  await app.stop();
  await app.start();
  await expect(editor(id)).toHaveValue("Retained before failure and newer");
});

test("Registered forms create ordinary blank browsers and image previews create empty text buffers", async () => {
  const origin = await app.newChat(workspace, "codex"),
    file = path.join(app.folders[0], "invented-form.html");
  await writeFile(
    file,
    '<!doctype html><title>Invented form</title><input aria-label="Answer">',
  );
  const form = await app.cli<{ id: string; paneId: string }>(
    "page",
    "open",
    "--workspace",
    workspace,
    "--conversation",
    origin.id,
    "--path",
    file,
  );
  const record = (await state()).browsers.find((b) => b.id === form.id)!;
  await app.app!.evaluate(async ({ webContents }, url) => {
    const contents = webContents
      .getAllWebContents()
      .find((wc) => wc.getURL() === url)!;
    await contents.executeJavaScript(
      'document.querySelector("input").value = "Keep the source form"',
    );
    contents.focus();
    const modifiers: ("meta" | "control")[] = [
      process.platform === "darwin" ? "meta" : "control",
    ];
    contents.sendInputEvent({ type: "keyDown", keyCode: "T", modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode: "T", modifiers });
  }, record.url);
  await expect
    .poll(async () => (await active()).activePaneId)
    .not.toBe(form.paneId);
  const childPane = (await active()).activePaneId;
  await expect(
    app.pane(childPane).getByRole("textbox", { name: "Address", exact: true }),
  ).toBeFocused();
  const child = (await state()).browsers.find((b) => b.paneId === childPane)!;
  expect(child.url).toBe("about:blank");
  expect(child.agentPage).toBeUndefined();
  expect(
    (await state()).browsers.find((b) => b.id === form.id)?.agentPage
      ?.conversationId,
  ).toBe(origin.id);
  const sourceValue = await app.app!.evaluate(
    ({ webContents }, url) =>
      webContents
        .getAllWebContents()
        .find((wc) => wc.getURL() === url)!
        .executeJavaScript('document.querySelector("input").value'),
    record.url,
  );
  expect(sourceValue).toBe("Keep the source form");
  await app.cli(
    "browser",
    "navigate",
    "--id",
    child.id,
    "--url",
    pathToFileURL(file).href,
  );
  expect(
    await app.app!.evaluate(
      ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .find((wc) => wc.getURL() === url)!
          .executeJavaScript("typeof window.codPage"),
      pathToFileURL(file).href,
    ),
  ).toBe("undefined");
  const image = path.join(app.folders[0], "invented-image.png");
  await app.page.screenshot({ path: image });
  const preview = await app.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    image,
  );
  await app
    .pane(preview.paneId)
    .getByRole("region", { name: "Image preview", exact: true })
    .focus();
  await app.page.keyboard.press(`${modifier}+t`);
  await expect
    .poll(async () => (await active()).activePaneId)
    .not.toBe(preview.paneId);
  const text = (await active()).activePaneId;
  await expect(editor(text)).toBeFocused();
  await expect(editor(text)).toHaveValue("");
});

test("Newer navigation cancels automatic follow while a contextual terminal is being created", async () => {
  test.skip(
    process.platform !== "linux",
    "Controlled live cwd delay uses the isolated Linux process path",
  );
  const source = await app.cli<{ id: string; paneId: string }>(
    "terminal",
    "open",
    "--workspace",
    workspace,
  );
  await expect
    .poll(
      async () =>
        (await state()).terminals.find((t) => t.id === source.id)?.status,
    )
    .toBe("running");
  const before = await active(),
    sourceGroup = before.groups!.find((g) =>
      g.paneIds.includes(source.paneId),
    )!;
  let otherGroup = await app.cli<{ groupId: string }>(
    "group",
    "ensure",
    "--workspace",
    workspace,
    "--side",
    "right",
  );
  if (otherGroup.groupId === sourceGroup.id)
    otherGroup = await app.cli<{ groupId: string }>(
      "group",
      "ensure",
      "--workspace",
      workspace,
      "--side",
      "left",
    );
  expect(otherGroup.groupId).not.toBe(sourceGroup.id);
  const other = await app.cli<{ paneId: string }>(
    "file",
    "new",
    "--workspace",
    workspace,
    "--group",
    otherGroup.groupId,
    "--focus",
    "true",
  );
  await expect(editor(other.paneId)).toBeEnabled();
  await app.cli(
    "pane",
    "focus",
    "--workspace",
    workspace,
    "--id",
    source.paneId,
  );
  const input = app.pane(source.paneId).locator(".xterm-helper-textarea");
  await input.focus();
  const terminal = (await state()).terminals.find((t) => t.id === source.id)!;
  await app.app!.evaluate(({}, pid) => {
    const fs = process.getBuiltinModule("node:fs/promises")!,
      readlink = fs.readlink;
    Object.assign(globalThis, {
      creationCwdPending: false,
      releaseCreationCwd: false,
    });
    Object.defineProperty(fs, "readlink", {
      value: async (file: string, ...options: unknown[]) => {
        if (String(file) === `/proc/${pid}/cwd`) {
          (globalThis as any).creationCwdPending = true;
          while (!(globalThis as any).releaseCreationCwd)
            await new Promise((r) => setTimeout(r, 5));
        }
        return Reflect.apply(readlink, fs, [file, ...options]);
      },
    });
  }, terminal.pid);
  try {
    await input.press(`${modifier}+t`);
    await expect
      .poll(() =>
        app.app!.evaluate(() => (globalThis as any).creationCwdPending),
      )
      .toBe(true);
    await editor(other.paneId).click();
    await editor(other.paneId).pressSequentially(
      "Keep my newer focus and text",
    );
    await expect
      .poll(async () => (await active()).activePaneId)
      .toBe(other.paneId);
  } finally {
    await app.app!.evaluate(() => {
      (globalThis as any).releaseCreationCwd = true;
    });
  }
  await expect.poll(async () => (await state()).terminals.length).toBe(2);
  expect((await active()).activePaneId).toBe(other.paneId);
  await expect(editor(other.paneId)).toBeFocused();
  await expect(editor(other.paneId)).toHaveValue(
    "Keep my newer focus and text",
  );
  const current = await active(),
    child = (await state()).terminals.find((t) => t.id !== source.id)!;
  expect(
    current.groups!.find((g) => g.id === sourceGroup.id)?.paneIds,
  ).toContain(child.paneId);
  expect(
    current.groups!.find((g) => g.id === sourceGroup.id)?.activePaneId,
  ).toBe(source.paneId);
  expect(child.cwd).toBe(terminal.cwd);
  expect(child.pid).not.toBe(terminal.pid);
});

test("Tabs keep review identity and unsaved state visible beside truncated filenames", async ({}, info) => {
  await app.page
    .locator(`[data-navigation-key="workspace:${workspace}"]`)
    .click({ button: "right" });
  await expect(
    app.page
      .locator("dialog.context-menu")
      .getByRole("button", { name: "New chat", exact: true })
      .locator("kbd"),
  ).toHaveText(process.platform === "darwin" ? /⌘.*N/ : /Ctrl.*N/);
  await app.page.keyboard.press("Escape");
  const filename =
    "An intentionally long document name shared by the source and its review snapshot.md";
  const file = path.join(app.folders[0], filename);
  const original = "# Invented source\nOriginal text\n";
  await writeFile(file, original);
  const source = await app.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    file,
  );
  await expect(editor(source.paneId)).toHaveValue(original);
  const conversation = await app.newChat(workspace, "codex");
  const review = await app.cli<{ paneId: string }>(
    "review",
    "open-document",
    "--workspace",
    workspace,
    "--path",
    file,
    "--conversation",
    conversation.id,
  );
  const sourceTab = app.page.locator(
    `[role="tab"][data-tab-id="${source.paneId}"]`,
  );
  const reviewTab = app.page.locator(
    `[role="tab"][data-tab-id="${review.paneId}"]`,
  );
  await expect(reviewTab.locator(".tab-kind")).toHaveText("Review");
  await expect(reviewTab.locator(".tab-kind")).toBeVisible();
  await expect(sourceTab.locator(".tab-kind")).toBeHidden();
  await expect(reviewTab).toHaveAttribute("title", /Review snapshot/);
  expect(
    await reviewTab
      .locator(".tab-label")
      .evaluate((e) => e.scrollWidth > e.clientWidth),
  ).toBe(true);
  await app.page.screenshot({
    path: info.outputPath("source-review-tabs-normal.png"),
  });
  await sourceTab.click();
  const input = editor(source.paneId);
  const changed = original + "Private invented draft\n";
  await input.fill(changed);
  await expect(sourceTab.locator(".tab-modified")).toBeVisible();
  await expect(sourceTab).toHaveAttribute("title", /Unsaved changes/);
  await expect(reviewTab.locator(".tab-modified")).toBeHidden();
  await app.cli(
    "pane",
    "pin",
    "--workspace",
    workspace,
    "--id",
    source.paneId,
    "--pinned",
    "true",
  );
  await expect(sourceTab.locator(".tab-pin")).toBeVisible();
  await expect(sourceTab.locator(".tab-modified")).toBeVisible();
  await sourceTab.click({ button: "right" });
  await expect(
    app.page
      .locator("dialog.context-menu")
      .getByRole("button", {
        name: "Close tab",
        exact: true,
      })
      .locator("kbd"),
  ).toHaveText("");
  await app.page.keyboard.press("Escape");
  await app.page.screenshot({
    path: info.outputPath("source-modified-tabs.png"),
  });
  await input.fill(original);
  await expect(sourceTab.locator(".tab-modified")).toBeHidden();
  await input.fill(changed);
  await expect(sourceTab.locator(".tab-modified")).toBeVisible();
  await input.press(`${modifier}+s`);
  await expect(sourceTab.locator(".tab-modified")).toBeHidden();
  expect(await readFile(file, "utf8")).toBe(changed);
  await input.fill(changed + "Survives restart\n");
  await expect(sourceTab.locator(".tab-modified")).toBeVisible();
  await app.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(800, 700),
  );
  await app.cli(
    "settings",
    "update",
    "--values",
    JSON.stringify({ "ui.fontSize": 20 }),
  );
  await expect(app.page.locator("html")).toHaveCSS("font-size", "20px");
  await reviewTab.click();
  const inspectBounds = () =>
    reviewTab.evaluate((tab) => {
      const outer = tab.getBoundingClientRect(),
        badge = tab.querySelector(".tab-kind")!.getBoundingClientRect();
      return {
        inside:
          badge.left >= outer.left &&
          badge.right <= outer.right &&
          badge.top >= outer.top &&
          badge.bottom <= outer.bottom,
        visible: badge.width > 0,
        height: outer.height,
      };
    });
  expect(await inspectBounds()).toEqual({
    inside: true,
    visible: true,
    height: 32,
  });
  await reviewTab.focus();
  await app.page.keyboard.press("Tab");
  await app.page.keyboard.press("Shift+Tab");
  await expect(reviewTab).toBeFocused();
  expect(
    await reviewTab.evaluate((e) => getComputedStyle(e).outlineStyle),
  ).toBe("solid");
  await app.page.screenshot({
    path: info.outputPath("source-review-tabs-narrow.png"),
  });
  await app.cli(
    "settings",
    "update",
    "--values",
    JSON.stringify({ "ui.fontSize": 32 }),
  );
  await expect(app.page.locator("html")).toHaveCSS("font-size", "32px");
  const maximum = await inspectBounds();
  expect(maximum.inside).toBe(true);
  expect(maximum.height).toBeGreaterThan(32);
  await app.page.screenshot({
    path: info.outputPath("source-review-tabs-maximum-text.png"),
  });
  await app.stop();
  await app.start();
  const restoredSource = app.page.locator(
    `[role="tab"][data-tab-id="${source.paneId}"]`,
  );
  await restoredSource.click();
  await expect(editor(source.paneId)).toHaveValue(
    changed + "Survives restart\n",
  );
  await expect(restoredSource.locator(".tab-modified")).toBeVisible();
  await expect(restoredSource.locator(".tab-pin")).toBeVisible();
  await expect(
    app.page.locator(`[role="tab"][data-tab-id="${review.paneId}"] .tab-kind`),
  ).toHaveText("Review");
});

test("Saving a short source tab does not move a held Close target", async () => {
  const source = await app.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    app.file,
  );
  const original = await readFile(app.file, "utf8");
  await expect(editor(source.paneId)).toHaveValue(original);
  const tab = app.page.locator(`[role="tab"][data-tab-id="${source.paneId}"]`);
  await tab.click();
  await editor(source.paneId).fill(original + "Changed before closing\n");
  await expect(tab.locator(".tab-modified")).toBeVisible();
  await app.app!.evaluate((_, target) => {
    const fs = process.getBuiltinModule("node:fs/promises")!,
      rename = fs.rename;
    Object.assign(globalThis, {
      tabSaveWaiting: false,
      tabSaveReleased: false,
    });
    fs.rename = async (from, to) => {
      if (String(to) === target) {
        (globalThis as any).tabSaveWaiting = true;
        while (!(globalThis as any).tabSaveReleased)
          await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return rename(from, to);
    };
  }, app.file);
  let held = false;
  try {
    await editor(source.paneId).press(`${modifier}+s`);
    await expect
      .poll(() => app.app!.evaluate(() => (globalThis as any).tabSaveWaiting))
      .toBe(true);
    await tab.hover();
    const close = tab.getByRole("button", {
      name: "Close spec.md",
      exact: true,
    });
    const before = (await close.boundingBox())!;
    await app.page.mouse.move(
      before.x + before.width / 2,
      before.y + before.height / 2,
    );
    await app.page.mouse.down();
    held = true;
    await app.app!.evaluate(() => {
      (globalThis as any).tabSaveReleased = true;
    });
    await expect(tab.locator(".tab-modified")).toBeHidden();
    const after = (await close.boundingBox())!;
    console.log(
      JSON.stringify({ fixture: "save-during-close-press", before, after }),
    );
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  } finally {
    await app.app!.evaluate(() => {
      (globalThis as any).tabSaveReleased = true;
    });
    if (held) await app.page.mouse.up();
  }
  await expect(tab).toHaveCount(0);
  expect(await readFile(app.file, "utf8")).toBe(
    original + "Changed before closing\n",
  );
});
