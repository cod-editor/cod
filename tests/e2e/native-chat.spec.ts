import { readWorkspaceChatDraftBody } from "./helpers/workspace-state";
import {
  openWorkspaceState,
  readWorkspaceState,
  writeWorkspaceState,
} from "../support/workspace-state";
import { test, expect, type Locator } from "@playwright/test";
import type { AppState, ConversationState } from "../../src/types";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import {
  LocalOwnerUnavailable,
  LocalProviderOwner,
} from "../../src/providers/local-owner-client";
import { localOwnerSockets } from "../../src/providers/local-owner-protocol";
import { createServer } from "node:http";
import path from "node:path";
import {
  cp,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import {
  ChatApp,
  type Chat,
  type Provider,
} from "./helpers/chat-fixture/harness";
import { questionAnswers } from "../../src/codex-questions";
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
const text = (chat: Pick<Chat, "messages">) =>
  chat.messages.map((message) => message.text).join("\n");

test("Routine collaboration stays in ordered activity details through completion and reopen", async ({}, info) => {
  const workspace = await shell.create("Invented collaboration workspace");
  const chat = await shell.newChat(workspace, "codex");
  const pane = () => shell.pane(chat.paneId);
  const activity = () => transcript(chat).locator("details.turn-activity");
  const summary = () => activity().locator(":scope > summary");
  const calls = () => activity().locator(":scope > .tool-activity > summary");
  const call = (name: string) =>
    activity()
      .locator(":scope > .tool-activity")
      .filter({
        has: shell.page.getByText(name, { exact: true }),
      });

  await shell.send(chat.id, "[collab-details] Coordinate invented work");
  await expect.poll(() => status(chat.id)).toBe("working");
  await expect(summary()).toHaveText("Activity");
  await expect(calls()).toHaveText(["spawnAgent", "sendInput"]);
  await expect(
    pane().getByRole("button", { name: "Agents, 1 running" }),
  ).toBeVisible();
  await expect(calls().first()).toBeHidden();
  await expect(transcript(chat)).toContainText("Coordinate invented work");
  await pane().screenshot({
    path: info.outputPath("active-collaboration-collapsed.png"),
  });

  await shell.configure({ codex: { showMixedCollaboration: true } });
  await expect(summary()).toHaveText("Run echo");
  await expect(calls()).toHaveText([
    "spawnAgent",
    "sendInput · failed",
    "Run echo",
    "wait",
  ]);
  await summary().click();
  await expect(calls().first()).toBeVisible();
  await call("sendInput · failed").locator("summary").click();
  await expect(call("sendInput · failed").locator("pre")).toContainText(
    "Invented agent call rejected",
  );
  await pane().screenshot({
    path: info.outputPath("active-collaboration-expanded.png"),
  });
  await summary().click();

  await shell.configure({
    codex: { showMixedCollaboration: true, finishCollaboration: true },
  });
  await expect.poll(() => status(chat.id)).toBe("ready");
  await expect(
    transcript(chat).getByText("Invented final reply"),
  ).toBeVisible();
  await expect(summary()).not.toContainText(/spawnAgent|sendInput|wait/);
  await expect(calls().first()).toBeHidden();
  await shell.stop();
  await shell.start();
  await shell.cli("conversation", "show", "--id", chat.id);
  await expect(
    transcript(chat).getByText("Invented final reply"),
  ).toBeVisible();
  await expect(calls()).toHaveText([
    "spawnAgent",
    "sendInput · failed",
    "Run echo",
    "wait",
  ]);
  await expect(calls().first()).toBeHidden();
  await summary().click();
  await call("sendInput · failed").locator("summary").click();
  await expect(call("sendInput · failed").locator("pre")).toContainText(
    "Invented agent call rejected",
  );
});

test("Markdown file links resolve encoded Unicode without changing literal paths", async ({}, info) => {
  await shell.configure({ codex: { finalOnly: true } });
  const workspace = await shell.create("Invented Markdown reference workspace");
  const chat = await shell.newChat(workspace, "codex");
  const folder = shell.folders[0];
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    folder,
  );
  const file = path.join(folder, "заметка #1.md");
  const encoded = file.split("/").map(encodeURIComponent).join("/");
  const literal = path.join(folder, "literal%20name.md");
  const malformed = "malformed-%D0.md";
  const escapedBoundary = "hidden%2Fnote.md";
  const escapedDrive = "C%3A/document.md";
  const contents = "First invented line\nSecond invented line\n";
  await Promise.all([
    mkdir(path.join(folder, "hidden")),
    mkdir(path.join(folder, "C:")),
  ]);
  await Promise.all([
    writeFile(file, contents),
    writeFile(literal, "Literal percent file"),
    writeFile(path.join(folder, "literal name.md"), "Decoded twin"),
    writeFile(path.join(folder, "hidden", "note.md"), "Unexpected target"),
    writeFile(
      path.join(folder, "C:", "document.md"),
      "Unexpected drive target",
    ),
  ]);

  await shell.send(
    chat.id,
    [
      `[Open encoded note](${encoded}:2)`,
      `[Open literal percent name](literal%20name.md)`,
      `[Malformed reference](${malformed})`,
      `[Escaped separator](${escapedBoundary})`,
      `[Escaped drive](${escapedDrive})`,
    ].join("\n\n"),
  );
  const reply = transcript(chat).locator(".chat-message.assistant");
  const link = (name: string) => reply.getByRole("link", { name, exact: true });
  const target = () =>
    shell.page.getByRole("textbox", { name: "File contents" });
  const statusText = shell.page.locator("#status");
  await link("Open encoded note").focus();
  await expect(link("Open encoded note")).toBeFocused();
  await shell.page.keyboard.press("Enter");
  await expect(target()).toHaveValue(contents);
  await expect(target()).toBeFocused();
  await expect
    .poll(() =>
      target().evaluate((editor: HTMLTextAreaElement) => editor.selectionStart),
    )
    .toBe(contents.indexOf("\n") + 1);
  await shell.page.screenshot({
    path: info.outputPath("encoded-file-reference.png"),
  });

  await link("Open literal percent name").click();
  await expect(target()).toHaveValue("Literal percent file");
  for (const [name, reference] of [
    ["Malformed reference", malformed],
    ["Escaped separator", escapedBoundary],
    ["Escaped drive", escapedDrive],
  ]) {
    await link(name).click();
    await expect(statusText).toHaveText(`File not found: ${reference}`);
    await expect(target()).toHaveValue("Literal percent file");
  }
  expect(
    await shell.cli(
      "file",
      "resolve",
      "--workspace",
      workspace,
      "--path",
      encoded,
    ),
  ).toEqual({ candidates: [] });
  expect(
    await shell.cli(
      "file",
      "resolve",
      "--workspace",
      workspace,
      "--path",
      literal,
    ),
  ).toEqual({ candidates: [{ path: literal }] });

  const previewLink = "Open encoded reference from preview";
  const index = path.join(folder, "reference-index.md");
  await writeFile(
    index,
    `[${previewLink}](${encodeURIComponent(path.basename(file))}:2)`,
  );
  await shell.cli("file", "open", "--workspace", workspace, "--path", index);
  await shell.page
    .getByRole("button", { name: "Preview Markdown", exact: true })
    .click();
  await shell.page
    .getByRole("region", { name: "Markdown preview", exact: true })
    .locator("iframe")
    .contentFrame()
    .getByRole("link", { name: previewLink, exact: true })
    .click();
  await expect(target()).toHaveValue(contents);
});

