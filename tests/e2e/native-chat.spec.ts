import { test, expect, type Locator } from "@playwright/test";
import type { AppState, ConversationState } from "../../src/types";
import { createServer } from "node:http";
import path from "node:path";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import {
  ChatApp,
  type Chat,
  type Provider,
} from "./helpers/chat-fixture/harness";
import { modifier, tabTo } from "./helpers/workspace-app";
import {
  createCodexAdapter,
  createKimiAdapter,
} from "../../src/providers/index";

// These exercise real Electron and native-protocol subprocesses, not live model access.
// AC6 requires a separately recorded authenticated Codex/Kimi app + native CLI run.
let shell: ChatApp;
test.beforeEach(async () => {
  shell = new ChatApp();
  await shell.prepare();
  await shell.start();
});
test.afterEach(async () => {
  await shell?.cleanup();
});
const transcript = (chat: { paneId: string }) =>
  shell
    .pane(chat.paneId)
    .getByRole("region", { name: "Conversation transcript", exact: true });
async function expandActivity(pane: Locator) {
  for (const activity of await pane.locator("details.turn-activity").all())
    if ((await activity.getAttribute("open")) === null)
      await activity.locator(":scope > summary").click();
}
const status = (id: string) => shell.inspect(id).then((chat) => chat.status);
const text = (chat: Chat) =>
  chat.messages.map((message) => message.text).join("\n");

test("Collapsed tool history does not materialize output until expanded", async () => {
  await shell.configure({ codex: { reasoningOptions: true } });
  const workspace = await shell.create("Long tool history");
  const chat = await shell.newChat(workspace, "codex");
  await shell.stop();
  const stateFile = path.join(shell.data, "state.json");
  const saved = JSON.parse(await readFile(stateFile, "utf8")) as AppState;
  const importedId = "codex-fixture-large-import";
  saved.conversations.find((c) => c.id === chat.id)!.nativeId = importedId;
  await writeFile(stateFile, JSON.stringify(saved));
  await writeFile(
    path.join(shell.recording + ".sessions", importedId + ".json"),
    JSON.stringify([
      {
        id: "large-turn",
        status: "completed",
        items: Array.from({ length: 400 }, (_, index) => ({
          id: `large-tool-${index}`,
          type: "commandExecution",
          command: "echo invented",
          status: "completed",
          aggregatedOutput: "invented-output ".repeat(100),
        })),
      },
    ]),
  );
  await shell.start();
  await shell.cli("conversation", "show", "--id", chat.id);
  await expect
    .poll(() =>
      shell.page.evaluate(
        async (id) =>
          (
            await window.cod.invoke<ConversationState>({
              op: "conversation.inspect",
              id,
            })
          ).tools.length,
        chat.id,
      ),
    )
    .toBe(400);
  const pane = shell.pane(chat.paneId);
  await expect(pane.locator(".tool-activity")).toHaveCount(60);
  await expect(pane.locator(".tool-activity pre")).toHaveCount(0);
  await pane
    .getByRole("button", { name: "Earlier messages", exact: true })
    .click();
  await expect
    .poll(() => pane.locator(".tool-activity").count())
    .toBeGreaterThan(60);
  await expect(pane.locator(".tool-activity pre")).toHaveCount(0);
  await expandActivity(pane);
  const tool = pane.locator(".tool-activity").first();
  await tool.locator("summary").click();
  await expect(tool.locator("pre")).toContainText("invented-output");
  await expect(pane.locator(".tool-activity pre")).toHaveCount(1);
  await tool.locator("summary").click();
  await expect(pane.locator(".tool-activity pre")).toHaveCount(0);
});

test("Failed opening cannot leave stale composer handlers when a pane is reused", async () => {
  const workspace = await shell.create("Composer recovery");
  const paneId = (await shell.workspace(workspace)).activePaneId;
  await shell.configure({
    codex: { initializeDelayMs: 600, initializeError: true },
  });
  const failed = shell.raw(
    "conversation",
    "resume",
    "--workspace",
    workspace,
    "--provider",
    "codex",
    "--native-id",
    "fixture-failed-resume",
    "--cwd",
    shell.folders[0],
  );
  await expect(
    shell
      .pane(paneId)
      .getByRole("status", { name: "Conversation status", exact: true }),
  ).toContainText("Starting");
  expect((await failed).code).not.toBe(0);
  await shell.configure({});
  const chat = await shell.newChat(workspace, "codex");
  expect(chat.paneId).toBe(paneId);
  const composer = shell
    .pane(paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  const prompt = "A long invented draft with attachments. ".repeat(80);
  await composer.fill(prompt);
  await composer.evaluate((input) => {
    const data = new DataTransfer();
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    );
    data.items.add(new File([png], "invented.png", { type: "image/png" }));
    input.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
    );
  });
  await expect
    .poll(async () => {
      const state = await shell.cli<AppState>("state");
      const draft = state.workspaces.find((w) => w.id === workspace)
        ?.chatDrafts?.[paneId];
      return { text: draft?.text, images: draft?.images?.length };
    })
    .toEqual({ text: prompt + "[Image 1]", images: 1 });
  const other = await shell.newChat(workspace, "codex");
  await shell.send(other.id, "Unrelated conversation");
  await shell.cli("conversation", "show", "--id", chat.id);
  await expect(composer).toHaveValue(prompt + "[Image 1]");
  await expect(shell.pane(paneId).locator(".composer-images img")).toHaveCount(
    1,
  );
  await shell.stop();
  await shell.start();
  await expect(
    shell.pane(paneId).getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue(prompt + "[Image 1]");
  await expect(shell.pane(paneId).locator(".composer-images img")).toHaveCount(
    1,
  );
  await shell
    .pane(paneId)
    .getByRole("textbox", { name: "Message", exact: true })
    .press(`${modifier}+Enter`);
  await expect
    .poll(async () =>
      (await shell.inspect(chat.id)).messages.some(
        (m) => m.role === "user" && m.text === prompt + "[Image 1]",
      ),
    )
    .toBe(true);
});

for (const provider of ["codex", "kimi"] as Provider[]) {
  test(`Chat AC1 ${provider}: UI creates native conversation and streams assistant/tool activity`, async () => {
    const workspace = await shell.create(`${provider} UI task`);
    await shell.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      shell.folders[0],
    );
    const draftPane = shell.pane(
      (await shell.workspace(workspace)).activePaneId,
    );
    await draftPane
      .getByRole("button", { name: "Provider", exact: true })
      .click();
    await shell.page
      .getByRole("button", {
        name: provider === "codex" ? "Codex" : "Kimi",
        exact: true,
      })
      .click();
    const input = draftPane.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await input.fill("unique-ui-turn");
    await input.press(`${modifier}+Enter`);
    await expect
      .poll(
        async () =>
          (await shell.cli<{ conversations: Chat[] }>("state")).conversations
            .length,
      )
      .toBe(1);
    const state = await shell.cli<{ conversations: Chat[] }>("state");
    expect(state.conversations).toHaveLength(1);
    const chat = state.conversations[0];
    expect(chat.provider).toBe(provider);
    await expect
      .poll(async () => (await shell.inspect(chat.id)).nativeId)
      .toMatch(new RegExp(`^${provider}-fixture-`));
    const pane = shell.pane(chat.paneId);
    await expect.poll(() => status(chat.id)).toBe("working");
    await expect(transcript(chat)).toContainText("STREAM unique-ui-turn");
    await expect.poll(() => status(chat.id)).toBe("ready");
    await expect(transcript(chat)).toContainText("DONE unique-ui-turn");
    await expect(transcript(chat)).not.toContainText("FOREIGN_OUTPUT");
    expect((await shell.inspect(chat.id)).tools.length).toBeGreaterThan(0);
    await expandActivity(pane);
    await pane.locator(".tool-activity").first().locator("summary").click();
    await expect(pane.getByText(/invented-tool/).first()).toBeVisible();
  });
}

