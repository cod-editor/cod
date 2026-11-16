import { test, expect } from "@playwright/test";
import type { AppState } from "../../src/types";
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

test("Rename from a chat tab reveals collapsed, hidden and maximized workspace navigation", async () => {
  const workspace = await shell.create("Rename navigation");
  const chat = await shell.newChat(workspace, "codex");
  const parent = shell.page.locator(
    `[role=treeitem][data-workspace-id="${workspace}"]`,
  );
  const row = shell.page.locator(
    `[role=treeitem][data-workspace-id="${chat.id}"]`,
  );
  const tab = shell.page.locator(`[role=tab][data-tab-id="${chat.paneId}"]`);
  await parent
    .getByRole("button", { name: "Expand or collapse workspace", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await tab.click({ button: "right" });
  await shell.page.getByRole("button", { name: "Rename", exact: true }).click();
  const input = shell.page.getByRole("textbox", {
    name: "Conversation name",
    exact: true,
  });
  await expect(input).toBeFocused();
  await input.fill("Cancelled inline name");
  await input.press("Escape");
  await expect(row).toBeFocused();
  await expect(row).not.toContainText("Cancelled inline name");
  await parent
    .getByRole("button", { name: "Expand or collapse workspace", exact: true })
    .click();
  await shell.cli(
    "workspace",
    "settings",
    "--id",
    workspace,
    "--settings",
    JSON.stringify({ workspacesVisible: false }),
  );
  const state = await shell.cli<AppState>("state");
  const group = state.workspaces.find(
    (w) => w.id === workspace,
  )!.activeGroupId!;
  await shell.cli("group", "zoom", "--workspace", workspace, "--id", group);
  await tab.click({ button: "right" });
  await shell.page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(input).toBeFocused();
  await expect(row).toBeVisible();
  expect(
    (await shell.cli<AppState>("state")).workspaces.find(
      (w) => w.id === workspace,
    )!.zoomedGroupId,
  ).toBeNull();
  await input.fill("Visible renamed chat");
  await input.press("Enter");
  await expect(row).toContainText("Visible renamed chat");
  await expect(row).toBeFocused();
  expect(await shell.prompts()).toHaveLength(0);
});

test("Closing workspace rows keeps keyboard focus on a surviving neighbor and the empty-state switcher", async () => {
  const first = await shell.create("First navigation workspace");
  const middle = await shell.create("Middle navigation workspace");
  const last = await shell.create("Last navigation workspace");
  const row = (id: string) =>
    shell.page.locator(`[role=treeitem][data-workspace-id="${id}"]`);
  const close = async (id: string) => {
    await row(id).click({ button: "right" });
    await shell.page
      .getByRole("button", { name: "Close workspace", exact: true })
      .click();
    await expect(row(id)).toHaveCount(0);
  };
  await close(middle);
  await expect(row(last)).toBeFocused();
  await row(last).press("ArrowUp");
  await expect(row(first)).toBeFocused();
  await row(first).press("Space");
  await expect
    .poll(async () => (await shell.state()).activeWorkspaceId)
    .toBe(first);
  await close(first);
  await expect(row(last)).toBeFocused();
  await close(last);
  // First launch may already have created its ordinary Untitled workspace.
  // Close every surviving fixture workspace before asserting the empty state.
  for (const workspace of (await shell.state()).workspaces)
    await close(workspace.id);
  await expect(
    shell.page.getByRole("button", { name: "Overview", exact: true }),
  ).toBeFocused();
  expect((await shell.state()).workspaces).toHaveLength(0);
});

test("Workspace review rows open with Space or Enter and expose a single selected item", async () => {
  const workspace = await shell.create("Review keyboard navigation");
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    shell.folders[0],
  );
  const chat = await shell.newChat(workspace, "codex");
  const review = await shell.cli<{ reviewId: string; paneId: string }>(
    "review",
    "open-document",
    "--workspace",
    workspace,
    "--path",
    shell.file,
    "--conversation",
    chat.id,
  );
  await shell.cli("conversation", "show", "--id", chat.id);
  const row = shell.page.locator(
    `[role=treeitem][data-workspace-id="${review.reviewId}"]`,
  );
  const parent = shell.page.locator(
    `[role=treeitem][data-workspace-id="${workspace}"]`,
  );
  const chatRow = shell.page.locator(
    `[role=treeitem][data-workspace-id="${chat.id}"]`,
  );
  await row.focus();
  await row.press("Space");
  await expect
    .poll(async () => (await shell.workspace(workspace)).activePaneId)
    .toBe(review.paneId);
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(parent).toHaveAttribute("aria-selected", "false");
  await expect(chatRow).toHaveAttribute("aria-selected", "false");
  await shell.cli("conversation", "show", "--id", chat.id);
  await expect(row).toHaveAttribute("aria-selected", "false");
  await row.focus();
  await row.press("Enter");
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(
    shell.page.getByRole("textbox", { name: "Conversation name", exact: true }),
  ).toHaveCount(0);
  expect(await shell.prompts()).toHaveLength(0);
});

async function palette() {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  return shell.page.getByRole("dialog", {
    name: "Command palette",
    exact: true,
  });
}

test("Commands exposes conversation management and targets a focused background conversation", async () => {
  const first = await shell.create("Source command workspace");
  const chat = await shell.newChat(first, "codex");
  const second = await shell.create("Destination command workspace");
  const other = await shell.newChat(second, "codex");
  const row = () =>
    shell.page.locator(`[role=treeitem][data-workspace-id="${chat.id}"]`);
  await row().focus();
  let commands = await palette();
  for (const label of [
    "Rename conversation",
    "Move conversation to workspace...",
    "Remove conversation from workspace",
    "Continue in CLI",
    "Session info...",
    "Close workspace",
  ])
    await expect(
      commands.getByRole("button", { name: label, exact: true }),
    ).toBeEnabled();
  await expect(
    commands.getByRole("button", { name: "Return to chat", exact: true }),
  ).toBeDisabled();
  await commands
    .getByRole("button", { name: "Rename conversation", exact: true })
    .click();
  const input = shell.page.getByRole("textbox", {
    name: "Conversation name",
    exact: true,
  });
  await expect(input).toBeFocused();
  await input.fill("Command renamed conversation");
  await input.press("Enter");
  await expect(row()).toContainText("Command renamed conversation");
  expect((await shell.state()).activeWorkspaceId).toBe(second);
  commands = await palette();
  await commands
    .getByRole("button", {
      name: "Move conversation to workspace...",
      exact: true,
    })
    .click();
  await shell.page
    .getByRole("dialog", {
      name: "Move conversation to workspace",
      exact: true,
    })
    .getByRole("button", { name: "Destination command workspace", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await shell.cli<AppState>("state")).conversations.find(
          (item) => item.id === chat.id,
        )?.workspaceId,
    )
    .toBe(second);
  expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
  await row().focus();
  commands = await palette();
  await commands
    .getByRole("button", {
      name: "Remove conversation from workspace",
      exact: true,
    })
    .click();
  await expect(row()).toHaveCount(0);
  expect(
    (await shell.cli<AppState>("state")).conversations.some(
      (item) => item.id === other.id,
    ),
  ).toBe(true);
  await shell.cli("pane", "reopen", "--workspace", second);
  expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
  await shell.page
    .locator(`[role=treeitem][data-workspace-id="${first}"]`)
    .focus();
  commands = await palette();
  await commands
    .getByRole("button", { name: "Close workspace", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await shell.state()).workspaces.some((item) => item.id === first),
    )
    .toBe(false);
  expect((await shell.state()).activeWorkspaceId).toBe(second);
  expect(await shell.prompts()).toHaveLength(0);
});

test("Commands shares busy and queued-message guards with conversation context actions", async () => {
  const workspace = await shell.create("Command availability");
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "Hold command fixture [hold]");
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("working");
  let commands = await palette();
  await expect(
    commands.getByRole("button", { name: "Continue in CLI", exact: true }),
  ).toBeDisabled();
  await expect(
    commands.getByRole("button", {
      name: "Remove conversation from workspace",
      exact: true,
    }),
  ).toBeDisabled();
  const search = commands.getByRole("textbox", {
    name: "Filter commands",
    exact: true,
  });
  await search.fill("Rename");
  await search.press("ArrowDown");
  const selected = await search.getAttribute("aria-activedescendant");
  await shell.cli("conversation", "interrupt", "--id", chat.id);
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("ready");
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute("aria-activedescendant", selected!);
  await search.fill("");
  await expect(
    commands.getByRole("button", { name: "Continue in CLI", exact: true }),
  ).toBeEnabled();
  await shell.page.keyboard.press("Escape");
  await shell.send(chat.id, "Second held command fixture [hold]");
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("working");
  await shell.send(chat.id, "Queued command fixture");
  await shell.cli("conversation", "interrupt", "--id", chat.id);
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("ready");
  commands = await palette();
  await expect(
    commands.getByRole("button", { name: "Continue in CLI", exact: true }),
  ).toBeDisabled();
  await expect(
    commands.getByRole("button", { name: "Continue in CLI", exact: true }),
  ).toHaveAttribute("title", "Send or cancel queued messages first");
  await expect(
    commands.getByRole("button", { name: "Rename conversation", exact: true }),
  ).toBeEnabled();
});

test("Commands never retargets a removed conversation to another active chat", async () => {
  const first = await shell.create("Original command target");
  const chat = await shell.newChat(first, "codex");
  const second = await shell.create("Other active command target");
  const other = await shell.newChat(second, "codex");
  await shell.page
    .locator(`[role=treeitem][data-workspace-id="${chat.id}"]`)
    .focus();
  await shell.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(780, 650),
  );
  const commands = await palette();
  const search = commands.getByRole("textbox", {
    name: "Filter commands",
    exact: true,
  });
  await search.fill("Rename conversation");
  const rename = commands.getByRole("button", {
    name: "Rename conversation",
    exact: true,
  });
  await expect(rename).toBeEnabled();
  await shell.cli("conversation", "remove", "--id", chat.id);
  await expect(rename).toBeDisabled();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("Rename conversation");
  await shell.page.screenshot({
    path: test.info().outputPath("disabled-command-target.png"),
  });
  await search.press("Enter");
  await expect(
    shell.page.getByRole("textbox", { name: "Conversation name", exact: true }),
  ).toHaveCount(0);
  expect((await shell.inspect(other.id)).nativeId).toBe(other.nativeId);
  expect((await shell.state()).activeWorkspaceId).toBe(second);
});