test("Assistant visualization links open sandboxed HTML beside the chat", async ({}, info) => {
  await shell.configure({ codex: { finalOnly: true } });
  const source = await shell.create("Original visualization workspace");
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    source,
    "--path",
    shell.folders[1],
  );
  const chat = await shell.newChat(source, "codex");
  const file = path.join(shell.folders[0], "interactive card.html");
  const alias = path.join(shell.folders[0], "outside.html");
  const external = path.join(shell.temporary, "private fixture.html");
  const missing = path.join(shell.folders[0], "missing.html");
  await writeFile(
    file,
    '<h1>Invented visualization</h1><button id="update">Update tally</button><output id="tally">0</output><script>document.getElementById("update").onclick=()=>document.getElementById("tally").textContent="1"</script>',
  );
  await writeFile(external, "<h1>Outside the target workspace</h1>");
  await symlink(external, alias);
  const reference = (file: string, title?: string) =>
    `visualize${JSON.stringify({ path: file, title })}`;
  const marker = reference(file);
  await shell.send(
    chat.id,
    [
      "I prepared an interactive tally.",
      marker,
      "The tally opens in a tab.",
      reference(alias, "linked tally"),
      reference(missing, "missing tally"),
      "\\" + marker,
      "```text\n" + marker + "\n```",
      "`" + marker + "`",
      "> " + marker,
      marker.slice(0, -1),
      "[Documentation](https://example.invalid/guide)",
    ].join("\n\n"),
  );
  await expect.poll(() => status(chat.id)).toBe("ready");
  const assistantReply = () =>
    transcript(chat).locator(".chat-message.assistant");
  const reply = assistantReply();
  await expect(reply).toContainText("The tally opens in a tab.");
  await reply.screenshot({ path: info.outputPath("visualization-reply.png") });
  await shell.page.screenshot({
    path: info.outputPath("visualization-reply-window.png"),
  });
  const openVisualization = () =>
    assistantReply().getByRole("button", {
      name: "Open visualization",
      exact: true,
    });
  await expect(reply.getByRole("button")).toHaveText([
    "Open visualization",
    "Open linked tally",
    "Open missing tally",
  ]);
  await expect(reply.locator("pre")).toHaveText(marker);
  await expect(reply.locator("p > code")).toHaveText(marker);
  await expect(reply.locator("blockquote")).toHaveText(marker);
  await expect(
    reply.getByRole("link", { name: "Documentation" }),
  ).toHaveAttribute("href", "https://example.invalid/guide");
  expect((await shell.cli<AppState>("state")).browsers).toHaveLength(0);
  await openVisualization().focus();
  await expect(openVisualization()).toBeFocused();
  await shell.page.keyboard.press("Enter");
  const error = shell.pane(chat.paneId).getByRole("alert");
  await expect(error).toHaveText(
    "Visualization HTML was not found in this workspace.",
  );
  expect((await shell.cli<AppState>("state")).browsers).toHaveLength(0);

  const destination = await shell.create("Visualization destination");
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    destination,
    "--path",
    shell.folders[0],
  );
  await shell.cli(
    "conversation",
    "move",
    "--id",
    chat.id,
    "--workspace",
    destination,
    "--follow",
    "true",
  );
  for (const name of ["Open linked tally", "Open missing tally"]) {
    await reply.getByRole("button", { name, exact: true }).click();
    await expect(error).toHaveText(
      "Visualization HTML was not found in this workspace.",
    );
    expect((await shell.cli<AppState>("state")).browsers).toHaveLength(0);
  }
  await openVisualization().click();
  await expect(
    shell.page.getByRole("combobox", { name: "Address", exact: true }),
  ).toHaveValue(/interactive%20card\.html$/);
  const browserPage = () =>
    shell
      .app!.context()
      .pages()
      .find((page) => page.url().endsWith("/interactive%20card.html"));
  await expect.poll(() => !!browserPage()).toBe(true);
  const content = browserPage()!;
  await expect(
    content.getByRole("heading", { name: "Invented visualization" }),
  ).toBeVisible();
  await content.getByRole("button", { name: "Update tally" }).click();
  await expect(content.locator("#tally")).toHaveText("1");
  expect(
    await content.evaluate(() =>
      ["cod", "codPage", "require"].map(
        (name) => typeof Reflect.get(window, name),
      ),
    ),
  ).toEqual(["undefined", "undefined", "undefined"]);
  expect((await shell.cli<AppState>("state")).browsers[0].workspaceId).toBe(
    destination,
  );
  const browserPreferences = await shell.app!.evaluate(
    ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL() === url)! as unknown as {
        getLastWebPreferences(): Electron.WebPreferences;
      };
      const preferences = contents.getLastWebPreferences();
      return {
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        preload: preferences.preload ?? "",
      };
    },
    content.url(),
  );
  expect(browserPreferences).toEqual({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    preload: "",
  });
  await expect(reply).toBeVisible();
  await shell.page.screenshot({
    path: info.outputPath("visualization-browser-and-chat.png"),
  });

  await content.screenshot({
    path: info.outputPath("visualization-browser-content.png"),
  });

  await shell.stop();
  await shell.start();
  await expect(openVisualization()).toBeVisible();
  await expect(assistantReply()).toContainText("The tally opens in a tab.");
  await openVisualization().click();
  await expect(
    shell.page.getByRole("combobox", { name: "Address", exact: true }),
  ).toHaveValue(/interactive%20card\.html$/);
});

test("Collapsed tool history does not materialize output until expanded", async () => {
  await shell.configure({ codex: { reasoningOptions: true } });
  const workspace = await shell.create("Long tool history");
  const chat = await shell.newChat(workspace, "codex");
  await shell.stop();
  const saved = readWorkspaceState(shell.data);
  const importedId = "codex-fixture-large-import";
  saved.conversations.find((c) => c.id === chat.id)!.nativeId = importedId;
  writeWorkspaceState(shell.data, saved);
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

test("Detached local chat finishes while Cod is closed and restores the same native session", async ({}, info) => {
  const owner = new LocalProviderOwner(shell.data);
  try {
    await shell.app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(760, 560),
    );
    await shell.page.keyboard.press(`${modifier}+,`);
    const settings = shell.page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    const search = settings.getByRole("searchbox", {
      name: "Search settings",
      exact: true,
    });
    await search.fill("Chat font");
    await expect(
      settings.getByText(/Applies when a local agent controller starts/),
    ).toBeHidden();
    await search.fill("detached");
    const detached = settings.getByRole("switch", {
      name: "Chat Run new sessions detached",
      exact: true,
    });
    await expect(detached).not.toBeChecked();
    await expect(detached).toHaveAccessibleDescription(/controller starts/);
    await detached.check();
    await detached.focus();
    await shell.page.screenshot({
      path: info.outputPath("detached-chat-settings.png"),
    });
    await shell.page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (
            await shell.cli<{ values: Record<string, unknown> }>(
              "settings",
              "get",
            )
          ).values["chat.detachedSessions"],
      )
      .toBe(true);
    await shell.configure({
      codex: { latencyChunks: 4, pauseLatencyAfter: 1 },
    });
    const workspace = await shell.create("Detached run fixture");
    const chat = await shell.newChat(workspace, "codex");
    const prompt = "[latency-fixture] continue while Cod is closed";
    await shell.send(chat.id, prompt);
    await expect(transcript(chat)).toContainText(/inventedstream-1/);
    await expect(transcript(chat)).not.toContainText(/inventedstream-2/);
    await expect
      .poll(async () => {
        const saved = readWorkspaceState(shell.data);
        const pending = saved.conversations.find(
          (candidate) => candidate.id === chat.id,
        );
        return pending?.messages.some((message) =>
          message.text.includes("inventedstream-1"),
        );
      })
      .toBe(true);
    const prompts = await shell.prompts();
    await shell.quitWithChoice("Leave Running");

    await shell.configure({ codex: { latencyChunks: 4 } });
    const nativeHistory = path.join(
      shell.recording + ".sessions",
      chat.nativeId + ".json",
    );
    await expect
      .poll(async () =>
        (await readFile(nativeHistory, "utf8")).includes(
          '"status":"completed"',
        ),
      )
      .toBe(true);

    await shell.start();
    const restored = await shell.inspect(chat.id);
    expect(restored.nativeId).toBe(chat.nativeId);
    expect(restored.status).toBe("ready");
    expect(text(restored).match(/inventedstream-[1-4]-/g)).toHaveLength(4);
    expect(await shell.prompts()).toEqual(prompts);
    await expect(transcript(chat)).toContainText(/inventedstream-4/);
    await shell.send(chat.id, "continue after detached completion");
    await expect(transcript(chat)).toContainText(
      "DONE continue after detached completion",
    );
  } finally {
    await owner.stop();
  }
});

for (const recovery of ["reachable", "unverified"] as const) {
  test(`Detached chat keeps its native owner when the event connection drops (${recovery})`, async () => {
    const owner = new LocalProviderOwner(shell.data);
    const inspect = (id: string) =>
      shell.cli<ConversationState>("conversation", "inspect", "--id", id);
    try {
      const main = shell.app!;
      await main.evaluate(() => {
        const net = process.getBuiltinModule("node:net")!;
        const write = net.Socket.prototype.write;
        net.Socket.prototype.write = function (
          chunk: string,
          ...rest: unknown[]
        ) {
          const probe = globalThis as typeof globalThis & {
            codWatch?: { destroy(): void };
            rejectCodWatch?: boolean;
            codWatches?: number;
            codReleases?: number;
          };
          if (
            typeof chunk === "string" &&
            chunk.startsWith('{"op":"workspace.watch"')
          ) {
            probe.codWatch = this;
            probe.codWatches = (probe.codWatches ?? 0) + 1;
            if (probe.rejectCodWatch) {
              this.destroy();
              return false;
            }
          }
          if (
            typeof chunk === "string" &&
            chunk.startsWith('{"op":"owner.release"')
          )
            probe.codReleases = (probe.codReleases ?? 0) + 1;
          return Reflect.apply(write, this, [chunk, ...rest]);
        };
      });

      const workspace = await shell.create("Detached reconnect fixture");
      await shell.cli(
        "settings",
        "update",
        "--values",
        '{"chat.detachedSessions":true}',
      );
      await shell.configure({
        codex: { latencyChunks: 4, pauseLatencyAfter: 1 },
      });
      const chat = await shell.newChat(workspace, "codex");
      await shell.send(chat.id, "[latency-fixture] retained native turn");
      await expect(transcript(chat)).toContainText(/inventedstream-1/);
      const original = await inspect(chat.id);
      const localTurn = original.turns?.at(-1)?.id;
      expect(localTurn).toBeDefined();
      async function readNativeTurn(conversation: ConversationState) {
        const reader = await owner.reconnect(
          chat.id,
          "codex",
          chat.nativeId,
          conversation.detachedOwner!,
          () => {},
        );
        try {
          return reader.activeTurnIdentity();
        } finally {
          reader.detach();
        }
      }
      const originalNativeTurn = await readNativeTurn(original);
      expect(originalNativeTurn).toBeDefined();
      const starts = await shell.prompts();
      const draftText = "Invented draft across reconnect";
      const composer = shell.pane(chat.paneId).getByRole("textbox", {
        name: "Message",
        exact: true,
      });
      await composer.fill(draftText);
      await expect
        .poll(() =>
          readWorkspaceChatDraftBody(shell.data, workspace, chat.paneId),
        )
        .toContain(draftText);

      await main.evaluate((_electron, rejectCodWatch) => {
        const probe = globalThis as typeof globalThis & {
          codWatch?: { destroy(): void };
          rejectCodWatch?: boolean;
        };
        if (!probe.codWatch) throw new Error("Fixture watch did not connect");
        probe.rejectCodWatch = rejectCodWatch;
        probe.codWatch.destroy();
      }, recovery === "unverified");
      await expect
        .poll(() => main.evaluate(() => (globalThis as any).codWatches))
        .toBe(2);

      if (recovery === "unverified") {
        await expect.poll(() => status(chat.id)).toBe("failed");
        const attempt = await shell.raw(
          "conversation",
          "option",
          "--id",
          chat.id,
          "--option",
          "reasoning",
          "--value",
          "high",
        );
        expect(attempt.code).not.toBe(0);
        expect(attempt.stderr).toContain(
          "Could not reconnect to the detached chat owner",
        );
        expect(await readNativeTurn(original)).toBe(originalNativeTurn);
        await expect(composer).toHaveValue(draftText);
        expect(await shell.prompts()).toEqual(starts);
        expect(
          await main.evaluate(() => (globalThis as any).codReleases ?? 0),
        ).toBe(0);
        await shell.quitWithChoice("Stop");
        await expect.poll(() => localOwnerSockets(shell.data)).toEqual([]);
        return;
      }

      // Complete the first watch handshake before dropping the replacement.
      const inspectNativeStatus = () =>
        shell.cli(
          "conversation",
          "native-inspect",
          "--id",
          chat.id,
          "--section",
          "status",
        );
      await inspectNativeStatus();
      await main.evaluate(() => {
        const probe = globalThis as typeof globalThis & {
          codWatch?: { destroy(): void };
        };
        if (!probe.codWatch) throw new Error("Fixture watch did not reconnect");
        probe.codWatch.destroy();
      });
      await expect
        .poll(() => main.evaluate(() => (globalThis as any).codWatches))
        .toBe(3);
      await inspectNativeStatus();
      const restored = await inspect(chat.id);
      expect(restored.status).toBe("working");
      expect(restored.turns?.at(-1)?.id).toBe(localTurn);
      expect(await readNativeTurn(restored)).toBe(originalNativeTurn);
      expect(restored.detachedOwner?.generation).toBe(
        original.detachedOwner?.generation,
      );
      expect(await shell.prompts()).toEqual(starts);
      await shell.configure({ codex: { latencyChunks: 4 } });
      await expect(transcript(chat)).toContainText(/inventedstream-4/);
      await expect.poll(() => status(chat.id)).toBe("ready");
      expect((await inspect(chat.id)).turns?.at(-1)?.id).toBe(localTurn);
      await expect(composer).toHaveValue(draftText);
      await composer.press("Enter");
      await expect(transcript(chat)).toContainText(`DONE ${draftText}`);
      const finished = await inspect(chat.id);
      expect(finished.nativeId).toBe(original.nativeId);
      expect(finished.detachedOwner?.generation).toBe(
        original.detachedOwner?.generation,
      );
      expect(finished.turns?.at(-2)?.id).toBe(localTurn);
      const prompts = await shell.prompts();
      expect(prompts).toHaveLength(starts.length + 1);
      expect(prompts.every((record) => record.pid === starts[0].pid)).toBe(
        true,
      );
      expect(
        (await shell.records()).filter(
          (record) => record.message?.method === "thread/resume",
        ),
      ).toEqual([]);
      expect(
        await main.evaluate(() => (globalThis as any).codReleases ?? 0),
      ).toBe(0);
    } finally {
      await owner.stop();
    }
  });
}