test("Chat AC2 routes background streams and permissions without stealing foreground focus", async () => {
  const firstWorkspace = await shell.create("Background Codex");
  const codex = await shell.newChat(firstWorkspace, "codex");
  const secondWorkspace = await shell.create("Foreground Kimi");
  const kimi = await shell.newChat(secondWorkspace, "kimi");
  const foreground = await shell.workspace(secondWorkspace);
  const draft = shell
    .pane(kimi.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Unsent composer draft");
  for (let index = 0; index < 5; index++) await draft.press("ArrowLeft");
  await draft.press("Shift+ArrowLeft");
  const draftSelection = await draft.evaluate((element) => ({
    start: (element as HTMLTextAreaElement).selectionStart,
    end: (element as HTMLTextAreaElement).selectionEnd,
  }));
  await Promise.all([
    shell.send(codex.id, "[approve] background-only"),
    shell.send(kimi.id, "[approve] foreground-only"),
  ]);
  await expect.poll(() => status(codex.id)).toBe("waiting");
  await expect.poll(() => status(kimi.id)).toBe("waiting");
  const first = await shell.inspect(codex.id),
    second = await shell.inspect(kimi.id);
  expect(text(first)).toContain("background-only");
  expect(text(first)).not.toContain("foreground-only");
  expect(text(second)).toContain("foreground-only");
  expect(text(second)).not.toContain("background-only");
  expect(first.pendingPermissions).toHaveLength(1);
  expect(second.pendingPermissions).toHaveLength(1);
  await expect(draft).toHaveValue("Unsent composer draft");
  await expect(draft).toBeFocused();
  expect(
    await draft.evaluate((element) => ({
      start: (element as HTMLTextAreaElement).selectionStart,
      end: (element as HTMLTextAreaElement).selectionEnd,
    })),
  ).toEqual(draftSelection);
  expect((await shell.state()).activeWorkspaceId).toBe(secondWorkspace);
  expect((await shell.workspace(secondWorkspace)).activePaneId).toBe(
    foreground.activePaneId,
  );
  // Both adapters may use permission-1; conversation identity must disambiguate it.
  const permission = first.pendingPermissions[0];
  const deny = permission.options.find((option) => option.label === "Deny")!;
  await shell.cli(
    "conversation",
    "permission",
    "--id",
    codex.id,
    "--request-id",
    permission.id,
    "--option-id",
    deny.id,
  );
  await expect.poll(() => status(codex.id)).toBe("ready");
  expect((await shell.inspect(kimi.id)).pendingPermissions).toEqual(
    second.pendingPermissions,
  );
  expect((await shell.state()).activeWorkspaceId).toBe(secondWorkspace);
  await expect(transcript(kimi)).not.toContainText("background-only");
  await shell
    .pane(kimi.paneId)
    .getByRole("button", { name: "Allow once", exact: true })
    .click();
  await expect.poll(() => status(kimi.id)).toBe("ready");
  await expect(transcript(kimi)).toContainText(
    "ALLOWED [approve] foreground-only",
  );
  expect(text(await shell.inspect(codex.id))).toContain(
    "DENIED [approve] background-only",
  );
});

for (const provider of ["codex", "kimi"] as Provider[]) {
  test(`Chat AC3/AC5 ${provider}: keyboard approvals, interruption and crash recovery`, async () => {
    const workspace = await shell.create(`${provider} controls`);
    const chat = await shell.newChat(workspace, provider);
    const pane = shell.pane(chat.paneId);
    const composer = pane.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await tabTo(shell.page, composer);
    await shell.page.keyboard.type("[approve] keyboard-permission");
    await shell.page.keyboard.press(`${modifier}+Enter`);
    await expect.poll(() => status(chat.id)).toBe("waiting");
    const waiting = await shell.inspect(chat.id);
    expect(waiting.pendingPermissions).toHaveLength(1);
    expect(text(waiting)).not.toContain("ALLOWED");
    const queued = await shell.cli<{ messageId: string }>(
      "conversation",
      "send",
      "--id",
      chat.id,
      "--text",
      "concurrent-turn",
    );
    expect(
      (
        (await shell.inspect(chat.id)) as Chat & {
          queuedMessages: Array<{ id: string; text: string }>;
        }
      ).queuedMessages,
    ).toContainEqual(
      expect.objectContaining({
        id: queued.messageId,
        text: "concurrent-turn",
      }),
    );
    await shell.cli(
      "conversation",
      "queue-remove",
      "--id",
      chat.id,
      "--message-id",
      queued.messageId,
    );
    expect(
      (
        await shell.raw(
          "conversation",
          "permission",
          "--id",
          chat.id,
          "--request-id",
          "unknown",
          "--option-id",
          "unknown",
        )
      ).code,
    ).not.toBe(0);
    expect((await shell.inspect(chat.id)).pendingPermissions).toEqual(
      waiting.pendingPermissions,
    );
    await tabTo(
      shell.page,
      pane.getByRole("button", { name: "Allow once", exact: true }),
    );
    await shell.page.keyboard.press("Enter");
    await expect.poll(() => status(chat.id)).toBe("ready");
    await expect(transcript(chat)).toContainText(
      "ALLOWED [approve] keyboard-permission",
    );
    await shell.send(chat.id, "[hold] cancel-me");
    await expect(transcript(chat)).toContainText("STREAM [hold] cancel-me");
    await tabTo(
      shell.page,
      pane.getByRole("button", { name: "Stop", exact: true }),
    );
    await shell.page.keyboard.press("Enter");
    await expect.poll(() => status(chat.id)).toBe("ready");
    await expect(
      pane.getByText(/cancelled|interrupted/i).first(),
    ).toBeVisible();
    await expect(transcript(chat)).not.toContainText("DONE [hold] cancel-me");
    await shell.send(chat.id, "[crash] invented-failure");
    await expect.poll(() => status(chat.id)).toBe("failed");
    const failure = pane.getByRole("status", {
      name: "Conversation status",
      exact: true,
    });
    await expect(failure).toBeVisible();
    await expect(failure).toContainText("Provider failed:");
    await shell.send(chat.id, "explicit-recovery");
    await expect.poll(() => status(chat.id)).toBe("ready");
    expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
    await expect(transcript(chat)).toContainText("DONE explicit-recovery");
  });
}

for (const provider of ["codex", "kimi"] as Provider[]) {
  test(`Chat AC4 ${provider}: restart preserves native identity without replaying inference`, async () => {
    const workspace = await shell.create(`${provider} restart`);
    const chat = await shell.newChat(workspace, provider);
    await shell.send(chat.id, "finished-before-restart");
    await expect.poll(() => status(chat.id)).toBe("ready");
    await shell.send(chat.id, "[hold] interrupted-by-shutdown");
    await expect(transcript(chat)).toContainText(
      "STREAM [hold] interrupted-by-shutdown",
    );
    const promptsBefore = await shell.prompts();
    expect(promptsBefore).toHaveLength(2);
    await shell.stop();
    await shell.start();
    const restored = await shell.inspect(chat.id);
    expect(restored.nativeId).toBe(chat.nativeId);
    expect(restored.status).toBe("failed");
    expect(text(restored)).toContain("DONE finished-before-restart");
    expect(text(restored)).not.toContain("DONE [hold] interrupted-by-shutdown");
    await expect(
      shell
        .pane(chat.paneId)
        .getByText(/interrupted|restart|stopped|shutdown/i)
        .first(),
    ).toBeVisible();
    // Check both initial startup and a bounded idle interval for unintended provider prompts.
    expect(await shell.prompts()).toEqual(promptsBefore);
    await shell.page.waitForTimeout(500);
    expect(await shell.prompts()).toEqual(promptsBefore);
    await shell.send(chat.id, "after-explicit-resume");
    await expect.poll(() => status(chat.id)).toBe("ready");
    expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
    await expect(transcript(chat)).toContainText("DONE after-explicit-resume");
    const records = await shell.records();
    const resume = records.find(
      (record) =>
        record.message?.method ===
        (provider === "codex" ? "thread/resume" : "session/load"),
    );
    expect(
      resume?.message?.params?.[
        provider === "codex" ? "threadId" : "sessionId"
      ],
    ).toBe(chat.nativeId);
    const promptsAfterResume = await shell.prompts();
    const bindingsBeforeRefocus = records.filter(
      (record) =>
        record.message?.method ===
        (provider === "codex" ? "thread/resume" : "session/load"),
    ).length;
    const refocused = await shell.cli<{
      id: string;
      paneId: string;
      nativeId: string;
    }>(
      "conversation",
      "resume",
      "--workspace",
      workspace,
      "--provider",
      provider,
      "--cwd",
      shell.folders[0],
      "--native-id",
      chat.nativeId,
    );
    expect(refocused).toEqual({
      id: chat.id,
      paneId: chat.paneId,
      nativeId: chat.nativeId,
    });
    expect((await shell.cli<AppState>("state")).conversations).toHaveLength(1);
    expect(
      (await shell.records()).filter(
        (record) =>
          record.message?.method ===
          (provider === "codex" ? "thread/resume" : "session/load"),
      ),
    ).toHaveLength(bindingsBeforeRefocus);
    expect(await shell.prompts()).toEqual(promptsAfterResume);
  });
}

test("Chat AC5 denies untrusted web-content chat invocation without starting a provider", async () => {
  const workspace = await shell.create("Untrusted chat boundary");
  const before = await shell.cli("state");
  const records = await shell.records();
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Invented untrusted page</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server missing address");
  try {
    const denied = await shell.app!.evaluate(
      async ({ BrowserWindow }, { url, preload, workspace, cwd }) => {
        const attacker = new BrowserWindow({
          show: false,
          webPreferences: {
            preload,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        try {
          await attacker.loadURL(url);
          return await attacker.webContents.executeJavaScript(
            `(async()=>{if(!window.cod?.invoke)return true;try{await window.cod.invoke(${JSON.stringify({ op: "conversation.create", workspace, provider: "codex", cwd })});return false;}catch{return true;}})()`,
          );
        } finally {
          attacker.destroy();
        }
      },
      {
        url: `http://127.0.0.1:${address.port}`,
        preload: path.join(shell.root, "dist/preload.cjs"),
        workspace,
        cwd: shell.folders[0],
      },
    );
    expect(denied).toBe(true);
    expect(await shell.cli("state")).toEqual(before);
    expect(await shell.records()).toEqual(records);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

for (const provider of ["codex", "kimi"] as Provider[]) {
  test(`Chat native history ${provider}: attach external session with user/assistant/tool history and no new inference`, async () => {
    const factory =
      provider === "codex" ? createCodexAdapter : createKimiAdapter;
    const adapter = factory({
      cwd: shell.folders[0],
      executable: process.execPath,
      args: JSON.parse(shell.environment[`COD_${provider.toUpperCase()}_ARGS`]),
      env: shell.environment,
    });
    let nativeId: string;
    const prompt = "external repeated history question";
    try {
      nativeId = (await adapter.create()).nativeId;
      await adapter.send(prompt);
      await adapter.send(prompt);
    } finally {
      await adapter.dispose();
    }
    const sentBefore = await shell.prompts();
    expect(sentBefore).toHaveLength(2);
    const workspace = await shell.create(`External ${provider} native history`);
    const attached = await shell.cli<{
      id: string;
      paneId: string;
      nativeId: string;
    }>(
      "conversation",
      "resume",
      "--workspace",
      workspace,
      "--provider",
      provider,
      "--cwd",
      shell.folders[0],
      "--native-id",
      nativeId!,
    );
    expect(attached.nativeId).toBe(nativeId!);
    const restored = await shell.inspect(attached.id);
    expect(restored.status).toBe("ready");
    expect(
      restored.messages.filter(
        (message) => message.role === "user" && message.text === prompt,
      ),
    ).toHaveLength(2);
    const assistant = restored.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.text)
      .join("\n");
    expect(assistant.split(`DONE ${prompt}`).length - 1).toBe(2);
    expect(restored.tools.length).toBeGreaterThanOrEqual(2);
    await expect(transcript(attached)).toContainText(prompt);
    await expect(transcript(attached)).toContainText(`DONE ${prompt}`);
    await expandActivity(shell.pane(attached.paneId));
    const historyTool = shell
      .pane(attached.paneId)
      .locator(".tool-activity")
      .first();
    if (await historyTool.count()) await historyTool.locator("summary").click();
    await expect(
      shell
        .pane(attached.paneId)
        .getByText(/invented-tool/)
        .first(),
    ).toBeVisible();
    expect(await shell.prompts()).toEqual(sentBefore);
  });
}

test("Chat failure isolation: slow failed create/resume retains another conversation's stream, tools and approval", async () => {
  const workspace = await shell.create("Failure isolation");
  const survivor = await shell.newChat(workspace, "codex");
  await shell.configure({
    kimi: { initializeDelayMs: 1000, initializeError: true },
  });
  for (const action of ["create", "resume"]) {
    const prompt = `[approve] survivor-during-${action}`;
    await shell.send(survivor.id, prompt);
    const failure = shell.raw(
      "conversation",
      action,
      "--workspace",
      workspace,
      "--provider",
      "kimi",
      "--cwd",
      shell.folders[0],
      ...(action === "resume"
        ? ["--native-id", "kimi-fixture-known-failure"]
        : []),
    );
    await expect(transcript(survivor)).toContainText(`STREAM ${prompt}`);
    await expect(
      shell
        .pane(survivor.paneId)
        .getByRole("button", { name: "Allow once", exact: true }),
    ).toBeVisible();
    expect((await failure).code).not.toBe(0);
    const kept = await shell.inspect(survivor.id);
    expect(kept.status).toBe("waiting");
    expect(text(kept)).toContain(`STREAM ${prompt}`);
    expect(kept.tools.length).toBeGreaterThan(0);
    expect(kept.pendingPermissions).toHaveLength(1);
    const permission = kept.pendingPermissions[0];
    await shell.cli(
      "conversation",
      "permission",
      "--id",
      survivor.id,
      "--request-id",
      permission.id,
      "--option-id",
      permission.options.find((option) => option.label === "Deny")!.id,
    );
    await expect.poll(() => status(survivor.id)).toBe("ready");
    await expect(transcript(survivor)).toContainText(`DENIED ${prompt}`);
  }
});

test("Chat close race: workspace removal cancels a pending resumed controller before inference", async () => {
  const workspace = await shell.create("Pending controller close");
  const chat = await shell.newChat(workspace, "kimi");
  await shell.send(chat.id, "before-close-race");
  await expect.poll(() => status(chat.id)).toBe("ready");
  // Keep target background so UI model discovery cannot preinitialize it.
  await shell.create("Unrelated foreground draft");
  await shell.stop();
  // Exercise the real asynchronous executable lookup, before controllers.set.
  // Every PATH candidate is invented; the final executable is our Node fixture.
  const bin = path.join(shell.temporary, "fixture-bin");
  await mkdir(bin);
  await symlink(process.execPath, path.join(bin, "kimi"));
  delete shell.environment.COD_KIMI_EXECUTABLE;
  shell.environment.PATH = [
    ...Array.from({ length: 1024 }, (_, index) =>
      path.join(shell.temporary, `absent-${index}`),
    ),
    bin,
  ].join(path.delimiter);
  await shell.start();
  const baseline = (await shell.records()).length;
  const connect = async () => {
    const socket = createConnection(shell.socket);
    socket.setEncoding("utf8");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const response = new Promise<{
      ok: boolean;
      result?: unknown;
      error?: string;
    }>((resolve, reject) => {
      let data = "";
      socket.on("error", reject);
      socket.setTimeout(10000, () =>
        socket.destroy(new Error("Socket request timeout")),
      );
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("\n")) {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          } finally {
            socket.destroy();
          }
        }
      });
    });
    return { socket, response };
  };
  const send = await connect(),
    close = await connect();
  try {
    send.socket.write(
      JSON.stringify({
        op: "conversation.send",
        id: chat.id,
        text: "must-not-run-after-close",
      }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 1));
    close.socket.write(
      JSON.stringify({ op: "workspace.close", id: workspace, force: true }) +
        "\n",
    );
    const [, closed] = await Promise.all([send.response, close.response]);
    expect(closed.ok).toBe(true);
    const state = await shell.cli<{ conversations: Chat[] }>("state");
    expect(state.conversations.some((item) => item.id === chat.id)).toBe(false);
    await shell.page.waitForTimeout(300);
    const subsequent = (await shell.records()).slice(baseline);
    expect(
      subsequent.filter(
        (record) => record.message?.method === "session/prompt",
      ),
    ).toHaveLength(0);
    for (const record of subsequent.filter(
      (record) => record.event === "started",
    )) {
      let alive = true;
      try {
        process.kill(record.pid!, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        else throw error;
      }
      expect(
        alive,
        "Closed conversation left an owned controller running",
      ).toBe(false);
    }
  } finally {
    send.socket.destroy();
    close.socket.destroy();
    for (const record of (await shell.records())
      .slice(baseline)
      .filter((record) => record.event === "started")) {
      try {
        process.kill(record.pid!, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
});

test("Chat Codex partial history avoids duplicate/reordered cached items and preserves live tool boundaries", async () => {
  const workspace = await shell.create("Partial history fixture");
  const chat = await shell.newChat(workspace, "codex");
  const original = "original-native-items";
  await shell.send(chat.id, original);
  await expect.poll(() => status(chat.id)).toBe("ready");
  const live = await shell.inspect(chat.id);
  expect(
    live.messages.filter((message) => message.role === "assistant"),
  ).toHaveLength(2);
  await expandActivity(shell.pane(chat.paneId));
  const liveTool = shell.pane(chat.paneId).locator(".tool-activity").first();
  if (await liveTool.count()) await liveTool.locator("summary").click();
  const ordered = await shell.cli<ConversationState>(
    "conversation",
    "inspect",
    "--id",
    chat.id,
  );
  expect(
    ordered.messages.find((m) => m.text.includes(`STREAM ${original}`))!.order,
  ).toBeLessThan(ordered.tools[0].order);
  expect(ordered.tools[0].order).toBeLessThan(
    ordered.messages.find((m) => m.text.includes(`DONE ${original}`))!.order,
  );
  await expect(transcript(chat).locator(".turn-activity")).toHaveCount(1);
  await expect(liveTool).toContainText("invented-tool");
  await shell.stop();
  await shell.configure({ codex: { partialTail: true } });
  await shell.start();
  await shell.send(chat.id, "[hold] after-partial-load");
  await expect(transcript(chat)).toContainText(
    "STREAM [hold] after-partial-load",
  );
  const restored = await inspectQueuedChat(chat.id);
  const assistant = restored.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("\n");
  expect(assistant.split(`DONE ${original}`).length - 1).toBe(1);
  await expandActivity(shell.pane(chat.paneId));
  const rendered = await transcript(chat).innerText();
  expect(rendered.indexOf(`DONE ${original}`)).toBeLessThan(
    rendered.indexOf("[hold] after-partial-load"),
  );
  await expect(
    shell
      .pane(chat.paneId)
      .getByText("Earlier messages are not shown", { exact: true }),
  ).toBeVisible();
  expect(
    restored.messages.filter((message) =>
      message.text.includes(`STREAM ${original}`),
    ),
  ).toHaveLength(1);
  expect(rendered.indexOf(`STREAM ${original}`)).toBeLessThan(
    rendered.indexOf(`DONE ${original}`),
  );
  expect(
    restored.tools.filter((tool) => tool.id === ordered.tools[0].id),
  ).toHaveLength(1);
});

test("Chat Codex earlier native pages preserve focus, retry and render overlapping items once", async () => {
  const workspace = await shell.create("Earlier native history");
  const nativeId = "codex-fixture-older-items";
  const nativeHistory = shell.recording + ".sessions";
  await mkdir(nativeHistory, { recursive: true });
  const assistant = (id: string, text: string) => ({
    id,
    type: "agentMessage",
    text,
  });
  await writeFile(
    path.join(nativeHistory, nativeId + ".json"),
    JSON.stringify([
      {
        id: "older-turn",
        status: "completed",
        items: [
          {
            id: "old-question",
            type: "userMessage",
            content: [{ type: "text", text: "Earlier fixture prompt" }],
          },
          {
            id: "old-command",
            type: "commandExecution",
            command: "earlier fixture command",
            status: "completed",
          },
          assistant("old-answer", "Earlier fixture answer"),
        ],
      },
      {
        id: "latest-turn",
        status: "completed",
        items: [
          {
            id: "new-question",
            type: "userMessage",
            content: [{ type: "text", text: "Latest fixture prompt" }],
          },
          assistant("new-answer", "Latest fixture answer"),
        ],
      },
    ]),
  );
  await shell.configure({
    codex: { pagedHistory: true, earlierHistoryError: true },
  });
  const chat = await shell.cli<{ id: string; paneId: string }>(
    "conversation",
    "resume",
    "--workspace",
    workspace,
    "--provider",
    "codex",
    "--cwd",
    shell.folders[0],
    "--native-id",
    nativeId,
  );
  const view = transcript(chat);
  const pane = shell.pane(chat.paneId);
  const earlier = view.getByRole("button", {
    name: "Earlier messages",
    exact: true,
  });
  const composer = pane.getByRole("textbox", { name: "Message", exact: true });
  await expect(view).toContainText("Latest fixture answer");
  await expect(view).not.toContainText("Earlier fixture prompt");
  await composer.fill("Preserved draft");
  await earlier.click();
  await expect(pane.getByRole("alert")).toContainText(
    "Invented history page failure",
  );
  await expect(
    view.getByText("Latest fixture answer", { exact: true }),
  ).toHaveCount(1);
  await expect(earlier).toBeVisible();

  await shell.configure({
    codex: { pagedHistory: true, earlierHistoryDelayMs: 350 },
  });
  await earlier.click();
  await expect(earlier).toHaveAttribute("aria-busy", "true");
  await composer.focus();
  await composer.press("End");
  await composer.press("!");
  await expect(view).toContainText("Earlier fixture answer");
  await expect(view).not.toContainText("Earlier fixture prompt");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("Preserved draft!");

  await earlier.click();
  await expect(view).toContainText("Earlier fixture prompt");
  await expect(earlier).toHaveCount(0);
  await expect(view.getByText("Earlier messages are not shown")).toHaveCount(0);
  const restored = await shell.inspect(chat.id);
  expect(restored.messages.map((message) => message.text)).toEqual([
    "Earlier fixture prompt",
    "Earlier fixture answer",
    "Latest fixture prompt",
    "Latest fixture answer",
  ]);
  expect(restored.tools).toHaveLength(1);
  expect(await shell.prompts()).toEqual([]);
  const pages = (await shell.records()).filter(
    (record) => record.message?.method === "thread/items/list",
  );
  expect(pages.map((record) => record.message?.params?.cursor)).toEqual([
    "fixture-items-0",
    "fixture-items-0",
    "fixture-items-3",
  ]);
});

async function removalMenu(id: string) {
  const overview = await shell.overview();
  const row = overview.locator(
    `.overview-item[data-navigation-key="conversation:${id}"]`,
  );
  const search = overview.getByRole("combobox");
  await search.focus();
  const offset = await row.evaluate((target) => {
    const rows = [
      ...target
        .closest(".overview-list")!
        .querySelectorAll(".overview-item:not([hidden])"),
    ];
    return (
      rows.indexOf(target) -
      rows.findIndex((item) => item.getAttribute("aria-current") === "true")
    );
  });
  for (let step = 0; step < Math.abs(offset); step++)
    await search.press(offset < 0 ? "ArrowUp" : "ArrowDown");
  await expect(row).toHaveAttribute("aria-current", "true");
  await search.press("Shift+F10");
  const menu = shell.page.getByRole("dialog", { name: "Actions", exact: true });
  await expect(menu).toBeVisible();
  return menu.getByRole("button", {
    name: "Remove from workspace",
    exact: true,
  });
}

for (const provider of ["codex", "kimi"] as const) {
  test(`Chat removal ${provider}: keyboard action removes workspace membership, undo restores draft and native resume keeps history`, async ({}, info) => {
    const workspace = await shell.create(`Remove ${provider} task`);
    const chat = await shell.newChat(workspace, provider);
    await shell.send(chat.id, "Invented retained native history");
    await expect.poll(() => status(chat.id)).toBe("ready");
    const nativeFile = path.join(
      shell.recording + ".sessions",
      chat.nativeId + ".json",
    );
    const nativeBytes = await readFile(nativeFile);
    const composer = shell
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Preserve this unsent local draft");
    await expect
      .poll(
        async () =>
          (await shell.cli<AppState>("state")).workspaces.find(
            (w) => w.id === workspace,
          )?.chatDrafts?.[chat.paneId]?.text,
      )
      .toBe("Preserve this unsent local draft");
    await shell.cli(
      "conversation",
      "report-status",
      "--id",
      chat.id,
      "--status",
      "ready",
    );
    const promptCount = (await shell.prompts()).length;
    let action = await removalMenu(chat.id);
    await expect(action).toBeEnabled();
    await shell.page.screenshot({
      path: info.outputPath(`${provider}-remove-context-menu.png`),
    });
    await tabTo(shell.page, action);
    await shell.page.keyboard.press("Enter");
    await expect(
      shell.page.locator(
        `.overview-item[data-navigation-key="conversation:${chat.id}"]`,
      ),
    ).toHaveCount(0);
    await expect(shell.pane(chat.paneId)).toHaveCount(0);
    const parent = shell.page.locator(
      `.overview-row[data-navigation-key="workspace:${workspace}"]`,
    );
    await expect((await shell.overview()).getByRole("combobox")).toBeFocused();
    await expect(parent).toHaveAttribute("data-status", "");
    expect(
      (await shell.cli<AppState>("state")).conversations.some(
        (c) => c.id === chat.id,
      ),
    ).toBe(false);
    expect(await readFile(nativeFile)).toEqual(nativeBytes);
    await shell.stop();
    await shell.start();
    expect(
      (await shell.cli<AppState>("state")).conversations.some(
        (c) => c.id === chat.id,
      ),
    ).toBe(false);
    expect(await readFile(nativeFile)).toEqual(nativeBytes);
    // Use the existing user-facing undo command; no new archive service.
    await shell.page.keyboard.press(`${modifier}+Shift+T`);
    await expect(
      shell
        .pane(chat.paneId)
        .getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("Preserve this unsent local draft");
    expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
    expect(await shell.prompts()).toHaveLength(promptCount);
    action = await removalMenu(chat.id);
    await tabTo(shell.page, action);
    await shell.page.keyboard.press("Enter");
    await expect(shell.pane(chat.paneId)).toHaveCount(0);
    const resumed = await shell.cli<{
      id: string;
      paneId: string;
      nativeId: string;
    }>(
      "conversation",
      "resume",
      "--workspace",
      workspace,
      "--provider",
      provider,
      "--cwd",
      shell.folders[0],
      "--native-id",
      chat.nativeId,
    );
    expect(resumed.nativeId).toBe(chat.nativeId);
    const beforeUndo = (await shell.cli<AppState>("state")).workspaces.find(
      (w) => w.id === workspace,
    )!.closedTabs;
    const duplicateUndo = await shell.raw(
      "pane",
      "reopen",
      "--workspace",
      workspace,
    );
    expect(duplicateUndo.code).not.toBe(0);
    expect(duplicateUndo.stderr).toContain("already open");
    expect(
      (await shell.cli<AppState>("state")).workspaces.find(
        (w) => w.id === workspace,
      )!.closedTabs,
    ).toEqual(beforeUndo);
    expect(text(await shell.inspect(resumed.id))).toContain(
      "DONE Invented retained native history",
    );
    expect(await shell.prompts()).toHaveLength(promptCount);
    expect(await readFile(nativeFile)).toEqual(nativeBytes);
    await shell.page.screenshot({
      path: info.outputPath(`${provider}-removed-session-native-resume.png`),
    });
    await shell.send(resumed.id, "Continue the same native history");
    await expect.poll(() => status(resumed.id)).toBe("ready");
    expect((await shell.inspect(resumed.id)).nativeId).toBe(chat.nativeId);
    expect(text(await shell.inspect(resumed.id))).toContain(
      "DONE Continue the same native history",
    );
  });
}

test("Chat removal refuses working, waiting and handed-off sessions without stopping their native process", async () => {
  const workspace = await shell.create("Removal guards");
  const chat = await shell.newChat(workspace, "codex");
  for (const prompt of [
    "[hold] Keep running",
    "[approve] Keep permission pending",
  ]) {
    await shell.send(chat.id, prompt);
    const expected = prompt.includes("[approve]") ? "waiting" : "working";
    await expect.poll(() => status(chat.id)).toBe(expected);
    const before = await shell.inspect(chat.id);
    const action = await removalMenu(chat.id);
    await expect(action).toBeDisabled();
    await expect(action).toHaveAttribute("title", /Stop the current response/);
    await shell.page.keyboard.press("Escape");
    await shell.page.keyboard.press("Escape");
    expect(
      (await shell.raw("conversation", "remove", "--id", chat.id)).code,
    ).not.toBe(0);
    expect(await status(chat.id)).toBe(expected);
    expect((await shell.inspect(chat.id)).pendingPermissions).toEqual(
      before.pendingPermissions,
    );
    await shell
      .pane(chat.paneId)
      .getByRole("button", { name: "Stop", exact: true })
      .click();
    await expect.poll(() => status(chat.id)).toBe("ready");
  }
  const handoff = await shell.cli<{ terminalId: string; paneId: string }>(
    "conversation",
    "handoff",
    "--id",
    chat.id,
  );
  const action = await removalMenu(chat.id);
  await expect(action).toBeDisabled();
  await expect(action).toHaveAttribute("title", /Return this session to chat/);
  await shell.page.keyboard.press("Escape");
  expect(
    (await shell.raw("conversation", "remove", "--id", chat.id)).code,
  ).not.toBe(0);
  const state = await shell.cli<AppState>("state");
  expect(state.terminals.find((t) => t.id === handoff.terminalId)?.status).toBe(
    "running",
  );
  expect(
    state.conversations.find((c) => c.id === chat.id)?.handoffTerminalId,
  ).toBe(handoff.terminalId);
  await shell.cli("terminal", "close", "--id", handoff.terminalId);
  await shell.cli("conversation", "reclaim", "--id", chat.id);
  await shell.send(chat.id, "Still usable after rejected removal");
  await expect.poll(() => status(chat.id)).toBe("ready");
  expect(text(await shell.inspect(chat.id))).toContain(
    "DONE Still usable after rejected removal",
  );
});

test("Chat removal preserves unresolved review and interactive-page origins", async () => {
  const workspace = await shell.create("Origin removal guards");
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    shell.folders[0],
  );
  const reviewChat = await shell.newChat(workspace, "codex");
  await shell.cli(
    "review",
    "open-document",
    "--workspace",
    workspace,
    "--path",
    shell.file,
    "--conversation",
    reviewChat.id,
  );
  const beforeReview = await shell.cli<AppState>("state");
  let action = await removalMenu(reviewChat.id);
  await expect(action).toBeDisabled();
  await expect(action).toHaveAttribute("title", /Finish the pending review/);
  await shell.page.keyboard.press("Escape");
  const rejectedReview = await shell.raw(
    "conversation",
    "remove",
    "--id",
    reviewChat.id,
  );
  expect(rejectedReview.code).not.toBe(0);
  expect(rejectedReview.stderr).toContain("pending review");
  expect((await shell.cli<AppState>("state")).reviews).toEqual(
    beforeReview.reviews,
  );
  expect((await shell.inspect(reviewChat.id)).nativeId).toBe(
    reviewChat.nativeId,
  );
  const pageChat = await shell.newChat(workspace, "codex");
  const file = path.join(shell.folders[0], "invented-form.html");
  await writeFile(
    file,
    '<!doctype html><title>Invented decision</title><form><label>Choice <input name="choice"></label><button>Submit</button></form>',
  );
  const page = await shell.cli<{ id: string }>(
    "page",
    "open",
    "--workspace",
    workspace,
    "--conversation",
    pageChat.id,
    "--path",
    file,
  );
  action = await removalMenu(pageChat.id);
  await expect(action).toBeDisabled();
  await expect(action).toHaveAttribute(
    "title",
    /Finish or close the interactive page/,
  );
  await shell.page.keyboard.press("Escape");
  expect(
    (await shell.raw("conversation", "remove", "--id", pageChat.id)).code,
  ).not.toBe(0);
  expect(
    (await shell.cli<AppState>("state")).browsers.some((b) => b.id === page.id),
  ).toBe(true);
  expect((await shell.inspect(pageChat.id)).nativeId).toBe(pageChat.nativeId);
  expect(await shell.prompts()).toHaveLength(0);
});

test("Pasted images have stable references at the caret across removal and restart", async ({}, info) => {
  const workspace = await shell.create("Image references");
  const chat = await shell.newChat(workspace, "codex");
  const composer = () =>
    shell
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
  await composer().fill("Example one: . Example two: .");
  async function paste(position: number) {
    await composer().evaluate((node, position) => {
      const input = node as HTMLTextAreaElement;
      input.setSelectionRange(position, position);
      const data = new DataTransfer();
      const png = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=",
        ),
        (c) => c.charCodeAt(0),
      );
      data.items.add(new File([png], "example.png", { type: "image/png" }));
      input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
      );
    }, position);
  }
  await paste(13);
  await expect(
    shell.pane(chat.paneId).locator(".composer-images img"),
  ).toHaveCount(1);
  await paste((await composer().inputValue()).lastIndexOf("."));
  await expect(composer()).toHaveValue(
    "Example one: [Image 1]. Example two: [Image 2].",
  );
  await expect(shell.pane(chat.paneId).locator(".image-reference")).toHaveText([
    "[Image 1]",
    "[Image 2]",
  ]);
  await shell
    .pane(chat.paneId)
    .getByRole("button", { name: "Remove image", exact: true })
    .first()
    .click();
  await expect(composer()).toHaveValue(
    "Example one: . Example two: [Image 2].",
  );
  await shell.stop();
  await shell.start();
  await expect(composer()).toHaveValue(
    "Example one: . Example two: [Image 2].",
  );
  await expect(shell.pane(chat.paneId).locator(".image-reference")).toHaveText([
    "[Image 2]",
  ]);
  await shell.page.screenshot({
    path: info.outputPath("image-references.png"),
  });
  await composer().press(`${modifier}+Enter`);
  await expect(
    transcript(chat).locator(".message-images .image-reference"),
  ).toHaveText(["[Image 2]"]);
});

test("Repeated Backspace saves the chat draft without echoing full state on every key", async () => {
  const workspace = await shell.create("Responsive composer");
  const chat = await shell.newChat(workspace, "codex");
  const original = "Long invented draft. ".repeat(4000);
  const image = {
    reference: 1,
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=",
  };
  await shell.page.evaluate(
    async ({ workspace, paneId, original, image }) => {
      await window.cod.invoke({
        op: "conversation.composer",
        workspace,
        paneId,
        text: original,
        images: [image],
      });
    },
    { workspace, paneId: chat.paneId, original, image },
  );
  await shell.stop();
  await shell.start();
  const input = () =>
    shell
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
  await expect(input()).toHaveValue(original);
  await expect(
    shell.pane(chat.paneId).locator(".composer-images img"),
  ).toHaveCount(1);
  await input().focus();
  await input().evaluate((node) => {
    const textarea = node as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  await shell.page.evaluate(() => {
    const counters = { snapshots: 0 };
    Object.assign(window, { composerCounters: counters });
    window.cod.onState(() => {
      counters.snapshots++;
    });
  });
  // Repeated keydown exercises Chromium's native key repeat, not synthetic input.
  for (let i = 0; i < 80; i++) await shell.page.keyboard.down("Backspace");
  await shell.page.keyboard.up("Backspace");
  const expected = original.slice(0, -80);
  await expect(input()).toHaveValue(expected);
  await expect(input()).toBeFocused();
  await expect
    .poll(async () => {
      try {
        const saved = JSON.parse(
          await readFile(path.join(shell.data, "composer-text.json"), "utf8"),
        );
        return (
          Object.values(saved.drafts) as Array<{
            pane: string;
            draft: { text: string };
          }>
        ).find((entry) => entry.pane === chat.paneId)?.draft.text;
      } catch {
        return undefined;
      }
    })
    .toBe(expected);
  expect(
    await shell.page.evaluate(
      () =>
        (window as unknown as { composerCounters: { snapshots: number } })
          .composerCounters.snapshots,
    ),
  ).toBeLessThan(5);
  await shell.stop();
  await shell.start();
  await expect(input()).toHaveValue(expected);
  await expect(
    shell.pane(chat.paneId).locator(".composer-images img"),
  ).toHaveCount(1);
  await shell
    .pane(chat.paneId)
    .getByRole("button", { name: "Remove image", exact: true })
    .click();
  await shell.stop();
  await shell.start();
  await expect(input()).toHaveValue(expected);
  await expect(
    shell.pane(chat.paneId).locator(".composer-images img"),
  ).toHaveCount(0);
});

test("Close tab shortcut closes the focused chat and preserves its session", async () => {
  const workspace = await shell.create("Close chat shortcut");
  const first = await shell.newChat(workspace, "codex");
  const second = await shell.newChat(workspace, "codex");
  const composer = shell
    .pane(second.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep this draft when closing the tab.");
  await shell
    .pane(second.paneId)
    .locator(".composer")
    .evaluate((node) => {
      Object.assign(window, { closedComposer: new WeakRef(node) });
    });
  await composer.press(`${modifier}+w`);
  await expect(shell.pane(second.paneId)).toHaveCount(0);
  const session = await shell.page.context().newCDPSession(shell.page);
  await session.send("HeapProfiler.collectGarbage");
  expect(
    await shell.page.evaluate(
      () =>
        (
          window as unknown as { closedComposer: WeakRef<HTMLElement> }
        ).closedComposer.deref() === undefined,
    ),
  ).toBe(true);
  await session.detach();
  await expect
    .poll(async () => {
      const journal = await readFile(
        path.join(shell.data, "diagnostics", "runtime.jsonl"),
        "utf8",
      );
      return journal.includes('"event":"close-tab-result"');
    })
    .toBe(true);
  const journal = await readFile(
    path.join(shell.data, "diagnostics", "runtime.jsonl"),
    "utf8",
  );
  expect(journal).not.toContain("Keep this draft when closing the tab.");
  const state = await shell.cli<AppState>("state");
  expect(state.conversations.some((c) => c.id === second.id)).toBe(true);
  expect(
    state.workspaces
      .find((w) => w.id === workspace)
      ?.panes.some((p) => p.id === first.paneId),
  ).toBe(true);
});

test("Close tab shortcut closes a focused source editor", async () => {
  const workspace = await shell.create("Close file shortcut");
  const file = path.join(shell.folders[0], "close-fixture.md");
  await writeFile(file, "# Invented file\n");
  const opened = await shell.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    file,
  );
  const editor = shell
    .pane(opened.paneId)
    .getByRole("textbox", { name: "File contents", exact: true });
  await expect(editor).toBeEnabled();
  await editor.focus();
  await editor.press(`${modifier}+w`);
  await expect(shell.pane(opened.paneId)).toHaveCount(0);
});

async function queueFixture(
  chat: { nativeId: string },
  id: string,
  text: string,
) {
  const destination = path.join(
    shell.recording + ".sessions",
    chat.nativeId + ".queue.json",
  );
  await writeFile(destination + ".tmp", JSON.stringify({ id, text }));
  await rename(destination + ".tmp", destination);
}

async function backgroundFixture(
  chat: Pick<Chat, "nativeId">,
  id: string,
  events: unknown[],
) {
  const destination = path.join(
    shell.recording + ".sessions",
    chat.nativeId + ".queue.json",
  );
  await writeFile(destination + ".tmp", JSON.stringify({ id, events }));
  await rename(destination + ".tmp", destination);
}

test("Codex late background results preserve the parent reply, composer and native continuation", async () => {
  const modelLabel = "Fixture model with a deliberately long readable name";
  await shell.configure({
    codex: {
      backgroundActivity: true,
      options: true,
      reasoningOptions: true,
      modelDisplayName: modelLabel,
    },
  });
  const workspace = await shell.create("Background checks");
  const chat = await shell.newChat(workspace, "codex");
  const pane = shell.pane(chat.paneId);
  const agents = pane.locator('[data-focus-key="background:agent"]');
  const shells = pane.locator('[data-focus-key="background:command"]');
  const agentList = pane.getByRole("list", { name: "Background agents" });
  const shellList = pane.getByRole("list", { name: "Background shells" });
  await expect(agents).toHaveCount(0);
  await expect(shells).toHaveCount(0);
  await shell.send(chat.id, "Check the fixture in a child");
  await expect.poll(() => status(chat.id)).toBe("ready");
  await expect(transcript(chat)).toContainText(
    "Tests are running in the background.",
  );
  await expect(agents).toHaveAccessibleName("Agents, 1 running");
  await expect(shells).toHaveAccessibleName("Shells, 1 running");
  await expect(agents).toHaveText("1 agent");
  await expect(shells).toHaveText("1 shell");
  await expect(pane.locator(".composer-background svg")).toHaveCount(0);
  await expect(agents).toHaveCSS("color", "rgb(133, 183, 255)");
  const model = pane.getByRole("button", { name: "Model", exact: true });
  await expect(model).toHaveText(modelLabel);
  const modelBounds = await model.boundingBox();
  const agentsBounds = await agents.boundingBox();
  expect(Math.abs(modelBounds!.y - agentsBounds!.y)).toBeLessThanOrEqual(1);
  await expect(agentList).toBeHidden();
  await agents.focus();
  await agents.press("Enter");
  await expect(agentList).toBeVisible();
  await expect(agents).toHaveAttribute("aria-expanded", "true");
  await expect(shells).toHaveAttribute("aria-expanded", "false");
  await expect(agentList).toContainText("/root/checker");
  await expect(agentList).not.toContainText("echo test checks");
  await expect(agentList).not.toContainText("unrelated work");
  await shells.click();
  await expect(agentList).toBeHidden();
  await expect(shellList).toBeVisible();
  await expect(agents).toHaveAttribute("aria-expanded", "false");
  await expect(shells).toHaveAttribute("aria-expanded", "true");
  await expect(shells).toHaveCSS("color", "rgb(133, 183, 255)");
  await expect(shellList).toContainText("echo test checks");
  await expect(shellList.getByRole("listitem")).toHaveCount(1);
  const list = shellList;
  await shell.page.screenshot({
    path: test.info().outputPath("background-counts.png"),
  });
  await expect
    .poll(() =>
      list.evaluate((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(
            x + width / 2,
            y + Math.min(height / 2, 10),
          ),
        );
      }),
    )
    .toBe(true);
  const close = await shell.raw("workspace", "close", "--id", workspace);
  expect(close.code).not.toBe(0);
  expect(close.stderr).toContain("Workspace has running agents or terminals");
  await shell.page.setViewportSize({ width: 390, height: 650 });
  const composer = await pane.locator(".composer").boundingBox();
  const counts = await shells.boundingBox();
  expect(counts!.x + counts!.width).toBeLessThanOrEqual(
    composer!.x + composer!.width,
  );
  await expect(list).toBeVisible();
  await shell.page.screenshot({
    path: test.info().outputPath("background-activity-narrow.png"),
  });
  await shell.page.setViewportSize({ width: 1280, height: 800 });
  await shells.press("Escape");
  await expect(shells).toBeFocused();
  await expect(shellList).toBeHidden();
  await agents.click();
  const input = pane.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Keep this unrelated draft");

  const child = "invented-child";
  const childResult = {
    method: "item/completed",
    params: {
      threadId: child,
      turnId: "child-turn",
      item: {
        type: "agentMessage",
        id: "child-result",
        phase: "final_answer",
        text: "Invented child result",
      },
    },
  };
  const childDone = {
    method: "item/completed",
    params: {
      threadId: chat.nativeId,
      turnId: "turn-1",
      item: {
        type: "subAgentActivity",
        id: "child-done",
        kind: "completed",
        agentThreadId: child,
      },
    },
  };
  await backgroundFixture(chat, "child-done", [
    childResult,
    childDone,
    childDone,
  ]);
  await expect(agents).toHaveAccessibleName("Recent agents");
  await expect(agents).toHaveText("Agents");
  await expect(agents).not.toHaveCSS("color", "rgb(133, 183, 255)");
  await expect(shells).toHaveText("1 shell");
  await expect(agentList).toContainText("Invented child result");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Keep this unrelated draft");

  const commandDone = {
    method: "item/completed",
    params: {
      threadId: child,
      turnId: "child-turn",
      item: {
        type: "commandExecution",
        id: "invented-shell",
        status: "completed",
        aggregatedOutput: "Invented checked output",
        exitCode: 0,
      },
    },
  };
  await backgroundFixture(chat, "shell-done", [commandDone, commandDone]);
  await expect(shells).toHaveText("Shells");
  await expect(agentList).toBeVisible();
  await expect(input).toBeFocused();
  await shells.click();
  await expect(list).toContainText("Invented checked output");
  await expect(
    list.getByText("Invented checked output", { exact: true }),
  ).toHaveCount(1);
  await expect
    .poll(async () => (await inspectQueuedChat(chat.id)).turns?.length)
    .toBe(1);
  await input.focus();

  const turn = { id: "native-continuation", status: "inProgress" };
  await backgroundFixture(chat, "native-continuation", [
    { method: "turn/started", params: { threadId: chat.nativeId, turn } },
    {
      method: "item/completed",
      params: {
        threadId: chat.nativeId,
        turnId: turn.id,
        item: {
          type: "agentMessage",
          id: "native-follow-up",
          phase: "final_answer",
          text: "Native follow-up kept.",
        },
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId: chat.nativeId,
        turn: { ...turn, status: "completed" },
      },
    },
  ]);
  await expect(transcript(chat)).toContainText("Native follow-up kept.");
  await expect
    .poll(async () => (await inspectQueuedChat(chat.id)).turns?.length)
    .toBe(2);
  const state = await inspectQueuedChat(chat.id);
  expect(
    state.messages.filter((message) => message.role === "user"),
  ).toHaveLength(1);
  expect(state.backgroundActivities).toHaveLength(2);
  await expect(input).toBeFocused();
  await shell.page.screenshot({
    path: test.info().outputPath("background-activity.png"),
  });
});

test("Escape dismisses chat controls before stopping only the focused response", async ({}, info) => {
  const codex = {
    options: true,
    reasoningOptions: true,
    modelDisplayName: "Fixture model with a deliberately long readable name",
  };
  await shell.configure({ codex });
  const workspace = await shell.create("Scoped Escape");
  const other = await shell.newChat(workspace, "codex");
  await shell.send(other.id, "[hold] companion turn");
  await expect.poll(() => status(other.id)).toBe("working");
  await shell.configure({ codex: { ...codex, backgroundActivity: true } });
  const chat = await shell.newChat(workspace, "codex");
  const pane = shell.pane(chat.paneId);
  await shell.cli("conversation", "show", "--id", chat.id);
  await shell.send(chat.id, "Prepare the activity fixture");
  await expect.poll(() => status(chat.id)).toBe("ready");
  const agent = pane.getByRole("button", { name: "Agents, 1 running" });
  const input = pane.getByRole("textbox", { name: "Message", exact: true });
  await expect(agent).toBeVisible();
  const group = (await shell.workspace(workspace)).groups[0].id;
  await shell.page.evaluate((request) => window.cod.invoke(request), {
    op: "group.split",
    workspace,
    id: group,
    paneId: chat.paneId,
    direction: "right",
  });
  await expect(shell.pane(other.paneId)).toBeVisible();
  await expect(pane).toBeVisible();
  await shell.configure({ codex });
  await shell.send(chat.id, "[hold] focused turn");
  await expect(transcript(chat)).toContainText("STREAM [hold] focused turn");
  await expect.poll(() => status(other.id)).toBe("working");
  const interrupts = async () =>
    (await shell.records()).filter(
      (record) => record.message?.method === "turn/interrupt",
    );

  await input.fill("Invented unsent draft");
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  const commands = shell.page.getByRole("dialog", { name: "Command palette" });
  await expect(commands).toBeVisible();
  await shell.page.keyboard.press("Escape");
  await expect(commands).toBeHidden();
  await expect(input).toBeFocused();
  await shell.overview();
  await expect(
    shell.page.getByRole("dialog", { name: "Overview" }),
  ).toBeVisible();
  await shell.page.keyboard.press("Escape");
  await expect(input).toBeFocused();

  await shell.page.keyboard.press(`${modifier}+F`);
  const find = shell.page.getByRole("textbox", {
    name: "Find in current content",
  });
  await expect(find).toBeFocused();
  await input.focus();
  await shell.page.keyboard.press("Escape");
  await expect(find).toBeHidden();
  await expect(input).toBeFocused();
  await agent.click();
  const agents = pane.getByRole("list", { name: "Background agents" });
  await expect(agents).toBeVisible();
  await agents.focus();
  await shell.page.screenshot({
    path: info.outputPath("background-mixed-working.png"),
  });
  await shell.page.setViewportSize({ width: 760, height: 680 });
  const model = pane.getByRole("button", { name: "Model", exact: true });
  const stop = pane.getByRole("button", { name: "Stop", exact: true });
  const effort = pane.getByRole("button", {
    name: "Reasoning effort",
    exact: true,
  });
  const effortCaption = effort.locator(".choice-caption");
  await expect(effortCaption).toHaveText("Medium");
  expect(
    await effortCaption.evaluate((element) => element.scrollWidth),
  ).toBeLessThanOrEqual((await effortCaption.boundingBox())!.width + 1);
  const composer = await input.boundingBox();
  const popover = await agents.boundingBox();
  expect(popover!.y + popover!.height).toBeLessThan(composer!.y);
  const controls = await Promise.all([
    model.boundingBox(),
    agent.boundingBox(),
    stop.boundingBox(),
  ]);
  for (const control of controls) {
    expect(control!.x).toBeGreaterThanOrEqual(composer!.x);
    expect(control!.x + control!.width).toBeLessThanOrEqual(
      composer!.x + composer!.width,
    );
  }
  expect(Math.abs(controls[0]!.y - controls[2]!.y)).toBeLessThanOrEqual(1);
  await shell.page.screenshot({
    path: info.outputPath("background-mixed-working-narrow.png"),
  });
  await shell.page.setViewportSize({ width: 1280, height: 800 });
  await shell.page.keyboard.press("Escape");
  await expect(agents).toBeHidden();
  await expect(agent).toBeFocused();

  await input.focus();
  await input.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        isComposing: true,
      }),
    ),
  );
  await input.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        repeat: true,
      }),
    ),
  );
  expect(await interrupts()).toHaveLength(0);
  await expect.poll(() => status(chat.id)).toBe("working");

  await shell.page.keyboard.press("Escape");
  await expect.poll(() => status(chat.id)).toBe("ready");
  await expect
    .poll(async () =>
      (await interrupts()).map((record) => record.message?.params?.threadId),
    )
    .toEqual([chat.nativeId]);
  await expect.poll(() => status(other.id)).toBe("working");
  await expect(input).toHaveValue("Invented unsent draft");
  await expect(input).toBeFocused();
});

