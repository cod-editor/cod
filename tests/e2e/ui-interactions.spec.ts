import type { AppState } from "../../src/types";
import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { ChatApp } from "./helpers/chat-fixture/harness";
import { modifier, tabTo } from "./helpers/workspace-app";
test.setTimeout(90_000);
test("First-run controls, menus, pending work and failure recovery remain usable", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  await app.configure({
    codex: { options: true, initializeDelayMs: 2500 },
    kimi: { options: true },
  });
  const observations: unknown[] = [];
  const capture = async (name: string) => {
    await app.page.screenshot({ path: info.outputPath(name + ".png") });
    observations.push({
      name,
      accessible: await app.page.locator("body").ariaSnapshot(),
      controls: await app.page
        .locator("button,input,textarea,select")
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            tag: node.tagName,
            label: node.getAttribute("aria-label") ?? node.textContent,
            disabled: (node as HTMLButtonElement).disabled,
            rect: {
              width: node.getBoundingClientRect().width,
              height: node.getBoundingClientRect().height,
            },
            background: getComputedStyle(node).backgroundColor,
            padding: getComputedStyle(node).padding,
          })),
        ),
    });
  };
  try {
    await app.start();
    await capture("01-clean-launch");
    await app.page
      .getByRole("button", { name: "Overview", exact: true })
      .click();
    await capture("02-workspace-picker");
    await app.page.keyboard.press("Escape");
    await app.page
      .getByRole("button", { name: "Provider", exact: true })
      .click();
    await capture("03-provider-menu");
    await app.page.keyboard.press("Escape");
    await app.command("New workspace");
    await expect(app.page.getByRole("dialog")).toHaveCount(0);
    await app.command("Rename workspace");
    const overview = app.page.getByRole("dialog", {
      name: "Overview",
      exact: true,
    });
    const name = overview.getByRole("textbox", {
      name: "Workspace name",
      exact: true,
    });
    const search = overview.getByRole("combobox", { name: "Search Overview" });
    await name.fill("Explore report export");
    await name.press("Enter");
    await expect(app.row("Explore report export")).toBeVisible();
    await expect(search).toBeFocused();
    await search.press("Escape");

    const message = app.page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await expect(message).toBeFocused();
    await message.fill("[hold] Explain the report export requirements");
    await app.page.keyboard.press(`${modifier}+Enter`);
    await capture("05-first-send-pending");
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    await capture("06-active-agent");
    await app.page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      app.page.getByText("Turn interrupted.", { exact: true }),
    ).toBeVisible();
    await capture("07-interrupted");
    await app.page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("[crash] Explain failure handling");
    await app.page.keyboard.press(`${modifier}+Enter`);
    await expect(
      app.page.getByRole("status", { name: "Conversation status" }),
    ).toContainText("failed");
    await expect(
      app.page.getByText("Provider failed: Provider process exited (23)", {
        exact: true,
      }),
    ).toHaveCount(1);
    await capture("08-provider-error");
    await app.page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Retry the same discussion");
    await app.page.keyboard.press(`${modifier}+Enter`);
    await expect(
      app.page.getByText("DONE Retry the same discussion", { exact: true }),
    ).toBeVisible();
    await capture("09-recovered");
    await app.overview();
    await app.row("Explore report export").click({ button: "right" });
    await capture("10-workspace-context-menu");
    await app.page.keyboard.press("Escape");
    await expect(search).toBeFocused();
    await search.press("Escape");
    await app.command("Install agent integration...");
    await capture("11-integration-dialog");
  } catch (error) {
    await capture("failure-state").catch(() => undefined);
    throw error;
  } finally {
    await writeFile(
      info.outputPath("observations.json"),
      JSON.stringify(observations, null, 2),
    );
    await app.cleanup();
  }
});

