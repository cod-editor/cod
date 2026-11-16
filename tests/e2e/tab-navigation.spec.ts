import { test, expect, type Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { WorkspaceApp, modifier } from "./helpers/workspace-app";
import type { AppState } from "../../src/types";

let app: WorkspaceApp;
let workspace: string;
test.beforeEach(async () => {
  app = new WorkspaceApp();
  await app.prepare();
  await app.start();
  workspace = await app.create("Tab navigation");
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
const state = async () =>
  (await app.cli<AppState>("state")).workspaces.find(
    (w) => w.id === workspace,
  )!;
const chooser = () =>
  app.page.getByRole("region", { name: "New tab", exact: true });
async function blank(group?: string) {
  const result = await app.cli<{ paneId: string; groupId: string }>(
    "pane",
    "new",
    "--workspace",
    workspace,
    ...(group ? ["--group", group] : []),
  );
  await expect(
    app.page.locator(`[role=tab][data-tab-id="${result.paneId}"]`),
  ).toBeVisible();
  return result;
}

test("New tab opens persistent choices in its target pane and replaces itself with each content type", async ({}, info) => {
  const original = await state();
  await app.page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(chooser()).toBeVisible();
  await expect(app.page.getByRole("dialog")).toHaveCount(0);
  await expect(
    chooser().getByRole("button", { name: "Open file", exact: true }),
  ).toBeFocused();
  const id = (await state()).activePaneId;
  expect((await state()).groups).toHaveLength(original.groups!.length);
  await chooser()
    .getByRole("button", { name: "Open file", exact: true })
    .press("Enter");
  const search = () =>
    app.page.getByRole("dialog", {
      name: "Open file",
      exact: true,
    });
  await expect(search()).toBeVisible();
  await search()
    .getByRole("textbox", { name: "Open file", exact: true })
    .press("Escape");
  await expect(
    chooser().getByRole("button", { name: "Open file", exact: true }),
  ).toBeFocused();
  await app
    .pane(id)
    .screenshot({ path: info.outputPath("new-tab-choices.png") });
  await app.stop();
  await app.start();
  await expect(chooser()).toBeVisible();
  expect((await state()).activePaneId).toBe(id);
  await chooser()
    .getByRole("button", { name: "Open file", exact: true })
    .click();
  await search()
    .getByRole("textbox", { name: "Open file", exact: true })
    .fill("spec.md");
  await search().getByRole("button", { name: "spec.md", exact: true }).click();
  await expect(
    app.pane(id).getByRole("textbox", { name: "File contents", exact: true }),
  ).toBeVisible();
  expect((await state()).groups).toHaveLength(original.groups!.length);
  await app.page.keyboard.press(`${modifier}+t`);
  await expect(
    chooser().getByRole("button", { name: "Open file", exact: true }),
  ).toBeFocused();
  const browserId = (await state()).activePaneId;
  await chooser()
    .getByRole("button", { name: "Open file", exact: true })
    .press("ArrowDown");
  await expect(
    chooser().getByRole("button", { name: "Browser", exact: true }),
  ).toBeFocused();
  await app.page.keyboard.press("Enter");
  await expect(
    app.pane(browserId).getByRole("textbox", { name: "Address", exact: true }),
  ).toBeFocused();
  const chat = await blank(original.groups![0].id);
  await chooser().getByRole("button", { name: "Chat", exact: true }).click();
  await expect(
    app
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true }),
  ).toBeFocused();
  const terminal = await blank(original.groups![0].id);
  await chooser()
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  await expect(
    app.pane(terminal.paneId).locator(".xterm-helper-textarea"),
  ).toBeFocused();
  expect((await state()).groups).toHaveLength(original.groups!.length);
  const blankTab = await blank();
  await app.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    blankTab.paneId,
  );
  await expect(app.pane(blankTab.paneId)).toHaveCount(0);
  await app.cli("pane", "reopen", "--workspace", workspace);
  await expect(chooser()).toBeVisible();
  expect((await state()).activePaneId).toBe(blankTab.paneId);
});