test("Codex running background state becomes unknown on restart", async () => {
  await shell.configure({ codex: { backgroundActivity: "legacy" } });
  const workspace = await shell.create("Interrupted checks");
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "Check the fixture");
  await expect.poll(() => status(chat.id)).toBe("ready");
  await expect
    .poll(
      async () =>
        (await inspectQueuedChat(chat.id)).backgroundActivities?.length,
    )
    .toBe(3);
  await expect(
    shell.pane(chat.paneId).getByRole("button", { name: "Agents, 1 running" }),
  ).toBeVisible();
  await expect(
    shell.pane(chat.paneId).getByRole("button", { name: "Shells, 2 running" }),
  ).toBeVisible();
  await backgroundFixture(chat, "legacy-child-done", [
    {
      method: "turn/completed",
      params: {
        threadId: "invented-child",
        turn: { id: "child-turn", status: "completed" },
      },
    },
  ]);
  await expect(
    shell.pane(chat.paneId).getByRole("button", { name: "Recent agents" }),
  ).toHaveText("Agents");
  await shell.stop();
  await shell.start();
  await shell.cli("conversation", "show", "--id", chat.id);
  const pane = shell.pane(chat.paneId);
  const shells = pane.getByRole("button", { name: "Recent shells" });
  await expect(shells).toHaveText("Shells");
  await shells.click();
  await expect(
    pane.getByRole("list", { name: "Background shells" }),
  ).toContainText("State unknown");
  expect(
    (await inspectQueuedChat(chat.id)).backgroundActivities?.map(
      (item) => item.state,
    ),
  ).toEqual(["completed", "unknown", "unknown"]);
});