test("Integration setup can be deferred, reopened and installed only after preview", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  const profile = path.join(app.temporary, "codex-profile");
  await mkdir(profile);
  await writeFile(
    path.join(profile, "config.toml"),
    'model = "fixture-model"\n',
  );
  app.environment.CODEX_HOME = profile;
  app.environment.KIMI_CODE_HOME = path.join(app.temporary, "kimi-profile");
  app.environment.CLAUDE_CONFIG_DIR = path.join(
    app.temporary,
    "claude-profile",
  );
  try {
    await app.start();
    await expect(
      app.page.getByRole("button", { name: "Set up integration", exact: true }),
    ).toBeVisible();
    const setup = app.page.getByRole("button", {
      name: "Set up integration",
      exact: true,
    });
    await expect(setup).toBeEnabled();
    await app.page.screenshot({ path: info.outputPath("setup-offer.png") });
    await setup.click();
    const firstDialog = app.page.getByRole("dialog", {
      name: "Install agent integration",
      exact: true,
    });
    await expect(
      firstDialog.getByRole("textbox", { name: "Agent profile directory" }),
    ).toHaveValue(profile);
    await firstDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(firstDialog).toHaveCount(0);
    await app.page
      .getByRole("button", { name: "Not now", exact: true })
      .click();
    await expect(
      app.page.getByRole("button", { name: "Set up integration", exact: true }),
    ).toHaveCount(0);
    await app.stop();
    await app.start();
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeVisible();
    await expect(
      app.page.getByRole("button", { name: "Set up integration", exact: true }),
    ).toHaveCount(0);
    await app.page
      .getByRole("textbox", { name: "Message", exact: true })
      .focus();
    await app.command("Install agent integration...");
    const dialog = app.page.getByRole("dialog", {
      name: "Install agent integration",
    });
    await expect(
      dialog.getByRole("textbox", { name: "Agent profile directory" }),
    ).toHaveValue(profile);
    await expect(
      dialog.getByRole("button", { name: "Install integration", exact: true }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeFocused();
    await app.command("Install agent integration...");
    await dialog
      .getByRole("button", { name: "Preview changes", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Install integration", exact: true }),
    ).toBeEnabled();
    expect(await readFile(path.join(profile, "config.toml"), "utf8")).toBe(
      'model = "fixture-model"\n',
    );
    await app.page.screenshot({ path: info.outputPath("setup-preview.png") });
    await dialog
      .getByRole("button", { name: "Install integration", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toHaveText(
      "Integration installed.",
    );
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await app.command("Install agent integration...");
    await dialog
      .getByRole("button", { name: "Preview changes", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toHaveText(
      "Integration is installed.",
    );
    await expect(
      dialog.getByRole("button", { name: "Install integration", exact: true }),
    ).toHaveCount(0);
  } finally {
    await app.cleanup();
  }
});

test("A preview update notice only hands off the asset on explicit activation", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const action = app.page.getByRole("button", { name: "Download update" });
    await expect(action).toBeHidden();
    await app.app!.evaluate(({ BrowserWindow, ipcMain }) => {
      const state = { opened: 0 };
      Object.assign(globalThis, { previewNoticeFixture: state });
      ipcMain.removeHandler("cod:preview-update-open");
      ipcMain.handle("cod:preview-update-open", () => {
        state.opened++;
      });
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(760, 650);
      window.webContents.send("cod:preview-update", "0.1.0-preview.2");
    });
    await expect(action).toBeVisible();
    await expect(action).toHaveAttribute(
      "title",
      "Download Cod 0.1.0-preview.2",
    );
    for (const fontSize of [20, 32]) {
      await app.cli(
        "settings",
        "update",
        "--values",
        JSON.stringify({ "ui.fontSize": fontSize }),
      );
      await expect(app.page.locator("html")).toHaveCSS(
        "font-size",
        `${fontSize}px`,
      );
      expect(
        await action.evaluate((node) => {
          const action = node.getBoundingClientRect();
          const area = node.parentElement!.getBoundingClientRect();
          return (
            action.left >= area.left &&
            action.right <= area.right &&
            action.top >= area.top &&
            action.bottom <= area.bottom
          );
        }),
      ).toBe(true);
    }
    const handoffs = () =>
      app.app!.evaluate(() => (globalThis as any).previewNoticeFixture.opened);
    expect(await handoffs()).toBe(0);
    await action.focus();
    await expect(action).toBeFocused();
    await app.page.screenshot({
      path: info.outputPath("preview-update-notice.png"),
    });
    await action.press("Enter");
    await expect.poll(handoffs).toBe(1);
    await app.app!.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send(
        "cod:preview-update",
        null,
      );
    });
    await expect(action).toBeHidden();
    expect(await handoffs()).toBe(1);
  } finally {
    await app.cleanup();
  }
});

test("Compact tab actions have visible mouse feedback without disturbing the selected view", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const tabs = app.page.locator(".tabs").first();
    const close = tabs.locator(".tab-close").first();
    const selected = tabs.getByRole("tab", { selected: true });
    await selected.hover();
    const idle = await close.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    const centers = await close.evaluate((node) => {
      const button = node.getBoundingClientRect();
      const icon = node.querySelector("svg")!.getBoundingClientRect();
      return {
        x: Math.abs(button.x + button.width / 2 - icon.x - icon.width / 2),
        y: Math.abs(button.y + button.height / 2 - icon.y - icon.height / 2),
      };
    });
    expect(centers.x).toBeLessThanOrEqual(0.5);
    expect(centers.y).toBeLessThanOrEqual(0.5);
    await close.hover();
    const hover = await close.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    expect(
      hover,
      "Close needs its own hover feedback inside a hovered tab",
    ).not.toBe(idle);
    await app.page.screenshot({ path: info.outputPath("tab-close-hover.png") });
    await app.page.mouse.down();
    await app.page.screenshot({
      path: info.outputPath("tab-close-pressed.png"),
    });
    await app.page.mouse.move(800, 400);
    await app.page.mouse.up();
    await expect(selected).toHaveCount(1);
    for (const name of [
      "Choose new tab type",
      "Toggle split view",
      "Overview",
      "Provider",
    ]) {
      const control = app.page
        .getByRole("button", { name, exact: true })
        .first();
      await control.hover();
      await app.page.screenshot({
        path: info.outputPath(
          name.toLowerCase().replaceAll(" ", "-") + "-hover.png",
        ),
      });
    }
    await app.page
      .getByRole("button", { name: "Choose new tab type", exact: true })
      .click();
    await app.page.screenshot({ path: info.outputPath("new-tab-choices.png") });
    await app.page.keyboard.press("Escape");
    await app.page
      .getByRole("button", { name: "Toggle split view", exact: true })
      .click();
    await app.page.screenshot({
      path: info.outputPath("single-group-selected-tab.png"),
    });
    await app.page
      .getByRole("button", { name: "Toggle split view", exact: true })
      .click();
    await app.stop();
    app.launchArguments = ["--force-device-scale-factor=2"];
    await app.start();
    await expect.poll(() => app.page.evaluate(() => devicePixelRatio)).toBe(2);
    await app.page.locator(".tab-close").first().hover();
    const raster = await app.app!.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString("base64"),
    );
    const png = Buffer.from(raster, "base64");
    expect(png.readUInt32BE(16)).toBe(
      await app.page.evaluate(() => innerWidth * devicePixelRatio),
    );
    await writeFile(info.outputPath("tab-close-hover-scale2.png"), png);
  } finally {
    await app.cleanup();
  }
});

