import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { WorkspaceApp, modifier, tabTo } from "./helpers/workspace-app";

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
  const dialog = shell.page.getByRole("dialog", {
    name: "New terminal",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Working directory", exact: true })
    .fill(shell.folders[0]);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const state = await shell.cli<{ terminals: Terminal[] }>("state");
  const terminal = state.terminals.find(
    (item) => item.workspaceId === workspace,
  )!;
  expect(terminal).toBeDefined();
  await ready(terminal.id);
  await expect(shell.pane(terminal.paneId).locator(".xterm")).toBeVisible();
  await tabTo(shell.page, input(terminal.paneId));
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
  await shell.page.keyboard.press(`${modifier}+Shift+E`);
  await expect(shell.row("Keyboard terminal")).toBeFocused();
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
  const layout = (await shell.workspace(workspace)).layout;
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
  expect((await shell.workspace(workspace)).layout).toEqual(layout);
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
