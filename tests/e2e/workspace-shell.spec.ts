import { test, expect, _electron } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { chmod, lstat, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkspaceApp, modifier, tabTo } from "./helpers/workspace-app";

let shell: WorkspaceApp;
test.beforeEach(async () => {
  shell = new WorkspaceApp();
  await shell.prepare();
  await shell.start();
});
test.afterEach(async () => {
  await shell?.cleanup();
});

async function createFromUI(name: string) {
  await shell.command("New workspace");
  await expect(shell.page.getByRole("dialog")).toHaveCount(0);
  await expect(
    shell.page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeFocused();
  await shell.command("Rename workspace");
  await expect(shell.page.getByRole("dialog")).toHaveCount(0);
  const rename = shell.page.getByRole("textbox", {
    name: "Workspace name",
    exact: true,
  });
  await rename.fill(name);
  await rename.press("Enter");
  await expect(shell.row(name)).toBeVisible();
  await expect(
    shell.page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeFocused();
  const workspace = (await shell.state()).workspaces.find(
    (item) => item.name === name,
  );
  expect(workspace).toBeDefined();
  return workspace!.id;
}

async function assertActive(workspaceId: string, paneId?: string) {
  await expect
    .poll(async () => (await shell.state()).activeWorkspaceId)
    .toBe(workspaceId);
  if (paneId) {
    await expect
      .poll(async () => (await shell.workspace(workspaceId)).activePaneId)
      .toBe(paneId);
    await expect(shell.pane(paneId)).toHaveAttribute("data-active", "true");
  }
}

test("AC1 creates and renames through UI, tracks two repositories, and switches workspaces", async () => {
  const first = await createFromUI("Draft task");
  const controls = (await shell.page
    .locator("#visibility-controls")
    .boundingBox())!;
  const sidebar = (await shell.page.locator(".sidebar").boundingBox())!;
  expect(
    Math.abs(controls.x + controls.width - (sidebar.x + sidebar.width - 8)),
  ).toBeLessThan(2);
  expect((await shell.workspace(first)).folders).toEqual([]);
  expect((await shell.workspace(first)).panes).toHaveLength(1);
  await shell.command("Rename workspace");
  await expect(shell.page.getByRole("dialog")).toHaveCount(0);
  const rename = shell.page.getByRole("textbox", {
    name: "Workspace name",
    exact: true,
  });
  await rename.fill("Specification task");
  await rename.press("Enter");
  await expect(shell.row("Specification task")).toBeVisible();
  await expect(shell.row("Draft task")).toHaveCount(0);
  for (const folder of shell.folders)
    await shell.cli("workspace", "add-folder", "--id", first, "--path", folder);
  const workspace = await shell.workspace(first);
  expect(workspace.folders).toHaveLength(2);
  for (const folder of shell.folders)
    expect(JSON.stringify(workspace.folders)).toContain(folder);
  const second = await createFromUI("Second task");
  await assertActive(second);
  await shell.row("Specification task").click();
  await assertActive(first);
  await shell.cli("workspace", "focus", "--id", second);
  await assertActive(second);
  await shell.row("Specification task").click();
  await assertActive(first);
});

test("AC2 navigates the panel and opens/dismisses the palette entirely by keyboard", async () => {
  const first = await shell.create("Alpha keyboard");
  const second = await shell.create("Beta keyboard");
  await shell.cli("workspace", "focus", "--id", first);
  await shell.page.keyboard.press(`${modifier}+Shift+W`);
  await expect(shell.row("Alpha keyboard")).toBeFocused();
  await shell.page.keyboard.press("ArrowDown");
  await expect(shell.row("Beta keyboard")).toBeFocused();
  await shell.page.keyboard.press("Enter");
  await assertActive(second);
  await shell.page.keyboard.press(`${modifier}+Shift+W`);
  await shell.page.keyboard.press("ArrowUp");
  await expect(shell.row("Alpha keyboard")).toBeFocused();
  await shell.page.keyboard.press("Enter");
  await assertActive(first);
  const before = await shell.state();
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  const palette = shell.page.getByRole("dialog");
  await expect(palette).toBeVisible();
  await expect(palette).toHaveAccessibleName(/command/i);
  await expect(palette.getByRole("textbox")).toBeFocused();
  await shell.page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  expect(await shell.state()).toEqual(before);
});

test("AC3 edits and saves a real file, retains unsaved text across switching, and protects external edits", async () => {
  const first = await shell.create("Documentation");
  const opened = await shell.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    first,
    "--path",
    shell.file,
  );
  const editor = shell
    .pane(opened.paneId)
    .getByRole("textbox", { name: "File contents", exact: true });
  await expect(editor).toHaveValue(await shell.contents());
  const draft = "# Invented specification\n\nUnsaved local draft.\n";
  await editor.fill(draft);
  const second = await shell.create("Other task");
  await assertActive(second);
  await shell.cli("workspace", "focus", "--id", first);
  await expect(editor).toHaveValue(draft);
  await editor.press(`${modifier}+s`);
  await expect.poll(() => shell.contents()).toBe(draft);
  const local = "# Local change retained\n";
  const external = "# External change retained\n";
  await editor.fill(local);
  await writeFile(shell.file, external);
  await editor.press(`${modifier}+s`);
  // A conflict must preserve both copies, not silently replace disk or the editor.
  await expect(editor).toHaveValue(local);
  expect(await shell.contents()).toBe(external);
  await expect(
    shell.page
      .getByText(/conflict|changed (on disk|externally)|external change/i)
      .first(),
  ).toBeVisible();
});

test("AC4 shares pane operations, supports keyboard controls, and rejects invalid targets atomically", async () => {
  const workspaceId = await shell.create("Pane operations");
  const initial = (await shell.workspace(workspaceId)).activePaneId;
  const split = await shell.cli<{ paneId: string }>(
    "pane",
    "split",
    "--workspace",
    workspaceId,
    "--id",
    initial,
    "--direction",
    "right",
  );
  await expect(shell.page.getByTestId("pane")).toHaveCount(2);
  await shell.cli("pane", "focus", "--workspace", workspaceId, "--id", initial);
  await assertActive(workspaceId, initial);
  const beforeResize = (await shell.workspace(workspaceId)).layout;
  await shell.cli(
    "pane",
    "resize",
    "--workspace",
    workspaceId,
    "--id",
    split.paneId,
    "--ratio",
    "0.65",
  );
  expect((await shell.workspace(workspaceId)).layout).not.toEqual(beforeResize);
  const boxes = await Promise.all([
    shell.pane(initial).boundingBox(),
    shell.pane(split.paneId).boundingBox(),
  ]);
  expect(boxes.every(Boolean)).toBe(true);
  expect(Math.abs(boxes[0]!.width - boxes[1]!.width)).toBeGreaterThan(20);
  const beforeInvalid = await shell.state();
  for (const args of [
    ["pane", "focus", "--workspace", workspaceId, "--id", "missing-pane"],
    [
      "pane",
      "resize",
      "--workspace",
      workspaceId,
      "--id",
      initial,
      "--ratio",
      "1.5",
    ],
    [
      "pane",
      "resize",
      "--workspace",
      workspaceId,
      "--id",
      initial,
      "--ratio",
      "NaN",
    ],
    [
      "pane",
      "split",
      "--workspace",
      workspaceId,
      "--id",
      initial,
      "--direction",
      "diagonal",
    ],
  ]) {
    expect((await shell.raw(...args)).code).not.toBe(0);
    expect(await shell.state()).toEqual(beforeInvalid);
  }
  await shell.cli(
    "pane",
    "close",
    "--workspace",
    workspaceId,
    "--id",
    split.paneId,
  );
  await expect(shell.page.getByTestId("pane")).toHaveCount(1);
  await shell.command("Split below");
  await expect(shell.page.getByTestId("pane")).toHaveCount(2);
  const workspace = await shell.workspace(workspaceId);
  const newPane = workspace.panes.find((pane) => pane.id !== initial)!.id;
  // Sequential keyboard traversal must focus the containing pane.
  await tabTo(
    shell.page,
    shell.pane(initial).getByRole("textbox", { name: "Message", exact: true }),
  );
  await assertActive(workspaceId, initial);
  await tabTo(
    shell.page,
    shell.pane(newPane).getByRole("textbox", { name: "Message", exact: true }),
  );
  await assertActive(workspaceId, newPane);
  await shell.page.keyboard.press(`${modifier}+W`);
  await expect(shell.page.getByTestId("pane")).toHaveCount(1);
  const unsplit = await shell.state();
  expect(
    (
      await shell.raw(
        "pane",
        "resize",
        "--workspace",
        workspaceId,
        "--id",
        initial,
        "--ratio",
        "0.5",
      )
    ).code,
  ).not.toBe(0);
  expect(await shell.state()).toEqual(unsplit);
});

test("AC5 restores folders, file references, split layout and selection in a fresh process", async ({}, testInfo) => {
  const first = await shell.create("Restored documentation");
  for (const folder of shell.folders)
    await shell.cli("workspace", "add-folder", "--id", first, "--path", folder);
  const opened = await shell.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    first,
    "--path",
    shell.file,
  );
  await shell.cli(
    "pane",
    "split",
    "--workspace",
    first,
    "--id",
    opened.paneId,
    "--direction",
    "right",
  );
  await shell.cli(
    "pane",
    "resize",
    "--workspace",
    first,
    "--id",
    opened.paneId,
    "--ratio",
    "0.35",
  );
  await shell.create("Restored background");
  await shell.cli("workspace", "focus", "--id", first);
  await shell.cli("pane", "focus", "--workspace", first, "--id", opened.paneId);
  const before = await shell.state();
  expect(JSON.stringify(before)).toContain(shell.file);
  const oldPid = shell.app!.process().pid;
  await shell.stop();
  expect((await shell.raw("state")).code).not.toBe(0);
  await shell.start();
  expect(shell.app!.process().pid).not.toBe(oldPid);
  expect(await shell.state()).toEqual(before);
  await assertActive(first, opened.paneId);
  await expect(
    shell
      .pane(opened.paneId)
      .getByRole("textbox", { name: "File contents", exact: true }),
  ).toHaveValue(await shell.contents());
  // The original empty conversation remains beside the two document groups.
  await expect(shell.page.getByTestId("pane")).toHaveCount(3);
  const viewportHeight = await shell.page.evaluate(() => window.innerHeight);
  const restoredPane = await shell.pane(opened.paneId).boundingBox();
  expect(restoredPane!.height).toBeGreaterThan(viewportHeight * 0.6);
  await shell.page.screenshot({
    path: testInfo.outputPath("workspace-restored.png"),
  });
});