test("Files panel width resizes by pointer and keyboard, persist, and restore after viewport clamping", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeVisible();
    const workspace = (await app.state()).activeWorkspaceId!;
    await app.page
      .getByRole("button", { name: "Toggle files", exact: true })
      .click();
    const separator = () =>
      app.page.getByRole("separator", {
        name: "Resize files",
        exact: true,
      });
    const width = () =>
      app.page
        .locator("#project-panel")
        .evaluate((node) => node.getBoundingClientRect().width);
    await separator().hover();
    await app.page.screenshot({
      path: info.outputPath("workspace-resize-hover.png"),
    });
    const bounds = await separator().boundingBox();
    await app.page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + 40);
    await app.page.mouse.down();
    await app.page.mouse.move(
      bounds!.x + bounds!.width / 2 + 190,
      bounds!.y + 40,
    );
    await app.page.mouse.up();
    await expect.poll(width).toBe(400);
    await separator().press("ArrowRight");
    await expect.poll(width).toBe(416);
    const preferred = async () =>
      (
        (await app.workspace(workspace)) as unknown as {
          settings: { filesWidth: number };
        }
      ).settings.filesWidth;
    await expect.poll(preferred).toBe(416);
    await app.stop();
    await app.start();
    await expect.poll(width).toBe(416);
    await app.app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(760, 800),
    );
    await expect.poll(width).toBeLessThan(416);
    expect(await preferred()).toBe(416);
    await app.app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1280, 800),
    );
    await expect.poll(width).toBe(416);
    await app.page.screenshot({
      path: info.outputPath("navigation-width-restored.png"),
    });
  } finally {
    await app.cleanup();
  }
});

