import { test, expect, type Locator, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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
      "pane.splitDown": ["Alt+Shift+N"],
      "focus.composer": ["Alt+J"],
      "focus.terminal": ["Mod+Backquote"],
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [
          `pane.focus${i + 1}`,
          [`Alt+${i + 1}`],
        ]),
      ),
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
  const { breakpointId } = await session.send("Debugger.setBreakpoint", {
    location: { scriptId: renderer.scriptId, lineNumber },
  });
  session.on("Debugger.paused", async (event) => {
    try {
      if (event.hitBreakpoints?.includes(breakpointId)) {
        const value = await session.send("Debugger.evaluateOnCallFrame", {
          callFrameId: event.callFrames[0].callFrameId,
          expression: "op",
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
    await app.page.keyboard.press("Escape");
    await expect(preview).toBeFocused();
    await reach(
      app.page,
      app.page.getByRole("button", { name: "Remove image", exact: true }),
    );
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
    const allow = app.page.getByRole("button", {
      name: "Allow once",
      exact: true,
    });
    await expect(allow).toBeVisible();
    expect(
      invocations.operations.filter((op) => op === "conversation.send"),
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
    await expect(composer()).toBeFocused();
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
        `<!doctype html><title>Invented keyboard page</title><label>First<input id="first" autofocus value="first field"></label><label>Second<input id="second" value="second field"></label><p>Closing marker</p><script>window.keys=[];document.addEventListener('keydown',e=>{window.keys.push({key:e.key,ctrl:e.ctrlKey,meta:e.metaKey,shift:e.shiftKey});if((e.ctrlKey||e.metaKey)&&['b','p','f'].includes(e.key.toLowerCase()))e.preventDefault()});</script>`,
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
    // Numbered pane focus is independent of tab selection.
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
    const selected = await inspect();
    expect(selected.field).toBe("second");
    expect(selected.start).toBe(1);
    expect(selected.end).toBe(2);
    const mod = process.platform === "darwin" ? "meta" : "control";
    for (const letter of ["B", "P"]) await key(letter, [mod]);
    const observed = await inspect();
    for (const letter of ["b", "p"])
      expect(
        observed.keys.filter(
          (item: { key: string }) => item.key.toLowerCase() === letter,
        ),
      ).toHaveLength(1);
    await expect(app.page.getByRole("dialog")).toHaveCount(0);
    await key("P", [mod, "shift"]);
    await expect(
      app.page.getByRole("dialog", { name: "Command palette" }),
    ).toBeVisible();
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
    await key("J", ["alt"]);
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeFocused();
    await app.page.keyboard.press("Alt+J");
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
    await expect
      .poll(
        async () =>
          (await state(app)).workspaces.find((w) => w.id === workspace)!.groups!
            .length,
      )
      .toBe(3);
    const splitState = (await state(app)).workspaces.find(
      (w) => w.id === workspace,
    )!;
    const originalGroup = splitState.groups!.find((g) =>
      g.paneIds.includes(original.id),
    )!;
    expect(originalGroup.paneIds).not.toContain(second.paneId);
    expect(
      splitState.groups!.find((g) => g.paneIds.includes(chatPane.id))!.paneIds,
    ).toEqual([chatPane.id]);
    expect(splitState.panes.filter((p) => p.id === original.id)).toHaveLength(
      1,
    );
    await app.cli(
      "pane",
      "focus",
      "--workspace",
      workspace,
      "--id",
      chatPane.id,
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
        .panes.some((pane) => pane.id === chatPane.id),
    ).toBe(true);
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
    const workspace = (await state(app)).activeWorkspaceId!;
    const terminal = await app.cli<{ id: string; paneId: string }>(
      "terminal",
      "open",
      "--workspace",
      workspace,
      "--cwd",
      app.folders[0],
    );
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
    await app.page.keyboard.press("Escape");
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
    await app.page.keyboard.press(`${modifier}+Shift+W`);
    await expect(input).not.toBeFocused();
    await app.page.keyboard.press(`${modifier}+Shift+W`);
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
    for (const shortcut of [`${modifier}+Shift+E`, `${modifier}+Shift+W`]) {
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
    const chatsBeforeFocus = (await state(app)).workspaces.find(
      (w) => w.id === workspace,
    )!.panes.length;
    await app.page.keyboard.press("Alt+J");
    await expect(
      app.page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeFocused();
    await app.page.keyboard.press("Alt+J");
    await expect(editor()).toBeFocused();
    expect(
      (await state(app)).workspaces.find((w) => w.id === workspace)!.panes,
    ).toHaveLength(chatsBeforeFocus);
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
    await command(app.page, "Split below");
    await expect
      .poll(
        async () =>
          (await state(app)).workspaces.find((item) => item.id === workspace)!
            .groups!.length,
      )
      .toBe(3);
    const splitBefore = JSON.stringify(
      (await state(app)).workspaces.find((item) => item.id === workspace)!
        .groupLayout,
    );
    const divider = app.page
      .getByRole("separator", { name: "Resize panes", exact: true })
      .last();
    await reach(app.page, divider);
    await app.page.keyboard.press("ArrowDown");
    await expect
      .poll(async () =>
        JSON.stringify(
          (await state(app)).workspaces.find((item) => item.id === workspace)!
            .groupLayout,
        ),
      )
      .not.toBe(splitBefore);
    await expect(divider).toBeFocused();
    // Traversing to the separator may activate a neighboring pane; choose the tab to move.
    await reach(
      app.page,
      app.pane(last).getByRole("textbox", { name: "Message", exact: true }),
    );
    await command(app.page, "Move tab to another pane");
    await expect(
      app.page.getByRole("dialog", { name: "Actions" }),
    ).toBeVisible();
    await app.page.keyboard.press("End");
    await app.page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          (await state(app)).workspaces.find((item) => item.id === workspace)!
            .groups!.length,
      )
      .toBe(2);
    expect(
      (await state(app)).workspaces
        .find((item) => item.id === workspace)!
        .panes.filter((pane) => pane.id === last),
    ).toHaveLength(1);
    await command(app.page, "Move tab left");
    await command(app.page, "Toggle material area");
    await expect(editor()).toHaveCount(0);
    await command(app.page, "Toggle material area");
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
    const workspace = (await state(app)).activeWorkspaceId!;
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
    const first = app.pane(review.paneId).locator(".review-line").first();
    await reach(app.page, first);
    await app.page.keyboard.press("Shift+ArrowDown");
    await app.page.keyboard.press(`${modifier}+Shift+M`);
    const comment = app
      .pane(review.paneId)
      .getByRole("textbox", { name: "Comment", exact: true });
    await expect(comment).toBeFocused();
    await app.page.keyboard.type("Clarify these first two lines.");
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
      app.pane(review.paneId).locator('.review-line[aria-pressed="true"]'),
    ).toHaveCount(2);
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
