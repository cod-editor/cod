import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { AppState } from "../../src/types";
import { modifier, WorkspaceApp } from "./helpers/workspace-app";
import { ChatApp } from "./helpers/chat-fixture/harness";

const execute = promisify(execFile);

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
const firstPrompt = "Name the invented image";
const imageReply = "The invented pixel is green.";
const followUp = "What did the previous prompt contain?";
const followUpReply = "The previous prompt included an image.";

async function loopbackModel(
  expectedAuthorization?: string,
  fixtureTools: ReadonlyMap<string, string> = new Map(),
) {
  let requests = 0;
  const turns: Array<{ text: string; model: string; effort?: string }> = [];
  const offeredTools = new Set<string>();
  let imageSent = false;
  let previousImageSent = false;
  const server = createServer(async (request, response) => {
    const reply = (body: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const route = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (route.endsWith("/count_tokens")) return reply({ input_tokens: 30 });
    if (route.endsWith("/models")) return reply({ data: [], has_more: false });
    if (request.method !== "POST" || route !== "/v1/messages")
      return reply({}, 404);
    if (
      expectedAuthorization &&
      request.headers.authorization !== expectedAuthorization
    )
      return reply({}, 401);
    if (++requests > 12) return reply({}, 429);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const users = body.messages.filter(
      (item: { role: string }) => item.role === "user",
    );
    type Block = { type: string; text?: string };
    const blocks = (message: { content: string | Block[] }) =>
      Array.isArray(message.content)
        ? message.content
        : [{ type: "text", text: message.content }];
    const content = blocks(users.at(-1));
    const text = content.map((block) => block.text ?? "").join("");
    turns.push({ text, model: body.model, effort: body.output_config?.effort });
    const earlierImage = users
      .slice(0, -1)
      .some((message: Parameters<typeof blocks>[0]) =>
        blocks(message).some((block) => block.type === "image"),
      );
    const answer = text.includes(followUp) ? followUpReply : imageReply;
    if (
      text.includes(firstPrompt) &&
      content.some((block) => block.type === "image")
    )
      imageSent = true;
    if (text.includes(followUp) && earlierImage) previousImageSent = true;
    const usage = { input_tokens: 30, output_tokens: 8 };
    const message = {
      id: "msg_" + randomUUID().replaceAll("-", ""),
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    };
    const fixturePrompt = users
      .flatMap((item: Parameters<typeof blocks>[0]) => blocks(item))
      .map((block: Block) => block.text ?? "")
      .filter((value: string) => fixtureTools.has(value))
      .at(-1);
    const toolFile =
      fixturePrompt && !offeredTools.has(fixturePrompt)
        ? fixtureTools.get(fixturePrompt)
        : undefined;
    if (toolFile) offeredTools.add(fixturePrompt);
    const block = toolFile
      ? {
          type: "tool_use",
          id: "toolu_" + randomUUID().replaceAll("-", ""),
          name: "Bash",
          input: {
            command: `printf invented > ${toolFile}`,
            description: "Write an invented fixture marker",
          },
        }
      : { type: "text", text: answer };
    const stopReason = toolFile ? "tool_use" : "end_turn";
    if (!body.stream)
      return reply({ ...message, content: [block], stop_reason: stopReason });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, value: object = {}) =>
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
      );
    send("message_start", { message });
    send("content_block_start", {
      index: 0,
      content_block:
        block.type === "tool_use"
          ? { ...block, input: {} }
          : { ...block, text: "" },
    });
    send("content_block_delta", {
      index: 0,
      delta:
        block.type === "tool_use"
          ? {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            }
          : { type: "text_delta", text: answer },
    });
    send("content_block_stop", { index: 0 });
    send("message_delta", {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    });
    send("message_stop");
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No loopback endpoint");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    turns,
    get requests() {
      return requests;
    },
    get imageSent() {
      return imageSent;
    },
    get previousImageSent() {
      return previousImageSent;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("Claude permission modes confirm locally and retain the same idle chat", async ({}, info) => {
  test.skip(process.platform !== "linux", "Uses isolated native Claude");
  test.setTimeout(90_000);
  const app = new WorkspaceApp();
  const markers = new Map([
    ["Run the default fixture", "fixture-default"],
    ["Run the bypass fixture", "fixture-bypass"],
    ["Run the restored default fixture", "fixture-restored"],
  ]);
  const model = await loopbackModel(
    "Bearer invented-permissions-token",
    markers,
  );
  try {
    await app.prepare();
    const executable = path.resolve(
      "node_modules",
      "@anthropic-ai",
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      "claude",
    );
    await access(executable);
    for (const name of [
      "CLAUDECODE",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "ANTHROPIC_API_KEY",
      "COD_CLAUDE_ARGS",
    ])
      delete app.environment[name];
    Object.assign(app.environment, {
      COD_CLAUDE_EXECUTABLE: executable,
      CLAUDE_CONFIG_DIR: path.join(app.temporary, "native-permissions"),
      ANTHROPIC_AUTH_TOKEN: "invented-permissions-token",
      ANTHROPIC_BASE_URL: model.endpoint,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    await app.start();
    const workspace = await app.create("Invented Claude permission workspace");
    await app.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      app.folders[0],
    );
    const button = (name: string) =>
      app.page.getByRole("button", { name, exact: true });
    const mode = () => button("Permission mode");
    const composer = () =>
      app.page.getByRole("textbox", { name: "Message", exact: true });
    const current = async () =>
      (await app.cli<AppState>("state")).conversations.find(
        (chat) => chat.workspaceId === workspace,
      );
    const ready = () =>
      expect.poll(async () => (await current())?.status).toBe("ready");
    const send = async (prompt: string) => {
      await composer().fill(prompt);
      await composer().press(`${modifier}+Enter`);
    };
    const selectMode = async (name: string) => {
      await mode().focus();
      await mode().press("Enter");
      await button(name).click();
    };
    await button("Provider").click();
    await button("Claude Code").click();
    await send("Run the default fixture");
    await expect(button("Deny")).toBeVisible();
    await expect(mode()).toContainText("Default permissions");
    await expect(mode()).toBeDisabled();
    const chat = (await current())!;
    const pending = chat.pendingPermissions.map(({ id }) => id);
    expect(pending).toHaveLength(1);
    const refused = await app.page.evaluate(async (id) => {
      try {
        await window.cod.setClaudePermissionMode(id, "bypassPermissions");
        return "";
      } catch (error) {
        return String(error);
      }
    }, chat.id);
    expect(refused).toContain("idle with no pending requests");
    expect((await current())?.pendingPermissions.map(({ id }) => id)).toEqual(
      pending,
    );
    await button("Deny").click();
    await ready();
    await expect(
      access(path.join(app.folders[0], "fixture-default")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const remoteReply = await new Promise<{ ok: boolean; error?: string }>(
      (resolve, reject) => {
        const socket = createConnection(app.socket);
        socket.setTimeout(3_000, () =>
          socket.destroy(new Error("Socket timeout")),
        );
        socket.setEncoding("utf8");
        let text = "";
        socket.on("connect", () =>
          socket.write(
            JSON.stringify({
              op: "conversation.claude-permission-mode",
              id: chat.id,
              mode: "bypassPermissions",
              trustedUi: true,
            }) + "\n",
          ),
        );
        socket.on("data", (chunk) => {
          text += chunk;
          if (text.includes("\n")) {
            socket.destroy();
            try {
              resolve(JSON.parse(text));
            } catch (error) {
              reject(error);
            }
          }
        });
        socket.on("error", reject);
      },
    );
    expect(remoteReply.ok).toBe(false);

    await app.app!.evaluate(({ dialog }) => {
      const original = dialog.showMessageBox.bind(dialog);
      dialog.showMessageBox = ((
        ...args: Parameters<typeof dialog.showMessageBox>
      ) => {
        const options = args.at(-1) as import("electron").MessageBoxOptions;
        if (options.title !== "Claude Code permissions")
          return original(...args);
        const verification = globalThis as typeof globalThis & {
          permissionDialogs?: Array<{ defaultId?: number; cancelId?: number }>;
          confirmPermissionDialog?: () => void;
        };
        (verification.permissionDialogs ??= []).push({
          defaultId: options.defaultId,
          cancelId: options.cancelId,
        });
        if (verification.permissionDialogs.length === 2)
          return new Promise<import("electron").MessageBoxReturnValue>(
            (resolve) => {
              verification.confirmPermissionDialog = () => {
                delete verification.confirmPermissionDialog;
                resolve({ response: 1, checkboxChecked: false });
              };
            },
          );
        return Promise.resolve({
          response: verification.permissionDialogs.length === 1 ? 0 : 1,
          checkboxChecked: false,
        });
      }) as typeof dialog.showMessageBox;
    });
    await composer().fill("Run the bypass fixture");
    const beforeBypass = model.requests;
    await selectMode("Bypass confirmations");
    await expect(mode()).not.toHaveAttribute("aria-busy", "true");
    await expect(mode()).toContainText("Default permissions");
    await selectMode("Bypass confirmations");
    await expect(mode()).toHaveAttribute("aria-busy", "true");
    const blocked = await app.raw(
      "conversation",
      "send",
      "--id",
      chat.id,
      "--text",
      "A prompt that must not queue during consent",
    );
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("permission change to finish");
    expect((await current())?.queuedMessages ?? []).toHaveLength(0);
    await expect(composer()).toHaveValue("Run the bypass fixture");
    await app.app!.evaluate(() => {
      const verification = globalThis as typeof globalThis & {
        confirmPermissionDialog?: () => void;
      };
      if (!verification.confirmPermissionDialog)
        throw new Error("The native confirmation is not open");
      verification.confirmPermissionDialog();
    });
    await expect(mode()).toContainText("Bypass confirmations");
    await expect(mode()).toBeFocused();
    await expect(composer()).toHaveValue("Run the bypass fixture");
    expect(model.requests).toBe(beforeBypass);
    expect(
      await app.app!.evaluate(
        () =>
          (globalThis as typeof globalThis & { permissionDialogs?: unknown[] })
            .permissionDialogs,
      ),
    ).toEqual([
      { defaultId: 0, cancelId: 0 },
      { defaultId: 0, cancelId: 0 },
    ]);
    await app.page.screenshot({
      path: info.outputPath("claude-permission-bypass.png"),
    });
    await composer().press(`${modifier}+Enter`);
    await ready();
    expect(
      await readFile(path.join(app.folders[0], "fixture-bypass"), "utf8"),
    ).toBe("invented");
    expect((await current())?.nativeId).toBe(chat.nativeId);
    await expect(button("Deny")).toHaveCount(0);

    const beforeDefault = model.requests;
    await selectMode("Default permissions");
    await expect(mode()).toContainText("Default permissions");
    expect(model.requests).toBe(beforeDefault);
    await send("Run the restored default fixture");
    await expect(button("Deny")).toBeVisible();
    await expect(mode()).toBeDisabled();
    await app.page.screenshot({
      path: info.outputPath("claude-permission-pending.png"),
    });
    await button("Deny").click();
    await ready();
    await selectMode("Bypass confirmations");
    await expect(mode()).toContainText("Bypass confirmations");
    await composer().fill("Invented draft survives restart");
    await expect
      .poll(
        async () =>
          (await app.cli<AppState>("state")).workspaces.find(
            ({ id }) => id === workspace,
          )?.chatDrafts?.[chat.paneId]?.text,
      )
      .toBe("Invented draft survives restart");
    const beforeRestart = model.requests;
    await app.stop();
    await app.start();
    await expect(mode()).toContainText("Default permissions");
    await expect(composer()).toHaveValue("Invented draft survives restart");
    expect((await current())?.nativeId).toBe(chat.nativeId);
    expect(model.requests).toBe(beforeRestart);
    expect(
      (await current())?.messages.filter(({ role }) => role === "user"),
    ).toHaveLength(3);
  } finally {
    try {
      await app.cleanup();
    } finally {
      await model.close();
    }
  }
});

test("Claude failure closes approvals without restoring an active turn", async ({}, info) => {
  test.skip(process.platform !== "linux", "Uses isolated native Claude");
  const app = new WorkspaceApp();
  const first = "Trigger the invented provider failure";
  const queued = "An invented queued follow-up";
  const draft = "An invented unsent draft";
  try {
    await app.prepare();
    const profile = path.join(app.temporary, "native-failure");
    await mkdir(profile);
    Object.assign(app.environment, {
      COD_CLAUDE_EXECUTABLE: path.resolve(
        "tests/e2e/helpers/claude-failed-turn.mjs",
      ),
      CLAUDE_CONFIG_DIR: profile,
    });
    const signal = (name: string) => writeFile(path.join(profile, name), "");
    const received = async (): Promise<string[]> =>
      (await readFile(path.join(profile, "received.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).message.content[0].text);

    await app.start();
    const workspace = await app.create("Invented Claude failure workspace");
    await app.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      app.folders[0],
    );
    const button = (name: string) =>
      app.page.getByRole("button", { name, exact: true });
    const composer = () =>
      app.page.getByRole("textbox", { name: "Message", exact: true });
    const current = async () =>
      (await app.cli<AppState>("state")).conversations.find(
        (chat) => chat.workspaceId === workspace,
      );
    const send = async (prompt: string) => {
      await composer().fill(prompt);
      await composer().press(`${modifier}+Enter`);
    };
    await button("Provider").click();
    await button("Claude Code").click();
    await send(first);
    await expect(button("Deny")).toHaveCount(2);
    await expect(button("Stop")).toBeVisible();
    await button("Deny").first().click();
    await expect(button("Deny")).toHaveCount(1);
    await expect.poll(async () => (await current())?.status).toBe("waiting");
    const chat = (await current())!;
    await send(queued);
    await expect
      .poll(async () => (await current())?.queuedMessages?.[0]?.text)
      .toBe(queued);
    await composer().fill(draft);

    await signal("fail-turn");
    await expect.poll(async () => (await current())?.status).toBe("failed");
    await signal("cancel-permissions");
    await expect(button("Permission mode")).toHaveText("Accept edits");
    expect(await current()).toMatchObject({
      id: chat.id,
      status: "failed",
      pendingPermissions: [],
      queuePaused: true,
      queuedMessages: [{ text: queued, status: "queued" }],
    });
    await expect(button("Stop")).toHaveCount(0);
    await expect(button("Deny")).toHaveCount(0);
    expect(await received()).toEqual([first]);

    await app.stop();
    await app.start();
    await expect(composer()).toHaveValue(draft);
    await expect(button("Continue queue")).toBeVisible();
    expect(await received()).toEqual([first]);
    await button("Continue queue").click();
    await expect.poll(received).toEqual([first, queued]);
    await expect.poll(async () => (await current())?.status).toBe("ready");
    await expect(composer()).toHaveValue(draft);
    await expect(button("Continue queue")).toHaveCount(0);
    expect(await current()).toMatchObject({
      id: chat.id,
      nativeId: chat.nativeId,
    });

    await signal("background-approval");
    await expect(button("Deny")).toHaveCount(1);
    await expect(button("Stop")).toHaveCount(0);
    await button("Deny").click();
    await expect(button("Deny")).toHaveCount(0);
    await expect.poll(async () => (await current())?.status).toBe("ready");

    await send(first);
    await expect.poll(received).toEqual([first, queued, first]);
    await expect.poll(async () => (await current())?.status).toBe("failed");
    await button("Overview").click();
    const overview = app.page.getByRole("dialog", { name: "Overview" });
    await overview
      .locator(
        `button.overview-item[data-navigation-key="conversation:${chat.id}"]`,
      )
      .hover();
    await overview
      .getByRole("combobox", { name: "Search Overview" })
      .press("Shift+F10");
    const menu = app.page.locator(".context-menu");
    await expect(
      menu.getByRole("button", { name: "Continue in CLI", exact: true }),
    ).toBeEnabled();
    await expect(
      menu.getByRole("button", { name: "Remove from workspace", exact: true }),
    ).toBeEnabled();
    await app.page.screenshot({
      path: info.outputPath("claude-failed-overview.png"),
    });
  } finally {
    await app.cleanup();
  }
});

test("Claude Code picker and chat reopen the same native conversation without sending", async ({}, info) => {
  test.skip(
    process.platform !== "linux",
    "The scoped acceptance runner uses glibc Linux",
  );
  test.setTimeout(60_000);
  const app = new WorkspaceApp();
  const model = await loopbackModel();
  try {
    await app.prepare();
    const executable = path.resolve(
      "node_modules",
      "@anthropic-ai",
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      "claude",
    );
    await access(executable);
    for (const name of [
      "CLAUDECODE",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "COD_CLAUDE_ARGS",
    ])
      delete app.environment[name];
    Object.assign(app.environment, {
      COD_CLAUDE_EXECUTABLE: executable,
      CLAUDE_CONFIG_DIR: path.join(app.temporary, "native-claude"),
      ANTHROPIC_API_KEY: "sk-fixture-non-secret",
      ANTHROPIC_BASE_URL: model.endpoint,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    await app.start();
    const workspace = await app.create("Invented Claude Code workspace");
    await app.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      app.folders[0],
    );
    const composer = () =>
      app.page.getByRole("textbox", { name: "Message", exact: true });
    const transcript = () =>
      app.page.getByRole("region", {
        name: "Conversation transcript",
        exact: true,
      });
    const expectImagePrompt = async () => {
      const first = transcript().locator(".chat-message.user").first();
      await expect(first.locator(".message-text")).toHaveText(firstPrompt);
      await expect(first.locator(".image-reference")).toHaveText("[Image 1]");
      await expect(first.getByRole("img")).toHaveAttribute(
        "src",
        `data:image/png;base64,${pixel}`,
      );
      await expect(
        app.page.locator(".tab-label").filter({ hasText: firstPrompt }),
      ).toHaveText(firstPrompt);
    };
    await app.page
      .getByRole("button", { name: "Provider", exact: true })
      .click();
    await app.page
      .getByRole("button", { name: "Claude Code", exact: true })
      .click();
    await expect(composer()).toHaveAttribute(
      "placeholder",
      "Message Claude Code...",
    );
    expect(model.requests).toBe(0);
    await composer().fill(firstPrompt);
    await composer().evaluate((node, data) => {
      const file = new File(
        [Uint8Array.from(atob(data), (value) => value.charCodeAt(0))],
        "invented.png",
        {
          type: "image/png",
        },
      );
      const clipboardData = new DataTransfer();
      clipboardData.items.add(file);
      node.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, pixel);
    await expect(app.page.locator(".composer-images img")).toHaveCount(1);
    await composer().press(`${modifier}+Enter`);
    await expect(transcript()).toContainText(imageReply);
    await expectImagePrompt();
    await expect(composer()).toHaveValue("");
    const current = async () =>
      (await app.cli<AppState>("state")).conversations.find(
        (conversation) => conversation.workspaceId === workspace,
      );
    await expect.poll(async () => (await current())?.status).toBe("ready");
    const first = (await current())!;
    expect(first.provider).toBe("claude");
    expect(
      first.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(model.imageSent).toBe(true);
    const calls = model.requests;
    await app.stop();
    await app.start();
    await expect(composer()).toBeEnabled();

    await app.page.keyboard.press(`${modifier}+Shift+P`);
    const commands = app.page.getByRole("dialog", {
      name: "Command palette",
      exact: true,
    });
    const filter = commands.getByRole("textbox", {
      name: "Filter commands",
      exact: true,
    });
    await filter.fill("Open existing native session");
    await filter.press("Enter");
    const picker = app.page.getByRole("dialog", {
      name: "Open existing session",
      exact: true,
    });
    await picker
      .getByRole("combobox", { name: "Provider", exact: true })
      .selectOption("claude");
    const row = picker.getByRole("button", { name: /invented image/i });
    await expect(row).toHaveAttribute("title", new RegExp(first.nativeId));
    await expect(row).not.toContainText("[Image 1]");
    await app.page.screenshot({
      path: info.outputPath("claude-native-session-picker.png"),
    });
    await row.click();
    await expect(composer()).toBeFocused();
    await expect(transcript()).toContainText(imageReply);
    expect((await current())?.nativeId).toBe(first.nativeId);
    expect(model.requests).toBe(calls);
    await composer().fill(followUp);
    await composer().press(`${modifier}+Enter`);
    await expect(transcript()).toContainText(followUpReply);
    await expect.poll(async () => (await current())?.status).toBe("ready");
    const resumed = (await current())!;
    expect(resumed.nativeId).toBe(first.nativeId);
    const users = resumed.messages.filter((message) => message.role === "user");
    expect(users).toHaveLength(2);
    expect(users[0].images?.[0]?.data).toBe(pixel);
    expect(users[0].text).toContain("[Image 1]");
    await expectImagePrompt();
    expect(model.previousImageSent).toBe(true);
    await app.page.screenshot({
      path: info.outputPath("claude-resumed-image-chat.png"),
    });
  } finally {
    try {
      await app.cleanup();
    } finally {
      await model.close();
    }
  }
});

test("A new chat keeps a native provider choice beside a browser during a shell refresh", async ({}, info) => {
  test.skip(process.platform !== "linux", "Uses X11 native menu input");
  const app = new ChatApp();
  const model = await loopbackModel("Bearer invented-switch-token");
  try {
    await app.prepare();
    await app.configure({ codex: {} });
    const executable = path.resolve(
      "node_modules",
      "@anthropic-ai",
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      "claude",
    );
    await access(executable);
    Object.assign(app.environment, {
      COD_CLAUDE_EXECUTABLE: executable,
      CLAUDE_CONFIG_DIR: path.join(app.temporary, "native-switch-claude"),
      ANTHROPIC_AUTH_TOKEN: "invented-switch-token",
      ANTHROPIC_BASE_URL: model.endpoint,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    await app.start();
    const workspace = await app.create("Invented split chat");
    await app.cli(
      "browser",
      "open",
      "--workspace",
      workspace,
      "--url",
      model.endpoint,
    );
    await app.command("New chat");
    await expect(app.page.locator(".browser-content:visible")).toHaveCount(1);
    const provider = () =>
      app.page.getByRole("button", { name: "Provider", exact: true });
    const composer = () =>
      app.page.getByRole("textbox", { name: "Message", exact: true });
    await expect(provider()).toContainText("Codex");
    await composer().fill("An invented unsent draft");
    await app.app!.evaluate(({ Menu }) => {
      const popup = Menu.prototype.popup;
      Menu.prototype.popup = function (options) {
        if (this.items.some((item) => item.label === "Claude Code")) {
          Object.assign(globalThis, { providerMenuShown: false });
          this.once("menu-will-show", () => {
            Object.assign(globalThis, { providerMenuShown: true });
          });
          const item = this.items.find(
            (entry) => entry.label === "Claude Code",
          )!;
          const click = item.click;
          item.click = (...args: unknown[]) => {
            Object.assign(globalThis, { providerMenuSelected: true });
            click.apply(item, args);
          };
        }
        return popup.call(this, options);
      };
    });
    await provider().focus();
    await app.page.keyboard.press("Enter");
    await expect
      .poll(() =>
        app.app!.evaluate(
          () =>
            (globalThis as typeof globalThis & { providerMenuShown?: boolean })
              .providerMenuShown,
        ),
      )
      .toBe(true);
    await app.cli(
      "workspace",
      "rename",
      "--id",
      workspace,
      "--name",
      "Invented split chat updated",
    );
    await expect(
      app.page.getByRole("button", { name: "Overview", exact: true }),
    ).toHaveText("Invented split chat updated");
    await execute("xdotool", [
      "key",
      "--delay",
      "80",
      "--clearmodifiers",
      "Home",
      "Down",
      "Down",
      "Return",
    ]);
    await expect
      .poll(() =>
        app.app!.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                providerMenuSelected?: boolean;
              }
            ).providerMenuSelected,
        ),
      )
      .toBe(true);
    await expect(provider()).toContainText("Claude Code");
    await expect(provider()).toBeFocused();
    await expect(composer()).toHaveAttribute(
      "placeholder",
      "Message Claude Code...",
    );
    await expect(composer()).toHaveValue("An invented unsent draft");
    await expect(
      app.page.getByRole("button", { name: "Model", exact: true }),
    ).toBeVisible();
    await app.page.screenshot({
      path: info.outputPath("claude-provider-next-to-browser.png"),
    });
    await app.stop();
    await app.start();
    await expect(provider()).toContainText("Claude Code");
    await expect(composer()).toHaveValue("An invented unsent draft");
    expect((await app.cli<AppState>("state")).conversations).toHaveLength(0);
    expect(await app.prompts()).toHaveLength(0);
    expect(model.requests).toBe(0);
  } finally {
    try {
      await app.cleanup();
    } finally {
      await model.close();
    }
  }
});

test("Claude composer picks native model and effort without sending, then restores the same chat choices", async ({}, info) => {
  test.skip(
    process.platform !== "linux",
    "Uses the isolated glibc native Claude runner",
  );
  test.setTimeout(90_000);
  const app = new WorkspaceApp();
  const model = await loopbackModel("Bearer invented-option-token");
  try {
    await app.prepare();
    const executable = path.resolve(
      "node_modules",
      "@anthropic-ai",
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      "claude",
    );
    await access(executable);
    const profile = path.join(app.temporary, "native-model-claude");
    for (const name of [
      "CLAUDECODE",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_EFFORT_LEVEL",
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "COD_CLAUDE_ARGS",
    ])
      delete app.environment[name];
    Object.assign(app.environment, {
      COD_CLAUDE_EXECUTABLE: executable,
      CLAUDE_CONFIG_DIR: profile,
      ANTHROPIC_AUTH_TOKEN: "invented-option-token",
      ANTHROPIC_BASE_URL: model.endpoint,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    await app.start();
    const workspace = await app.create("Invented model selection workspace");
    await app.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      app.folders[0],
    );
    const composer = () =>
      app.page.getByRole("textbox", { name: "Message", exact: true });
    const selector = (name: string) =>
      app.page.getByRole("button", { name, exact: true });
    const transcript = () =>
      app.page.getByRole("region", {
        name: "Conversation transcript",
        exact: true,
      });
    const imageDraft = firstPrompt + "[Image 1]";
    const choose = async (control: string, choice: string) => {
      await selector(control).click();
      await selector(choice).click();
      await expect(selector(control)).toBeFocused();
    };
    const conversation = async () =>
      (await app.cli<AppState>("state")).conversations.find(
        (c) => c.workspaceId === workspace,
      );

    await choose("Provider", "Claude Code");
    await expect(composer()).toHaveAttribute(
      "placeholder",
      "Message Claude Code...",
    );
    await composer().fill(firstPrompt);
    await composer().evaluate((node, data) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File(
          [Uint8Array.from(atob(data), (value) => value.charCodeAt(0))],
          "invented.png",
          { type: "image/png" },
        ),
      );
      node.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, pixel);
    await expect(app.page.locator(".composer-images img")).toHaveCount(1);
    await selector("Model").focus();
    await app.page.keyboard.press("Enter");
    await expect(selector("Sonnet")).toBeVisible();
    await app.page.screenshot({
      path: info.outputPath("claude-model-choice.png"),
    });
    await app.page.keyboard.press("Escape");
    await expect(selector("Model")).toBeFocused();
    await choose("Model", "Sonnet");
    await expect(selector("Model")).toContainText("Sonnet");
    await selector("Reasoning effort").click();
    await expect(selector("Low")).toBeVisible();
    await app.page.screenshot({
      path: info.outputPath("claude-effort-choice.png"),
    });
    await selector("Low").click();
    await expect(selector("Reasoning effort")).toBeFocused();
    await expect(selector("Reasoning effort")).toContainText("Low");
    await expect(composer()).toHaveValue(imageDraft);
    await expect(app.page.locator(".composer-images img")).toHaveCount(1);
    expect(model.requests).toBe(0);
    expect(await conversation()).toBeUndefined();
    await app.page.screenshot({
      path: info.outputPath("claude-composer-selections.png"),
    });
    await app.stop();
    await app.start();
    await expect(composer()).toHaveValue(imageDraft);
    await expect(app.page.locator(".composer-images img")).toHaveCount(1);
    await expect(selector("Model")).toContainText("Sonnet");
    await expect(selector("Reasoning effort")).toContainText("Low");
    expect(model.requests).toBe(0);
    await composer().press(`${modifier}+Enter`);
    await expect(transcript()).toContainText(imageReply);
    await expect.poll(async () => (await conversation())?.status).toBe("ready");
    const first = (await conversation())!;
    expect(
      first.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(model.imageSent).toBe(true);
    expect(
      model.turns.find(({ text }) => text.includes(firstPrompt)),
    ).toMatchObject({
      model: expect.stringMatching(/^claude-sonnet-/),
      effort: "low",
    });
    await choose("Reasoning effort", "High");
    await expect(selector("Reasoning effort")).toContainText("High");
    const calls = model.requests;
    await app.stop();
    await app.start();
    await expect(selector("Model")).toContainText("Sonnet");
    await expect(selector("Reasoning effort")).toContainText("High");
    expect(model.requests).toBe(calls);
    expect((await conversation())?.nativeId).toBe(first.nativeId);
    await composer().fill(followUp);
    await composer().press(`${modifier}+Enter`);
    await expect(transcript()).toContainText(followUpReply);
    await expect.poll(async () => (await conversation())?.status).toBe("ready");
    expect(
      model.turns.find(({ text }) => text.includes(followUp)),
    ).toMatchObject({
      model: expect.stringMatching(/^claude-sonnet-/),
      effort: "high",
    });
    const latest = (await conversation())!;
    expect(latest.nativeId).toBe(first.nativeId);
    expect(
      latest.messages.filter((message) => message.role === "user"),
    ).toHaveLength(2);
    expect(model.previousImageSent).toBe(true);
  } finally {
    try {
      await app.cleanup();
    } finally {
      await model.close();
    }
  }
});

test("Claude API authentication survives a desktop restart without exposing the token", async ({}, info) => {
  const linux = process.platform === "linux";
  test.skip(
    !(
      (process.platform === "darwin" &&
        process.env.COD_VERIFY_MACOS_KEYCHAIN === "1") ||
      (linux && process.env.COD_VERIFY_LINUX_KEYRING === "1")
    ),
    "Needs a disposable system keyring and a Playwright loader without its mock keyring switches",
  );
  test.setTimeout(90_000);
  const app = new WorkspaceApp();
  const token = "invented-cod-bearer";
  const model = await loopbackModel("Bearer " + token);
  try {
    await app.prepare();
    const executable = path.resolve(
      "node_modules",
      "@anthropic-ai",
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      "claude",
    );
    await access(executable);
    for (const name of [
      "CLAUDECODE",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "COD_CLAUDE_ARGS",
    ])
      delete app.environment[name];
    Object.assign(app.environment, {
      COD_CLAUDE_EXECUTABLE: executable,
      CLAUDE_CONFIG_DIR: path.join(app.temporary, "native-claude"),
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    await app.start();
    const assertRealKeyring = async () => {
      expect(
        await app.app!.evaluate(({ app }) => [
          app.commandLine.hasSwitch("use-mock-keychain"),
          app.commandLine.getSwitchValue("password-store") === "basic",
        ]),
      ).toEqual([false, false]);
    };
    await assertRealKeyring();
    const workspace = await app.create("Invented authentication workspace");
    await app.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      app.folders[0],
    );
    const settings = () =>
      app.page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
    const openApi = async () => {
      await app.page.keyboard.press(`${modifier}+Shift+P`);
      const commands = app.page.getByRole("dialog", {
        name: "Command palette",
        exact: true,
      });
      const filter = commands.getByRole("textbox", {
        name: "Filter commands",
        exact: true,
      });
      await filter.fill("Settings...");
      await filter.press("Enter");
      await settings()
        .getByRole("searchbox", { name: "Search settings" })
        .fill("Claude");
      await settings().getByText("API authentication", { exact: true }).click();
    };
    const url = () =>
      settings().getByRole("textbox", { name: "API URL", exact: true });
    const secret = () => settings().getByLabel("API token", { exact: true });
    await openApi();
    await expect(url()).toBeEnabled();
    await url().fill(model.endpoint);
    await expect(secret()).toHaveAttribute("type", "password");
    await secret().fill(token);
    await secret().press("Enter");
    await expect(
      settings()
        .getByRole("status")
        .filter({ hasText: "Saved for local Claude Code chats." }),
    ).toBeVisible();
    await expect(secret()).toHaveValue("");
    await expect(secret()).toBeFocused();
    await app.page.screenshot({
      path: info.outputPath("claude-api-saved.png"),
    });
    const routeFile = path.join(app.data, "claude-api.enc");
    const ciphertext = await readFile(routeFile);
    expect(ciphertext.includes(token)).toBe(false);
    if (linux) expect(ciphertext.toString("latin1", 0, 3)).toMatch(/^v1[12]$/);
    expect(
      JSON.stringify(await app.cli("settings", "get")).includes(token),
    ).toBe(false);
    await settings()
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await app.page
      .getByRole("button", { name: "Provider", exact: true })
      .click();
    await app.page
      .getByRole("button", { name: "Claude Code", exact: true })
      .click();
    const composer = () =>
      app.page.getByRole("textbox", { name: "Message", exact: true });
    const transcript = () =>
      app.page.getByRole("region", {
        name: "Conversation transcript",
        exact: true,
      });
    await composer().fill("An invented authentication test");
    await composer().press(`${modifier}+Enter`);
    await expect(transcript()).toContainText(imageReply);
    const current = async () =>
      (await app.cli<AppState>("state")).conversations.find(
        (conversation) => conversation.workspaceId === workspace,
      );
    await expect.poll(async () => (await current())?.status).toBe("ready");
    const first = (await current())!;
    const calls = model.requests;
    await app.stop();
    await app.start();
    await assertRealKeyring();
    await openApi();
    await expect(url()).toHaveValue(model.endpoint + "/");
    await expect(secret()).toHaveValue("");
    await settings()
      .getByRole("button", { name: "Close", exact: true })
      .click();
    expect(model.requests).toBe(calls);
    await composer().fill(followUp);
    await composer().press(`${modifier}+Enter`);
    await expect(transcript()).toContainText(followUpReply);
    await expect.poll(async () => (await current())?.status).toBe("ready");
    const latest = (await current())!;
    expect(latest.nativeId).toBe(first.nativeId);
    expect(
      latest.messages.filter((message) => message.role === "user"),
    ).toHaveLength(2);
    expect(JSON.stringify(latest).includes(token)).toBe(false);

    if (linux) {
      const keyringBus = app.environment.DBUS_SESSION_BUS_ADDRESS;
      expect(keyringBus).toBeTruthy();
      const missingKeyringBus = `unix:path=${path.join(app.temporary, "missing-keyring-bus")}`;
      await app.stop();
      app.environment.DBUS_SESSION_BUS_ADDRESS = missingKeyringBus;
      await app.start();
      await assertRealKeyring();
      // The pinned Electron returns true and encrypts with a known key when
      // the D-Bus session is missing. Test against the real fallback.
      const fallback = await app.app!.evaluate(async ({ safeStorage }) => {
        const available = await safeStorage.isAsyncEncryptionAvailable();
        const ciphertext =
          await safeStorage.encryptStringAsync("public fixture");
        return [available, ciphertext.toString("latin1", 0, 3)];
      });
      expect(fallback).toEqual([true, "v10"]);
      await openApi();
      await expect(
        settings()
          .getByRole("status")
          .filter({ hasText: "Unlock the system keyring" }),
      ).toBeVisible();
      await app.page.screenshot({
        path: info.outputPath("claude-api-locked.png"),
      });
      expect(await readFile(routeFile)).toEqual(ciphertext);
      await settings()
        .getByRole("button", { name: "Close", exact: true })
        .click();
      const recoveryDraft = "Continue from the invented saved draft";
      const callsBeforeRetry = model.requests;
      await composer().fill(recoveryDraft);
      await composer().press(`${modifier}+Enter`);
      await expect(
        app.page.getByText(/Unlock the system keyring/).first(),
      ).toBeVisible();
      await expect(composer()).toHaveValue(recoveryDraft);
      expect(model.requests).toBe(callsBeforeRetry);
      expect(
        (await current())?.messages.filter(
          (message) => message.role === "user",
        ),
      ).toHaveLength(2);
      await app.stop();
      app.environment.DBUS_SESSION_BUS_ADDRESS = keyringBus;
      await app.start();
      await expect(composer()).toHaveValue(recoveryDraft);
      expect(model.requests).toBe(callsBeforeRetry);
      await composer().press(`${modifier}+Enter`);
      await expect.poll(() => model.requests).toBe(callsBeforeRetry + 1);
      await expect(composer()).toHaveValue("");
      await expect.poll(async () => (await current())?.status).toBe("ready");
      const recovered = (await current())!;
      expect(recovered.nativeId).toBe(first.nativeId);
      expect(
        recovered.messages.filter((message) => message.role === "user"),
      ).toHaveLength(3);

      await app.stop();
      app.environment.DBUS_SESSION_BUS_ADDRESS = missingKeyringBus;
      await app.start();
      await openApi();
      await settings()
        .getByRole("button", { name: "Remove saved authentication" })
        .click();
      await expect(
        settings()
          .getByRole("status")
          .filter({ hasText: "A system keyring is unavailable" }),
      ).toBeVisible();
      await expect(url()).toBeHidden();
      await app.page.screenshot({
        path: info.outputPath("claude-api-unavailable.png"),
      });
      expect(
        await app.page.evaluate(async () => {
          try {
            await window.cod.claudeApiSettings({
              action: "save",
              endpoint: "https://gateway.example/",
              token: "invented-fallback-token",
            });
            return false;
          } catch {
            return true;
          }
        }),
      ).toBe(true);
      await expect
        .poll(() =>
          access(routeFile).then(
            () => true,
            () => false,
          ),
        )
        .toBe(false);
    }
  } finally {
    try {
      await app.cleanup();
    } finally {
      await model.close();
    }
  }
});
