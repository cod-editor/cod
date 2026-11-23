import type { AppState } from "../../src/types";
import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { ChatApp } from "./helpers/chat-fixture/harness";
import { modifier } from "./helpers/workspace-app";
const execute = promisify(execFile);

test("Native directory chooser selects a real folder with spaces and supports cancellation", async ({}, info) => {
  test.skip(
    process.platform !== "linux",
    "Actual native chooser automation uses isolated X11; macOS desktop must remain untouched",
  );
  const app = new ChatApp();
  await app.prepare();
  let nativeWindow: string | undefined;
  const findChooser = async () => {
    try {
      return (
        await execute("xdotool", [
          "search",
          "--onlyvisible",
          "--name",
          "Add folder to workspace",
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
  try {
    await app.start();
    const selected = app.page.evaluate(() => window.cod.chooseDirectory());
    await expect
      .poll(async () => {
        nativeWindow = await findChooser();
        return !!nativeWindow;
      })
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
        info.outputPath("native-folder-picker.png"),
        Buffer.from(capture, "base64"),
      );
    await execute("xdotool", ["windowfocus", "--sync", nativeWindow!]);
    await execute("xdotool", ["key", "--window", nativeWindow!, "ctrl+l"]);
    await execute("xdotool", [
      "type",
      "--window",
      nativeWindow!,
      "--clearmodifiers",
      "--delay",
      "20",
      app.folders[0],
    ]);
    await execute("xdotool", ["key", "--window", nativeWindow!, "alt+o"]).catch(
      () => undefined,
    );
    expect(await selected).toBe(app.folders[0]);
    nativeWindow = undefined;
    const cancelled = app.page.evaluate(() => window.cod.chooseDirectory());
    await expect
      .poll(async () => {
        nativeWindow = await findChooser();
        return !!nativeWindow;
      })
      .toBe(true);
    await execute("xdotool", [
      "key",
      "--window",
      nativeWindow!,
      "Escape",
    ]).catch(() => undefined);
    expect(await cancelled).toBeNull();
    nativeWindow = undefined;
  } finally {
    if (nativeWindow)
      await execute("xdotool", [
        "key",
        "--window",
        nativeWindow,
        "Escape",
      ]).catch(() => undefined);
    await app.cleanup();
  }
});

test("Settings adjust the actual interface, editor and chat text and survive restart", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const workspace = await app.create("Readable workspace");
    await app.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      app.folders[0],
    );
    await app.cli("file", "open", "--workspace", workspace, "--path", app.file);
    await app.page.keyboard.press(`${modifier}+,`);
    const settings = app.page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await expect(settings).toBeVisible();
    for (const [name, value] of [
      ["Interface text size", "17"],
      ["Editor text size", "19"],
      ["Chat text size", "18"],
    ]) {
      await settings.getByRole("spinbutton", { name, exact: true }).fill(value);
      await settings
        .getByRole("spinbutton", { name, exact: true })
        .press("Tab");
    }
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await expect(app.page.locator(".file-editor")).toHaveCSS(
      "font-size",
      "19px",
    );
    await expect(app.page.locator(".composer textarea")).toHaveCSS(
      "font-size",
      "18px",
    );
    await app.page.screenshot({
      path: info.outputPath("text-sizes-split.png"),
    });
    const origin = await app.newChat(workspace, "codex");
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
    await expect(
      app
        .pane(review.paneId)
        .getByRole("textbox", { name: "Review source", exact: true }),
    ).toHaveCSS("font-size", "19px");
    await app.page.screenshot({
      path: info.outputPath("scaled-review-source.png"),
    });
    await app.cli(
      "pane",
      "focus",
      "--workspace",
      workspace,
      "--id",
      (await app.workspace(workspace)).panes.find(
        (p) => p.kind === "document" && !p.draftChat,
      )!.id,
    );

    await app.stop();
    await app.start();
    await expect(app.page.locator(".file-editor")).toHaveCSS(
      "font-size",
      "19px",
    );
    await expect(app.page.locator(".composer textarea")).toHaveCSS(
      "font-size",
      "18px",
    );
    await app.command("Settings...");
    await expect(
      app.page.getByRole("spinbutton", {
        name: "Interface text size",
        exact: true,
      }),
    ).toHaveValue("17");
    await app.page
      .getByRole("button", { name: "Reset defaults", exact: true })
      .click();
    await app.page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(app.page.locator(".file-editor")).toHaveCSS(
      "font-size",
      "16px",
    );
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    const palette = app.page.getByRole("dialog");
    await expect(palette).toBeVisible();
    const box = (await palette.boundingBox())!;
    const height = await app.page.evaluate(() => innerHeight);
    expect(box.y).toBeLessThan(height * 0.15);
    expect(box.height).toBeLessThan(height * 0.65);
    await app.page.screenshot({
      path: info.outputPath("compact-command-palette.png"),
    });
  } finally {
    await app.cleanup();
  }
});

test("Folder actions use the native chooser from Commands, Overview and empty and populated file trees", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const workspace = await app.create("Folder navigation");
    const choose = async (folder: string | null) => {
      await app.app!.evaluate(({ dialog }, value) => {
        dialog.showOpenDialog = (async () => ({
          canceled: value === null,
          filePaths: value === null ? [] : [value],
        })) as typeof dialog.showOpenDialog;
      }, folder);
    };
    await choose(null);
    await app.command("Add folder");
    expect((await app.workspace(workspace)).folders).toHaveLength(0);
    await expect(app.page.getByRole("dialog")).toHaveCount(0);
    const background = await app.cli<{ id: string }>(
      "workspace",
      "create",
      "--name",
      "Background folder target",
    );
    const overview = await app.overview();
    const search = overview.getByRole("combobox", { name: "Search Overview" });
    await search.fill("Background folder target");
    await choose(app.folders[0]);
    await app.row("Background folder target").click({ button: "right" });
    await app.page
      .getByRole("button", { name: "Add folder...", exact: true })
      .click();
    await expect
      .poll(async () => (await app.workspace(background.id)).folders.length)
      .toBe(1);
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("Background folder target");
    expect((await app.state()).activeWorkspaceId).toBe(workspace);
    expect((await app.workspace(workspace)).folders).toHaveLength(0);
    await search.press("Escape");
    const filesToggle = app.page.getByRole("button", {
      name: "Toggle files",
      exact: true,
    });
    if ((await filesToggle.getAttribute("aria-pressed")) !== "true")
      await filesToggle.click();
    const tree = app.page.getByRole("tree", { name: "File tree" });
    await choose(app.folders[0]);
    await tree.click({ button: "right", position: { x: 30, y: 80 } });
    await app.page
      .getByRole("button", { name: "Add folder...", exact: true })
      .click();
    await expect
      .poll(async () => (await app.workspace(workspace)).folders.length)
      .toBe(1);
    const root = tree.getByRole("treeitem", {
      name: "alpha repo",
      exact: true,
    });
    await expect(root).toBeVisible();
    await choose(app.folders[1]);
    await root.click({ button: "right" });
    await app.page
      .getByRole("button", { name: "Add folder...", exact: true })
      .click();
    await expect
      .poll(async () => (await app.workspace(workspace)).folders.length)
      .toBe(2);
    await app.page.screenshot({
      path: info.outputPath("multiple-folder-navigation.png"),
    });
    await app.stop();
    await app.start();
    await expect(
      app.page
        .getByRole("tree", { name: "File tree" })
        .getByRole("treeitem", { name: "alpha repo", exact: true }),
    ).toBeVisible();
    await expect(
      app.page
        .getByRole("tree", { name: "File tree" })
        .getByRole("treeitem", { name: "beta repo", exact: true }),
    ).toBeVisible();
  } finally {
    await app.cleanup();
  }
});

