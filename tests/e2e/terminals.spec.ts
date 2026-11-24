import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { WorkspaceApp, modifier, tabTo } from "./helpers/workspace-app";
import type { AppState } from "../../src/types";

interface Terminal {
  id: string;
  paneId: string;
  workspaceId: string;
  cwd: string;
  pid: number;
  cols: number;
  rows: number;
  output: string;
  status: string;
}
let shell: WorkspaceApp;
const marker = () => `FIXTURE_${randomUUID().replaceAll("-", "")}`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
test.beforeEach(async () => {
  shell = new WorkspaceApp();
  await shell.prepare();
  Object.assign(shell.environment, {
    COD_TERMINAL_SHELL: "/bin/bash",
    COD_TERMINAL_ARGS: JSON.stringify(["--noprofile", "--norc", "-i"]),
    BASH_SILENCE_DEPRECATION_WARNING: "1",
    HISTFILE: "/dev/null",
  });
  await shell.start();
});
test.afterEach(async () => {
  await shell?.cleanup();
});
const inspect = (id: string) =>
  shell.cli<Terminal>("terminal", "inspect", "--id", id);
const write = (id: string, data: string) =>
  shell.cli("terminal", "write", "--id", id, "--data", data);
async function output(id: string, expression: RegExp) {
  await expect.poll(async () => (await inspect(id)).output).toMatch(expression);
  return (await inspect(id)).output;
}
async function ready(id: string) {
  const tag = marker();
  await write(id, `stty -echo; set +H; printf '\\n${tag}\\n'\n`);
  await output(id, new RegExp(`(?:^|[\\r\\n])${tag}[\\r\\n]`));
}
async function open(workspace: string, cwd = shell.folders[0]) {
  const terminal = await shell.cli<Terminal>(
    "terminal",
    "open",
    "--workspace",
    workspace,
    "--cwd",
    cwd,
  );
  await ready(terminal.id);
  expect((await inspect(terminal.id)).status).toBe("running");
  return terminal;
}
const input = (paneId: string) =>
  shell
    .pane(paneId)
    .getByRole("textbox", { name: "Terminal input", exact: true });
async function command(id: string, source: string) {
  const tag = marker();
  await write(id, `${source}; printf '\\n${tag}\\n'\n`);
  await output(id, new RegExp(`(?:^|[\\r\\n])${tag}[\\r\\n]`));
  return (await inspect(id)).output;
}
async function foreground(id: string) {
  const tag = marker();
  await write(
    id,
    `sleep 300 & job=$!; printf '\\n${tag}:%s\\n' "$job"; wait "$job"\n`,
  );
  const text = await output(id, new RegExp(`${tag}:\\d+`));
  return Number(text.match(new RegExp(`${tag}:(\\d+)`))![1]);
}

test("T1 AC1 creates UI and CLI terminals with real xterm keyboard input and three TTY descriptors", async ({}, info) => {
  const workspace = await shell.create("Terminal UI fixture");
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  await shell.page
    .getByRole("button", { name: "New terminal", exact: true })
    .click();
  await expect(shell.page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await shell.cli<{ terminals: Terminal[] }>("state")).terminals.length,
    )
    .toBe(1);
  const state = await shell.cli<{ terminals: Terminal[] }>("state");
  const terminal = state.terminals.find(
    (item) => item.workspaceId === workspace,
  )!;
  expect(terminal).toBeDefined();
  await ready(terminal.id);
  await expect(shell.pane(terminal.paneId).locator(".xterm")).toBeVisible();
  await expect(input(terminal.paneId)).toBeFocused();
  const tag = marker();
  await shell.page.keyboard.type(
    `test -t 0 && test -t 1 && test -t 2 && printf '${tag}\\n'`,
  );
  await shell.page.keyboard.press("Enter");
  await output(terminal.id, new RegExp(tag));
  await expect(
    shell
      .pane(terminal.paneId)
      .getByRole("region", { name: "Terminal output", exact: true }),
  ).toContainText(tag);
  const second = await open(workspace, shell.folders[1]);
  expect(second.id).not.toBe(terminal.id);
  expect((await inspect(second.id)).cwd).toBe(shell.folders[1]);
  await shell.page.screenshot({ path: info.outputPath("real-terminals.png") });
});