test("Pressed Stop, tab close and menu triggers survive streamed and background state updates", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  await app.configure({ codex: { streamDelayMs: 1200 } });
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      "<!doctype html><title>Initial page</title><h1>Invented browser page</h1>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server unavailable");
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    await app.start();
    const workspace = await app.create("Continuous controls");
    const chat = await app.newChat(workspace, "codex");
    await app.send(chat.id, "[hold] Update while pressing Stop");
    const stop = app.page.getByRole("button", { name: "Stop", exact: true });
    await stop.hover();
    const pressed = await stop.elementHandle();
    await app.page.mouse.down();
    await expect(
      app.page.getByText("STREAM [hold] Update while pressing Stop", {
        exact: true,
      }),
    ).toBeAttached();
    expect(await pressed!.evaluate((node) => node.isConnected)).toBe(true);
    await app.page.screenshot({
      path: info.outputPath("stop-held-through-stream.png"),
    });
    await app.page.mouse.up();
    await expect(
      app.page.getByText("Turn interrupted.", { exact: true }),
    ).toBeVisible();
    const file = await app.cli<{ paneId: string }>(
      "file",
      "open",
      "--workspace",
      workspace,
      "--path",
      app.file,
    );
    const close = app.page.getByRole("button", {
      name: "Close spec.md",
      exact: true,
    });
    await close.hover();
    const closeNode = await close.elementHandle();
    await app.page.mouse.down();
    await app.cli(
      "workspace",
      "rename",
      "--id",
      workspace,
      "--name",
      "Background rename one",
    );
    await expect(
      app.page.getByRole("button", { name: "Overview", exact: true }),
    ).toHaveText("Background rename one");
    expect(await closeNode!.evaluate((node) => node.isConnected)).toBe(true);
    await app.page.mouse.up();
    await expect(app.pane(file.paneId)).toHaveCount(0);
    const browser = await app.cli<{ paneId: string }>(
      "browser",
      "open",
      "--workspace",
      workspace,
      "--url",
      url,
    );
    const browserClose = app.page.getByRole("button", {
      name: "Close Initial page",
      exact: true,
    });
    await browserClose.hover();
    const browserCloseNode = await browserClose.elementHandle();
    await app.page.mouse.down();
    const page = app
      .app!.context()
      .pages()
      .find((candidate) => candidate.url() === url)!;
    await page.evaluate(() => {
      document.title = "Loaded page";
    });
    await expect(
      app.page.getByRole("button", { name: "Close Loaded page", exact: true }),
    ).toBeVisible();
    expect(await browserCloseNode!.evaluate((node) => node.isConnected)).toBe(
      true,
    );
    await app.page.mouse.up();
    await expect(app.pane(browser.paneId)).toHaveCount(0);
    const add = app.page
      .getByRole("button", { name: "Choose new tab type", exact: true })
      .first();
    await add.hover();
    const addNode = await add.elementHandle();
    await app.page.mouse.down();
    await app.cli(
      "workspace",
      "rename",
      "--id",
      workspace,
      "--name",
      "Background rename two",
    );
    await expect(
      app.page.getByRole("button", { name: "Overview", exact: true }),
    ).toHaveText("Background rename two");
    expect(await addNode!.evaluate((node) => node.isConnected)).toBe(true);
    await app.page.mouse.up();
    await expect(
      app.page.getByRole("dialog", {
        name: "Actions",
        exact: true,
      }),
    ).toBeVisible();
    await app.page.keyboard.press("Escape");
    await expect(
      app.page.getByRole("dialog", { name: "Actions", exact: true }),
    ).toHaveCount(0);
    const secondary = await app.cli<{ id: string }>(
      "workspace",
      "create",
      "--name",
      "Second task",
    );
    await app.overview();
    const target = app.row("Second task");
    await target.hover();
    const targetNode = await target.elementHandle();
    await app.page.mouse.down();
    await app.cli(
      "conversation",
      "report-status",
      "--id",
      chat.id,
      "--status",
      "waiting",
      "--context",
      "Invented background question",
    );
    await expect(
      app.row("Background rename two").locator(".."),
    ).toHaveAttribute("data-status", "waiting");
    expect(await targetNode!.evaluate((node) => node.isConnected)).toBe(true);
    await app.page.mouse.up();
    await expect
      .poll(async () => (await app.state()).activeWorkspaceId)
      .toBe(secondary.id);
  } finally {
    await app.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Keyboard model choice retains focus and the next prompt uses the selected native model", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  await app.configure({
    codex: { options: true, multipleModels: true, reasoningOptions: true },
  });
  try {
    await app.start();
    const workspace = await app.create("Choose model");
    const chat = await app.newChat(workspace, "codex");
    const model = app.page.getByRole("button", {
      name: "Model",
      exact: true,
    });
    await expect(model).toBeEnabled();
    await app.page.screenshot({
      path: info.outputPath("model-reasoning-closed-controls.png"),
    });
    await model.focus();
    await model.press("Enter");
    const menu = app.page.getByRole("dialog", { name: "Actions" });
    await expect(
      menu.getByRole("button", { name: "Fixture model", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const box = await menu.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(
      await app.page.evaluate(() => innerHeight),
    );
    await app.page.screenshot({
      path: info.outputPath("model-menu-above-composer.png"),
    });
    await app.page.keyboard.press("ArrowDown");
    await app.page.keyboard.press("Enter");
    await expect(model).toHaveText("Alternate fixture");
    await expect(model).toBeEnabled();
    await expect(model).toBeFocused();
    const composer = app.page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.fill("Check the chosen model");
    await composer.press(`${modifier}+Enter`);
    await expect(
      app.page.getByText("DONE Check the chosen model", { exact: true }),
    ).toBeVisible();
    expect((await app.prompts()).at(-1)?.message?.params?.model).toBe(
      "fixture-alternate",
    );
    expect((await app.inspect(chat.id)).status).toBe("ready");
  } finally {
    await app.cleanup();
  }
});

test("New chat aliases recover from zero workspaces without restoring archived sessions or starting inference", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    let composer = app.page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.fill(
      "Keep this invented history in its archived workspace.",
    );
    await composer.press(`${modifier}+Enter`);
    await expect(
      app.page.getByText(
        "DONE Keep this invented history in its archived workspace.",
        { exact: true },
      ),
    ).toBeVisible();
    const initial = await app.cli<AppState>("state");
    const original = initial.workspaces[0];
    const conversation = initial.conversations[0];
    const promptCount = (await app.prompts()).length;
    const starts = (await app.records()).filter(
      (record) => record.event === "started",
    ).length;
    await composer.fill("Unsent draft remains with the archived chat.");
    await app.overview();
    await app.row(original.name).first().click({ button: "right" });
    await app.page
      .getByRole("button", { name: "Close workspace", exact: true })
      .click();
    await expect
      .poll(async () => (await app.state()).workspaces.length)
      .toBe(0);
    await app.page.keyboard.press("Escape");
    await app.stop();
    await app.start();
    composer = app.page.getByRole("textbox", { name: "Message", exact: true });
    expect((await app.state()).workspaces).toHaveLength(0);
    for (const alias of ["chat", "session", "conversation"]) {
      await app.page.keyboard.press(`${modifier}+Shift+P`);
      const palette = app.page.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("textbox").fill(alias);
      await expect(
        palette.getByRole("button", { name: "New chat", exact: true }),
      ).toBeVisible();
      if (alias === "conversation")
        await palette
          .getByRole("button", { name: "New chat", exact: true })
          .click();
      else await app.page.keyboard.press("Escape");
    }
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("");
    const fresh = await app.cli<AppState>("state");
    expect(fresh.workspaces).toHaveLength(1);
    expect(fresh.workspaces[0].id).not.toBe(original.id);
    expect(fresh.conversations).toHaveLength(0);
    expect(
      fresh.closedWorkspaces?.find((w) => w.workspace.id === original.id)
        ?.conversations[0].nativeId,
    ).toBe(conversation.nativeId);
    expect(await app.prompts()).toHaveLength(promptCount);
    await app.command("New chat");
    expect((await app.state()).workspaces[0].panes).toHaveLength(1);
    expect(
      (await app.records()).filter((record) => record.event === "started"),
    ).toHaveLength(starts);
    await app.page.screenshot({
      path: info.outputPath("new-chat-after-last-workspace-closed.png"),
    });
    await app.cli("workspace", "reopen", "--id", original.id);
    await expect(
      app.page.getByText(
        "DONE Keep this invented history in its archived workspace.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(composer).toHaveValue(
      "Unsent draft remains with the archived chat.",
    );
    expect(await app.prompts()).toHaveLength(promptCount);
  } finally {
    await app.cleanup();
  }
});

