import { test, expect, type Locator, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ChatApp } from "./helpers/chat-fixture/harness";
import { modifier } from "./helpers/workspace-app";
import type { AppState } from "../../src/types";

// These journeys exercise an explicit temporary profile, never the user's keymap.
async function prepareKeyboardProfile(app: ChatApp) {
  await app.prepare();
  await mkdir(app.data, { recursive: true });
  await writeFile(
    path.join(app.data, "keymap.json"),
    JSON.stringify({
      "pane.next": ["Alt+Tab"],
      "pane.previous": ["Alt+Shift+Tab"],
      "pane.zoom": ["Alt+Enter"],
      "pane.splitRight": ["Alt+N"],
    }),
  );
}

// User actions in this suite use keyboard input. CLI is fixture setup or observation.
async function reach(page: Page, target: Locator, limit = 24, reverse = false) {
  const visited: string[] = [];
  for (let index = 0; index < limit; index++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    visited.push(
      await page.evaluate(() => {
        const e = document.activeElement;
        return `${e?.tagName}:${e?.getAttribute("aria-label") ?? e?.textContent?.slice(0, 80)}`;
      }),
    );
    await page.keyboard.press(reverse ? "Shift+Tab" : "Tab");
  }
  console.log("Keyboard focus trail", visited);
  await page.screenshot({
    path: test.info().outputPath("unreachable-control.png"),
  });
  await expect(target, `Reachable within ${limit} Tab stops`).toBeFocused();
}
async function command(page: Page, label: string) {
  await page.keyboard.press(`${modifier}+Shift+P`);
  const filter = page.getByRole("textbox", { name: "Filter commands" });
  await expect(filter).toBeFocused();
  await page.keyboard.type(label);
  const action = page
    .getByRole("dialog", { name: "Command palette" })
    .getByRole("button", { name: label, exact: true });
  await expect(action).toBeVisible();
  for (let index = 0; index < 20; index++) {
    if ((await action.getAttribute("aria-current")) === "true") break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(action).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Enter");
}
async function observeInvocations(page: Page) {
  const session = await page.context().newCDPSession(page);
  const operations: string[] = [];
  const scripts: Array<{ scriptId: string; url: string }> = [];
  session.on("Debugger.scriptParsed", (event) => scripts.push(event));
  await session.send("Debugger.enable");
  const renderer = scripts.find((script) =>
    script.url.endsWith("/renderer.js"),
  );
  if (!renderer) throw new Error("Trusted renderer script missing");
  const { scriptSource } = await session.send("Debugger.getScriptSource", {
    scriptId: renderer.scriptId,
  });
  const lineNumber = scriptSource
    .split("\n")
    .findIndex((line) => line.includes("return await window.cod.invoke("));
  if (lineNumber < 0) throw new Error("Trusted invocation boundary missing");
  const operationName = /\{\s*op:\s*([\w$]+)/.exec(
    scriptSource.split("\n")[lineNumber],
  )?.[1];
  if (!operationName)
    throw new Error("Trusted invocation operation binding missing");
  const { breakpointId } = await session.send("Debugger.setBreakpoint", {
    location: { scriptId: renderer.scriptId, lineNumber },
  });
  session.on("Debugger.paused", async (event) => {
    try {
      if (event.hitBreakpoints?.includes(breakpointId)) {
        const value = await session.send("Debugger.evaluateOnCallFrame", {
          callFrameId: event.callFrames[0].callFrameId,
          expression: operationName,
          returnByValue: true,
        });
        if (typeof value.result.value === "string")
          operations.push(value.result.value);
      }
    } finally {
      await session.send("Debugger.resume");
    }
  });
  return { operations, close: () => session.detach() };
}
// Keep bounded metadata for failures that a test-event-only trace cannot explain.
async function observeLayoutFocus(page: Page) {
  await page.evaluate(() => {
    const events: unknown[] = [];
    const identities = new WeakMap<Element, number>();
    let sequence = 0;
    const identity = (node: Element) => {
      if (!identities.has(node)) identities.set(node, ++sequence);
      return identities.get(node);
    };
    const describe = (node: Element | null) =>
      node
        ? {
            identity: identity(node),
            tag: node.tagName,
            role: node.getAttribute("role"),
            label: node.getAttribute("aria-label")?.slice(0, 100),
            pane: node.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId,
            separator: [
              ...document.querySelectorAll('[role="separator"]'),
            ].indexOf(node),
            connected: node.isConnected,
          }
        : null;
    const record = (event: string, node: Element | null, extra = {}) => {
      events.push({
        time: performance.now(),
        event,
        target: describe(node),
        active: describe(document.activeElement),
        documentFocused: document.hasFocus(),
        ...extra,
      });
      if (events.length > 96) events.shift();
    };
    const controller = new AbortController();
    const original = HTMLElement.prototype.focus;
    const traced: typeof original = function (this: HTMLElement, ...args) {
      record("focus-call", this, { stack: new Error().stack?.slice(0, 1800) });
      return original.apply(this, args);
    };
    HTMLElement.prototype.focus = traced;
    for (const name of ["focusin", "focusout", "keydown"])
      document.addEventListener(
        name,
        (event) =>
          record(name, event.target as Element, {
            key: (event as KeyboardEvent).key,
          }),
        { capture: true, signal: controller.signal },
      );
    for (const name of ["focus", "blur"])
      window.addEventListener(
        name,
        () => record("window-" + name, document.activeElement),
        { signal: controller.signal },
      );
    Object.assign(window, {
      layoutFocusDiagnostics: {
        snapshot: () => ({
          events,
          active: describe(document.activeElement),
          documentFocused: document.hasFocus(),
          separators: [...document.querySelectorAll('[role="separator"]')].map(
            describe,
          ),
        }),
        dispose: () => {
          controller.abort();
          if (HTMLElement.prototype.focus === traced)
            HTMLElement.prototype.focus = original;
        },
      },
    });
  });
  return async (failed: boolean) =>
    page.evaluate((failed) => {
      const probe = (window as any).layoutFocusDiagnostics;
      if (!probe) return undefined;
      const snapshot = failed ? probe.snapshot() : undefined;
      probe.dispose();
      delete (window as any).layoutFocusDiagnostics;
      return snapshot;
    }, failed);
}

async function state(app: ChatApp) {
  return app.cli<AppState>("state");
}

test("Keyboard chat journey starts without a mouse, handles permission and preserves a cancelled dialog draft", async ({}, info) => {
  const app = new ChatApp();
  await prepareKeyboardProfile(app);
  try {
    await app.start();
    const composer = () =>
      app.page.getByRole("textbox", { name: "Message", exact: true });
    await expect(composer()).toBeFocused();
    await app.page.keyboard.press(`${modifier}+N`);
    await expect(composer()).toBeFocused();
    expect((await state(app)).conversations).toHaveLength(0);
    await app.app!.evaluate(
      async ({ clipboard, nativeImage, ClipboardItem }) => {
        const image = nativeImage.createFromBitmap(
          Buffer.alloc(8 * 8 * 4, 180),
          { width: 8, height: 8 },
        );
        await clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([new Uint8Array(image.toPNG())], {
              type: "image/png",
            }),
          }),
        ]);
      },
    );
    await app.page.keyboard.press(`${modifier}+V`);
    const preview = app.page
      .locator(".composer-images button")
      .filter({ has: app.page.locator("img") });
    await expect(preview).toHaveCount(1);
    await reach(app.page, preview);
    await app.page.keyboard.press("Enter");
    await expect(app.page.locator("dialog.image-viewer")).toBeVisible();
    await reach(
      app.page,
      app.page.getByRole("button", { name: "Close image", exact: true }),
    );
    await app.page.keyboard.press("Enter");
    await expect(preview).toBeFocused();
    await expect(app.page.locator("dialog.image-viewer")).toHaveCount(0);
    await app.page.evaluate(() => {
      let released = false;
      document.addEventListener(
        "close",
        (event) => {
          const dialog = event.target;
          if (
            released ||
            !(dialog instanceof HTMLDialogElement) ||
            !dialog.classList.contains("image-viewer")
          )
            return;
          event.stopImmediatePropagation();
          (window as any).releaseImageClose = () => {
            released = true;
            const before = document.activeElement?.getAttribute("aria-label");
            dialog.dispatchEvent(new Event("close"));
            return {
              before,
              after: document.activeElement?.getAttribute("aria-label"),
            };
          };
        },
        true,
      );
    });
    await app.page.keyboard.press("Enter");
    await expect(app.page.locator("dialog.image-viewer")).toBeVisible();
    await app.page.keyboard.press("Escape");
    await expect
      .poll(() =>
        app.page.evaluate(() => typeof (window as any).releaseImageClose),
      )
      .toBe("function");
    await expect(preview).toBeFocused();
    await reach(
      app.page,
      app.page.getByRole("button", { name: "Remove image", exact: true }),
    );
    const focusTransition = await app.page.evaluate(() =>
      (window as any).releaseImageClose(),
    );
    await info.attach("image-close-focus", {
      body: JSON.stringify(focusTransition),
      contentType: "application/json",
    });
    await expect(
      app.page.getByRole("button", { name: "Remove image", exact: true }),
    ).toBeFocused();
    await app.page.keyboard.press("Enter");
    await expect(preview).toHaveCount(0);
    await reach(app.page, composer());
    const invocations = await observeInvocations(app.page);
    await app.page.keyboard.type("[approve] keyboard only task");
    await composer().evaluate((node) =>
      node.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          ctrlKey: true,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await app.page.keyboard.press(`${modifier}+Alt+Enter`);
    expect(await app.prompts()).toHaveLength(0);
    expect(
      invocations.operations.filter((op) =>
        ["conversation.start", "conversation.send"].includes(op),
      ),
    ).toHaveLength(0);
    await app.page.keyboard.press(`${modifier}+Enter`);
    await expect.poll(async () => (await app.prompts()).length).toBe(1);
    expect(JSON.stringify(await app.prompts())).not.toContain("data:image/");
    const allow = app.page.getByRole("button", {
      name: "Allow once",
      exact: true,
    });
    await expect(allow).toBeVisible();
    expect(
      invocations.operations.filter((op) => op === "conversation.send"),
      JSON.stringify(invocations.operations),
    ).toHaveLength(1);
    expect(
      invocations.operations.filter((op) => op === "conversation.start"),
    ).toHaveLength(1);
    await invocations.close();
    await reach(app.page, allow);
    await app.page.keyboard.press("Enter");
    await expect(
      app.page.getByText("ALLOWED [approve] keyboard only task", {
        exact: true,
      }),
    ).toBeVisible();
    await reach(app.page, composer());
    await app.page.keyboard.type("next draft remains intact");
    await app.page.keyboard.press("Home");
    await app.page.keyboard.press("ArrowRight");
    await command(app.page, "Rename workspace");
    await expect(
      app.page.getByRole("textbox", { name: "Workspace name" }),
    ).toBeFocused();
    await app.page.keyboard.type("Cancelled workspace");
    await app.page.keyboard.press("Escape");
    await expect((await app.overview()).getByRole("combobox")).toBeFocused();
    await app.page.keyboard.press("Escape");
    await expect(composer()).toHaveValue("next draft remains intact");
    expect(
      await composer().evaluate(
        (node) => (node as HTMLTextAreaElement).selectionStart,
      ),
    ).toBe(1);
    await app.page.screenshot({
      path: info.outputPath("keyboard-chat-focus.png"),
    });
  } finally {
    await app.cleanup();
  }
});

