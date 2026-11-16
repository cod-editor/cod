import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { ChatApp } from "./helpers/chat-fixture/harness";
import { modifier } from "./helpers/workspace-app";
const execute = promisify(execFile);
let app: ChatApp;
let workspace: string;
test.beforeEach(async () => {
  app = new ChatApp();
  await app.prepare();
  await app.configure({ codex: {} });
  await app.start();
  workspace = await app.create("Manual inspectors");
});
test.afterEach(async () => app.cleanup());
const owner = async (url = app.page.url()) =>
  app.app!.evaluate(({ webContents }, url) => {
    const page = webContents
      .getAllWebContents()
      .find((c) => c.getURL() === url);
    if (!page) return { open: false };
    return {
      open: page.isDevToolsOpened(),
      id: page.id,
      tools: page.devToolsWebContents?.id,
    };
  }, url);
async function nativeKey(
  url: string,
  key: string,
  modifiers: Array<"control" | "meta" | "alt" | "shift"> = [],
) {
  await app.app!.evaluate(
    ({ webContents }, { url, key, modifiers }) => {
      const contents = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)!;
      contents.focus();
      contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
      contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
    },
    { url, key, modifiers },
  );
}
async function closeInspector(url = app.page.url(), shortcut = "F12") {
  const state = await owner(url);
  if (!state.open) return;
  await expect
    .poll(() =>
      app.app!.evaluate(async ({ webContents }, id) => {
        const tools = webContents.fromId(id!);
        return tools && !tools.isLoadingMainFrame()
          ? await tools.executeJavaScript("document.readyState")
          : "loading";
      }, state.tools),
    )
    .toBe("complete");
  // Detached DevTools is a native Chromium window, not an Electron BrowserWindow.
  const windows = await execute("xdotool", [
    "search",
    "--onlyvisible",
    "--name",
    "DevTools",
  ]);
  const inspectorWindow = windows.stdout.trim().split(/\s+/).at(-1)!;
  await execute("xdotool", ["windowfocus", "--sync", inspectorWindow]);
  await expect
    .poll(() =>
      app.app!.evaluate(
        ({ webContents }) => webContents.getFocusedWebContents()?.id,
      ),
    )
    .toBe(state.tools);
  const capture = await app.app!.evaluate(
    async ({ webContents }, id) =>
      (await webContents.fromId(id!)!.capturePage()).toPNG().toString("base64"),
    state.tools,
  );
  await writeFile(
    test.info().outputPath(`inspector-${state.id}.png`),
    Buffer.from(capture, "base64"),
  );
  await execute("xdotool", ["key", "--clearmodifiers", shortcut]);
  await expect.poll(() => owner(url).then((s) => s.open)).toBe(false);
}
async function page(name: string) {
  const file = path.join(app.folders[0], `${name}.html`);
  await writeFile(
    file,
    `<title>${name}</title><h1 id="target">Invented inspection target</h1><input id="field" value="Retained input"><script>window.identity=crypto.randomUUID()</script>`,
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
  return { ...browser, url };
}
async function command() {
  await app.page
    .getByRole("textbox", { name: "Filter commands" })
    .fill("Toggle Developer Tools");
  await app.page
    .getByRole("button", { name: "Toggle Developer Tools", exact: true })
    .click();
}

test("F12 and the platform alias toggle Cod's inspector, including from its own window, without changing draft or restart state", async () => {
  await app.newChat(workspace, "codex");
  const input = app.page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Preserve my inspector draft");
  await input.press("Home");
  await input.press("ArrowRight");
  await input.press("F12");
  await expect.poll(() => owner().then((s) => s.open)).toBe(true);
  await closeInspector();
  await expect(input).toHaveValue("Preserve my inspector draft");
  await input.focus();
  await app.page.keyboard.press(
    process.platform === "darwin" ? `${modifier}+Alt+i` : `${modifier}+Shift+i`,
  );
  await expect.poll(() => owner().then((s) => s.open)).toBe(true);
  await closeInspector();
  await input.focus();
  await app.page.keyboard.press(`${modifier}+Shift+p`);
  await command();
  await expect.poll(() => owner().then((s) => s.open)).toBe(true);
  await closeInspector();
  await app.stop();
  await app.start();
  expect((await owner()).open).toBe(false);
  await expect(
    app.page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Preserve my inspector draft");
});

test("Native page keys and Commands inspect the invocation's exact page rather than Cod or another tab", async () => {
  const first = await page("First page"),
    second = await page("Second page");
  await app.cli(
    "pane",
    "focus",
    "--workspace",
    workspace,
    "--id",
    first.paneId,
  );
  const identity = await app.app!.evaluate(
    async ({ webContents }, url) =>
      webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)!
        .executeJavaScript("window.identity"),
    first.url,
  );
  await nativeKey(first.url, "F12");
  await expect.poll(() => owner(first.url).then((s) => s.open)).toBe(true);
  expect((await owner()).open).toBe(false);
  expect((await owner(second.url)).open).toBe(false);
  expect(
    await app.app!.evaluate(
      async ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .find((c) => c.getURL() === url)!
          .executeJavaScript(
            "[typeof window.cod,typeof require,window.identity]",
          ),
      first.url,
    ),
  ).toEqual(["undefined", "undefined", identity]);
  await closeInspector(first.url);
  await nativeKey(first.url, "P", [
    process.platform === "darwin" ? "meta" : "control",
    "shift",
  ]);
  await expect(
    app.page.getByRole("dialog", { name: "Command palette" }),
  ).toBeVisible();
  await command();
  await expect.poll(() => owner(first.url).then((s) => s.open)).toBe(true);
  expect((await owner()).open).toBe(false);
  expect((await owner(second.url)).open).toBe(false);
  await closeInspector(first.url);
  await app
    .pane(first.paneId)
    .getByRole("textbox", { name: "Address", exact: true })
    .focus();
  await app.page.keyboard.press("F12");
  await expect.poll(() => owner().then((s) => s.open)).toBe(true);
  expect((await owner(first.url)).open).toBe(false);
  await closeInspector();
  await nativeKey(first.url, "F12");
  await app.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    first.paneId,
  );
  await expect.poll(() => owner(first.url).then((s) => s.open)).toBe(false);
  await app.cli("pane", "reopen", "--workspace", workspace);
  await expect(app.pane(first.paneId)).toBeVisible();
  expect((await owner(first.url)).open).toBe(false);
});

