import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ChatApp } from "./helpers/chat-fixture/harness";
import { modifier } from "./helpers/workspace-app";
import type { AppState } from "../../src/types";
const execute = promisify(execFile);
let app: ChatApp, server: Server, origin: string, workspace: string;
test.beforeEach(async () => {
  server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    const send = () =>
      response.end(
        '<title>Invented link page</title><h1>Link actions</h1><a id="target" href="/destination?q=one%26two#part">Destination</a><input id="field" value="Retain this form"><select id="choice"><option>First</option><option>Second</option></select><a id="unsafe" href="javascript:void(0)">Unsupported link</a><script>window.identity=crypto.randomUUID()</script>',
      );
    if (_request.url === "/slow") setTimeout(send, 2000);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Fixture server absent");
  origin = `http://127.0.0.1:${address.port}`;
  app = new ChatApp();
  await app.prepare();
  await app.configure({ codex: {} });
  await app.start();
  workspace = await app.create("Link actions");
  await app.app!.evaluate(
    ({ shell, app: electron, Menu, dialog, clipboard }) => {
      clipboard.writeText("Invented clipboard");
      Object.assign(globalThis, {
        externalUrls: [],
        defaultHandler: false,
        externalFailure: false,
        pageActionErrors: [],
        nativeMenu: { labels: [], enabled: [], closed: true },
      });
      shell.openExternal = async (url) => {
        (globalThis as any).externalUrls.push(url);
        if ((globalThis as any).externalFailure)
          throw Error("Invented platform handoff failure");
      };
      electron.isDefaultProtocolClient = () =>
        Boolean((globalThis as any).defaultHandler);
      Object.assign(dialog, {
        showMessageBox: async (
          _window: unknown,
          options: { detail: string },
        ) => {
          (globalThis as any).pageActionErrors.push(options.detail);
          return { response: 0, checkboxChecked: false };
        },
      });
      const popup = Menu.prototype.popup;
      Menu.prototype.popup = function (options) {
        Object.assign(globalThis, {
          nativeMenu: {
            labels: this.items.map((i) => i.label),
            enabled: this.items
              .filter((i) => i.type !== "separator" && i.enabled)
              .map((i) => i.label),
            closed: false,
          },
        });
        this.once("menu-will-close", () => {
          (globalThis as any).nativeMenu.closed = true;
        });
        popup.call(this, options);
      };
    },
  );
});
test.afterEach(async () => {
  await app?.cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const handoffs = () =>
  app.app!.evaluate(() => (globalThis as any).externalUrls as string[]);
const browserRecords = async () => (await app.cli<AppState>("state")).browsers;
async function openBrowser() {
  const record = await app.cli<{ id: string; paneId: string }>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    origin + "/source",
  );
  await expect
    .poll(() =>
      app.app!.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .some((c) => c.getURL() === url && !c.isLoadingMainFrame()),
        origin + "/source",
      ),
    )
    .toBe(true);
  await expect(app.pane(record.paneId)).toBeVisible();
  return record;
}
async function pageValue(source: string, url = origin + "/source") {
  return app.app!.evaluate(
    ({ webContents }, { source, url }) =>
      webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)!
        .executeJavaScript(source),
    { source, url },
  );
}
async function nativeContext(
  selector: string,
  keyboard = false,
  url = origin + "/source",
) {
  await app.app!.evaluate(
    async ({ webContents }, { url, selector, keyboard }) => {
      const contents = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)!;
      const point = await contents.executeJavaScript(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});${keyboard ? "e.focus();" : ""}const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
      );
      const ready = new Promise<void>((resolve) =>
        contents.once("context-menu", (_event, params) => {
          Object.assign(globalThis, { nativeLinkURL: params.linkURL });
          setImmediate(resolve);
        }),
      );
      contents.focus();
      if (keyboard) {
        contents.sendInputEvent({
          type: "keyDown",
          keyCode: "F10",
          modifiers: ["shift"],
        });
        contents.sendInputEvent({
          type: "keyUp",
          keyCode: "F10",
          modifiers: ["shift"],
        });
      } else {
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
      }
      await ready;
    },
    { url, selector, keyboard },
  );
}
async function chooseNative(label: string) {
  const enabled = await app.app!.evaluate(
    () => (globalThis as any).nativeMenu.enabled as string[],
  );
  expect(enabled).toContain(label);
  await execute("xdotool", [
    "key",
    "--delay",
    "80",
    "--clearmodifiers",
    "Home",
    ...Array(enabled.indexOf(label)).fill("Down"),
    "Return",
  ]);
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).nativeMenu.closed))
    .toBe(true);
}
async function command(label: string) {
  await app.page.keyboard.press(`${modifier}+Shift+p`);
  const dialog = app.page.getByRole("dialog", { name: "Command palette" });
  await dialog.getByRole("textbox").fill(label);
  await dialog.getByRole("button", { name: label, exact: true }).click();
}