test("Native website keys stay on the page and palette cancellation restores its exact field selection", async ({}, info) => {
  const app = new ChatApp();
  await prepareKeyboardProfile(app);
  let server: Server | undefined;
  try {
    server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<!doctype html><title>Invented keyboard page</title><label>First<input id="first" autofocus value="first field"></label><label>Second<input id="second" value="second field"></label><div id="rich" contenteditable>Invented rich text</div><p>Closing marker</p><script>window.keys=[];document.addEventListener('keydown',e=>{window.keys.push({key:e.key,code:e.code,ctrl:e.ctrlKey,meta:e.metaKey,shift:e.shiftKey});if((e.ctrlKey||e.metaKey)&&e.target instanceof HTMLInputElement&&['b','p','f'].includes(e.key.toLowerCase()))e.preventDefault()});</script>`,
      );
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address");
    const url = `http://127.0.0.1:${address.port}/`;
    await app.start();
    const workspace = (await state(app)).activeWorkspaceId!;
    await app.cli("browser", "open", "--workspace", workspace, "--url", url);
    const inspect = async () =>
      app.app!.evaluate(async ({ webContents }, url) => {
        const wc = webContents
          .getAllWebContents()
          .find((item) => item.getURL() === url);
        if (!wc) return null;
        return {
          focused: wc.isFocused(),
          ...(await wc.executeJavaScript(
            `({field:document.activeElement.id,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd,keys:window.keys})`,
          )),
        };
      }, url);
    await expect.poll(inspect).not.toBeNull();
    // Left/right pane focus is independent of tab selection.
    await app.page.keyboard.press("Alt+1");
    await expect.poll(async () => (await inspect())?.focused).toBe(true);
    const key = async (
      keyCode: string,
      modifiers: Array<"control" | "meta" | "shift" | "alt"> = [],
    ) => {
      await app.app!.evaluate(
        ({ webContents }, args) => {
          const wc = webContents
            .getAllWebContents()
            .find((item) => item.getURL() === args.url)!;
          wc.sendInputEvent({
            type: "keyDown",
            keyCode: args.keyCode,
            modifiers: args.modifiers,
          });
          wc.sendInputEvent({
            type: "keyUp",
            keyCode: args.keyCode,
            modifiers: args.modifiers,
          });
        },
        { url, keyCode, modifiers },
      );
    };
    await key("Tab");
    await key("Home");
    await key("Right");
    await key("Right", ["shift"]);
    await expect.poll(inspect).toMatchObject({
      focused: true,
      field: "second",
      start: 1,
      end: 2,
    });
    const mod = process.platform === "darwin" ? "meta" : "control";
    for (const letter of ["B", "P"]) await key(letter, [mod]);
    await expect
      .poll(async () => {
        const keys: Array<{ key: string }> = (await inspect())?.keys ?? [];
        return ["b", "p"].map(
          (letter) =>
            keys.filter((item) => item.key.toLowerCase() === letter).length,
        );
      })
      .toEqual([1, 1]);
    await expect(app.page.getByRole("dialog")).toHaveCount(0);
    const toggleFiles = app.page.getByRole("button", { name: "Toggle files" });
    const runPageScript = (script: string) =>
      app.app!.evaluate(
        ({ webContents }, { url, script }) =>
          webContents
            .getAllWebContents()
            .find((item) => item.getURL() === url)!
            .executeJavaScript(script),
        { url, script },
      );
    await expect(toggleFiles).toHaveAttribute("aria-pressed", "false");
    await runPageScript("document.querySelector('#rich').focus()");
    await key("B", [mod]);
    await expect
      .poll(() => runPageScript("document.queryCommandState('bold')"))
      .toBe(true);
    await expect(toggleFiles).toHaveAttribute("aria-pressed", "false");

    await runPageScript("document.activeElement.blur()");
    await key("B", [mod]);
    await expect(toggleFiles).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await inspect())?.focused).toBe(true);
    await key("B", [mod]);
    await expect(toggleFiles).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => (await inspect())?.focused).toBe(true);
    await runPageScript(
      "document.querySelector('#second').focus(); document.querySelector('#second').setSelectionRange(1, 2)",
    );
    await key("P", [mod, "shift"]);
    await expect(
      app.page.getByRole("dialog", { name: "Command palette" }),
    ).toBeVisible();
    await app.page.screenshot({
      path: info.outputPath("commands-over-native-page.png"),
    });
    await app.page.keyboard.press("Escape");
    await expect.poll(async () => (await inspect())?.focused).toBe(true);
    const restored = await inspect();
    expect([restored.field, restored.start, restored.end]).toEqual([
      "second",
      1,
      2,
    ]);
    await key("F", [mod]);
    const nativeFind = app.page.getByRole("textbox", {
      name: "Find in current content",
      exact: true,
    });
    await expect(nativeFind).toBeFocused();
    await app.page.keyboard.type("First");
    await expect(
      app.page.getByRole("status", { name: "Find results" }),
    ).toHaveText("1 of 2");
    await app.page.keyboard.press("Enter");
    await expect(
      app.page.getByRole("status", { name: "Find results" }),
    ).toHaveText("2 of 2");
    await app.page.keyboard.press("Shift+Enter");
    await expect(
      app.page.getByRole("status", { name: "Find results" }),
    ).toHaveText("1 of 2");
    await app.page.keyboard.press("Escape");
    await expect.poll(async () => (await inspect())?.focused).toBe(true);
    const afterFind = await inspect();
    expect([afterFind.field, afterFind.start, afterFind.end]).toEqual([
      "second",
      1,
      2,
    ]);
    await key("Escape");
    await expect
      .poll(
        async () =>
          (await inspect())?.keys.filter(
            (item: { key: string }) => item.key === "Escape",
          ).length,
      )
      .toBe(1);
    await key("F", [mod]);
    await expect(nativeFind).toBeFocused();
    await app.app!.evaluate(({ webContents }, url) => {
      webContents
        .getAllWebContents()
        .find((item) => item.getURL() === url)!
        .focus();
    }, url);
    await expect.poll(async () => (await inspect())?.focused).toBe(true);
    await key("Escape");
    await expect(nativeFind).toBeHidden();
    await expect.poll(async () => (await inspect())?.focused).toBe(true);
    expect(
      (await inspect())?.keys.filter(
        (item: { key: string }) => item.key === "Escape",
      ),
    ).toHaveLength(1);
    await key("J", [mod, "shift"]);
    await expect
      .poll(async () => (await inspect())?.keys)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "KeyJ", shift: true }),
        ]),
      );
    await expect.poll(async () => (await inspect())?.focused).toBe(true);
    // Provide an already available real frame to exercise the composed path
    // without racing the operating system's bounded native capture deadline.
    await app.app!.evaluate(async ({ webContents }, fixtureUrl) => {
      const native = webContents
        .getAllWebContents()
        .find((item) => item.getURL() === fixtureUrl)!;
      const capture = native.capturePage.bind(native);
      const frame = await capture(undefined, { stayHidden: true });
      native.capturePage = async () => {
        native.capturePage = capture;
        return frame;
      };
    }, url);
    await key("`", ["control"]);
    const quick = app.page.getByRole("dialog", { name: "Quick Terminal" });
    await expect(
      quick.getByRole("textbox", { name: "Terminal input" }),
    ).toBeFocused();
    await expect(quick).toHaveCSS("opacity", "1");
    await expect(app.page.locator(".browser-overview-backdrop")).toBeVisible();
    expect(
      await app.app!.evaluate(
        ({ BrowserWindow, WebContentsView }, fixtureUrl) =>
          BrowserWindow.getAllWindows()[0].contentView.children.some(
            (view) =>
              view instanceof WebContentsView &&
              view.webContents.getURL() === fixtureUrl &&
              view.getVisible(),
          ),
        url,
      ),
    ).toBe(false);
    await app.page.screenshot({
      path: info.outputPath("quick-terminal-over-browser.png"),
    });
    await app.page.keyboard.press("Control+Backquote");
    await expect(quick).toHaveCount(0);
    expect((await inspect()).keys).not.toContainEqual(
      expect.objectContaining({ code: "Backquote", ctrl: true }),
    );
    await expect.poll(async () => (await inspect())?.focused).toBe(true);
    const quickButton = app.page.locator(".app-header").getByRole("button", {
      name: "Quick Terminal",
      exact: true,
    });
    await quickButton.click();
    await expect(
      quick.getByRole("textbox", { name: "Terminal input" }),
    ).toBeFocused();
    await quick
      .getByRole("textbox", { name: "Terminal input" })
      .press("Escape");
    await expect(quick).toHaveCount(0);
    await expect.poll(async () => (await inspect())?.focused).toBe(true);
    const afterButton = await inspect();
    expect([afterButton.field, afterButton.start, afterButton.end]).toEqual([
      "second",
      1,
      2,
    ]);
    await key("E", [mod, "shift"]);
    await expect(app.page.locator("#project-panel")).toBeFocused();
    await app.page.keyboard.press(`${modifier}+Shift+E`);
    await expect.poll(async () => (await inspect())?.focused).toBe(true);
    const afterFocusReturn = await inspect();
    expect([
      afterFocusReturn.field,
      afterFocusReturn.start,
      afterFocusReturn.end,
    ]).toEqual(["second", 1, 2]);
    const nativePng = await app.app!.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL() === url)!;
      return (await contents.capturePage()).toPNG().toString("base64");
    }, url);
    await (
      await import("node:fs/promises")
    ).writeFile(
      info.outputPath("native-field-selection.png"),
      Buffer.from(nativePng, "base64"),
    );

    await key("Tab", ["alt"]);
    await expect.poll(async () => (await inspect())?.focused).toBe(false);
    await app.page.screenshot({
      path: info.outputPath("native-keyboard-return.png"),
    });
    const before = (await state(app)).workspaces.find(
      (item) => item.id === workspace,
    )!;
    const original = before.panes.find((pane) => pane.kind === "browser")!;
    const chatPane = before.panes.find((pane) => pane.kind === "document")!;
    const second = await app.cli<{ paneId: string }>(
      "browser",
      "open",
      "--workspace",
      workspace,
      "--url",
      url + "second",
    );
    // Keep the origin physically visible while making the app's active pane a chat.
    await app.cli(
      "pane",
      "focus",
      "--workspace",
      workspace,
      "--id",
      original.id,
    );
    await expect
      .poll(
        async () =>
          (
            await app.cli<{ visible: boolean }>(
              "browser",
              "inspect",
              "--id",
              (original as { browserId: string }).browserId,
            )
          ).visible,
      )
      .toBe(true);
    await app.cli(
      "pane",
      "focus",
      "--workspace",
      workspace,
      "--id",
      chatPane.id,
    );
    await app.page.evaluate(() => {
      (window as any).__keyboardStates = [];
      window.cod.onState((value) => {
        const w = value.workspaces.find(
          (item) => item.id === value.activeWorkspaceId,
        );
        (window as any).__keyboardStates.push({
          active: w?.activePaneId,
          groups: w?.groups?.map((g) => ({ id: g.id, active: g.activePaneId })),
          focused: document.activeElement?.getAttribute("aria-label"),
        });
      });
    });
    await app.app!.evaluate(({ webContents }, url) => {
      const wc = webContents
        .getAllWebContents()
        .find((item) => item.getURL() === url)!;
      wc.focus();
      wc.sendInputEvent({
        type: "keyDown",
        keyCode: "2",
        modifiers: [process.platform === "darwin" ? "meta" : "control"],
      });
      wc.sendInputEvent({
        type: "keyUp",
        keyCode: "2",
        modifiers: [process.platform === "darwin" ? "meta" : "control"],
      });
    }, url);
    await expect
      .poll(
        async () =>
          (await state(app)).workspaces.find((item) => item.id === workspace)!
            .activePaneId,
      )
      .toBe(second.paneId)
      .catch(async (error) => {
        console.log("Native target diagnosis", {
          original: original.id,
          chat: chatPane.id,
          expected: second.paneId,
          states: await app.page.evaluate(
            () => (window as any).__keyboardStates,
          ),
          native: await inspect(),
        });
        throw error;
      });
    // Keep the origin physically visible while making the app's active pane a chat.
    await app.cli(
      "pane",
      "focus",
      "--workspace",
      workspace,
      "--id",
      original.id,
    );
    await expect
      .poll(
        async () =>
          (
            await app.cli<{ visible: boolean }>(
              "browser",
              "inspect",
              "--id",
              (original as { browserId: string }).browserId,
            )
          ).visible,
      )
      .toBe(true);
    await app.cli(
      "pane",
      "focus",
      "--workspace",
      workspace,
      "--id",
      chatPane.id,
    );
    await app.app!.evaluate(({ webContents }, url) => {
      const wc = webContents
        .getAllWebContents()
        .find((item) => item.getURL() === url)!;
      wc.focus();
      wc.sendInputEvent({ type: "keyDown", keyCode: "N", modifiers: ["alt"] });
      wc.sendInputEvent({ type: "keyUp", keyCode: "N", modifiers: ["alt"] });
    }, url);
    const chatGroup = before.groups!.find((group) =>
      group.paneIds.includes(chatPane.id),
    )!;
    await expect
      .poll(
        async () =>
          (await state(app)).workspaces
            .find((w) => w.id === workspace)!
            .groups!.find((group) => group.id === chatGroup.id)!.paneIds,
      )
      .toEqual([chatPane.id, original.id]);
    const splitState = (await state(app)).workspaces.find(
      (w) => w.id === workspace,
    )!;
    expect(splitState.groups).toHaveLength(2);
    expect(
      splitState.groups!.find((group) => group.id !== chatGroup.id)!.paneIds,
    ).toEqual([second.paneId]);
    expect(splitState.panes.filter((p) => p.id === original.id)).toHaveLength(
      1,
    );
    // Keep the original browser on the right while another tab is active on the left.
    await app.cli(
      "pane",
      "focus",
      "--workspace",
      workspace,
      "--id",
      second.paneId,
    );
    await app.app!.evaluate(
      ({ webContents }, args) => {
        const wc = webContents
          .getAllWebContents()
          .find((item) => item.getURL() === args.url)!;
        wc.focus();
        wc.sendInputEvent({
          type: "keyDown",
          keyCode: "W",
          modifiers: [args.mod as "meta" | "control"],
        });
        wc.sendInputEvent({
          type: "keyUp",
          keyCode: "W",
          modifiers: [args.mod as "meta" | "control"],
        });
      },
      { url, mod },
    );
    await expect
      .poll(async () =>
        (await state(app)).workspaces
          .find((item) => item.id === workspace)!
          .panes.some((pane) => pane.id === original.id),
      )
      .toBe(false);
    expect(
      (await state(app)).workspaces
        .find((item) => item.id === workspace)!
        .panes.map((pane) => pane.id),
    ).toEqual(expect.arrayContaining([chatPane.id, second.paneId]));
    // Leaving Find open must not crash or hang application shutdown.
    await app.page.keyboard.press("Alt+1");
    await app.app!.evaluate(
      ({ webContents }, args) => {
        const wc = webContents
          .getAllWebContents()
          .find((item) => item.getURL() === args.url)!;
        wc.sendInputEvent({
          type: "keyDown",
          keyCode: "F",
          modifiers: [args.mod as "meta" | "control"],
        });
        wc.sendInputEvent({
          type: "keyUp",
          keyCode: "F",
          modifiers: [args.mod as "meta" | "control"],
        });
      },
      { url: url + "second", mod },
    );
    await expect(
      app.page.getByRole("textbox", {
        name: "Find in current content",
        exact: true,
      }),
    ).toBeFocused();
    await app.page.keyboard.type("Closing marker");
    await expect(
      app.page.getByRole("status", { name: "Find results" }),
    ).toHaveText("1 of 1");
    await app.stop();
  } finally {
    await app.cleanup();
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});

