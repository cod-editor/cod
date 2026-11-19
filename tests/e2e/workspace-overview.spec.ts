import { test, expect } from "@playwright/test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ChatApp } from "./helpers/chat-fixture/harness";
import { modifier } from "./helpers/workspace-app";
import type { AppState } from "../../src/types";

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
  await expect(overview()).toHaveText("No workspaces");
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
  await app.cli(
    "workspace",
    "settings",
    "--id",
    first,
    "--settings",
    JSON.stringify({ workspacesVisible: false }),
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
  await search().press("Tab");
  const actions = overview().getByRole("gridcell", {
    name: `Actions for ${label}`,
    exact: true,
  });
  await expect(actions).toBeFocused();
  expect(
    await actions.evaluate((node) => getComputedStyle(node).outlineStyle),
  ).toBe("solid");
  await overview().screenshot({
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
  await expect(
    app.page.locator(
      `#workspace-tree [data-navigation-key="terminal:${terminal.id}"]`,
    ),
  ).toHaveCount(0);
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
  const actions = overview().getByRole("gridcell", {
    name: "Actions for Alpha complete conversation label",
    exact: true,
  });
  await expect(actions).toBeFocused();
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
  const review = await app.cli<{ reviewId: string }>(
    "review",
    "open-document",
    "--workspace",
    workspace,
    "--path",
    app.file,
    "--conversation",
    chat.id,
  );
  const sidebarReview = app.page.locator(
    `#workspace-tree [data-navigation-key="review:${review.reviewId}"]`,
  );
  await expect(sidebarReview).toBeVisible();
  await sidebarReview.click();
  await expect(app.page.locator(".review-body")).toBeVisible();
  await show();
  await search().fill("spec.md");
  await expect(row("review", review.reviewId)).toHaveCount(0);
  await expect(overview()).toContainText("No matching items");
  await search().fill("guarded workspace");
  await expect(row("workspace", workspace)).toBeVisible();
  await row("workspace", workspace).click();
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
  await action("workspace", workspace, "Close workspace");
  const guard = app.page.getByRole("dialog", {
    name: "Close workspace",
    exact: true,
  });
  await expect(
    guard.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await guard.getByRole("button", { name: "Cancel", exact: true }).click();
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
  await expect(row("conversation", chat.id)).toHaveAttribute(
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
  try {
    await chmod(app.data, 0o500);
    await name.press("Enter");
    await expect(overview().getByRole("alert")).toContainText(
      /EACCES|permission denied/i,
    );
    await expect(name).toHaveValue("Invented rename recovered");
    await expect(search()).toHaveValue("Invented");
  } finally {
    await chmod(app.data, 0o700);
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
  const stateFile = path.join(app.data, "state.json");
  const state: AppState = JSON.parse(await readFile(stateFile, "utf8"));
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
      settings: { ...template.settings, workspacesVisible: false },
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
  await writeFile(stateFile, JSON.stringify(state));
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
  const last = overview().locator("button.overview-item").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await last.hover();
  await expect(last).toHaveAttribute("aria-selected", "true");
  await search().press("ArrowDown");
  await search().press("ArrowUp");
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
  await expect(
    app.page.locator(
      '#workspace-tree [data-navigation-key="workspace:invented-workspace-49"]',
    ),
  ).toHaveAttribute("data-status", "ready");
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