test("Queued Codex turns update the transcript and attention without stealing focus", async () => {
  const workspace = await shell.create("Queued completions");
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "Initial turn");
  await expect.poll(() => status(chat.id)).toBe("ready");
  const before = await inspectQueuedChat(chat.id);
  const other = await shell.newChat(workspace, "codex");
  await queueFixture(chat, "job-one", "Job finished externally");
  await expect.poll(() => status(chat.id)).toBe("working");
  await expect
    .poll(() => textFromInspection(chat.id))
    .toContain("DONE Job finished externally");
  await expect.poll(() => status(chat.id)).toBe("ready");
  const after = await inspectQueuedChat(chat.id);
  expect(after.completionRevision).toBe((before.completionRevision ?? 0) + 1);
  expect(after.turns).toHaveLength((before.turns?.length ?? 0) + 1);
  expect(
    after.messages.filter(
      (m) => m.role === "user" && m.text === "Job finished externally",
    ),
  ).toHaveLength(1);
  expect(
    after.messages.filter(
      (m) => m.role === "user" && m.text === "Initial turn",
    ),
  ).toHaveLength(1);
  expect(after.turns?.at(-1)?.outcome).toBe("completed");
  expect(after.tools.at(-1)?.turnId).toBe(after.turns?.at(-1)?.id);
  expect((await shell.workspace(workspace)).activePaneId).toBe(other.paneId);
  await shell.cli("conversation", "show", "--id", chat.id);
  await expect(transcript(chat)).toContainText("DONE Job finished externally");
  await shell.page.screenshot({
    path: test.info().outputPath("queued-turn-visible.png"),
  });
  await shell.stop();
  await shell.start();
  await shell.cli("conversation", "show", "--id", chat.id);
  await expect(transcript(chat)).toContainText("DONE Job finished externally");
});

