import { test, expect, type Page } from "@playwright/test";
import { rename, symlink, writeFile } from "node:fs/promises";
import type { AppState } from "../../src/types";
import path from "node:path";
import { ChatApp } from "./helpers/chat-fixture/harness";
let shell: ChatApp;
test.beforeEach(async () => {
  shell = new ChatApp();
  await shell.prepare();
  await shell.start();
});
test.afterEach(async () => {
  await shell?.cleanup();
});

test("Opening a registered file reuses its native form and refreshes only on request", async ({}, info) => {
  const workspace = await shell.create("Reusable artifact task");
  const origin = await shell.newChat(workspace, "codex");
  const other = await shell.newChat(workspace, "kimi");
  const file = path.join(shell.folders[0], "artifact.html");
  const alias = path.join(shell.folders[0], "artifact-alias.html");
  const document = (title: string) =>
    `<!doctype html><title>Invented artifact</title><h1>${title}</h1><label>Answer<input></label>`;
  await writeFile(file, document("First revision"));
  await symlink(file, alias);
  type Opened = { id: string; paneId: string };
  const args = (filePath = file, conversation = origin.id) => [
    "page",
    "open",
    "--workspace",
    workspace,
    "--conversation",
    conversation,
    "--path",
    filePath,
  ];
  const open = (filePath = file, ...flags: string[]) =>
    shell.cli<Opened>(...args(filePath), ...flags);
  const [opened, viaAlias, concurrent] = await Promise.all([
    open(),
    open(alias),
    open(),
  ]);
  expect(viaAlias).toEqual(opened);
  expect(concurrent).toEqual(opened);
  const registered = () =>
    shell
      .cli<AppState>("state")
      .then((state) =>
        state.browsers.filter(
          (record) => record.agentPage?.conversationId === origin.id,
        ),
      );
  expect(await registered()).toHaveLength(1);
  const inspect = (id = opened.id) =>
    shell.cli<{ url: string; error?: string }>(
      "browser",
      "inspect",
      "--id",
      id,
    );
  async function locate(id: string, heading: string) {
    const { url } = await inspect(id);
    let page: Page | undefined;
    await expect
      .poll(() => {
        page = shell
          .app!.context()
          .pages()
          .find((candidate) => candidate.url() === url);
        return Boolean(page);
      })
      .toBe(true);
    await expect(page!.getByRole("heading", { name: heading })).toBeVisible();
    return page!;
  }
  const page = await locate(opened.id, "First revision");
  const entryUrl = page.url();
  const answer = page.getByLabel("Answer");
  await answer.fill("Keep this unsent answer");
  await writeFile(file, document("Second revision"));
  expect(
    (await shell.raw(...args(path.join(shell.folders[0], "missing.html"))))
      .code,
  ).not.toBe(0);
  expect((await shell.raw(...args(), "--refresh", "yes")).code).not.toBe(0);

  await shell.create("Another invented workspace");
  expect(await open(alias, "--refresh", "false")).toEqual(opened);
  await expect(shell.pane(opened.paneId)).toBeVisible();
  const state = await shell.state();
  expect(state.activeWorkspaceId).toBe(workspace);
  expect(
    state.workspaces.find(({ id }) => id === workspace)?.activePaneId,
  ).toBe(opened.paneId);
  await expect(answer).toHaveValue("Keep this unsent answer");
  await expect(
    page.getByRole("heading", { name: "First revision" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("artifact-reused.png") });

  expect(await open(file, "--refresh", "true")).toEqual(opened);
  expect(page.url()).toBe(entryUrl);
  await expect(
    page.getByRole("heading", { name: "Second revision" }),
  ).toBeVisible();
  await expect(answer).toHaveValue("");
  await page.screenshot({ path: info.outputPath("artifact-refreshed.png") });
  const distinct = await shell.cli<Opened>(...args(file, other.id));
  expect(distinct.id).not.toBe(opened.id);
  expect(distinct.paneId).not.toBe(opened.paneId);
  expect((await inspect(distinct.id)).url).not.toBe(entryUrl);
  expect(await shell.prompts()).toHaveLength(0);

  // Retain the persisted identity even if startup cannot load the file.
  await shell.stop();
  const removed = file + ".saved";
  await rename(file, removed);
  await shell.start();
  await expect.poll(async () => (await inspect()).error).toContain("ENOENT");
  expect((await shell.raw(...args())).code).not.toBe(0);
  expect(await registered()).toHaveLength(1);
  await rename(removed, file);
  const [restored, alongsideRestore] = await Promise.all([open(), open(alias)]);
  expect(restored).toEqual(opened);
  expect(alongsideRestore).toEqual(opened);
  const restoredPage = await locate(opened.id, "Second revision");
  expect(await restoredPage.evaluate(() => typeof window.cod)).toBe(
    "undefined",
  );
  expect(await registered()).toHaveLength(1);
  expect(await shell.prompts()).toHaveLength(0);
});

test("Registered local form binds its real isolated view to one origin conversation", async ({}, info) => {
  const workspace = await shell.create("Artifact response task");
  const origin = await shell.newChat(workspace, "codex");
  const decoy = await shell.newChat(workspace, "kimi");
  const file = path.join(shell.folders[0], "artifact.html");
  await writeFile(
    file,
    `<!doctype html><title>Invented artifact</title><h1>Choose export limits</h1><form><label>Answer<input name="answer"></label><button>Submit response</button></form><output aria-label="Form result"></output><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();document.querySelector('output').textContent=JSON.stringify(await codPage.submit({answer:document.querySelector('input').value}))}</script>`,
  );
  const opened = await shell.cli<{ id: string; paneId: string }>(
    "page",
    "open",
    "--workspace",
    workspace,
    "--conversation",
    origin.id,
    "--path",
    file,
  );
  const record = await shell.cli<{ url: string }>(
    "browser",
    "inspect",
    "--id",
    opened.id,
  );
  let page: Page | undefined;
  await expect
    .poll(() => {
      page = shell
        .app!.context()
        .pages()
        .find((candidate) => candidate.url() === record.url);
      return !!page;
    })
    .toBe(true);
  await expect(
    page!.getByRole("heading", { name: "Choose export limits" }),
  ).toBeVisible();
  expect(
    await page!.evaluate(() => ({
      node: typeof (window as unknown as { require?: unknown }).require,
      cod: typeof window.cod,
    })),
  ).toEqual({ node: "undefined", cod: "undefined" });
  const bad = await page!.evaluate(
    async (id) =>
      (
        window as unknown as {
          codPage: { submit: (value: unknown) => Promise<{ ok: boolean }> };
        }
      ).codPage.submit({
        conversationId: id,
        answer: "must not route elsewhere",
      }),
    decoy.id,
  );
  expect(bad.ok).toBe(false);
  expect(await shell.prompts()).toHaveLength(0);
  await page!.getByLabel("Answer", { exact: true }).fill("100000 rows");
  await page!
    .getByRole("button", { name: "Submit response", exact: true })
    .click();
  await expect(page!.getByLabel("Form result")).toContainText('"ok":true');
  await expect
    .poll(async () =>
      (await shell.inspect(origin.id)).messages
        .map((message) => message.text)
        .join("\n"),
    )
    .toContain("100000 rows");
  expect((await shell.inspect(decoy.id)).messages).toEqual([]);
  await expect
    .poll(async () => (await shell.inspect(origin.id)).status)
    .toBe("ready");
  const repeated = await page!.evaluate(async () =>
    (
      window as unknown as {
        codPage: { submit: (value: unknown) => Promise<{ ok: boolean }> };
      }
    ).codPage.submit({ answer: "duplicate must not send" }),
  );
  expect(repeated.ok).toBe(false);
  expect(await shell.prompts()).toHaveLength(1);
  await shell.page.screenshot({
    path: info.outputPath("registered-artifact-shell.png"),
  });
  await page!.screenshot({
    path: info.outputPath("registered-artifact-content.png"),
  });
  await page!.getByRole("heading", { name: "Choose export limits" }).click();
  // Host accelerators use Electron's native input path, not CDP DOM key dispatch.
  await shell.app!.evaluate(({ webContents }, url) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL() === url)!;
    contents.focus();
    const modifiers: Array<"meta" | "control" | "shift"> = [
      process.platform === "darwin" ? "meta" : "control",
      "shift",
    ];
    contents.sendInputEvent({ type: "keyDown", keyCode: "P", modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode: "P", modifiers });
  }, record.url);
  await expect(
    shell.page.getByRole("dialog", { name: /command/i }),
  ).toBeVisible();
  await shell.page.keyboard.press("Escape");
  await shell.cli("conversation", "show", "--id", origin.id);
  const packet = shell
    .pane(origin.paneId)
    .locator("details.structured-message");
  const summary = packet.locator("summary");
  await expect(summary).toHaveText("Response to artifact.html");
  await summary.click();
  await expect(packet.locator("pre")).toBeVisible();
  await expect(packet.locator("pre")).toContainText("100000 rows");
  await shell.cli(
    "conversation",
    "rename",
    "--id",
    decoy.id,
    "--name",
    "Invented renamed conversation",
  );
  await expect(packet.locator("pre")).toBeVisible();
  await shell.cli(
    "pane",
    "focus",
    "--workspace",
    workspace,
    "--id",
    opened.paneId,
  );
  await shell.stop();
  await shell.start();
  const restored = await shell.cli<{
    url: string;
    agentPage: { submission: { status: string } };
  }>("browser", "inspect", "--id", opened.id);
  expect(restored.agentPage.submission.status).toBe("completed");
  await expect
    .poll(() => {
      page = shell
        .app!.context()
        .pages()
        .find((candidate) => candidate.url() === restored.url);
      return !!page;
    })
    .toBe(true);
  for (const refresh of [false, true]) {
    expect(
      await shell.cli(
        "page",
        "open",
        "--workspace",
        workspace,
        "--conversation",
        origin.id,
        "--path",
        file,
        "--refresh",
        String(refresh),
      ),
    ).toEqual(opened);
    await expect(
      page!.getByLabel("Answer", { exact: true }),
    ).not.toBeEditable();
  }
  const afterRestart = await page!.evaluate(async () =>
    (
      window as unknown as {
        codPage: { submit: (value: unknown) => Promise<{ ok: boolean }> };
      }
    ).codPage.submit({ answer: "restart must not resend" }),
  );
  expect(afterRestart.ok).toBe(false);
  expect(await shell.prompts()).toHaveLength(1);
  await shell.app!.evaluate(({ webContents }, url) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL() === url)!;
    contents.focus();
    const modifiers: Array<"meta" | "control"> = [
      process.platform === "darwin" ? "meta" : "control",
    ];
    contents.sendInputEvent({ type: "keyDown", keyCode: "W", modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode: "W", modifiers });
  }, restored.url);
  await expect(shell.pane(opened.paneId)).toHaveCount(0);
  expect((await shell.state()).activeWorkspaceId).toBe(workspace);
  expect((await shell.inspect(origin.id)).nativeId).toBeTruthy();
});