test("Header split mode follows position while the Files panel stays independent", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const workspace = await app.create("Spatial layout");
    await app.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      app.folders[0],
    );
    const file = await app.cli<{ paneId: string }>(
      "file",
      "open",
      "--workspace",
      workspace,
      "--path",
      app.file,
    );
    const editor = app
      .pane(file.paneId)
      .getByRole("textbox", { name: "File contents", exact: true });
    const composer = app.page.locator(".composer textarea");
    const split = app.page.getByRole("button", {
      name: "Toggle split view",
      exact: true,
    });
    const files = app.page.getByRole("button", {
      name: "Toggle files",
      exact: true,
    });
    await expect(split).toHaveAttribute("aria-pressed", "true");
    await expect(split).toHaveCSS("color", "rgb(97, 175, 239)");
    await files.click();
    await editor.focus();
    await split.click();
    await expect(editor).toBeFocused();
    await expect(composer).toBeHidden();
    await expect(files).toHaveAttribute("aria-pressed", "true");

    await app.page.keyboard.press("Alt+2");
    await expect(composer).toBeFocused();
    await expect(editor).toBeHidden();
    await app.page.keyboard.press("Shift+Escape");
    await expect(composer).toBeFocused();
    await expect(editor).toBeVisible();
    await expect(split).toHaveAttribute("aria-pressed", "true");
    const before = await app.cli<AppState>("state");
    const left = before.workspaces
      .find((item) => item.id === workspace)!
      .groups.find((group) => group.paneIds.includes(file.paneId))!;
    expect(
      (
        await app.raw(
          "group",
          "split",
          "--workspace",
          workspace,
          "--id",
          left.id,
          "--direction",
          "down",
        )
      ).code,
    ).not.toBe(0);
    expect(await app.cli<AppState>("state")).toEqual(before);
    await app.page.screenshot({
      path: info.outputPath("side-by-side-pane-switch.png"),
    });
  } finally {
    await app.cleanup();
  }
});

test("Searchable command palette keeps typing focus and shows the action Enter will execute", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    await app.create("Keyboard navigation");
    const composer = app.page.locator(".composer textarea");
    await composer.fill("A retained draft");
    await composer.press("Home");
    await composer.press("ArrowRight");
    const caret = await composer.evaluate(
      (node) => (node as HTMLTextAreaElement).selectionStart,
    );
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    const palette = app.page.getByRole("dialog", {
      name: "Command palette",
      exact: true,
    });
    const input = palette.getByRole("textbox", {
      name: "Filter commands",
      exact: true,
    });
    const selected = async () => {
      const id = await input.getAttribute("aria-activedescendant");
      expect(id).toBeTruthy();
      const row = app.page.locator(`[id="${id}"]`);
      await expect(row).toBeVisible();
      return row;
    };
    await expect(input).toBeFocused();
    await selected();
    await input.fill("New");
    await input.press("ArrowDown");
    await expect(input).toBeFocused();
    await expect(await selected()).toContainText("New chat");
    await input.pressSequentially(" workspace");
    await expect(input).toHaveValue("New workspace");
    await expect(await selected()).toContainText("New workspace");
    await app.page.screenshot({
      path: info.outputPath("palette-keyboard-selection.png"),
    });
    await input.fill("Rename workspace");
    await input.press("Enter");
    await expect(
      app.page.getByRole("textbox", { name: "Workspace name", exact: true }),
    ).toBeFocused();
    await app.page.keyboard.press("Escape");
    const search = app.page.getByRole("combobox", { name: "Search Overview" });
    await expect(search).toBeFocused();
    await search.press("Escape");
    await expect(composer).toBeFocused();
    expect(
      await composer.evaluate(
        (node) => (node as HTMLTextAreaElement).selectionStart,
      ),
    ).toBe(caret);
    await composer.focus();
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    await input.fill("No invented command has this name");
    await input.press("ArrowDown");
    await input.press("Enter");
    await expect(palette).toBeVisible();
    await expect(input).toBeFocused();
    await expect(palette.getByRole("button")).toHaveCount(0);
    await input.press("Escape");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("A retained draft");
    expect(
      await composer.evaluate(
        (node) => (node as HTMLTextAreaElement).selectionStart,
      ),
    ).toBe(caret);
  } finally {
    await app.cleanup();
  }
});