async function textFromInspection(id: string) {
  return text(await inspectQueuedChat(id));
}

test("Queued Codex turns retain permission and interruption controls", async () => {
  const workspace = await shell.create("Queued permission");
  const chat = await shell.newChat(workspace, "codex");
  await queueFixture(chat, "approval", "External approval [approve]");
  await expect.poll(() => status(chat.id)).toBe("waiting");
  const pending = await inspectQueuedChat(chat.id);
  expect(pending.pendingPermissions).toHaveLength(1);
  const result = await shell.raw(
    "conversation",
    "send",
    "--id",
    chat.id,
    "--text",
    "Must not overlap",
  );
  expect(result.code).toBe(0);
  expect(
    (await inspectQueuedChat(chat.id)).queuedMessages?.map((m) => m.text),
  ).toEqual(["Must not overlap"]);
  expect(
    (await inspectQueuedChat(chat.id)).messages.some(
      (m) => m.role === "user" && m.text === "Must not overlap",
    ),
  ).toBe(false);
  await shell.cli(
    "conversation",
    "permission",
    "--id",
    chat.id,
    "--request-id",
    pending.pendingPermissions[0].id,
    "--option-id",
    "deny",
  );
  await expect.poll(() => status(chat.id)).toBe("ready");
  await expect(transcript(chat)).toContainText("DENIED External approval");
  await expect
    .poll(() => textFromInspection(chat.id))
    .toContain("DONE Must not overlap");
  await expect
    .poll(async () => (await inspectQueuedChat(chat.id)).queuedMessages?.length)
    .toBe(0);
  const revision = (await inspectQueuedChat(chat.id)).completionRevision;
  await queueFixture(chat, "held", "External hold [hold]");
  await expect.poll(() => status(chat.id)).toBe("working");
  await shell.cli("conversation", "interrupt", "--id", chat.id);
  await expect.poll(() => status(chat.id)).toBe("ready");
  expect((await inspectQueuedChat(chat.id)).turns?.at(-1)?.outcome).toBe(
    "cancelled",
  );
  expect((await inspectQueuedChat(chat.id)).completionRevision).toBe(revision);
  await shell.send(chat.id, "Normal follow-up");
  await expect
    .poll(() => textFromInspection(chat.id))
    .toContain("DONE Normal follow-up");
});

function inspectQueuedChat(id: string) {
  return shell.cli<ConversationState>("conversation", "inspect", "--id", id);
}

test("Codex tool result CLI targets an idle chat, preserves its draft and restores native activity", async () => {
  const workspace = await shell.create("Result destination");
  const chat = await shell.newChat(workspace, "codex");
  const pane = () => shell.pane(chat.paneId);
  const composer = () =>
    pane().getByRole("textbox", { name: "Message", exact: true });
  const item = () =>
    pane()
      .locator(".tool-activity")
      .filter({ hasText: "Tool result · fixture.file_check" });
  await composer().fill("Keep this draft");
  const other = await shell.create("Other workspace");
  const output = "-- first invented result\nsecond line";
  const receipt = await shell.cli(
    "conversation",
    "send-tool-result",
    "--id",
    chat.id,
    "--name",
    "file_check",
    "--namespace",
    "fixture",
    "--output",
    output,
  );
  expect(receipt).toEqual({
    id: chat.id,
    status: "accepted",
    nativeTurnId: "turn-1",
  });
  expect((await shell.cli<AppState>("state")).activeWorkspaceId).toBe(other);
  await expect.poll(() => status(chat.id)).toBe("ready");
  await shell.cli("conversation", "show", "--id", chat.id);
  await expect(composer()).toHaveValue("Keep this draft");
  await expect(transcript(chat)).toContainText("Tool result received.");
  await expect(item()).toHaveCount(1);
  await expect(item()).toHaveAttribute("data-tool-phase", "completed");
  await expandActivity(pane());
  await item().locator(":scope > summary").click();
  await expect(item().locator("pre")).toHaveText(output);
  expect(
    (await shell.inspect(chat.id)).messages.map((message) => message.role),
  ).toEqual(["assistant"]);
  const requests = await shell.prompts();
  expect(requests).toHaveLength(1);
  expect(requests[0].message?.params).toMatchObject({
    threadId: chat.nativeId,
    input: [],
    toolOutput: {
      name: "file_check",
      namespace: "fixture",
      output,
      retain: true,
    },
  });
  await shell.stop();
  await shell.start();
  await shell.cli("conversation", "show", "--id", chat.id);
  await expect(item()).toHaveCount(1);
  await expect(item()).toHaveAttribute(
    "data-tool-id",
    `codex/${chat.nativeId}/turn-1/result-turn-1-0`,
  );
  await expect(item()).toHaveAttribute("data-tool-phase", "completed");
  await expect(composer()).toHaveValue("Keep this draft");
  expect(await shell.prompts()).toHaveLength(1);
});

test("Both ordinary Codex send shortcuts steer the same live turn and keep the existing queue", async () => {
  const workspace = await shell.create("Steering fixture");
  const chat = await shell.newChat(workspace, "codex");
  const pane = shell.pane(chat.paneId);
  const composer = pane.getByRole("textbox", { name: "Message", exact: true });
  await shell.send(chat.id, "Original task [hold]");
  await expect
    .poll(() => textFromInspection(chat.id))
    .toContain("STREAM Original task [hold]");
  await shell.send(chat.id, "Keep waiting");
  await composer.fill("First live follow-up");
  await composer.press("Enter");
  await expect(transcript(chat)).toContainText("First live follow-up");
  await expect(composer).toHaveValue("");
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=";
  await shell.cli(
    "conversation",
    "composer",
    "--workspace",
    workspace,
    "--pane-id",
    chat.paneId,
    "--text",
    "One more follow-up [Image 1]",
    "--images",
    JSON.stringify([{ data: png, mimeType: "image/png", reference: 1 }]),
  );
  await expect(composer).toHaveValue("One more follow-up [Image 1]");
  await composer.press(`${modifier}+Enter`);
  await expect(transcript(chat)).toContainText("One more follow-up");
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();

  const live = await inspectQueuedChat(chat.id);
  expect(live.turns).toHaveLength(1);
  expect(live.status).toBe("working");
  expect(live.queuedMessages?.map((item) => item.text)).toEqual([
    "Keep waiting",
  ]);
  expect(
    live.messages
      .filter((item) => item.role === "user")
      .map(({ text, turnId }) => ({ text, turnId })),
  ).toEqual(
    [
      "Original task [hold]",
      "First live follow-up",
      "One more follow-up [Image 1]",
    ].map((text) => ({ text, turnId: live.turns?.[0].id })),
  );
  const requests = (await shell.records()).filter(
    (row) => row.message?.method === "turn/steer",
  );
  expect(requests).toHaveLength(2);
  expect(requests.map((row) => row.message?.params?.expectedTurnId)).toEqual([
    "turn-1",
    "turn-1",
  ]);
  expect(requests[1]?.message?.params?.input).toEqual(
    expect.arrayContaining([
      { type: "image", url: `data:image/png;base64,${png}` },
    ]),
  );
  expect(live.messages.at(-1)?.images?.[0]?.data).toBe(png);
  await composer.fill("Retain stale input");
  const error = await shell.page.evaluate(async (id) => {
    try {
      await window.cod.invoke({
        op: "conversation.send",
        id,
        expectedTurn: "ended-turn",
        text: "Retain stale input",
      });
      return null;
    } catch (error) {
      return String(error);
    }
  }, chat.id);
  expect(error).toContain("The selected turn has ended");
  await expect(composer).toHaveValue("Retain stale input");
  expect(await shell.prompts()).toHaveLength(1);
  expect(
    (await shell.records()).filter(
      (row) => row.message?.method === "turn/steer",
    ),
  ).toHaveLength(2);
});

test("Codex steering preserves a rejected draft and reconciles an uncertain receipt after restart", async () => {
  const workspace = await shell.create("Steering recovery fixture");
  const chat = await shell.newChat(workspace, "codex");
  const pane = () => shell.pane(chat.paneId);
  const composer = () =>
    pane().getByRole("textbox", { name: "Message", exact: true });
  await shell.send(chat.id, "Original task [hold]");
  await expect
    .poll(() => textFromInspection(chat.id))
    .toContain("STREAM Original task [hold]");
  await shell.configure({ codex: { steering: "reject" } });
  await composer().fill("Recoverable follow-up");
  await composer().press("Enter");
  await expect(
    pane().getByRole("status", { name: "Conversation status" }),
  ).toContainText("Fixture turn no longer active");
  await expect(composer()).toHaveValue("Recoverable follow-up");
  await shell.configure({ codex: { steering: "silent" } });
  await composer().press("Enter");
  await expect(pane().getByLabel("Pending follow-ups")).toContainText(
    "Waiting for the current turn",
  );
  await expect(composer()).toHaveValue("");
  await composer().fill("Keep my next draft");
  await shell.stop();
  await shell.start();
  await shell.cli("conversation", "show", "--id", chat.id);
  await expect(pane().getByLabel("Pending follow-ups")).toContainText(
    "Follow-up delivery uncertain",
  );
  await pane().getByRole("button", { name: "Check delivery" }).click();
  await expect(pane().getByLabel("Pending follow-ups")).toHaveCount(0);
  await expect(composer()).toHaveValue("Keep my next draft");
  const restored = await inspectQueuedChat(chat.id);
  expect(
    restored.messages.filter(
      (item) => item.role === "user" && item.text === "Recoverable follow-up",
    ),
  ).toHaveLength(1);
  expect(await shell.prompts()).toHaveLength(1);
});

test("A follow-up absent from the finished native turn returns to a paused queue", async () => {
  const workspace = await shell.create("Undelivered follow-up fixture");
  const chat = await shell.newChat(workspace, "codex");
  const pane = shell.pane(chat.paneId);
  const composer = pane.getByRole("textbox", { name: "Message", exact: true });
  await shell.configure({ codex: { steering: "absent" } });
  await shell.send(chat.id, "Original task [hold]");
  await expect
    .poll(() => textFromInspection(chat.id))
    .toContain("STREAM Original task [hold]");
  await composer.fill("Keep this follow-up");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await shell.cli("conversation", "interrupt", "--id", chat.id);
  await expect(pane.getByLabel("Pending follow-ups")).toContainText(
    "Follow-up delivery uncertain",
  );
  await pane.getByRole("button", { name: "Check delivery" }).click();
  await expect(
    pane.getByRole("button", { name: "Continue queue" }),
  ).toBeVisible();
  expect(await shell.prompts()).toHaveLength(1);
  await pane.getByRole("button", { name: "Continue queue" }).click();
  await expect(transcript(chat)).toContainText("DONE Keep this follow-up");
  expect(await shell.prompts()).toHaveLength(2);
});

test("Ordinary Kimi ACP send visibly queues when the provider cannot steer", async () => {
  const workspace = await shell.create("Kimi steering fixture");
  const chat = await shell.newChat(workspace, "kimi");
  const composer = shell
    .pane(chat.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await shell.send(chat.id, "Original task [hold]");
  await expect
    .poll(() => textFromInspection(chat.id))
    .toContain("STREAM Original task [hold]");
  await composer.fill("Retain this draft");
  await composer.press("Enter");
  await expect(
    shell.pane(chat.paneId).getByLabel("Queued messages"),
  ).toContainText("Retain this draft");
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
  expect(
    (await shell.records()).filter(
      (row) => row.message?.method === "turn/steer",
    ),
  ).toHaveLength(0);
  expect(await shell.prompts()).toHaveLength(1);
});

test("Codex tool result CLI joins a busy turn and leaves the human message queued", async () => {
  const workspace = await shell.create("Running check");
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "Begin [approve]");
  await expect.poll(() => status(chat.id)).toBe("waiting");
  await shell.send(chat.id, "Message after check");
  const receipt = await shell.cli(
    "conversation",
    "send-tool-result",
    "--id",
    chat.id,
    "--name",
    "check_reports",
    "--output",
    "Invented status output",
  );
  expect(receipt).toEqual({
    id: chat.id,
    status: "accepted",
    nativeTurnId: "turn-1",
  });
  await expect
    .poll(async () => (await shell.inspect(chat.id)).tools)
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "completed",
          details: expect.objectContaining({
            type: "functionCallOutput",
            output: "Invented status output",
            namespace: null,
          }),
        }),
      ]),
    );
  const active = await inspectQueuedChat(chat.id);
  expect(active.status).toBe("waiting");
  expect(active.turns).toHaveLength(1);
  expect(active.queuedMessages?.map((message) => message.text)).toEqual([
    "Message after check",
  ]);
  expect(
    active.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text),
  ).toEqual(["Begin [approve]"]);
  const result = active.tools.find(
    (tool) => (tool.details as { type?: string }).type === "functionCallOutput",
  );
  expect(result?.turnId).toBe(active.turns?.[0].id);
  await shell.cli(
    "conversation",
    "permission",
    "--id",
    chat.id,
    "--request-id",
    active.pendingPermissions[0].id,
    "--option-id",
    "deny",
  );
  await expect(transcript(chat)).toContainText("DONE Message after check");
  const finished = await inspectQueuedChat(chat.id);
  expect(finished.turns).toHaveLength(2);
  expect(finished.queuedMessages).toEqual([]);
  expect(
    (await shell.prompts()).map((entry) => entry.message?.params?.input),
  ).toMatchObject([
    [{ type: "text", text: "Begin [approve]" }],
    [],
    [{ type: "text", text: "Message after check" }],
  ]);
});

