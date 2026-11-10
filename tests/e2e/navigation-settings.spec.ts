import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
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
    await settings.getByRole("button", { name: "Done", exact: true }).click();
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
      app.pane(review.paneId).locator(".review-line").first(),
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
    await app.page.getByRole("button", { name: "Done", exact: true }).click();
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

test("Folder actions use the native chooser from Commands and empty and populated file trees", async ({}, info) => {
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

test("Header pane controls follow the visible left and right regions and restore hidden panes", async ({}, info) => {
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
    const left = () =>
      app.page.getByRole("button", { name: "Hide left pane", exact: true });
    const right = () =>
      app.page.getByRole("button", { name: "Hide right pane", exact: true });
    await expect(left()).toHaveAttribute("aria-pressed", "true");
    await expect(right()).toHaveAttribute("aria-pressed", "true");
    await expect(left()).toHaveCSS("color", "rgb(97, 175, 239)");
    await left().click();
    await expect(app.pane(file.paneId)).toBeHidden();
    await expect(app.page.locator(".composer textarea")).toBeVisible();
    await app.page
      .getByRole("button", { name: "Show left pane", exact: true })
      .click();
    await expect(app.pane(file.paneId)).toBeVisible();
    await right().click();
    await expect(app.page.locator(".composer textarea")).toBeHidden();
    await expect(app.pane(file.paneId)).toBeVisible();
    await app.page
      .getByRole("button", { name: "Show right pane", exact: true })
      .click();
    await expect(app.page.locator(".composer textarea")).toBeVisible();
    const leftGroup = await left().getAttribute("data-group-id");
    const split = await app.cli<{ paneId: string; groupId: string }>(
      "group",
      "split",
      "--workspace",
      workspace,
      "--id",
      leftGroup!,
      "--direction",
      "down",
    );
    await expect(
      app.page.getByRole("button", { name: "Hide top left pane", exact: true }),
    ).toBeVisible();
    await expect(
      app.page.getByRole("button", {
        name: "Hide bottom left pane",
        exact: true,
      }),
    ).toBeVisible();
    await app.page
      .getByRole("button", { name: "Hide bottom left pane", exact: true })
      .click();
    await expect(app.pane(split.paneId)).toBeHidden();
    await expect(app.pane(file.paneId)).toBeVisible();
    await app.page
      .getByRole("button", { name: "Show bottom left pane", exact: true })
      .click();
    await expect(app.pane(split.paneId)).toBeVisible();
    await app.page.screenshot({
      path: info.outputPath("spatial-pane-controls.png"),
    });
    await app.cli(
      "group",
      "zoom",
      "--workspace",
      workspace,
      "--id",
      split.groupId,
    );
    await expect(app.pane(file.paneId)).toBeHidden();
    await app.page
      .getByRole("button", { name: "Show top left pane", exact: true })
      .click();
    await expect(app.pane(file.paneId)).toBeVisible();
    await expect(app.pane(split.paneId)).toBeVisible();
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
    await input.press("Enter");
    await expect(
      app.page.getByRole("textbox", { name: "Workspace name", exact: true }),
    ).toBeVisible();
    await app.page.keyboard.press("Escape");
    await expect(composer).toBeFocused();
    expect(
      await composer.evaluate(
        (node) => (node as HTMLTextAreaElement).selectionStart,
      ),
    ).toBe(caret);
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
      .getByRole("button", { name: "Switch workspace", exact: true })
      .click();
    const picker = app.page.getByRole("dialog");
    const filter = picker.getByRole("textbox");
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