test("Native right-click opens an independent background tab in the source group and restart retains both", async () => {
  const source = await openBrowser();
  await app.cli(
    "pane",
    "pin",
    "--workspace",
    workspace,
    "--id",
    source.paneId,
    "--pinned",
    "true",
  );
  const identity = await pageValue("window.identity");
  await nativeContext("#target");
  await chooseNative("Open link in new tab");
  await expect.poll(async () => (await browserRecords()).length).toBe(2);
  const target = (await browserRecords()).find((b) => b.id !== source.id)!;
  expect(target.url).toBe(origin + "/destination?q=one%26two#part");
  const state = (await app.cli<AppState>("state")).workspaces.find(
    (w) => w.id === workspace,
  )!;
  const group = state.groups!.find((g) => g.paneIds.includes(source.paneId))!;
  expect(group.paneIds).toContain(target.paneId);
  expect(state.activePaneId).toBe(source.paneId);
  await expect
    .poll(() =>
      app.app!.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .some((c) => c.getURL() === url && c.isFocused()),
        origin + "/source",
      ),
    )
    .toBe(true);
  expect(
    await pageValue("[window.identity,document.querySelector('#field').value]"),
  ).toEqual([identity, "Retain this form"]);
  await expect
    .poll(() =>
      app.app!.evaluate(
        ({ webContents }, url) =>
          webContents.getAllWebContents().some((c) => c.getURL() === url),
        target.url,
      ),
    )
    .toBe(true);
  expect(
    await pageValue(
      "[window.opener,typeof window.cod,typeof require]",
      target.url,
    ),
  ).toEqual([null, "undefined", "undefined"]);
  await nativeContext("#target");
  await chooseNative("Open link in new tab");
  await expect.poll(async () => (await browserRecords()).length).toBe(3);
  await app.stop();
  await app.start();
  expect((await browserRecords()).map((b) => b.url)).toEqual(
    expect.arrayContaining([origin + "/source", target.url]),
  );
  expect(
    (await app.cli<AppState>("state")).workspaces.find(
      (w) => w.id === workspace,
    )!.activePaneId,
  ).toBe(source.paneId);
});

test("Native keyboard context handoff and current-page Commands use the exact validated URL once", async () => {
  const source = await openBrowser();
  await nativeContext("#target", true);
  await chooseNative("Open link in system browser");
  await expect
    .poll(() => handoffs())
    .toEqual([origin + "/destination?q=one%26two#part"]);
  expect(await browserRecords()).toHaveLength(1);
  await app
    .pane(source.paneId)
    .getByRole("textbox", { name: "Address", exact: true })
    .focus();
  await command("Open in system browser");
  await expect
    .poll(() => handoffs())
    .toEqual([origin + "/destination?q=one%26two#part", origin + "/source"]);
  const result = await app.cli(
    "browser",
    "open-external",
    "--url",
    origin + "/cli?q=retained#fragment",
  );
  expect(result).toEqual({ url: origin + "/cli?q=retained#fragment" });
  expect(await browserRecords()).toHaveLength(1);
  for (const url of [
    "javascript:alert(1)",
    "file:///tmp/not-a-web-link",
    "mailto:fixture@example.org",
  ])
    expect(
      (await app.raw("browser", "open-external", "--url", url)).code,
    ).not.toBe(0);
  await app.app!.evaluate(() =>
    Object.assign(globalThis, { defaultHandler: true }),
  );
  expect(
    (await app.raw("browser", "open-external", "--url", origin + "/loop"))
      .stderr,
  ).toContain("default browser");
  expect(await handoffs()).toHaveLength(3);
  expect(await browserRecords()).toHaveLength(1);
  await app.app!.evaluate(() =>
    Object.assign(globalThis, { defaultHandler: false, externalFailure: true }),
  );
  await nativeContext("#target", true);
  await chooseNative("Open link in system browser");
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).pageActionErrors))
    .toEqual(["Invented platform handoff failure"]);
  expect(await browserRecords()).toHaveLength(1);
  expect(await pageValue("document.querySelector('#field').value")).toBe(
    "Retain this form",
  );
});

