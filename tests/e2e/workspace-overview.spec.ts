import {
  openWorkspaceState,
  readWorkspaceState,
  writeWorkspaceState,
} from "../support/workspace-state";
import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { ChatApp } from "./helpers/chat-fixture/harness";
import { modifier } from "./helpers/workspace-app";
import type { AppState } from "../../src/types";

const execute = promisify(execFile);
let app: ChatApp;
test.beforeEach(async () => {
  app = new ChatApp();
  await app.prepare();
  await app.start();
});
test.afterEach(async () => app.cleanup());
const overview = () =>
  app.page.getByRole("dialog", { name: "Overview", exact: true });
const search = () =>
  overview().getByRole("combobox", { name: "Search Overview" });
const row = (kind: string, id: string) =>
  overview().locator(
    `button.overview-item[data-navigation-key="${kind}:${id}"]`,
  );
async function show() {
  await app.page.keyboard.press(`${modifier}+Shift+O`);
  await expect(search()).toBeFocused();
}
async function action(kind: string, id: string, label: string) {
  await row(kind, id).hover();
  await search().press("Shift+F10");
  await app.page
    .locator(".context-menu")
    .getByRole("button", { name: label, exact: true })
    .click();
}

test("Overview keeps selection separate from activation, preserves workspace groups and returns the exact draft focus", async ({}, info) => {
  for (const workspace of (await app.cli<AppState>("state")).workspaces)
    await app.cli("workspace", "close", "--id", workspace.id);
  await app.command("Overview");
  await expect(overview().getByRole("status")).toHaveText("No workspaces");
  const emptyHints = overview().locator(".picker-footer");
  await expect(emptyHints.getByText("Esc", { exact: true })).toBeVisible();
  await expect(emptyHints.getByText("Enter", { exact: true })).toBeHidden();
  await expect(emptyHints.getByText("↑ ↓", { exact: true })).toBeHidden();
  await search().press("Enter");
  await expect(overview()).toBeVisible();
  await search().press("Escape");
  const first = await app.create("Invented Alpha workspace");
  const chat = await app.newChat(first, "codex");
  const label = "Shared long conversation " + "Readable words ".repeat(12);
  await app.cli("conversation", "rename", "--id", chat.id, "--name", label);
  const second = await app.create("Invented Beta workspace");
  const other = await app.newChat(second, "codex");
  await app.cli("conversation", "rename", "--id", other.id, "--name", label);
  await app.cli("conversation", "show", "--id", chat.id);
  const composer = app
    .pane(chat.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Invented draft before Overview");
  await composer.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(3, 12),
  );
  await app.cli("group", "toggle-split", "--workspace", first);
  await app.cli("group", "toggle-split", "--workspace", first);
  const before = await app.cli<AppState>("state");
  await composer.focus();
  await show();
  await expect(row("conversation", chat.id)).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(row("workspace", first)).toBeVisible();
  await expect(row("workspace", second)).toBeVisible();
  await expect(row("conversation", other.id)).toBeVisible();
  await expect(
    overview().locator(".overview-list [aria-expanded]"),
  ).toHaveCount(0);
  await search().fill("shared");
  await expect(row("conversation", chat.id)).toBeVisible();
  await expect(row("conversation", other.id)).toBeVisible();
  await expect(row("conversation", other.id)).toHaveAccessibleName(
    new RegExp(label.trim()),
  );
  await search().press("ArrowDown");
  await expect(search()).toBeFocused();
  expect((await app.cli<AppState>("state")).activeWorkspaceId).toBe(first);
  await overview().screenshot({
    path: info.outputPath("overview-long-context.png"),
  });
  await app.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(760, 700),
  );
  await app.cli(
    "settings",
    "update",
    "--values",
    JSON.stringify({ "ui.fontSize": 20 }),
  );
  await expect.poll(() => app.page.evaluate(() => innerWidth)).toBe(760);
  expect(
    await overview().evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await overview().screenshot({
    path: info.outputPath("overview-narrow-large-text.png"),
  });
  await search().press("Escape");
  await expect(composer).toBeFocused();
  expect(
    await composer.evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
    ]),
  ).toEqual([3, 12]);
  const after = await app.cli<AppState>("state");
  expect(after.workspaces.find((w) => w.id === first)?.settings).toEqual(
    before.workspaces.find((w) => w.id === first)?.settings,
  );
  expect(
    after.workspaces
      .find((w) => w.id === first)
      ?.groups.map((group) => !!group.hidden),
  ).toEqual(
    before.workspaces
      .find((w) => w.id === first)
      ?.groups.map((group) => !!group.hidden),
  );
  await app.page.getByRole("button", { name: "Overview", exact: true }).click();
  await search().fill("Beta shared");
  await row("conversation", other.id).click();
  await expect(overview()).toHaveCount(0);
  await expect(
    app
      .pane(other.paneId)
      .getByRole("textbox", { name: "Message", exact: true }),
  ).toBeFocused();
  expect((await app.cli<AppState>("state")).activeWorkspaceId).toBe(second);
  await show();
  await app.page.keyboard.press(`${modifier}+Shift+O`);
  await expect(overview()).toHaveCount(0);
});

test("Overview arrow key repeat stops at both visible ends with and without search", async ({}, info) => {
  const first = await app.create("Shared sample Alpha");
  await app.newChat(first, "codex");
  const last = await app.create("Shared sample Beta");
  await app.newChat(last, "codex");
  await app.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(760, 550),
  );
  await show();
  const results = overview().locator("button.overview-item");
  const total = await results.count();
  expect(total).toBeGreaterThan(4);
  for (const query of ["", "Shared sample"]) {
    await search().fill(query);
    await expect(results).toHaveCount(query ? 4 : total);
    for (const key of ["ArrowUp", "ArrowDown"]) {
      const isFirst = key === "ArrowUp";
      const boundary = isFirst ? results.first() : results.last();
      await results.nth(isFirst ? 1 : (await results.count()) - 2).hover();
      await app.page.keyboard.down(key);
      try {
        await expect(boundary).toHaveAttribute("aria-current", "true");
        for (let repeat = 0; repeat < 3; repeat++) {
          await app.page.keyboard.down(key);
          await expect(boundary).toHaveAttribute("aria-current", "true");
        }
      } finally {
        await app.page.keyboard.up(key);
      }
      await expect(boundary).toHaveAttribute("aria-current", "true");
      await expect(boundary).toHaveAttribute("aria-selected", "true");
      await expect(search()).toHaveAttribute(
        "aria-activedescendant",
        (await boundary.getAttribute("id"))!,
      );
      await expect(search()).toBeFocused();
      await expect(boundary).toBeInViewport();
      if (query) {
        await app.page.screenshot({
          path: info.outputPath(
            isFirst
              ? "overview-first-visible.png"
              : "overview-last-visible.png",
          ),
        });
      }
    }
  }
});

test("Overview prefers siblings and the current workspace heading when a selected tab disappears", async ({}, info) => {
  const source = await app.create("Shared route Alpha");
  const openBrowser = (workspace: string) =>
    app.cli<{ id: string; paneId: string }>(
      "browser",
      "open",
      "--workspace",
      workspace,
      "--url",
      "about:blank",
    );
  const first = await openBrowser(source);
  const second = await openBrowser(source);
  const terminal = await app.cli<{ id: string; paneId: string }>(
    "terminal",
    "open",
    "--workspace",
    source,
    "--cwd",
    app.folders[0],
  );
  const destination = await app.create("Shared route Beta");
  const other = await openBrowser(destination);
  await show();
  await search().fill("Shared route");
  const footer = overview().locator(".picker-footer");
  await row("browser", second.id).hover();
  const close = async (kind: string, id: string) => {
    await expect(row(kind, id)).toHaveAttribute("aria-current", "true");
    await expect(footer).toContainText("Close tab");
    await search().press(`${modifier}+w`);
    await expect(row(kind, id)).toHaveCount(0);
    await expect(search()).toBeFocused();
    expect((await app.state()).activeWorkspaceId).toBe(destination);
  };

  await close("browser", second.id);
  await close("terminal", terminal.id);
  await close("browser", first.id);
  await expect(row("workspace", source)).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(footer).toContainText("Close workspace");
  await expect(search()).toHaveValue("Shared route");
  await search().dispatchEvent("keydown", {
    key: "w",
    code: "KeyW",
    ctrlKey: process.platform !== "darwin",
    metaKey: process.platform === "darwin",
    repeat: true,
  });
  await expect(row("workspace", source)).toBeVisible();
  await expect(row("browser", other.id)).toBeVisible();
  await app.page.screenshot({
    path: info.outputPath("overview-workspace-after-close.png"),
  });

  const filtered = await openBrowser(source);
  await search().fill("Home");
  await row("browser", filtered.id).hover();
  await close("browser", filtered.id);
  await expect(row("workspace", source)).toHaveCount(0);
  await expect(row("workspace", destination)).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(search()).toHaveValue("Home");
});