test("Workspace and file pickers preserve filtering after arrow navigation", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const first = await app.create("Project Alpha");
    await app.create("Project Beta");
    await app.page
      .getByRole("button", { name: "Overview", exact: true })
      .click();
    const picker = app.page.getByRole("dialog");
    const filter = picker.getByRole("combobox", { name: "Search Overview" });
    await filter.fill("Project");
    await filter.press("ArrowDown");
    await expect(filter).toBeFocused();
    await filter.pressSequentially(" Alpha");
    await expect(filter).toHaveValue("Project Alpha");
    await filter.press("Enter");
    await expect
      .poll(async () => (await app.state()).activeWorkspaceId)
      .toBe(first);
    await app.cli(
      "workspace",
      "add-folder",
      "--id",
      first,
      "--path",
      app.folders[0],
    );
    await writeFile(
      app.folders[0] + "/spec-other.md",
      "# Other invented file\n",
    );
    await app.command("Open file");
    const query = app.page
      .getByRole("dialog")
      .getByRole("textbox", { name: "Open file", exact: true });
    await query.fill("spec");
    await expect(app.page.getByRole("dialog").getByRole("button")).toHaveCount(
      2,
    );
    await query.press("ArrowDown");
    await expect(query).toBeFocused();
    await query.pressSequentially(".md");
    await expect(query).toHaveValue("spec.md");
    await expect(app.page.getByRole("dialog").getByRole("button")).toHaveCount(
      1,
    );
    const filePickerBox = (await app.page.getByRole("dialog").boundingBox())!;
    const windowHeight = await app.page.evaluate(() => innerHeight);
    expect(filePickerBox.y).toBeLessThan(windowHeight * 0.15);
    await app.page.screenshot({
      path: info.outputPath("file-picker-keyboard-selection.png"),
    });
    await query.press("Enter");
    await expect(
      app.page.getByRole("textbox", { name: "File contents", exact: true }),
    ).toHaveValue("# Invented specification\n\nInitial text.\n");
    await app.page.keyboard.press(`${modifier}+Shift+F`);
    const search = app.page.getByRole("dialog", {
      name: "Search workspace",
      exact: true,
    });
    await search.getByRole("textbox").fill("Initial text");
    await expect(search.getByRole("button")).toHaveCount(1);
    const searchBox = (await search.boundingBox())!;
    expect(searchBox.y).toBeCloseTo(filePickerBox.y, 0);
    expect(searchBox.width).toBeCloseTo(filePickerBox.width, 0);
    await app.page.screenshot({
      path: info.outputPath("content-search-top-placement.png"),
    });
  } finally {
    await app.cleanup();
  }
});

