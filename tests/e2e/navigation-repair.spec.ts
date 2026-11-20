import { test, expect } from "@playwright/test";
import type { AppState } from "../../src/types";
import { ChatApp } from "./helpers/chat-fixture/harness";
import { modifier } from "./helpers/workspace-app";
let shell: ChatApp;
test.beforeEach(async () => {
  shell = new ChatApp();
  await shell.prepare();
  await shell.start();
});
test.afterEach(async () => {
  await shell?.cleanup();
});

const overviewRow = (kind: string, id: string) =>
  shell.page.locator(
    `.workspace-overview .overview-item[data-navigation-key="${kind}:${id}"]`,
  );

async function overviewAction(kind: string, id: string, label: string) {
  const overview = await shell.overview();
  await overviewRow(kind, id).click({ button: "right" });
  await shell.page.getByRole("button", { name: label, exact: true }).click();
  return overview;
}

async function reopenPicker() {
  await shell.command("Reopen closed workspace");
  const picker = shell.page.getByRole("dialog", {
    name: "Overview",
    exact: true,
  });
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("checkbox", { name: "Show closed workspaces" }),
  ).toBeChecked();
  return picker;
}

test("Rename from a chat tab opens the targeted inline editor in Overview", async () => {
  const workspace = await shell.create("Rename navigation");
  const chat = await shell.newChat(workspace, "codex");
  const tab = shell.page.locator(`[role=tab][data-tab-id="${chat.paneId}"]`);
  const rename = async () => {
    await tab.click({ button: "right" });
    await shell.page
      .getByRole("button", { name: "Rename", exact: true })
      .click();
  };
  const input = shell.page.getByRole("textbox", {
    name: "Conversation name",
    exact: true,
  });
  await rename();
  await expect(input).toBeFocused();
  await input.fill("Cancelled inline name");
  await input.press("Escape");
  await expect(overviewRow("conversation", chat.id)).not.toContainText(
    "Cancelled inline name",
  );
  await shell.page.keyboard.press("Escape");
  await shell.cli("group", "toggle-split", "--workspace", workspace);
  await shell.cli("group", "toggle-split", "--workspace", workspace);
  await rename();
  await expect(input).toBeFocused();
  await input.fill("Visible renamed chat");
  await input.press("Enter");
  await expect(overviewRow("conversation", chat.id)).toContainText(
    "Visible renamed chat",
  );
  await expect((await shell.overview()).getByRole("combobox")).toBeFocused();
  expect(
    (await shell.cli<AppState>("state")).workspaces
      .find((item) => item.id === workspace)!
      .groups.filter((group) => !group.hidden),
  ).toHaveLength(1);
  expect(await shell.prompts()).toHaveLength(0);
});

test("Closing workspace results selects a surviving neighbor and supports reopen", async () => {
  const first = await shell.create("First navigation workspace");
  const middle = await shell.create("Middle navigation workspace");
  const last = await shell.create("Last navigation workspace");
  const overview = await overviewAction("workspace", middle, "Close workspace");
  await expect(overviewRow("workspace", middle)).toHaveCount(0);
  await expect(overviewRow("workspace", last)).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(overview.getByRole("combobox")).toBeFocused();
  await overviewAction("workspace", last, "Close workspace");
  await expect(overviewRow("workspace", first)).toHaveAttribute(
    "aria-current",
    "true",
  );
  await overview.getByRole("combobox").press("Enter");
  await expect
    .poll(async () => (await shell.state()).activeWorkspaceId)
    .toBe(first);
  for (const workspace of (await shell.state()).workspaces) {
    await overviewAction("workspace", workspace.id, "Close workspace");
    await expect(overviewRow("workspace", workspace.id)).toHaveCount(0);
  }
  await expect(overview).toContainText("No workspaces");
  expect((await shell.state()).workspaces).toHaveLength(0);
  await overview.getByRole("combobox").press("Escape");
  const picker = await reopenPicker();
  expect((await shell.state()).workspaces).toHaveLength(0);
  await picker.getByRole("combobox").press("Enter");
  await expect
    .poll(async () => (await shell.state()).workspaces)
    .toHaveLength(1);
});