test("Detached chat can explicitly resume after its owner stops in the same desktop", async () => {
  const workspace = await shell.create("Ended owner recovery fixture");
  await shell.cli(
    "settings",
    "update",
    "--values",
    '{"chat.detachedSessions":true}',
  );
  const chat = await shell.newChat(workspace, "codex");
  try {
    await shell.send(chat.id, "Invented turn before the owner stops");
    await expect.poll(() => status(chat.id)).toBe("ready");
    await expect(transcript(chat)).toContainText(
      "DONE Invented turn before the owner stops",
    );
    await new LocalProviderOwner(shell.data).stop();
    await expect.poll(() => localOwnerSockets(shell.data)).toEqual([]);
    await expect.poll(() => status(chat.id)).toBe("failed");
    const composer = shell.pane(chat.paneId).getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.fill("Invented retry after known owner stop");
    await composer.press("Enter");
    await expect(transcript(chat)).toContainText(
      "DONE Invented retry after known owner stop",
      { timeout: 8000 },
    );
    expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
    expect(await shell.prompts()).toHaveLength(2);
  } finally {
    await new LocalProviderOwner(shell.data).stop();
  }
});

for (const output of ["streaming", "quiet"] as const) {
  test(`Detached recovery keeps the live owner with a failed checkpoint and ${output} turn`, async () => {
    const owner = new LocalProviderOwner(shell.data);
    const inspect = (id: string) =>
      shell.cli<ConversationState>("conversation", "inspect", "--id", id);
    try {
      const workspace = await shell.create("Detached recovery fixture");
      await shell.cli(
        "settings",
        "update",
        "--values",
        '{"chat.detachedSessions":true}',
      );
      await shell.configure({
        codex: {
          latencyChunks: 4,
          pauseLatencyAfter: output === "quiet" ? 0 : 1,
        },
      });
      const chat = await shell.newChat(workspace, "codex");
      await shell.send(chat.id, "[latency-fixture] active across restart");
      if (output === "quiet") {
        await expect.poll(() => status(chat.id)).toBe("working");
        await expect.poll(async () => (await shell.prompts()).length).toBe(1);
      } else {
        await expect(transcript(chat)).toContainText(/inventedstream-1/);
      }
      const draft = () =>
        shell.pane(chat.paneId).getByRole("textbox", {
          name: "Message",
          exact: true,
        });
      await draft().fill("Invented retry draft");
      const original = await inspect(chat.id);
      const starts = await shell.prompts();
      await shell.quitWithChoice("Leave Running");

      const saved = readWorkspaceState(shell.data);
      const savedChat = saved.conversations.find(
        (item) => item.id === chat.id,
      )!;
      if (output === "quiet") {
        const cursor = savedChat.detachedOwner!;
        const probe = await owner.reconnect(
          chat.id,
          "codex",
          chat.nativeId,
          cursor,
          () => undefined,
        );
        const nativeTurn = probe.activeTurnIdentity();
        probe.detach();
        expect(nativeTurn).toBeDefined();
        // Replay the working event from before the provider acknowledged the turn.
        cursor.sequence--;
      }
      savedChat.status = "failed";
      savedChat.error = "Invented session already has an active writer";
      const interrupted = savedChat.turns!.at(-1)!;
      interrupted.outcome = "failed";
      interrupted.finishedAt = new Date().toISOString();
      writeWorkspaceState(shell.data, saved);

      await shell.start();
      const restored = await inspect(chat.id);
      expect(restored.status).toBe("working");
      expect(restored.error).toBeUndefined();
      expect(restored.turns?.at(-1)).toEqual(interrupted);
      expect(restored.nativeId).toBe(original.nativeId);
      expect(restored.detachedOwner?.generation).toBe(
        original.detachedOwner?.generation,
      );
      await expect(draft()).toHaveValue("Invented retry draft");
      const inspection = await shell.cli<{ nativeId: string }>(
        "conversation",
        "native-inspect",
        "--id",
        chat.id,
        "--section",
        "status",
      );
      expect(inspection.nativeId).toBe(original.nativeId);
      expect(await shell.prompts()).toEqual(starts);

      await shell.configure({ codex: { latencyChunks: 4 } });
      await expect(transcript(chat)).toContainText(/inventedstream-4/);
      await expect.poll(() => status(chat.id)).toBe("ready");
      expect(
        text(await shell.inspect(chat.id)).match(/inventedstream-[1-4]-/g),
      ).toHaveLength(4);
      await expect(draft()).toHaveValue("Invented retry draft");
      await draft().press("Enter");
      await expect(transcript(chat)).toContainText("DONE Invented retry draft");
      const records = await shell.records();
      expect(
        records.filter((record) => record.message?.method === "thread/resume"),
      ).toEqual([]);
      const prompts = await shell.prompts();
      expect(prompts).toHaveLength(starts.length + 1);
      expect(prompts.every((record) => record.pid === starts[0].pid)).toBe(
        true,
      );
      const finished = await inspect(chat.id);
      expect(finished.detachedOwner?.generation).toBe(
        original.detachedOwner?.generation,
      );
    } finally {
      await owner.stop();
    }
  });
}