test("Terminal readline and interruption survive global keyboard navigation without duplicate input", async ({}, info) => {
  const app = new ChatApp();
  await prepareKeyboardProfile(app);
  Object.assign(app.environment, {
    COD_TERMINAL_SHELL: "/bin/bash",
    COD_TERMINAL_ARGS: JSON.stringify(["--noprofile", "--norc", "-i"]),
    HISTFILE: "/dev/null",
  });
  try {
    await app.start();
    await command(app.page, "New terminal");
    await expect.poll(async () => (await state(app)).terminals.length).toBe(1);
    const terminal = (await state(app)).terminals[0]!;
    const input = app
      .pane(terminal.paneId)
      .getByRole("textbox", { name: "Terminal input" });
    const output = async () =>
      (
        await app.cli<{ output: string }>(
          "terminal",
          "inspect",
          "--id",
          terminal.id,
        )
      ).output;
    await reach(app.page, input);
    await app.page.keyboard.press("Control+Backquote");
    const quick = app.page.getByRole("dialog", { name: "Quick Terminal" });
    await expect(
      quick.getByRole("textbox", { name: "Terminal input" }),
    ).toBeFocused();
    await app.page.keyboard.press("Control+Backquote");
    await expect(quick).toHaveCount(0);
    await expect(input).toBeFocused();
    await app.page.keyboard.press("Control+c");
    await app.page.keyboard.type(
      "stty -echo; set +H; printf '\\nKEYBOARD_READY\\n'",
    );
    await app.page.keyboard.press("Enter");
    await expect.poll(output).toMatch(/\r?\nKEYBOARD_READY\r?\n/);
    await app.page.keyboard.type("printf '\\nREADLINE:%s\\n' AB");
    await app.page.keyboard.press("Control+b");
    await app.page.keyboard.type("X");
    await app.page.keyboard.press("Enter");
    await expect.poll(output).toContain("READLINE:AXB");
    expect((await output()).match(/READLINE:AXB/g)).toHaveLength(1);
    await app.page.keyboard.type("sleep 300");
    await app.page.keyboard.press("Enter");
    await app.page.keyboard.press("Control+c");
    await app.page.keyboard.type("printf '\\nINTERRUPT_OK\\n'");
    await app.page.keyboard.press("Enter");
    await expect.poll(output).toContain("INTERRUPT_OK");
    await app.page.keyboard.type(
      "stty raw -echo; printf '\nRAW_ESCAPE_READY\n'; od -An -tu1 -N1; stty sane; stty -echo",
    );
    await app.page.keyboard.press("Enter");
    await expect.poll(output).toContain("RAW_ESCAPE_READY");
    await app.page.keyboard.press("Escape");
    await expect.poll(output).toMatch(/RAW_ESCAPE_READY[\s\S]*?\s27\r?\n/);
    const wrapGrid = await app.cli<{ cols: number }>(
      "terminal",
      "inspect",
      "--id",
      terminal.id,
    );
    const wrapped = "A".repeat(wrapGrid.cols - 2) + "WRAP_NEEDLE";
    await app.page.keyboard.type(`printf '\\n${wrapped}\\n'`);
    await app.page.keyboard.press("Enter");
    await expect.poll(output).toContain(wrapped);
    await command(app.page, "Find in current content");
    await expect(
      app.page.getByRole("textbox", {
        name: "Find in current content",
        exact: true,
      }),
    ).toBeFocused();
    await app.page.keyboard.type("WRAP_NEEDLE");
    await expect(
      app.page.getByRole("status", { name: "Find results" }),
    ).toHaveText("1 of 1");
    await app.page.screenshot({
      path: info.outputPath("terminal-wrapped-find.png"),
    });
    await app.page.keyboard.press(`${modifier}+A`);
    await app.page.keyboard.press("Backspace");
    await expect(
      app.page.getByRole("status", { name: "Find results" }),
    ).toHaveText("");
    await app.page.screenshot({
      path: info.outputPath("terminal-cleared-find.png"),
    });
    await input.focus();
    await app.page.keyboard.press("Escape");
    await expect(
      app.page.getByRole("textbox", {
        name: "Find in current content",
        exact: true,
      }),
    ).toBeHidden();
    await expect(input).toBeFocused();
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    await expect(
      app.page.getByRole("dialog", { name: "Command palette" }),
    ).toBeVisible();
    await app.page.keyboard.press("Escape");
    await expect(input).toBeFocused();
    await app.page.keyboard.type("printf '\\nAFTER_PALETTE\\n'");
    await app.page.keyboard.press("Enter");
    await expect.poll(output).toContain("AFTER_PALETTE");
    expect((await output()).match(/AFTER_PALETTE/g)).toHaveLength(1);
    await app.overview();
    await expect(input).not.toBeFocused();
    await app.page.keyboard.press("Escape");
    await expect(input).toBeFocused();
    await app.page.screenshot({
      path: info.outputPath("terminal-keyboard-focus.png"),
    });
    const grid = await app.cli<{ cols: number; rows: number }>(
      "terminal",
      "inspect",
      "--id",
      terminal.id,
    );
    await app.page.keyboard.press(`${modifier}+=`);
    await expect
      .poll(async () => {
        const changed = await app.cli<{ cols: number; rows: number }>(
          "terminal",
          "inspect",
          "--id",
          terminal.id,
        );
        return changed.cols < grid.cols || changed.rows < grid.rows;
      })
      .toBe(true);
    await app.page.keyboard.press(`${modifier}+,`);
    await expect(
      app.page.getByRole("spinbutton", {
        name: "Terminal text size",
        exact: true,
      }),
    ).toHaveValue("14");
    await expect(
      app.page.getByRole("spinbutton", {
        name: "Interface text size",
        exact: true,
      }),
    ).toHaveValue("14");
    await app.page.screenshot({
      path: info.outputPath("terminal-font-settings.png"),
    });
    await app.page.keyboard.press("Escape");
    await expect(input).toBeFocused();
    await app.page.keyboard.press(`${modifier}+0`);
    await app.page.keyboard.press(`${modifier}+,`);
    await expect(
      app.page.getByRole("spinbutton", {
        name: "Terminal text size",
        exact: true,
      }),
    ).toHaveValue("13");
    await app.page.keyboard.press("Escape");
    await app.page.keyboard.press(`${modifier}+=`);
    await app.stop();
    await app.start();
    await app.page.keyboard.press(`${modifier}+,`);
    await expect(
      app.page.getByRole("spinbutton", {
        name: "Terminal text size",
        exact: true,
      }),
    ).toHaveValue("14");
  } finally {
    await app.cleanup();
  }
});