test("Overview uses one compact selection surface with first-line controls at normal and narrow sizes", async ({}, info) => {
  const first = await app.create("Release planning");
  const chat = await app.newChat(first, "codex");
  const label =
    "Investigate keyboard navigation and preserve drafts while switching between a document, browser and conversation";
  await app.cli("conversation", "rename", "--id", chat.id, "--name", label);
  const second = await app.create("Documentation and everyday browsing");
  const other = await app.newChat(second, "codex");
  await app.cli(
    "conversation",
    "rename",
    "--id",
    other.id,
    "--name",
    "Review the contributor guide",
  );
  await app.cli(
    "browser",
    "open",
    "--workspace",
    second,
    "--url",
    "about:blank",
  );
  await app.cli("conversation", "show", "--id", chat.id);
  await app.page.keyboard.press(`${modifier}+Shift+P`);
  await app.page
    .locator("dialog.command-palette")
    .screenshot({ path: info.outputPath("commands-reference.png") });
  await app.page.keyboard.press("Escape");
  await show();
  await search().fill("a");
  await row("conversation", chat.id).hover();
  await expect(row("conversation", chat.id)).toHaveClass(/selected/);
  for (const narrow of [false, true]) {
    if (narrow) {
      await app.app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(760, 700),
      );
      await app.cli(
        "settings",
        "update",
        "--values",
        JSON.stringify({ "ui.fontSize": 20 }),
      );
    }
    await expect(row("conversation", chat.id)).toHaveAccessibleName(
      new RegExp(label),
    );
    const geometry = await row("conversation", chat.id).evaluate((button) => {
      const row = button.parentElement!;
      const label = button
        .querySelector(".overview-label")!
        .getBoundingClientRect();
      const icon = button.querySelector(".icon")!.getBoundingClientRect();
      const actions = row
        .querySelector(".overview-actions")!
        .getBoundingClientRect();
      return {
        rowHeight: row.getBoundingClientRect().height,
        labelTop: label.top,
        labelBottom: label.bottom,
        rowBottom: row.getBoundingClientRect().bottom,
        iconTop: icon.top,
        actionsTop: actions.top,
        rowBackground: getComputedStyle(row).backgroundColor,
        rowShadow: getComputedStyle(row).boxShadow,
        buttonBackground: getComputedStyle(button).backgroundColor,
        overflow: row.scrollWidth > row.clientWidth,
      };
    });
    if (!narrow) expect(geometry.rowHeight).toBeLessThanOrEqual(28);
    expect(Math.abs(geometry.iconTop - geometry.labelTop)).toBeLessThan(8);
    expect(Math.abs(geometry.actionsTop - geometry.labelTop)).toBeLessThan(8);
    expect(geometry.labelBottom).toBeLessThanOrEqual(geometry.rowBottom);
    expect(geometry.rowShadow).toBe("none");
    expect(geometry.buttonBackground).toBe("rgba(0, 0, 0, 0)");
    expect(geometry.rowBackground).toBe("rgb(69, 74, 86)");
    const parentIcon = await row("workspace", first)
      .locator(".navigation-item-icon")
      .boundingBox();
    const childIcon = await row("conversation", chat.id)
      .locator(".navigation-item-icon")
      .boundingBox();
    expect(childIcon!.x - parentIcon!.x).toBe(16);
    expect(geometry.overflow).toBe(false);
    await app.page.screenshot({
      path: info.outputPath(
        narrow ? "overview-mixed-narrow.png" : "overview-mixed-normal.png",
      ),
    });
  }
  const actions = overview().getByRole("gridcell", {
    name: `Actions for ${label}`,
    exact: true,
  });
  await actions.hover();
  const actionBackground = await actions.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  expect(actionBackground).toMatch(
    /(?:color\(srgb .* \/ 0\.08\)|rgba\(.*0\.08\))/,
  );
  await app.page.screenshot({
    path: info.outputPath("overview-actions-hover.png"),
  });
  await search().press("Tab");
  const filter = overview().getByRole("button", {
    name: "Show closed workspaces and cancelled reviews",
  });
  await expect(filter).toBeFocused();
  await filter.press("Tab");
  await expect(actions).toBeFocused();
  expect(
    await actions.evaluate((node) => getComputedStyle(node).outlineStyle),
  ).toBe("solid");
  await app.page.screenshot({
    path: info.outputPath("overview-actions-focus.png"),
  });
  await search().press("Escape");
  await expect(
    app
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true }),
  ).toBeFocused();
});

