import { test, expect } from "@playwright/test";
import { ChatApp } from "./helpers/chat-fixture/harness";
import { modifier } from "./helpers/workspace-app";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
test.setTimeout(90_000);

let shell: ChatApp;
test.beforeEach(async () => {
  shell = new ChatApp();
  await shell.prepare();
  await shell.start();
});
test.afterEach(async () => {
  await shell?.cleanup();
});

test("New task stays a compact bottom-composer chat at normal and wide window sizes", async ({}, info) => {
  await expect(
    shell.page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  expect(
    (await shell.state()).workspaces.some(
      (workspace) => workspace.name === "Untitled",
    ),
  ).toBe(true);
  const name = "A workspace with a thirty-two-plus character title";
  const workspace = await shell.create(name);
  const view = shell.pane((await shell.workspace(workspace)).activePaneId);
  const composer = view.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeVisible();
  await expect(
    view.getByRole("button", { name: "Provider", exact: true }),
  ).toBeVisible();
  await expect(
    view.getByRole("button", { name: "Send", exact: true }),
  ).toHaveCount(0);
  for (const width of [1280, 1920]) {
    await shell.app!.evaluate(({ BrowserWindow }, width) => {
      BrowserWindow.getAllWindows()[0].setSize(width, 900);
    }, width);
    await expect
      .poll(async () => (await composer.boundingBox())?.y ?? 0)
      .toBeGreaterThan(600);
    const box = await composer.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(1120);
    expect(box!.width).toBeGreaterThan(450);
    await shell.page.screenshot({
      path: info.outputPath(`empty-chat-${width}.png`),
    });
  }
  await composer.fill("Keep this unsent task description");
  await composer.press("Enter");
  await expect(composer).toHaveValue("Keep this unsent task description\n");
  expect(
    (await shell.cli<{ conversations: unknown[] }>("state")).conversations,
  ).toHaveLength(0);
  await shell.create("Another task");
  await shell.cli("workspace", "focus", "--id", workspace);
  await expect(composer).toHaveValue("Keep this unsent task description\n");
  await shell.stop();
  await shell.start();
  await expect(
    shell
      .pane((await shell.workspace(workspace)).activePaneId)
      .getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Keep this unsent task description\n");
});

test("Background workspace creation preserves chat, keyboard focus and unsent draft", async ({}, info) => {
  const workspace = await shell.create("Foreground task");
  const paneId = (await shell.workspace(workspace)).activePaneId;
  const composer = shell
    .pane(paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Do not move my caret");
  await composer.press("ArrowLeft");
  const selection = await composer.evaluate(
    (node) => (node as HTMLTextAreaElement).selectionStart,
  );
  const background = await shell.cli<{ id: string }>(
    "workspace",
    "create",
    "--name",
    "Agent-created background task",
  );
  expect(background.id).not.toBe(workspace);
  expect((await shell.state()).activeWorkspaceId).toBe(workspace);
  await expect(composer).toBeFocused();
  expect(
    await composer.evaluate(
      (node) => (node as HTMLTextAreaElement).selectionStart,
    ),
  ).toBe(selection);
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  await expect(shell.page.getByRole("dialog")).toBeVisible();
  await shell.page.keyboard.press("Escape");
  await expect(composer).toBeFocused();
  await shell.page.screenshot({
    path: info.outputPath("background-context-preserved.png"),
  });
});

test("Closing views preserves conversation ownership and file drafts; busy workspace closure is rejected atomically", async ({}, info) => {
  const workspace = await shell.create("Lifecycle task");
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "[hold] keep ownership through view changes");
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("working");
  const rejected = await shell.raw("workspace", "close", "--id", workspace);
  expect(rejected.code).not.toBe(0);
  expect(
    (await shell.state()).workspaces.some((item) => item.id === workspace),
  ).toBe(true);
  expect((await shell.inspect(chat.id)).status).toBe("working");
  await shell.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    chat.paneId,
  );
  expect((await shell.inspect(chat.id)).status).toBe("working");
  const reopened = await shell.cli<{ paneId: string }>(
    "pane",
    "reopen",
    "--workspace",
    workspace,
  );
  expect(reopened.paneId).toBe(chat.paneId);
  await expect(
    shell
      .pane(chat.paneId)
      .getByRole("region", { name: "Conversation transcript", exact: true }),
  ).toContainText("keep ownership");
  await shell.cli("conversation", "interrupt", "--id", chat.id);
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("ready");
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    shell.folders[0],
  );
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
  await editor.fill("# Unsaved lifecycle draft\n");
  await shell.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    file.paneId,
  );
  const restoredFile = await shell.cli<{ paneId: string }>(
    "pane",
    "reopen",
    "--workspace",
    workspace,
  );
  expect(restoredFile.paneId).toBe(file.paneId);
  await expect(editor).toHaveValue("# Unsaved lifecycle draft\n");
  expect(await shell.contents()).not.toContain("Unsaved lifecycle draft");
  await shell.page.screenshot({
    path: info.outputPath("restored-draft-and-conversation.png"),
  });
  await shell.cli("workspace", "close", "--id", workspace);
  expect(
    (await shell.state()).workspaces.some((item) => item.id === workspace),
  ).toBe(false);
  await shell.stop();
  await shell.start();
  await shell.cli("workspace", "reopen", "--id", workspace);
  await expect(
    shell
      .pane(file.paneId)
      .getByRole("textbox", { name: "File contents", exact: true }),
  ).toHaveValue("# Unsaved lifecycle draft\n");
  expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
  const records = await shell.records();
  expect(
    records.filter((record) => record.message?.method === "turn/start"),
  ).toHaveLength(1);
});