test("Workspace browser rows retain title, selection, keyboard navigation and recovery through restart", async ({}, info) => {
  const file = path.join(app.folders[0], "invented.html");
  await writeFile(
    file,
    "<!doctype html><title>Invented browser page</title><p>Fixture</p>",
  );
  const browser = await app.cli<{ id: string; paneId: string }>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    pathToFileURL(file).href,
  );
  const row = () =>
    app.page.locator(`[role=treeitem][data-browser-id="${browser.id}"]`);
  await expect(row()).toContainText("Invented browser page");
  await expect(row()).toHaveAttribute("aria-selected", "true");
  await row().focus();
  await row().press("ArrowUp");
  expect((await state()).activePaneId).toBe(browser.paneId);
  await app.page.keyboard.press("ArrowDown");
  await expect(row()).toBeFocused();
  await row().press("Enter");
  await expect(app.pane(browser.paneId)).toBeVisible();
  await expect(
    app.page.getByRole("textbox", { name: "Conversation name", exact: true }),
  ).toHaveCount(0);
  const site = app
    .app!.context()
    .pages()
    .find((page) => page.url() === pathToFileURL(file).href)!;
  await row().focus();
  await site.evaluate(() => {
    document.title = "Updated browser page " + "x".repeat(100000);
  });
  await expect(row()).toContainText("Updated browser page");
  expect((await row().textContent())!.length).toBeLessThanOrEqual(160);
  await expect(row()).toBeFocused();
  await app.page.screenshot({
    path: info.outputPath("browser-workspace-row.png"),
  });
  const sourceGroup = (await state()).groups!.find((g) =>
    g.paneIds.includes(browser.paneId),
  )!.id;
  await app.app!.evaluate(({ webContents }, url) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL() === url)!;
    contents.focus();
    const modifiers: ("meta" | "control")[] = [
      process.platform === "darwin" ? "meta" : "control",
    ];
    contents.sendInputEvent({ type: "keyDown", keyCode: "T", modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode: "T", modifiers });
  }, pathToFileURL(file).href);
  await expect(
    chooser().getByRole("button", { name: "Open file", exact: true }),
  ).toBeFocused();
  const newPane = (await state()).activePaneId;
  expect(
    (await state()).groups!.find((g) => g.paneIds.includes(newPane))!.id,
  ).toBe(sourceGroup);
  await app.cli("pane", "close", "--workspace", workspace, "--id", newPane);
  const other = await app.cli<{ id: string }>(
    "workspace",
    "create",
    "--name",
    "Other task",
  );
  await app.cli("workspace", "focus", "--id", other.id);
  await row().focus();
  await row().press("Space");
  await expect
    .poll(async () => (await app.state()).activeWorkspaceId)
    .toBe(workspace);
  await expect(app.pane(browser.paneId)).toBeVisible();
  await row().press("Delete");
  await expect(row()).toHaveCount(0);
  await expect(
    app.page.locator(`[role=treeitem][data-workspace-id="${other.id}"]`),
  ).toBeFocused();
  await app.cli("pane", "reopen", "--workspace", workspace);
  await expect(row()).toBeVisible();
  await app.stop();
  await app.start();
  await expect(row()).toBeVisible();
  await expect(row()).toContainText("Invented browser page");
});

async function drag(source: Locator, target: Locator, x: number) {
  await source.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await app.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await app.page.mouse.down();
  await app.page.mouse.move(
    from.x + from.width / 2 + 8,
    from.y + from.height / 2,
    { steps: 3 },
  );
  await app.page.mouse.move(to.x + x, to.y + to.height / 2, { steps: 16 });
  // A second move dispatches dragover after entering a different drop target.
  // https://playwright.dev/docs/input#dragging-manually
  await app.page.mouse.move(to.x + x, to.y + to.height / 2);
  await expect(app.page.locator(".tab-insertion-marker")).toBeVisible();
}

test("Drag tabs inserts at the pointer, cancels safely and moves across groups without losing tab identity", async ({}, info) => {
  const one = await blank();
  const two = await blank();
  const three = await blank();
  const group = () =>
    app.page.locator(`.tab-group[data-group-id="${one.groupId}"]`);
  const tab = (id: string) =>
    app.page.locator(`[role=tab][data-tab-id="${id}"]`);
  const order = async (groupId = one.groupId) =>
    (await state()).groups!.find((g) => g.id === groupId)!.paneIds;
  const before = await order();
  await drag(tab(three.paneId), tab(one.paneId), 3);
  await app.page.screenshot({ path: info.outputPath("tab-insertion.png") });
  const dragNode = await tab(three.paneId).elementHandle();
  await app.cli(
    "workspace",
    "rename",
    "--id",
    workspace,
    "--name",
    "Updated while dragging",
  );
  expect(await dragNode!.evaluate((node) => node.isConnected)).toBe(true);
  await app.page.mouse.up();
  await expect
    .poll(order)
    .toEqual([before[0], three.paneId, one.paneId, two.paneId]);
  await drag(
    tab(three.paneId),
    tab(two.paneId),
    (await tab(two.paneId).boundingBox())!.width - 3,
  );
  await app.page.mouse.up();
  await expect.poll(order).toEqual(before);
  await drag(tab(three.paneId), tab(one.paneId), 3);
  await app.page.keyboard.press("Escape");
  await app.page.mouse.up();
  await expect(app.page.locator(".tab-insertion-marker")).toHaveCount(0);
  expect(await order()).toEqual(before);
  const right = await app.cli<{ groupId: string }>(
    "group",
    "ensure",
    "--workspace",
    workspace,
    "--side",
    "right",
  );
  const destination = await blank(right.groupId);
  await drag(tab(two.paneId), tab(destination.paneId), 3);
  await app.page.mouse.up();
  await expect
    .poll(() => order(right.groupId))
    .toEqual([two.paneId, destination.paneId]);
  expect((await state()).panes.filter((p) => p.id === two.paneId)).toHaveLength(
    1,
  );
  expect(await order()).toEqual(before.filter((id) => id !== two.paneId));
  await app.stop();
  await app.start();
  expect(await order(right.groupId)).toEqual([two.paneId, destination.paneId]);
  await expect(tab(two.paneId)).toHaveAttribute("aria-selected", "true");
  await expect(group()).toBeVisible();
});

