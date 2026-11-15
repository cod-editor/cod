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