test("Detached owner upgrade retains a running turn and opens saved chats on the current build", async () => {
  const owner = new LocalProviderOwner(shell.data);
  const currentRoot = shell.root;
  const earlierRoot = path.join(shell.temporary, "other-cod-build");
  const historyDirectory = shell.recording + ".sessions";
  const savedId = "codex-fixture-detached-upgrade";
  const earlierSourceHash = createHash("sha256")
    .update("invented earlier owner build")
    .digest("hex");
  try {
    await shell.stop();
    await mkdir(earlierRoot);
    await cp(path.join(currentRoot, "dist"), path.join(earlierRoot, "dist"), {
      recursive: true,
    });
    await symlink(
      path.join(currentRoot, "node_modules"),
      path.join(earlierRoot, "node_modules"),
      "dir",
    );
    const metadataPath = path.join(earlierRoot, "dist/build-info.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.build.sourceHash = earlierSourceHash;
    await writeFile(metadataPath, JSON.stringify(metadata));
    shell.root = earlierRoot;
    await shell.start();
    const workspace = await shell.create("Detached update fixture");
    await shell.cli(
      "settings",
      "update",
      "--values",
      '{"chat.detachedSessions":true}',
    );

    await expect(shell.newChat(workspace, "codex")).rejects.toThrow(
      "Reopen Cod to use the updated detached chat owner",
    );
    expect(await localOwnerSockets(shell.data)).toEqual([]);
    await build({
      entryPoints: [path.join(currentRoot, "src/provider-owner.ts")],
      bundle: true,
      target: "node20",
      platform: "node",
      format: "cjs",
      define: {
        __COD_OWNER_BUILD__: JSON.stringify(earlierSourceHash.slice(0, 24)),
      },
      outfile: path.join(earlierRoot, "dist/provider-owner.cjs"),
    });
    await shell.configure({
      codex: { latencyChunks: 4, pauseLatencyAfter: 1 },
    });
    const running = await shell.newChat(workspace, "codex");
    await shell.send(running.id, "[latency-fixture] work through update");
    await expect(transcript(running)).toContainText(/inventedstream-1/);
    const draft = () =>
      shell.pane(running.paneId).getByRole("textbox", {
        name: "Message",
        exact: true,
      });
    await draft().fill("Unsent text across builds");
    const original = await shell.cli<ConversationState>(
      "conversation",
      "inspect",
      "--id",
      running.id,
    );
    const originalOwner = await localOwnerSockets(shell.data);
    expect(originalOwner).toHaveLength(1);
    const originalCursor = original.detachedOwner!;
    expect(originalCursor.build).toBe(earlierSourceHash.slice(0, 24));
    await expect(
      owner.reconnect(
        running.id,
        "codex",
        running.nativeId,
        { ...originalCursor, generation: "expired-fixture-owner" },
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(LocalOwnerUnavailable);
    const starts = await shell.prompts();
    await shell.quitWithChoice("Leave Running");

    shell.root = currentRoot;
    await shell.start();
    expect(await status(running.id)).toBe("working");
    await expect(draft()).toHaveValue("Unsent text across builds");
    const resume = (nativeId: string) =>
      shell.cli<Chat>(
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
    expect((await resume(running.nativeId)).id).toBe(running.id);
    expect(await localOwnerSockets(shell.data)).toEqual(originalOwner);
    await mkdir(historyDirectory, { recursive: true });
    await writeFile(
      path.join(historyDirectory, savedId + ".json"),
      JSON.stringify([
        {
          id: "invented-saved-turn",
          status: "completed",
          items: [
            {
              id: "invented-saved-answer",
              type: "agentMessage",
              text: "Invented saved answer",
            },
          ],
        },
      ]),
    );
    const saved = await resume(savedId);
    expect(saved.nativeId).toBe(savedId);
    await expect(transcript(saved)).toContainText("Invented saved answer");
    expect(await localOwnerSockets(shell.data)).toHaveLength(2);
    expect(await status(running.id)).toBe("working");
    const restored = await shell.cli<ConversationState>(
      "conversation",
      "inspect",
      "--id",
      running.id,
    );
    expect(restored.detachedOwner?.generation).toBe(
      original.detachedOwner?.generation,
    );
    expect(restored.turns?.at(-1)?.id).toBe(original.turns?.at(-1)?.id);
    expect(await shell.prompts()).toEqual(starts);
    expect(
      (await shell.records())
        .filter((record) => record.message?.method === "thread/resume")
        .map((record) => record.message?.params?.threadId),
    ).toEqual([savedId]);

    await shell.configure({ codex: { latencyChunks: 4 } });
    await expect.poll(() => status(running.id)).toBe("ready");
    await shell.cli("conversation", "show", "--id", running.id);
    await expect(transcript(running)).toContainText(/inventedstream-4/);
    await expect(draft()).toHaveValue("Unsent text across builds");
    await shell.cli("conversation", "remove", "--id", running.id);
    await expect.poll(() => localOwnerSockets(shell.data)).toHaveLength(1);
    expect(await localOwnerSockets(shell.data)).not.toEqual(originalOwner);
    await shell.send(saved.id, "[hold] stop the current build");
    await expect(transcript(saved)).toContainText(
      "STREAM [hold] stop the current build",
    );
    await shell.quitWithChoice("Stop");
    await expect.poll(() => localOwnerSockets(shell.data)).toEqual([]);
  } finally {
    shell.root = currentRoot;
    await owner.stop();
  }
});

const nameQuitChat = (id: string, name: string) =>
  shell.cli("conversation", "rename", "--id", id, "--name", name);

async function captureAndCancelQuit(screenshot: string, closeWindow = false) {
  const app = shell.app!;
  const native = process.platform === "linux";
  await app.evaluate(
    ({ app, BrowserWindow }, { native, closeWindow }) => {
      (globalThis as any).quitDialog = undefined;
      (globalThis as any).quitChoice = "Cancel";
      (globalThis as any).showNativeQuit = native;
      if (closeWindow) BrowserWindow.getAllWindows()[0].close();
      else app.quit();
    },
    { native, closeWindow },
  );
  const quitDialog = () => app.evaluate(() => (globalThis as any).quitDialog);
  await expect.poll(quitDialog).toBeDefined();
  if (native) {
    const execute = promisify(execFile);
    let nativeWindow = "";
    try {
      await expect
        .poll(async () => {
          nativeWindow = (
            await execute("xdotool", [
              "search",
              "--onlyvisible",
              "--name",
              "Quit Cod",
            ]).catch(() => ({ stdout: "" }))
          ).stdout
            .trim()
            .split("\n")
            .at(-1)!;
          return nativeWindow;
        })
        .not.toBe("");
      const image = await app.evaluate(async ({ desktopCapturer }) => {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 1280, height: 1024 },
        });
        return sources[0]?.thumbnail.toPNG().toString("base64");
      });
      if (image) await writeFile(screenshot, Buffer.from(image, "base64"));
    } finally {
      await execute(
        "xdotool",
        nativeWindow
          ? ["key", "--window", nativeWindow, "Escape"]
          : ["key", "Escape"],
      ).catch(() => undefined);
      await app.evaluate(() => {
        (globalThis as any).showNativeQuit = false;
      });
    }
  }
  return quitDialog();
}

test("Quit dialog names active local chats across workspaces and bounds the list", async ({}, info) => {
  const research = await shell.create("Research");
  const operations = await shell.create("Operations");
  await shell.newChat(research, "codex");
  const chats: Array<{ id: string; nativeId: string }> = [];
  for (const index of [1, 2, 3, 4, 5, 6]) {
    const chat = await shell.newChat(
      index % 2 ? research : operations,
      "codex",
    );
    if (index === 1) await nameQuitChat(chat.id, "Draft\nsummary");
    if (index === 3)
      await nameQuitChat(chat.id, "Long session " + "x".repeat(60));
    await shell.send(chat.id, `[hold] Session ${index}`);
    chats.push(chat);
  }
  await expect
    .poll(() => Promise.all(chats.map((chat) => status(chat.id))))
    .toEqual(Array(6).fill("working"));

  expect(
    await captureAndCancelQuit(info.outputPath("local-chats-quit.png"), true),
  ).toEqual({
    buttons: ["Stop", "Cancel"],
    defaultButton: "Cancel",
    message: "6 local agents are active",
    detail: [
      "• Research — Draft summary",
      "• Operations — [hold] Session 2",
      "• Research — Long session " + "x".repeat(28) + "…",
      "• Operations — [hold] Session 4",
      "• Research — [hold] Session 5",
      "… and 1 more",
    ].join("\n"),
  });
  await expect
    .poll(() => Promise.all(chats.map((chat) => status(chat.id))))
    .toEqual(Array(6).fill("working"));
  await shell.quitWithChoice("Stop");
  await shell.start();
  for (const chat of chats) {
    const restored = await shell.inspect(chat.id);
    expect(restored.nativeId).toBe(chat.nativeId);
    expect(restored.status).toBe("failed");
  }
});

test("Detached local chat keeps an approval through restart, with Cancel and Stop at Quit", async ({}, info) => {
  const owner = new LocalProviderOwner(shell.data);
  try {
    const workspace = await shell.create("Detached approval fixture");
    await shell.cli(
      "settings",
      "update",
      "--values",
      '{"chat.detachedSessions":true}',
    );
    const chat = await shell.newChat(workspace, "codex");
    await shell.send(chat.id, "[approve] retained approval");
    await expect.poll(() => status(chat.id)).toBe("waiting");
    const original = (await shell.inspect(chat.id)).pendingPermissions[0];
    await nameQuitChat(chat.id, "Approve release draft");
    expect(
      await captureAndCancelQuit(info.outputPath("detached-chat-quit.png")),
    ).toEqual({
      buttons: ["Leave Running", "Stop", "Cancel"],
      defaultButton: "Cancel",
      message: "One local agent is active",
      detail: "• Detached approval fixture — Approve release draft",
    });
    await expect.poll(() => status(chat.id)).toBe("waiting");
    await shell.quitWithChoice("Leave Running");

    await shell.start();
    expect((await shell.inspect(chat.id)).pendingPermissions[0]).toEqual(
      original,
    );
    const allow = shell
      .pane(chat.paneId)
      .getByRole("button", { name: "Allow once", exact: true });
    await allow.click();
    await expect.poll(() => status(chat.id)).toBe("ready");
    await expect(transcript(chat)).toContainText(
      "ALLOWED [approve] retained approval",
    );
    await shell.send(chat.id, "[hold] stop detached work");
    await expect(transcript(chat)).toContainText(
      "STREAM [hold] stop detached work",
    );
    await shell.quitWithChoice("Stop");

    await shell.start();
    const stopped = await shell.inspect(chat.id);
    expect(stopped.nativeId).toBe(chat.nativeId);
    expect(stopped.status).toBe("failed");
    expect(text(stopped)).not.toContain("DONE [hold] stop detached work");
  } finally {
    await owner.stop();
  }
});

test("Detached local chat falls back to explicit native resume if its owner is gone", async () => {
  const owner = new LocalProviderOwner(shell.data);
  try {
    const workspace = await shell.create("Detached owner loss fixture");
    await shell.cli(
      "settings",
      "update",
      "--values",
      '{"chat.detachedSessions":true}',
    );
    const chat = await shell.newChat(workspace, "kimi");
    await shell.send(chat.id, "[hold] owner can be lost");
    await expect(transcript(chat)).toContainText(
      "STREAM [hold] owner can be lost",
    );
    const prompts = await shell.prompts();
    await shell.quitWithChoice("Leave Running");
    await owner.stop();

    await shell.start();
    const recovered = await shell.inspect(chat.id);
    expect(recovered.status).toBe("failed");
    expect(recovered.nativeId).toBe(chat.nativeId);
    expect(text(recovered)).toContain("Detached session owner stopped");
    expect(await shell.prompts()).toEqual(prompts);
    await shell.send(chat.id, "resume saved detached session");
    await expect(transcript(chat)).toContainText(
      "DONE resume saved detached session",
    );
    expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
  } finally {
    await owner.stop();
  }
});

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
  await shell.configure({ codex: { options: true } });
  await shell.stop();
  await shell.start();
  const workspace = (await shell.state()).activeWorkspaceId!;
  // Complete the trusted composer's own metadata read before measuring the
  // effects of the untrusted invocation.
  await expect(
    shell.page.getByRole("button", { name: "Model", exact: true }),
  ).toHaveText("Fixture model");
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
  await shell.configure({ codex: { pagedHistory: true, historyPageSize: 1 } });
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
      .getByRole("button", { name: "Earlier messages", exact: true }),
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
            aggregatedOutput: "Earlier output loaded on expansion",
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
  expect(
    (await shell.records()).filter(
      (record) => record.message?.method === "thread/items/read",
    ),
  ).toHaveLength(0);
  await expandActivity(pane);
  await pane.locator(".tool-activity > summary").click();
  await expect(pane.locator(".tool-activity pre")).toContainText(
    "Earlier output loaded on expansion",
  );
  const pages = (await shell.records()).filter(
    (record) => record.message?.method === "thread/items/list",
  );
  expect(
    pages.map((record) => [
      record.message?.params?.turnId,
      record.message?.params?.cursor,
    ]),
  ).toEqual([
    ["latest-turn", undefined],
    ["older-turn", undefined],
    ["older-turn", undefined],
    ["older-turn", "fixture-items-2"],
  ]);
});