test("Searchable settings apply font, terminal cursor and external edits live and preserve invalid files", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const workspace = await app.create("Settings fixture");
    const terminal = await app.cli<{ paneId: string }>(
      "terminal",
      "open",
      "--workspace",
      workspace,
    );
    await app.page.keyboard.press(`${modifier}+,`);
    const dialog = app.page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("searchbox", { name: "Search settings" })
      .fill("cursor");
    await expect(
      dialog.getByRole("combobox", { name: "Terminal Cursor shape" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("spinbutton", { name: "Interface text size" }),
    ).toBeHidden();
    await dialog
      .getByRole("combobox", { name: "Terminal Cursor shape" })
      .selectOption("bar");
    const blinking = dialog.getByRole("switch", {
      name: "Terminal Blinking cursor",
      exact: true,
    });
    await expect(blinking).not.toBeChecked();
    await blinking.hover();
    await expect(blinking).toHaveCSS("border-color", "rgb(169, 175, 188)");
    const off = await blinking.boundingBox();
    await blinking.focus();
    await blinking.press("Space");
    await expect(blinking).toBeChecked();
    await expect(blinking).toBeFocused();
    await expect(blinking).toHaveCSS("outline-style", "solid");
    expect(await blinking.boundingBox()).toEqual(off);
    await dialog.getByText("Blinking cursor", { exact: true }).click();
    await expect(blinking).not.toBeChecked();
    await blinking.press("Space");
    await expect(blinking).toBeChecked();
    await dialog
      .getByRole("button", {
        name: "Reset Terminal Blinking cursor",
        exact: true,
      })
      .click();
    await expect(blinking).not.toBeChecked();
    await blinking.press("Space");
    await expect(blinking).toBeChecked();
    await app.page.screenshot({
      path: info.outputPath("settings-controls-keyboard-focus.png"),
    });
    await expect
      .poll(
        async () =>
          (await app.cli<any>("settings", "get")).values[
            "terminal.cursorStyle"
          ],
      )
      .toBe("bar");
    await dialog.getByRole("searchbox").fill("");
    await dialog
      .getByRole("combobox", { name: "Editor Font family" })
      .selectOption("monospace");
    await expect
      .poll(
        async () =>
          (await app.cli<any>("settings", "get")).values["editor.fontFamily"],
      )
      .toBe("monospace");
    await app.page.screenshot({
      path: info.outputPath("settings-controls-normal.png"),
    });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await app.cli(
      "settings",
      "update",
      "--values",
      JSON.stringify({ "terminal.fontSize": 20, "chat.fontFamily": "serif" }),
    );
    await expect(
      app.pane(terminal.paneId).locator(".xterm-screen"),
    ).toBeVisible();
    const file = path.join(app.data, "settings.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved["terminal.cursorStyle"]).toBe("bar");
    expect(saved["terminal.cursorBlink"]).toBe(true);
    await writeFile(
      file,
      '{"ui.fontSize":18,"terminal.cursorStyle":"underline"}',
    );
    await expect(app.page.locator("html")).toHaveCSS("font-size", "18px");
    await writeFile(file, "broken JSON");
    await app.page.keyboard.press(`${modifier}+,`);
    await expect(dialog.getByRole("status")).toContainText("Invalid JSON");
    await expect(app.page.locator("html")).toHaveCSS("font-size", "18px");
    expect(await readFile(file, "utf8")).toBe("broken JSON");
    await dialog.getByRole("searchbox").fill("terminal cursor");
    await expect(blinking).toBeDisabled();
    await expect(
      dialog.getByRole("combobox", { name: "Terminal Cursor shape" }),
    ).toBeDisabled();
    await app.page.screenshot({
      path: info.outputPath("settings-controls-disabled.png"),
    });
    await dialog.getByRole("searchbox").fill("");
    // Browser preferences have independent ownership; changing one must not
    // hide the unresolved appearance-file failure or re-enable its writes.
    await dialog
      .getByRole("combobox", { name: "Search engine", exact: true })
      .selectOption("bing");
    await expect
      .poll(() => app.cli("browser", "settings"))
      .toEqual({ searchEngine: "bing" });
    await expect(dialog.getByRole("status")).toContainText("Invalid JSON");
    await expect(
      dialog.getByRole("button", { name: "Reset defaults", exact: true }),
    ).toBeDisabled();
    expect(await readFile(file, "utf8")).toBe("broken JSON");
    await writeFile(file, JSON.stringify(saved));
    await expect(dialog.getByRole("status")).toBeEmpty();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await app.stop();
    await app.start();
    expect(
      (await app.cli<any>("settings", "get")).values["terminal.cursorStyle"],
    ).toBe("bar");
  } finally {
    await app.cleanup();
  }
});

test("Global settings search and reset include the persisted browser search engine", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    await app.create("Browser settings fixture");
    await app.cli("browser", "settings", "--search-engine", "bing");
    await app.command("Settings...");
    let dialog = app.page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    let search = dialog.getByRole("searchbox", { name: "Search settings" });
    await search.fill("search engine");
    let engine = dialog.getByRole("combobox", {
      name: "Search engine",
      exact: true,
    });
    await expect(engine).toBeVisible();
    await expect(engine).toHaveValue("bing");
    await expect(
      dialog.getByRole("spinbutton", {
        name: "Interface text size",
        exact: true,
      }),
    ).toBeHidden();
    await engine.selectOption("duckduckgo");
    await expect
      .poll(() => app.cli("browser", "settings"))
      .toEqual({ searchEngine: "duckduckgo" });
    await expect(
      dialog.getByRole("button", {
        name: "Reset Browser Search engine",
        exact: true,
      }),
    ).toBeEnabled();
    await dialog
      .getByRole("button", { name: "Reset Browser Search engine", exact: true })
      .click();
    await expect(engine).toHaveValue("google");
    await expect(engine).toBeEnabled();
    await engine.selectOption("yandex");
    await expect
      .poll(() => app.cli("browser", "settings"))
      .toEqual({ searchEngine: "yandex" });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await app.stop();
    await app.start();
    await app.command("Browser settings");
    dialog = app.page.getByRole("dialog", { name: "Settings", exact: true });
    search = dialog.getByRole("searchbox", { name: "Search settings" });
    engine = dialog.getByRole("combobox", {
      name: "Search engine",
      exact: true,
    });
    await expect(engine).toHaveValue("yandex");
    await expect(search).toHaveValue("browser");
    await search.press("Tab");
    await expect(engine).toBeFocused();
    await dialog.screenshot({
      path: info.outputPath("unified-browser-settings.png"),
    });
    await app.page.setViewportSize({ width: 460, height: 700 });
    const fieldBounds = await engine.boundingBox();
    const dialogBounds = await dialog.boundingBox();
    expect(fieldBounds!.x + fieldBounds!.width).toBeLessThanOrEqual(
      dialogBounds!.x + dialogBounds!.width,
    );
    await dialog.screenshot({
      path: info.outputPath("narrow-browser-settings.png"),
    });
    await dialog
      .getByRole("button", { name: "Reset defaults", exact: true })
      .click();
    await expect
      .poll(() => app.cli("browser", "settings"))
      .toEqual({ searchEngine: "google" });
    await expect(engine).toHaveValue("google");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await app.cli("browser", "settings", "--search-engine", "bing");
    await app.cli("settings", "update", "--reset", "true");
    expect(await app.cli("browser", "settings")).toEqual({
      searchEngine: "google",
    });
    await app.stop();
    await app.start();
    expect(await app.cli("browser", "settings")).toEqual({
      searchEngine: "google",
    });
  } finally {
    await app.cleanup();
  }
});

test("Global reset reports a partial failure without claiming browser settings changed", async () => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    await app.cli("browser", "settings", "--search-engine", "bing");
    await app.cli(
      "settings",
      "update",
      "--values",
      JSON.stringify({ "ui.fontSize": 19 }),
    );
    const library = path.join(app.data, "browser-library.json");
    await rename(library, library + ".saved");
    await mkdir(library);
    const result = await app.raw("settings", "update", "--reset", "true");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Appearance settings were reset, but browser settings could not be reset",
    );
    expect(await app.cli("browser", "settings")).toEqual({
      searchEngine: "bing",
    });
    const appearance = await app.cli<{ values: Record<string, unknown> }>(
      "settings",
      "get",
    );
    expect(appearance.values["ui.fontSize"]).toBe(14);
    await rm(library, { recursive: true });
    await rename(library + ".saved", library);
  } finally {
    await app.cleanup();
  }
});