test("Session selection stays local and keyboard editor focus has no enclosing bright outline", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  const source = path.join(app.folders[0], "report-export.ts");
  await writeFile(
    source,
    `export interface ReportRow {
  title: string;
  amount: number;
}

export function exportReport(rows: ReportRow[]): string {
  const header = "Title,Amount";
  const lines = rows.map((row) => {
    const title = row.title.replaceAll('"', '""');
    return '\"' + title + '\",' + row.amount;
  });
  return [header, ...lines].join("\\n");
}
`,
  );
  await app.configure({
    codex: {
      narrative:
        "I inspected the report export. The existing permissions check can be reused, and quoted CSV values need coverage. I will keep the change small and preserve the current filters.",
    },
  });
  try {
    await app.start();
    const composer = app.page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.fill("Inspect the invented specification.");
    await composer.press(`${modifier}+Enter`);
    await expect(
      app.page.getByText("DONE Inspect the invented specification.", {
        exact: true,
      }),
    ).toBeVisible();
    const state = await app.state();
    const workspace = state.workspaces[0];
    const overview = await app.overview();
    await expect(
      overview.locator('.overview-item[aria-selected="true"]'),
    ).toHaveCount(1);
    await expect(app.row(workspace.name).first()).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await app.page.screenshot({
      path: info.outputPath("selected-chat-not-parent.png"),
    });
    await app.page.keyboard.press("Escape");
    await app.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace.id,
      "--path",
      app.folders[0],
    );
    await app.cli(
      "file",
      "open",
      "--workspace",
      workspace.id,
      "--path",
      source,
    );
    await app.page
      .getByRole("button", { name: "Toggle files", exact: true })
      .click();
    const editor = app.page.getByRole("textbox", {
      name: "File contents",
      exact: true,
    });
    await editor.focus();
    await editor.press("ArrowRight");
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    await expect(
      app.page.getByRole("dialog", { name: "Command palette" }),
    ).toBeVisible();
    await app.page.keyboard.press("Escape");
    await expect(editor).toBeFocused();
    const outline = await editor.evaluate((node) => ({
      width: getComputedStyle(node).outlineWidth,
      style: getComputedStyle(node).outlineStyle,
    }));
    expect(outline.width === "0px" || outline.style === "none").toBe(true);
    await editor.press("End");
    await editor.press("!");
    await expect(editor).toBeFocused();
    await app.page.screenshot({
      path: info.outputPath("keyboard-editor-focus.png"),
    });
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    await app.page.screenshot({
      path: info.outputPath("populated-code-chat-palette.png"),
    });
    await app.page.keyboard.press("Escape");
  } finally {
    await app.cleanup();
  }
});