test("Overview exposes valid workspace groups and independently reachable row actions without tree nesting", async ({}, info) => {
  const first = await app.create("Invented grouped Alpha");
  const chat = await app.newChat(first, "codex");
  await app.cli(
    "conversation",
    "rename",
    "--id",
    chat.id,
    "--name",
    "Alpha complete conversation label",
  );
  const terminal = await app.cli<{ id: string; paneId: string }>(
    "terminal",
    "open",
    "--workspace",
    first,
    "--cwd",
    app.folders[0],
  );
  const second = await app.create("Invented grouped Beta");
  const browser = await app.cli<{ id: string; paneId: string }>(
    "browser",
    "open",
    "--workspace",
    second,
    "--url",
    "about:blank",
  );
  await show();
  const grid = overview().getByRole("grid", { name: "Workspace Overview" });
  await expect(search()).toHaveAttribute("aria-haspopup", "grid");
  await expect(
    grid.getByRole("rowgroup", { name: "Invented grouped Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    grid.getByRole("rowgroup", { name: "Invented grouped Beta", exact: true }),
  ).toBeVisible();
  await expect(row("conversation", chat.id)).toBeVisible();
  await expect(row("terminal", terminal.id)).toBeVisible();
  await expect(row("browser", browser.id)).toBeVisible();
  await expect(overview().getByRole("treeitem")).toHaveCount(0);
  await expect(overview().locator(".overview-disclosure")).toHaveCount(0);
  const structure = await grid.evaluate((root) =>
    [...root.children].every(
      (group) =>
        group.getAttribute("role") === "rowgroup" &&
        [...group.children].every(
          (row) =>
            row.getAttribute("role") === "row" &&
            [...row.children].every(
              (cell) => cell.getAttribute("role") === "gridcell",
            ),
        ),
    ),
  );
  expect(structure).toBe(true);
  const before = await app.cli<AppState>("state");
  await row("conversation", chat.id).hover();
  await expect(search()).toBeFocused();
  await expect(search()).toHaveAttribute(
    "aria-activedescendant",
    (await row("conversation", chat.id).getAttribute("id")) as string,
  );
  await search().press("Tab");
  const filter = overview().getByRole("button", {
    name: "Show closed workspaces and cancelled reviews",
  });
  await expect(filter).toBeFocused();
  await filter.press("Tab");
  const actions = overview().getByRole("gridcell", {
    name: "Actions for Alpha complete conversation label",
    exact: true,
  });
  await expect(actions).toBeFocused();
  const popup = app.page.getByRole("dialog", { name: "Actions", exact: true });
  await expect(actions).toHaveAttribute("aria-haspopup", "dialog");
  await actions.press("Enter");
  await expect(popup).toBeVisible();
  await expect(actions).toHaveAttribute("aria-expanded", "true");
  await expect(actions).toHaveAttribute(
    "aria-controls",
    (await popup.getAttribute("id"))!,
  );
  const initial = popup.locator("button:focus");
  await expect(initial).toHaveCount(1);
  const focusedName = await initial.getAttribute("aria-label");
  await app.page.keyboard.press("ArrowDown");
  await expect(initial).not.toHaveAttribute("aria-label", focusedName!);
  await app.page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(actions).not.toHaveAttribute("aria-expanded", "true");
  await expect(actions).toBeFocused();
  await search().press("Shift+F10");
  await expect(popup).toBeVisible();
  await app.page.keyboard.press("Escape");
  await expect(search()).toBeFocused();
  await actions.focus();
  await actions.press("Enter");
  await app.page
    .locator(".context-menu")
    .getByRole("button", { name: "Pin tab", exact: true })
    .click();
  await expect(row("conversation", chat.id)).toHaveAccessibleName(/Pinned/);
  expect((await app.cli<AppState>("state")).activeWorkspaceId).toBe(
    before.activeWorkspaceId,
  );
  await expect(search()).toBeFocused();
  await action("conversation", chat.id, "Rename");
  const name = overview().getByRole("textbox", {
    name: "Conversation name",
    exact: true,
  });
  await expect(name).toBeFocused();
  expect(await name.evaluate((input) => !input.closest("button"))).toBe(true);
  await name.fill("Cancelled grouped label");
  await name.press("Escape");
  await expect(row("conversation", chat.id)).toContainText(
    "Alpha complete conversation label",
  );
  await search().fill("Alpha complete");
  await expect(row("workspace", first)).toBeVisible();
  await expect(row("workspace", second)).toHaveCount(0);
  await expect(row("terminal", terminal.id)).toHaveCount(0);
  await app.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(760, 720),
  );
  await app.cli(
    "settings",
    "update",
    "--values",
    JSON.stringify({ "ui.fontSize": 20 }),
  );
  await expect.poll(() => app.page.evaluate(() => innerWidth)).toBe(760);
  expect(
    await overview().evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await app.app!.evaluate(({ app }) =>
    app.setAccessibilitySupportEnabled(true),
  );
  const session = await app.page.context().newCDPSession(app.page);
  const ax = await session.send("Accessibility.getFullAXTree");
  const root = ax.nodes.find(
    (node) =>
      !node.ignored &&
      node.role?.value === "grid" &&
      node.name?.value === "Workspace Overview",
  );
  expect(root).toBeDefined();
  const nodes = new Map(ax.nodes.map((node) => [node.nodeId, node]));
  const descendants = new Set<string>();
  const visit = (id: string) => {
    if (descendants.has(id)) return;
    descendants.add(id);
    for (const child of nodes.get(id)?.childIds ?? []) visit(child);
  };
  visit(root!.nodeId);
  const exposed = ax.nodes.filter(
    (node) => descendants.has(node.nodeId) && !node.ignored,
  );
  expect(exposed.some((node) => node.role?.value === "rowgroup")).toBe(true);
  expect(
    exposed.some(
      (node) =>
        node.role?.value === "gridcell" &&
        node.name?.value?.includes("Alpha complete conversation label"),
    ),
  ).toBe(true);
  expect(exposed.some((node) => node.role?.value === "treeitem")).toBe(false);
  await writeFile(
    info.outputPath("overview-accessibility.json"),
    JSON.stringify(exposed, null, 2),
  );
  await session.detach();
  await overview().screenshot({
    path: info.outputPath("overview-grouped-filtered.png"),
  });
  await search().fill("no matching invented object");
  await expect(grid).toBeHidden();
  await expect(search()).not.toHaveAttribute("aria-activedescendant");
  await expect(overview()).toContainText("No matching items");
  await search().fill("");
  await expect(row("terminal", terminal.id)).toBeVisible();
  await overview().screenshot({
    path: info.outputPath("overview-grouped-all.png"),
  });
});

test("Overview rename, pin, move and shared closure actions preserve the query and object identity", async () => {
  const first = await app.create("Invented source");
  const chat = await app.newChat(first, "codex");
  await app.cli(
    "conversation",
    "rename",
    "--id",
    chat.id,
    "--name",
    "Invented chosen conversation",
  );
  const second = await app.create("Invented destination");
  await show();
  await search().fill("chosen");
  await action("conversation", chat.id, "Rename");
  const name = overview().getByRole("textbox", {
    name: "Conversation name",
    exact: true,
  });
  await name.fill("Cancelled label");
  await name.press("Escape");
  await expect(search()).toHaveValue("chosen");
  await expect(row("conversation", chat.id)).toContainText(
    "Invented chosen conversation",
  );
  await action("conversation", chat.id, "Rename");
  await name.fill("Unrelated renamed title");
  await name.press("Enter");
  await expect(search()).toBeFocused();
  await expect(row("conversation", chat.id)).toContainText(
    "Unrelated renamed title",
  );
  await action("conversation", chat.id, "Pin tab");
  await expect(row("conversation", chat.id)).toHaveAccessibleName(/Pinned/);
  await expect(search()).toHaveValue("chosen");
  await action("conversation", chat.id, "Unpin tab");
  await action("conversation", chat.id, "Move to workspace...");
  const move = app.page.getByRole("dialog", {
    name: "Move conversation to workspace",
    exact: true,
  });
  await move.getByRole("textbox").press("Escape");
  await expect(search()).toBeFocused();
  await expect(search()).toHaveValue("chosen");
  await action("conversation", chat.id, "Move to workspace...");
  await move
    .getByRole("button", { name: "Invented destination", exact: true })
    .click();
  await expect(row("workspace", second)).toBeVisible();
  await expect(row("workspace", first)).toHaveCount(0);
  expect((await app.inspect(chat.id)).nativeId).toBe(chat.nativeId);
  await action("conversation", chat.id, "Close tab");
  await expect(row("conversation", chat.id)).toBeVisible();
  await action("conversation", chat.id, "Open conversation");
  await expect(
    app
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true }),
  ).toBeFocused();
  await show();
  await app.stop();
  await app.start();
  await expect(overview()).toHaveCount(0);
  await show();
  await search().fill("Unrelated renamed");
  await expect(row("conversation", chat.id)).toBeVisible();
  expect(
    (await app.cli<AppState>("state")).conversations.find(
      (c) => c.id === chat.id,
    )?.workspaceId,
  ).toBe(second);
  await search().fill("Invented destination");
  await app.app!.evaluate(({ dialog }) => {
    Object.assign(dialog, {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    });
  });
  await action("workspace", second, "Add folder...");
  await expect(search()).toBeFocused();
  await expect(search()).toHaveValue("Invented destination");
  await app.app!.evaluate(({ dialog }, folder) => {
    Object.assign(dialog, {
      showOpenDialog: async () => ({ canceled: false, filePaths: [folder] }),
    });
  }, app.folders[0]);
  await action("workspace", second, "Add folder...");
  await expect
    .poll(() => app.workspace(second).then((w) => w.folders))
    .toContain(app.folders[0]);
  await expect(search()).toBeFocused();
  await action("workspace", second, "New chat");
  await expect(overview()).toHaveCount(0);
  const draft = (await app.cli<AppState>("state")).workspaces.find(
    (w) => w.id === second,
  )!.activePaneId;
  await expect(
    app.pane(draft).getByRole("textbox", { name: "Message", exact: true }),
  ).toBeFocused();
  const handoff = await app.cli<{ paneId: string }>(
    "conversation",
    "handoff",
    "--id",
    chat.id,
  );
  await show();
  await search().fill("Unrelated renamed");
  await action("conversation", chat.id, "Open CLI terminal");
  await expect(overview()).toHaveCount(0);
  await expect(
    app.pane(handoff.paneId).locator(".xterm-helper-textarea"),
  ).toBeFocused();
});

test("Overview keeps browser pixels visible and restores native focus and state", async ({}, info) => {
  const workspace = await app.create("Invented browser workspace");
  const file = path.join(app.folders[0], "overview-page.html");
  await writeFile(
    file,
    `<!doctype html><title>Invented Overview form</title>
     <style>body {background:#147dc1;height:250vh}
     input {position:fixed;left:12px;top:12px}</style>
     <input id="field" value="Invented native draft">
     <script>window.fixtureIdentity = Math.random()</script>`,
  );
  const browser = await app.cli<{ id: string; paneId: string }>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    pathToFileURL(file).href,
  );
  await expect
    .poll(() =>
      app
        .app!.context()
        .pages()
        .some((page) => page.url() === pathToFileURL(file).href),
    )
    .toBe(true);
  const site = app
    .app!.context()
    .pages()
    .find((page) => page.url() === pathToFileURL(file).href)!;
  const identity = await site.evaluate(() => {
    window.scrollTo(0, 240);
    return (window as Window & { fixtureIdentity?: number }).fixtureIdentity;
  });
  await expect.poll(() => site.evaluate(() => window.scrollY)).toBe(240);
  await site.locator("input").focus();
  await site
    .locator("input")
    .evaluate((node: HTMLInputElement) => node.setSelectionRange(3, 11));
  await app.app!.evaluate(({ webContents }, url) => {
    const contents = webContents
      .getAllWebContents()
      .find((wc) => wc.getURL() === url)!;
    contents.focus();
    const modifiers: ("meta" | "control" | "shift")[] = [
      process.platform === "darwin" ? "meta" : "control",
      "shift",
    ];
    contents.sendInputEvent({ type: "keyDown", keyCode: "O", modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode: "O", modifiers });
  }, pathToFileURL(file).href);
  await expect(search()).toBeFocused();
  const backdrop = app
    .pane(browser.paneId)
    .locator(".browser-overview-backdrop");
  await expect(backdrop).toBeVisible();
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
      app.app!.evaluate(async ({ BrowserWindow }, point) => {
        const image =
          await BrowserWindow.getAllWindows()[0].webContents.capturePage({
            ...point,
            width: 1,
            height: 1,
          });
        const [blue, green, red] = image.toBitmap();
        return (
          Math.abs(red - 20) + Math.abs(green - 125) + Math.abs(blue - 193)
        );
      }, sample),
    )
    .toBeLessThan(15);
  await app.page.screenshot({
    path: info.outputPath("overview-over-browser.png"),
  });
  await search().fill("form");
  await search().press("Escape");
  await expect(backdrop).toHaveCount(0);
  expect(
    await site.evaluate(() => ({
      identity: (window as Window & { fixtureIdentity?: number })
        .fixtureIdentity,
      scroll: window.scrollY,
    })),
  ).toEqual({ identity, scroll: 240 });

  await expect
    .poll(() =>
      app.app!.evaluate(({ webContents }) =>
        webContents.getFocusedWebContents()?.getURL(),
      ),
    )
    .toBe(pathToFileURL(file).href);
  await site.keyboard.type("replacement");
  await expect(site.locator("input")).toHaveValue("Invreplacementtive draft");
  await app.app!.evaluate(({ dialog }) => {
    Object.assign(globalThis, {
      overviewCloseResponse: 0,
      overviewClosePrompts: 0,
    });
    Object.assign(dialog, {
      showMessageBox: async () => {
        (globalThis as any).overviewClosePrompts++;
        return {
          response: (globalThis as any).overviewCloseResponse,
          checkboxChecked: false,
        };
      },
    });
  });
  await site.evaluate(() => {
    window.onbeforeunload = () => false;
  });
  await app.app!.evaluate(({ webContents }, url) => {
    const contents = webContents
      .getAllWebContents()
      .find((wc) => wc.getURL() === url)!;
    contents.focus();
    const modifiers: ("meta" | "control" | "shift")[] = [
      process.platform === "darwin" ? "meta" : "control",
      "shift",
    ];
    contents.sendInputEvent({ type: "keyDown", keyCode: "O", modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode: "O", modifiers });
  }, pathToFileURL(file).href);
  await expect(search()).toBeFocused();
  await search().fill("form");
  await action("browser", browser.id, "Close tab");
  await expect
    .poll(() =>
      app.app!.evaluate(() => (globalThis as any).overviewClosePrompts),
    )
    .toBe(1);
  await expect(row("browser", browser.id)).toBeVisible();
  await expect(search()).toHaveValue("form");
  await app.app!.evaluate(() => {
    (globalThis as any).overviewCloseResponse = 1;
  });
  await action("browser", browser.id, "Close tab");
  await expect(row("browser", browser.id)).toHaveCount(0);
  await expect(search()).toBeFocused();
  await search().press("Escape");
  await app.cli("pane", "reopen", "--workspace", workspace);
  await expect(app.pane(browser.paneId)).toBeVisible();
});