test("Tool result CLI rejects unsupported providers and reserved role flags without sending", async () => {
  const workspace = await shell.create("Unsupported tool result");
  const chat = await shell.newChat(workspace, "kimi");
  const args = [
    "conversation",
    "send-tool-result",
    "--id",
    chat.id,
    "--name",
    "check",
    "--output",
    "",
  ];
  const unsupported = await shell.raw(...args);
  expect(unsupported.code).toBe(1);
  expect(unsupported.stderr).toContain("only supported in Codex conversations");
  const role = await shell.raw(...args, "--role", "system");
  expect(role.code).toBe(1);
  expect(role.stderr).toContain("Unknown or reserved flag: --role");
  expect(await shell.prompts()).toHaveLength(0);
});

test("Queued turn at completion cannot be cleared by the previous send promise", async () => {
  await shell.configure({ codex: { queueAfterCompletion: true } });
  const workspace = await shell.create("Immediate queue");
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "Initial turn");
  await expect
    .poll(() => textFromInspection(chat.id))
    .toContain("Queued immediately [hold]");
  expect(await status(chat.id)).toBe("working");
  const result = await shell.raw(
    "conversation",
    "send",
    "--id",
    chat.id,
    "--text",
    "Overlap",
  );
  expect(result.code).toBe(0);
  expect(
    (await inspectQueuedChat(chat.id)).queuedMessages?.map((m) => m.text),
  ).toEqual(["Overlap"]);
  expect(
    (await inspectQueuedChat(chat.id)).turns?.at(-1)?.finishedAt,
  ).toBeUndefined();
  await shell.cli("conversation", "interrupt", "--id", chat.id);
  await expect.poll(() => status(chat.id)).toBe("ready");
  expect(
    (await inspectQueuedChat(chat.id)).turns?.map((t) => t.outcome),
  ).toEqual(["completed", "cancelled"]);
});

test("Local diagnostics record process memory and clean shutdown without conversation content", async () => {
  const workspace = await shell.create("PRIVATE_DIAGNOSTIC_FIXTURE");
  await shell.newChat(workspace, "codex");
  await shell.stop();
  const directory = path.join(shell.data, "diagnostics");
  const log = await readFile(path.join(directory, "runtime.jsonl"), "utf8");
  const entries = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries.some((entry) => entry.event === "start")).toBe(true);
  const memory = entries.find((entry) => entry.event === "memory");
  expect(memory.main.rss).toBeGreaterThan(0);
  expect(memory.processes.length).toBeGreaterThan(0);
  expect(entries.at(-1).event).toBe("shutdown");
  expect(log).not.toContain("PRIVATE_DIAGNOSTIC_FIXTURE");
  expect(
    JSON.parse(await readFile(path.join(directory, "session.json"), "utf8"))
      .clean,
  ).toBe(true);
});

test("Overview opens a selected workspace and renames chats with the platform chord", async () => {
  const first = await shell.create("First keyboard workspace");
  const chat = await shell.newChat(first, "codex");
  const second = await shell.create("Second keyboard workspace");
  const select = (key: string) =>
    shell.page.locator(`.overview-item[data-navigation-key="${key}"]`).hover();
  const search = (await shell.overview()).getByRole("combobox");
  await select(`workspace:${first}`);
  expect((await shell.cli<AppState>("state")).activeWorkspaceId).toBe(second);
  await search.press("Enter");
  await expect
    .poll(async () => (await shell.cli<AppState>("state")).activeWorkspaceId)
    .toBe(first);
  await shell.overview();
  await select(`conversation:${chat.id}`);
  await search.press(`${modifier}+Enter`);
  const name = shell.page.getByRole("textbox", {
    name: "Conversation name",
    exact: true,
  });
  await expect(name).toBeFocused();
  await name.fill("Cancelled name");
  await name.press("Escape");
  await expect(search).toBeFocused();
  await select(`conversation:${chat.id}`);
  await search.press(`${modifier}+Enter`);
  await name.fill("Renamed conversation");
  await name.press("Enter");
  await expect(search).toBeFocused();
  await search.press("Enter");
  await expect(shell.pane(chat.paneId)).toBeVisible();
  expect(await shell.prompts()).toHaveLength(0);
  await shell.stop();
  await shell.start();
  await shell.overview();
  await expect(shell.row("Renamed conversation")).toBeVisible();
});

test("Short composer input with 25 MB state writes only small draft data", async ({}, info) => {
  const workspace = await shell.create("Input responsiveness");
  const chat = await shell.newChat(workspace, "codex");
  await shell.stop();
  const file = path.join(shell.data, "state.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  // Invented inert history load; it must not be cloned or serialized by typing.
  saved.fixtureHistory = "invented history ".repeat(1_600_000);
  await writeFile(file, JSON.stringify(saved));
  await shell.start();
  const input = shell
    .pane(chat.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  const start = performance.now();
  await input.pressSequentially("A short invented message", { delay: 20 });
  for (let i = 0; i < 12; i++) await input.press("Backspace");
  const expected = "A short invented message".slice(0, -12);
  await expect(input).toHaveValue(expected);
  await expect
    .poll(async () => {
      try {
        const data = await readFile(
          path.join(shell.data, "composer-text.json"),
          "utf8",
        );
        const entries = Object.values(JSON.parse(data).drafts) as Array<{
          draft: { text: string };
        }>;
        return (
          entries.some((entry) => entry.draft.text === expected) &&
          data.length < 2048
        );
      } catch {
        return false;
      }
    })
    .toBe(true);
  info.annotations.push({
    type: "input-duration-ms",
    description: String(Math.round(performance.now() - start)),
  });
  const disk = JSON.parse(await readFile(file, "utf8")) as AppState;
  expect(
    disk.workspaces.find((w) => w.id === workspace)?.chatDrafts?.[chat.paneId]
      ?.text ?? "",
  ).toBe("");
  await shell.stop();
  await shell.start();
  await expect(
    shell
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue(expected);
});

test("Enter sends chat, Shift Enter inserts a line and IME and model controls do not send", async () => {
  await shell.configure({ kimi: { options: true, multipleModels: true } });
  const workspace = await shell.create("Chat Enter behavior");
  const chat = await shell.newChat(workspace, "kimi");
  const host = shell.pane(chat.paneId);
  const input = host.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("First line");
  await input.press("Shift+Enter");
  await input.pressSequentially("Second line");
  await expect(input).toHaveValue("First line\nSecond line");
  await input.evaluate((node) =>
    node.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    ),
  );
  expect(await shell.prompts()).toHaveLength(0);
  const model = host.getByRole("button", { name: "Model", exact: true });
  await model.focus();
  await model.press("Enter");
  await expect(
    shell.page.getByRole("dialog", { name: "Actions", exact: true }),
  ).toBeVisible();
  expect(await shell.prompts()).toHaveLength(0);
  // Native dialog close events are queued. A newer focus must win if cleanup
  // reaches the renderer after the user has already returned to the composer.
  await shell.page
    .getByRole("dialog", { name: "Actions", exact: true })
    .evaluate((node: HTMLDialogElement) => {
      const closed = node.onclose;
      node.onclose = (event) => {
        (window as any).__finishMenuClose = () => closed?.call(node, event);
      };
    });
  await shell.page.keyboard.press("Escape");
  await shell.page.waitForFunction(
    () => typeof (window as any).__finishMenuClose === "function",
  );
  await input.focus();
  await shell.page.evaluate(() => (window as any).__finishMenuClose());
  await expect(input).toBeFocused();
  await input.press("Enter");
  await expect.poll(() => shell.prompts()).toHaveLength(1);
  await expect(input).toHaveValue("");
  await expect(transcript(chat)).toContainText("First line\nSecond line");
});

for (const provider of ["codex", "kimi"] as const) {
  test(`Busy ${provider} chat queues messages, edits in place and cancels without losing the next draft`, async () => {
    const workspace = await shell.create("Message queue");
    const chat = await shell.newChat(workspace, provider);
    if (provider === "codex")
      await shell.configure({ codex: { steering: "unsupported" } });
    await shell.send(chat.id, "First request [approve]");
    await expect.poll(() => status(chat.id)).toBe("waiting");
    const pane = shell.pane(chat.paneId);
    const input = pane.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("Original queued text");
    await input.press("Enter");
    const queue = pane.getByRole("region", { name: "Queued messages" });
    await expect(queue).toContainText("Original queued text");
    await expect(input).toHaveValue("");
    expect((await shell.prompts()).length).toBe(1);
    await shell.send(chat.id, "Cancel this queued text");
    await queue
      .locator(".queued-message")
      .filter({ hasText: "Cancel this queued text" })
      .getByRole("button", { name: "Cancel queued message", exact: true })
      .click();
    await expect(queue).not.toContainText("Cancel this queued text");
    const edit = queue.getByRole("button", {
      name: "Edit queued message",
      exact: true,
    });
    const field = queue.getByRole("textbox", { name: "Edit queued message" });
    await edit.click();
    await field.fill("Discard this unsaved revision");
    await queue
      .getByRole("button", {
        name: provider === "codex" ? "Save" : "Cancel",
        exact: true,
      })
      .press("Escape");
    await expect(field).toBeHidden();
    await expect(edit).toBeFocused();
    await expect(queue).toContainText("Original queued text");
    await expect.poll(() => status(chat.id)).toBe("waiting");
    await edit.click();
    await field.fill("Revised queued text");
    const permission = (await shell.inspect(chat.id)).pendingPermissions[0];
    await shell.cli(
      "conversation",
      "permission",
      "--id",
      chat.id,
      "--request-id",
      permission.id,
      "--option-id",
      permission.options[0].id,
    );
    await expect.poll(() => status(chat.id)).toBe("ready");
    // Completion cannot dispatch the entry while its editor is open.
    expect((await shell.prompts()).length).toBe(1);
    await input.fill("Keep this next draft");
    await queue.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(async () => text(await shell.inspect(chat.id)))
      .toContain("DONE Revised queued text");
    await expect(queue).toHaveCount(0);
    await expect(input).toHaveValue("Keep this next draft");
    expect((await shell.prompts()).length).toBe(2);
    await shell.stop();
    await shell.start();
    await shell.cli("conversation", "show", "--id", chat.id);
    await expect(
      shell
        .pane(chat.paneId)
        .getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("Keep this next draft");
  });
}

test("Queued messages and images survive restart and resume explicitly without replaying interrupted sends", async () => {
  const workspace = await shell.create("Durable message queue");
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "Hold initial request [hold]");
  await expect.poll(() => status(chat.id)).toBe("working");
  const image = {
    reference: 1,
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  };
  const first = await shell.cli<{ messageId: string }>(
    "conversation",
    "send",
    "--id",
    chat.id,
    "--text",
    "Image [Image 1]",
    "--images",
    JSON.stringify([image]),
  );
  await shell.send(chat.id, "Second queued message");
  await shell.stop();
  await shell.start();
  await shell.cli("conversation", "show", "--id", chat.id);
  const inspect = () =>
    shell.cli<ConversationState>("conversation", "inspect", "--id", chat.id);
  expect((await inspect()).queuedMessages?.map((m) => m.text)).toEqual([
    "Image [Image 1]",
    "Second queued message",
  ]);
  expect((await inspect()).queuedMessages?.[0].images).toEqual([image]);
  expect((await shell.prompts()).length).toBe(1);
  await shell.cli(
    "conversation",
    "queue-edit",
    "--id",
    chat.id,
    "--message-id",
    first.messageId,
    "--text",
    "Edited image [Image 1]",
  );
  const pane = shell.pane(chat.paneId);
  await expect(
    pane.getByRole("region", { name: "Queued messages" }).locator("img"),
  ).toHaveCount(1);
  await shell.page.screenshot({
    path: test.info().outputPath("message-queue.png"),
  });
  await shell.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(780, 650),
  );
  const queue = pane.getByRole("region", { name: "Queued messages" });
  const edit = queue
    .getByRole("button", { name: "Edit queued message", exact: true })
    .first();
  await edit.focus();
  await expect(edit).toBeFocused();
  expect(
    await queue.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await shell.page.screenshot({
    path: test.info().outputPath("message-queue-narrow.png"),
  });
  await pane
    .getByRole("button", { name: "Continue queue", exact: true })
    .click();
  await expect
    .poll(async () => text(await shell.inspect(chat.id)))
    .toContain("DONE Second queued message");
  await expect
    .poll(async () => (await inspect()).queuedMessages?.length)
    .toBe(0);
  expect((await shell.prompts()).length).toBe(3);
});

test("Interrupted sends pause remaining queued messages and restart never repeats an uncertain send", async () => {
  const workspace = await shell.create("Queue interruption");
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "First request [hold]");
  await expect.poll(() => status(chat.id)).toBe("working");
  await shell.send(chat.id, "Next request [hold]");
  await shell.cli("conversation", "interrupt", "--id", chat.id);
  await expect.poll(() => status(chat.id)).toBe("ready");
  const inspect = () =>
    shell.cli<ConversationState>("conversation", "inspect", "--id", chat.id);
  expect((await inspect()).queuePaused).toBe(true);
  expect((await shell.prompts()).length).toBe(1);
  await shell.cli("conversation", "queue-resume", "--id", chat.id);
  await expect.poll(() => status(chat.id)).toBe("working");
  await expect
    .poll(async () => (await inspect()).queuedMessages?.[0].status)
    .toBe("sending");
  await shell.send(chat.id, "Last queued request");
  await shell.stop();
  await shell.start();
  await shell.cli("conversation", "show", "--id", chat.id);
  await expect
    .poll(async () => (await inspect()).queuedMessages?.[0].status)
    .toBe("uncertain");
  expect((await inspect()).queuePaused).toBe(true);
  expect((await shell.prompts()).length).toBe(2);
  const blocked = await shell.raw(
    "conversation",
    "queue-resume",
    "--id",
    chat.id,
  );
  expect(blocked.code).not.toBe(0);
  expect(blocked.stderr).toContain("uncertain");
  const uncertain = (await inspect()).queuedMessages![0];
  await shell.cli(
    "conversation",
    "queue-remove",
    "--id",
    chat.id,
    "--message-id",
    uncertain.id,
  );
  await shell.cli("conversation", "queue-resume", "--id", chat.id);
  await expect
    .poll(async () => text(await shell.inspect(chat.id)))
    .toContain("DONE Last queued request");
  expect((await shell.prompts()).length).toBe(3);
});

test("A fragmented large composer request preserves its text and image through restart", async () => {
  const workspace = await shell.create("Large request fixture");
  const chat = await shell.newChat(workspace, "codex");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=",
    "base64",
  );
  const image = {
    reference: 1,
    mimeType: "image/png",
    name: "Invented large image",
    data: Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]).toString(
      "base64",
    ),
  };
  const wire = Buffer.from(
    JSON.stringify({
      op: "conversation.composer",
      workspace,
      paneId: chat.paneId,
      text: "Invented large request [Image 1]",
      images: [image],
    }) + "\n",
  );
  const reply = await new Promise<{ ok: boolean; error?: string }>(
    (resolve, reject) => {
      const connection = createConnection(shell.socket);
      let text = "";
      connection.setEncoding("utf8");
      connection.setTimeout(15000, () =>
        connection.destroy(new Error("Fixture request deadline")),
      );
      connection.on("error", reject);
      connection.on("data", (chunk) => {
        text += chunk;
        if (text.includes("\n")) {
          resolve(JSON.parse(text));
          connection.destroy();
        }
      });
      connection.on("connect", () => {
        void (async () => {
          for (let start = 0; start < wire.length; start += 4093) {
            if (!connection.write(wire.subarray(start, start + 4093)))
              await new Promise<void>((resolve) =>
                connection.once("drain", resolve),
              );
          }
        })();
      });
    },
  );
  expect(reply.ok, reply.error).toBe(true);
  const input = () =>
    shell
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
  await expect(input()).toHaveValue("Invented large request [Image 1]");
  await expect(
    shell.pane(chat.paneId).locator(".composer-images img"),
  ).toHaveCount(1);
  await shell.stop();
  await shell.start();
  await expect(input()).toHaveValue("Invented large request [Image 1]");
  await expect(
    shell.pane(chat.paneId).locator(".composer-images img"),
  ).toHaveCount(1);
});