test("Settings native selectors retain keyboard selection and cancellation", async ({}, info) => {
  test.skip(
    process.platform !== "linux",
    "Native select automation uses isolated X11; macOS desktop must remain untouched",
  );
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    await app.command("Settings...");
    const dialog = app.page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await dialog
      .getByRole("searchbox", { name: "Search settings" })
      .fill("cursor shape");
    const cursor = dialog.getByRole("combobox", {
      name: "Terminal Cursor shape",
      exact: true,
    });
    const checkClosedControl = async (value: string, fontSize: number) => {
      await expect(cursor).toHaveCSS("font-size", `${fontSize}px`);
      await expect(cursor.locator("selectedcontent")).toHaveText(value);
      const geometry = await cursor.evaluate((select) => {
        const label = select.querySelector("selectedcontent")!;
        const range = document.createRange();
        range.selectNodeContents(label);
        const text = range.getBoundingClientRect();
        const field = select.getBoundingClientRect();
        const arrow = select
          .parentElement!.querySelector(".icon")!
          .getBoundingClientRect();
        return {
          labelVisible: text.width > 0,
          labelCenter: (text.top + text.bottom) / 2,
          arrowCenter: (arrow.top + arrow.bottom) / 2,
          fieldCenter: (field.top + field.bottom) / 2,
          valueGap: arrow.left - text.right,
          trailingInset: field.right - arrow.right,
        };
      });
      expect(geometry.labelVisible).toBe(true);
      expect(
        Math.abs(geometry.labelCenter - geometry.arrowCenter),
      ).toBeLessThanOrEqual(1.5);
      expect(
        Math.abs(geometry.arrowCenter - geometry.fieldCenter),
      ).toBeLessThan(1);
      expect(geometry.valueGap).toBeGreaterThanOrEqual(8);
      expect(geometry.trailingInset).toBeGreaterThanOrEqual(12);
    };
    await checkClosedControl("block", 14);
    await app.cli("settings", "update", "--values", '{"ui.fontSize":13}');
    await checkClosedControl("block", 13);
    await app.cli("settings", "update", "--values", '{"ui.fontSize":14}');
    await expect(cursor).toHaveCSS("font-size", "14px");
    await cursor.hover();
    await expect(cursor).toHaveCSS("background-color", "rgb(54, 60, 70)");
    await expect(cursor).toHaveValue("block");
    const rect = (await cursor.boundingBox())!;
    const origin = await app.app!.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return {
        bounds: win.getContentBounds(),
        nativeId: win.getNativeWindowHandle().readUInt32LE(0),
      };
    });
    await execute("xdotool", [
      "windowfocus",
      "--sync",
      String(origin.nativeId),
    ]);
    await execute("xdotool", [
      "mousemove",
      "--sync",
      String(Math.round(origin.bounds.x + rect.x + rect.width / 2)),
      String(Math.round(origin.bounds.y + rect.y + rect.height / 2)),
      "click",
      "1",
    ]);
    await expect
      .poll(() => cursor.evaluate((node) => node.matches(":open")))
      .toBe(true);
    await expect(cursor).toHaveCSS("background-color", "rgb(69, 74, 86)");
    const savedOption = cursor.getByRole("option", {
      name: "block",
      exact: true,
    });
    await expect(savedOption).toHaveAttribute("value", "block");
    expect(
      await cursor.evaluate(
        (node) => getComputedStyle(node, "::picker(select)").backgroundColor,
      ),
    ).toBe(
      await cursor.evaluate((node) => {
        const reference = document.createElement("span");
        reference.style.color = "var(--surface-raised)";
        node.parentElement!.append(reference);
        const color = getComputedStyle(reference).color;
        reference.remove();
        return color;
      }),
    );
    await execute("xdotool", ["key", "--clearmodifiers", "Down"]);
    await expect(
      cursor.getByRole("option", { name: "bar", exact: true }),
    ).toBeFocused();
    await expect(cursor).toHaveValue("block");
    const capture = await app.app!.evaluate(async ({ desktopCapturer }) => {
      const screens = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1280, height: 1024 },
      });
      return screens[0]?.thumbnail.toPNG().toString("base64");
    });
    expect(capture).toBeTruthy();
    await writeFile(
      info.outputPath("native-settings-selector.png"),
      Buffer.from(capture!, "base64"),
    );
    await execute("xdotool", ["key", "--clearmodifiers", "Escape"]);
    await expect(cursor).toHaveValue("block");
    await expect(dialog).toBeVisible();
    await expect(cursor).toBeFocused();
    await execute("xdotool", ["key", "--clearmodifiers", "space"]);
    await expect
      .poll(() => cursor.evaluate((node) => node.matches(":open")))
      .toBe(true);
    await execute("xdotool", ["key", "--clearmodifiers", "u"]);
    await expect(
      cursor.getByRole("option", { name: "underline", exact: true }),
    ).toBeFocused();
    await expect(cursor).toHaveValue("block");
    await execute("xdotool", ["key", "--clearmodifiers", "Return"]);
    await expect(cursor).toHaveValue("underline");
    await expect
      .poll(
        async () =>
          (await app.cli<any>("settings", "get")).values[
            "terminal.cursorStyle"
          ],
      )
      .toBe("underline");
    await app.page.setViewportSize({ width: 460, height: 640 });
    await app.cli("settings", "update", "--values", '{"ui.fontSize":20}');
    await checkClosedControl("underline", 20);
    const longChoice =
      "An invented unavailable cursor option with a deliberately long name";
    await cursor.evaluate((element, text) => {
      const option = new Option(text, "unavailable");
      option.disabled = true;
      (element as HTMLSelectElement).add(option);
    }, longChoice);
    await cursor.click();
    const unavailable = cursor.getByRole("option", { name: longChoice });
    await expect(unavailable).toBeDisabled();
    await expect(unavailable).toBeInViewport();
    expect((await unavailable.boundingBox())!.height).toBeGreaterThan(40);
    await expect(cursor).toHaveValue("underline");
    await app.page.screenshot({
      path: info.outputPath("native-settings-selector-narrow.png"),
    });
    await dialog
      .getByRole("heading", { name: "Settings", exact: true })
      .click();
    await expect
      .poll(() => cursor.evaluate((node) => node.matches(":open")))
      .toBe(false);
    await expect(cursor).toHaveValue("underline");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  } finally {
    await app.cleanup();
  }
});