test("Overview keeps split browser backdrops in their own panes and discards them on workspace change", async () => {
  const other = await app.create("Invented empty workspace");
  const workspace = await app.create("Invented split browser workspace");
  async function openPage(name: string, sourcePane?: string) {
    const file = path.join(app.folders[0], name + ".html");
    await writeFile(
      file,
      `<!doctype html><title>Invented ${name}</title><p>Fixture page</p>`,
    );
    return app.cli<{ id: string; paneId: string }>(
      "browser",
      "open",
      "--workspace",
      workspace,
      "--url",
      pathToFileURL(file).href,
      ...(sourcePane ? ["--source-pane", sourcePane, "--focus", "true"] : []),
    );
  }
  const left = await openPage("alpha");
  const split = await app.cli<{ paneId: string }>(
    "pane",
    "split",
    "--workspace",
    workspace,
    "--id",
    left.paneId,
    "--direction",
    "right",
  );
  const right = await openPage("beta", split.paneId);
  await expect
    .poll(async () => {
      const state = await app.cli<AppState>("state");
      return [left, right].map(
        ({ id }) =>
          !!state.browsers.find((browser) => browser.id === id)?.visible,
      );
    })
    .toEqual([true, true]);
  const image = (pane: string) =>
    app.pane(pane).locator(".browser-overview-backdrop");
  await show();
  for (const pane of [left.paneId, right.paneId]) {
    const view = app.pane(pane).locator(".browser-content");
    await expect(image(pane)).toBeVisible();
    expect(await image(pane).boundingBox()).toEqual(await view.boundingBox());
  }
  await expect
    .poll(async () => {
      const state = await app.cli<AppState>("state");
      return [left, right].map(
        ({ id }) =>
          state.browsers.find((browser) => browser.id === id)?.visible,
      );
    })
    .toEqual([false, false]);
  const box = (await image(left.paneId).boundingBox())!;
  await app.page.mouse.click(box.x + 12, box.y + box.height - 12);
  await expect(overview()).toHaveCount(0);
  await expect(app.page.locator(".browser-overview-backdrop")).toHaveCount(0);
  await show();
  await expect(image(left.paneId)).toBeVisible();
  await app.cli("workspace", "focus", "--id", other);
  await expect(app.page.locator(".browser-overview-backdrop")).toHaveCount(0);
  await search().press("Escape");
  await expect(overview()).toHaveCount(0);
  await app.cli("workspace", "focus", "--id", workspace);
  await expect(app.page.locator(".browser-overview-backdrop")).toHaveCount(0);

  // A deliberately delayed capture must not hold the other visible pane or input.
  const leftUrl = pathToFileURL(path.join(app.folders[0], "alpha.html")).href;
  await expect
    .poll(async () => {
      const state = await app.cli<AppState>("state");
      return [left, right].every(
        ({ id }) =>
          state.browsers.find((browser) => browser.id === id)?.visible,
      );
    })
    .toBe(true);
  await app.app!.evaluate(({ webContents }, url) => {
    const contents = webContents
      .getAllWebContents()
      .find((page) => page.getURL() === url)!;
    const capture = contents.capturePage.bind(contents);
    contents.capturePage = async (...args) => {
      contents.capturePage = capture;
      const frame = await capture(...args);
      await new Promise<void>((resolve) => {
        (process as import("node:events").EventEmitter).once(
          "fixture-release-overview-capture",
          resolve,
        );
      });
      return frame;
    };
  }, leftUrl);
  await show();
  await expect(overview()).toHaveCSS("opacity", "1");
  await expect(image(left.paneId)).toHaveCount(0);
  await expect(image(right.paneId)).toHaveJSProperty("complete", true);
  await search().pressSequentially("beta");
  await expect(search()).toHaveValue("beta");
  await app.app!.evaluate(() => {
    (process as import("node:events").EventEmitter).emit(
      "fixture-release-overview-capture",
    );
  });
  await expect(image(left.paneId)).toHaveCount(0);
  await search().press("Escape");
  await expect(overview()).toHaveCount(0);
});

test("Overview stages browser pixels before native hide, accepts early input and ignores cancelled handoffs", async ({}, info) => {
  test.skip(
    process.platform !== "linux",
    "Actual pointer input uses isolated X11",
  );
  const workspace = await app.create("Invented overview handoff");
  const file = path.join(app.folders[0], "overview-handoff.html");
  await writeFile(
    file,
    `<!doctype html><title>Invented handoff page</title>
     <style>:root {background:#147dc1}</style>
     <input value="Invented draft">
     <script>window.fixtureClicks = 0;
     addEventListener("pointerdown", () => window.fixtureClicks++);</script>`,
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
  const chat = await app.newChat(workspace, "codex");
  const left = (await app.cli<AppState>("state")).workspaces
    .find((item) => item.id === workspace)!
    .groups.find((group) => group.paneIds.includes(browser.paneId))!;
  await app.cli(
    "group",
    "split",
    "--workspace",
    workspace,
    "--id",
    left.id,
    "--direction",
    "right",
    "--pane-id",
    chat.paneId,
  );

  const composer = app
    .pane(chat.paneId)
    .getByRole("textbox", { name: "Message" });
  const openingFixture = await app.app!.evaluate(
    ({ BrowserWindow, ipcMain, WebContentsView }, url) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(760, 620);
      const child = win.contentView.children.find(
        (view) =>
          view instanceof WebContentsView && view.webContents.getURL() === url,
      ) as Electron.WebContentsView;
      const gate = {
        pending: false,
        release: () => {},
        visible: () => child.getVisible(),
      };
      const channel = "cod:browser-hide-for-overview";
      const handler = (
        ipcMain as unknown as {
          _invokeHandlers: Map<
            string,
            (event: Electron.IpcMainInvokeEvent, opening: number) => boolean
          >;
        }
      )._invokeHandlers.get(channel)!;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, opening: number) => {
        await new Promise<void>((resolve) => {
          gate.pending = true;
          gate.release = resolve;
        });
        gate.pending = false;
        return handler(event, opening);
      });
      Object.assign(globalThis, { overviewHandoffFixture: gate });
      return win.getNativeWindowHandle().readUInt32LE(0);
    },
    url,
  );
  await execute("xdotool", ["windowfocus", "--sync", String(openingFixture)]);
  const site = app
    .app!.context()
    .pages()
    .find((page) => page.url() === url)!;
  const native = (action: "read" | "release") =>
    app.app!.evaluate((_electron, action) => {
      const gate = (
        globalThis as unknown as {
          overviewHandoffFixture: {
            pending: boolean;
            visible: () => boolean;
            release: () => void;
          };
        }
      ).overviewHandoffFixture;
      if (action === "release") gate.release();
      return { pending: gate.pending, visible: gate.visible() };
    }, action);
  const backdrop = app
    .pane(browser.paneId)
    .locator(".browser-overview-backdrop");
  const browserPoint = await app
    .pane(browser.paneId)
    .locator(".browser-content")
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        x: Math.floor(bounds.x + 16),
        y: Math.floor(bounds.bottom - 20),
      };
    });
  const nativeWindowPoint = await app.app!.evaluate(
    ({ BrowserWindow }, point) => {
      const bounds = BrowserWindow.getAllWindows()[0].getContentBounds();
      return { x: bounds.x + point.x, y: bounds.y + point.y };
    },
    browserPoint,
  );
  const clickPagePoint = () =>
    execute("xdotool", [
      "mousemove",
      "--sync",
      String(nativeWindowPoint.x),
      String(nativeWindowPoint.y),
      "click",
      "1",
    ]);
  const captureScreen = async (name: string) => {
    const screenShot = await app.app!.evaluate(
      async ({ desktopCapturer, screen }, point) => {
        const display = screen.getPrimaryDisplay();
        const [source] = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: display.size,
        });
        const image = source.thumbnail;
        const badge = image.crop({ ...point, width: 1, height: 1 });
        const [blue, green, red] = badge.toBitmap();
        return {
          bluePage: blue > green + 20 && green > red + 40,
          png: image.toPNG().toString("base64"),
        };
      },
      nativeWindowPoint,
    );
    expect(screenShot.bluePage).toBe(true);
    await writeFile(
      info.outputPath(name + ".png"),
      Buffer.from(screenShot.png, "base64"),
    );
  };
  await app.cli(
    "pane",
    "focus",
    "--workspace",
    workspace,
    "--id",
    browser.paneId,
  );
  await app.app!.evaluate(
    ({ webContents }, url) =>
      webContents
        .getAllWebContents()
        .find((page) => page.getURL() === url)
        ?.focus(),
    url,
  );
  await execute("xdotool", ["key", "--clearmodifiers", "ctrl+shift+o"]);
  await expect
    .poll(() => native("read"))
    .toEqual({ pending: true, visible: true });
  await expect(overview()).toHaveCSS("opacity", "0");
  await expect(backdrop).toHaveJSProperty("complete", true);
  await captureScreen("overview-native-handoff-before-hide");
  await execute("xdotool", ["key", "--clearmodifiers", "h"]);
  await expect(search()).toHaveValue("h");
  await clickPagePoint();
  expect(
    await site.evaluate(
      () => (window as Window & { fixtureClicks?: number }).fixtureClicks,
    ),
  ).toBe(0);
  const focusAfterClick = await app.app!.evaluate(
    ({ BrowserWindow, webContents }) =>
      BrowserWindow.getAllWindows()[0].webContents ===
      webContents.getFocusedWebContents(),
  );
  await info.attach("overview-shell-focus-after-native-click.json", {
    body: JSON.stringify({
      shellWebContents: focusAfterClick,
      shellDocument: await app.page.evaluate(() => document.hasFocus()),
      searchInput: await search().evaluate(
        (input) => input === document.activeElement,
      ),
    }),
    contentType: "application/json",
  });
  await execute("xdotool", ["type", "andoff"]);
  await expect(search()).toHaveValue("handoff");
  await native("release");
  await expect(overview()).toHaveCSS("opacity", "1");
  await expect
    .poll(() => native("read"))
    .toEqual({ pending: false, visible: false });
  await captureScreen("overview-native-handoff-after-hide");
  await clickPagePoint();
  await expect(overview()).toHaveCount(0);
  await expect(backdrop).toHaveCount(0);
  await expect
    .poll(() =>
      app.app!.evaluate(({ webContents }) =>
        webContents.getFocusedWebContents()?.getURL(),
      ),
    )
    .toBe(url);

  await app.cli("pane", "focus", "--workspace", workspace, "--id", chat.paneId);
  await composer.focus();
  await app.page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect
    .poll(() => native("read"))
    .toEqual({ pending: true, visible: true });
  await expect(overview()).toHaveCSS("opacity", "0");
  await execute("xdotool", ["key", "--clearmodifiers", "Escape"]);
  await expect(overview()).toHaveCount(0);
  await expect(backdrop).toHaveCount(0);
  await native("release");
  await expect
    .poll(() => native("read"))
    .toEqual({ pending: false, visible: true });
  expect(
    await site.evaluate(
      () => (window as Window & { fixtureClicks?: number }).fixtureClicks,
    ),
  ).toBe(0);
});