test("Filter closed workspaces in Overview and reopen the selected older workspace", async ({}, info) => {
  const earlier = await shell.create("Northstar Planning");
  const earlierPane = (await shell.workspace(earlier)).activePaneId;
  const draft = (paneId: string) =>
    shell.pane(paneId).getByRole("textbox", { name: "Message", exact: true });
  await draft(earlierPane).fill("Saved planning draft");
  await shell.cli("group", "toggle-split", "--workspace", earlier);
  const savedLayout = (await shell.workspace(earlier)).groupLayout;
  const release = await shell.create("Release 2042");
  const latest = await shell.create("Northstar Follow-up");
  const current = await shell.create("Current work");
  for (const id of [earlier, release, latest])
    await shell.cli("workspace", "close", "--id", id);
  const currentDraft = draft((await shell.workspace(current)).activePaneId);
  await currentDraft.fill("Keep editing here");
  await currentDraft.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(5, 12),
  );
  const picker = await shell.overview();
  const search = picker.getByRole("combobox");
  const filter = picker.getByRole("checkbox", {
    name: "Show closed workspaces",
  });
  const results = picker.locator("[data-closed] button.overview-item");
  await expect(search).toBeFocused();
  await expect(filter).not.toBeChecked();
  await search.fill("NORTHSTAR");
  await expect(results).toHaveCount(0);
  await search.press("Tab");
  await expect(filter).toBeFocused();
  await filter.press("Space");
  await expect(filter).toBeChecked();
  await expect(search).toHaveValue("NORTHSTAR");
  await expect(results).toHaveText([
    "Northstar Follow-up",
    "Northstar Planning",
  ]);
  await filter.click();
  await expect(filter).not.toBeChecked();
  await expect(search).toHaveValue("NORTHSTAR");
  await expect(results).toHaveCount(0);
  await filter.press("Space");
  await filter.press("Shift+Tab");
  await expect(search).toBeFocused();
  await search.fill("");
  await expect(results).toHaveText([
    "Northstar Follow-up",
    "Release 2042",
    "Northstar Planning",
  ]);
  await search.fill("missing");
  await expect(picker.getByRole("status")).toHaveText("No matching items");
  await search.press("Enter");
  expect((await shell.state()).activeWorkspaceId).toBe(current);
  await search.press("Escape");
  await expect(picker).toBeHidden();
  await expect(currentDraft).toBeFocused();
  expect(
    await currentDraft.evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([5, 12]);

  await reopenPicker();
  await search.fill("NORTHSTAR");
  await expect(results).toHaveText([
    "Northstar Follow-up",
    "Northstar Planning",
  ]);
  await search.press("ArrowDown");
  const olderRow = overviewRow("closed-workspace", earlier);
  await expect(olderRow).toHaveAttribute("aria-current", "true");
  await expect(olderRow).toHaveAccessibleDescription("Closed workspace");
  await expect(olderRow.locator(".navigation-item-icon")).toHaveCSS(
    "opacity",
    "0.7",
  );
  await expect(picker.locator(".picker-footer")).toContainText(
    /Reopen\s*Enter/,
  );
  expect(await search.getAttribute("aria-activedescendant")).toBe(
    await olderRow.getAttribute("id"),
  );
  await shell.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(760, 700),
  );
  await shell.page.screenshot({
    path: info.outputPath("overview-closed-workspaces.png"),
  });
  await search.press("Enter");
  await expect(picker).toBeHidden();
  await expect(draft(earlierPane)).toHaveValue("Saved planning draft");
  expect((await shell.workspace(earlier)).groupLayout).toEqual(savedLayout);
  expect((await shell.state()).activeWorkspaceId).toBe(earlier);

  await reopenPicker();
  await expect(results).toHaveText(["Northstar Follow-up", "Release 2042"]);
  const staleRow = await overviewRow(
    "closed-workspace",
    latest,
  ).elementHandle();
  await shell.cli("workspace", "reopen", "--id", latest);
  await shell.cli("workspace", "focus", "--id", earlier);
  await expect(overviewRow("closed-workspace", latest)).toHaveCount(0);
  await staleRow!.evaluate((row) => {
    if (!(row instanceof HTMLButtonElement)) throw new Error("Missing result");
    row.click();
  });
  await expect(picker.getByRole("alert")).toContainText(/no longer closed/i);
  await expect(search).toBeFocused();
  expect((await shell.state()).activeWorkspaceId).toBe(earlier);
  expect(
    (await shell.state()).workspaces.some(({ id }) => id === release),
  ).toBe(false);
  await search.fill("release");
  await overviewRow("closed-workspace", release).click();
  await expect
    .poll(async () => (await shell.state()).activeWorkspaceId)
    .toBe(release);
});