for (const provider of ["codex", "kimi"] as const)
  test(`Native handoff ${provider}: pending review and form guards preserve the controller and unsent message`, async ({}, info) => {
    const workspace = await shell.create("Handoff feedback fixture");
    await shell.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      shell.folders[0],
    );
    const reviewChat = await shell.newChat(workspace, provider);
    await shell.cli(
      "review",
      "open-document",
      "--workspace",
      workspace,
      "--path",
      shell.file,
      "--conversation",
      reviewChat.id,
    );
    async function handoffAction(id: string) {
      await removalMenu(id);
      return shell.page
        .getByRole("dialog", { name: "Actions", exact: true })
        .getByRole("button", { name: "Continue in CLI", exact: true });
    }
    const beforeReview = await shell.cli<AppState>("state");
    let action = await handoffAction(reviewChat.id);
    await expect(action).toBeDisabled();
    await expect(action).toHaveAttribute("title", /pending review/);
    await shell.page.keyboard.press("Escape");
    const reviewResult = await shell.raw(
      "conversation",
      "handoff",
      "--id",
      reviewChat.id,
    );
    expect(reviewResult.code).not.toBe(0);
    expect(reviewResult.stderr).toContain("pending review");
    expect((await shell.cli<AppState>("state")).reviews).toEqual(
      beforeReview.reviews,
    );
    expect((await shell.inspect(reviewChat.id)).nativeId).toBe(
      reviewChat.nativeId,
    );
    expect(await status(reviewChat.id)).toBe("ready");

    const chat = await shell.newChat(workspace, provider);
    const unsent = "Keep my next message while handing off";
    await shell.cli(
      "conversation",
      "composer",
      "--workspace",
      workspace,
      "--pane-id",
      chat.paneId,
      "--text",
      unsent,
    );
    const file = path.join(shell.folders[0], "handoff-form.html");
    await writeFile(
      file,
      '<!doctype html><title>Invented handoff form</title><form><input name="answer"><button>Submit</button></form>',
    );
    const page = await shell.cli<{ id: string }>(
      "page",
      "open",
      "--workspace",
      workspace,
      "--conversation",
      chat.id,
      "--path",
      file,
    );
    action = await handoffAction(chat.id);
    await expect(action).toBeDisabled();
    await expect(action).toHaveAttribute("title", /interactive page/);
    await shell.page.screenshot({
      path: info.outputPath("guarded-handoff.png"),
    });
    await shell.page.keyboard.press("Escape");
    const formResult = await shell.raw(
      "conversation",
      "handoff",
      "--id",
      chat.id,
    );
    expect(formResult.code).not.toBe(0);
    expect(formResult.stderr).toContain("interactive page");
    let state = await shell.cli<AppState>("state");
    expect(state.terminals).toHaveLength(0);
    expect(
      state.conversations.find((c) => c.id === chat.id)?.handoffTerminalId,
    ).toBeUndefined();
    expect(state.browsers.some((b) => b.id === page.id)).toBe(true);
    expect(
      state.workspaces.find((w) => w.id === workspace)?.chatDrafts?.[
        chat.paneId
      ]?.text,
    ).toBe(unsent);
    expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
    expect(await status(chat.id)).toBe("ready");
    expect(await shell.prompts()).toHaveLength(0);
    await shell.cli("browser", "close", "--id", page.id);
    action = await handoffAction(chat.id);
    await expect(action).toBeEnabled();
    await tabTo(shell.page, action);
    await shell.page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          ((await shell.inspect(chat.id)) as unknown as ConversationState)
            .handoffTerminalId,
      )
      .toBeTruthy();
    const handed = await shell.cli<AppState>("state");
    const terminalId = handed.conversations.find(
      (c) => c.id === chat.id,
    )!.handoffTerminalId!;
    expect(handed.terminals.find((t) => t.id === terminalId)?.cwd).toBe(
      shell.folders[0],
    );
    await shell.cli("terminal", "close", "--id", terminalId);
    await shell.cli("conversation", "reclaim", "--id", chat.id);
    expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
    await expect(
      shell
        .pane(chat.paneId)
        .getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue(unsent);
    expect(await shell.prompts()).toHaveLength(0);
    await shell.stop();
    await shell.start();
    await shell.cli("conversation", "show", "--id", chat.id);
    await expect(
      shell
        .pane(chat.paneId)
        .getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue(unsent);
    expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
    expect(await shell.prompts()).toHaveLength(0);
  });

test("Native handoff waits for an already accepted review mutation before checking its guard", async () => {
  const workspace = await shell.create("Ordered handoff fixture");
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    shell.folders[0],
  );
  const chat = await shell.newChat(workspace, "codex");
  await shell.app!.evaluate(({ ipcMain }, file) => {
    const fs = process.getBuiltinModule("fs/promises") as any;
    const open = fs.open;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (globalThis as any).reviewReadHeld = false;
    (globalThis as any).handoffEntered = false;
    fs.open = async (...args: any[]) => {
      if (args[0] === file && !(globalThis as any).reviewReadHeld) {
        (globalThis as any).reviewReadHeld = true;
        await gate;
      }
      return open.apply(fs, args);
    };
    const handler = (ipcMain as any)._invokeHandlers.get("cod:invoke");
    ipcMain.removeHandler("cod:invoke");
    ipcMain.handle("cod:invoke", (event, request) => {
      if (request.op === "conversation.handoff")
        (globalThis as any).handoffEntered = true;
      return handler(event, request);
    });
    (globalThis as any).releaseReviewRead = () => {
      fs.open = open;
      ipcMain.removeHandler("cod:invoke");
      ipcMain.handle("cod:invoke", handler);
      release();
    };
  }, shell.file);
  await shell.page.evaluate(
    ({ workspace, id, file }) => {
      (window as any).orderedReview = window.cod.invoke({
        op: "review.open-document",
        workspace,
        conversation: id,
        path: file,
      });
    },
    { workspace, id: chat.id, file: shell.file },
  );
  await expect
    .poll(() => shell.app!.evaluate(() => (globalThis as any).reviewReadHeld))
    .toBe(true);
  await shell.page.evaluate((id) => {
    (window as any).orderedHandoff = window.cod
      .invoke({ op: "conversation.handoff", id })
      .then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error: String(error) }),
      );
  }, chat.id);
  await expect
    .poll(() => shell.app!.evaluate(() => (globalThis as any).handoffEntered))
    .toBe(true);
  await shell.app!.evaluate(() => (globalThis as any).releaseReviewRead());
  await shell.page.evaluate(() => (window as any).orderedReview);
  const result = await shell.page.evaluate(
    () => (window as any).orderedHandoff,
  );
  expect(result.ok).toBe(false);
  expect(result.error).toContain("pending review");
  const state = await shell.cli<AppState>("state");
  expect(state.terminals).toHaveLength(0);
  expect(
    state.reviews?.some((review) => review.originConversationId === chat.id),
  ).toBe(true);
  expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
  expect(await status(chat.id)).toBe("ready");
  expect(await shell.prompts()).toHaveLength(0);
});

async function nativeSessionPicker(source = shell.page) {
  if (source === shell.page) await source.keyboard.press(`${modifier}+Shift+p`);
  else
    await shell.app!.evaluate(({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL() === url)!;
      contents.focus();
      const modifiers: Array<"control" | "meta" | "shift"> = [
        process.platform === "darwin" ? "meta" : "control",
        "shift",
      ];
      contents.sendInputEvent({ type: "keyDown", keyCode: "P", modifiers });
      contents.sendInputEvent({ type: "keyUp", keyCode: "P", modifiers });
    }, source.url());
  const command = shell.page
    .getByRole("dialog", { name: "Command palette", exact: true })
    .getByRole("textbox", { name: "Filter commands", exact: true });
  await command.fill("Open existing native session");
  await command.press("Enter");
  const picker = shell.page.getByRole("dialog", {
    name: "Open existing session",
    exact: true,
  });
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("textbox", { name: "Filter sessions", exact: true }),
  ).toBeFocused();
  return picker;
}

for (const provider of ["codex", "kimi"] as const)
  test(`Native session picker ${provider}: search, resume and refocus retain identity without inference`, async ({}, info) => {
    const factory =
      provider === "codex" ? createCodexAdapter : createKimiAdapter;
    const native: Array<{ nativeId: string; cwd: string }> = [];
    for (const prompt of [
      "First invented native history",
      "Second invented native history",
    ]) {
      const adapter = factory({
        cwd: shell.folders[0],
        executable: process.execPath,
        args: JSON.parse(
          shell.environment[`COD_${provider.toUpperCase()}_ARGS`],
        ),
        env: shell.environment,
      });
      try {
        const session = await adapter.create();
        await adapter.send(prompt);
        native.push(session);
      } finally {
        await adapter.dispose();
      }
    }
    await shell.configure({
      [provider]: {
        sessions: native.map((session, index) => ({
          nativeId: session.nativeId,
          cwd: session.cwd,
          name: `Catalog choice ${index + 1}`,
          preview: index
            ? "Invented alpine evidence"
            : "Invented coastal evidence",
        })),
      },
    });
    const workspace = await shell.create("Native catalog task");
    await shell.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      shell.folders[0],
    );
    const original = await shell.newChat(workspace, provider);
    // The CLI reply precedes the renderer snapshot. Target the conversation,
    // rather than typing into its still-visible empty-chat placeholder.
    await expect(shell.pane(original.paneId)).toHaveAttribute(
      "aria-label",
      `${provider} conversation`,
    );
    const input = shell
      .pane(original.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
    await input.fill("Preserve the catalog invoker draft");
    await input.evaluate((node) =>
      (node as HTMLTextAreaElement).setSelectionRange(3, 9),
    );
    let picker = await nativeSessionPicker();
    if (provider === "kimi")
      await picker
        .getByRole("combobox", { name: "Provider", exact: true })
        .selectOption(provider);
    await expect(
      picker.getByRole("button", { name: /Catalog choice 1/ }),
    ).toBeVisible();
    const before = (await shell.records()).filter((record) =>
      ["thread/list", "session/list"].includes(record.message?.method ?? ""),
    ).length;
    const filter = picker.getByRole("textbox", {
      name: "Filter sessions",
      exact: true,
    });
    await filter.fill("NO SUCH CATALOG ENTRY");
    await expect(picker.getByRole("status")).toHaveText(
      "No matching sessions.",
    );
    await filter.fill("ALPINE");
    await expect(
      picker.getByRole("button", { name: /Catalog choice 2/ }),
    ).toBeVisible();
    await expect(
      picker.getByRole("button", { name: /Catalog choice 1/ }),
    ).toBeHidden();
    expect(
      (await shell.records()).filter((record) =>
        ["thread/list", "session/list"].includes(record.message?.method ?? ""),
      ).length,
    ).toBe(before);
    await filter.press("ArrowDown");
    expect((await shell.cli<AppState>("state")).conversations).toHaveLength(1);
    expect(await shell.prompts()).toHaveLength(2);
    await filter.press("Escape");
    await expect(input).toBeFocused();
    expect(
      await input.evaluate((node) => [
        (node as HTMLTextAreaElement).selectionStart,
        (node as HTMLTextAreaElement).selectionEnd,
      ]),
    ).toEqual([3, 9]);
    picker = await nativeSessionPicker();
    if (provider === "kimi")
      await picker
        .getByRole("combobox", { name: "Provider", exact: true })
        .selectOption(provider);
    const query = picker.getByRole("textbox", {
      name: "Filter sessions",
      exact: true,
    });
    await query.fill(
      `${native[1].nativeId.slice(-8)} ${path.basename(shell.folders[0])}`,
    );
    const row = picker.getByRole("button", { name: /Catalog choice 2/ });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("title", new RegExp(native[1].nativeId));
    await picker.screenshot({
      path: info.outputPath("native-session-search.png"),
    });
    if (provider === "codex") await query.press("Enter");
    else await row.click();
    await expect(picker).toHaveCount(0);
    await expect
      .poll(
        async () => (await shell.cli<AppState>("state")).conversations.length,
      )
      .toBe(2);
    const state = await shell.cli<AppState>("state");
    const attached = state.conversations.find(
      (conversation) => conversation.nativeId === native[1].nativeId,
    )!;
    expect(
      state.workspaces.find((item) => item.id === workspace)?.chatDrafts?.[
        original.paneId
      ]?.text,
    ).toBe("Preserve the catalog invoker draft");
    expect(attached.cwd).toBe(shell.folders[0]);
    const attachedInput = shell
      .pane(attached.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
    await expect(attachedInput).toBeFocused();
    await expect(transcript(attached)).toContainText(
      "DONE Second invented native history",
    );
    await attachedInput.fill("Unsent message in the attached history");
    await expect
      .poll(
        async () =>
          (await shell.cli<AppState>("state")).workspaces.find(
            (w) => w.id === workspace,
          )?.chatDrafts?.[attached.paneId]?.text,
      )
      .toBe("Unsent message in the attached history");
    const elsewhere = await shell.create("Another native catalog task");
    const records = await shell.records();
    const duplicate = await shell.cli<{
      id: string;
      paneId: string;
      nativeId: string;
    }>(
      "conversation",
      "resume",
      "--workspace",
      elsewhere,
      "--provider",
      provider,
      "--cwd",
      shell.folders[1],
      "--native-id",
      native[1].nativeId,
    );
    expect(duplicate.id).toBe(attached.id);
    expect(duplicate.paneId).toBe(attached.paneId);
    const ownership = (items: typeof records) =>
      items.filter(
        (record) =>
          record.event === "started" ||
          [
            "thread/start",
            "thread/resume",
            "session/new",
            "session/load",
          ].includes(record.message?.method ?? ""),
      );
    expect(ownership(await shell.records())).toEqual(ownership(records));
    expect((await shell.cli<AppState>("state")).activeWorkspaceId).toBe(
      workspace,
    );
    await attachedInput.focus();
    await attachedInput.evaluate((node) =>
      (node as HTMLTextAreaElement).setSelectionRange(2, 8),
    );
    picker = await nativeSessionPicker();
    if (provider === "kimi")
      await picker
        .getByRole("combobox", { name: "Provider", exact: true })
        .selectOption(provider);
    if (provider === "codex") {
      await tabTo(shell.page, picker.locator("summary"));
      await shell.page.keyboard.press("Enter");
    } else
      await picker.getByText("Open by session ID", { exact: true }).click();
    const manual = picker.getByRole("textbox", {
      name: "Native session ID",
      exact: true,
    });
    await manual.fill(native[1].nativeId);
    await manual.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
    });
    await manual.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
    });
    await expect(picker).toBeVisible();
    const bindingsBefore = (await shell.records()).filter((record) =>
      ["thread/resume", "session/load"].includes(record.message?.method ?? ""),
    ).length;
    await manual.press("Enter");
    await expect(picker).toHaveCount(0);
    await expect(attachedInput).toBeFocused();
    await expect(attachedInput).toHaveValue(
      "Unsent message in the attached history",
    );
    expect(
      await attachedInput.evaluate((node) => [
        (node as HTMLTextAreaElement).selectionStart,
        (node as HTMLTextAreaElement).selectionEnd,
      ]),
    ).toEqual([2, 8]);
    expect(
      (await shell.records()).filter((record) =>
        ["thread/resume", "session/load"].includes(
          record.message?.method ?? "",
        ),
      ).length,
    ).toBe(bindingsBefore);
    expect((await shell.cli<AppState>("state")).conversations).toHaveLength(2);
    expect(await shell.prompts()).toHaveLength(2);
  });