test("Model menu preserves caret, fits above the composer and rolls back a rejected native choice", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  await app.configure({
    kimi: {
      options: true,
      multipleModels: true,
      optionDelayMs: 800,
      optionError: true,
    },
  });
  try {
    await app.start();
    const workspace = await app.create("Native model choice");
    const chat = await app.newChat(workspace, "kimi");
    const model = app.page.getByRole("button", { name: "Model", exact: true });
    const composer = app.page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.fill("Keep this draft and caret.");
    await composer.press("Home");
    await composer.press("ArrowRight");
    await tabTo(app.page, model);
    await app.page.keyboard.press("Enter");
    const menu = app.page.getByRole("dialog", { name: "Actions" });
    await expect(
      menu.getByRole("button", { name: "Fixture model", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await app.page.keyboard.press("Escape");
    await expect(model).toBeFocused();
    await tabTo(app.page, composer);
    expect(
      await composer.evaluate((n: HTMLTextAreaElement) => n.selectionStart),
    ).toBe(1);
    await tabTo(app.page, model);
    await app.page.keyboard.press("Enter");
    await app.page.keyboard.press("ArrowDown");
    await app.page.keyboard.press("Enter");
    await expect(model).toHaveAttribute("aria-busy", "true");
    await expect(model).toHaveText("Alternate fixture");
    await model.click();
    await expect(menu).toHaveCount(0);
    await expect(app.page.locator(".composer .action-error")).toContainText(
      "Native option state unavailable",
    );
    await expect(model).toHaveAttribute("aria-busy", "false");
    await expect(model).toHaveText("Fixture model");
    expect(
      (await app.records()).filter(
        (r) => r.message?.method === "session/set_config_option",
      ),
    ).toHaveLength(1);
    await expect(composer).toHaveValue("Keep this draft and caret.");
    expect(await app.prompts()).toHaveLength(0);
    await app.page.screenshot({
      path: info.outputPath("model-selection-error-rollback.png"),
    });
    await app.page.locator(".composer").click({ button: "right" });
    await app.page
      .getByRole("dialog", { name: "Actions" })
      .getByRole("button", { name: "Session info...", exact: true })
      .click();
    const details = app.page.getByRole("dialog", { name: "Session status" });
    await expect(details).toContainText("Working directory");
    await expect(details).toContainText(app.folders[0]);
    await app.page.screenshot({
      path: info.outputPath("session-details-working-directory.png"),
    });
    expect((await app.inspect(chat.id)).status).toBe("ready");
  } finally {
    await app.cleanup();
  }
});

test("Shared dialog controls retain consistent geometry and fit enlarged text", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    await app.create("Control geometry");
    await app.page.keyboard.press(`${modifier}+,`);
    const settings = app.page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    const buttons = settings.locator(".ui-dialog-actions button");
    const heights = await buttons.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    );
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBe(28);
    const input = settings.getByRole("spinbutton", {
      name: "Interface text size",
      exact: true,
    });
    await input.fill("20");
    await input.press("Tab");
    const overflow = await settings.evaluate((dialog) =>
      [...dialog.querySelectorAll("button,input,select")].some((node) => {
        if (!node.getClientRects().length) return false;
        const rect = node.getBoundingClientRect(),
          bounds = dialog.getBoundingClientRect();
        return rect.right > bounds.right || rect.left < bounds.left;
      }),
    );
    expect(overflow).toBe(false);
    const positions = await settings
      .locator(".setting-row .setting-control")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().left),
      );
    expect(new Set(positions).size).toBe(1);
    await app.page.screenshot({ path: info.outputPath("shared-settings.png") });
    await settings
      .getByRole("button", { name: "Reset defaults", exact: true })
      .click();
    await expect(
      settings.getByRole("button", { name: "Reset defaults", exact: true }),
    ).toBeEnabled();
    await settings
      .getByRole("searchbox", { name: "Search settings", exact: true })
      .fill("browser");
    const browser = settings;
    await expect(
      browser.getByRole("combobox", { name: "Search engine", exact: true }),
    ).toBeVisible();
    await expect(
      browser.getByRole("button", { name: "Done", exact: true }),
    ).toHaveCSS("min-height", "28px");
    await app.page.screenshot({
      path: info.outputPath("shared-browser-settings.png"),
    });
  } finally {
    await app.cleanup();
  }
});

