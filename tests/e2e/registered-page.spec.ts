import { test, expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
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