test("Reopening a closed terminal requires explicit fresh-shell intent and never replays commands", async () => {
  const workspace = await shell.create("Terminal lifecycle");
  const terminal = await shell.cli<{ id: string; paneId: string }>(
    "terminal",
    "open",
    "--workspace",
    workspace,
    "--cwd",
    shell.folders[0],
  );
  await shell.cli(
    "terminal",
    "write",
    "--id",
    terminal.id,
    "--data",
    "echo INVENTED_TERMINAL_MARKER\n",
  );
  await expect
    .poll(async () =>
      JSON.stringify(
        await shell.cli("terminal", "inspect", "--id", terminal.id),
      ),
    )
    .toContain("INVENTED_TERMINAL_MARKER");
  await shell.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    terminal.paneId,
  );
  expect(
    (await shell.raw("pane", "reopen", "--workspace", workspace)).code,
  ).not.toBe(0);
  const reopened = await shell.cli<{ paneId: string }>(
    "pane",
    "reopen",
    "--workspace",
    workspace,
    "--new-shell",
    "true",
  );
  expect(reopened.paneId).not.toBe(terminal.paneId);
  const state = await shell.cli<{
    terminals: Array<{ id: string; paneId: string; output: string }>;
  }>("state");
  const fresh = state.terminals.find(
    (item) => item.paneId === reopened.paneId,
  )!;
  expect(fresh.id).not.toBe(terminal.id);
  expect(
    JSON.stringify(await shell.cli("terminal", "inspect", "--id", fresh.id)),
  ).not.toContain("INVENTED_TERMINAL_MARKER");
});