test("Artifact busy rejection stays editable and an admitted provider failure stays uncertain across restart", async () => {
  const workspace = await shell.create("Artifact retry boundaries");
  const chat = await shell.newChat(workspace, "codex");
  const file = path.join(shell.folders[0], "retry-form.html");
  await writeFile(
    file,
    `<!doctype html><h1>Retry form</h1><form><label>Answer<input name="answer"></label><button>Submit response</button></form><output aria-label="Result"></output><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();document.querySelector('output').textContent=JSON.stringify(await codPage.submit({answer:document.querySelector('input').value}))}</script>`,
  );
  const opened = await shell.cli<{ id: string }>(
    "page",
    "open",
    "--workspace",
    workspace,
    "--conversation",
    chat.id,
    "--path",
    file,
  );
  const inspect = () =>
    shell.cli<{ url: string; agentPage: { submission?: { status: string } } }>(
      "browser",
      "inspect",
      "--id",
      opened.id,
    );
  let page: Page | undefined;
  const locate = async () => {
    const record = await inspect();
    await expect
      .poll(() => {
        page = shell
          .app!.context()
          .pages()
          .find((candidate) => candidate.url() === record.url);
        return !!page;
      })
      .toBe(true);
    await expect(
      page!.getByRole("heading", { name: "Retry form" }),
    ).toBeVisible();
  };
  await locate();
  await shell.send(chat.id, "[hold] Existing task");
  await page!.getByLabel("Answer").fill("unsent while busy");
  await page!.getByRole("button", { name: "Submit response" }).click();
  await expect(page!.getByLabel("Result")).toContainText('"ok":false');
  expect((await inspect()).agentPage.submission).toBeUndefined();
  await expect(page!.getByLabel("Answer")).toBeEditable();
  expect(await shell.prompts()).toHaveLength(1);
  await shell.cli("conversation", "interrupt", "--id", chat.id);
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("ready");
  await page!.getByLabel("Answer").fill("[crash] admitted response");
  await page!.getByRole("button", { name: "Submit response" }).click();
  await expect
    .poll(async () => (await inspect()).agentPage.submission?.status)
    .toBe("uncertain");
  await expect(page!.getByLabel("Answer")).not.toBeEditable();
  expect(await shell.prompts()).toHaveLength(2);
  await shell.stop();
  await shell.start();
  await locate();
  expect((await inspect()).agentPage.submission?.status).toBe("uncertain");
  await expect(page!.getByLabel("Answer")).not.toBeEditable();
  expect(await shell.prompts()).toHaveLength(2);
});

