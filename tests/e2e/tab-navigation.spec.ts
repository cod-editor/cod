import { test, expect, type Locator } from "@playwright/test";
import { readdir, readFile, writeFile } from "node:fs/promises";
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

test("Fallback new tab retains persistent choices and replaces itself with each content type", async ({}, info) => {
  const original = await state();
  await blank();
  await chooser()
    .getByRole("button", { name: "New file", exact: true })
    .focus();
  await expect(chooser()).toBeVisible();
  await expect(app.page.getByRole("dialog")).toHaveCount(0);
  await expect(
    chooser().getByRole("button", { name: "New file", exact: true }),
  ).toBeFocused();
  const id = (await state()).activePaneId;
  expect((await state()).groups).toHaveLength(original.groups!.length);
  await app
    .pane(id)
    .screenshot({ path: info.outputPath("new-tab-choices.png") });
  await app.stop();
  await app.start();
  await expect(chooser()).toBeVisible();
  expect((await state()).activePaneId).toBe(id);
  const folder = app.folders[0];
  const filesBefore = (await readdir(folder)).sort();
  await chooser()
    .getByRole("button", { name: "New file", exact: true })
    .press("Enter");
  const editor = () =>
    app.pane(id).getByRole("textbox", { name: "File contents", exact: true });
  await expect(editor()).toBeFocused();
  await expect(editor()).toHaveValue("");
  expect((await state()).panes.find((p) => p.id === id)?.kind).toBe("untitled");
  const note = "Draft a note from the launcher";
  await editor().fill(note);
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
    .toBe(note);
  expect((await readdir(folder)).sort()).toEqual(filesBefore);
  await app.stop();
  await app.start();
  await expect(editor()).toHaveValue(note);
  const target = path.join(folder, "launcher-note.txt");
  await app.app!.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, target);
  await editor().press(`${modifier}+s`);
  await expect
    .poll(() => readFile(target, "utf8").catch(() => null))
    .toBe(note);
  await expect(editor()).toHaveValue(note);
  expect((await state()).groups).toHaveLength(original.groups!.length);
  await app.page.keyboard.press(`${modifier}+t`);
  await expect(
    app.page.getByRole("textbox", { name: "File contents", exact: true }),
  ).toHaveValue("");
  await blank(original.groups![0].id);
  const browserId = (await state()).activePaneId;
  await chooser()
    .getByRole("button", { name: "New file", exact: true })
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

test("Overview browser results retain title, selection, keyboard navigation and recovery through restart", async ({}, info) => {
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
  const overview = await app.overview();
  const search = overview.getByRole("combobox");
  const row = () =>
    app.page
      .getByRole("dialog", { name: "Overview", exact: true })
      .locator(`.overview-item[data-navigation-key="browser:${browser.id}"]`);
  await expect(row()).toContainText("Invented browser page");
  await expect(row()).toHaveAttribute("aria-selected", "true");
  await search.press("ArrowUp");
  expect((await state()).activePaneId).toBe(browser.paneId);
  await search.press("ArrowDown");
  await expect(row()).toHaveAttribute("aria-current", "true");
  await search.press("Enter");
  await expect(app.pane(browser.paneId)).toBeVisible();
  await expect(
    app.page.getByRole("textbox", { name: "Conversation name", exact: true }),
  ).toHaveCount(0);
  const site = app
    .app!.context()
    .pages()
    .find((page) => page.url() === pathToFileURL(file).href)!;
  await app.overview();
  await site.evaluate(() => {
    document.title = "Updated browser page " + "x".repeat(100000);
  });
  await expect(row()).toContainText("Updated browser page");
  expect((await row().textContent())!.length).toBeLessThanOrEqual(160);
  await expect(search).toBeFocused();
  await app.page.screenshot({
    path: info.outputPath("browser-workspace-row.png"),
  });
  await search.press("Escape");
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
  await expect
    .poll(async () => (await state()).activePaneId)
    .not.toBe(browser.paneId);
  const newPane = (await state()).activePaneId;
  await expect(
    app.pane(newPane).getByRole("textbox", { name: "Address", exact: true }),
  ).toBeFocused();
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
  await app.overview();
  await row().hover();
  await search.press("Enter");
  await expect
    .poll(async () => (await app.state()).activeWorkspaceId)
    .toBe(workspace);
  await expect(app.pane(browser.paneId)).toBeVisible();
  await app.overview();
  await row().hover();
  await search.press(`${modifier}+w`);
  await expect(row()).toHaveCount(0);
  await expect(search).toBeFocused();
  await app.cli("pane", "reopen", "--workspace", workspace);
  await expect(row()).toBeVisible();
  await app.stop();
  await app.start();
  await app.overview();
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
  await region.getByRole("button", { name: "New file", exact: true }).focus();
  await app.page.keyboard.press("ArrowDown");
  await expect(
    region.getByRole("button", { name: "Browser", exact: true }),
  ).toBeFocused();
  await app
    .pane((await state()).activePaneId)
    .screenshot({ path: info.outputPath("new-tab-narrow-enlarged.png") });
});

test("New file replaces the exact blank tab and rejects a changed or closed target", async () => {
  const first = await blank();
  const second = await blank(first.groupId);
  const before = (await state()).groups!.find(
    (g) => g.id === first.groupId,
  )!.paneIds;
  const options = [
    "file",
    "new",
    "--workspace",
    workspace,
    "--group",
    first.groupId,
    "--replace-pane",
  ];
  await app.cli(...options, first.paneId);
  const background = await state();
  expect(background.activePaneId).toBe(second.paneId);
  expect(background.panes.find((p) => p.id === first.paneId)).toMatchObject({
    kind: "untitled",
  });
  expect(background.panes.find((p) => p.id === second.paneId)).toMatchObject({
    kind: "empty",
    launcher: true,
  });
  expect(
    background.groups!.find((g) => g.id === first.groupId)!.paneIds,
  ).toEqual(before);
  const changed = await app.raw(...options, first.paneId);
  expect(changed.code).toBe(1);
  expect(changed.stderr).toContain("The blank tab was changed");
  await app.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    second.paneId,
  );
  const afterClose = (await state()).panes.map((p) => p.id);
  const closed = await app.raw(...options, second.paneId);
  expect(closed.code).toBe(1);
  expect(closed.stderr).toContain("The blank tab was closed");
  expect((await state()).panes.map((p) => p.id)).toEqual(afterClose);

  const moved = await blank(first.groupId);
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
    moved.paneId,
    "--group",
    right.groupId,
  );
  const wrongGroup = await app.raw(...options, moved.paneId);
  expect(wrongGroup.code).toBe(1);
  expect(wrongGroup.stderr).toContain("The blank tab moved");
  expect(
    (await state()).panes.find((p) => p.id === moved.paneId),
  ).toMatchObject({ kind: "empty", launcher: true });
});