async function pasteLargeFixtureImage(composer: Locator) {
  const bytes = await composer.evaluate(async (input) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 900;
    const context = canvas.getContext("2d")!;
    const pixels = context.createImageData(canvas.width, canvas.height);
    // Deterministic opaque noise is a valid PNG above the frame threshold.
    let seed = 42817;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels.data[i] = seed & 255;
      pixels.data[i + 1] = (seed >>> 8) & 255;
      pixels.data[i + 2] = (seed >>> 16) & 255;
      pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error("Could not encode fixture PNG"));
      });
    });
    const transfer = new DataTransfer();
    transfer.items.add(new File([png], "fixture.png", { type: png.type }));
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
      }),
    );
    return png.size;
  });
  expect(Math.ceil(bytes / 3) * 4).toBeGreaterThan(4 * 1024 * 1024);
}

for (const detached of [false, true]) {
  test(`Chat Codex large pasted images survive native echoes in ${detached ? "detached" : "direct"} chat`, async () => {
    await shell.configure({
      codex: {
        echoUserInput: true,
        steeringReply: true,
        finishSteeringReply: true,
      },
    });
    const owner = new LocalProviderOwner(shell.data);
    try {
      if (detached)
        await shell.cli(
          "settings",
          "update",
          "--values",
          '{"chat.detachedSessions":true}',
        );
      const workspace = await shell.create("Image notification fixture");
      const chat = await shell.newChat(workspace, "codex");
      const pane = shell.pane(chat.paneId);
      const composer = pane.getByRole("textbox", {
        name: "Message",
        exact: true,
      });
      const paste = async (prompt: string) => {
        await composer.fill(prompt);
        await pasteLargeFixtureImage(composer);
        await expect(pane.locator(".composer-images img")).toHaveCount(1);
        await composer.press(`${modifier}+Enter`);
        await expect(composer).toHaveValue("");
      };
      await paste("First image [hold]");
      await expect(transcript(chat)).toContainText("STREAM First image");
      await paste("Live image");
      await expect(transcript(chat)).toContainText(
        "Export verified. The file is ready.",
      );
      await expect.poll(() => status(chat.id)).toBe("ready");
      const saved = await inspectQueuedChat(chat.id);
      expect(saved.turns).toHaveLength(1);
      expect(
        saved.messages
          .filter((message) => message.role === "user")
          .map((message) => ({
            text: message.text,
            images: message.images?.length,
          })),
      ).toEqual([
        { text: "First image [hold][Image 1]", images: 1 },
        { text: "Live image[Image 1]", images: 1 },
      ]);
      expect(
        (await shell.records())
          .filter((record) =>
            ["turn/start", "turn/steer"].includes(record.message?.method ?? ""),
          )
          .map((record) => record.message?.method),
      ).toEqual(["turn/start", "turn/steer"]);
      if (detached) {
        await shell.send(chat.id, "[crash] in the same detached chat");
        await expect.poll(() => status(chat.id)).toBe("failed");
        await shell.send(chat.id, "Explicit recovery after failure");
        await expect(transcript(chat)).toContainText(
          "DONE Explicit recovery after failure",
        );
        await expect.poll(() => status(chat.id)).toBe("ready");
        expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
        const records = await shell.records();
        const resume = records.find(
          (record) => record.message?.method === "thread/resume",
        );
        expect(resume?.message?.params?.threadId).toBe(chat.nativeId);
        expect(resume?.pid).not.toBe(
          records.find((record) => record.message?.method === "turn/start")
            ?.pid,
        );
      }
    } finally {
      if (detached) await owner.stop();
    }
  });

  test(`Chat Codex restores a failed image turn and sends the saved draft after restart in ${detached ? "detached" : "direct"} chat`, async () => {
    await shell.configure({
      codex: { echoUserInput: true, pagedHistory: true },
    });
    const owner = new LocalProviderOwner(shell.data);
    try {
      if (detached)
        await shell.cli(
          "settings",
          "update",
          "--values",
          '{"chat.detachedSessions":true}',
        );
      const workspace = await shell.create("Image history recovery fixture");
      const chat = await shell.newChat(workspace, "codex");
      const composer = () =>
        shell.pane(chat.paneId).getByRole("textbox", {
          name: "Message",
          exact: true,
        });
      const nativeFile = path.join(
        shell.recording + ".sessions",
        chat.nativeId + ".json",
      );

      await shell.send(chat.id, "Earlier fixture turn");
      await expect.poll(() => status(chat.id)).toBe("ready");

      const draftImages = () =>
        shell.pane(chat.paneId).locator(".composer-images img");
      await composer().fill("[crash] Saved image prompt");
      await pasteLargeFixtureImage(composer());
      await expect(draftImages()).toHaveCount(1);
      await pasteLargeFixtureImage(composer());
      await expect(draftImages()).toHaveCount(2);
      await composer().press(`${modifier}+Enter`);
      await expect.poll(() => status(chat.id)).toBe("failed");
      const stored = JSON.parse(await readFile(nativeFile, "utf8"));
      expect(stored).toHaveLength(2);
      expect(stored[1].items).toHaveLength(1);
      expect(
        stored[1].items[0].content.filter(
          (part: { type: string }) => part.type === "image",
        ),
      ).toHaveLength(2);
      expect(JSON.stringify(stored).length).toBeGreaterThan(8 * 1024 * 1024);

      await composer().fill("Saved retry draft");
      await pasteLargeFixtureImage(composer());
      await expect(composer()).toHaveValue("Saved retry draft[Image 1]");
      await expect(draftImages()).toHaveCount(1);
      await shell.stop();
      if (detached) await owner.stop();
      await shell.start();
      await expect(composer()).toHaveValue("Saved retry draft[Image 1]");
      await expect(
        shell.pane(chat.paneId).locator(".composer-images img"),
      ).toHaveCount(1);
      expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
      expect(await shell.prompts()).toHaveLength(2);

      await composer().press(`${modifier}+Enter`);
      await expect(transcript(chat)).toContainText("DONE Saved retry draft");
      await expect(composer()).toHaveValue("");
      await expect.poll(() => status(chat.id)).toBe("ready");
      const resumed = await inspectQueuedChat(chat.id);
      expect(resumed.nativeId).toBe(chat.nativeId);
      expect(
        resumed.messages
          .filter((message) => message.role === "user")
          .map(({ text, images }) => ({ text, images: images?.length })),
      ).toEqual([
        { text: "Earlier fixture turn", images: undefined },
        { text: "[crash] Saved image prompt[Image 1][Image 2]", images: 2 },
        { text: "Saved retry draft[Image 1]", images: 1 },
      ]);
      expect(await shell.prompts()).toHaveLength(3);
    } finally {
      if (detached) await owner.stop();
    }
  });

  test(`Chat Codex oversized native history opens in ${detached ? "detached" : "direct"} chat after writer release`, async () => {
    const owner = new LocalProviderOwner(shell.data);
    try {
      if (detached)
        await shell.cli(
          "settings",
          "update",
          "--values",
          '{"chat.detachedSessions":true}',
        );
      const workspace = await shell.create("Native history fixture");
      const nativeId = "codex-fixture-oversized-history";
      const nativeHistory = shell.recording + ".sessions";
      await mkdir(nativeHistory, { recursive: true });
      await writeFile(
        path.join(nativeHistory, nativeId + ".json"),
        JSON.stringify(
          Array.from({ length: 9 }, (_, index) => ({
            id: `turn-${index}`,
            status: "completed",
            items: [
              {
                id: `prompt-${index}`,
                type: "userMessage",
                content: [
                  { type: "text", text: `Invented saved prompt ${index}` },
                ],
              },
              {
                id: `tool-${index}`,
                type: "commandExecution",
                status: "completed",
                command: "invented command",
                aggregatedOutput: "x".repeat(750_000),
              },
              {
                id: `answer-${index}`,
                type: "agentMessage",
                text: `Invented saved answer ${index}`,
              },
            ],
          })),
        ),
      );
      const resume = () =>
        shell.cli<Chat>(
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
      await shell.configure({ codex: { heldNativeId: nativeId } });
      await expect(resume()).rejects.toThrow("active writer");
      expect((await shell.cli<AppState>("state")).conversations).toHaveLength(
        0,
      );
      await shell.configure({ codex: {} });
      const chat = await resume();
      expect(chat.nativeId).toBe(nativeId);
      await expect(transcript(chat)).toContainText("Invented saved answer 8");
      await expect(transcript(chat)).not.toContainText(
        "Invented saved prompt 0",
      );
      const earlier = transcript(chat).getByRole("button", {
        name: "Earlier messages",
        exact: true,
      });
      await earlier.click();
      await expect(transcript(chat)).toContainText("Invented saved prompt 3");
      const loaded = await shell.inspect(chat.id);
      expect(
        loaded.messages
          .filter((message) => message.role === "user")
          .map((message) => message.text),
      ).toEqual(
        [3, 4, 5, 6, 7, 8].map((index) => `Invented saved prompt ${index}`),
      );
      expect(await shell.prompts()).toEqual([]);
      expect(
        (await shell.records())
          .filter((record) => record.message?.method === "thread/resume")
          .every((record) => record.message?.params?.excludeTurns === true),
      ).toBe(true);
      expect(
        (await shell.records())
          .filter((record) => record.message?.method === "thread/turns/list")
          .map((record) => record.message?.params?.limit),
      ).toEqual([6, 3, 6, 3]);
      await shell.stop();
      await shell.start();
      await expect(transcript(chat)).toContainText("Invented saved answer 8");
      expect((await shell.inspect(chat.id)).nativeId).toBe(nativeId);
      expect(await shell.prompts()).toEqual([]);
    } finally {
      if (detached) await owner.stop();
    }
  });
}

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
        const body = readWorkspaceChatDraftBody(
          shell.data,
          workspace,
          chat.paneId,
        );
        return body && JSON.parse(body).text;
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

test("Composer options align in a draft and an existing chat at both interface sizes", async ({}, info) => {
  const longModel = "Fixture model with a deliberately long readable name";
  await shell.configure({
    codex: {
      options: true,
      reasoningOptions: true,
      configuredDraftModel: "fixture-model",
      configuredDraftReasoning: "medium",
      modelDisplayName: longModel,
    },
  });
  const workspace = await shell.create("Composer control geometry");
  await shell.command("New chat");
  const draft = shell.pane((await shell.workspace(workspace)).activePaneId);
  const check = async (pane: Locator, phase: string) => {
    const model = pane.getByRole("button", { name: "Model", exact: true });
    const effort = pane.getByRole("button", {
      name: "Reasoning effort",
      exact: true,
    });
    await expect(model).toHaveText(longModel);
    await expect(effort).toHaveText("Medium");
    for (const [fontSize, width, height] of [
      [14, 1280, 800],
      [13, 1280, 800],
      [13, 760, 680],
    ]) {
      await shell.cli(
        "settings",
        "update",
        "--values",
        JSON.stringify({ "ui.fontSize": fontSize }),
      );
      await shell.app!.evaluate(
        ({ BrowserWindow }, [width, height]) =>
          BrowserWindow.getAllWindows()[0].setContentSize(width, height),
        [width, height],
      );
      await expect
        .poll(() => shell.page.evaluate(() => innerWidth))
        .toBe(width);
      if (width === 760) {
        await shell.cli("group", "toggle-split", "--workspace", workspace);
        await expect
          .poll(
            async () => (await pane.locator(".composer").boundingBox())!.width,
          )
          .toBeLessThan(380);
      }
      await expect(pane.locator(".composer-actions")).toHaveCSS(
        "font-size",
        `${fontSize - 2}px`,
      );
      const geometry = (button: Locator) =>
        button.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const caption = element.querySelector("span")!;
          const text = document.createRange();
          text.selectNodeContents(caption);
          const chevron = element.querySelector("svg")!.getBoundingClientRect();
          return {
            y: rect.y,
            height: rect.height,
            textTop: text.getBoundingClientRect().top,
            chevronTop: chevron.top,
            chevronBottom: chevron.bottom,
            buttonRight: rect.right,
            captionRight: caption.getBoundingClientRect().right,
            captionWidth: caption.clientWidth,
            textWidth: caption.scrollWidth,
          };
        });
      const [a, b] = await Promise.all([geometry(model), geometry(effort)]);
      await shell.page.screenshot({
        path: info.outputPath(`composer-${phase}-${fontSize}-${width}.png`),
      });
      expect(a.y).toBeCloseTo(b.y);
      expect(a.height).toBeCloseTo(b.height);
      expect(a.textTop).toBeCloseTo(b.textTop);
      expect(a.chevronTop).toBeCloseTo(b.chevronTop);
      expect(a.chevronBottom).toBeCloseTo(b.chevronBottom);
      expect(a.captionRight).toBeLessThan(a.buttonRight);
      expect(b.captionRight).toBeLessThan(b.buttonRight);
      expect(b.captionWidth).toBeGreaterThanOrEqual(b.textWidth);
      const composer = (await pane.locator(".composer").boundingBox())!;
      expect(b.buttonRight).toBeLessThanOrEqual(composer.x + composer.width);
    }
    await model.press("Enter");
    const menu = shell.page.getByRole("dialog", {
      name: "Actions",
      exact: true,
    });
    await expect(menu).toBeVisible();
    await shell.page.keyboard.press("Escape");
    await expect(model).toBeFocused();
    await expect(menu).toHaveCount(0);
    await shell.cli("group", "toggle-split", "--workspace", workspace);
  };
  const input = draft.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("An invented draft with a retained selection");
  await input.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(3, 9),
  );
  await check(draft, "draft");
  await expect(input).toHaveValue(
    "An invented draft with a retained selection",
  );
  expect(
    await input.evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([3, 9]);
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "An invented message for the composer");
  await expect.poll(() => status(chat.id)).toBe("ready");
  await expect(transcript(chat)).toContainText(
    "An invented message for the composer",
  );
  await check(shell.pane(chat.paneId), "chat");
});