test("Registered report links and CLI navigation preserve the origin and isolate linked documents", async () => {
  const workspace = await shell.create("Invented report task");
  const origin = await shell.newChat(workspace, "codex");
  const file = path.join(shell.folders[0], "report.html");
  await writeFile(
    file,
    '<h1>Invented report</h1><a href="evidence.html">Evidence</a>',
  );
  await writeFile(
    path.join(shell.folders[0], "evidence.html"),
    '<h1>Invented evidence</h1><script src="evidence.js"></script>',
  );
  await writeFile(
    path.join(shell.folders[0], "evidence.js"),
    'document.body.dataset.loaded="yes"',
  );
  const opened = await shell.cli<{ id: string }>(
    "page",
    "open",
    "--workspace",
    workspace,
    "--conversation",
    origin.id,
    "--path",
    file,
  );
  const record = await shell.cli<{ url: string }>(
    "browser",
    "inspect",
    "--id",
    opened.id,
  );
  let page: Page | undefined;
  await expect
    .poll(() => {
      page = shell
        .app!.context()
        .pages()
        .find((p) => p.url() === record.url);
      return !!page;
    })
    .toBe(true);
  await page!.getByRole("link", { name: "Evidence", exact: true }).click();
  await expect(
    page!.getByRole("heading", { name: "Invented evidence" }),
  ).toBeVisible();
  await expect(page!.locator("body")).toHaveAttribute("data-loaded", "yes");
  expect(await page!.evaluate(() => typeof (window as any).codPage)).toBe(
    "undefined",
  );
  await shell.cli("browser", "back", "--id", opened.id);
  await expect(
    page!.getByRole("heading", { name: "Invented report" }),
  ).toBeVisible();
  expect(await page!.evaluate(() => typeof (window as any).codPage)).toBe(
    "object",
  );
  await shell.cli("browser", "forward", "--id", opened.id);
  await expect(
    page!.getByRole("heading", { name: "Invented evidence" }),
  ).toBeVisible();
  await shell.cli("browser", "reload", "--id", opened.id);
  await expect(page!.locator("body")).toHaveAttribute("data-loaded", "yes");
  const reopen = (...flags: string[]) =>
    shell.cli(
      "page",
      "open",
      "--workspace",
      workspace,
      "--conversation",
      origin.id,
      "--path",
      file,
      ...flags,
    );
  expect(await reopen()).toEqual(opened);
  await expect(
    page!.getByRole("heading", { name: "Invented evidence" }),
  ).toBeVisible();
  expect(await reopen("--refresh", "true")).toEqual(opened);
  await expect(
    page!.getByRole("heading", { name: "Invented report" }),
  ).toBeVisible();
  expect(page!.url()).toBe(record.url);
  expect(await shell.prompts()).toHaveLength(0);
});
