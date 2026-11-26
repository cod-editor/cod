import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { AppState } from "../../src/types";
import { modifier, WorkspaceApp } from "./helpers/workspace-app";

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
const firstPrompt = "Name the invented image";
const imageReply = "The invented pixel is green.";
const followUp = "What did the previous prompt contain?";
const followUpReply = "The previous prompt included an image.";

async function loopbackModel() {
  let requests = 0;
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
    const block = { type: "text", text: answer };
    if (!body.stream)
      return reply({ ...message, content: [block], stop_reason: "end_turn" });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, value: object = {}) =>
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
      );
    send("message_start", { message });
    send("content_block_start", {
      index: 0,
      content_block: { ...block, text: "" },
    });
    send("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: answer },
    });
    send("content_block_stop", { index: 0 });
    send("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
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
    const input = app.page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await app.page
      .getByRole("button", { name: "Provider", exact: true })
      .click();
    await app.page
      .getByRole("button", { name: "Claude Code", exact: true })
      .click();
    await expect(input).toHaveAttribute(
      "placeholder",
      "Message Claude Code...",
    );
    expect(model.requests).toBe(0);
    await input.fill(firstPrompt);
    await input.evaluate((node, data) => {
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
    await input.press(`${modifier}+Enter`);
    const transcript = app.page.getByRole("region", {
      name: "Conversation transcript",
      exact: true,
    });
    await expect(transcript).toContainText(imageReply);
    await expect(input).toHaveValue("");
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
    await app.page.screenshot({
      path: info.outputPath("claude-native-session-picker.png"),
    });
    await row.click();
    await expect(input).toBeFocused();
    await expect(transcript).toContainText(imageReply);
    expect((await current())?.nativeId).toBe(first.nativeId);
    expect(model.requests).toBe(calls);
    await input.fill(followUp);
    await input.press(`${modifier}+Enter`);
    await expect(transcript).toContainText(followUpReply);
    await expect.poll(async () => (await current())?.status).toBe("ready");
    const resumed = (await current())!;
    expect(resumed.nativeId).toBe(first.nativeId);
    const users = resumed.messages.filter((message) => message.role === "user");
    expect(users).toHaveLength(2);
    expect(users[0].images?.[0]?.data).toBe(pixel);
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
