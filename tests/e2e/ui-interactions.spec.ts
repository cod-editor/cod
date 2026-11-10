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
      .getByRole("button", { name: "Switch workspace", exact: true })
      .click();
    await capture("02-workspace-picker");
    await app.page.keyboard.press("Escape");
    await app.page
      .getByRole("button", { name: "Provider", exact: true })
      .click();
    await capture("03-provider-menu");
    await app.page.keyboard.press("Escape");
    await app.command("New workspace");
    await capture("04-new-workspace-dialog");
    await app.page
      .getByRole("textbox", { name: "Workspace name", exact: true })
      .fill("Explore report export");
    await app.page.getByRole("button", { name: "Create", exact: true }).click();
    await app.page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("[hold] Explain the report export requirements");
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
    await app.row("Explore report export").click({ button: "right" });
    await capture("10-workspace-context-menu");
    await app.page.keyboard.press("Escape");
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

test("Compact tab actions have visible mouse feedback without disturbing the selected view", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const tabs = app.page.getByRole("tablist").first();
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
      "New tab",
      "Maximize pane",
      "Switch workspace",
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
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    await app.page.screenshot({ path: info.outputPath("new-tab-menu.png") });
    await app.page.keyboard.press("Escape");
    await app.page
      .getByRole("button", { name: "Maximize pane", exact: true })
      .click();
    await app.page.screenshot({
      path: info.outputPath("maximized-selected-tab.png"),
    });
    await app.page
      .getByRole("button", { name: "Restore panes", exact: true })
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

test("Navigation widths resize by pointer and keyboard, persist, and restore after viewport clamping", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeVisible();
    const workspace = (await app.state()).activeWorkspaceId!;
    const separator = () =>
      app.page.getByRole("separator", {
        name: "Resize workspaces",
        exact: true,
      });
    const width = () =>
      app.page
        .locator(".sidebar")
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
          settings: { workspacesWidth: number };
        }
      ).settings.workspacesWidth;
    await expect.poll(preferred).toBe(416);
    await app.page
      .getByRole("button", { name: "Toggle files", exact: true })
      .click();
    const files = () =>
      app.page.getByRole("separator", { name: "Resize files", exact: true });
    await files().press("Home");
    await expect(files()).toHaveAttribute("aria-valuenow", "160");
    await app.stop();
    await app.start();
    await expect.poll(width).toBe(416);
    await expect(files()).toHaveAttribute("aria-valuenow", "160");
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
    ).toBeVisible();
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
      app.page.getByRole("button", { name: "Switch workspace", exact: true }),
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
      .getByRole("button", { name: "New tab", exact: true })
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
      app.page.getByRole("button", { name: "Switch workspace", exact: true }),
    ).toHaveText("Background rename two");
    expect(await addNode!.evaluate((node) => node.isConnected)).toBe(true);
    await app.page.mouse.up();
    await expect(
      app.page.getByRole("dialog", { name: "Actions", exact: true }),
    ).toBeVisible();
    await app.page.keyboard.press("Escape");
    const secondary = await app.cli<{ id: string }>(
      "workspace",
      "create",
      "--name",
      "Second task",
    );
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
    await expect(app.row("Background rename two")).toHaveAttribute(
      "data-status",
      "waiting",
    );
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
    await app.row(original.name).first().click({ button: "right" });
    await app.page
      .getByRole("button", { name: "Close workspace", exact: true })
      .click();
    await expect
      .poll(async () => (await app.state()).workspaces.length)
      .toBe(0);
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
    const tree = app.page.getByRole("tree", {
      name: "Workspaces",
      exact: true,
    });
    await expect(tree.locator('[aria-selected="true"]')).toHaveCount(1);
    await expect(app.row(workspace.name).first()).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await app.page.screenshot({
      path: info.outputPath("selected-chat-not-parent.png"),
    });
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