test("Native editable menus retain clipboard/select/selection focus, reject unsafe links and close with the owner", async () => {
  const source = await openBrowser();
  await pageValue(
    "(()=>{const e=document.querySelector('#field');e.focus();e.setSelectionRange(2,6)})()",
  );
  await nativeContext("#field", true);
  const enabled = await app.app!.evaluate(
    () => (globalThis as any).nativeMenu.enabled as string[],
  );
  expect(enabled).toEqual(
    expect.arrayContaining(["Cut", "Copy", "Paste", "Select all"]),
  );
  await execute("xdotool", ["key", "--clearmodifiers", "Escape"]);
  expect(
    await pageValue(
      "(()=>{const e=document.querySelector('#field');return[e.value,e.selectionStart,e.selectionEnd,document.activeElement===e,document.querySelector('select').value]})()",
    ),
  ).toEqual(["Retain this form", 2, 6, true, "First"]);
  const points = await app.app!.evaluate(
    async ({ BrowserWindow, webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)!;
      Object.assign(globalThis, { pageCursors: [] });
      contents.on("cursor-changed", (_event, type) =>
        (globalThis as any).pageCursors.push(type),
      );
      const window = BrowserWindow.getAllWindows()[0];
      const view = window.contentView.children.find(
        (v) => (v as any).webContents?.id === contents.id,
      )!;
      const bounds = view.getBounds(),
        content = window.getContentBounds();
      const relative = await contents.executeJavaScript(
        "['#target','#field','#choice'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})",
      );
      return relative.map((p: { x: number; y: number }) => ({
        x: content.x + bounds.x + p.x,
        y: content.y + bounds.y + p.y,
      }));
    },
    origin + "/source",
  );
  await execute("xdotool", [
    "mousemove",
    "--sync",
    String(points[0].x),
    String(points[0].y),
  ]);
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).pageCursors))
    .toContain("hand");
  await execute("xdotool", [
    "mousemove",
    "--sync",
    String(points[1].x),
    String(points[1].y),
  ]);
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).pageCursors))
    .toContain("text");
  await execute("xdotool", [
    "mousemove",
    "--sync",
    String(points[2].x),
    String(points[2].y),
    "click",
    "1",
  ]);
  await execute("xdotool", ["key", "--clearmodifiers", "Down", "Return"]);
  await expect
    .poll(() => pageValue("document.querySelector('select').value"))
    .toBe("Second");
  await nativeContext("#unsafe");
  const labels = await app.app!.evaluate(
    () => (globalThis as any).nativeMenu.labels as string[],
  );
  expect(labels).not.toContain("Open link in new tab");
  expect(labels).not.toContain("Open link in system browser");
  await chooseNative("Copy link address");
  expect(await app.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    await app.app!.evaluate(() => (globalThis as any).nativeLinkURL),
  );
  expect(
    (
      await app.raw(
        "browser",
        "open-link",
        "--id",
        source.id,
        "--url",
        "file:///tmp/private",
      )
    ).code,
  ).not.toBe(0);
  await nativeContext("#target");
  await app.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    source.paneId,
  );
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).nativeMenu.closed))
    .toBe(true);
});

test("Chat link menus preserve a cancelled composer draft and explicit handoff never creates a Cod tab", async () => {
  const chat = await app.newChat(workspace, "codex");
  await app.send(
    chat.id,
    `[Fixture link](${origin}/from-chat?q=one%26two#part)`,
  );
  await expect
    .poll(async () => (await app.inspect(chat.id)).status)
    .toBe("ready");
  const link = app
    .pane(chat.paneId)
    .getByRole("link", { name: "Fixture link", exact: true })
    .last();
  await expect(link).toBeVisible();
  const composer = app
    .pane(chat.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Retain this unsent draft");
  await link.focus();
  await link.press("Shift+F10");
  await expect(
    app.page.getByRole("dialog", { name: "Actions", exact: true }),
  ).toBeVisible();
  await app.page.keyboard.press("Escape");
  await expect(link).toBeFocused();
  await expect(composer).toHaveValue("Retain this unsent draft");
  await link.click({ button: "right" });
  await app.page
    .getByRole("dialog", { name: "Actions", exact: true })
    .getByRole("button", { name: "Open in system browser", exact: true })
    .click();
  await expect
    .poll(() => handoffs())
    .toEqual([origin + "/from-chat?q=one%26two#part"]);
  expect(await browserRecords()).toHaveLength(0);
  await link.focus();
  await command("Open link");
  await expect.poll(async () => (await browserRecords()).length).toBe(1);
  expect((await browserRecords())[0].workspaceId).toBe(workspace);
  expect((await browserRecords())[0].url).toBe(
    origin + "/from-chat?q=one%26two#part",
  );
});

test("Markdown preview and source caret share handoff actions without granting a preview bridge to other frames", async ({}, info) => {
  const file = path.join(app.folders[0], "links.md");
  const url = origin + "/from-file?q=one%26two#part";
  await writeFile(file, `# Links\n\n[Preview link](${url})\n`);
  const opened = await app.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    file,
  );
  const editor = app
    .pane(opened.paneId)
    .getByRole("textbox", { name: "File contents", exact: true });
  await expect(editor).toBeEnabled();
  await editor.evaluate((e: HTMLTextAreaElement) => {
    e.focus();
    const p = e.value.indexOf("?q=");
    e.setSelectionRange(p, p);
  });
  await command("Open in system browser");
  await expect.poll(() => handoffs()).toEqual([url]);
  await editor.focus();
  await editor.press("Shift+F10");
  await expect(
    app.page.getByRole("dialog", { name: "Actions", exact: true }),
  ).toBeVisible();
  await app.page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  const preview = await app.cli<{ paneId: string }>(
    "preview",
    "open",
    "--workspace",
    workspace,
    "--path",
    file,
  );
  const frame = app.pane(preview.paneId).locator("iframe").contentFrame();
  const link = frame.getByRole("link", { name: "Preview link", exact: true });
  await expect(link).toBeVisible();
  await link.focus();
  await link.press("Shift+F10");
  await app.page.keyboard.press("Escape");
  await expect(link).toBeFocused();
  await link.click({ button: "right" });
  await app.page.screenshot({
    path: info.outputPath("preview-link-actions.png"),
  });
  await app.page
    .getByRole("dialog", { name: "Actions", exact: true })
    .getByRole("button", { name: "Open in system browser", exact: true })
    .click();
  await expect.poll(() => handoffs()).toEqual([url, url]);
  expect(await browserRecords()).toHaveLength(0);
  await app.page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.addEventListener("message", () => resolve(), { once: true });
        window.postMessage(
          {
            type: "cod-preview-link-menu",
            href: "https://example.org/spoof",
            x: 0,
            y: 0,
          },
          "*",
        );
      }),
  );
  await expect(
    app.page.getByRole("dialog", { name: "Actions", exact: true }),
  ).toHaveCount(0);
  expect(await handoffs()).toEqual([url, url]);
});