test("Keyboard task layout edits files, reorders tabs, hides and restores panes across restart", async ({}, info) => {
  const app = new ChatApp();
  await prepareKeyboardProfile(app);
  try {
    await app.start();
    await command(app.page, "New workspace");
    await expect(app.page.getByRole("dialog")).toHaveCount(0);
    const workspace = (await state(app)).activeWorkspaceId!;
    await app.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      app.folders[0],
    );
    await command(app.page, "Open file");
    await app.page.keyboard.type("spec.md");
    await expect(
      app.page
        .getByRole("dialog", { name: "Open file", exact: true })
        .getByRole("button", { name: "spec.md", exact: true }),
    ).toHaveAttribute("aria-current", "true");
    await app.page.keyboard.press("Enter");
    const editor = () =>
      app.page.getByRole("textbox", { name: "File contents" });
    await expect(editor()).toBeFocused();
    await app.page.keyboard.press(`${modifier}+End`);
    await app.page.keyboard.type("\nKeyboard addition.");
    await expect(editor()).toHaveValue(/Keyboard addition\./);
    await app.page.keyboard.press(`${modifier}+S`);
    console.log(
      "Save observation",
      await app.page.evaluate(() => ({
        focus: document.activeElement?.getAttribute("aria-label"),
        status: [...document.querySelectorAll('[role="status"]')].map(
          (item) => item.textContent,
        ),
      })),
      (await state(app)).workspaces.find((item) => item.id === workspace)
        ?.activePaneId,
    );
    await app.page.screenshot({
      path: info.outputPath("keyboard-save-state.png"),
    });
    await expect
      .poll(async () =>
        (await import("node:fs/promises")).readFile(app.file, "utf8"),
      )
      .toContain("Keyboard addition.");
    const originalCaret = await editor().evaluate(
      (node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd],
    );
    const beforePanels = (await state(app)).workspaces.find(
      (w) => w.id === workspace,
    )!;
    await app.page.keyboard.press(`${modifier}+B`);
    await expect
      .poll(
        async () =>
          (await state(app)).workspaces.find((w) => w.id === workspace)!
            .settings?.filesVisible,
      )
      .toBe(!beforePanels.settings?.filesVisible);
    expect(
      (await state(app)).workspaces.find((w) => w.id === workspace)!.groups,
    ).toEqual(beforePanels.groups);
    await app.page.keyboard.press(`${modifier}+B`);
    await expect
      .poll(
        async () =>
          (await state(app)).workspaces.find((w) => w.id === workspace)!
            .settings?.filesVisible,
      )
      .toBe(beforePanels.settings?.filesVisible === true);
    for (const shortcut of [`${modifier}+Shift+E`]) {
      await app.page.keyboard.press(shortcut);
      await expect(editor()).not.toBeFocused();
      await app.page.keyboard.press(shortcut);
      await expect(editor()).toBeFocused();
      expect(
        await editor().evaluate((node: HTMLTextAreaElement) => [
          node.selectionStart,
          node.selectionEnd,
        ]),
      ).toEqual(originalCaret);
    }
    // Current-content search keeps the file unchanged and restores its exact caret.
    const beforeFind = await editor().evaluate((node: HTMLTextAreaElement) => ({
      start: node.selectionStart,
      end: node.selectionEnd,
      value: node.value,
    }));
    await app.page.keyboard.press(`${modifier}+F`);
    const find = app.page.getByRole("textbox", {
      name: "Find in current content",
      exact: true,
    });
    await expect(find).toBeFocused();
    await app.page.keyboard.type("Keyboard");
    await expect(
      app.page.getByRole("status", { name: "Find results" }),
    ).toHaveText("1 of 1");
    await app.page.keyboard.press("Enter");
    await app.page.keyboard.press("Shift+Enter");
    await expect(
      app.page.getByRole("status", { name: "Find results" }),
    ).toHaveText("1 of 1");
    expect(
      await editor().evaluate((node: HTMLTextAreaElement) =>
        node.value.slice(node.selectionStart, node.selectionEnd),
      ),
    ).toBe("Keyboard");
    await app.page.screenshot({
      path: info.outputPath("current-content-find.png"),
    });
    await app.page.keyboard.press("Escape");
    await expect(editor()).toBeFocused();
    expect(
      await editor().evaluate((node: HTMLTextAreaElement) => ({
        start: node.selectionStart,
        end: node.selectionEnd,
        value: node.value,
      })),
    ).toEqual(beforeFind);
    await app.page.keyboard.press("Alt+2");
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeFocused();
    await app.page.keyboard.type("preserved first draft");
    const firstDraft = (await state(app)).workspaces.find(
      (item) => item.id === workspace,
    )!.activePaneId;
    await app.page.keyboard.press(`${modifier}+N`);
    await expect
      .poll(
        async () =>
          (await state(app)).workspaces.find((item) => item.id === workspace)!
            .activePaneId,
      )
      .not.toBe(firstDraft);
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeFocused();
    await app.page.keyboard.type("preserved second draft");
    const before = (await state(app)).workspaces.find(
      (item) => item.id === workspace,
    )!;
    const group = before.groups!.find((item) =>
      item.paneIds.includes(before.activePaneId),
    )!;
    expect(group.paneIds).toHaveLength(2);
    const last = before.activePaneId;
    await command(app.page, "Move tab left");
    await expect
      .poll(
        async () =>
          (await state(app)).workspaces
            .find((item) => item.id === workspace)!
            .groups!.find((item) => item.id === group.id)!.paneIds[0],
      )
      .toBe(last);
    await app.page.keyboard.press(`${modifier}+2`);
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("preserved first draft");
    await app.page.keyboard.press(`${modifier}+1`);
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("preserved second draft");
    const finishFocusDiagnostics = await observeLayoutFocus(app.page);
    await expect(
      app.page.getByRole("separator", { name: "Resize panes", exact: true }),
    ).toHaveCount(1);
    const splitBefore = JSON.stringify(
      (await state(app)).workspaces.find((item) => item.id === workspace)!
        .groupLayout,
    );
    const divider = app.page.getByRole("separator", {
      name: "Resize panes",
      exact: true,
    });
    await reach(app.page, divider);
    await app.page.keyboard.press("ArrowRight");
    await expect
      .poll(async () =>
        JSON.stringify(
          (await state(app)).workspaces.find((item) => item.id === workspace)!
            .groupLayout,
        ),
      )
      .not.toBe(splitBefore);
    try {
      await expect(divider).toBeFocused();
    } catch (error) {
      const focus = await finishFocusDiagnostics(true).catch(() => undefined);
      const native = await app
        .app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({
            focused: window.isFocused(),
            destroyed: window.isDestroyed(),
            contentsFocused: window.webContents.isFocused(),
          })),
        )
        .catch(() => undefined);
      await info.attach("layout-focus-failure", {
        body: JSON.stringify({ focus, native }),
        contentType: "application/json",
      });
      throw error;
    } finally {
      await finishFocusDiagnostics(false).catch(() => undefined);
    }
    // Move the same tab across and back using the single destination action.
    await app.page.keyboard.press("Alt+2");
    await reach(
      app.page,
      app.pane(last).getByRole("textbox", { name: "Message", exact: true }),
    );
    await command(app.page, "Move tab to another pane");
    await expect
      .poll(async () =>
        (await state(app)).workspaces
          .find((item) => item.id === workspace)!
          .groups.find((item) => item.id === group.id)!
          .paneIds.includes(last),
      )
      .toBe(false);
    await expect(
      app.pane(last).getByRole("textbox", { name: "Message", exact: true }),
    ).toBeFocused();
    await command(app.page, "Move tab to another pane");
    await expect
      .poll(async () =>
        (await state(app)).workspaces
          .find((item) => item.id === workspace)!
          .groups.find((item) => item.id === group.id)!
          .paneIds.includes(last),
      )
      .toBe(true);
    expect(
      (await state(app)).workspaces
        .find((item) => item.id === workspace)!
        .panes.filter((pane) => pane.id === last),
    ).toHaveLength(1);
    await command(app.page, "Move tab left");
    await command(app.page, "Toggle left pane");
    await expect(editor()).toHaveCount(0);
    await command(app.page, "Toggle left pane");
    await expect(editor()).toBeVisible();
    await app.page.keyboard.press("Alt+1");
    await expect(editor()).toBeFocused();
    await app.page.keyboard.press("Alt+Enter");
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveCount(0);
    await app.page.keyboard.press("Alt+Enter");
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeVisible();
    await command(app.page, "Focus files / return");
    const root = app.page.getByRole("treeitem", {
      name: "alpha repo",
      exact: true,
    });
    await expect(root).toBeFocused();
    await app.page.keyboard.press("ArrowRight");
    await app.page.keyboard.press("ArrowRight");
    await expect(
      app.page.getByRole("treeitem", { name: "spec.md", exact: true }),
    ).toBeFocused();
    await app.page.keyboard.press("ArrowLeft");
    await expect(root).toBeFocused();
    await app.page.keyboard.press("Shift+F10");
    await expect(
      app.page.getByRole("dialog", { name: "Actions" }),
    ).toBeVisible();
    await app.page.keyboard.press("Escape");
    await expect(root).toBeFocused();
    await app.page.screenshot({
      path: info.outputPath("keyboard-layout-files.png"),
    });
    const savedGroups = (await state(app)).workspaces.find(
      (item) => item.id === workspace,
    )!.groups!;
    const savedGroup = savedGroups.find((item) => item.paneIds.includes(last))!;
    expect(savedGroup.paneIds[0]).toBe(last);
    await app.stop();
    await app.start();
    const restored = (await state(app)).workspaces.find(
      (item) => item.id === workspace,
    )!;
    expect(restored.groups).toEqual(savedGroups);
    expect(
      restored.groups!.find((item) => item.id === savedGroup.id)!.paneIds[0],
    ).toBe(last);
    await app.page.keyboard.press("Alt+2");
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("preserved second draft");
    await expect(
      app.pane(last).getByRole("textbox", { name: "Message", exact: true }),
    ).toBeFocused();
    await app.page.keyboard.press(`${modifier}+W`);
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("preserved first draft");
    await app.page.keyboard.press(`${modifier}+Shift+T`);
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("preserved second draft");
    const delayedFile = app.folders[0] + "/delayed-keyboard.md";
    await (
      await import("node:fs/promises")
    ).writeFile(delayedFile, "Delayed fixture content.");
    // Delay one real IPC read, as existing pending-save fixtures do; user actions remain keyboard-only.
    await app.app!.evaluate(({ ipcMain }) => {
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (...args: any[]) => unknown>;
        }
      )._invokeHandlers;
      const original = handlers.get("cod:invoke")!;
      let pending = true;
      ipcMain.removeHandler("cod:invoke");
      ipcMain.handle("cod:invoke", async (event, request) => {
        if (request.op === "file.read" && pending) {
          pending = false;
          await new Promise<void>((resolve) => {
            (globalThis as any).releaseKeyboardRead = resolve;
          });
        }
        return original(event, request);
      });
    });
    await command(app.page, "Open file");
    await app.page.keyboard.type("delayed-keyboard.md");
    await expect(
      app.page
        .getByRole("dialog", { name: "Open file", exact: true })
        .getByRole("button", { name: "delayed-keyboard.md", exact: true }),
    ).toHaveAttribute("aria-current", "true");
    await app.page.keyboard.press("Enter");
    await expect(editor()).toBeDisabled();
    await app.page.keyboard.press("Alt+2");
    const returnedComposer = app.page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await expect(returnedComposer).toBeFocused();
    await app.page.keyboard.press("End");
    await app.page.keyboard.type(" while file loads");
    await app.app!.evaluate(() => (globalThis as any).releaseKeyboardRead());
    await expect(editor()).toHaveValue("Delayed fixture content.");
    await expect(editor()).toBeEnabled();
    await expect(returnedComposer).toBeFocused();
    await expect(returnedComposer).toHaveValue(
      "preserved second draft while file loads",
    );
  } finally {
    await app.cleanup();
  }
});