test("Commands ranks tokens and recent activations without losing the cancelled draft", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    await app.cli(
      "settings",
      "update",
      "--values",
      JSON.stringify({ "ui.fontFamily": "monospace", "ui.fontSize": 16 }),
    );
    const composer = app.page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.fill("Keep this invented draft and caret");
    await composer.evaluate((input: HTMLTextAreaElement) =>
      input.setSelectionRange(2, 9),
    );
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    let dialog = app.page.getByRole("dialog", {
      name: "Command palette",
      exact: true,
    });
    let query = dialog.getByRole("textbox", { name: "Filter commands" });
    await query.fill("files tog");
    await expect(
      dialog.getByRole("button", { name: "Toggle files", exact: true }),
    ).toHaveAttribute("aria-current", "true");
    await query.press("Escape");
    await expect(composer).toBeFocused();
    expect(
      await composer.evaluate((input: HTMLTextAreaElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    ).toEqual([2, 9]);
    expect(
      await app.page.evaluate(() =>
        localStorage.getItem("cod.ui.recent-commands"),
      ),
    ).toBeNull();
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    await app.page.mouse.click(8, 600);
    await expect(
      app.page.getByRole("dialog", { name: "Command palette", exact: true }),
    ).toHaveCount(0);
    await expect(composer).toBeFocused();
    expect(
      await composer.evaluate((input: HTMLTextAreaElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    ).toEqual([2, 9]);
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    dialog = app.page.getByRole("dialog", {
      name: "Command palette",
      exact: true,
    });
    query = dialog.getByRole("textbox", { name: "Filter commands" });
    await query.fill("files tog");
    await query.press("Enter");
    await expect(dialog).toHaveCount(0);
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    dialog = app.page.getByRole("dialog", {
      name: "Command palette",
      exact: true,
    });
    await expect(
      dialog.locator("button.command-row").first(),
    ).toHaveAccessibleName("Toggle files");
    await expect(dialog.locator(".command-history:not([hidden])")).toHaveCount(
      1,
    );
    await app.page.screenshot({
      path: info.outputPath("commands-recent-normal.png"),
    });
    await dialog.getByRole("textbox").fill("zzzz invented no match");
    await expect(dialog.locator(".picker-empty")).toBeVisible();
    await dialog.getByRole("textbox").press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox").press("Escape");
    await app.stop();
    await app.start();
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    dialog = app.page.getByRole("dialog", {
      name: "Command palette",
      exact: true,
    });
    await expect(
      dialog.locator("button.command-row").first(),
    ).toHaveAccessibleName("Toggle files");
    await dialog.getByRole("textbox").press("Escape");
    await app.page.evaluate(() =>
      localStorage.setItem(
        "cod.ui.recent-commands",
        JSON.stringify([
          "removed-command",
          null,
          "navigation.toggleFiles",
          "navigation.toggleFiles",
        ]),
      ),
    );
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    dialog = app.page.getByRole("dialog", {
      name: "Command palette",
      exact: true,
    });
    await expect(dialog.locator(".command-history:not([hidden])")).toHaveCount(
      1,
    );
    await dialog.getByRole("textbox").fill("keyb short");
    await expect(
      dialog.getByRole("button", { name: "Keyboard shortcuts", exact: true }),
    ).toBeVisible();
  } finally {
    await app.cleanup();
  }
});

test("File shortcuts distinguish editor focus from file tree actions", async () => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const workspace = await app.create("Invented shortcut scope");
    await app.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      app.folders[0],
    );
    const search = app.page.getByRole("dialog", {
      name: "Open file",
      exact: true,
    });
    await app.command("Open file");
    await expect(search.locator(".picker-footer kbd")).toHaveText([
      "↑ ↓",
      "Enter",
      "Esc",
    ]);
    const pickerInput = search.getByRole("textbox", {
      name: "Open file",
      exact: true,
    });
    await pickerInput.fill("spec.md");
    await expect(
      search.getByRole("button", { name: "spec.md", exact: true }),
    ).toHaveAttribute("aria-current", "true");
    await pickerInput.press("Enter");
    const editor = app.page.getByRole("textbox", {
      name: "File contents",
      exact: true,
    });
    await expect(editor).toBeFocused();
    const key = process.platform === "darwin" ? "⌘S" : "Ctrl+S";
    const commands = app.page.getByRole("dialog", {
      name: "Command palette",
      exact: true,
    });
    const filter = commands.getByRole("textbox", {
      name: "Filter commands",
      exact: true,
    });
    const save = commands.getByRole("button", {
      name: "Save file",
      exact: true,
    });
    await editor.press(`${modifier}+Shift+P`);
    await filter.fill("Save file");
    await expect(save.locator("kbd")).toHaveText(key);
    await filter.press("Escape");
    await expect(editor).toBeFocused();
    const files = app.page.locator("#project-panel");
    if (!(await files.isVisible()))
      await app.page
        .getByRole("button", { name: "Toggle files", exact: true })
        .click();
    const root = files.getByRole("treeitem", {
      name: "alpha repo",
      exact: true,
    });
    await root.focus();
    await root.press("ArrowRight");
    const file = files.getByRole("treeitem", { name: "spec.md", exact: true });
    await file.focus();
    await file.press("Shift+F10");
    const menu = app.page.getByRole("dialog", { name: "Actions", exact: true });
    await expect(
      menu.getByRole("button", { name: "Open", exact: true }).locator("kbd"),
    ).toHaveText("Enter");
    await app.page.keyboard.press("Escape");
    await expect(file).toBeFocused();
    await file.press(`${modifier}+Shift+P`);
    await filter.fill("Save file");
    await expect(save.locator("kbd")).toHaveText("");
    await filter.press("Escape");
    await expect(file).toBeFocused();
    await file.press("Enter");
    await expect(editor).toBeFocused();
  } finally {
    await app.cleanup();
  }
});

