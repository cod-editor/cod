import { test, expect, type Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ChatApp } from "./helpers/chat-fixture/harness";
import { modifier } from "./helpers/workspace-app";
import type { AppState, WorkspaceState } from "../../src/types";
let app: ChatApp;
let workspace: string;
test.beforeEach(async () => {
  app = new ChatApp();
  await app.prepare();
  await app.configure({ codex: {} });
  await app.start();
  workspace = await app.create("Pinned tasks");
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
const state = () => app.cli<AppState>("state");
const ws = async () =>
  (await state()).workspaces.find((w) => w.id === workspace)!;
const tab = (id: string) => app.page.locator(`[role=tab][data-tab-id="${id}"]`);
const pin = (id: string, value = true) =>
  app.cli(
    "pane",
    "pin",
    "--workspace",
    workspace,
    "--id",
    id,
    "--pinned",
    String(value),
  );
const focus = (id: string) =>
  app.cli("pane", "focus", "--workspace", workspace, "--id", id);
const blank = (group?: string) =>
  app.cli<{ paneId: string; groupId: string }>(
    "pane",
    "new",
    "--workspace",
    workspace,
    ...(group ? ["--group", group] : []),
  );
const order = (w: WorkspaceState, group: string) =>
  w.groups!.find((g) => g.id === group)!.paneIds;
async function context(id: string, label: string) {
  await tab(id).click({ button: "right" });
  await app.page
    .getByRole("dialog", { name: "Actions", exact: true })
    .getByRole("button", { name: label, exact: true })
    .click();
}
async function drag(source: Locator, target: Locator, edge: "left" | "right") {
  await source.scrollIntoViewIfNeeded();
  const a = (await source.boundingBox())!,
    b = (await target.boundingBox())!;
  await app.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await app.page.mouse.down();
  await app.page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2, {
    steps: 3,
  });
  const x = edge === "left" ? b.x + 12 : b.x + b.width - 12;
  await app.page.mouse.move(x, b.y + b.height / 2, { steps: 16 });
  await app.page.mouse.move(x, b.y + b.height / 2);
  await expect(app.page.locator(".tab-insertion-marker")).toBeVisible();
}

test("Pin actions preserve background selection, replace close with unpin and protect routine keyboard and mouse closure", async ({}, info) => {
  const first = await blank(),
    second = await blank();
  await context(first.paneId, "Pin tab");
  expect((await ws()).activePaneId).toBe(second.paneId);
  expect(order(await ws(), first.groupId)[0]).toBe(first.paneId);
  await expect(
    tab(first.paneId).getByRole("button", {
      name: "Unpin New tab",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    tab(first.paneId).getByRole("button", {
      name: "Close New tab",
      exact: true,
    }),
  ).toHaveCount(0);
  await focus(first.paneId);
  await tab(first.paneId).focus();
  await tab(first.paneId).press(`${modifier}+w`);
  await expect(tab(first.paneId)).toBeVisible();
  await expect
    .poll(async () => (await ws()).activePaneId)
    .not.toBe(first.paneId);
  await expect(tab(second.paneId)).toBeVisible();
  await tab(first.paneId).focus();
  await tab(first.paneId).press("Delete");
  await tab(first.paneId).click({ button: "middle" });
  await expect(tab(first.paneId)).toBeVisible();
  await context(first.paneId, "Close all tabs");
  await expect
    .poll(async () => (await ws()).panes.map((p) => p.id))
    .toEqual([first.paneId]);
  await tab(first.paneId).focus();
  await tab(first.paneId).press(`${modifier}+w`);
  expect((await ws()).activePaneId).toBe(first.paneId);
  await expect(tab(first.paneId)).toBeFocused();
  await tab(first.paneId).click({ button: "right" });
  await app.page.keyboard.press("Escape");
  await expect(tab(first.paneId)).toBeFocused();
  await app.page.screenshot({ path: info.outputPath("pinned-tab.png") });
  await tab(first.paneId)
    .getByRole("button", { name: "Unpin New tab", exact: true })
    .click();
  await expect(tab(first.paneId)).toHaveAttribute("data-pinned", "false");
  await tab(first.paneId)
    .getByRole("button", { name: "Close New tab", exact: true })
    .click();
  await expect(tab(first.paneId)).toHaveCount(0);
});

test("Native browser shortcuts and CLI aliases preserve a pinned page; explicit context close and reopen restore its pin and position", async () => {
  const before = await blank();
  const pagePath = path.join(app.folders[0], "pinned.html");
  await writeFile(
    pagePath,
    "<title>Pinned report</title><input value=retained>",
  );
  const pageUrl = pathToFileURL(pagePath).href;
  const browser = await app.cli<{ id: string; paneId: string }>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    pageUrl,
  );
  await pin(browser.paneId);
  const extra = await blank(before.groupId);
  await focus(browser.paneId);
  await expect(
    app
      .pane(browser.paneId)
      .getByRole("textbox", { name: "Address", exact: true }),
  ).toBeVisible();
  await app.app!.evaluate(({ webContents }, url) => {
    const page = webContents
      .getAllWebContents()
      .find((c) => c.getURL() === url);
    if (!page) throw new Error(`Missing native page for ${url}`);
    page.focus();
    page.sendInputEvent({
      type: "keyDown",
      keyCode: "W",
      modifiers: [process.platform === "darwin" ? "meta" : "control"],
    });
    page.sendInputEvent({
      type: "keyUp",
      keyCode: "W",
      modifiers: [process.platform === "darwin" ? "meta" : "control"],
    });
  }, pageUrl);
  await expect
    .poll(async () => (await ws()).activePaneId)
    .not.toBe(browser.paneId);
  expect(
    (await app.cli<{ closed: boolean }>("browser", "close", "--id", browser.id))
      .closed,
  ).toBe(false);
  expect((await state()).browsers.some((b) => b.id === browser.id)).toBe(true);
  await context(browser.paneId, "Close tab");
  await expect(tab(browser.paneId)).toHaveCount(0);
  await app.cli("pane", "reopen", "--workspace", workspace);
  await expect(tab(browser.paneId)).toHaveAttribute("data-pinned", "true");
  expect(order(await ws(), before.groupId)[0]).toBe(browser.paneId);
  expect(
    (await state()).browsers.find((b) => b.id === browser.id)?.paneId,
  ).toBe(browser.paneId);
  await expect(tab(extra.paneId)).toBeVisible();
  await app.stop();
  await app.start();
  await expect(tab(browser.paneId)).toHaveAttribute("data-pinned", "true");
  expect((await ws()).activePaneId).toBe(browser.paneId);
});

test("Pinned and ordinary dragging clamps to the correct segment and cross-pane moves, splits and restart retain identity", async ({}, info) => {
  const a = await blank(),
    b = await blank(),
    c = await blank();
  await pin(a.paneId);
  await pin(b.paneId);
  await expect(tab(a.paneId)).toHaveAttribute("data-pinned", "true");
  await expect(tab(b.paneId)).toHaveAttribute("data-pinned", "true");
  await drag(tab(c.paneId), tab(a.paneId), "left");
  const marker = (await app.page
    .locator(".tab-insertion-marker")
    .boundingBox())!;
  const boundary = (await tab(b.paneId).boundingBox())!;
  expect(Math.abs(marker.x - (boundary.x + boundary.width))).toBeLessThan(3);
  await app.page.mouse.up();
  expect(order(await ws(), a.groupId).slice(0, 2)).toEqual([
    a.paneId,
    b.paneId,
  ]);
  await drag(tab(a.paneId), tab(c.paneId), "right");
  await app.page.screenshot({ path: info.outputPath("pinned-insertion.png") });
  await app.page.mouse.up();
  await expect
    .poll(async () => order(await ws(), a.groupId).slice(0, 2))
    .toEqual([b.paneId, a.paneId]);
  const right = await app.cli<{ groupId: string }>(
    "group",
    "ensure",
    "--workspace",
    workspace,
    "--side",
    "right",
  );
  const destination = await blank(right.groupId);
  await drag(tab(a.paneId), tab(destination.paneId), "right");
  await app.page.mouse.up();
  await expect
    .poll(async () => order(await ws(), right.groupId)[0])
    .toBe(a.paneId);
  expect((await ws()).panes.find((p) => p.id === a.paneId)?.pinned).toBe(true);
  await context(a.paneId, "Split below");
  await app.stop();
  await app.start();
  await expect(tab(a.paneId)).toHaveAttribute("data-pinned", "true");
  expect((await ws()).panes.filter((p) => p.id === a.paneId)).toHaveLength(1);
  expect(
    (await ws()).groups!.find((g) => g.paneIds.includes(a.paneId))!.paneIds,
  ).toEqual([a.paneId]);
});

test("Pinned chat, draft and active native task follow cross-workspace moves and survive view close and workspace recovery", async () => {
  const chat = await app.newChat(workspace, "codex");
  await pin(chat.paneId);
  await app.send(chat.id, "Keep working [hold]");
  await expect
    .poll(async () => (await app.inspect(chat.id)).status)
    .toBe("working");
  await app.cli(
    "conversation",
    "composer",
    "--workspace",
    workspace,
    "--pane-id",
    chat.paneId,
    "--text",
    "Retain this draft",
  );
  const before = (await state()).conversations.find((c) => c.id === chat.id)!;
  const destination = await app.create("Other task");
  const reserved = (await state()).workspaces.find(
    (w) => w.id === destination,
  )!.activePaneId;
  await app.cli(
    "pane",
    "pin",
    "--workspace",
    destination,
    "--id",
    reserved,
    "--pinned",
    "true",
  );
  const fresh = await app.cli<{ paneId: string }>("conversation", "draft");
  expect(fresh.paneId).not.toBe(reserved);
  await app.cli(
    "pane",
    "close",
    "--workspace",
    destination,
    "--id",
    fresh.paneId,
  );
  await app.cli(
    "conversation",
    "move",
    "--id",
    chat.id,
    "--workspace",
    destination,
  );
  workspace = destination;
  await expect(tab(reserved)).toHaveAttribute("data-pinned", "true");
  await expect(tab(chat.paneId)).toHaveAttribute("data-pinned", "true");
  expect(
    (await state()).conversations.find((c) => c.id === chat.id)?.nativeId,
  ).toBe(before.nativeId);
  const denied = await app.raw("conversation", "remove", "--id", chat.id);
  expect(denied.code).not.toBe(0);
  expect(denied.stderr).toContain("Unpin this chat");
  await context(chat.paneId, "Close tab");
  expect((await app.inspect(chat.id)).status).toBe("working");
  expect((await state()).conversations.some((c) => c.id === chat.id)).toBe(
    true,
  );
  await app.cli("pane", "reopen", "--workspace", workspace);
  await expect(
    app
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Retain this draft");
  await app.cli("conversation", "interrupt", "--id", chat.id);
  await expect
    .poll(async () => (await app.inspect(chat.id)).status)
    .toBe("ready");
  await app.cli("workspace", "close", "--id", workspace);
  await app.cli("workspace", "reopen", "--id", workspace);
  await app.cli("workspace", "focus", "--id", workspace);
  await expect(tab(chat.paneId)).toHaveAttribute("data-pinned", "true");
  await app.stop();
  await app.start();
  await expect(
    app
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Retain this draft");
  expect(
    (await state()).conversations.find((c) => c.id === chat.id)?.nativeId,
  ).toBe(before.nativeId);
});

test("Pinned blank tabs keep protection through every content choice and terminal reopen requires a fresh shell", async () => {
  for (const kind of ["New file", "Browser", "Chat", "Terminal"]) {
    const b = await blank();
    await pin(b.paneId);
    const choice = app
      .pane(b.paneId)
      .getByRole("region", { name: "New tab", exact: true });
    await choice.getByRole("button", { name: kind, exact: true }).click();
    await expect(tab(b.paneId)).toHaveAttribute("data-pinned", "true");
    await expect
      .poll(async () => (await ws()).panes.find((p) => p.id === b.paneId)?.kind)
      .toBe(
        kind === "Browser"
          ? "browser"
          : kind === "Terminal"
            ? "terminal"
            : kind === "New file"
              ? "untitled"
              : "document",
      );
    if (kind === "Chat") {
      const composer = app
        .pane(b.paneId)
        .getByRole("textbox", { name: "Message", exact: true });
      await composer.fill("Keep this session");
      await composer.press("Enter");
      await expect
        .poll(
          async () => (await ws()).panes.find((p) => p.id === b.paneId)?.kind,
        )
        .toBe("conversation");
      await expect(tab(b.paneId)).toHaveAttribute("data-pinned", "true");
    }
    if (kind === "Terminal") {
      const terminal = (await state()).terminals.find(
        (t) => t.paneId === b.paneId,
      )!;
      expect(
        (
          await app.cli<{ closed: boolean }>(
            "terminal",
            "close",
            "--id",
            terminal.id,
          )
        ).closed,
      ).toBe(false);
      await context(b.paneId, "Close tab");
      expect(
        (await app.raw("pane", "reopen", "--workspace", workspace)).code,
      ).not.toBe(0);
      const reopened = await app.cli<{ paneId: string }>(
        "pane",
        "reopen",
        "--workspace",
        workspace,
        "--new-shell",
        "true",
      );
      await expect(tab(reopened.paneId)).toHaveAttribute("data-pinned", "true");
      expect(
        (await state()).terminals.find((t) => t.paneId === reopened.paneId)?.id,
      ).not.toBe(terminal.id);
    }
  }
});

test("Bulk close skips pins and preserves dirty source drafts; pin commands use shared live keymap and reset keeps pins", async () => {
  const pinned = await blank();
  await pin(pinned.paneId);
  await blank(pinned.groupId);
  const file = await app.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    app.file,
  );
  await app.cli(
    "pane",
    "move",
    "--workspace",
    workspace,
    "--id",
    file.paneId,
    "--group",
    pinned.groupId,
  );
  const content = app
    .pane(file.paneId)
    .getByRole("textbox", { name: "File contents", exact: true });
  await content.fill("Unsaved source text");
  await app.cli(
    "file",
    "draft",
    "--workspace",
    workspace,
    "--pane-id",
    file.paneId,
    "--content",
    "Unsaved source text",
    "--expected-content",
    "# Invented specification\n\nInitial text.\n",
  );
  const extra = await blank(pinned.groupId);
  await context(extra.paneId, "Close other tabs");
  await expect(tab(pinned.paneId)).toHaveAttribute("data-pinned", "true");
  await expect(tab(file.paneId)).toHaveCount(0);
  await app.cli("pane", "reopen", "--workspace", workspace);
  await expect(content).toHaveValue("Unsaved source text");
  await writeFile(
    path.join(app.data, "keymap.json"),
    JSON.stringify({ "tab.togglePin": ["Mod+Alt+U"] }),
  );
  await app.page.keyboard.press(`${modifier}+Shift+p`);
  await app.page
    .getByRole("textbox", { name: "Filter commands", exact: true })
    .fill("Keyboard shortcuts");
  await app.page
    .getByRole("button", { name: /Keyboard shortcuts/ })
    .first()
    .click();
  await app.page
    .getByRole("textbox", { name: "Search shortcuts" })
    .fill("Toggle pin tab");
  await expect(
    app.page
      .locator(".shortcut-row")
      .filter({ hasText: "Toggle pin tab" })
      .locator("kbd"),
  ).toContainText("Alt");
  await app.page.keyboard.press("Escape");
  await focus(extra.paneId);
  await tab(extra.paneId).focus();
  await tab(extra.paneId).press(`${modifier}+Alt+u`);
  await expect(tab(extra.paneId)).toHaveAttribute("data-pinned", "true");
  await app.cli("settings", "update", "--reset", "true");
  await expect(tab(extra.paneId)).toHaveAttribute("data-pinned", "true");
  const invalid = await app.raw(
    "pane",
    "pin",
    "--workspace",
    workspace,
    "--id",
    extra.paneId,
    "--pinned",
    "maybe",
  );
  expect(invalid.code).not.toBe(0);
  await expect(tab(extra.paneId)).toHaveAttribute("data-pinned", "true");
});

test("Bulk and explicit pinned closure retain the native beforeunload guard, and a destroyed pinned page remains recoverable", async () => {
  const b = await blank();
  const file = path.join(app.folders[0], "guard.html");
  await writeFile(
    file,
    '<title>Guarded report</title><input value="Unsaved form">',
  );
  const url = pathToFileURL(file).href;
  const browser = await app.cli<{ id: string; paneId: string }>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    url,
  );
  await expect
    .poll(
      async () =>
        (
          await app.cli<{ loading: boolean }>(
            "browser",
            "inspect",
            "--id",
            browser.id,
          )
        ).loading,
    )
    .toBe(false);
  await app.app!.evaluate(async ({ webContents, dialog }, url) => {
    const page = webContents
      .getAllWebContents()
      .find((c) => c.getURL() === url)!;
    await page.executeJavaScript(
      'document.querySelector("input").focus();window.onbeforeunload=()=>false;void 0',
    );
    page.focus();
    page.sendInputEvent({ type: "keyDown", keyCode: "A" });
    page.sendInputEvent({ type: "keyUp", keyCode: "A" });
    Object.assign(dialog, {
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    });
  }, url);
  const result = await app.cli<{ cancelled: string }>(
    "pane",
    "close-many",
    "--workspace",
    workspace,
    "--group",
    b.groupId,
    "--scope",
    "all",
  );
  expect(result.cancelled).toBe(browser.paneId);
  await expect(tab(browser.paneId)).toBeVisible();
  expect(
    (await ws()).closedTabs?.some((c) => c.pane.id === browser.paneId),
  ).not.toBe(true);
  await pin(browser.paneId);
  const protectedClose = await app.cli<{ closed: boolean }>(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    browser.paneId,
    "--include-pinned",
    "true",
  );
  expect(protectedClose.closed).toBe(false);
  await app.app!.evaluate(async ({ webContents }, url) => {
    const page = webContents
      .getAllWebContents()
      .find((c) => c.getURL() === url)!;
    await page.executeJavaScript("window.onbeforeunload=null;void 0");
    page.close();
  }, url);
  await expect
    .poll(
      async () =>
        (
          await app.cli<{ error?: string }>(
            "browser",
            "inspect",
            "--id",
            browser.id,
          )
        ).error,
    )
    .toContain("closed itself");
  await expect(tab(browser.paneId)).toHaveAttribute("data-pinned", "true");
  await app.cli("browser", "reload", "--id", browser.id);
  await expect
    .poll(
      async () =>
        (
          await app.cli<{ error?: string }>(
            "browser",
            "inspect",
            "--id",
            browser.id,
          )
        ).error,
    )
    .toBeUndefined();
  await expect(tab(browser.paneId)).toHaveAttribute("data-pinned", "true");
});