test("Dragging through an overflowing tab bar scrolls without committing an abandoned move", async () => {
  const first = await blank();
  for (let i = 0; i < 14; i++) await blank(first.groupId);
  const tabs = app.page.locator(`[data-group-id="${first.groupId}"] .tabs`);
  const before = (await state()).groups!.find(
    (g) => g.id === first.groupId,
  )!.paneIds;
  const source = tabs.locator(`[data-tab-id="${first.paneId}"]`);
  await source.scrollIntoViewIfNeeded();
  const initial = await tabs.evaluate((node) => node.scrollLeft);
  const from = (await source.boundingBox())!;
  const area = (await tabs.boundingBox())!;
  await app.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await app.page.mouse.down();
  await app.page.mouse.move(
    from.x + from.width / 2 + 8,
    from.y + from.height / 2,
    { steps: 3 },
  );
  await app.page.mouse.move(area.x + area.width - 3, area.y + area.height / 2, {
    steps: 14,
  });
  await expect
    .poll(() => tabs.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(initial);
  await app.page.keyboard.press("Escape");
  await app.page.mouse.up();
  await expect(app.page.locator(".tab-insertion-marker")).toHaveCount(0);
  expect(
    (await state()).groups!.find((g) => g.id === first.groupId)!.paneIds,
  ).toEqual(before);
});

test("Blank tab choices fit a narrow split and use shared controls with enlarged interface text", async ({}, info) => {
  const right = await app.cli<{ groupId: string }>(
    "group",
    "ensure",
    "--workspace",
    workspace,
    "--side",
    "right",
  );
  await blank(right.groupId);
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
  const region = chooser();
  const bounds = (await region.boundingBox())!;
  const buttons = region.getByRole("button");
  await expect(buttons).toHaveCount(4);
  for (const button of await buttons.all()) {
    const rect = (await button.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(bounds.x);
    expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    await expect(button).toHaveClass(/ui-button/);
  }
  expect(
    await region.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await region.getByRole("button", { name: "Open file", exact: true }).focus();
  await app.page.keyboard.press("ArrowDown");
  await expect(
    region.getByRole("button", { name: "Browser", exact: true }),
  ).toBeFocused();
  await app
    .pane((await state()).activePaneId)
    .screenshot({ path: info.outputPath("new-tab-narrow-enlarged.png") });
});

test("A file choice keeps its original blank tab and rejects a tab that was closed while choosing", async () => {
  const first = await blank();
  await chooser()
    .getByRole("button", { name: "Open file", exact: true })
    .click();
  const search = app.page.getByRole("dialog", {
    name: "Open file",
    exact: true,
  });
  await expect(search).toBeVisible();
  const second = await app.cli<{ paneId: string }>(
    "pane",
    "new",
    "--workspace",
    workspace,
  );
  await search
    .getByRole("textbox", { name: "Open file", exact: true })
    .fill("spec.md");
  await search.getByRole("button", { name: "spec.md", exact: true }).click();
  await expect(
    app
      .pane(first.paneId)
      .getByRole("textbox", { name: "File contents", exact: true }),
  ).toBeVisible();
  expect(
    (await state()).panes.find((p) => p.id === second.paneId),
  ).toMatchObject({ kind: "empty", launcher: true });
  await app.cli(
    "pane",
    "focus",
    "--workspace",
    workspace,
    "--id",
    second.paneId,
  );
  await chooser()
    .getByRole("button", { name: "Open file", exact: true })
    .click();
  await expect(search).toBeVisible();
  await search
    .getByRole("textbox", { name: "Open file", exact: true })
    .fill("spec.md");
  await search.getByRole("button", { name: "spec.md", exact: true }).click();
  await expect
    .poll(async () => (await state()).panes.some((p) => p.id === second.paneId))
    .toBe(false);
  expect(
    (await state()).panes.filter((p) => p.kind === "document" && p.filePath),
  ).toHaveLength(1);
  const closed = await blank();
  await chooser()
    .getByRole("button", { name: "Open file", exact: true })
    .click();
  await expect(search).toBeVisible();
  await app.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    closed.paneId,
  );
  const before = (await state()).panes.map((p) => p.id);
  await search
    .getByRole("textbox", { name: "Open file", exact: true })
    .fill("spec.md");
  await search.getByRole("button", { name: "spec.md", exact: true }).click();
  await expect(app.page.locator("#status")).toContainText(
    "The blank tab was closed",
  );
  expect((await state()).panes.map((p) => p.id)).toEqual(before);
});