test("Overview reconciles review, streaming and removal updates without losing input, selected IDs or closure guards", async () => {
  const workspace = await app.create("Invented guarded workspace");
  await app.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    app.folders[0],
  );
  const chat = await app.newChat(workspace, "codex");
  await app.cli(
    "conversation",
    "rename",
    "--id",
    chat.id,
    "--name",
    "Invented guarded conversation",
  );
  const neighbor = await app.newChat(workspace, "codex");
  await app.cli(
    "conversation",
    "rename",
    "--id",
    neighbor.id,
    "--name",
    "Invented guarded neighbor",
  );
  const review = await app.cli<{ reviewId: string; paneId: string }>(
    "review",
    "open-document",
    "--workspace",
    workspace,
    "--path",
    app.file,
    "--conversation",
    chat.id,
  );
  await app.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    review.paneId,
  );
  await show();
  await search().fill("spec.md");
  await expect(row("review", review.reviewId)).toBeVisible();
  await row("review", review.reviewId).hover();
  await search().press("Enter");
  await expect(app.page.locator(".review-body")).toBeVisible();
  await show();
  await search().fill("guarded");
  await search().evaluate((node) =>
    Object.assign(window, { overviewInputIdentity: node }),
  );
  await app.send(chat.id, "Invented background streaming [hold]");
  await expect(row("conversation", chat.id).locator("..")).toHaveAttribute(
    "data-status",
    "review",
  );
  await expect(search()).toHaveValue("guarded");
  expect(
    await search().evaluate(
      (node) => node === (window as any).overviewInputIdentity,
    ),
  ).toBe(true);
  await row("conversation", chat.id).hover();
  await search().press("Shift+F10");
  await expect(
    app.page
      .locator(".context-menu")
      .getByRole("button", { name: "Remove from workspace", exact: true }),
  ).toBeDisabled();
  await app.page.keyboard.press("Escape");
  await expect(search()).toBeFocused();
  await expect
    .poll(async () => (await app.inspect(chat.id)).status)
    .toBe("working");
  await search().press(`${modifier}+Shift+W`);
  await expect(row("conversation", chat.id)).toBeVisible();
  expect((await app.inspect(chat.id)).status).toBe("working");
  await action("workspace", workspace, "Close workspace");
  const guard = app.page.getByRole("dialog", {
    name: "Close workspace",
    exact: true,
  });
  const cancel = guard.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeFocused();
  await expect(cancel.locator("kbd")).toHaveText("Esc");
  await expect(
    guard
      .getByRole("button", { name: "Stop and close", exact: true })
      .locator("kbd"),
  ).toHaveCount(0);
  await cancel.press("Escape");
  await expect(search()).toHaveValue("guarded");
  await expect(search()).toBeFocused();
  await app.cli(
    "conversation",
    "rename",
    "--id",
    chat.id,
    "--name",
    "Invented guarded updated label",
  );
  await expect(row("conversation", chat.id)).toContainText("updated label");
  expect(
    await search().evaluate(
      (node) => node === (window as any).overviewInputIdentity,
    ),
  ).toBe(true);
  await app.cli("conversation", "interrupt", "--id", chat.id);
  await search().fill("guarded updated");
  await row("conversation", chat.id).hover();
  await app.cli(
    "conversation",
    "rename",
    "--id",
    chat.id,
    "--name",
    "Changed without query match",
  );
  await expect(row("conversation", chat.id)).toHaveCount(0);
  await expect(search()).toHaveValue("guarded updated");
  await search().press("Enter");
  await expect(overview()).toBeVisible();
  await search().fill("guarded");
  await row("conversation", neighbor.id).hover();
  await expect
    .poll(() => app.inspect(neighbor.id).then((c) => c.status))
    .toBe("ready");
  await app.cli("conversation", "remove", "--id", neighbor.id);
  await expect(row("conversation", neighbor.id)).toHaveCount(0);
  await expect(row("review", review.reviewId)).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("Overview uses the shared live keymap and reset while preserving native page authority", async () => {
  const workspace = await app.create("Invented keymap workspace");
  const chat = await app.newChat(workspace, "codex");
  const input = app
    .pane(chat.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Invented keymap draft");
  await writeFile(
    path.join(app.data, "keymap.json"),
    JSON.stringify({ "workspace.overview": ["Mod+Shift+U"] }),
  );
  await expect(
    app.page.getByRole("button", { name: "Overview", exact: true }),
  ).toHaveAttribute("title", /Shift\+U/);
  await input.focus();
  await app.page.keyboard.press(`${modifier}+Shift+O`);
  await expect(overview()).toHaveCount(0);
  await app.page.keyboard.press(`${modifier}+Shift+U`);
  await expect(search()).toBeFocused();
  await app.page.keyboard.press(`${modifier}+Shift+U`);
  await expect(input).toBeFocused();
  await writeFile(path.join(app.data, "keymap.json"), "{}\n");
  await expect(
    app.page.getByRole("button", { name: "Overview", exact: true }),
  ).toHaveAttribute("title", /Shift\+O/);
  await show();
  await search().press("Escape");
  await expect(input).toHaveValue("Invented keymap draft");
});

test("A newer Overview activation wins over an earlier accepted navigation with a delayed reply", async () => {
  const first = await app.create("Invented earlier target");
  const chat = await app.newChat(first, "codex");
  const second = await app.create("Invented newer target");
  const newer = await app.newChat(second, "codex");
  await app.app!.evaluate(({ ipcMain }, earlier) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: any[]) => unknown>;
      }
    )._invokeHandlers;
    const original = handlers.get("cod:invoke")!;
    ipcMain.removeHandler("cod:invoke");
    ipcMain.handle("cod:invoke", async (event, request) => {
      const result = await original(event, request);
      if (
        request.op === "workspace.focus" &&
        request.id === earlier &&
        !(globalThis as any).overviewReplyHeld
      ) {
        (globalThis as any).overviewReplyHeld = true;
        await new Promise<void>((resolve) => {
          (globalThis as any).releaseOverviewReply = resolve;
        });
      }
      return result;
    });
  }, first);
  await show();
  await search().fill("earlier");
  await row("conversation", chat.id).click();
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).overviewReplyHeld))
    .toBe(true);
  await show();
  await search().fill("newer");
  await row("conversation", newer.id).click();
  const input = app
    .pane(newer.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeFocused();
  await app.app!.evaluate(() => (globalThis as any).releaseOverviewReply());
  await app.page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(input).toBeFocused();
  expect((await app.cli<AppState>("state")).activeWorkspaceId).toBe(second);
});