test("Registered form link actions retain the response owner and never copy its bridge to an ordinary tab", async () => {
  const conversation = await app.newChat(workspace, "codex");
  const file = path.join(app.folders[0], "link-form.html");
  await writeFile(
    file,
    `<title>Invented form</title><input id="answer" value="Unsaved answer"><a id="target" href="${origin}/destination">Destination</a>`,
  );
  const form = await app.cli<{ id: string; paneId: string; url: string }>(
    "page",
    "open",
    "--workspace",
    workspace,
    "--conversation",
    conversation.id,
    "--path",
    file,
  );
  const record = await app.cli<{ url: string }>(
    "browser",
    "inspect",
    "--id",
    form.id,
  );
  Object.assign(form, { url: record.url });
  await expect
    .poll(async () => pageValue("typeof codPage.submit", form.url))
    .toBe("function");
  await nativeContext("#target", true, form.url);
  const labels = await app.app!.evaluate(
    () => (globalThis as any).nativeMenu.labels,
  );
  expect(labels).not.toContain("Inspect element");
  await chooseNative("Open link in new tab");
  await expect.poll(async () => (await browserRecords()).length).toBe(2);
  const target = (await browserRecords()).find((b) => b.id !== form.id)!;
  expect(target.agentPage).toBeUndefined();
  expect(
    await pageValue("[typeof codPage,typeof cod,typeof require]", target.url),
  ).toEqual(["undefined", "undefined", "undefined"]);
  expect(
    await pageValue(
      "[document.querySelector('#answer').value,typeof codPage.submit]",
      form.url,
    ),
  ).toEqual(["Unsaved answer", "function"]);
  expect((await app.inspect(conversation.id)).messages).toEqual([]);
  await nativeContext("#target", true, form.url);
  await chooseNative("Open link in system browser");
  expect(
    await app.app!.evaluate(() => (globalThis as any).externalUrls),
  ).toEqual([origin + "/destination"]);
  expect((await browserRecords()).length).toBe(2);
});

test("A background link finishing a slow load does not take focus from newer address editing", async () => {
  await openBrowser();
  await pageValue(
    `document.querySelector('#target').href=${JSON.stringify(origin + "/slow")}`,
  );
  await nativeContext("#target");
  await chooseNative("Open link in new tab");
  await expect.poll(async () => (await browserRecords()).length).toBe(2);
  await app.app!.evaluate(({ webContents }, url) => {
    const contents = webContents
      .getAllWebContents()
      .find((c) => c.getURL() === url)!;
    contents.sendInputEvent({
      type: "keyDown",
      keyCode: "L",
      modifiers: [process.platform === "darwin" ? "meta" : "control"],
    });
    contents.sendInputEvent({
      type: "keyUp",
      keyCode: "L",
      modifiers: [process.platform === "darwin" ? "meta" : "control"],
    });
  }, origin + "/source");
  const address = app.page.getByRole("textbox", { name: "Address" });
  await expect(address).toBeFocused();
  await address.fill("unfinished.example");
  await expect
    .poll(
      async () =>
        (await browserRecords()).find((b) => b.url === origin + "/slow")
          ?.loading,
    )
    .toBe(false);
  await expect(address).toBeFocused();
  await expect(address).toHaveValue("unfinished.example");
});