test("Settings groups readable font choices and adjusts values without losing live preferences", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    await app.command("Settings...");
    let dialog = app.page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    for (const name of ["Interface", "Editor", "Chat", "Terminal", "Browser"])
      await expect(
        dialog.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
    await expect(
      dialog.getByText("Interface · Font family", { exact: true }),
    ).toHaveCount(0);
    const family = dialog.getByRole("combobox", {
      name: "Editor Font family",
      exact: true,
    });
    await expect(family.locator("option:checked")).toHaveText("System default");
    await family.selectOption({ label: "Custom…" });
    const custom = dialog.getByRole("textbox", {
      name: "Editor custom font family",
      exact: true,
    });
    await expect(custom).toBeFocused();
    const familyName =
      "Invented Mono with a deliberately long family name for compact settings";
    const value = `'${familyName}', monospace`;
    await custom.fill(value);
    await custom.press("Tab");
    await expect
      .poll(
        async () =>
          (await app.cli<any>("settings", "get")).values["editor.fontFamily"],
      )
      .toBe(value);
    await expect(family.locator("option:checked")).toHaveText(familyName);
    const row = dialog.locator('[data-setting-key="editor.fontSize"]');
    const size = row.getByRole("spinbutton", {
      name: "Editor text size",
      exact: true,
    });
    await size.fill("20");
    await size.press("Tab");
    await row.getByRole("button", { name: /^Increase/ }).click();
    await expect(size).toHaveValue("21");
    await size.fill("40");
    await size.press("Tab");
    await expect(row.getByRole("button", { name: /^Increase/ })).toBeDisabled();
    await row.getByRole("button", { name: /^Decrease/ }).click();
    await expect(size).toHaveValue("39");
    await row
      .getByRole("button", { name: "Reset Editor Font size", exact: true })
      .click();
    await expect(size).toHaveValue("16");
    await expect(row.getByRole("button", { name: /^Increase/ })).toBeEnabled();
    await expect(
      row.getByRole("button", { name: "Reset Editor Font size", exact: true }),
    ).toBeHidden();
    await dialog.screenshot({ path: info.outputPath("settings-sections.png") });
    const search = dialog.getByRole("searchbox", { name: "Search settings" });
    const before = await search.boundingBox();
    const heading = (await dialog
      .getByRole("heading", {
        name: "Settings",
        exact: true,
      })
      .boundingBox())!;
    expect(before!.y - heading.y - heading.height).toBeGreaterThanOrEqual(8);
    await search.fill("terminal cursor");
    await expect(
      dialog.getByRole("heading", { name: "Terminal", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Interface", exact: true }),
    ).toBeHidden();
    await expect(
      dialog.getByRole("heading", { name: "Editor", exact: true }),
    ).toBeHidden();
    expect((await search.boundingBox())!.y).toBeCloseTo(before!.y, 0);
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeVisible();
    await search.fill("Interface text size");
    await expect(
      dialog.getByRole("spinbutton", {
        name: "Interface text size",
        exact: true,
      }),
    ).toBeVisible();
    await expect(family).toBeHidden();
    await search.fill("No invented setting matches this query");
    const empty = dialog.getByText("No matching settings", { exact: true });
    await expect(empty).toBeVisible();
    await expect(dialog.getByRole("heading", { level: 3 })).toHaveCount(0);
    await dialog.screenshot({
      path: info.outputPath("settings-empty-search.png"),
    });
    await search.fill("");
    await expect(empty).toBeHidden();
    await app.page.setViewportSize({ width: 460, height: 640 });
    await app.cli(
      "settings",
      "update",
      "--values",
      JSON.stringify({ "ui.fontSize": 22 }),
    );
    await expect(app.page.locator("html")).toHaveCSS("font-size", "22px");
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    const fieldBounds = (await dialog
      .getByRole("spinbutton", { name: "Interface text size", exact: true })
      .boundingBox())!;
    const resetBounds = (await dialog
      .getByRole("button", { name: "Reset Interface Font size", exact: true })
      .boundingBox())!;
    expect(
      Math.abs(
        resetBounds.y +
          resetBounds.height / 2 -
          fieldBounds.y -
          fieldBounds.height / 2,
      ),
    ).toBeLessThan(2);
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeInViewport();
    await dialog.screenshot({
      path: info.outputPath("settings-narrow-enlarged.png"),
    });
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    const narrowSearch = await search.boundingBox();
    const narrowClose = await close.boundingBox();
    const browserSection = dialog.getByRole("heading", {
      name: "Browser",
      exact: true,
    });
    await expect(browserSection).not.toBeInViewport();
    await browserSection.scrollIntoViewIfNeeded();
    await expect(browserSection).toBeInViewport({ ratio: 1 });
    expect(await search.boundingBox()).toEqual(narrowSearch);
    expect(await close.boundingBox()).toEqual(narrowClose);
    expect((await dialog.boundingBox())!.width).toBeLessThan(460);
    await app.page.screenshot({
      path: info.outputPath("settings-scrolled-narrow.png"),
    });
    await search.fill("editor");
    await family.scrollIntoViewIfNeeded();
    const wrap = dialog.getByRole("switch", {
      name: "Editor Wrap long lines",
      exact: true,
    });
    await wrap.scrollIntoViewIfNeeded();
    await expect(wrap).toBeInViewport({ ratio: 1 });
    const selectBounds = (await family.boundingBox())!;
    expect(selectBounds.height).toBeLessThan(44);
    const arrow = family.locator("+ .icon");
    const arrowBounds = (await arrow.boundingBox())!;
    const selectStyle = await family.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        appearance: style.appearance,
        inset: parseFloat(style.paddingInlineEnd),
      };
    });
    expect(selectStyle.appearance).toBe("base-select");
    expect(selectStyle.inset).toBeGreaterThan(arrowBounds.width);
    expect(
      selectBounds.x + selectBounds.width - arrowBounds.x - arrowBounds.width,
    ).toBeGreaterThanOrEqual(8);
    await app.page.screenshot({
      path: info.outputPath("settings-controls-narrow-enlarged.png"),
    });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await app.stop();
    await app.start();
    expect(
      (await app.cli<any>("settings", "get")).values["editor.fontFamily"],
    ).toBe(value);
    await app.command("Settings...");
    dialog = app.page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog
      .getByRole("combobox", { name: "Editor Font family", exact: true })
      .selectOption({ label: "System default" });
    await expect
      .poll(
        async () =>
          (await app.cli<any>("settings", "get")).values["editor.fontFamily"],
      )
      .toBe("ui-monospace, SFMono-Regular, Menlo, monospace");
    await expect(
      dialog
        .getByRole("combobox", { name: "Editor Font family", exact: true })
        .locator("option:checked"),
    ).toHaveText("System default");
  } finally {
    await app.cleanup();
  }
});