test("A failed Overview rename retains the edit and query and supports a successful retry", async () => {
  const workspace = await app.create("Invented rename source");
  await show();
  await search().fill("Invented");
  await action("workspace", workspace, "Rename workspace");
  const name = overview().getByRole("textbox", {
    name: "Workspace name",
    exact: true,
  });
  await name.fill("Invented rename recovered");
  using db = openWorkspaceState(app.data);
  db.exec(`
    CREATE TRIGGER fail_workspace_rename BEFORE UPDATE ON records
    WHEN NEW.kind = 'workspace'
      AND OLD.id = '${workspace}'
      AND json_extract(NEW.body, '$.name') = 'Invented rename recovered'
    BEGIN SELECT RAISE(ABORT, 'Invented rename rejected'); END;
  `);
  try {
    await name.press("Enter");
    await expect(overview().getByRole("alert")).toContainText(
      "Invented rename rejected",
    );
    await expect(name).toHaveValue("Invented rename recovered");
    await expect(search()).toHaveValue("Invented");
    expect(
      readWorkspaceState(app.data).workspaces.find(({ id }) => id === workspace)
        ?.name,
    ).toBe("Invented rename source");
  } finally {
    db.exec("DROP TRIGGER fail_workspace_rename");
  }
  await name.press("Enter");
  await expect(search()).toBeFocused();
  await expect(row("workspace", workspace)).toContainText(
    "Invented rename recovered",
  );
  await expect(overview().getByRole("alert")).toHaveCount(0);
});

test("Overview cancellation restores the caret synchronously and delayed close cleanup preserves a newer target", async () => {
  const workspace = await app.create("Invented cancellation workspace");
  const chat = await app.newChat(workspace, "codex");
  const input = app
    .pane(chat.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Invented cancellation draft");
  await input.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(3, 9),
  );
  await input.focus();
  await show();
  await overview().evaluate((dialog) => {
    const hold = (event: Event) => {
      event.stopImmediatePropagation();
      (window as any).releaseOverviewClose = () => {
        dialog.removeEventListener("close", hold, true);
        dialog.dispatchEvent(new Event("close", { bubbles: true }));
      };
    };
    dialog.addEventListener("close", hold, true);
  });
  await search().press("Escape");
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
    ]),
  ).toEqual([3, 9]);
  const header = app.page.getByRole("button", {
    name: "Overview",
    exact: true,
  });
  await expect
    .poll(() =>
      app.page.evaluate(() => typeof (window as any).releaseOverviewClose),
    )
    .toBe("function");
  await header.focus();
  await app.page.evaluate(() => (window as any).releaseOverviewClose());
  await app.page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(header).toBeFocused();
});

test("Overview returns to a real terminal and browsing a dormant page never loads it before activation", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "text/html");
    response.end(
      '<!doctype html><title>Invented dormant page</title><input autofocus value="Invented page draft">',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const first = await app.create("Invented terminal workspace");
    const terminal = await app.cli<{ id: string; paneId: string }>(
      "terminal",
      "open",
      "--workspace",
      first,
      "--cwd",
      app.folders[0],
    );
    const second = await app.create("Invented dormant workspace");
    const browser = await app.cli<{ id: string }>(
      "browser",
      "open",
      "--workspace",
      second,
      "--url",
      url,
    );
    await expect.poll(() => requests).toBeGreaterThan(0);
    await app.cli("workspace", "focus", "--id", first);
    await app.stop();
    requests = 0;
    await app.start();
    const input = app.pane(terminal.paneId).locator(".xterm-helper-textarea");
    await expect(input).toBeVisible();
    await app.cli(
      "terminal",
      "write",
      "--id",
      terminal.id,
      "--data",
      "stty -echo; printf 'READY_OVERVIEW\\n'\n",
    );
    await expect
      .poll(() =>
        app
          .cli<{ output: string }>("terminal", "inspect", "--id", terminal.id)
          .then((t) => t.output),
      )
      .toContain("READY_OVERVIEW");
    await input.focus();
    const command = `printf '\\n${[...Buffer.from("OVERVIEW_PTY_OK")].map((byte) => "\\" + byte.toString(8)).join("")}\\n'`;
    const middle = Math.floor(command.length / 2);
    await app.page.keyboard.type(command.slice(0, middle));
    const pid = (
      await app.cli<{ pid: number }>("terminal", "inspect", "--id", terminal.id)
    ).pid;
    await show();
    await search().fill("terminal workspace");
    await expect(row("terminal", terminal.id)).toBeVisible();
    await action("terminal", terminal.id, "Pin tab");
    await expect(row("terminal", terminal.id)).toHaveAccessibleName(/Pinned/);
    await row("terminal", terminal.id).click();
    await expect(input).toBeFocused();
    expect(
      (
        await app.cli<{ pid: number }>(
          "terminal",
          "inspect",
          "--id",
          terminal.id,
        )
      ).pid,
    ).toBe(pid);
    await show();
    await search().fill("dormant page");
    await expect(row("browser", browser.id)).toBeVisible();
    await search().press("ArrowDown");
    await search().press("ArrowUp");
    expect(requests).toBe(0);
    await search().press("Escape");
    await expect(input).toBeFocused();
    await app.page.keyboard.type(command.slice(middle));
    await app.page.keyboard.press("Enter");
    await expect
      .poll(() =>
        app
          .cli<{ output: string }>("terminal", "inspect", "--id", terminal.id)
          .then((t) => t.output),
      )
      .toMatch(/[\r\n]OVERVIEW_PTY_OK[\r\n]/);
    expect(requests).toBe(0);
    await show();
    await search().fill("dormant page");
    await row("browser", browser.id).click();
    await expect.poll(() => requests).toBeGreaterThan(0);
    await expect
      .poll(() =>
        app.app!.evaluate(({ webContents }) =>
          webContents.getFocusedWebContents()?.getURL(),
        ),
      )
      .toBe(url);
    await app.app!.evaluate(({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((wc) => wc.getURL() === url)!;
      contents.focus();
      const modifiers: ("meta" | "control" | "shift")[] = [
        process.platform === "darwin" ? "meta" : "control",
        "shift",
      ];
      contents.sendInputEvent({ type: "keyDown", keyCode: "O", modifiers });
      contents.sendInputEvent({ type: "keyUp", keyCode: "O", modifiers });
    }, url);
    await expect(search()).toBeFocused();
    await app.page.mouse.click(
      5,
      (await app.page.evaluate(() => innerHeight)) - 5,
    );
    await expect(overview()).toHaveCount(0);
    await expect
      .poll(() =>
        app.app!.evaluate(({ webContents }) =>
          webContents.getFocusedWebContents()?.getURL(),
        ),
      )
      .toBe(url);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Overview search stays responsive with 1000 rows, retained history and attachments during background streaming", async ({}, info) => {
  test.setTimeout(120_000);
  const first = await app.create("Invented collection000");
  const chat = await app.newChat(first, "codex");
  const second = await app.create("Invented background");
  const stream = await app.newChat(second, "codex");
  const image = await app.app!.evaluate(({ nativeImage }) => {
    const bitmap = Buffer.alloc(512 * 512 * 4);
    let seed = 123456;
    for (let index = 0; index < bitmap.length; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      bitmap[index] = index % 4 === 3 ? 255 : seed >>> 24;
    }
    return nativeImage
      .createFromBitmap(bitmap, { width: 512, height: 512 })
      .toPNG()
      .toString("base64");
  });
  await app.stop();
  const state = readWorkspaceState(app.data);
  const original = state.conversations.find((c) => c.id === chat.id)!;
  const streaming = state.conversations.find((c) => c.id === stream.id)!;
  const template = state.workspaces.find((w) => w.id === first)!;
  state.workspaces = [];
  state.conversations = [];
  state.browsers = [];
  state.terminals = [];
  state.drafts = {};
  for (let w = 0; w < 50; w++) {
    const workspaceId = w === 0 ? first : `invented-workspace-${w}`;
    const panes: AppState["workspaces"][number]["panes"] = [];
    for (let c = 0; c < 20; c++) {
      const live =
        w === 0 && c === 0
          ? original
          : w === 49 && c === 0
            ? streaming
            : undefined;
      const id = live?.id ?? `invented-conversation-${w}-${c}`;
      const paneId = live?.paneId ?? `invented-pane-${w}-${c}`;
      panes.push({ kind: "conversation", id: paneId, conversationId: id });
      state.conversations.push({
        ...original,
        ...live,
        id,
        paneId,
        workspaceId,
        nativeId: live?.nativeId ?? `invented-native-${w}-${c}`,
        displayName: `Needle${String(c).padStart(3, "0")} ${"Invented readable label ".repeat(4)}`,
        status: "ready",
        error: undefined,
        messages: [
          {
            id: `invented-message-${w}-${c}`,
            order: 0,
            role: "user",
            text: "Invented retained context",
          },
        ],
        tools: [],
        turns: [],
        pendingPermissions: [],
      });
    }
    const group = `invented-group-${w}`;
    state.workspaces.push({
      ...template,
      id: workspaceId,
      name: `Invented collection${String(w).padStart(3, "0")}`,
      panes,
      activePaneId: panes[0].id,
      groups: [
        {
          id: group,
          paneIds: panes.map((p) => p.id),
          activePaneId: panes[0].id,
        },
      ],
      groupLayout: { type: "leaf", paneId: group },
      activeGroupId: group,
      closedTabs: [],
      chatDrafts: {},
      settings: template.settings,
    });
  }
  const heavy = state.conversations.at(-1)!;
  heavy.messages.push({
    id: "invented-retained-large-reply",
    order: 1,
    role: "assistant",
    text: "H".repeat(25 * 1024 * 1024),
  });
  heavy.messages[0].images = Array.from({ length: 8 }, (_, index) => ({
    name: `invented-image-${index}.png`,
    mimeType: "image/png",
    data: image,
    reference: index + 1,
  }));
  state.activeWorkspaceId = first;
  writeWorkspaceState(app.data, state);
  await app.configure({
    codex: { extraTools: 50, streamDelayMs: 500, finalDelayMs: 2000 },
  });
  await app.start();
  await app.send(stream.id, "Invented Overview traffic");
  await expect
    .poll(() => app.inspect(stream.id).then((c) => c.status))
    .toBe("working");
  await show();
  await search().evaluate((input) => {
    const measured = window as any;
    measured.overviewTimings = [];
    input.addEventListener(
      "input",
      () => {
        const start = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            measured.overviewTimings.push(performance.now() - start),
          ),
        );
      },
      { capture: true },
    );
  });
  for (let index = 0; index < 24; index++) {
    await search().fill(index % 2 ? "collection049 needle019" : "Invented");
    await expect
      .poll(() =>
        app.page.evaluate(() => (window as any).overviewTimings.length),
      )
      .toBe(index + 1);
    await expect(overview().locator("button.overview-item")).toHaveCount(
      index % 2 ? 2 : 1050,
    );
    await expect(
      overview().locator('.overview-item[aria-selected="true"]'),
    ).toBeInViewport();
  }
  const timings: number[] = await app.page.evaluate(
    () => (window as any).overviewTimings,
  );
  const sorted = [...timings].sort((a, b) => a - b);
  const metrics = {
    rows: 1000,
    workspaces: 50,
    retainedHistoryBytes: 25 * 1024 * 1024,
    attachments: 8,
    attachmentBytes: Buffer.byteLength(image, "base64") * 8,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
    samples: timings,
  };
  await writeFile(
    info.outputPath("overview-latency.json"),
    JSON.stringify(metrics, null, 2),
  );
  console.log("OVERVIEW_LATENCY", JSON.stringify(metrics));
  expect(
    (await app.inspect(stream.id)).messages.some((message) =>
      message.text.includes("STREAM Invented Overview traffic"),
    ),
  ).toBe(true);
  expect(metrics.p95Ms).toBeLessThan(100);
  expect(metrics.maxMs!).toBeLessThan(200);
  await search().fill("Invented");
  const results = overview().locator("button.overview-item");
  const last = results.last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await last.hover();
  await expect(last).toHaveAttribute("aria-selected", "true");
  await search().press("ArrowDown");
  await expect(last).toHaveAttribute("aria-selected", "true");
  await search().press("ArrowUp");
  await expect(results.nth((await results.count()) - 2)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await search().press("ArrowDown");
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect(last).toBeInViewport();
  await search().press("Shift+F10");
  await expect(
    app.page.getByRole("dialog", { name: "Actions", exact: true }),
  ).toBeVisible();
  await app.page.keyboard.press("Escape");
  await expect(search()).toBeFocused();
  await search().press("Escape");
  // Compare lifecycle counts after background metadata has settled.
  await expect
    .poll(() => app.inspect(stream.id).then((c) => c.status))
    .toBe("ready");
  await show();
  await expect(
    row("workspace", "invented-workspace-49").locator(".."),
  ).toHaveAttribute("data-status", "ready");
  await search().press("Escape");
  const baselineNodes = await app.page.evaluate(
    () => document.getElementsByTagName("*").length,
  );
  for (let index = 0; index < 20; index++) {
    await show();
    await search().press("Escape");
  }
  // A closed native dialog leaves the accessibility tree before its close event.
  await expect(app.page.locator("dialog.workspace-overview")).toHaveCount(0);
  expect(
    await app.page.evaluate(() => document.getElementsByTagName("*").length),
  ).toBeLessThanOrEqual(baselineNodes + 5);
  expect((await app.prompts()).length).toBe(1);
});