test("Inspect element uses the actual native context-menu point and restricted forms omit that menu entry", async () => {
  const ordinary = await page("Point inspection");
  const point = await app.app!.evaluate(async ({ webContents }, url) => {
    const contents = webContents
      .getAllWebContents()
      .find((c) => c.getURL() === url)!;
    const inspect = contents.inspectElement.bind(contents);
    Object.assign(contents, {
      inspectElement: (x: number, y: number) => {
        Object.assign(globalThis, {
          lastInspectPoint: { x, y, id: contents.id },
        });
        inspect(x, y);
      },
    });
    const point = await contents.executeJavaScript(
      '(()=>{const r=document.querySelector("h1").getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)}})()',
    );
    const shown = new Promise<void>((resolve) =>
      contents.once("context-menu", () => setImmediate(resolve)),
    );
    contents.focus();
    contents.sendInputEvent({
      type: "mouseDown",
      button: "right",
      clickCount: 1,
      ...point,
    });
    contents.sendInputEvent({
      type: "mouseUp",
      button: "right",
      clickCount: 1,
      ...point,
    });
    await shown;
    return point;
  }, ordinary.url);
  await execute("xdotool", ["key", "--clearmodifiers", "End", "Return"]);
  await expect.poll(() => owner(ordinary.url).then((s) => s.open)).toBe(true);
  expect(
    await app.app!.evaluate(
      () =>
        (globalThis as unknown as { lastInspectPoint: unknown })
          .lastInspectPoint,
    ),
  ).toEqual({ ...point, id: (await owner(ordinary.url)).id });
  await closeInspector(ordinary.url);
  const chat = await app.newChat(workspace, "codex");
  const file = path.join(app.folders[0], "response.html");
  await writeFile(
    file,
    "<title>Restricted response</title><h1>Response form</h1>",
  );
  const form = await app.cli<{ id: string; paneId: string }>(
    "page",
    "open",
    "--workspace",
    workspace,
    "--conversation",
    chat.id,
    "--path",
    file,
  );
  await expect(app.pane(form.paneId)).toBeVisible();
  const labels = await app.app!.evaluate(async ({ Menu, webContents }, url) => {
    const prototype = Menu.prototype;
    const original = prototype.popup;
    let labels: string[] = [];
    prototype.popup = function () {
      labels = this.items.map((item) => item.label);
    };
    try {
      const contents = webContents
        .getAllWebContents()
        .find((c) => c.getURL().includes(url))!;
      contents.emit(
        "context-menu",
        {},
        {
          x: 20,
          y: 20,
          isEditable: false,
          editFlags: {},
          selectionText: "",
          linkURL: "",
        },
      );
    } finally {
      prototype.popup = original;
    }
    return labels;
  }, "response.html");
  expect(labels).not.toContain("Inspect element");
});