test("Native session picker ignores superseded results and errors, recovers from failure and preserves focus on cancel", async ({}, info) => {
  const workspace = await shell.create("Read-only native catalog");
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    shell.folders[0],
  );
  const chat = await shell.newChat(workspace, "codex");
  await expect(shell.pane(chat.paneId)).toHaveAttribute(
    "aria-label",
    "codex conversation",
  );
  const input = shell
    .pane(chat.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Keep this unsent message and selection");
  await input.evaluate((node) =>
    (node as HTMLTextAreaElement).setSelectionRange(4, 12),
  );
  const entry = {
    nativeId: "invented-native-catalog-id",
    cwd: shell.folders[0],
    name: "Fresh recovered session with a deliberately long invented title and repeated context. ".repeat(
      4,
    ),
    preview: "Searchable recovery evidence",
  };
  await shell.configure({
    codex: { discoveryError: true, discoveryDelayMs: 300 },
    kimi: { sessions: [entry] },
  });
  await shell.app!.evaluate(({ ipcMain }) => {
    const handler = (ipcMain as any)._invokeHandlers.get("cod:invoke");
    (globalThis as any).pickerDiscoverySettled = { codex: 0, kimi: 0 };
    ipcMain.removeHandler("cod:invoke");
    ipcMain.handle("cod:invoke", async (event, request) => {
      try {
        return await handler(event, request);
      } finally {
        if (request.op === "conversation.discover")
          (globalThis as any).pickerDiscoverySettled[request.provider]++;
      }
    });
    (globalThis as any).restorePickerHandler = () => {
      ipcMain.removeHandler("cod:invoke");
      ipcMain.handle("cod:invoke", handler);
    };
  });
  let picker = await nativeSessionPicker();
  await expect
    .poll(
      async () =>
        (await shell.records()).filter(
          (record) => record.message?.method === "thread/list",
        ).length,
    )
    .toBe(1);
  await picker
    .getByRole("combobox", { name: "Provider", exact: true })
    .selectOption("kimi");
  await expect(
    picker.getByRole("button", { name: /Fresh recovered session/ }),
  ).toBeVisible();
  await expect
    .poll(() =>
      shell.app!.evaluate(
        () => (globalThis as any).pickerDiscoverySettled.codex,
      ),
    )
    .toBe(1);
  await shell.page.evaluate(() => window.cod.invoke({ op: "capabilities" }));
  await expect(picker.getByRole("status")).toHaveText("");
  await expect(
    picker.getByRole("textbox", { name: "Filter sessions", exact: true }),
  ).toBeFocused();
  await picker
    .getByRole("combobox", { name: "Provider", exact: true })
    .selectOption("codex");
  await expect
    .poll(
      async () =>
        (await shell.records()).filter(
          (record) => record.message?.method === "thread/list",
        ).length,
    )
    .toBe(2);
  await shell.page.keyboard.press("Escape");
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((node) => [
      (node as HTMLTextAreaElement).selectionStart,
      (node as HTMLTextAreaElement).selectionEnd,
    ]),
  ).toEqual([4, 12]);
  await shell.configure({ codex: { sessions: [entry] } });
  picker = await nativeSessionPicker();
  await expect(
    picker.getByRole("button", { name: /Fresh recovered session/ }),
  ).toBeVisible();
  await expect
    .poll(() =>
      shell.app!.evaluate(
        () => (globalThis as any).pickerDiscoverySettled.codex,
      ),
    )
    .toBe(3);
  await shell.page.evaluate(() => window.cod.invoke({ op: "capabilities" }));
  await expect(picker.getByRole("status")).toHaveText("");
  await expect(
    picker.getByRole("textbox", { name: "Filter sessions", exact: true }),
  ).toBeFocused();
  await shell.configure({ codex: { discoveryError: true } });
  await picker
    .getByRole("button", { name: "Find sessions", exact: true })
    .click();
  await expect(picker.getByRole("alert")).toContainText(
    "Invented discovery failure",
  );
  const catalog = [
    entry,
    ...Array.from({ length: 999 }, (_, index) => ({
      nativeId: `invented-catalog-${index}`,
      cwd: shell.folders[0],
      name: index ? `Invented metadata session ${index}` : "",
      preview: index ? "Metadata-only fixture" : "",
    })),
  ];
  await shell.configure({ codex: { sessions: catalog } });
  await picker
    .getByRole("textbox", { name: "Filter sessions", exact: true })
    .fill("recovery");
  await picker
    .getByRole("textbox", { name: "Working directory", exact: true })
    .press("Enter");
  await expect(
    picker.getByRole("button", { name: /Fresh recovered session/ }),
  ).toBeVisible();
  const filter = picker.getByRole("textbox", {
    name: "Filter sessions",
    exact: true,
  });
  await filter.fill("");
  await expect(picker.locator(".command-list button")).toHaveCount(1000);
  await expect(
    picker.getByRole("button", { name: /invented-catalog-0/ }),
  ).toBeVisible();
  await filter.evaluate((node) => {
    (window as any).catalogInputFrames = [];
    node.addEventListener(
      "input",
      () => {
        const started = performance.now();
        requestAnimationFrame(() =>
          (window as any).catalogInputFrames.push(performance.now() - started),
        );
      },
      { capture: true },
    );
  });
  await filter.pressSequentially("recovery");
  const samples = await filter.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    return (window as any).catalogInputFrames as number[];
  });
  expect(samples).toHaveLength(8);
  const sorted = [...samples].sort((left, right) => left - right);
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const performanceFile = info.outputPath(
    "native-session-search-performance.json",
  );
  await writeFile(
    performanceFile,
    JSON.stringify({ catalogSize: 1000, samples, p95Ms: p95 }),
  );
  await info.attach("native-session-search-performance", {
    path: performanceFile,
    contentType: "application/json",
  });
  expect(p95).toBeLessThan(200);
  await shell.page.setViewportSize({ width: 400, height: 650 });
  expect((await picker.boundingBox())!.width).toBeLessThanOrEqual(400);
  expect(
    await picker.evaluate((node) => node.scrollWidth - node.clientWidth),
  ).toBeLessThanOrEqual(1);
  await picker.screenshot({
    path: info.outputPath("native-session-search-narrow.png"),
  });
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  await shell.page.setViewportSize({ width: 1280, height: 800 });
  await expect(picker).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Keep this unsent message and selection");
  expect(
    await input.evaluate((node) => [
      (node as HTMLTextAreaElement).selectionStart,
      (node as HTMLTextAreaElement).selectionEnd,
    ]),
  ).toEqual([4, 12]);
  expect(await shell.prompts()).toHaveLength(0);
  expect(
    (await shell.records()).filter((record) =>
      ["thread/resume", "session/load"].includes(record.message?.method ?? ""),
    ),
  ).toHaveLength(0);
  await shell.app!.evaluate(() => (globalThis as any).restorePickerHandler());
});

for (const provider of ["codex", "kimi"] as const)
  test(`Concurrent native resume ${provider} creates one controller after delayed directory checks`, async () => {
    const factory =
      provider === "codex" ? createCodexAdapter : createKimiAdapter;
    const adapter = factory({
      cwd: shell.folders[0],
      executable: process.execPath,
      args: JSON.parse(shell.environment[`COD_${provider.toUpperCase()}_ARGS`]),
      env: shell.environment,
    });
    let nativeId: string;
    try {
      nativeId = (await adapter.create()).nativeId;
      await adapter.send("Invented native concurrency history");
    } finally {
      await adapter.dispose();
    }
    const first = await shell.create("First resume destination");
    const second = await shell.create("Second resume destination");
    await shell.app!.evaluate(({}, directory) => {
      const fs = process.getBuiltinModule("fs/promises") as any;
      const stat = fs.stat;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      (globalThis as any).resumeDirectoryChecks = 0;
      fs.stat = async (...args: any[]) => {
        if (
          args[0] === directory &&
          (globalThis as any).resumeDirectoryChecks < 2
        ) {
          (globalThis as any).resumeDirectoryChecks++;
          await gate;
        }
        return stat.apply(fs, args);
      };
      (globalThis as any).releaseResumeDirectoryChecks = () => {
        fs.stat = stat;
        release();
      };
    }, shell.folders[0]);
    const requests = [first, second].map((workspace) =>
      shell.cli<{ id: string; paneId: string; nativeId: string }>(
        "conversation",
        "resume",
        "--workspace",
        workspace,
        "--provider",
        provider,
        "--cwd",
        shell.folders[0],
        "--native-id",
        nativeId,
      ),
    );
    await expect
      .poll(() =>
        shell.app!.evaluate(() => (globalThis as any).resumeDirectoryChecks),
      )
      .toBe(2);
    await shell.app!.evaluate(() =>
      (globalThis as any).releaseResumeDirectoryChecks(),
    );
    const results = await Promise.all(requests);
    expect(results[0]).toEqual(results[1]);
    const state = await shell.cli<AppState>("state");
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0].nativeId).toBe(nativeId);
    expect(state.conversations[0].cwd).toBe(shell.folders[0]);
    expect(
      state.workspaces
        .flatMap((workspace) => workspace.panes)
        .filter((pane) => pane.kind === "conversation"),
    ).toHaveLength(1);
    expect(
      (await shell.records()).filter((record) =>
        ["thread/resume", "session/load"].includes(
          record.message?.method ?? "",
        ),
      ),
    ).toHaveLength(1);
    expect(await shell.prompts()).toHaveLength(1);
  });

test("Native session picker returns to native browser input on cancel and focuses the attached chat on selection", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><title>Native picker invoker</title><textarea aria-label="Native invoker">Native selected message</textarea>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture server address unavailable");
    const url = `http://127.0.0.1:${address.port}`;
    const workspace = await shell.create("Native browser picker task");
    await shell.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      shell.folders[0],
    );
    const chat = await shell.newChat(workspace, "codex");
    await shell.configure({
      codex: {
        sessions: [
          {
            nativeId: chat.nativeId,
            cwd: shell.folders[0],
            name: "Already attached native chat",
          },
        ],
      },
    });
    const browser = await shell.cli<{ id: string; paneId: string }>(
      "browser",
      "open",
      "--workspace",
      workspace,
      "--url",
      url,
    );
    await shell.page
      .locator(`[role=tab][data-tab-id="${browser.paneId}"]`)
      .click();
    let nativePage: typeof shell.page | undefined;
    await expect
      .poll(() => {
        nativePage = shell
          .app!.context()
          .pages()
          .find((page) => page.url().startsWith(url));
        return !!nativePage;
      })
      .toBe(true);
    const input = nativePage!.getByRole("textbox", {
      name: "Native invoker",
      exact: true,
    });
    await input.click();
    await input.evaluate((node) =>
      (node as HTMLTextAreaElement).setSelectionRange(3, 10),
    );
    let picker = await nativeSessionPicker(nativePage!);
    await picker
      .getByRole("textbox", { name: "Filter sessions", exact: true })
      .press("Escape");
    await expect
      .poll(() => nativePage!.evaluate(() => document.hasFocus()))
      .toBe(true);
    await expect(input).toBeFocused();
    expect(
      await input.evaluate((node) => [
        (node as HTMLTextAreaElement).selectionStart,
        (node as HTMLTextAreaElement).selectionEnd,
      ]),
    ).toEqual([3, 10]);
    picker = await nativeSessionPicker(nativePage!);
    await picker
      .getByRole("textbox", { name: "Filter sessions", exact: true })
      .fill("Already attached");
    await expect(
      picker.getByRole("button", { name: /Already attached native chat/ }),
    ).toBeVisible();
    await picker
      .getByRole("textbox", { name: "Filter sessions", exact: true })
      .press("Enter");
    await expect(picker).toHaveCount(0);
    await expect(
      shell
        .pane(chat.paneId)
        .getByRole("textbox", { name: "Message", exact: true }),
    ).toBeFocused();
    await expect
      .poll(() => shell.page.evaluate(() => document.hasFocus()))
      .toBe(true);
    expect((await shell.workspace(workspace)).activePaneId).toBe(chat.paneId);
    expect((await shell.cli<AppState>("state")).conversations).toHaveLength(1);
    expect(await shell.prompts()).toHaveLength(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