test("A pending Overview rename cannot block or replace a newer search", async () => {
  const first = await app.create("Invented Alpha rename");
  const second = await app.create("Invented Beta search");
  await app.app!.evaluate(({ ipcMain }, id) => {
    const handlers = (ipcMain as any)._invokeHandlers;
    const original = handlers.get("cod:invoke");
    ipcMain.removeHandler("cod:invoke");
    ipcMain.handle("cod:invoke", async (event, request) => {
      const result = await original(event, request);
      if (request.op === "workspace.rename" && request.id === id) {
        (globalThis as any).renameHeld = true;
        await new Promise<void>((resolve) => {
          (globalThis as any).releaseRename = resolve;
        });
      }
      return result;
    });
  }, first);
  await show();
  await search().fill("Alpha");
  await action("workspace", first, "Rename workspace");
  await overview()
    .getByRole("textbox", { name: "Workspace name" })
    .fill("Invented unrelated title");
  await search().fill("Beta");
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).renameHeld))
    .toBe(true);
  await expect(row("workspace", second)).toBeVisible();
  await expect(row("workspace", first)).toHaveCount(0);
  await app.app!.evaluate(() => (globalThis as any).releaseRename());
  await expect(search()).toHaveValue("Beta");
  await expect(search()).toBeFocused();
  await expect(row("workspace", first)).toHaveCount(0);
});

test("Overview cancellation uses the current pane when its original pane was removed", async () => {
  const workspace = await app.create("Invented removed origin");
  const first = await app.newChat(workspace, "codex");
  await app
    .pane(first.paneId)
    .getByRole("textbox", { name: "Message", exact: true })
    .focus();
  await show();
  const second = await app.newChat(workspace, "codex");
  await app.cli(
    "pane",
    "close",
    "--id",
    first.paneId,
    "--workspace",
    workspace,
  );
  await expect(row("conversation", second.id)).toBeVisible();
  await search().press("Escape");
  await expect(
    app
      .pane(second.paneId)
      .getByRole("textbox", { name: "Message", exact: true }),
  ).toBeFocused();
});

test("Overview and Commands open from a Markdown preview and return to its focused link", async () => {
  const workspace = await app.create("Invented preview origin");
  const file = path.join(app.folders[0], "overview-preview.md");
  await writeFile(
    file,
    "# Invented preview\n\n[Example](https://example.invalid/)\n",
  );
  await app.cli("file", "open", "--workspace", workspace, "--path", file);
  await app.page
    .getByRole("button", { name: "Preview Markdown", exact: true })
    .click();
  const frame = app.page
    .getByRole("region", { name: "Markdown preview", exact: true })
    .locator("iframe")
    .contentFrame();
  const link = frame.getByRole("link", { name: "Example" });
  await link.focus();
  await expect(link).toBeFocused();
  for (const keyCode of ["O", "P"]) {
    await app.app!.evaluate(({ BrowserWindow }, keyCode) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const modifiers: ("meta" | "control" | "shift")[] = [
        process.platform === "darwin" ? "meta" : "control",
        "shift",
      ];
      contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    }, keyCode);
    const field =
      keyCode === "O"
        ? search()
        : app.page.getByRole("textbox", { name: "Filter commands" });
    await expect(field).toBeFocused();
    await field.press("Escape");
    await expect(link).toBeFocused();
  }
});