test("AC6 applies explicit background targets without stealing workspace or pane focus", async () => {
  const background = await shell.create("Background task");
  const foreground = await shell.create("Foreground task");
  const paneId = (await shell.workspace(foreground)).activePaneId;
  await shell.cli(
    "workspace",
    "rename",
    "--id",
    background,
    "--name",
    "Renamed background",
  );
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    background,
    "--path",
    shell.folders[1],
  );
  await expect(shell.row("Renamed background")).toBeVisible();
  await assertActive(foreground, paneId);
  expect((await shell.workspace(background)).name).toBe("Renamed background");
  expect((await shell.workspace(foreground)).folders).toEqual([]);
  const before = await shell.state();
  await shell.cli("capabilities");
  expect(await shell.state()).toEqual(before);
});

test("AC7 isolates renderer privileges and rejects commands from arbitrary web content", async () => {
  const workspaceId = await shell.create("Security fixture");
  const before = await shell.state();
  const preferences = await shell.app!.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]
      .webContents as unknown as {
      getLastWebPreferences(): {
        sandbox?: boolean;
        contextIsolation?: boolean;
        nodeIntegration?: boolean;
      };
    };
    const preferences = contents.getLastWebPreferences();
    return {
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
    };
  });
  expect(preferences).toEqual({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  });
  expect(
    await shell.page.evaluate(() => ({
      require: typeof (globalThis as any).require,
      process: typeof (globalThis as any).process,
    })),
  ).toEqual({ require: "undefined", process: "undefined" });
  if (process.platform !== "win32")
    expect((await stat(shell.socket)).mode & 0o077).toBe(0);
  expect((await shell.raw("workspace", "create", "--name", "")).code).not.toBe(
    0,
  );
  expect(
    (await shell.raw("workspace", "focus", "--id", "unknown-workspace")).code,
  ).not.toBe(0);
  expect(await shell.state()).toEqual(before);
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      "<!doctype html><title>Invented untrusted page</title><h1>Untrusted fixture</h1>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP fixture address missing");
  try {
    const result = await shell.app!.evaluate(
      async ({ BrowserWindow }, { url, preload }) => {
        // A real remote-origin renderer with the production preload tests the sender boundary.
        const attacker = new BrowserWindow({
          show: false,
          webPreferences: {
            preload,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        await attacker.loadURL(url);
        const result = await attacker.webContents
          .executeJavaScript(`(async () => {
          window.observedStates = [];
          if (window.cod && typeof window.cod.onState === 'function') window.cod.onState(state => window.observedStates.push(state));
          if (!window.cod || typeof window.cod.invoke !== 'function') return { denied: true, reason: 'bridge absent' };
          try { await window.cod.invoke({ op: 'workspace.create', name: 'Unauthorized workspace' }); return { denied: false }; }
          catch { return { denied: true, reason: 'sender rejected' }; }
        })()`);
        return { ...result, contentsId: attacker.webContents.id };
      },
      {
        url: `http://127.0.0.1:${address.port}`,
        preload: path.join(shell.root, "dist/preload.cjs"),
      },
    );
    expect(result.denied).toBe(true);
    expect(await shell.state()).toEqual(before);
    await shell.cli(
      "workspace",
      "rename",
      "--id",
      workspaceId,
      "--name",
      "Legitimate private-state marker",
    );
    await expect(shell.row("Legitimate private-state marker")).toBeVisible();
    await shell.page.waitForTimeout(300);
    const leaked = await shell.app!.evaluate(
      async ({ webContents }, contentsId) => {
        const contents = webContents.fromId(contentsId);
        if (!contents)
          throw new Error("Attacker renderer disappeared before observation");
        return contents.executeJavaScript("window.observedStates");
      },
      result.contentsId,
    );
    expect(leaked).toEqual([]);
    await shell.app!.evaluate(({ BrowserWindow, webContents }, contentsId) => {
      const contents = webContents.fromId(contentsId);
      if (contents) BrowserWindow.fromWebContents(contents)?.destroy();
    }, result.contentsId);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("S1 concurrent CLI mutations retain every workspace through restart", async () => {
  await expect(
    shell.page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  const initialCount = (await shell.state()).workspaces.length;
  const names = Array.from(
    { length: 8 },
    (_, index) => `Parallel task ${index}`,
  );
  const ids = await Promise.all(names.map((name) => shell.create(name)));
  expect(new Set(ids).size).toBe(names.length);
  await Promise.all(
    ids.map((id, index) =>
      shell.cli(
        "workspace",
        "rename",
        "--id",
        id,
        "--name",
        `Renamed parallel ${index}`,
      ),
    ),
  );
  // Split a UTF-8 code point across socket writes, as real transport delivery can.
  const unicodeName = "Concurrent A🌱B";
  const payload = Buffer.from(
    JSON.stringify({ op: "workspace.create", name: unicodeName }) + "\n",
  );
  const boundary = payload.indexOf(Buffer.from("🌱")) + 1;
  await new Promise<void>((resolve, reject) => {
    const connection = createConnection(shell.socket);
    let response = "";
    connection.setEncoding("utf8");
    connection.setTimeout(5000, () =>
      connection.destroy(new Error("Socket fixture timed out")),
    );
    connection.on("error", reject);
    connection.on("connect", () => {
      connection.write(payload.subarray(0, boundary));
      setTimeout(() => connection.write(payload.subarray(boundary)), 20);
    });
    connection.on("data", (chunk) => {
      response += chunk;
      if (!response.includes("\n")) return;
      try {
        expect(JSON.parse(response).ok).toBe(true);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        connection.destroy();
      }
    });
  });
  const before = await shell.state();
  expect(before.workspaces).toHaveLength(initialCount + names.length + 1);
  expect(
    before.workspaces.some((workspace) => workspace.name === unicodeName),
  ).toBe(true);
  for (const [index, id] of ids.entries())
    expect(
      before.workspaces.find((workspace) => workspace.id === id)?.name,
    ).toBe(`Renamed parallel ${index}`);
  await shell.stop();
  await shell.start();
  expect(await shell.state()).toEqual(before);
});

test("S1 saving an executable symlink preserves the link and target permission mode", async () => {
  test.skip(
    process.platform === "win32",
    "POSIX executable mode is not represented on Windows",
  );
  const script = path.join(shell.folders[0], "invented-script.sh");
  await writeFile(script, "#!/bin/sh\nprintf 'invented fixture\\n'\n");
  await chmod(script, 0o755);
  const link = path.join(shell.folders[0], "linked-script.sh");
  await symlink(script, link);
  const workspace = await shell.create("Executable document");
  const { paneId } = await shell.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    link,
  );
  const editor = shell
    .pane(paneId)
    .getByRole("textbox", { name: "File contents", exact: true });
  await editor.fill("#!/bin/sh\nprintf 'edited invented fixture\\n'\n");
  await editor.press(`${modifier}+s`);
  // Checking actual bytes prevents a no-op save from satisfying the mode assertion.
  await expect
    .poll(async () =>
      (await import("node:fs/promises")).readFile(script, "utf8"),
    )
    .toContain("edited invented fixture");
  expect((await stat(script)).mode & 0o777).toBe(0o755);
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
});

test("S1 recovers persisted state and stale socket after an abrupt app crash", async () => {
  const workspaceId = await shell.create("Crash recovery fixture");
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspaceId,
    "--path",
    shell.folders[0],
  );
  const before = await shell.state();
  const process = shell.app!.process();
  const exited = new Promise<void>((resolve) =>
    process.once("exit", () => resolve()),
  );
  // Kill only this test's spawned main process; never match or terminate other apps.
  expect(process.kill("SIGKILL")).toBe(true);
  await exited;
  shell.app = undefined;
  await shell.start();
  expect(await shell.state()).toEqual(before);
  await expect(shell.row("Crash recovery fixture")).toBeVisible();
});

test("S1 rejects a second controller without unlinking the live instance socket", async () => {
  await shell.create("First controller survives");
  const before = await shell.state();
  // Own the OS process directly: Playwright can dispose its Electron channel
  // before process() is called when startup intentionally exits immediately.
  const second = spawn(
    shell.app!.process().spawnfile,
    [
      path.join(shell.root, "dist/main.cjs"),
      `--user-data-dir=${path.join(shell.temporary, "second-chromium")}`,
    ],
    {
      cwd: shell.root,
      env: {
        ...shell.environment,
        COD_DATA_DIR: path.join(shell.temporary, "second-data"),
      },
      stdio: "ignore",
    },
  );
  let launchError: Error | undefined;
  second.once("error", (error) => {
    launchError = error;
  });
  try {
    await expect
      .poll(
        () => {
          if (launchError) throw launchError;
          return second.exitCode;
        },
        { timeout: 5000 },
      )
      .not.toBeNull();
    expect(await shell.state()).toEqual(before);
    await shell.cli(
      "workspace",
      "rename",
      "--id",
      before.workspaces[0].id,
      "--name",
      "Still controlled by first instance",
    );
    await expect(shell.row("Still controlled by first instance")).toBeVisible();
  } finally {
    if (second.exitCode === null && second.signalCode === null)
      second.kill("SIGTERM");
  }
});

test("S1 missing file stops retrying automatically and recovers in the same pane", async () => {
  const workspace = await shell.create("Recover missing document");
  const { paneId } = await shell.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    shell.file,
  );
  await expect(
    shell
      .pane(paneId)
      .getByRole("textbox", { name: "File contents", exact: true }),
  ).toHaveValue(await shell.contents());
  await shell.stop();
  await rm(shell.file);
  await shell.start();
  await expect(
    shell.pane(paneId).getByText(/file is unavailable/i),
  ).toBeVisible();
  expect(JSON.stringify(await shell.state())).toContain(shell.file);
  const mutations = await shell.page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let count = 0;
        const observer = new MutationObserver((records) => {
          count += records.length;
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(count);
        }, 500);
      }),
  );
  expect(
    mutations,
    "Unavailable file must not trigger an unbounded render/read loop",
  ).toBeLessThanOrEqual(50);
  const restored = "# File restored by an external process\n";
  await writeFile(shell.file, restored);
  await shell
    .pane(paneId)
    .getByRole("button", { name: "Retry loading file", exact: true })
    .click();
  await expect(
    shell
      .pane(paneId)
      .getByRole("textbox", { name: "File contents", exact: true }),
  ).toHaveValue(restored);
  await expect(
    shell.pane(paneId).getByText(/file is unavailable/i),
  ).toHaveCount(0);
});