for (const provider of ["codex", "kimi"] as const) {
  test(`${provider} native CLI handoff has one controller and explicit reclaim without inference`, async () => {
    const workspace = await shell.create(`${provider} handoff task`);
    const chat = await shell.newChat(workspace, provider);
    await shell.send(chat.id, "handoff baseline");
    await expect
      .poll(async () => (await shell.inspect(chat.id)).status)
      .toBe("ready");
    const beforePrompts = await shell.prompts();
    const handoff = await shell.cli<{ terminalId: string; paneId: string }>(
      "conversation",
      "handoff",
      "--id",
      chat.id,
    );
    expect(handoff.terminalId).toBeTruthy();
    expect(
      (
        await shell.raw(
          "conversation",
          "send",
          "--id",
          chat.id,
          "--text",
          "must not run under two controllers",
        )
      ).code,
    ).not.toBe(0);
    expect(
      (await shell.raw("conversation", "reclaim", "--id", chat.id)).code,
    ).not.toBe(0);
    await shell.cli("terminal", "close", "--id", handoff.terminalId);
    await shell.cli("conversation", "reclaim", "--id", chat.id);
    expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
    expect(
      (await shell.inspect(chat.id)).messages
        .map((message) => message.text)
        .join("\n"),
    ).toContain("handoff baseline");
    expect(await shell.prompts()).toHaveLength(beforePrompts.length);
    await shell.cli("conversation", "show", "--id", chat.id);
    await expect(
      shell
        .pane(chat.paneId)
        .getByRole("region", { name: "Conversation transcript", exact: true }),
    ).toContainText("handoff baseline");
  });

  test(`${provider} image-only first message: native clipboard preview, restart and provider delivery`, async ({}, info) => {
    const workspace = await shell.create(`${provider} image task`);
    await shell.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      shell.folders[0],
    );
    const paneId = (await shell.workspace(workspace)).activePaneId;
    let pane = shell.pane(paneId);
    await pane.getByRole("button", { name: "Provider", exact: true }).click();
    await shell.page
      .getByRole("button", {
        name: provider === "codex" ? "Codex" : "Kimi",
        exact: true,
      })
      .click();
    await shell.app!.evaluate(
      async ({ clipboard, nativeImage, ClipboardItem }) => {
        const bitmap = Buffer.alloc(32 * 32 * 4, 255);
        for (let offset = 0; offset < bitmap.length; offset += 4) {
          bitmap[offset] = 100;
          bitmap[offset + 1] = 160;
          bitmap[offset + 2] = 220;
        }
        const image = nativeImage.createFromBitmap(bitmap, {
          width: 32,
          height: 32,
        });
        await clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([new Uint8Array(image.toPNG())], {
              type: "image/png",
            }),
          }),
        ]);
      },
    );
    let composer = pane.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.click();
    await composer.press(`${modifier}+V`);
    await expect(
      pane.getByRole("button", { name: "Remove image", exact: true }),
    ).toBeVisible();
    await shell.page.screenshot({
      path: info.outputPath(`${provider}-pasted-image.png`),
    });
    await shell.stop();
    await shell.start();
    pane = shell.pane(paneId);
    composer = pane.getByRole("textbox", { name: "Message", exact: true });
    await expect(
      pane.getByRole("button", { name: "Remove image", exact: true }),
    ).toBeVisible();
    await composer.press(`${modifier}+Enter`);
    await expect
      .poll(
        async () =>
          (
            await shell.cli<{
              conversations: Array<{ id: string; provider: string }>;
            }>("state")
          ).conversations.length,
      )
      .toBe(1);
    const chat = (
      await shell.cli<{
        conversations: Array<{
          id: string;
          provider: string;
          messages: Array<{ images?: unknown[] }>;
        }>;
      }>("state")
    ).conversations[0];
    expect(chat.provider).toBe(provider);
    await expect
      .poll(async () => (await shell.inspect(chat.id)).status)
      .toBe("ready");
    const prompts = await shell.prompts();
    expect(prompts).toHaveLength(1);
    const params = prompts[0].message!.params!;
    if (provider === "codex")
      expect(JSON.stringify(params)).toContain("data:image/png;base64,");
    else {
      expect(JSON.stringify(params)).toContain('"type":"image"');
      expect(JSON.stringify(params)).toContain('"mimeType":"image/png"');
    }
    await expect(pane.locator(".transcript img")).toHaveCount(1);
    await shell.stop();
    await shell.start();
    pane = shell.pane(paneId);
    await expect(pane.locator(".transcript img")).toHaveCount(1);
    expect(await shell.prompts()).toHaveLength(1);
    await shell.page.screenshot({
      path: info.outputPath(`${provider}-image-transcript-restored.png`),
    });
  });
}