test("A closed workspace with a terminal requires confirmation to start fresh shells", async () => {
  const state = () => shell.cli<AppState>("state");
  const workspace = await shell.create("Terminal archive");
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
    "echo ARCHIVED_SHELL_MARKER\n",
  );
  await expect
    .poll(
      async () =>
        (await state()).terminals.find((item) => item.id === terminal.id)
          ?.output,
    )
    .toContain("ARCHIVED_SHELL_MARKER");
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "Saved handoff conversation");
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("ready");
  const handoff = await shell.cli<{ terminalId: string; paneId: string }>(
    "conversation",
    "handoff",
    "--id",
    chat.id,
  );
  await shell.cli("workspace", "close", "--id", workspace, "--force", "true");
  const picker = await reopenPicker();
  const search = picker.getByRole("combobox");
  await search.fill("Terminal archive");
  const terminalRow = overviewRow("closed-workspace", workspace);
  await expect(terminalRow).toBeVisible();
  await expect(picker.getByRole("row")).toHaveCount(1);
  expect((await state()).terminals).toHaveLength(0);
  await search.press("Enter");
  const confirmation = shell.page.getByRole("dialog", {
    name: "Reopen workspace?",
    exact: true,
  });
  await expect(confirmation).toContainText("Terminal archive");
  await expect(
    confirmation.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toBeHidden();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("Terminal archive");
  expect((await state()).terminals).toHaveLength(0);
  await terminalRow.click();
  await confirmation
    .getByRole("button", { name: "Reopen workspace", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await state()).terminals.find(
          (item) => item.paneId === terminal.paneId,
        )?.status,
    )
    .toBe("running");
  const restored = await state();
  const fresh = restored.terminals.find(
    (item) => item.paneId === terminal.paneId,
  )!;
  expect(fresh.id).not.toBe(terminal.id);
  expect(fresh.output).not.toContain("ARCHIVED_SHELL_MARKER");
  const panes = restored.workspaces.find(({ id }) => id === workspace)!.panes;
  expect(panes.find(({ id }) => id === terminal.paneId)).toMatchObject({
    kind: "terminal",
    terminalId: fresh.id,
  });
  expect(panes.find(({ id }) => id === handoff.paneId)).toMatchObject({
    kind: "terminal",
    terminalId: handoff.terminalId,
  });
  expect(
    restored.terminals.find(({ id }) => id === handoff.terminalId),
  ).toMatchObject({
    nativeConversationId: chat.id,
    status: "exited",
    pid: 0,
  });
  expect(
    restored.conversations.find(({ id }) => id === chat.id)?.handoffTerminalId,
  ).toBe(handoff.terminalId);
  await shell.cli("conversation", "reclaim", "--id", chat.id);
  expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
});

test("A pending review opens through Overview by keyboard and mouse after closing its tab", async () => {
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
  await shell.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    review.paneId,
  );
  expect((await shell.workspace(workspace)).activePaneId).toBe(chat.paneId);
  const overview = await shell.overview();
  const search = overview.getByRole("combobox");
  await search.fill("Review: spec.md");
  await expect(search).toBeFocused();
  const row = overviewRow("review", review.reviewId);
  const resultCount = await overview.locator(".overview-item:visible").count();
  for (let step = 0; step < resultCount; step++) {
    if ((await row.getAttribute("aria-current")) === "true") break;
    await search.press("ArrowDown");
  }
  await expect(row).toHaveAttribute("aria-current", "true");
  await search.press("Enter");
  await expect(shell.page.locator(".review-body")).toBeVisible();
  const active = (await shell.cli<AppState>("state")).workspaces.find(
    (item) => item.id === workspace,
  )!;
  expect(
    active.panes.find((pane) => pane.id === active.activePaneId),
  ).toMatchObject({ kind: "review", reviewId: review.reviewId });
  await shell.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    active.activePaneId,
  );
  await shell.overview();
  await overviewRow("review", review.reviewId).click();
  await expect(shell.page.locator(".review-body")).toBeVisible();
  expect(await shell.prompts()).toHaveLength(0);
});

async function palette() {
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  return shell.page.getByRole("dialog", {
    name: "Command palette",
    exact: true,
  });
}

test("Commands and Overview expose conversation management with exact targets", async () => {
  const first = await shell.create("Source command workspace");
  const chat = await shell.newChat(first, "codex");
  const second = await shell.create("Destination command workspace");
  const other = await shell.newChat(second, "codex");
  await shell.cli("conversation", "show", "--id", chat.id);
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
  await expect(overviewRow("conversation", chat.id)).toContainText(
    "Command renamed conversation",
  );
  await shell.page.keyboard.press("Escape");
  expect((await shell.state()).activeWorkspaceId).toBe(first);
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
  await overviewAction("conversation", chat.id, "Remove from workspace");
  await expect(overviewRow("conversation", chat.id)).toHaveCount(0);
  expect(
    (await shell.cli<AppState>("state")).conversations.some(
      (item) => item.id === other.id,
    ),
  ).toBe(true);
  await shell.cli("pane", "reopen", "--workspace", second);
  expect((await shell.inspect(chat.id)).nativeId).toBe(chat.nativeId);
  await overviewAction("workspace", first, "Close workspace");
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
  await shell.cli("conversation", "show", "--id", chat.id);
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
  await shell.cli("workspace", "focus", "--id", second);
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