test("T1 AC2 preserves two independent shells and output across workspace switches without replay duplication", async () => {
  const first = await shell.create("Terminal alpha");
  const one = await open(first);
  const tag = marker();
  await command(one.id, `export COD_FIXTURE_VALUE=alpha; printf '${tag}\\n'`);
  const second = await shell.create("Terminal beta");
  const two = await open(second);
  await command(two.id, "export COD_FIXTURE_VALUE=beta");
  const extra = await open(first);
  expect((await shell.state()).activeWorkspaceId).toBe(second);
  const oldPid = (await inspect(one.id)).pid;
  for (let i = 0; i < 3; i++) {
    await shell.cli("workspace", "focus", "--id", first);
    await shell.cli("workspace", "focus", "--id", second);
  }
  expect((await inspect(one.id)).pid).toBe(oldPid);
  expect((await inspect(one.id)).output.split(tag)).toHaveLength(2);
  for (const [id, value] of [
    [one.id, "alpha"],
    [two.id, "beta"],
  ]) {
    const check = marker();
    await command(id, `printf '${check}:%s\\n' "$COD_FIXTURE_VALUE"`);
    await output(id, new RegExp(`${check}:${value}`));
  }
  expect((await inspect(two.id)).output).not.toContain(tag);
  await shell.cli("terminal", "close", "--id", extra.id);
});

test("T1 AC3 CLI resize changes real inactive PTY and visible viewport fitting changes dimensions", async () => {
  const first = await shell.create("Resize terminal");
  const terminal = await open(first);
  await shell.create("Inactive resize target");
  await shell.cli(
    "terminal",
    "resize",
    "--id",
    terminal.id,
    "--cols",
    "111",
    "--rows",
    "37",
  );
  const tag = marker();
  await command(terminal.id, `printf '${tag}:'; stty size`);
  await output(terminal.id, new RegExp(`${tag}:37 111`));
  await shell.cli("workspace", "focus", "--id", first);
  await expect
    .poll(async () => (await inspect(terminal.id)).cols)
    .not.toBe(111);
  const before = await inspect(terminal.id);
  await shell.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(720, 520),
  );
  await expect
    .poll(async () => {
      const current = await inspect(terminal.id);
      return current.cols !== before.cols || current.rows !== before.rows;
    })
    .toBe(true);
  const actual = await inspect(terminal.id);
  const check = marker();
  await command(terminal.id, `printf '${check}:'; stty size`);
  await output(
    terminal.id,
    new RegExp(`${check}:${actual.rows} ${actual.cols}`),
  );
});

test("T1 AC4 keyboard Ctrl-C interrupts foreground work and global shortcuts work from terminal input", async () => {
  const workspace = await shell.create("Keyboard terminal");
  const terminal = await open(workspace);
  await tabTo(shell.page, input(terminal.paneId));
  await shell.page.keyboard.type("sleep 300");
  await shell.page.keyboard.press("Enter");
  await shell.page.keyboard.press("Control+c");
  const tag = marker();
  await shell.page.keyboard.type(`printf '${tag}\\n'`);
  await shell.page.keyboard.press("Enter");
  await output(terminal.id, new RegExp(tag));
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  await expect(shell.page.getByRole("dialog")).toBeVisible();
  await shell.page.keyboard.press("Escape");
  await tabTo(shell.page, input(terminal.paneId));
  const overview = await shell.overview();
  await expect(overview.getByRole("combobox")).toBeFocused();
  await expect(shell.row("Keyboard terminal")).toBeVisible();
});

async function deferPaletteClose() {
  await shell.page.evaluate(() => {
    let released = false;
    document.addEventListener(
      "close",
      (event) => {
        const dialog = event.target;
        if (
          released ||
          !(dialog instanceof HTMLDialogElement) ||
          !dialog.classList.contains("command-palette")
        )
          return;
        event.stopImmediatePropagation();
        Object.assign(window, {
          releasePaletteClose: () => {
            released = true;
            dialog.dispatchEvent(new Event("close"));
          },
        });
      },
      true,
    );
  });
}