test("Shared picker roles, shortcut columns and menu geometry survive narrow enlarged text", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    await app.cli(
      "settings",
      "update",
      "--values",
      JSON.stringify({ "ui.fontFamily": "monospace", "ui.fontSize": 16 }),
    );
    const composer = app.page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.fill("Invented unchanged menu draft");
    await composer.focus();
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    const dialog = app.page.getByRole("dialog", {
      name: "Command palette",
      exact: true,
    });
    const query = dialog.getByRole("textbox", { name: "Filter commands" });
    const colors = await dialog.evaluate((node) => ({
      color: getComputedStyle(node).color,
      backdrop: getComputedStyle(node, "::backdrop").backgroundColor,
      placeholder: getComputedStyle(
        node.querySelector("input")!,
        "::placeholder",
      ).color,
    }));
    expect(colors.color).toBe("rgb(220, 224, 229)");
    expect(colors.placeholder).toBe("rgb(135, 138, 152)");
    expect(colors.backdrop).toBe("rgba(0, 0, 0, 0)");
    await query.fill("Save file");
    const save = dialog.getByRole("button", { name: "Save file", exact: true });
    await expect(save).toBeDisabled();
    await expect(save.locator("kbd")).toHaveText("");
    await expect(dialog.locator(".picker-footer kbd")).toHaveText([
      "↑ ↓",
      "Enter",
      "Esc",
    ]);
    await app.app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(800, 700),
    );
    await app.cli(
      "settings",
      "update",
      "--values",
      JSON.stringify({ "ui.fontSize": 20 }),
    );
    const layout = await save.evaluate((node) => {
      const label = node
        .querySelector(".command-name")!
        .getBoundingClientRect();
      const hint = node.querySelector("kbd")!.getBoundingClientRect();
      const reason = node
        .querySelector(".command-disabled-reason")!
        .getBoundingClientRect();
      return {
        labelBottom: label.bottom,
        labelTop: label.top,
        hintTop: hint.top,
        reasonTop: reason.top,
        overflow: node.scrollWidth > node.clientWidth,
      };
    });
    expect(layout.reasonTop).toBeGreaterThanOrEqual(layout.labelBottom - 1);
    expect(Math.abs(layout.hintTop - layout.labelTop)).toBeLessThan(4);
    expect(layout.overflow).toBe(false);
    await app.page.screenshot({
      path: info.outputPath("commands-disabled-narrow.png"),
    });
    await query.fill("");
    await app.page.screenshot({
      path: info.outputPath("commands-enlarged.png"),
    });
    await query.press("Escape");
    await expect(composer).toBeFocused();
    await app.page.getByRole("tab").first().click({ button: "right" });
    const menu = app.page.locator("dialog.context-menu");
    await expect(menu).toBeVisible();
    const close = menu.getByRole("button", { name: "Close tab", exact: true });
    await expect(close.locator("kbd")).toHaveText(
      process.platform === "darwin" ? /⌘.*W/ : /Ctrl.*W/,
    );
    expect((await menu.boundingBox())!.width).toBeGreaterThanOrEqual(220);
    await menu.screenshot({ path: info.outputPath("tab-menu-shortcuts.png") });
    const keymap = path.join(app.data, "keymap.json");
    await close.focus();
    await writeFile(
      keymap,
      JSON.stringify({
        "tab.close": ["Alt+X"],
        "tab.togglePin": ["Alt+Y"],
        "tab.closeOthers": ["Alt+Z"],
      }),
    );
    const alt = process.platform === "darwin" ? "⌥" : "Alt+";
    await expect(close.locator("kbd")).toHaveText(alt + "X");
    const pin = menu.getByRole("button", { name: "Pin tab", exact: true });
    await expect(pin.locator("kbd")).toHaveText(alt + "Y");
    const columns = await menu
      .locator("button:not(:disabled) kbd")
      .evaluateAll((keys) =>
        keys
          .filter((key) => key.textContent)
          .map((key) => key.getBoundingClientRect().right),
      );
    expect(columns).toHaveLength(2);
    expect(Math.max(...columns) - Math.min(...columns)).toBeLessThan(1);
    const others = menu.getByRole("button", {
      name: "Close other tabs",
      exact: true,
    });
    await expect(others).toBeDisabled();
    await expect(others.locator("kbd")).toHaveText("");
    await expect(close).toBeFocused();
    await writeFile(keymap, JSON.stringify({ "tab.close": null }));
    await expect(close.locator("kbd")).toHaveText("");
    await expect(close).toBeFocused();
    await writeFile(keymap, "{}");
    await expect(close.locator("kbd")).toHaveText(
      process.platform === "darwin" ? "⌘W" : "Ctrl+W",
    );
    await pin.click();
    const tab = app.page.getByRole("tab").first();
    await expect(tab).toHaveAttribute("data-pinned", "true");
    await tab.click({ button: "right" });
    await expect(
      menu
        .getByRole("button", { name: "Close tab", exact: true })
        .locator("kbd"),
    ).toHaveCount(0);
    await app.page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    const plus = app.page
      .getByRole("button", { name: "Choose new tab type", exact: true })
      .first();
    await plus.click();
    await expect(plus).toHaveAttribute("aria-expanded", "true");
    expect(
      await plus.evaluate((node) => getComputedStyle(node).backgroundColor),
    ).toBe("rgb(69, 74, 86)");
    const chooser = app.page.locator("dialog.context-menu");
    expect((await chooser.boundingBox())!.width).toBeGreaterThanOrEqual(220);
    await chooser.screenshot({ path: info.outputPath("new-tab-menu.png") });
    await app.page.keyboard.press("Escape");
    await expect(plus).not.toHaveAttribute("aria-expanded", "true");
    await expect(plus).toBeFocused();
    // Replacing the same trigger before the native close event must not leave
    // an old popup's expanded state attached to the replacement.
    await plus.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(app.page.locator("dialog.context-menu")).toHaveCount(1);
    await expect(plus).toHaveAttribute("aria-expanded", "true");
    await app.page.keyboard.press("Escape");
    await expect(plus).not.toHaveAttribute("aria-expanded", "true");
    await expect(plus).not.toHaveAttribute("aria-controls");
    await expect(composer).toHaveValue("Invented unchanged menu draft");
  } finally {
    await app.cleanup();
  }
});