test("Overview quick actions close a selected tab or remove a saved chat from search", async ({}, info) => {
  const first = await app.create("Active navigation fixture");
  const active = await app.newChat(first, "codex");
  const second = await app.create("Other navigation fixture");
  const selected = await app.newChat(second, "codex");
  await app.cli(
    "conversation",
    "rename",
    "--id",
    selected.id,
    "--name",
    "Chosen chat fixture",
  );
  await app.cli("conversation", "show", "--id", active.id);
  const activeComposer = app
    .pane(active.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await activeComposer.fill("Preserve this active composer draft");
  await app.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(660, 530),
  );

  const footer = () => overview().locator(".picker-footer");
  const selection = () => row("conversation", selected.id);
  const snapshots = () => app.cli<AppState>("state");
  await show();
  await search().pressSequentially("Chosen chat");
  await selection().hover();
  await expect(search()).toBeFocused();
  await expect(footer()).toContainText("Open");
  await expect(footer()).toContainText("Rename");
  await expect(footer()).toContainText("Close tab");
  const shortcuts = await footer().locator("kbd").allTextContents();
  expect(shortcuts).toEqual(
    process.platform === "darwin"
      ? ["Enter", "⌘Enter", "⌘W", "⌘⇧W"]
      : ["Enter", "Ctrl+Enter", "Ctrl+W", "Ctrl+Shift+W"],
  );
  await expect(footer()).toBeInViewport();
  await overview().screenshot({
    path: info.outputPath("overview-quick-actions-narrow.png"),
  });

  await search().press(`${modifier}+Enter`);
  const editor = overview().getByRole("textbox", {
    name: "Conversation name",
    exact: true,
  });
  await expect(editor).toBeFocused();
  await expect(footer()).not.toContainText("Close tab");
  await editor.fill("Taken aside fixture");
  await editor.press(`${modifier}+w`);
  await editor.press(`${modifier}+Shift+W`);
  await expect(editor).toHaveValue("Taken aside fixture");
  await editor.press("Enter");
  await expect(search()).toHaveValue("Chosen chat");
  await expect(search()).toBeFocused();
  await expect(selection()).toContainText("Taken aside fixture");
  expect((await snapshots()).activeWorkspaceId).toBe(first);

  await app.cli(
    "pane",
    "pin",
    "--workspace",
    second,
    "--id",
    selected.paneId,
    "--pinned",
    "true",
  );
  await expect(selection()).toHaveAccessibleName(/Pinned/);
  await expect(footer()).not.toContainText("Close tab");
  await expect(footer()).not.toContainText("Remove from workspace");
  await search().press(`${modifier}+w`);
  await search().press(`${modifier}+Shift+W`);
  expect(
    (await app.workspace(second)).panes.some(
      (pane) => pane.id === selected.paneId,
    ),
  ).toBe(true);
  await app.cli(
    "pane",
    "pin",
    "--workspace",
    second,
    "--id",
    selected.paneId,
    "--pinned",
    "false",
  );
  await expect(footer()).toContainText("Close tab");
  await search().dispatchEvent("keydown", {
    key: "w",
    code: "KeyW",
    ctrlKey: process.platform !== "darwin",
    metaKey: process.platform === "darwin",
    isComposing: true,
  });
  expect(
    (await app.workspace(second)).panes.some(
      (pane) => pane.id === selected.paneId,
    ),
  ).toBe(true);

  await writeFile(
    path.join(app.data, "keymap.json"),
    JSON.stringify({ "tab.close": ["Mod+Shift+Y"] }),
  );
  await expect(footer()).toContainText(
    process.platform === "darwin" ? "⌘⇧Y" : "Ctrl+Shift+Y",
  );
  await search().press(`${modifier}+w`);
  expect(
    (await app.workspace(second)).panes.some(
      (pane) => pane.id === selected.paneId,
    ),
  ).toBe(true);
  await search().press(`${modifier}+Shift+Y`);
  await expect
    .poll(async () =>
      (await app.workspace(second)).panes.some(
        (pane) => pane.id === selected.paneId,
      ),
    )
    .toBe(false);
  await expect(search()).toHaveValue("Chosen chat");
  await expect(search()).toBeFocused();
  await expect(selection()).toHaveAttribute("aria-current", "true");
  await expect(footer()).toContainText("Remove from workspace");
  await search().dispatchEvent("keydown", {
    key: "Y",
    code: "KeyY",
    ctrlKey: process.platform !== "darwin",
    metaKey: process.platform === "darwin",
    shiftKey: true,
    repeat: true,
  });
  const afterClose = await snapshots();
  expect(afterClose.activeWorkspaceId).toBe(first);
  expect(afterClose.workspaces.some((item) => item.id === second)).toBe(true);
  expect(afterClose.conversations.some((chat) => chat.id === selected.id)).toBe(
    true,
  );
  await search().fill("Taken aside fixture");
  await expect(selection()).toHaveAttribute("aria-current", "true");
  await expect(footer()).toContainText("Remove from workspace");
  await expect(footer()).toContainText(
    process.platform === "darwin" ? "⌘⇧W" : "Ctrl+Shift+W",
  );
  await search().dispatchEvent("keydown", {
    key: "Y",
    code: "KeyY",
    ctrlKey: process.platform !== "darwin",
    metaKey: process.platform === "darwin",
    shiftKey: true,
    repeat: true,
  });
  await search().press(`${modifier}+Shift+Y`);
  await expect(selection()).toBeVisible();
  await search().press(`${modifier}+Shift+W`);
  await expect(selection()).toHaveCount(0);
  await expect(search()).toBeFocused();
  await expect(search()).toHaveValue("Taken aside fixture");
  const afterRemoval = await snapshots();
  expect(afterRemoval.activeWorkspaceId).toBe(first);
  expect(
    afterRemoval.conversations.some((chat) => chat.id === selected.id),
  ).toBe(false);
  await search().press("Escape");
  await expect(activeComposer).toBeFocused();
  await expect(activeComposer).toHaveValue(
    "Preserve this active composer draft",
  );
  await app.cli("pane", "reopen", "--workspace", second);
  expect(
    (await snapshots()).conversations.find((chat) => chat.id === selected.id),
  ).toMatchObject({
    nativeId: selected.nativeId,
    displayName: "Taken aside fixture",
  });

  await show();
  await search().fill("Taken aside fixture");
  await selection().hover();
  await expect(footer()).toContainText("Close tab");
  await search().press(`${modifier}+Shift+W`);
  await expect(selection()).toHaveCount(0);
  expect(
    (await app.workspace(second)).panes.some(
      ({ id }) => id === selected.paneId,
    ),
  ).toBe(false);
});

test("Close and remove shortcut preserves the active chat draft and native session across restart", async () => {
  const workspace = await app.create("Invented draft removal");
  const chat = await app.newChat(workspace, "codex");
  const composer = () =>
    app
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
  const snapshot = () => app.cli<AppState>("state");

  await composer().fill("cut this");
  await composer().selectText();
  await composer().press(`${modifier}+x`);
  await expect(composer()).toHaveValue("");
  await composer().fill("Preserve this pending draft");
  await composer().press(`${modifier}+Shift+W`);
  await expect
    .poll(async () =>
      (await snapshot()).conversations.some(({ id }) => id === chat.id),
    )
    .toBe(false);
  await app.stop();
  await app.start();
  await app.cli("pane", "reopen", "--workspace", workspace);
  await expect(composer()).toHaveValue("Preserve this pending draft");
  expect((await app.inspect(chat.id)).nativeId).toBe(chat.nativeId);
  expect(await app.prompts()).toEqual([]);
});

test("Close and remove shortcut closes its browser and terminal targets and archives open workspaces", async () => {
  const workspace = await app.create("Invented shortcut targets");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><title>Invented shortcut page</title><input autofocus value="cut this">',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const browser = await app.cli<{ paneId: string }>(
      "browser",
      "open",
      "--workspace",
      workspace,
      "--url",
      url,
    );
    const readPageInput = () =>
      app.app!.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .find((item) => item.getURL() === url)
            ?.executeJavaScript('document.querySelector("input")?.value') ??
          null,
        url,
      );
    await expect.poll(readPageInput).toBe("cut this");
    await app.app!.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL() === url)!;
      contents.focus();
      await contents.executeJavaScript(
        'document.querySelector("input").select()',
      );
    }, url);
    const browserKey = (keyCode: string, shifted = false) =>
      app.app!.evaluate(
        ({ webContents }, { url, keyCode, shifted }) => {
          const contents = webContents
            .getAllWebContents()
            .find((item) => item.getURL() === url)!;
          const modifiers: Array<"meta" | "control" | "shift"> = [
            process.platform === "darwin" ? "meta" : "control",
          ];
          if (shifted) modifiers.push("shift");
          contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
          contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
        },
        { url, keyCode, shifted },
      );
    await browserKey("X");
    await expect.poll(readPageInput).toBe("");
    await browserKey("W", true);
    await expect(app.pane(browser.paneId)).toHaveCount(0);

    const home = await app.cli<{ paneId: string }>(
      "browser",
      "open",
      "--workspace",
      workspace,
      "--url",
      "about:blank",
    );
    const address = app
      .pane(home.paneId)
      .getByRole("combobox", { name: "Address" });
    await address.focus();
    await address.press(`${modifier}+Shift+W`);
    await expect(app.pane(home.paneId)).toHaveCount(0);

    const terminal = await app.cli<{ paneId: string }>(
      "terminal",
      "open",
      "--workspace",
      workspace,
      "--cwd",
      app.folders[0],
    );
    const terminalInput = app
      .pane(terminal.paneId)
      .getByRole("textbox", { name: "Terminal input" });
    await terminalInput.focus();
    await terminalInput.press(`${modifier}+Shift+W`);
    await expect(app.pane(terminal.paneId)).toHaveCount(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  await show();
  await search().fill("Invented shortcut targets");
  await row("workspace", workspace).hover();
  await search().press(`${modifier}+Shift+W`);
  await expect(row("workspace", workspace)).toHaveCount(0);
  const state = () => app.cli<AppState>("state");
  await expect
    .poll(async () =>
      (await state()).closedWorkspaces?.some(
        (entry) => entry.workspace.id === workspace,
      ),
    )
    .toBe(true);
  await overview()
    .getByRole("button", {
      name: "Show closed workspaces and cancelled reviews",
    })
    .click();
  await search().focus();
  const archived = row("closed-workspace", workspace);
  await archived.hover();
  await search().press(`${modifier}+Shift+W`);
  await expect(archived).toBeVisible();
  await search().press("Enter");
  await expect
    .poll(async () =>
      (await state()).workspaces.some(({ id }) => id === workspace),
    )
    .toBe(true);
});
