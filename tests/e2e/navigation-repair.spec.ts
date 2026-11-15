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
  await expect(
    shell.page.getByRole("button", { name: "Switch workspace", exact: true }),
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