test("Delayed Commands cancellation preserves newer Overview focus and the terminal input line", async () => {
  const workspace = await shell.create("Delayed palette fixture");
  const terminal = await open(workspace);
  await tabTo(shell.page, input(terminal.paneId));
  const tag = marker();
  await shell.page.keyboard.type(`printf '${tag}\\n'`);
  // Native close delivery is asynchronous. Hold that event until a newer real
  // keyboard action has selected another control, without changing dialog.close.
  await deferPaletteClose();
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  await expect(
    shell.page.getByRole("dialog", { name: "Command palette" }),
  ).toBeVisible();
  await shell.page.keyboard.press("Escape");
  await expect
    .poll(() =>
      shell.page.evaluate(() => typeof (window as any).releasePaletteClose),
    )
    .toBe("function");
  await tabTo(shell.page, input(terminal.paneId));
  const overview = await shell.overview();
  await expect(overview.getByRole("combobox")).toBeFocused();
  await shell.page.evaluate(() => (window as any).releasePaletteClose());
  await shell.page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(overview.getByRole("combobox")).toBeFocused();
  await shell.page.keyboard.press("Escape");
  await expect(input(terminal.paneId)).toBeFocused();
  await shell.page.keyboard.press("Enter");
  await output(terminal.id, new RegExp(tag));
});

test("Palette cancellation restores the editor caret before late cleanup and preserves newer input in that invoker", async () => {
  const workspace = await shell.create("Palette caret fixture");
  const file = path.join(shell.folders[0], "caret.txt");
  await writeFile(file, "alpha beta gamma delta");
  await shell.cli("file", "open", "--workspace", workspace, "--path", file);
  const editor = shell.page.getByRole("textbox", {
    name: "File contents",
    exact: true,
  });
  await tabTo(shell.page, editor);
  await shell.page.keyboard.press(`${modifier}+Home`);
  for (let i = 0; i < 3; ++i) await shell.page.keyboard.press("ArrowRight");
  for (let i = 0; i < 6; ++i)
    await shell.page.keyboard.press("Shift+ArrowRight");
  const range = () =>
    editor.evaluate((e) => [
      (e as HTMLTextAreaElement).selectionStart,
      (e as HTMLTextAreaElement).selectionEnd,
    ]);
  await expect.poll(range).toEqual([3, 9]);
  await deferPaletteClose();
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  await expect(
    shell.page.getByRole("dialog", { name: "Command palette" }),
  ).toBeVisible();
  await shell.page.keyboard.press("Escape");
  await expect
    .poll(() =>
      shell.page.evaluate(() => typeof (window as any).releasePaletteClose),
    )
    .toBe("function");
  await expect(editor).toBeFocused();
  await expect.poll(range).toEqual([3, 9]);
  await shell.page.keyboard.press("End");
  await shell.page.keyboard.type(" appended");
  for (let i = 0; i < 4; ++i)
    await shell.page.keyboard.press("Shift+ArrowLeft");
  const newer = await range();
  expect(newer).not.toEqual([3, 9]);
  const value = await editor.inputValue();
  await shell.page.evaluate(() => (window as any).releasePaletteClose());
  await shell.page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(value);
  expect(await range()).toEqual(newer);
});