test("Close immediately after a pane shortcut follows the new tab even during selection IPC", async () => {
  const app = new ChatApp();
  await prepareKeyboardProfile(app);
  try {
    await app.start();
    const workspace = await app.create("Rapid tab close");
    const first = await app.newChat(workspace, "codex");
    const second = await app.newChat(workspace, "codex");
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
    await app.page.keyboard.press("Alt+1");
    await expect(editor).toBeFocused();

    await app.app!.evaluate(({ ipcMain }, target) => {
      const state = globalThis as typeof globalThis & {
        releaseLayoutFocus?: () => void;
        layoutCloseTarget?: string;
      };
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (...args: any[]) => unknown>;
        }
      )._invokeHandlers;
      const original = handlers.get("cod:invoke")!;
      ipcMain.removeHandler("cod:invoke");
      ipcMain.handle("cod:invoke", async (event, request) => {
        if (
          request.op === "pane.focus" &&
          request.id === target &&
          !state.releaseLayoutFocus
        ) {
          await new Promise<void>((resolve) => {
            state.releaseLayoutFocus = resolve;
          });
        }
        if (request.op === "pane.close") state.layoutCloseTarget = request.id;
        return original(event, request);
      });
    }, second.paneId);
    await app.page.keyboard.press("Alt+2");
    await expect
      .poll(() =>
        app.app!.evaluate(() => typeof (globalThis as any).releaseLayoutFocus),
      )
      .toBe("function");
    await expect(editor).toBeFocused();
    await app.page.keyboard.press(`${modifier}+W`);
    await app.app!.evaluate(() => (globalThis as any).releaseLayoutFocus());

    await expect
      .poll(() =>
        app.app!.evaluate(() => (globalThis as any).layoutCloseTarget),
      )
      .toBe(second.paneId);
    await expect(app.pane(second.paneId)).toBeHidden();
    await expect(
      app
        .pane(first.paneId)
        .getByRole("textbox", { name: "Message", exact: true }),
    ).toBeFocused();
    await expect(editor).toBeVisible();
  } finally {
    await app.cleanup();
  }
});

test("Held and rapid pane cycling preserves the latest target while selection is pending", async () => {
  const app = new ChatApp();
  await prepareKeyboardProfile(app);
  try {
    await app.start();
    const workspace = await app.create("Rapid pane cycling");
    const right = await app.newChat(workspace, "codex");
    const left = await app.cli<{ paneId: string }>(
      "file",
      "open",
      "--workspace",
      workspace,
      "--path",
      app.file,
    );
    const editor = app
      .pane(left.paneId)
      .getByRole("textbox", { name: "File contents", exact: true });
    const composer = app
      .pane(right.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
    await app.page.keyboard.press("Alt+1");
    await expect(editor).toBeFocused();
    await editor.fill("Keep the unsaved file during a burst.");

    await app.app!.evaluate(({ ipcMain }, target) => {
      const state = {
        targets: [] as string[],
        closed: undefined as string | undefined,
        release: undefined as (() => void) | undefined,
      };
      (globalThis as any).paneBurst = state;
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (...args: any[]) => unknown>;
        }
      )._invokeHandlers;
      const original = handlers.get("cod:invoke")!;
      ipcMain.removeHandler("cod:invoke");
      ipcMain.handle("cod:invoke", async (event, request) => {
        if (request.op === "pane.focus") {
          state.targets.push(request.id);
          if (request.id === target && !state.release)
            await new Promise<void>((resolve) => {
              state.release = resolve;
            });
        }
        if (request.op === "pane.close") state.closed = request.id;
        return original(event, request);
      });
    }, right.paneId);
    const burstState = () =>
      app.app!.evaluate(() => {
        const { targets, closed, release } = (globalThis as any).paneBurst;
        return { targets, closed, paused: typeof release === "function" };
      });
    const release = () =>
      app.app!.evaluate(() => (globalThis as any).paneBurst.release());
    const keys = app.page.keyboard;
    await keys.down("Alt");
    await keys.down("Tab");
    await expect
      .poll(burstState)
      .toMatchObject({ targets: [right.paneId], paused: true });
    for (let repeat = 0; repeat < 3; repeat++) await keys.down("Tab");
    await keys.up("Tab");
    await keys.up("Alt");
    await expect(editor).toBeFocused();
    await release();
    await expect
      .poll(burstState)
      .toMatchObject({ targets: [right.paneId, left.paneId] });
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("Keep the unsaved file during a burst.");
    await expect(composer).toBeVisible();

    // Inject a realistic OS cadence without waiting for each focus operation.
    await app.page.evaluate(() => {
      const presses: Array<{ at: number; repeat: boolean }> = [];
      const focus: Array<{ at: number; control: string }> = [];
      const recording = new AbortController();
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Tab" && event.altKey)
            presses.push({ at: performance.now(), repeat: event.repeat });
        },
        { capture: true, signal: recording.signal },
      );
      document.addEventListener(
        "focusin",
        (event) => {
          if (!(event.target instanceof HTMLTextAreaElement)) return;
          const control = event.target.getAttribute("aria-label")!;
          focus.push({ at: performance.now(), control });
        },
        { signal: recording.signal },
      );
      (globalThis as any).paneCadence = { presses, focus, recording };
    });
    const cadence = () =>
      app.page.evaluate(() => {
        const { presses, focus } = (globalThis as any).paneCadence;
        return { presses, focus } as {
          presses: Array<{ at: number; repeat: boolean }>;
          focus: Array<{ at: number; control: string }>;
        };
      });
    await keys.down("Alt");
    for (let index = 0; index < 8; index++) {
      if (index) await new Promise((resolve) => setTimeout(resolve, 100));
      await keys.down("Tab");
    }
    await keys.up("Tab");
    await keys.up("Alt");
    await expect
      .poll(async () => (await cadence()).focus.map((entry) => entry.control))
      .toEqual(
        Array.from({ length: 8 }, (_, index) =>
          index % 2 ? "File contents" : "Message",
        ),
      );
    await app.page.evaluate(() =>
      (globalThis as any).paneCadence.recording.abort(),
    );
    const { presses, focus } = await cadence();
    expect(presses.map((entry) => entry.repeat)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    await writeFile(
      test.info().outputPath("pane-repeat-cadence.json"),
      JSON.stringify({
        intervalsMs: presses
          .slice(1)
          .map((entry, index) => entry.at - presses[index].at),
        focusDelayMs: focus.map((entry, index) => entry.at - presses[index].at),
      }),
    );

    const split = app.page.getByRole("button", { name: "Toggle split view" });
    await keys.press("Alt+Enter");
    await expect(split).toHaveAccessibleDescription("Only left pane visible");
    const arm = () =>
      app.app!.evaluate(() => {
        const state = (globalThis as any).paneBurst;
        state.targets = [];
        state.release = undefined;
      });
    await arm();
    await keys.press("Alt+Tab");
    await expect
      .poll(burstState)
      .toMatchObject({ targets: [right.paneId], paused: true });
    await keys.press("Alt+Tab");
    await release();
    await expect
      .poll(burstState)
      .toMatchObject({ targets: [right.paneId, left.paneId] });
    await expect(split).toHaveAccessibleDescription("Only left pane visible");
    await expect(editor).toBeFocused();

    await arm();
    await keys.press("Alt+Shift+Tab");
    await expect
      .poll(burstState)
      .toMatchObject({ targets: [right.paneId], paused: true });
    await keys.press("Alt+Shift+Tab");
    await keys.press("Alt+Shift+Tab");
    await keys.press(`${modifier}+W`);
    await release();
    await expect.poll(burstState).toMatchObject({ closed: right.paneId });
    await expect(composer).toHaveCount(0);
    await keys.press("Alt+1");
    await expect(split).toHaveAccessibleDescription("Only left pane visible");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("Keep the unsaved file during a burst.");
  } finally {
    await app.cleanup();
  }
});

test("A long review supports keyboard range comments and submission without tabbing through source lines", async ({}, info) => {
  const app = new ChatApp();
  await prepareKeyboardProfile(app);
  try {
    await (
      await import("node:fs/promises")
    ).writeFile(
      app.file,
      Array.from(
        { length: 180 },
        (_, i) => `Invented review line ${i + 1}`,
      ).join("\n"),
    );
    await app.start();
    const workspace = await app.create("Keyboard review");
    await app.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      app.folders[0],
    );
    const chat = await app.newChat(workspace, "codex");
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
    await app.page.keyboard.press("Alt+1");
    const first = app
      .pane(review.paneId)
      .getByRole("textbox", { name: "Review source", exact: true });
    await reach(app.page, first);
    await app.page.keyboard.press(`${modifier}+Home`);
    await app.page.keyboard.press("Shift+ArrowDown");
    await app.page.keyboard.press("Shift+End");
    await app.page.keyboard.press(`${modifier}+Shift+M`);
    const comment = app
      .pane(review.paneId)
      .getByRole("textbox", { name: "Comment", exact: true });
    await expect(comment).toBeFocused();
    await app.page.keyboard.type("Clarify these first two lines.");
    await app.page.keyboard.press("Escape");
    await expect(first).toBeFocused();
    await expect(comment).toHaveValue("Clarify these first two lines.");
    await reach(
      app.page,
      app
        .pane(review.paneId)
        .getByRole("button", { name: "Save comment", exact: true }),
      8,
    );
    await app.page.keyboard.press("Enter");
    await expect(
      app.pane(review.paneId).getByLabel("Draft comment", { exact: true }),
    ).toContainText("Clarify these first two lines.");
    expect(await app.prompts()).toHaveLength(0);
    await expect(
      app
        .pane(review.paneId)
        .getByLabel("Draft comment", { exact: true })
        .locator("blockquote"),
    ).toHaveText("Invented review line 1\nInvented review line 2");
    const submit = app
      .pane(review.paneId)
      .getByRole("button", { name: "Send feedback", exact: true });
    await reach(app.page, submit, 8, true);
    await app.page.screenshot({
      path: info.outputPath("keyboard-review-private.png"),
    });
    await app.page.keyboard.press("Enter");
    await expect.poll(async () => (await app.prompts()).length).toBe(1);
    await expect(app.pane(review.paneId)).toContainText("Feedback sent");
    await app.page.screenshot({
      path: info.outputPath("keyboard-review-submitted.png"),
    });
  } finally {
    await app.cleanup();
  }
});