test("Settings-related input dialogs retain native submission and exact cancel focus", async () => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const workspace = await app.create("Dialog composition fixture");
    const chat = await app.newChat(workspace, "codex");
    const composer = app
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("retained unsent message");
    await composer.evaluate((node: HTMLTextAreaElement) =>
      node.setSelectionRange(2, 7),
    );
    await app.command("Chat maximum width");
    let dialog = app.page.getByRole("dialog", {
      name: "Chat maximum width",
      exact: true,
    });
    let value = dialog.getByRole("spinbutton", {
      name: "Chat maximum width (pixels)",
      exact: true,
    });
    await expect(
      dialog
        .getByRole("button", { name: "Cancel", exact: true })
        .locator("kbd"),
    ).toHaveText("Esc");
    await expect(
      dialog.getByRole("button", { name: "Save", exact: true }).locator("kbd"),
    ).toHaveText("Enter");
    await value.fill("1250");
    await value.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("retained unsent message");
    expect(
      await composer.evaluate((node: HTMLTextAreaElement) => [
        node.selectionStart,
        node.selectionEnd,
      ]),
    ).toEqual([2, 7]);
    await app.command("Chat maximum width");
    dialog = app.page.getByRole("dialog", {
      name: "Chat maximum width",
      exact: true,
    });
    value = dialog.getByRole("spinbutton", {
      name: "Chat maximum width (pixels)",
      exact: true,
    });
    await value.fill("1250");
    await value.press("Enter");
    await expect(dialog).toHaveCount(0);
    const state = await app.cli<{
      workspaces: Array<{ id: string; settings?: { chatMaxWidth?: number } }>;
    }>("state");
    expect(
      state.workspaces.find((item) => item.id === workspace)?.settings
        ?.chatMaxWidth,
    ).toBe(1250);
    await expect(composer).toHaveValue("retained unsent message");
  } finally {
    await app.cleanup();
  }
});