test("T1 AC5 pane and workspace close stop owned foreground jobs while another terminal survives", async () => {
  const first = await shell.create("Closing terminal");
  const one = await open(first);
  const firstPid = (await inspect(one.id)).pid;
  const job = await foreground(one.id);
  const second = await shell.create("Surviving terminal");
  const survivor = await open(second);
  await shell.cli("workspace", "focus", "--id", first);
  await tabTo(shell.page, input(one.paneId));
  // Linux Ctrl+W belongs to readline; Cod closure remains keyboard-accessible.
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  await expect(
    shell.page.getByRole("textbox", { name: "Filter commands" }),
  ).toBeFocused();
  await shell.page.keyboard.type("Close tab");
  await expect(
    shell.page.getByRole("button", { name: "Close tab", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  await shell.page.keyboard.press("Enter");
  await expect.poll(() => alive(job) || alive(firstPid)).toBe(false);
  const closing = await open(first);
  const closingPid = (await inspect(closing.id)).pid;
  const secondJob = await foreground(closing.id);
  await shell.cli("workspace", "close", "--id", first, "--force", "true");
  await expect.poll(() => alive(secondJob) || alive(closingPid)).toBe(false);
  const before = (await inspect(survivor.id)).pid;
  expect(
    (
      await shell.raw(
        "terminal",
        "write",
        "--id",
        "missing-terminal",
        "--data",
        "exit\n",
      )
    ).code,
  ).not.toBe(0);
  expect((await inspect(survivor.id)).pid).toBe(before);
  await command(survivor.id, "printf survivor-alive");
});

test("T1 AC6 restart restores terminal resources with fresh processes and no shell state or command replay", async () => {
  const workspace = await shell.create("Restored terminal");
  const terminal = await open(workspace);
  const tag = marker();
  await command(
    terminal.id,
    `export COD_FIXTURE_OLD=present; printf '${tag}\\n'`,
  );
  const old = await inspect(terminal.id);
  const layout = (await shell.workspace(workspace)).groupLayout;
  await shell.stop();
  await expect.poll(() => alive(old.pid)).toBe(false);
  await shell.start();
  await expect
    .poll(async () => (await inspect(terminal.id)).pid)
    .toBeGreaterThan(0);
  const restored = await inspect(terminal.id);
  expect(restored.pid).toBeGreaterThan(0);
  expect(restored.pid).not.toBe(old.pid);
  expect(restored.cwd).toBe(old.cwd);
  expect(restored.paneId).toBe(old.paneId);
  expect((await shell.workspace(workspace)).groupLayout).toEqual(layout);
  expect(restored.output).not.toContain(tag);
  await ready(terminal.id);
  const check = marker();
  await command(
    terminal.id,
    `printf '${check}:%s\\n' "\${COD_FIXTURE_OLD-unset}"`,
  );
  await output(terminal.id, new RegExp(`${check}:unset`));
});

test("T1 AC7 untrusted remote page cannot inspect or mutate terminals or observe private output", async () => {
  const workspace = await shell.create("Trusted terminal");
  const terminal = await open(workspace);
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Invented untrusted fixture</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  try {
    const probe = await shell.app!.evaluate(
      async ({ BrowserWindow }, { url, preload, id }) => {
        const window = new BrowserWindow({
          show: false,
          webPreferences: {
            preload,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        await window.loadURL(url);
        const denied = await window.webContents.executeJavaScript(
          `(async()=>{window.observed=[]; if(window.cod?.onState)window.cod.onState(value=>window.observed.push(value)); if(window.cod?.onTerminal)window.cod.onTerminal(value=>window.observed.push(value)); if(!window.cod?.invoke)return [true,true,true]; const operations=[{op:'terminal.inspect',id:${JSON.stringify(id)}},{op:'terminal.write',id:${JSON.stringify(id)},data:'exit\\n'},{op:'terminal.resize',id:${JSON.stringify(id)},cols:1,rows:1}]; return Promise.all(operations.map(async op=>{try{await window.cod.invoke(op);return false;}catch{return true;}}));})()`,
        );
        return { denied, contentsId: window.webContents.id };
      },
      {
        url: `http://127.0.0.1:${address.port}`,
        preload: path.join(shell.root, "dist/preload.cjs"),
        id: terminal.id,
      },
    );
    expect(probe.denied).toEqual([true, true, true]);
    const tag = marker();
    await command(terminal.id, `printf '${tag}\\n'`);
    const observed = await shell.app!.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id)!;
      return contents.executeJavaScript("window.observed");
    }, probe.contentsId);
    expect(observed).toEqual([]);
    expect((await inspect(terminal.id)).cols).toBeGreaterThan(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

for (const closer of [
  "workspace.close",
  "terminal.close",
  "pane.close",
] as const) {
  test(`T1 lifecycle race: ${closer} serializes concurrent terminal admission`, async () => {
    const workspace = await shell.create("Terminal lifecycle fixture");
    const old = await open(workspace);
    await command(old.id, "trap '' HUP");
    const oldPid = (await inspect(old.id)).pid;
    const result = (await shell.page.evaluate(
      async ({ closer, workspace, id, paneId, cwd }) => {
        const invoke = (request: Record<string, unknown> & { op: string }) =>
          window.cod.invoke(request);
        const closing = invoke(
          closer === "workspace.close"
            ? { op: closer, id: workspace, force: true }
            : closer === "pane.close"
              ? { op: closer, workspace, id: paneId }
              : { op: closer, id },
        );
        // The owned shell ignores HUP, keeping close in its bounded escalation window.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const opening = invoke({ op: "terminal.open", workspace, cwd });
        const outcomes = await Promise.allSettled([closing, opening]);
        return {
          outcomes: outcomes.map((value) => value.status),
          state: await invoke({ op: "state" }),
        };
      },
      {
        closer,
        workspace,
        id: old.id,
        paneId: old.paneId,
        cwd: shell.folders[0],
      },
    )) as {
      outcomes: string[];
      state: {
        workspaces: Array<{
          id: string;
          panes: Array<{ terminalId?: string }>;
        }>;
        terminals: Terminal[];
      };
    };
    expect(result.outcomes[0]).toBe("fulfilled");
    await expect.poll(() => alive(oldPid)).toBe(false);
    if (closer === "workspace.close") {
      expect(result.outcomes[1]).toBe("rejected");
      expect(
        result.state.workspaces.some((item) => item.id === workspace),
      ).toBe(false);
      expect(result.state.terminals).toEqual([]);
    } else {
      expect(result.outcomes[1]).toBe("fulfilled");
      expect(result.state.terminals).toHaveLength(1);
      const current = result.state.terminals[0];
      expect(current.id).not.toBe(old.id);
      expect(alive(current.pid)).toBe(true);
      expect(
        result.state.workspaces
          .find((item) => item.id === workspace)!
          .panes.some((pane) => pane.terminalId === current.id),
      ).toBe(true);
      await ready(current.id);
      await shell.cli("terminal", "close", "--id", current.id);
      await expect.poll(() => alive(current.pid)).toBe(false);
    }
  });
}

test("Two-group keyboard mode keeps a real terminal process alive while switching to the editor", async () => {
  const workspace = await shell.create("Preserve the running shell");
  const file = await shell.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    shell.file,
  );
  const editor = shell
    .pane(file.paneId)
    .getByRole("textbox", { name: "File contents", exact: true });
  const terminal = await open(workspace);
  const original = await inspect(terminal.id);
  const split = shell.page.getByRole("button", {
    name: "Toggle split view",
    exact: true,
  });
  await expect(split).toHaveAttribute("aria-pressed", "true");
  await input(terminal.paneId).focus();
  await input(terminal.paneId).press("Shift+Escape");
  await expect(split).toHaveAttribute("aria-pressed", "false");
  await expect(input(terminal.paneId)).toBeFocused();
  await expect(editor).toBeHidden();

  await input(terminal.paneId).press("Alt+1");
  await expect(editor).toBeFocused();
  await expect(input(terminal.paneId)).toBeHidden();
  await command(terminal.id, "printf 'still running\\n'");
  expect((await inspect(terminal.id)).pid).toBe(original.pid);

  await editor.press("Alt+2");
  await expect(input(terminal.paneId)).toBeFocused();
  await input(terminal.paneId).press("Shift+Escape");
  await expect(split).toHaveAttribute("aria-pressed", "true");
  await expect(editor).toBeVisible();
  await expect(input(terminal.paneId)).toBeFocused();
  expect((await inspect(terminal.id)).pid).toBe(original.pid);
});

test("Quick Terminal keeps centered margins and refits its live shell across window sizes", async ({}, info) => {
  const workspace = await shell.create("Quick Terminal sizing fixture");
  const dialog = shell.page.getByRole("dialog", { name: "Quick Terminal" });
  const quickInput = dialog.getByRole("textbox", { name: "Terminal input" });
  await shell.page.keyboard.press("Control+Backquote");
  await expect(quickInput).toBeFocused();
  const terminal = (await shell.cli<AppState>("state")).quickTerminals!.find(
    (item) => item.workspaceId === workspace,
  )!;
  await ready(terminal.id);
  const original = await inspect(terminal.id);
  await write(
    terminal.id,
    "clear; printf '%s\\n' '$ npm run check' '' 'Checking project files…' 'Type check passed' 'Formatting check passed'\n",
  );
  await expect(
    dialog.getByRole("region", { name: "Terminal output" }),
  ).toContainText("Formatting check passed");

  const sizes = [
    {
      name: "laptop",
      width: 1280,
      height: 820,
      box: { x: 64, y: 41, width: 1152, height: 738 },
    },
    {
      name: "large",
      width: 2200,
      height: 1300,
      box: { x: 200, y: 150, width: 1800, height: 1000 },
    },
    {
      name: "compact",
      width: 760,
      height: 520,
      box: { x: 38, y: 26, width: 684, height: 468 },
    },
  ];
  const measured = [];
  for (const { name, width, height } of sizes) {
    await shell.app!.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setContentSize(
          size.width,
          size.height,
        ),
      { width, height },
    );
    await expect
      .poll(() => shell.page.evaluate(() => [innerWidth, innerHeight]))
      .toEqual([width, height]);
    await expect(quickInput).toBeFocused();
    const bounds = (await dialog.boundingBox())!;
    measured.push(
      Object.fromEntries(
        Object.entries(bounds).map(([key, value]) => [key, Math.round(value)]),
      ),
    );
    await shell.page.screenshot({
      path: info.outputPath(`quick-terminal-sizing-${name}.png`),
    });
  }
  expect(measured).toEqual(sizes.map(({ box }) => box));

  await expect
    .poll(async () => {
      const current = await inspect(terminal.id);
      return current.cols < original.cols && current.rows < original.rows;
    })
    .toBe(true);
  const fitted = await inspect(terminal.id);
  expect(fitted.pid).toBe(original.pid);
  const tag = marker();
  await command(terminal.id, `printf '${tag}:'; stty size`);
  await output(terminal.id, new RegExp(`${tag}:${fitted.rows} ${fitted.cols}`));

  await shell.page.mouse.click(10, 260);
  await expect(dialog).toHaveCount(0);
});

test("Quick Terminal inherits its focused local cwd, retains its shell across hiding and never adds a tab", async ({}, info) => {
  const workspace = await shell.create("Invented Quick Terminal workspace");
  const ordinary = await open(workspace);
  await command(ordinary.id, `cd ${JSON.stringify(shell.folders[1])}`);
  await input(ordinary.paneId).focus();
  const before = await shell.cli<AppState>("state");
  const dialog = shell.page.getByRole("dialog", { name: "Quick Terminal" });
  const quickInput = dialog.getByRole("textbox", { name: "Terminal input" });
  const toggle = () => shell.page.keyboard.press("Control+Backquote");
  const trigger = shell.page.locator(".app-header").getByRole("button", {
    name: "Quick Terminal",
    exact: true,
    includeHidden: true,
  });
  await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toHaveAttribute("title", /Quick Terminal.+`/);
  const button = (await trigger.boundingBox())!;
  const split = (await shell.page
    .getByRole("button", {
      name: "Toggle split view",
    })
    .boundingBox())!;
  expect(button.x + button.width).toBeLessThanOrEqual(split.x);
  await shell.page.screenshot({
    path: info.outputPath("quick-terminal-titlebar-closed.png"),
  });

  await trigger.click();
  await expect(quickInput).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByText("Local", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  const first = (await shell.cli<AppState>("state")).quickTerminals!.find(
    (item) => item.workspaceId === workspace,
  )!;
  const firstProcess = await inspect(first.id);
  expect(firstProcess.cwd).toBe(shell.folders[1]);
  expect(firstProcess.pid).toBeGreaterThan(0);
  expect((await shell.cli<AppState>("state")).workspaces).toEqual(
    before.workspaces,
  );
  expect(
    (await shell.cli<AppState>("state")).terminals.map(({ id }) => id),
  ).toEqual(before.terminals.map(({ id }) => id));
  await ready(first.id);
  await quickInput.pressSequentially(
    "stty raw -echo; printf 'QUICK_RAW_READY\\n'; od -An -tu1 -N1; stty sane; stty -echo",
  );
  await quickInput.press("Enter");
  await output(first.id, /QUICK_RAW_READY/);
  await quickInput.press("Escape");
  await output(first.id, /QUICK_RAW_READY[\s\S]*?\s27\r?\n/);
  await expect(dialog).toBeVisible();
  await write(first.id, "sleep .1; printf 'QUICK_HIDDEN_OUTPUT\\n'\n");
  // The native dialog owns backdrop clicks, including the trigger's position.
  await shell.page.mouse.click(
    button.x + button.width / 2,
    button.y + button.height / 2,
  );
  await expect(dialog).toHaveCount(0);
  await expect(input(ordinary.paneId)).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await output(first.id, /QUICK_HIDDEN_OUTPUT/);
  await shell.page.getByRole("button", { name: "Overview" }).focus();
  await shell.page.keyboard.press("Tab");
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(quickInput).toBeFocused();
  await dialog.getByRole("button", { name: "Hide Quick Terminal" }).click();
  await expect(trigger).toBeFocused();
  await writeFile(
    path.join(shell.data, "keymap.json"),
    JSON.stringify({ "terminal.quickToggle": ["Alt+F7"] }),
  );
  await expect(trigger).toHaveAttribute("title", /Quick Terminal.+F7/);
  await shell.page.keyboard.press("Alt+F7");
  await expect(quickInput).toBeFocused();
  await expect(
    dialog.getByRole("region", { name: "Terminal output" }),
  ).toContainText("QUICK_HIDDEN_OUTPUT");
  expect((await inspect(first.id)).pid).toBe(firstProcess.pid);
  await shell.page.screenshot({
    path: info.outputPath("quick-terminal-local.png"),
  });

  await shell.page.setViewportSize({ width: 440, height: 620 });
  const compact = (await dialog.boundingBox())!;
  expect(compact.width).toBeLessThanOrEqual(400);
  expect(Math.abs(compact.x + compact.width / 2 - 220)).toBeLessThan(2);
  await expect
    .poll(() =>
      dialog.evaluate((element) => {
        const host = element.querySelector(".terminal-output")!;
        const screen = element.querySelector(".xterm-screen")!;
        return (
          element.scrollWidth <= element.clientWidth &&
          screen.getBoundingClientRect().right <=
            host.getBoundingClientRect().right
        );
      }),
    )
    .toBe(true);
  await expect(quickInput).toBeFocused();
  await shell.page.screenshot({
    path: info.outputPath("quick-terminal-narrow.png"),
  });
  await shell.page.keyboard.press("Alt+F7");
  await expect(dialog).toHaveCount(0);
  const narrowButton = (await trigger.boundingBox())!;
  expect(narrowButton.x).toBeGreaterThanOrEqual(0);
  expect(narrowButton.x + narrowButton.width).toBeLessThanOrEqual(440);
  await shell.page.screenshot({
    path: info.outputPath("quick-terminal-titlebar-narrow.png"),
  });
  await writeFile(path.join(shell.data, "keymap.json"), "{}");
  await expect(trigger).toHaveAttribute("title", /Quick Terminal.+`/);
  await shell.page.setViewportSize({ width: 1280, height: 820 });

  const other = await shell.create("Another workspace");
  await expect(dialog).toHaveCount(0);
  await toggle();
  await expect(quickInput).toBeFocused();
  const second = (await shell.cli<AppState>("state")).quickTerminals!.find(
    (item) => item.workspaceId === other,
  )!;
  expect(second.id).not.toBe(first.id);
  await shell.page.mouse.click(10, 70);
  await expect(dialog).toHaveCount(0);
  await expect(
    shell.raw("workspace", "close", "--id", workspace),
  ).resolves.toMatchObject({ code: 1 });
  await shell.cli("workspace", "close", "--id", workspace, "--force", "true");
  await expect.poll(() => alive(firstProcess.pid)).toBe(false);
});