test("Active composer aligns choice labels, glyphs and adjacent controls", async ({}, info) => {
  const codex = {
    options: true,
    multipleModels: true,
    reasoningOptions: true,
    modelDisplayName: "GPT-6.2-Sol",
  };
  await shell.configure({ codex: { ...codex, backgroundActivity: true } });
  await shell.cli("settings", "update", "--values", '{"ui.fontSize":13}');
  const workspace = await shell.create("Composer alignment fixture");
  const chat = await shell.newChat(workspace, "codex");
  const pane = shell.pane(chat.paneId);
  const row = pane.locator(".composer-actions");
  const model = row.getByRole("button", { name: "Model", exact: true });
  const effort = row.getByRole("button", {
    name: "Reasoning effort",
    exact: true,
  });
  const agents = row.getByRole("button", {
    name: "Agents, 1 running",
    exact: true,
  });
  const shells = row.getByRole("button", {
    name: "Shells, 1 running",
    exact: true,
  });
  const stop = row.getByRole("button", { name: "Stop", exact: true });
  await expect(model).toHaveText("GPT-6.2-Sol");
  await expect(effort).toHaveText("Medium");
  await shell.send(chat.id, "Start one invented background agent");
  await expect.poll(() => status(chat.id)).toBe("ready");
  await expect(agents).toBeVisible();
  await expect(shells).toBeVisible();
  await backgroundFixture(chat, "composer-shell-finished", [
    {
      method: "item/completed",
      params: {
        threadId: "invented-child",
        turnId: "child-turn",
        item: {
          type: "commandExecution",
          id: "invented-shell",
          status: "completed",
          exitCode: 0,
        },
      },
    },
  ]);
  await expect(shells).toHaveCount(0);

  await shell.configure({ codex });
  await shell.send(chat.id, "Show active controls [hold]");
  await expect(stop).toBeVisible();
  await expect(agents).toHaveText("1 agent");
  await expect(model).toBeDisabled();
  await expect(effort).toBeDisabled();
  await expect(row).toHaveCSS("font-size", "11px");
  await shell.page.screenshot({
    path: info.outputPath("active-composer-full.png"),
  });
  await row.screenshot({
    path: info.outputPath("active-composer-toolbar.png"),
  });
  const measured = await row.evaluate((toolbar) => {
    const canvas = document.createElement("canvas");
    const metrics = canvas.getContext("2d")!;
    const top = toolbar.getBoundingClientRect().top;
    const baseline = (text: Element) => {
      const font = getComputedStyle(text);
      metrics.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
      const range = document.createRange();
      range.selectNode(text.firstChild!);
      return (
        range.getBoundingClientRect().top -
        top +
        metrics.measureText(text.textContent ?? "").fontBoundingBoxAscent
      );
    };
    const paintedCenter = (shape: SVGGraphicsElement) => {
      const box = shape.getBBox();
      return (
        new DOMPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        ).matrixTransform(shape.getScreenCTM()!).y - top
      );
    };
    const label = (selector: string) => toolbar.querySelector(selector)!;
    const glyph = (selector: string) =>
      paintedCenter(toolbar.querySelector<SVGGraphicsElement>(selector)!);
    return {
      baselines: {
        provider: baseline(label(":scope > span:first-child")),
        model: baseline(label(".composer-choice-model .ui-button-label")),
        effort: baseline(label(".composer-choice-reasoning .ui-button-label")),
        agents: baseline(label('[data-focus-key="background:agent"]')),
      },
      centers: {
        model: glyph(".composer-choice-model svg > path"),
        effort: glyph(".composer-choice-reasoning svg > path"),
        stop: glyph('button[aria-label="Stop"] svg > rect'),
      },
      cssPixels: window.devicePixelRatio,
    };
  });
  await writeFile(
    info.outputPath("active-composer-geometry.json"),
    JSON.stringify(measured, null, 2),
  );
  const spread = (measure: Record<string, number>) => {
    const values = Object.values(measure);
    return Math.max(...values) - Math.min(...values);
  };

  await stop.focus();
  await stop.press("Enter");
  await expect.poll(() => status(chat.id)).toBe("ready");
  for (const [trigger, name] of [
    [model, "model"],
    [effort, "effort"],
  ] as const) {
    await trigger.focus();
    await trigger.press("Enter");
    const menu = shell.page.getByRole("dialog", { name: "Actions" });
    await expect(menu).toBeVisible();
    await shell.page.screenshot({
      path: info.outputPath(`composer-${name}-menu.png`),
    });
    await shell.page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
  expect(spread(measured.baselines)).toBeLessThanOrEqual(0.5);
  expect(spread(measured.centers)).toBeLessThanOrEqual(0.5);
});

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
  await shell.cli("settings", "update", "--values", '{"ui.fontSize":13}');
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
  await expect(shells).toHaveCount(0);
  await expect(shellList).toHaveCount(0);
  await expect(agentList).toBeVisible();
  await expect(input).toBeFocused();

  const secondCommandId = "second-shell";
  await backgroundFixture(chat, "second-shell-started", [
    {
      method: "item/started",
      params: {
        threadId: child,
        turnId: "child-turn",
        item: {
          type: "commandExecution",
          id: secondCommandId,
          command: "echo additional checks",
          status: "inProgress",
        },
      },
    },
  ]);
  await expect(shells).toHaveText("1 shell");
  await expect(shells).toHaveAttribute("aria-expanded", "false");
  await expect(agentList).toBeVisible();
  await shells.click();
  await expect(shellList.getByRole("listitem")).toHaveCount(2);
  await expect(shellList.getByRole("listitem").first()).toContainText(
    "echo additional checks",
  );
  await expect(
    shellList.getByText("Invented checked output", { exact: true }),
  ).toHaveCount(1);
  await shellList.focus();
  await expect(shellList).toBeFocused();
  await backgroundFixture(chat, "second-shell-done", [
    {
      ...commandDone,
      params: {
        ...commandDone.params,
        item: { ...commandDone.params.item, id: secondCommandId },
      },
    },
  ]);
  await expect(shells).toHaveCount(0);
  await expect(shellList).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Keep this unrelated draft");
  await shell.page.setViewportSize({ width: 390, height: 650 });
  await shell.page.screenshot({
    path: test.info().outputPath("background-no-live-shell-narrow.png"),
  });
  await shell.page.setViewportSize({ width: 1280, height: 800 });
  await agents.click();
  await agentList.focus();

  await backgroundFixture(chat, "child-done", [
    childResult,
    childDone,
    childDone,
  ]);
  await expect(agents).toHaveCount(0);
  await expect(shells).toHaveCount(0);
  await expect(agentList).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Keep this unrelated draft");

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
  expect(state.backgroundActivities).toHaveLength(3);
  expect(state.backgroundActivities).toContainEqual(
    expect.objectContaining({
      kind: "agent",
      state: "completed",
      result: "Invented child result",
    }),
  );
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
  await shell.cli("settings", "update", "--values", '{"ui.fontSize":13}');
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
  const effortCaption = effort.locator(".ui-button-label");
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