test("Keyboard reference and unavailable commands are discoverable without losing composer selection", async ({}, info) => {
  const app = new ChatApp();
  await prepareKeyboardProfile(app);
  try {
    await app.start();
    const composer = app.page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await expect(composer).toBeFocused();
    await app.page.keyboard.type("unsent keyboard draft");
    await app.page.keyboard.press("Home");
    await app.page.keyboard.press("ArrowRight");
    await command(app.page, "Keyboard shortcuts");
    const dialog = app.page.getByRole("dialog", { name: "Keyboard shortcuts" });
    const filter = dialog.getByRole("textbox", { name: "Search shortcuts" });
    await expect(filter).toBeFocused();
    await app.page.keyboard.type("Toggle files");
    await expect(dialog.locator(".shortcut-row")).toHaveCount(1);
    await expect(dialog.locator("kbd")).toContainText("B");
    await app.page.screenshot({
      path: info.outputPath("keyboard-reference.png"),
    });
    const retired = ["Focus chat / return", "Focus terminal / return"];
    for (const name of retired) {
      await filter.fill(name);
      await expect(dialog.locator(".shortcut-row")).toHaveCount(0);
    }
    await filter.fill("Focus files / return");
    await expect(dialog.locator(".shortcut-row")).toHaveCount(1);
    await app.page.keyboard.press(`${modifier}+A`);
    await app.page.keyboard.type("Select review lines");
    await expect(dialog.locator(".shortcut-row")).toHaveCount(1);
    await expect(dialog.locator("kbd")).toContainText("Shift");
    await expect(dialog.locator("small")).toHaveText("Review source lines");
    await app.page.keyboard.press(`${modifier}+A`);
    await app.page.keyboard.type("Open context menu");
    await expect(dialog.locator("kbd")).toContainText("F10");
    await app.page.keyboard.press(`${modifier}+A`);
    await app.page.keyboard.press("Backspace");
    const referenceList = dialog.locator(".shortcut-list");
    await reach(app.page, referenceList, 3);
    await app.page.keyboard.press("End");
    await expect
      .poll(() => referenceList.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);

    await app.page.keyboard.press("Escape");
    await expect(composer).toBeFocused();
    expect(
      await composer.evaluate(
        (node) => (node as HTMLTextAreaElement).selectionStart,
      ),
    ).toBe(1);
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    const palette = app.page.getByRole("dialog", { name: "Command palette" });
    const query = palette.getByRole("textbox", { name: "Filter commands" });
    for (const name of retired) {
      await query.fill(name);
      await expect(
        palette.getByRole("button", { name, exact: true }),
      ).toHaveCount(0);
    }
    await query.fill("");
    await app.page.keyboard.type("Review active document");
    const action = app.page.getByRole("button", {
      name: /Review active document/,
    });
    await expect(action).toBeDisabled();
    await expect(action.locator(".command-disabled-reason")).toHaveText(
      "Select an editable file first",
    );
    await app.page.keyboard.press("Enter");
    await expect(
      app.page.getByRole("dialog", { name: "Command palette" }),
    ).toBeVisible();
    await app.page.screenshot({
      path: info.outputPath("disabled-keyboard-command.png"),
    });

    await app.page.keyboard.press("Escape");
    await expect(composer).toHaveValue("unsent keyboard draft");
    expect(await app.prompts()).toHaveLength(0);
  } finally {
    await app.cleanup();
  }
});

test("Invalid custom shortcuts fall back safely and repaired shortcuts reload into actions and reference", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  await mkdir(app.data, { recursive: true });
  const config = path.join(app.data, "keymap.json");
  await writeFile(config, JSON.stringify({ "unknown.command": ["Alt+E"] }));
  try {
    await app.start();
    const composer = app.page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await expect(composer).toBeFocused();
    await app.page.keyboard.type("preserved custom shortcut draft");
    await app.page.keyboard.press("Home");
    await app.page.keyboard.press("ArrowRight");
    await command(app.page, "Keyboard shortcuts");
    const warning = app.page.getByRole("status", {
      name: "Keyboard shortcuts configuration",
    });
    await expect(warning).toContainText("Defaults are active");
    await app.page
      .getByRole("textbox", { name: "Search shortcuts" })
      .pressSequentially("Commands");
    const entry = app.page
      .locator(".shortcut-row")
      .filter({ has: app.page.locator("span", { hasText: /^Commands$/ }) });
    await expect(entry.locator("kbd")).toContainText("Shift");
    await writeFile(config, JSON.stringify({ palette: ["Mod+Alt+P"] }));
    await expect
      .poll(() => app.page.evaluate(() => window.cod.getKeymap()))
      .toMatchObject({ overrides: { palette: ["Mod+Alt+P"] } });
    await expect(warning).toBeHidden();
    await expect(entry.locator("kbd")).toContainText("Alt");
    await expect(entry.locator("kbd")).not.toContainText("Shift");
    await app.page.screenshot({
      path: info.outputPath("custom-shortcuts-reloaded.png"),
    });
    await app.page.keyboard.press("Escape");
    await expect(composer).toBeFocused();
    expect(
      await composer.evaluate(
        (node: HTMLTextAreaElement) => node.selectionStart,
      ),
    ).toBe(1);
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    await expect(app.page.getByRole("dialog")).toHaveCount(0);
    await app.page.keyboard.press(`${modifier}+Alt+P`);
    await expect(
      app.page.getByRole("dialog", { name: "Command palette" }),
    ).toBeVisible();
    await app.page.keyboard.press("Escape");
    await expect(composer).toHaveValue("preserved custom shortcut draft");
    expect(await app.prompts()).toHaveLength(0);
    await app.stop();
    await app.start();
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("preserved custom shortcut draft");
    await app.page.keyboard.press(`${modifier}+Alt+P`);
    await expect(
      app.page.getByRole("dialog", { name: "Command palette" }),
    ).toBeVisible();
  } finally {
    await app.cleanup();
  }
});