test("S1 metadata updates preserve editor focus, draft and keyboard selection", async () => {
  const background = await shell.create("Background metadata");
  const workspace = await shell.create("Active metadata");
  const { paneId } = await shell.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    shell.file,
  );
  const editor = shell
    .pane(paneId)
    .getByRole("textbox", { name: "File contents", exact: true });
  await expect(editor).toHaveValue(await shell.contents());
  await editor.fill("123456789");
  for (let index = 0; index < 6; index++) await editor.press("ArrowLeft");
  await editor.press("Shift+ArrowRight");
  await editor.press("Shift+ArrowRight");
  const selection = await editor.evaluate((element) => ({
    start: (element as HTMLTextAreaElement).selectionStart,
    end: (element as HTMLTextAreaElement).selectionEnd,
  }));
  expect(selection).toEqual({ start: 3, end: 5 });
  for (const [id, name] of [
    [workspace, "Active renamed"],
    [background, "Background renamed"],
  ]) {
    await shell.cli("workspace", "rename", "--id", id, "--name", name);
    await expect(shell.row(name)).toBeVisible();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("123456789");
    expect(
      await editor.evaluate((element) => ({
        start: (element as HTMLTextAreaElement).selectionStart,
        end: (element as HTMLTextAreaElement).selectionEnd,
      })),
    ).toEqual(selection);
  }
});

