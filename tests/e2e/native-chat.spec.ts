import { test, expect, type Locator } from "@playwright/test";
import type { ConversationState } from "../../src/types";
import { createServer } from "node:http";
import path from "node:path";
import { mkdir, symlink } from "node:fs/promises";
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
    await pane
      .locator(".tool-activity")
      .filter({ hasText: /invented-tool/ })
      .first()
      .locator("summary")
      .click();
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
    expect(
      (
        await shell.raw(
          "conversation",
          "send",
          "--id",
          chat.id,
          "--text",
          "concurrent-turn",
        )
      ).code,
    ).not.toBe(0);
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
    await expect(pane.getByText(/failed|exited|error/i).first()).toBeVisible();
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
    expect(
      (
        await shell.raw(
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
        )
      ).code,
    ).not.toBe(0);
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
      .filter({ hasText: "invented-tool" })
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
  const liveTool = shell
    .pane(chat.paneId)
    .locator(".tool-activity")
    .filter({ hasText: "invented-tool" })
    .first();
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
  const restored = await shell.inspect(chat.id);
  const assistant = restored.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("\n");
  expect(assistant.split(`DONE ${original}`).length - 1).toBe(1);
  const rendered = await transcript(chat).innerText();
  expect(rendered.indexOf(`DONE ${original}`)).toBeLessThan(
    rendered.indexOf("[hold] after-partial-load"),
  );
  await expect(
    shell
      .pane(chat.paneId)
      .getByText("Earlier messages are not shown", { exact: true }),
  ).toBeVisible();
  // Keeping cached context or showing only authoritative partial history are valid;
  // if cached leading text remains, its original position must remain before the tail.
  if (rendered.includes(`STREAM ${original}`))
    expect(rendered.indexOf(`STREAM ${original}`)).toBeLessThan(
      rendered.indexOf(`DONE ${original}`),
    );
});