test("Keymap remapping, live reset and restart preserve exact inspector authority", async () => {
  const config = path.join(app.data, "keymap.json");
  await writeFile(config, JSON.stringify({ "devtools.toggle": ["Alt+F12"] }));
  await app.page.keyboard.press(`${modifier}+Shift+p`);
  await app.page
    .getByRole("textbox", { name: "Filter commands" })
    .fill("Keyboard shortcuts");
  await app.page
    .getByRole("button", { name: "Keyboard shortcuts", exact: true })
    .click();
  await app.page
    .getByRole("textbox", { name: "Search shortcuts" })
    .fill("Toggle Developer Tools");
  await expect(
    app.page
      .locator(".shortcut-row")
      .filter({ hasText: "Toggle Developer Tools" })
      .locator("kbd"),
  ).toContainText("Alt");
  await app.page.keyboard.press("Escape");
  await app.page.keyboard.press("F12");
  expect((await owner()).open).toBe(false);
  await app.page.keyboard.press("Alt+F12");
  await expect.poll(() => owner().then((s) => s.open)).toBe(true);
  await app.app!.evaluate(
    ({ webContents }, url) =>
      webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)!
        .closeDevTools(),
    app.page.url(),
  );
  const remappedPage = await page("Remapped inspector");
  await nativeKey(remappedPage.url, "F12");
  expect((await owner(remappedPage.url)).open).toBe(false);
  await nativeKey(remappedPage.url, "F12", ["alt"]);
  await expect
    .poll(() => owner(remappedPage.url).then((s) => s.open))
    .toBe(true);
  await closeInspector(remappedPage.url, "alt+F12");
  await app.stop();
  await app.start();
  await nativeKey(app.page.url(), "F12", ["alt"]);
  await expect.poll(() => owner().then((s) => s.open)).toBe(true);
  await app.app!.evaluate(
    ({ webContents }, url) =>
      webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)!
        .closeDevTools(),
    app.page.url(),
  );
  await writeFile(config, JSON.stringify({ "devtools.toggle": ["F12"] }));
  await app.page.keyboard.press(`${modifier}+Shift+p`);
  await app.page
    .getByRole("textbox", { name: "Filter commands" })
    .fill("Keyboard shortcuts");
  await app.page
    .getByRole("button", { name: "Keyboard shortcuts", exact: true })
    .click();
  await app.page
    .getByRole("textbox", { name: "Search shortcuts" })
    .fill("Toggle Developer Tools");
  await expect(
    app.page
      .locator(".shortcut-row")
      .filter({ hasText: "Toggle Developer Tools" })
      .locator("kbd"),
  ).toHaveText("F12");
  await app.page.keyboard.press("Escape");
  await app.page.keyboard.press("F12");
  await expect.poll(() => owner().then((s) => s.open)).toBe(true);
});