test("Workspace rename stays inline through updates, saves on blur and cancels with Escape", async ({}, info) => {
  const first = await shell.create("Inline first");
  const second = await shell.create("Inline second");
  await shell.row("Inline first").click({ button: "right" });
  await shell.page
    .getByRole("button", { name: "Rename workspace", exact: true })
    .click();
  const input = shell.page.getByRole("textbox", {
    name: "Workspace name",
    exact: true,
  });
  await expect(input).toBeFocused();
  await expect(shell.page.getByRole("dialog")).toHaveCount(0);
  await input.fill("Edited first");
  await input.press("ArrowLeft");
  const caret = await input.evaluate(
    (node: HTMLInputElement) => node.selectionStart,
  );
  await shell.cli(
    "workspace",
    "rename",
    "--id",
    second,
    "--name",
    "Background update",
  );
  await expect(input).toHaveValue("Edited first");
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((node: HTMLInputElement) => node.selectionStart),
  ).toBe(caret);
  expect((await shell.state()).activeWorkspaceId).toBe(second);
  await shell.page.screenshot({ path: info.outputPath("inline-rename.png") });
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  expect((await shell.workspace(first)).name).toBe("Inline first");
  await shell.row("Inline first").locator(".tree-label").dblclick();
  await expect(input).toBeFocused();
  await input.fill("Saved on blur");
  await shell.row("Background update").click();
  await expect(shell.row("Saved on blur")).toBeVisible();
  await shell.row("Saved on blur").locator(".tree-label").dblclick();
  await input.fill("   ");
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  expect((await shell.workspace(first)).name).toBe("Saved on blur");
  await shell.stop();
  await shell.start();
  await expect(shell.row("Saved on blur")).toBeVisible();
});