test("Settings returns native page focus and field selection after Close and Escape", async () => {
  const app = new ChatApp();
  await app.prepare();
  try {
    const file = path.join(app.folders[0], "settings-focus.html");
    await writeFile(
      file,
      '<!doctype html><title>Invented Settings focus</title><input id="field" value="abcdefghij">',
    );
    const url = pathToFileURL(file).href;
    await app.start();
    const workspace = await app.create("Native Settings focus");
    const browser = await app.cli<{ id: string }>(
      "browser",
      "open",
      "--workspace",
      workspace,
      "--url",
      url,
    );
    const inspect = () =>
      app.app!.evaluate(async ({ webContents }, url) => {
        const wc = webContents
          .getAllWebContents()
          .find((item) => item.getURL() === url);
        if (!wc) return null;
        return {
          focused: wc.isFocused(),
          ...(await wc.executeJavaScript(
            "({value:field.value,start:field.selectionStart,end:field.selectionEnd})",
          )),
        };
      }, url);
    await expect.poll(inspect).not.toBeNull();
    await expect
      .poll(
        async () =>
          (
            await app.cli<{ visible: boolean }>(
              "browser",
              "inspect",
              "--id",
              browser.id,
            )
          ).visible,
      )
      .toBe(true);
    await app.page
      .getByRole("combobox", { name: "Address", exact: true })
      .click();
    if (process.platform === "linux") {
      const point = await app.app!.evaluate(
        async ({ BrowserWindow, webContents }, url) => {
          const wc = webContents
            .getAllWebContents()
            .find((item) => item.getURL() === url)!;
          const host = BrowserWindow.getAllWindows().find((window) =>
            window.contentView.children.some(
              (view) => (view as any).webContents?.id === wc.id,
            ),
          )!;
          const view = host.contentView.children.find(
            (view) => (view as any).webContents?.id === wc.id,
          )!;
          const viewport = view.getBounds(),
            origin = host.getContentBounds();
          const field = await wc.executeJavaScript(
            "(()=>{const r=field.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()",
          );
          host.focus();
          return {
            x: Math.round(origin.x + viewport.x + field.x),
            y: Math.round(origin.y + viewport.y + field.y),
          };
        },
        url,
      );
      await execute("xdotool", [
        "mousemove",
        "--sync",
        String(point.x),
        String(point.y),
        "click",
        "--clearmodifiers",
        "1",
      ]);
    } else
      await app.app!.evaluate(async ({ webContents }, url) => {
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.getURL() === url)!;
        await wc.executeJavaScript("field.focus()");
        wc.focus();
      }, url);
    await app.app!.evaluate(async ({ webContents }, url) => {
      const wc = webContents
        .getAllWebContents()
        .find((item) => item.getURL() === url)!;
      await wc.executeJavaScript("field.setSelectionRange(2,7)");
    }, url);
    const key = (keyCode: string, mod = false, shift = false) =>
      app.app!.evaluate(
        ({ webContents }, { url, keyCode, mod, shift }) => {
          const wc = webContents
            .getAllWebContents()
            .find((item) => item.getURL() === url)!;
          const modifiers: Array<"control" | "meta" | "shift"> = mod
            ? [process.platform === "darwin" ? "meta" : "control"]
            : [];
          if (shift) modifiers.push("shift");
          wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
          wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
        },
        { url, keyCode, mod, shift },
      );
    await expect.poll(async () => (await inspect())?.focused).toBe(true);
    await key(",", true);
    let dialog = app.page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(inspect)
      .toMatchObject({ focused: true, start: 2, end: 7 });
    await key("Right");
    await expect
      .poll(inspect)
      .toMatchObject({ focused: true, value: "abcdefghij", start: 7, end: 7 });
    await key(",", true);
    dialog = app.page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("searchbox", { name: "Search settings" })
      .press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(inspect)
      .toMatchObject({ focused: true, value: "abcdefghij", start: 7, end: 7 });
    await key("P", true, true);
    const palette = app.page.getByRole("dialog", {
      name: "Command palette",
      exact: true,
    });
    await palette
      .getByRole("textbox", { name: "Filter commands" })
      .fill("Browser settings");
    await palette
      .getByRole("button", { name: "Browser settings", exact: true })
      .click();
    dialog = app.page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(
      dialog.getByRole("searchbox", { name: "Search settings" }),
    ).toHaveValue("browser");
    await dialog
      .getByRole("searchbox", { name: "Search settings" })
      .press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(inspect)
      .toMatchObject({ focused: true, value: "abcdefghij", start: 7, end: 7 });
    await key(",", true);
    dialog = app.page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog
      .getByRole("button", { name: "Keyboard shortcuts", exact: true })
      .click();
    const shortcuts = app.page.getByRole("dialog", {
      name: "Keyboard shortcuts",
      exact: true,
    });
    await expect(shortcuts).toBeVisible();
    await shortcuts
      .getByRole("textbox", { name: "Search shortcuts", exact: true })
      .press("Escape");
    await expect(shortcuts).toHaveCount(0);
    await expect
      .poll(inspect)
      .toMatchObject({ focused: true, value: "abcdefghij", start: 7, end: 7 });
    await key(",", true);
    dialog = app.page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(dialog).toBeVisible();
    await app.cli("browser", "close", "--id", browser.id);
    await expect.poll(inspect).toBeNull();
    await dialog
      .getByRole("searchbox", { name: "Search settings" })
      .press("Escape");
    await expect(dialog).toHaveCount(0);
    const header = app.page.getByRole("button", {
      name: "Overview",
      exact: true,
    });
    await header.focus();
    await app.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(header).toBeFocused();
  } finally {
    await app.cleanup();
  }
});

test("Settings preserves a shell field selection and late cleanup respects newer focus", async () => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const input = app.page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await input.fill("Invented retained settings draft");
    await input.evaluate((node: HTMLTextAreaElement) =>
      node.setSelectionRange(3, 9, "backward"),
    );
    await input.press(`${modifier}+,`);
    let dialog = app.page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await dialog.evaluate((dialog) => {
      const hold = (event: Event) => {
        event.stopImmediatePropagation();
        (window as any).releaseSettingsClose = () => {
          dialog.removeEventListener("close", hold, true);
          dialog.dispatchEvent(new Event("close", { bubbles: true }));
        };
      };
      dialog.addEventListener("close", hold, true);
    });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(input).toBeFocused();
    const selection = () =>
      input.evaluate((node: HTMLTextAreaElement) => [
        node.selectionStart,
        node.selectionEnd,
        node.selectionDirection,
      ]);
    expect(await selection()).toEqual([3, 9, "backward"]);
    await expect
      .poll(() =>
        app.page.evaluate(() => typeof (window as any).releaseSettingsClose),
      )
      .toBe("function");
    const header = app.page.getByRole("button", {
      name: "Overview",
      exact: true,
    });
    await header.focus();
    await app.page.evaluate(() => (window as any).releaseSettingsClose());
    await app.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(header).toBeFocused();
    await expect(input).toHaveValue("Invented retained settings draft");
    await input.focus();
    await input.press(`${modifier}+,`);
    dialog = app.page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog
      .getByRole("searchbox", { name: "Search settings" })
      .fill("font");
    await dialog
      .getByRole("searchbox", { name: "Search settings" })
      .press("Escape");
    await expect(input).toBeFocused();
    expect(await selection()).toEqual([3, 9, "backward"]);
  } finally {
    await app.cleanup();
  }
});