test("Codex restores and reactivates only confirmed running children", async ({}, info) => {
  const child = "invented-reviewer";
  const staleChild = "invented-stale-child";
  const foreignChild = "unrelated-helper";
  const row = (id: string, type: string, foreign = false) => ({
    id,
    foreign,
    agentNickname: id,
    status: { type },
  });
  await shell.configure({
    codex: {
      childThreads: [row(child, "idle"), row(foreignChild, "active", true)],
    },
  });
  const workspace = await shell.create("Reused checks");
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "Invented parent work");
  await expect.poll(() => status(chat.id)).toBe("ready");
  const pane = shell.pane(chat.paneId);
  const agents = pane.locator('[data-focus-key="background:agent"]');
  const list = pane.getByRole("list", { name: "Background agents" });
  const input = pane.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Keep this invented draft");
  const change = (threadId: string, type: string) => ({
    method: "thread/status/changed",
    params: { threadId, status: { type } },
  });
  const activity = (id: string, kind: string, agentThreadId = child) => ({
    method: "item/completed",
    params: {
      threadId: chat.nativeId,
      turnId: "parent-turn",
      item: { type: "subAgentActivity", id, kind, agentThreadId },
    },
  });
  const wait = {
    method: "item/completed",
    params: {
      threadId: chat.nativeId,
      turnId: "parent-turn",
      item: {
        type: "collabAgentToolCall",
        id: "invented-wait",
        tool: "wait",
        status: "completed",
        senderThreadId: chat.nativeId,
        receiverThreadIds: [],
        agentsStates: {},
      },
    },
  };
  const scopedRequests = async () =>
    (await shell.records()).filter(
      ({ message }) => message?.method === "thread/list",
    );
  const inspector = () =>
    shell.cli(
      "conversation",
      "native-inspect",
      "--id",
      chat.id,
      "--section",
      "agents",
    );
  const publish = async (id: string, events: unknown[]) => {
    await backgroundFixture(chat, id, events);
    await expect
      .poll(async () =>
        (await shell.records()).some(
          (event) =>
            event.event === "background-fixture-delivered" &&
            (event as { id?: string }).id === id,
        ),
      )
      .toBe(true);
  };

  await publish("queued-only", [
    activity("queue-review", "interacted"),
    change(foreignChild, "active"),
    wait,
  ]);
  await expect.poll(async () => (await scopedRequests()).length).toBe(1);
  expect((await scopedRequests())[0].message?.params).toMatchObject({
    parentThreadId: chat.nativeId,
    includedThreadIds: [child],
    limit: 1,
  });
  expect(await inspector()).toMatchObject({
    entries: [{ id: child, detail: `idle - ${child}` }],
  });
  await expect(agents).toHaveCount(0);

  await publish("first-running-turn", [change(child, "active")]);
  await expect(agents).toHaveAccessibleName("Agents, 1 running");
  await expect(input).toBeFocused();
  await agents.click();
  await expect(list).toContainText(child);
  await list.focus();
  await publish("first-idle", [change(child, "idle")]);
  await expect(agents).toHaveCount(0);
  await expect(list).toHaveCount(0);
  await expect(input).toBeFocused();

  await publish("second-running-turn", [
    // Global status may arrive before the parent interaction is rendered.
    change(child, "active"),
    activity("followup-review", "interacted"),
    activity("late-prior-completion", "completed"),
    change(foreignChild, "active"),
    wait,
  ]);
  await expect(agents).toHaveText("1 agent");
  await expect(input).toHaveValue("Keep this invented draft");
  expect(await scopedRequests()).toHaveLength(2);
  await agents.click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await shell.page.screenshot({
    path: info.outputPath("reactivated-child.png"),
  });
  await publish("second-idle", [change(child, "idle")]);
  await expect(agents).toHaveCount(0);

  await shell.stop();
  await shell.configure({
    codex: {
      childThreads: [
        row(child, "active"),
        row(staleChild, "active"),
        row(foreignChild, "active", true),
      ],
      childChangesBeforeList: [{ threadId: staleChild, status: "idle" }],
    },
  });
  await shell.start();
  await shell.cli("conversation", "show", "--id", chat.id);
  const reopenedAgents = shell
    .pane(chat.paneId)
    .locator('[data-focus-key="background:agent"]');
  await expect(reopenedAgents).toHaveText("1 agent");
  const scope = (await scopedRequests()).at(-1)?.message?.params;
  expect(scope).toMatchObject({ parentThreadId: chat.nativeId });
  expect(scope).not.toHaveProperty("sourceKinds");
  expect(scope).not.toHaveProperty("includedThreadIds");
  expect((await inspectQueuedChat(chat.id)).backgroundActivities).toEqual([
    expect.objectContaining({ id: child, kind: "agent", state: "running" }),
  ]);
  await publish("resumed-controller-unloads-child", [
    change(child, "notLoaded"),
  ]);
  await expect(reopenedAgents).toHaveCount(0);
  expect((await inspectQueuedChat(chat.id)).backgroundActivities).toEqual([
    expect.objectContaining({ id: child, state: "unknown" }),
  ]);
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
    shell.pane(chat.paneId).locator('[data-focus-key="background:agent"]'),
  ).toHaveCount(0);
  await expect(
    shell.pane(chat.paneId).getByRole("button", { name: "Shells, 2 running" }),
  ).toHaveText("2 shells");
  await shell.stop();
  await shell.start();
  await shell.cli("conversation", "show", "--id", chat.id);
  const pane = shell.pane(chat.paneId);
  await expect(
    pane.locator('[data-focus-key="background:command"]'),
  ).toHaveCount(0);
  await expect(
    pane.getByRole("list", { name: "Background shells" }),
  ).toHaveCount(0);
  await expect(pane.locator('[data-focus-key="background:agent"]')).toHaveCount(
    0,
  );
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
  await pasteLargeFixtureImage(composer());
  await expect(pane().locator(".composer-images img")).toHaveCount(1);
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
      (item) =>
        item.role === "user" &&
        item.text === "Recoverable follow-up[Image 1]" &&
        item.images?.length === 1,
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
  const background = await shell.create("Retained history");
  const retained = await shell.newChat(background, "codex");
  const workspace = await shell.create("Input responsiveness");
  const chat = await shell.newChat(workspace, "codex");
  await shell.stop();
  const saved = readWorkspaceState(shell.data);
  // A retained conversation is persisted but must not be serialized by typing.
  const history = saved.conversations.find((item) => item.id === retained.id)!;
  history.messages = Array.from({ length: 125 }, (_, index) => ({
    id: `invented-retained-message-${index}`,
    role: "assistant",
    origin: "application",
    order: index,
    text: "invented history ".repeat(12_500),
  }));
  writeWorkspaceState(shell.data, saved);
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
        const body = readWorkspaceChatDraftBody(
          shell.data,
          workspace,
          chat.paneId,
        );
        return (
          !!body && JSON.parse(body).text === expected && body.length < 2048
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
  {
    using db = openWorkspaceState(shell.data, true);
    const layout = db
      .prepare("SELECT body FROM records WHERE kind = 'workspace' AND id = ?")
      .get(workspace);
    expect(JSON.parse(String(layout?.body))).not.toHaveProperty("chatDrafts");
  }
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
    const cancelOrigin = queue.getByRole("button", {
      name: provider === "codex" ? "Save" : "Cancel",
      exact: true,
    });
    await shell.app!.evaluate(({ ipcMain }, id) => {
      const handler = (ipcMain as any)._invokeHandlers.get("cod:invoke");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      ipcMain.removeHandler("cod:invoke");
      ipcMain.handle("cod:invoke", async (event, request) => {
        if (request.op === "conversation.queue-edit" && request.id === id) {
          (globalThis as any).queueCancelHeld = true;
          await gate;
        }
        return handler(event, request);
      });
      (globalThis as any).releaseQueueCancel = () => {
        ipcMain.removeHandler("cod:invoke");
        ipcMain.handle("cod:invoke", handler);
        release();
      };
    }, chat.id);
    await cancelOrigin.press("Escape");
    await expect
      .poll(() =>
        shell.app!.evaluate(() => (globalThis as any).queueCancelHeld),
      )
      .toBe(true);
    expect(
      await cancelOrigin.evaluate((button) => {
        // A redraw can restore focus to a replacement control while IPC is pending.
        const replacement = button.cloneNode(true) as HTMLButtonElement;
        replacement.disabled = false;
        button.replaceWith(replacement);
        replacement.focus();
        return replacement === document.activeElement;
      }),
    ).toBe(true);
    await shell.app!.evaluate(() => (globalThis as any).releaseQueueCancel());
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
      items.filter((record) =>
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

test("Codex async questions retain structured replies and composer draft across active and reopened chats", async ({}, info) => {
  await shell.configure({ codex: { asyncQuestionHold: true } });
  const workspace = await shell.create(
    "Invented asynchronous question workspace",
  );
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "[async-question] Prepare invented checks");
  const first = () =>
    transcript(chat).getByRole("form", { name: "Which test environment?" });
  const second = () =>
    transcript(chat).getByRole("form", {
      name: "Where should the test report go?",
    });
  const draft = () =>
    shell
      .pane(chat.paneId)
      .getByRole("textbox", { name: "Message", exact: true });
  await expect(first()).toBeVisible();
  await draft().fill("Keep this draft intact");
  const staging = first().getByRole("radio", { name: "Staging" });
  for (let i = 0; i < 4; i++) await shell.page.keyboard.press("Shift+Tab");
  await expect(staging).toBeFocused();
  await shell.page.keyboard.press("ArrowDown");
  await expect(first().getByRole("radio", { name: "Preview" })).toBeChecked();
  await expect(
    first().getByRole("radio", { name: "Preview" }).locator(".."),
  ).toHaveCSS("outline-style", "solid");
  await shell.page.screenshot({
    path: info.outputPath("async-question-active.png"),
  });
  await shell.page.keyboard.press("Enter");
  await expect(first().getByRole("status")).toHaveText("Answered");
  await expect(second().getByRole("radio", { name: "Project" })).toBeFocused();
  await expect(draft()).toHaveValue("Keep this draft intact");
  const asked = (
    await shell.cli<ConversationState>(
      "conversation",
      "inspect",
      "--id",
      chat.id,
    )
  ).messages.find((message) => message.questions?.length);
  expect(asked?.questions?.map(({ id }) => JSON.parse(id))).toEqual([
    ["request_user_input_async", asked?.id.split("/").at(-1), 0],
    ["request_user_input_async", asked?.id.split("/").at(-1), 1],
  ]);
  const initialReply = (
    await shell.cli<ConversationState>(
      "conversation",
      "inspect",
      "--id",
      chat.id,
    )
  ).messages.flatMap(({ text }) => questionAnswers(text));
  expect(initialReply).toEqual([
    {
      questionItemId: asked?.questions?.[0]?.id,
      question: "Which test environment?",
      answer: "Preview",
    },
  ]);
  const duplicate = await shell.raw(
    "conversation",
    "answer-question",
    "--id",
    chat.id,
    "--question-id",
    initialReply[0]!.questionItemId,
    "--answer",
    "Send again",
  );
  expect(duplicate.code).not.toBe(0);
  expect(duplicate.stdout + duplicate.stderr).toContain(
    "An answer was already submitted",
  );

  await shell.configure({ codex: {} });
  await expect.poll(() => status(chat.id)).toBe("ready");
  await shell.stop();
  await shell.start();
  await shell.cli("conversation", "show", "--id", chat.id);
  await expect(first().getByRole("status")).toHaveText("Answered");
  await expect(first().getByRole("radio")).toHaveCount(0);
  await expect(draft()).toHaveValue("Keep this draft intact");
  await second().getByRole("radio", { name: "Other" }).check();
  await second().getByRole("radio", { name: "Other" }).press("Enter");
  const reply = second().getByRole("textbox", { name: "Your answer" });
  await expect(reply).toBeFocused();
  await reply.fill("Keep it in the release notes.");
  await shell.page.setViewportSize({ width: 640, height: 800 });
  await shell.page.screenshot({
    path: info.outputPath("async-question-other-narrow.png"),
  });
  await reply.press("Enter");
  await expect(second().getByRole("status")).toHaveText("Answered");
  await expect(draft()).toBeFocused();
  await expect(transcript(chat)).toContainText("Keep it in the release notes.");
  await expect(transcript(chat)).not.toContainText(
    "send_user_message_question_reply",
  );
  await expect(draft()).toHaveValue("Keep this draft intact");
  const finalReply = (
    await shell.cli<ConversationState>(
      "conversation",
      "inspect",
      "--id",
      chat.id,
    )
  ).messages.flatMap(({ text }) => questionAnswers(text));
  expect(
    finalReply.map(({ questionItemId, answer }) => ({
      questionItemId,
      answer,
    })),
  ).toEqual([
    { questionItemId: asked?.questions?.[0]?.id, answer: "Preview" },
    {
      questionItemId: asked?.questions?.[1]?.id,
      answer: "Keep it in the release notes.",
    },
  ]);
});

test("Codex async question does not queue a reply to a turn that rejects steering", async () => {
  await shell.configure({
    codex: { asyncQuestionHold: true, steering: "unsupported" },
  });
  const workspace = await shell.create("Invented unsupported answer workspace");
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "[async-question] Prepare invented checks");
  const first = transcript(chat).getByRole("form", {
    name: "Which test environment?",
  });
  await first.getByRole("button", { name: "Send answer" }).click();
  await expect(first.getByRole("alert")).toContainText("Wait for the active");
  const after = await shell.cli<ConversationState>(
    "conversation",
    "inspect",
    "--id",
    chat.id,
  );
  expect(after.queuedMessages ?? []).toHaveLength(0);
  expect(
    after.messages.flatMap(({ text }) => questionAnswers(text)),
  ).toHaveLength(0);
  await expect(
    first.getByRole("button", { name: "Send answer" }),
  ).toBeEnabled();
  await shell.configure({ codex: {} });
  await expect.poll(() => status(chat.id)).toBe("ready");
  const question = after.messages.find(({ questions }) => questions?.length)
    ?.questions?.[0];
  expect(question).toBeTruthy();
  await shell.cli(
    "conversation",
    "answer-question",
    "--id",
    chat.id,
    "--question-id",
    question!.id,
    "--answer",
    "Staging",
  );
  await expect(first.getByRole("status")).toHaveText("Answered");
});

test("Codex async question reconciles a missing live echo without retry", async () => {
  await shell.configure({
    codex: { asyncQuestionHold: true, steering: "silent" },
  });
  const workspace = await shell.create("Invented missing answer echo");
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "[async-question] Prepare invented checks");
  const first = () =>
    transcript(chat).getByRole("form", { name: "Which test environment?" });
  await first().getByRole("button", { name: "Send answer" }).click();
  await expect(first().getByRole("status")).toHaveText(
    "Answer delivery unconfirmed",
  );
  await expect(
    first().getByRole("button", { name: "Send answer" }),
  ).toHaveCount(0);
  await shell.configure({ codex: {} });
  await expect.poll(() => status(chat.id)).toBe("ready");
  await shell.stop();
  await shell.start();
  await shell.cli("conversation", "show", "--id", chat.id);
  await expect(first().getByRole("status")).toHaveText("Answered");
  const after = await shell.cli<ConversationState>(
    "conversation",
    "inspect",
    "--id",
    chat.id,
  );
  expect(
    after.messages.flatMap(({ text }) => questionAnswers(text)),
  ).toHaveLength(1);
});