test("Positional pane commands ignore tab content and restore hidden sides without losing drafts", async ({}, info) => {
  const app = new ChatApp();
  await prepareKeyboardProfile(app);
  const config = path.join(app.data, "keymap.json");
  const bindings = JSON.parse(
    await (await import("node:fs/promises")).readFile(config, "utf8"),
  );
  Object.assign(bindings, {
    "pane.toggleLeft": ["Mod+E"],
    "pane.toggleRight": ["Mod+J"],
    "pane.focusLeft": ["Alt+1"],
    "pane.focusRight": ["Alt+2"],
  });
  await writeFile(config, JSON.stringify(bindings));
  try {
    await app.start();
    const workspace = await app.create("Universal pane positions");
    const first = await app.newChat(workspace, "codex");
    await app.newChat(workspace, "codex");
    const file = await app.cli<{ paneId: string }>(
      "file",
      "open",
      "--workspace",
      workspace,
      "--path",
      app.file,
    );
    const other = path.join(app.folders[0], "second.txt");
    await writeFile(other, "Second fixture");
    await app.cli("file", "open", "--workspace", workspace, "--path", other);
    let w = (await app.cli<AppState>("state")).workspaces.find(
      (w) => w.id === workspace,
    )!;
    const left = w.groups!.find((g) => g.paneIds.includes(file.paneId))!;
    const right = w.groups!.find((g) => g.paneIds.includes(first.paneId))!;
    await app.cli(
      "pane",
      "move",
      "--workspace",
      workspace,
      "--id",
      file.paneId,
      "--group",
      right.id,
    );
    await app.cli(
      "pane",
      "move",
      "--workspace",
      workspace,
      "--id",
      first.paneId,
      "--group",
      left.id,
    );
    const composer = app
      .pane(first.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
    const editor = app
      .pane(file.paneId)
      .getByRole("textbox", { name: "File contents", exact: true });
    await app.page.keyboard.press("Alt+1");
    await expect(composer).toBeFocused();
    await composer.fill("Keep left chat draft");
    await app.page.keyboard.press("Alt+2");
    await expect(editor).toBeFocused();
    await editor.fill("Keep right file draft");
    await app.page.keyboard.press(`${modifier}+J`);
    await expect(app.pane(file.paneId)).toBeHidden();
    await expect(composer).toBeFocused();
    await app.page.keyboard.press("Alt+2");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("Keep right file draft");
    await app.page.keyboard.press("Alt+Enter");
    await expect(composer).toBeVisible();
    await app.page.keyboard.press(`${modifier}+E`);
    await expect(app.pane(first.paneId)).toBeHidden();
    await expect(editor).toBeFocused();
    await app.page.keyboard.press(`${modifier}+J`);
    await expect(editor).toBeFocused();
    await expect(
      app.page.getByRole("button", { name: "Toggle split view", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await app.page.keyboard.press("Alt+1");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Keep left chat draft");
    w = (await app.cli<AppState>("state")).workspaces.find(
      (w) => w.id === workspace,
    )!;
    expect(w.groups!.find((g) => g.id === left.id)!.paneIds).toContain(
      first.paneId,
    );
    expect(w.groups!.find((g) => g.id === right.id)!.paneIds).toContain(
      file.paneId,
    );
    await app.page.screenshot({
      path: info.outputPath("positional-pane-focus.png"),
    });
    await app.page.keyboard.press(`${modifier}+J`);
    await app.stop();
    await app.start();
    await app.page.keyboard.press("Alt+2");
    await expect
      .poll(() =>
        app.page.evaluate(() => {
          const e = document.activeElement as HTMLElement | null;
          return {
            pane: e?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId,
            label: e?.getAttribute("aria-label"),
            focused: document.hasFocus(),
            tag: e?.tagName,
            disabled: e instanceof HTMLTextAreaElement ? e.disabled : null,
          };
        }),
      )
      .toMatchObject({
        pane: file.paneId,
        label: "File contents",
        focused: true,
        disabled: false,
      });
    await expect(
      app
        .pane(file.paneId)
        .getByRole("textbox", { name: "File contents", exact: true }),
    ).toBeFocused();
    await expect(
      app
        .pane(file.paneId)
        .getByRole("textbox", { name: "File contents", exact: true }),
    ).toHaveValue("Keep right file draft");
    const html = path.join(app.folders[0], "keyboard.html");
    await writeFile(
      html,
      "<!doctype html><title>Native pane fixture</title><h1>Native pane</h1>",
    );
    const url = (await import("node:url")).pathToFileURL(html).href;
    const browser = await app.cli<{ id: string; paneId: string }>(
      "browser",
      "open",
      "--workspace",
      workspace,
      "--url",
      url,
      "--source-pane",
      file.paneId,
      "--focus",
      "true",
    );
    await app.page.keyboard.press("Alt+2");
    await expect
      .poll(() =>
        app.app!.evaluate(
          ({ webContents }, url) =>
            webContents
              .getAllWebContents()
              .some((w) => w.getURL() === url && w.isFocused()),
          url,
        ),
      )
      .toBe(true);
    const split = app.page.getByRole("button", {
      name: "Toggle split view",
      exact: true,
    });
    if ((await split.getAttribute("aria-pressed")) !== "true")
      await app.cli("group", "toggle-split", "--workspace", workspace);
    await expect(split).toHaveAttribute("aria-pressed", "true");
    await app.app!.evaluate(({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((w) => w.getURL() === url)!;
      const modifiers: Array<"meta" | "control"> = [
        process.platform === "darwin" ? "meta" : "control",
      ];
      contents.sendInputEvent({ type: "keyDown", keyCode: "J", modifiers });
      contents.sendInputEvent({ type: "keyUp", keyCode: "J", modifiers });
    }, url);
    await expect(app.pane(browser.paneId)).toBeHidden();
    await expect(
      app
        .pane(first.paneId)
        .getByRole("textbox", { name: "Message", exact: true }),
    ).toBeFocused();
    const restoredComposer = app
      .pane(first.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
    await expect(restoredComposer).toHaveValue("Keep left chat draft");
    await expect
      .poll(() => app.page.evaluate(() => document.hasFocus()))
      .toBe(true);
    await app.page.keyboard.type(" after native hide");
    await expect(restoredComposer).toHaveValue(
      "Keep left chat draft after native hide",
    );
    await app.page.keyboard.press("Alt+2");
    await expect(app.pane(browser.paneId)).toBeVisible();
    await expect
      .poll(() =>
        app.app!.evaluate(
          ({ webContents }, url) =>
            webContents
              .getAllWebContents()
              .some((w) => w.getURL() === url && w.isFocused()),
          url,
        ),
      )
      .toBe(true);
    const nativeKey = async (keyCode: string, alt: boolean) =>
      app.app!.evaluate(
        ({ webContents }, { url, keyCode, alt }) => {
          const contents = webContents
            .getAllWebContents()
            .find((w) => w.getURL() === url)!;
          const modifiers: Array<"meta" | "control" | "alt"> = alt
            ? ["alt"]
            : [process.platform === "darwin" ? "meta" : "control"];
          contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
          contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
        },
        { url, keyCode, alt },
      );
    await nativeKey("1", true);
    await expect(
      app
        .pane(first.paneId)
        .getByRole("textbox", { name: "Message", exact: true }),
    ).toBeFocused();
    await app.page.keyboard.press("Alt+2");
    await expect
      .poll(() =>
        app.app!.evaluate(
          ({ webContents }, url) =>
            webContents
              .getAllWebContents()
              .some((w) => w.getURL() === url && w.isFocused()),
          url,
        ),
      )
      .toBe(true);
    await nativeKey("Enter", true);
    await expect(app.pane(first.paneId)).toBeVisible();
    await nativeKey("E", false);
    await expect(app.pane(first.paneId)).toBeHidden();
    await expect(app.pane(browser.paneId)).toBeVisible();
    await nativeKey("1", true);
    await expect(
      app
        .pane(first.paneId)
        .getByRole("textbox", { name: "Message", exact: true }),
    ).toBeFocused();
    expect(await app.prompts()).toHaveLength(0);
  } finally {
    await app.cleanup();
  }
});

for (const replacement of ["none", "keyboard", "native"] as const) {
  const cancelled = replacement !== "none";
  test(`A hidden chat ${cancelled ? `does not steal focus after newer ${replacement} navigation` : "regains native keyboard focus when its selection snapshot follows the operation reply"}`, async () => {
    const app = new ChatApp();
    await app.prepare();
    await app.configure({ codex: {} });
    await mkdir(app.data, { recursive: true });
    await writeFile(
      path.join(app.data, "keymap.json"),
      JSON.stringify({
        "pane.focusLeft": ["Alt+1"],
        "pane.focusRight": ["Alt+2"],
      }),
    );
    try {
      await app.start();
      const workspace = await app.create("Delayed pane selection");
      const chat = await app.newChat(workspace, "codex");
      await app.newChat(workspace, "codex");
      const file = path.join(app.folders[0], "delayed-pane.html");
      await writeFile(
        file,
        "<title>Delayed native fixture</title><h1>Native page</h1>",
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
      const initial = (await app.cli<AppState>("state")).workspaces.find(
        (w) => w.id === workspace,
      )!;
      const left = initial.groups!.find((g) =>
        g.paneIds.includes(browser.paneId),
      )!;
      const right = initial.groups!.find((g) =>
        g.paneIds.includes(chat.paneId),
      )!;
      await app.cli(
        "pane",
        "move",
        "--workspace",
        workspace,
        "--id",
        chat.paneId,
        "--group",
        left.id,
      );
      await app.cli(
        "pane",
        "move",
        "--workspace",
        workspace,
        "--id",
        browser.paneId,
        "--group",
        right.id,
      );
      await app.cli(
        "group",
        "visibility",
        "--workspace",
        workspace,
        "--id",
        (await app.cli<AppState>("state")).workspaces
          .find((w) => w.id === workspace)!
          .groups!.find((g) => g.paneIds.includes(chat.paneId))!.id,
        "--hidden",
        "true",
      );
      await expect(app.pane(chat.paneId)).toBeHidden();
      await app.app!.evaluate(
        ({ BrowserWindow, ipcMain }, { workspace, pane }) => {
          const contents = BrowserWindow.getAllWindows()[0].webContents;
          const send = contents.send.bind(contents);
          let pending: unknown[] | undefined;
          let holding = true;
          let capturing = false;
          Object.assign(globalThis, {
            releasePaneSelection: () => {
              holding = false;
              if (pending) send("cod:state", ...pending);
            },
            paneSelectionAccepted: false,
            replacementSelectionAccepted: false,
          });
          contents.send = function (channel, ...args) {
            const state = args[0];
            if (channel === "cod:state")
              Object.assign(globalThis, {
                latestSelectedPane: state.workspaces.find(
                  (w: any) => w.id === workspace,
                )?.activePaneId,
              });
            if (
              channel === "cod:state" &&
              holding &&
              (capturing ||
                state?.workspaces?.find((w: any) => w.id === workspace)
                  ?.activePaneId === pane)
            ) {
              capturing = true;
              pending = args;
              return;
            }
            send(channel, ...args);
          };
          const handlers = (
            ipcMain as unknown as {
              _invokeHandlers: Map<string, (...args: any[]) => unknown>;
            }
          )._invokeHandlers;
          const original = handlers.get("cod:invoke")!;
          ipcMain.removeHandler("cod:invoke");
          ipcMain.handle("cod:invoke", async (event, request) => {
            const result = await original(event, request);
            if (request.op === "pane.focus" && request.id === pane)
              Object.assign(globalThis, { paneSelectionAccepted: true });
            if (request.op === "pane.focus" && request.id !== pane)
              Object.assign(globalThis, { replacementSelectionAccepted: true });
            return result;
          });
        },
        { workspace, pane: chat.paneId },
      );
      await app.app!.evaluate(({ webContents }, url) => {
        const contents = webContents
          .getAllWebContents()
          .find((c) => c.getURL() === url)!;
        contents.focus();
        contents.sendInputEvent({
          type: "keyDown",
          keyCode: "1",
          modifiers: ["alt"],
        });
        contents.sendInputEvent({
          type: "keyUp",
          keyCode: "1",
          modifiers: ["alt"],
        });
      }, url);
      await expect
        .poll(() =>
          app.app!.evaluate(() => (globalThis as any).paneSelectionAccepted),
        )
        .toBe(true);
      await app.page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      if (replacement === "keyboard") {
        await app.page.keyboard.press("Alt+2");
        await expect
          .poll(() =>
            app.app!.evaluate(
              () => (globalThis as any).replacementSelectionAccepted,
            ),
          )
          .toBe(true);
      } else if (replacement === "native") {
        await app.app!.evaluate(({ webContents }, url) => {
          const contents = webContents
            .getAllWebContents()
            .find((c) => c.getURL() === url)!;
          contents.focus();
          contents.sendInputEvent({
            type: "mouseDown",
            x: 30,
            y: 35,
            button: "left",
            clickCount: 1,
          });
          contents.sendInputEvent({
            type: "mouseUp",
            x: 30,
            y: 35,
            button: "left",
            clickCount: 1,
          });
        }, url);
        await expect
          .poll(() =>
            app.app!.evaluate(() => (globalThis as any).latestSelectedPane),
          )
          .toBe(browser.paneId);
      }
      await app.app!.evaluate(() => (globalThis as any).releasePaneSelection());
      const input = app
        .pane(chat.paneId)
        .getByRole("textbox", { name: "Message", exact: true });
      if (cancelled) {
        await expect(input).toBeHidden();
        await expect
          .poll(() =>
            app.app!.evaluate(
              ({ webContents }, url) =>
                webContents
                  .getAllWebContents()
                  .some((c) => c.getURL() === url && c.isFocused()),
              url,
            ),
          )
          .toBe(true);
      } else {
        await expect(input).toBeFocused();
        await app.page.keyboard.type("Retained keyboard input");
        await expect(input).toHaveValue("Retained keyboard input");
      }
      expect(await app.prompts()).toHaveLength(0);
    } finally {
      await app.cleanup();
    }
  });
}

test("Revealing a parked native page keeps the outgoing chat visible until the page presents", async () => {
  const app = new ChatApp();
  await prepareKeyboardProfile(app);
  try {
    await app.start();
    const workspace = await app.create("Export notes");
    const chat = await app.newChat(workspace, "codex");
    const { groupId: right, paneId: placeholder } = await app.cli<{
      groupId: string;
      paneId: string;
    }>("group", "ensure", "--workspace", workspace, "--side", "right");
    const file = path.join(app.folders[0], "export-preview.html");
    await writeFile(file, "<!doctype html><title>Export preview</title>");
    const url = pathToFileURL(file).href;
    const browser = await app.cli<{ id: string; paneId: string }>(
      "browser",
      "open",
      "--workspace",
      workspace,
      "--group",
      right,
      "--source-pane",
      placeholder,
      "--focus",
      "true",
      "--url",
      url,
    );
    await expect
      .poll(async () => {
        const state = await app.cli<AppState>("state");
        const record = state.browsers.find((item) => item.id === browser.id);
        return (
          record && !record.loading && record.visible && record.url === url
        );
      })
      .toBe(true);
    await app.cli(
      "pane",
      "focus",
      "--workspace",
      workspace,
      "--id",
      chat.paneId,
    );
    await app.cli("group", "toggle-split", "--workspace", workspace);
    await expect
      .poll(
        async () =>
          (await app.cli<AppState>("state")).browsers.find(
            (item) => item.id === browser.id,
          )?.visible,
      )
      .toBe(false);
    await app.app!.evaluate(({ BrowserWindow }, pageUrl) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
        (child) =>
          "webContents" in child &&
          (child.webContents as Electron.WebContents).getURL() === pageUrl,
      ) as Electron.WebContentsView;
      const setVisible = view.setVisible.bind(view);
      // Hold the native layer after shell navigation, as an asynchronous
      // presentation would, until the fixture lets the window compose it.
      view.setVisible = (visible) => {
        if (!visible) setVisible(false);
      };
      Object.assign(globalThis, {
        releaseNativePresentation: () => {
          view.setVisible = setVisible;
          setVisible(true);
        },
      });
    }, url);
    const composer = app.pane(chat.paneId).getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.fill("Keep the export notes draft.");
    await composer.press("Alt+Tab");
    const selectedBrowser = app.page.locator(
      `.tab-select[data-tab-id="${browser.paneId}"]`,
    );
    const fallback = app
      .pane(browser.paneId)
      .locator(".browser-reveal-previous");
    await expect(selectedBrowser).toHaveAttribute("aria-selected", "true");
    await expect(fallback.locator("textarea")).toHaveValue(
      "Keep the export notes draft.",
    );
    await expect(fallback).toHaveAttribute("aria-hidden", "true");
    await expect(fallback).toHaveJSProperty("inert", true);
    await app.app!.evaluate(() =>
      (globalThis as { releaseNativePresentation?: () => void })
        .releaseNativePresentation!(),
    );
    await expect(fallback).toHaveCount(0);
    await app.page.keyboard.press("Alt+Tab");
    await expect(composer).toHaveValue("Keep the export notes draft.");
    await expect(composer).toBeFocused();
  } finally {
    await app.cleanup();
  }
});

test("Pane cycling keeps the visibility icon stable and reaches a parked editor, terminal and native page", async ({}, info) => {
  const app = new ChatApp();
  await prepareKeyboardProfile(app);
  Object.assign(app.environment, {
    COD_TERMINAL_SHELL: "/bin/bash",
    COD_TERMINAL_ARGS: JSON.stringify(["--noprofile", "--norc", "-i"]),
    HISTFILE: "/dev/null",
  });
  try {
    await app.start();
    const workspace = await app.create("Release notes");
    const leftGroup = (await app.workspace(workspace)).groups[0];
    const left = leftGroup.id;
    const openFile = async (name: string, body: string) => {
      const file = path.join(app.folders[0], name);
      await writeFile(file, body);
      return app.cli<{ paneId: string }>(
        "file",
        "open",
        "--workspace",
        workspace,
        "--group",
        left,
        "--source-pane",
        leftGroup.activePaneId,
        "--focus",
        "true",
        "--path",
        file,
      );
    };
    await openFile("notes.txt", "Test the tab controls.");
    const file = await openFile(
      "release-notes.txt",
      "Verify the export examples.",
    );
    const editor = app
      .pane(file.paneId)
      .getByRole("textbox", { name: "File contents", exact: true });
    const split = app.page.getByRole("button", {
      name: "Toggle split view",
      exact: true,
    });
    const tab = (paneId: string) =>
      app.page.locator(`.tab-select[data-tab-id="${paneId}"]`);
    const caption = (paneId: string) => tab(paneId).locator(".tab-label");
    const bright = "rgb(220, 224, 229)";
    const muted = "rgb(169, 175, 188)";
    await editor.fill("Keep the unsaved release notes.");
    await editor.press("End");
    await editor.press("Alt+Tab");
    await expect(editor).toBeFocused();
    await expect(split).toHaveAccessibleDescription("No split");
    expect((await app.workspace(workspace)).groups).toHaveLength(1);

    await split.click();
    await expect(split).toHaveAccessibleDescription("Both panes visible");
    const rightGroup = (await app.workspace(workspace)).groups.find(
      (group) => group.id !== left,
    )!;
    const right = rightGroup.id;
    const html = path.join(app.folders[0], "export-preview.html");
    await writeFile(
      html,
      '<!doctype html><title>Export preview</title><input id="entry" value="Keep native selection" autofocus>',
    );
    const url = pathToFileURL(html).href;
    const browser = await app.cli<{ paneId: string }>(
      "browser",
      "open",
      "--workspace",
      workspace,
      "--group",
      right,
      "--source-pane",
      rightGroup.activePaneId,
      "--focus",
      "true",
      "--url",
      url,
    );
    const shell = await app.cli<{ id: string; paneId: string }>(
      "terminal",
      "open",
      "--workspace",
      workspace,
      "--group",
      right,
      "--source-pane",
      browser.paneId,
      "--focus",
      "true",
      "--cwd",
      app.folders[0],
    );
    const terminal = app
      .pane(shell.paneId)
      .getByRole("textbox", { name: "Terminal input", exact: true });
    const region = (id: string) =>
      app.page.locator(`.tab-group[data-group-id="${id}"]`);
    const svg = split.locator("svg");
    const glyph = await svg.evaluate((element) => element.outerHTML);
    // A mouse selection changes the caption, not the layout drawing or either selected tab.
    await tab(file.paneId).click();
    await expect(caption(file.paneId)).toHaveCSS("color", bright);
    await expect(caption(shell.paneId)).toHaveCSS("color", muted);
    await expect(region(left)).toHaveAccessibleDescription("Active pane");
    await expect(region(right)).toHaveAccessibleDescription("Other pane");
    await expect(tab(file.paneId)).toHaveAttribute("aria-selected", "true");
    await expect(tab(shell.paneId)).toHaveAttribute("aria-selected", "true");
    const tabChrome = (paneId: string) =>
      tab(paneId).evaluate((button) => {
        const tab = getComputedStyle(button.parentElement!);
        const body = getComputedStyle(button.closest(".tab-group")!);
        return {
          background: tab.backgroundColor,
          edge: tab.borderBottomColor,
          opacity: body.opacity,
          filter: body.filter,
        };
      });
    const leftChrome = await tabChrome(file.paneId);
    const rightChrome = await tabChrome(shell.paneId);
    await app.page.screenshot({
      path: info.outputPath("split-visibility-left-focused.png"),
    });

    await editor.press("Alt+Tab");
    await expect(terminal).toBeFocused();
    await expect(caption(file.paneId)).toHaveCSS("color", muted);
    await expect(caption(shell.paneId)).toHaveCSS("color", bright);
    await expect(region(right)).toHaveAccessibleDescription("Active pane");
    await expect(region(left)).toHaveAccessibleDescription("Other pane");
    await expect(split).toHaveAccessibleDescription("Both panes visible");
    expect(await svg.evaluate((element) => element.outerHTML)).toBe(glyph);
    expect(await tabChrome(file.paneId)).toEqual(leftChrome);
    expect(await tabChrome(shell.paneId)).toEqual(rightChrome);
    await app.page.keyboard.type("printf 'Invented terminal result\\n'");
    await app.page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          (
            await app.cli<{ output: string }>(
              "terminal",
              "inspect",
              "--id",
              shell.id,
            )
          ).output,
      )
      .toContain("Invented terminal result");
    await app.app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(760, 680),
    );
    await expect.poll(() => app.page.evaluate(() => innerWidth)).toBe(760);
    await app.page.screenshot({
      path: info.outputPath("split-visibility-right-focused-narrow.png"),
    });
    await app.app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
    );
    await expect.poll(() => app.page.evaluate(() => innerWidth)).toBe(1280);

    await terminal.press("Alt+Enter");
    await expect(split).toHaveAccessibleDescription("Only right pane visible");
    await terminal.press("Alt+Shift+Tab");
    await expect(split).toHaveAccessibleDescription("Only left pane visible");
    await expect(terminal).toBeHidden();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("Keep the unsaved release notes.");
    await editor.press("Alt+Tab");
    await expect(split).toHaveAccessibleDescription("Only right pane visible");
    await expect(terminal).toBeFocused();
    await expect(editor).toBeHidden();

    await tab(browser.paneId).click();
    await app.page.keyboard.press("Alt+2");
    const inspectBrowser = (targetUrl = url) =>
      app.app!.evaluate(async ({ webContents }, url) => {
        const contents = webContents
          .getAllWebContents()
          .find((candidate) => candidate.getURL() === url);
        if (!contents) return null;
        return {
          focused: contents.isFocused(),
          ...(await contents.executeJavaScript(
            "({id:document.activeElement.id,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd})",
          )),
        };
      }, targetUrl);
    await expect.poll(async () => (await inspectBrowser())?.focused).toBe(true);
    await app.app!.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL() === url)!;
      await contents.executeJavaScript(
        'document.querySelector("input").focus(); document.activeElement.setSelectionRange(5, 11)',
      );
    }, url);
    const nativePress = async (
      keyCode: string,
      modifiers: Array<"alt" | "shift" | "isautorepeat">,
      targetUrl = url,
    ) =>
      app.app!.evaluate(
        ({ webContents }, values) => {
          const contents = webContents
            .getAllWebContents()
            .find((candidate) => candidate.getURL() === values.url)!;
          contents.sendInputEvent({
            type: "keyDown",
            keyCode: values.keyCode,
            modifiers: values.modifiers,
          });
          contents.sendInputEvent({
            type: "keyUp",
            keyCode: values.keyCode,
            modifiers: values.modifiers,
          });
        },
        { url: targetUrl, keyCode, modifiers },
      );
    await nativePress("Enter", ["alt"]);
    await expect(split).toHaveAccessibleDescription("Both panes visible");
    await nativePress("Tab", ["alt", "isautorepeat"]);
    await expect(editor).toBeFocused();
    await expect
      .poll(() => app.page.evaluate(() => document.hasFocus()))
      .toBe(true);
    await expect(split).toHaveAccessibleDescription("Both panes visible");
    await editor.press("Alt+Shift+Tab");
    await expect
      .poll(inspectBrowser)
      .toMatchObject({ focused: true, id: "entry", start: 5, end: 11 });
    expect(await svg.evaluate((element) => element.outerHTML)).toBe(glyph);

    await nativePress("Enter", ["alt"]);
    await expect(split).toHaveAccessibleDescription("Only right pane visible");
    await nativePress("Tab", ["alt", "shift", "isautorepeat"]);
    await expect(split).toHaveAccessibleDescription("Only left pane visible");
    await expect(editor).toBeFocused();
    await expect
      .poll(() => app.page.evaluate(() => document.hasFocus()))
      .toBe(true);
    await editor.press("Alt+Tab");
    await expect(split).toHaveAccessibleDescription("Only right pane visible");
    await expect
      .poll(inspectBrowser)
      .toMatchObject({ focused: true, id: "entry", start: 5, end: 11 });
    expect(
      (await app.workspace(workspace)).groups.find(
        (group) => group.id === right,
      )?.paneIds,
    ).toEqual([browser.paneId, shell.paneId]);

    const standalone = await app.create("Standalone preview");
    const origin = await app.workspace(standalone);
    const standaloneUrl = url + "#standalone";
    await app.cli(
      "browser",
      "open",
      "--workspace",
      standalone,
      "--source-pane",
      origin.activePaneId,
      "--focus",
      "true",
      "--url",
      standaloneUrl,
    );
    await expect(split).toHaveAccessibleDescription("No split");
    await app.page.keyboard.press("Alt+1");
    const inspectStandalone = () => inspectBrowser(standaloneUrl);
    await expect
      .poll(inspectStandalone)
      .toMatchObject({ focused: true, id: "entry" });
    const beforeCycle = await inspectStandalone();
    await nativePress("Tab", ["alt"], standaloneUrl);
    await nativePress("Tab", ["alt", "shift"], standaloneUrl);
    expect(await inspectStandalone()).toEqual(beforeCycle);
    expect((await app.workspace(standalone)).groups).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});