test("Agent integration installation previews explicit temporary profile before writing", async ({}, info) => {
  const profile = path.join(shell.temporary, "invented-codex-profile");
  await shell.command("Install agent integration...");
  const dialog = shell.page.getByRole("dialog", {
    name: "Install agent integration",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Agent profile directory" })
    .fill(profile);
  await dialog
    .getByRole("button", { name: "Preview changes", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Install integration", exact: true }),
  ).toBeVisible();
  await expect(access(path.join(profile, "hooks.json"))).rejects.toThrow();
  await expect(dialog).toContainText("/hooks");
  await shell.page.screenshot({
    path: info.outputPath("integration-explicit-preview.png"),
  });
  await dialog
    .getByRole("button", { name: "Install integration", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("Integration installed.");
  const hooks = JSON.parse(
    await readFile(path.join(profile, "hooks.json"), "utf8"),
  );
  expect(hooks.hooks.SessionStart).toHaveLength(1);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await shell.command("Install agent integration...");
  await dialog
    .getByRole("textbox", { name: "Agent profile directory" })
    .fill(profile);
  await dialog
    .getByRole("button", { name: "Preview changes", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Integration is installed.",
  );
});

test("Long conversation remains readable beside a multi-repository file tree and document", async ({}, info) => {
  const workspace = await shell.create("Export reports");
  for (const folder of shell.folders)
    await shell.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      folder,
    );
  const chat = await shell.newChat(workspace, "codex");
  for (const prompt of [
    "Inspect the report API and web repositories before writing the export specification.",
    "Keep the first version small. Explain how permissions apply to exported rows.",
    "Use CSV with the active filters. The export should include only fields the user can view.",
    "What happens if the export exceeds one hundred thousand rows? Include an actionable error.",
    "Update the specification with the agreed limit and cover cancellation in the tests.",
    "Summarize the changes and leave the document open for my review.",
  ]) {
    await shell.send(chat.id, prompt);
    await expect
      .poll(async () => (await shell.inspect(chat.id)).status)
      .toBe("ready");
  }
  const file = await shell.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    shell.file,
  );
  await shell.page
    .getByRole("button", { name: "Toggle files", exact: true })
    .click();
  await expect(
    shell.page.getByRole("tree", { name: "File tree", exact: true }),
  ).toBeVisible();
  await expect(
    shell
      .pane(file.paneId)
      .getByRole("textbox", { name: "File contents", exact: true }),
  ).toBeVisible();
  const transcript = shell
    .pane(chat.paneId)
    .getByRole("region", { name: "Conversation transcript", exact: true });
  await expect(transcript).toBeVisible();
  await expect(transcript).toContainText("Summarize the changes");
  await shell.page.screenshot({
    path: info.outputPath("multi-repo-document-long-chat.png"),
  });
});

test("Opening first material preserves the fresh workspace conversation draft", async () => {
  const workspace = await shell.create("Draft and first document");
  const draft = (await shell.workspace(workspace)).activePaneId;
  const composer = shell
    .pane(draft)
    .getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Unsent specification request");
  const file = await shell.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    shell.file,
  );
  expect(file.paneId).not.toBe(draft);
  await expect(composer).toBeVisible();
  await expect(composer).toHaveValue("Unsent specification request");
  await expect(
    shell
      .pane(file.paneId)
      .getByRole("textbox", { name: "File contents", exact: true }),
  ).toBeVisible();
});

test("First conversation initialization failure restores the same draft beside open material", async () => {
  const workspace = await shell.create("Recover initial connection");
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    shell.folders[0],
  );
  const draftId = (await shell.workspace(workspace)).activePaneId;
  await shell
    .pane(draftId)
    .getByRole("button", { name: "Provider", exact: true })
    .click();
  await shell.page.getByRole("button", { name: "Kimi", exact: true }).click();
  const draftText = "Keep my original request after the connection fails";
  const composer = shell
    .pane(draftId)
    .getByRole("textbox", { name: "Message", exact: true });
  await composer.fill(draftText);
  const file = await shell.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    shell.file,
  );
  await shell.configure({ kimi: { initializeError: true } });
  await composer.press(`${modifier}+Enter`);
  await expect(
    shell
      .pane(draftId)
      .getByRole("status")
      .filter({ hasText: /Provider process exited \(17\)/ }),
  ).toBeVisible();
  await expect(composer).toHaveValue(draftText);
  expect(
    (await shell.workspace(workspace)).panes.some(
      (pane) => pane.id === draftId,
    ),
  ).toBe(true);
  await expect(
    shell
      .pane(file.paneId)
      .getByRole("textbox", { name: "File contents", exact: true }),
  ).toBeVisible();
  await shell.stop();
  await shell.start();
  await expect(
    shell.pane(draftId).getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue(draftText);
});

test("Workspace status icons match their chats and prioritize actual failures", async ({}, info) => {
  const workspace = await shell.create("Attention fixture");
  const ready = await shell.newChat(workspace, "codex");
  await shell.cli(
    "conversation",
    "report-status",
    "--id",
    ready.id,
    "--status",
    "ready",
  );
  let workspaceRow = shell.row("Attention fixture");
  let readyRow = shell.page.locator(`[data-workspace-id="${ready.id}"]`);
  const color = (row: import("@playwright/test").Locator) =>
    row
      .locator(":scope > .icon, :scope > .tree-disclosure > .icon")
      .evaluate((node) => getComputedStyle(node).color);
  await expect(readyRow).toHaveAttribute("data-status", "ready");
  await expect(workspaceRow).toHaveAttribute("data-status", "ready");
  await expect(workspaceRow).toHaveAttribute("aria-label", /Completed/);
  expect(await color(workspaceRow)).toBe(await color(readyRow));

  const failed = await shell.newChat(workspace, "kimi");
  await shell.send(failed.id, "[crash]");
  await expect
    .poll(async () => (await shell.inspect(failed.id)).status)
    .toBe("failed");
  // A stale ready hook must never hide the failed native controller.
  await shell.cli(
    "conversation",
    "report-status",
    "--id",
    failed.id,
    "--status",
    "ready",
  );
  let failedRow = shell.page.locator(`[data-workspace-id="${failed.id}"]`);
  await expect(failedRow).toHaveAttribute("data-status", "failed");
  await expect(readyRow).toHaveAttribute("data-status", "ready");
  await expect(workspaceRow).toHaveAttribute("data-status", "failed");
  await expect(workspaceRow).toHaveAttribute("aria-label", /Error/);
  expect(await color(workspaceRow)).toBe(await color(failedRow));
  expect(await color(readyRow)).not.toBe(await color(failedRow));
  const review = await shell.newChat(workspace, "codex");
  await shell.cli(
    "conversation",
    "report-status",
    "--id",
    review.id,
    "--status",
    "review",
  );
  const waiting = await shell.newChat(workspace, "codex");
  await shell.cli(
    "conversation",
    "report-status",
    "--id",
    waiting.id,
    "--status",
    "waiting",
  );
  const working = await shell.newChat(workspace, "codex");
  await shell.send(working.id, "[hold] Implement export");
  const workingRow = shell.page.locator(`[data-workspace-id="${working.id}"]`);
  await expect(workingRow).toHaveAttribute("data-status", "working");
  await expect(workingRow).toHaveAttribute("aria-label", /Working/);
  const reviewRow = shell.page.locator(`[data-workspace-id="${review.id}"]`);
  await expect(reviewRow).toHaveAttribute("data-status", "review");
  await expect(reviewRow).toHaveAttribute("aria-label", /Review requested/);
  expect(await color(workingRow)).not.toBe(await color(readyRow));
  expect(await color(reviewRow)).not.toBe(await color(workingRow));
  await expect(shell.page.locator("#workspace-tree .attention")).toHaveCount(0);
  await failedRow.click();
  await expect(failedRow).toHaveAttribute("aria-selected", "true");
  await expect(workspaceRow).toHaveAttribute("data-status", "failed");
  await shell.page.screenshot({
    path: info.outputPath("status-icons-mixed-selected.png"),
  });
  const failedColor = await color(failedRow);
  await workspaceRow
    .getByRole("button", { name: "Expand or collapse workspace", exact: true })
    .click();
  await expect(workspaceRow).toHaveAttribute("aria-expanded", "false");
  await expect(workingRow).toHaveCount(0);
  await expect(workspaceRow).toHaveAttribute("data-status", "failed");
  expect(await color(workspaceRow)).toBe(failedColor);
  await shell.page.screenshot({
    path: info.outputPath("status-icons-collapsed-aggregate.png"),
  });
  await expect(workspaceRow.locator(".workspace-child-count")).toHaveText("5");
  await expect(workspaceRow.locator(".workspace-child-count")).toHaveAttribute(
    "aria-label",
    "5 hidden conversations",
  );
  await workspaceRow.locator(".tree-label").click();
  await expect(workspaceRow).toHaveAttribute("aria-expanded", "false");
  await expect(workspaceRow.locator(".workspace-child-count")).toHaveText("5");
  await shell.stop();
  await shell.start();
  workspaceRow = shell.row("Attention fixture");
  readyRow = shell.page.locator(`[data-workspace-id="${ready.id}"]`);
  failedRow = shell.page.locator(`[data-workspace-id="${failed.id}"]`);
  await expect(workspaceRow).toHaveAttribute("aria-expanded", "false");
  await expect(workspaceRow.locator(".workspace-child-count")).toHaveText("5");
  await expect(workspaceRow).toHaveAttribute("data-status", "failed");
  await shell.page.screenshot({
    path: info.outputPath("workspace-collapsed-count-restored.png"),
  });
  await shell.page.keyboard.press(`${modifier}+Shift+W`);
  await expect(workspaceRow).toBeFocused();
  await shell.page.keyboard.press("ArrowRight");
  await expect(workspaceRow).toHaveAttribute("aria-expanded", "true");
  await expect(workspaceRow.locator(".workspace-child-count")).toHaveCount(0);
  await shell.page.keyboard.press("ArrowRight");
  await expect(readyRow).toBeFocused();
  await shell.page.keyboard.press("ArrowLeft");
  await expect(workspaceRow).toBeFocused();
  await shell.page.keyboard.press("ArrowLeft");
  await expect(workspaceRow).toHaveAttribute("aria-expanded", "false");
  await workspaceRow
    .getByRole("button", { name: "Expand or collapse workspace", exact: true })
    .click();
  await expect(workspaceRow).toHaveAttribute("aria-expanded", "true");
  await expect(failedRow).toHaveAttribute("aria-selected", "true");
  await shell.page.screenshot({
    path: info.outputPath("workspace-icon-expanded.png"),
  });
});
