import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChatApp } from "./helpers/chat-fixture/harness";
import { modifier } from "./helpers/workspace-app";
import { ContextClient, toolPayload } from "../runtime-integration/harness";
import type { AppState } from "../../src/types";

async function pasteFixtureImage(app: ChatApp) {
  await app.app!.evaluate(async ({ clipboard, nativeImage, ClipboardItem }) => {
    const image = nativeImage.createFromBitmap(Buffer.alloc(8 * 8 * 4, 180), {
      width: 8,
      height: 8,
    });
    await clipboard.write([
      new ClipboardItem({
        "image/png": new Blob([new Uint8Array(image.toPNG())], {
          type: "image/png",
        }),
      }),
    ]);
  });
  await app.page.keyboard.press(`${modifier}+V`);
}

test("An agent moves its existing conversation during a turn without losing the user's draft or review", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  let context: ContextClient | undefined;
  const config = {
    moveFolder: app.folders[0],
    moveFile: app.file,
    moveName: "Report implementation",
    moveNow: false,
  };
  await app.configure({ codex: config });
  const state = () => app.cli<AppState>("state");
  try {
    await app.start();
    const initial = await state();
    expect(initial.workspaces).toHaveLength(1);
    expect(initial.conversations).toHaveLength(0);
    const source = initial.activeWorkspaceId!;
    const firstView = initial.workspaces[0].activePaneId;
    const composer = () => app.pane(firstView).locator(".composer textarea");
    await composer().fill(
      "Prepare a review, then create a workspace and move this same session there. [move-workspace]",
    );
    await composer().press(`${modifier}+Enter`);
    await expect
      .poll(async () =>
        (await app.records()).some((r) => r.event === "move-prepared"),
      )
      .toBe(true);
    const prepared = (await app.records()).find(
      (r) => r.event === "move-prepared",
    ) as unknown as {
      conversation: string;
      review: { paneId: string; reviewId: string };
    };
    const conversation = (await state()).conversations.find(
      (c) => c.id === prepared.conversation,
    )!;
    expect(conversation.paneId).toBe(firstView);
    const nativeId = conversation.nativeId;
    context = new ContextClient(app, source, conversation.id);
    await context.initialize();
    const before = toolPayload(
      await context.request("tools/call", {
        name: "cod_context",
        arguments: {},
      }),
    );
    expect(before.workspace).toMatchObject({ id: source });
    const review = app.pane(prepared.review.paneId);
    await review.locator(".review-line").first().focus();
    await app.page.keyboard.press(`${modifier}+Shift+M`);
    await review
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("Keep this private note through relocation.");
    await app.app!.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers.get("cod:invoke");
      ipcMain.removeHandler("cod:invoke");
      ipcMain.handle("cod:invoke", async (event, request) => {
        if (request.op === "review.comment-add")
          await new Promise((resolve) => setTimeout(resolve, 600));
        return original(event, request);
      });
    });
    await review
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    await composer().fill("The next request stays with this session.");
    await expect(
      review.getByLabel("Draft comment", { exact: true }),
    ).toContainText("Keep this private note through relocation.");
    await expect(composer()).toBeFocused();
    await pasteFixtureImage(app);
    await expect(
      app.pane(firstView).locator(".composer-images img"),
    ).toHaveCount(1);
    await expect
      .poll(
        async () =>
          (await state()).workspaces.find((w) => w.id === source)?.activePaneId,
      )
      .toBe(firstView);
    await app.configure({ codex: { ...config, moveNow: true } });
    await expect
      .poll(async () =>
        (await app.records()).some((r) => r.event === "conversation-moved"),
      )
      .toBe(true);
    const moved = (await app.records()).find(
      (r) => r.event === "conversation-moved",
    ) as unknown as { target: string };
    await expect
      .poll(async () => (await state()).activeWorkspaceId)
      .toBe(moved.target);
    await expect
      .poll(async () => (await app.inspect(conversation.id)).status)
      .toBe("ready");
    const current = await state();
    const target = current.workspaces.find((w) => w.id === moved.target)!;
    expect(current.conversations).toHaveLength(1);
    expect(current.conversations[0]).toMatchObject({
      id: conversation.id,
      nativeId,
      workspaceId: moved.target,
      paneId: firstView,
      cwd: conversation.cwd,
    });
    expect(target.panes.filter((p) => p.kind === "conversation")).toHaveLength(
      1,
    );
    expect(target.panes.some((p) => p.id === prepared.review.paneId)).toBe(
      true,
    );
    expect(target.panes.some((p) => p.kind === "document" && p.draftChat)).toBe(
      false,
    );
    expect(
      (await app.records()).filter((r) => r.event === "started"),
    ).toHaveLength(1);
    await expect(composer()).toHaveValue(
      "The next request stays with this session.",
    );
    await expect(
      app.pane(firstView).locator(".composer-images img"),
    ).toHaveCount(1);
    const after = toolPayload(
      await context.request("tools/call", {
        name: "cod_context",
        arguments: {},
      }),
    );
    expect(after.workspace).toMatchObject({
      id: moved.target,
      name: config.moveName,
    });
    expect(after.conversation).toMatchObject({
      id: conversation.id,
      nativeId,
      cwd: conversation.cwd,
    });
    await app.cli("review", "show", "--id", prepared.review.reviewId);
    await expect(
      app
        .pane(prepared.review.paneId)
        .getByLabel("Draft comment", { exact: true }),
    ).toContainText("Keep this private note through relocation.");
    await composer().focus();
    await composer().press(`${modifier}+Enter`);
    await expect.poll(async () => (await app.prompts()).length).toBe(2);
    await expect
      .poll(async () => (await app.inspect(conversation.id)).status)
      .toBe("ready");
    expect((await app.prompts()).at(-1)?.nativeId).toBe(nativeId);
    await expect(
      app.pane(firstView).getByRole("status", {
        name: "Conversation status",
        exact: true,
        includeHidden: true,
      }),
    ).toHaveText("");
    await expect(app.page.getByText(/Pane not found:/)).toHaveCount(0);
    await app.page.screenshot({
      path: info.outputPath("same-session-after-move.png"),
    });
    await context.cleanup();
    context = undefined;
    await app.stop();
    await app.start();
    expect((await state()).conversations).toHaveLength(1);
    expect((await state()).conversations[0]).toMatchObject({
      id: conversation.id,
      nativeId,
      workspaceId: moved.target,
    });
    await expect(app.pane(firstView)).toContainText("Turn continued.");
    await expect(
      app
        .pane(prepared.review.paneId)
        .getByLabel("Draft comment", { exact: true }),
    ).toContainText("Keep this private note through relocation.");
    await app.command("New workspace");
    await expect(app.page.getByRole("dialog")).toHaveCount(0);

    const unrelated = (await state()).activeWorkspaceId;
    const otherComposer = app.page.locator(".composer textarea");
    await otherComposer.fill("Do not disturb this other task.");
    await app.cli(
      "conversation",
      "move",
      "--id",
      conversation.id,
      "--workspace",
      source,
      "--follow",
      "false",
    );
    expect((await state()).activeWorkspaceId).toBe(unrelated);
    await expect(otherComposer).toHaveValue("Do not disturb this other task.");
    await expect(otherComposer).toBeFocused();
    expect((await state()).conversations[0]).toMatchObject({
      id: conversation.id,
      nativeId,
      workspaceId: source,
    });
  } finally {
    await context?.cleanup();
    await app.cleanup();
  }
});

test("Native session commands inspect without inference and invoke only the selected skill path", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  const skillPath = app.folders[0] + "/first/SKILL.md",
    duplicateSkillPath = app.folders[0] + "/second/SKILL.md";
  await app.configure({
    codex: { nativeInspection: true, skillPath, duplicateSkillPath },
  });
  try {
    await app.start();
    const composer = () => app.page.locator(".composer textarea");
    await composer().fill("/status");
    await composer().press(`${modifier}+Enter`);
    const status = app.page.getByRole("dialog", {
      name: "Session status",
      exact: true,
    });
    await expect(status).toContainText("12%");
    await expect(status).toContainText("34%");
    await expect(status.getByRole("textbox")).toHaveCount(0);
    expect(await app.prompts()).toHaveLength(0);
    const conversation = (await app.cli<AppState>("state")).conversations[0];
    await expect(status).toContainText(conversation.nativeId!);
    await status.locator("dd").first().click({ clickCount: 3 });
    await app.page.keyboard.press(`${modifier}+C`);
    const copied = await app.app!.evaluate(
      async ({ clipboard }) => await clipboard.readText(),
    );
    expect(copied.trim()).toBe(conversation.nativeId);
    expect(conversation.messages.filter((m) => m.role === "user")).toHaveLength(
      0,
    );
    const rejected = await app.raw(
      "conversation",
      "send",
      "--id",
      conversation.id,
      "--text",
      "/status",
    );
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("native-inspect");
    expect(await app.prompts()).toHaveLength(0);

    await app.page.screenshot({
      path: info.outputPath("native-status-no-inference.png"),
    });
    await status.getByRole("button", { name: "Done", exact: true }).click();
    await composer().fill("Retain this draft while I inspect the provider.");
    await pasteFixtureImage(app);
    const openSection = async (section: string) => {
      await app.page
        .locator(".composer")
        .click({ button: "right", position: { x: 5, y: 5 } });
      await app.page
        .getByRole("button", { name: "Session commands...", exact: true })
        .click();
      await app.page
        .getByRole("dialog")
        .getByRole("button", { name: `/${section}`, exact: true })
        .click();
      return app.page.getByRole("dialog", {
        name: `Session ${section}`,
        exact: true,
      });
    };
    const config = await openSection("config");
    await expect(config).toContainText("fixture-model");
    await expect(config).not.toContainText(
      /MUST_NOT_RENDER|model_reasoning_effort|sandbox_mode/,
    );
    await expect(config.getByRole("textbox")).toHaveCount(0);
    await app.page.screenshot({
      path: info.outputPath("native-readonly-settings.png"),
    });
    await config.getByRole("button", { name: "Done", exact: true }).click();
    const plugins = await openSection("plugins");
    await expect(plugins).toContainText("Invented plugin");
    await app.page.screenshot({
      path: info.outputPath("native-readonly-plugins.png"),
    });
    await expect(
      plugins.getByRole("button", { name: /Invented plugin/ }),
    ).toHaveCount(0);
    await plugins.getByRole("button", { name: "Done", exact: true }).click();
    const agents = await openSection("agents");
    await expect(agents).toContainText("Invented reviewer");
    await expect(agents).not.toContainText("MUST_NOT_RENDER_FOREIGN");
    await agents.getByRole("button", { name: "Done", exact: true }).click();
    expect(await app.prompts()).toHaveLength(0);
    await app.configure({ codex: { nativeInspection: false } });
    const unavailable = await openSection("skills");
    await expect(unavailable).toContainText("inspection unavailable");
    await app.page.screenshot({
      path: info.outputPath("native-inspection-unavailable.png"),
    });
    await app.page.keyboard.press("Escape");
    await expect(composer()).toHaveValue(
      "Retain this draft while I inspect the provider.",
    );
    await expect(app.page.locator(".composer-images img")).toHaveCount(1);
    await app.configure({
      codex: { nativeInspection: true, skillPath, duplicateSkillPath },
    });
    const skills = await openSection("skills");
    await expect(skills).toContainText(duplicateSkillPath);
    await app.page.screenshot({
      path: info.outputPath("native-skills-disambiguated.png"),
    });
    await skills
      .getByRole("button")
      .filter({ hasText: duplicateSkillPath })
      .click();
    await expect(composer()).toBeFocused();
    await expect(composer()).toHaveValue(/Retain this draft/);
    await expect(composer()).toHaveValue(/\$fixture-review/);
    await expect(app.page.locator(".composer-images img")).toHaveCount(1);
    expect(await app.prompts()).toHaveLength(0);
    await app.stop();
    await app.start();
    await expect(composer()).toHaveValue(/Retain this draft/);
    await expect(app.page.locator(".composer-images img")).toHaveCount(1);
    await composer().press(`${modifier}+Enter`);
    await expect.poll(async () => (await app.prompts()).length).toBe(1);
    await expect
      .poll(async () => (await app.inspect(conversation.id)).status)
      .toBe("ready");
    const input = (await app.prompts())[0].message?.params?.input as Array<{
      type: string;
      name?: string;
      path?: string;
    }>;
    expect(input.filter((part) => part.type === "skill")).toEqual([
      { type: "skill", name: "fixture-review", path: duplicateSkillPath },
    ]);
    expect(
      (await app.records())
        .filter((r) => r.message?.method?.includes("config/"))
        .map((r) => r.message?.method),
    ).toEqual(["config/read"]);
  } finally {
    await app.cleanup();
  }
});

test("Fresh workspace exposes both pane controls and opens material without duplicating its chat", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  try {
    await app.start();
    const initial = await app.cli<AppState>("state");
    const workspace = initial.workspaces[0];
    const draft = workspace.activePaneId;
    const left = app.page.getByRole("button", {
      name: "Show left pane",
      exact: true,
    });
    const right = app.page.getByRole("button", {
      name: "Hide right pane",
      exact: true,
    });
    await expect(left).toBeVisible();
    await expect(left).toBeEnabled();
    await expect(right).toBeVisible();
    await expect(right).toBeDisabled();
    await expect(right).toHaveAttribute(
      "title",
      "At least one pane must remain open",
    );
    await expect(app.page.locator(".composer textarea")).toHaveCount(1);
    await app.page
      .locator(".composer textarea")
      .fill("Keep the only conversation draft.");
    await app.page.screenshot({
      path: info.outputPath("fresh-visible-pane-controls.png"),
    });
    await left.click();
    await expect(
      app.page.getByRole("button", { name: "Hide left pane", exact: true }),
    ).toBeVisible();
    await expect(app.page.locator(".composer textarea")).toHaveCount(1);
    expect((await app.cli<AppState>("state")).conversations).toHaveLength(0);
    await expect(app.pane(draft).locator(".composer textarea")).toHaveValue(
      "Keep the only conversation draft.",
    );
    await right.click();
    await expect(app.pane(draft)).toBeHidden();
    await expect(
      app.page.getByRole("button", { name: "Hide left pane", exact: true }),
    ).toBeDisabled();
    await app.stop();
    await app.start();
    await expect(app.pane(draft)).toBeHidden();
    await app.page
      .getByRole("button", { name: "Show right pane", exact: true })
      .click();
    await expect(app.pane(draft).locator(".composer textarea")).toHaveValue(
      "Keep the only conversation draft.",
    );
    await expect(app.page.locator(".composer textarea")).toHaveCount(1);
    await app.page.screenshot({
      path: info.outputPath("empty-material-restored-chat.png"),
    });
  } finally {
    await app.cleanup();
  }
});

test("Completed turns fold commentary and tools while final answers and decisions remain visible", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  await app.configure({
    codex: {
      extraTools: 3,
      interactiveQuestion: true,
      finalDelayMs: 2000,
      options: true,
      reasoningOptions: true,
      narrative:
        "I checked how report exports are assembled. The API already applies account permissions before selecting rows, so the export should reuse that query rather than create a second filtering path.\n\nThe remaining decision is the size limit. I suggest keeping the first version synchronous for small reports and returning a useful error when the result is too large. The existing browser page can keep its filters while the request runs.\n\nI will add coverage for an empty report, quoted CSV values and a request from an account that cannot access the report. After that I will inspect the diff before asking you to review the document.",
    },
  });
  try {
    await app.start();
    const composer = app.page.locator(".composer textarea");
    await composer.fill("Search and inspect the invented files.");
    await composer.press(`${modifier}+Enter`);
    await expect(
      app.page.getByText("STREAM Search and inspect the invented files.", {
        exact: true,
      }),
    ).toBeAttached();
    const working = app.page.getByRole("status", { name: "Turn activity" });
    await expect(working).toHaveText(/Working · \d+s/);
    const liveActivity = app.page.locator("details.turn-activity").first();
    await expect(liveActivity.locator(".current-tool")).toHaveText("Run echo");
    await expect(liveActivity.locator(".tool-activity")).toHaveCount(4);
    await expect(liveActivity.locator(".tool-activity").last()).toHaveAttribute(
      "data-tool-phase",
      "completed",
    );
    expect(await working.evaluate((node) => !!node.closest("summary"))).toBe(
      false,
    );
    await expect(liveActivity.locator(".assistant").first()).toBeHidden();
    await liveActivity.locator(":scope > summary").click();
    await expect(liveActivity.locator(".assistant").first()).toBeVisible();
    await expect(working).toHaveText(/Working · [1-9]\d*s/);
    await expect(liveActivity).toHaveAttribute("open", "");
    await liveActivity.locator(":scope > summary").click();
    await expect(app.page.locator(".transcript > .tool-activity")).toHaveCount(
      0,
    );
    await expect(app.page.locator(".transcript > .turn-activity")).toHaveCount(
      1,
    );
    await expect(
      app.page.locator(".chat-body > .conversation-status"),
    ).toBeHidden();
    await app.page.screenshot({
      path: info.outputPath("working-in-turn-activity.png"),
    });
    const liveState = await app.cli<AppState>("state");
    const conversationId = liveState.conversations[0].id;
    await expect(app.page.locator(".turn-activity")).toHaveCount(1);
    const first = app.page.locator(".turn-activity").first();
    await expect(first.locator(":scope > summary")).toHaveAttribute(
      "aria-label",
      /Worked for \d+s/,
    );
    await expect(working).toHaveCount(0);
    await expect(
      app.page.getByText("DONE Search and inspect the invented files.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(await first.getAttribute("open")).toBeNull();
    const question = app.page.getByText(
      "Should the report include archived rows?",
      { exact: true },
    );
    await expect(question).toBeVisible();
    expect(
      await question.evaluate((node) => !!node.closest(".turn-activity")),
    ).toBe(false);
    await app.page.screenshot({
      path: info.outputPath("populated-collapsed-turn.png"),
    });
    await expect(first.locator(".assistant").first()).toContainText(
      "I checked how report exports are assembled",
    );
    await expect(
      app.page.getByText("STREAM Search and inspect the invented files.", {
        exact: true,
      }),
    ).toBeHidden();
    const reasoning = app.page.getByRole("button", {
      name: "Reasoning effort",
      exact: true,
    });
    await reasoning.click();
    const choices = app.page.getByRole("dialog", { name: "Actions" });
    await expect(
      choices.getByRole("button", { name: "Medium", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await choices.getByRole("button", { name: "Low", exact: true }).click();
    await expect(reasoning).toHaveText("Low");
    await expect(composer).toHaveCSS("resize", "none");
    await app.app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 800),
    );
    await app.page.screenshot({
      path: info.outputPath("narrow-populated-composer.png"),
    });
    await app.app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
    );

    await first.locator(":scope > summary").click();
    await expect(first.locator(".tool-activity")).toHaveCount(4);
    await first
      .locator(".tool-activity")
      .filter({ hasText: "invented-extra-0" })
      .locator("summary")
      .click();
    await expect(first).toContainText("Fixture detail 0");
    await app.page.screenshot({
      path: info.outputPath("completed-expanded-commentary-tools.png"),
    });
    await composer.fill("Ask before the next command. [approve]");
    await composer.press(`${modifier}+Enter`);
    await expect(
      app.page.getByRole("button", { name: /Allow once/ }),
    ).toBeVisible();
    await expect(working).toHaveText("Waiting for your response");
    await expect(
      app.page.locator(".chat-body > .conversation-status"),
    ).toBeHidden();
    await expect(first).toHaveAttribute("open", "");
    expect(
      await app.page
        .getByRole("button", { name: /Allow once/ })
        .evaluate((node) => Boolean(node.closest(".turn-activity"))),
    ).toBe(false);
    await app.page.screenshot({
      path: info.outputPath("grouped-tools-visible-permission.png"),
    });
    // An actual waiting interval must not become agent working time.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await app.page.getByRole("button", { name: /Allow once/ }).click();
    await expect(
      app.page.getByText(/ALLOWED Ask before the next command/),
    ).toBeVisible();
    await expect
      .poll(async () => (await app.inspect(conversationId)).status)
      .toBe("ready");
    const afterApproval = await app.cli<
      import("../../src/types").ConversationState
    >("conversation", "inspect", "--id", conversationId);
    const approvalTurn = afterApproval.turns!.at(-1)!;
    expect(approvalTurn.outcome).toBe("completed");
    expect(
      approvalTurn.elapsedMs! - approvalTurn.durationMs!,
    ).toBeGreaterThanOrEqual(150);
    await app.configure({ codex: { extraTools: 1, failExtraTool: true } });
    await composer.fill("Show a recoverable tool failure.");
    await composer.press(`${modifier}+Enter`);
    const failure = app.page
      .locator(".tool-activity")
      .filter({ hasText: "Invented tool failed" });
    await expect
      .poll(async () => (await app.inspect(conversationId)).status)
      .toBe("ready");
    await expect(failure.locator(":scope > summary")).toContainText("failed");
    await expect(failure).not.toHaveAttribute("data-action-required", "true");
    const failedTurn = app.page
      .locator("details.turn-activity")
      .filter({ has: failure });
    await expect(failedTurn).toHaveCount(1);
    await expect(failure).toBeHidden();
    await failedTurn.scrollIntoViewIfNeeded();
    await app.page.screenshot({
      path: info.outputPath("completed-tool-error-collapsed.png"),
    });
    await failedTurn.locator(":scope > summary").click();
    await expect(failure).toBeVisible();
    await failure.locator(":scope > summary").click();
    await expect(failure.locator("pre")).toContainText("Invented tool failed");
    await app.send(conversationId, "[hold] Cancel this observed turn");
    await expect
      .poll(async () => (await app.inspect(conversationId)).status)
      .toBe("working");
    const runningTurn = app.page.locator("details.turn-activity").last();
    await expect(runningTurn.locator(".current-tool")).toHaveText("Run echo");
    await expect(runningTurn.locator(".tool-activity").first()).toBeHidden();
    await runningTurn.scrollIntoViewIfNeeded();
    await app.page.screenshot({
      path: info.outputPath("live-current-action.png"),
    });
    await runningTurn.locator(":scope > summary").click();
    await expect(runningTurn.locator(".tool-activity").first()).toBeVisible();
    await app.page.screenshot({
      path: info.outputPath("live-expanded-actions.png"),
    });

    await app.page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect
      .poll(async () => (await app.inspect(conversationId)).status)
      .toBe("ready");
    let observed = await app.cli<import("../../src/types").ConversationState>(
      "conversation",
      "inspect",
      "--id",
      conversationId,
    );
    expect(observed.turns!.at(-1)!.outcome).toBe("cancelled");
    const stopped = app.page
      .locator(".turn-activity")
      .filter({ hasText: /Stopped after/ })
      .last();
    await expect(stopped).toBeVisible();
    await expect(stopped).toHaveAttribute("open", "");
    await stopped.scrollIntoViewIfNeeded();
    await app.page.screenshot({
      path: info.outputPath("cancelled-turn-duration.png"),
    });
    await app.send(conversationId, "[crash]");
    await expect
      .poll(async () => (await app.inspect(conversationId)).status)
      .toBe("failed");
    observed = await app.cli<import("../../src/types").ConversationState>(
      "conversation",
      "inspect",
      "--id",
      conversationId,
    );
    expect(observed.turns!.at(-1)!.outcome).toBe("failed");
    const knownTurns = observed.turns;
    await app.stop();
    await app.start();
    expect(
      (
        await app.cli<import("../../src/types").ConversationState>(
          "conversation",
          "inspect",
          "--id",
          conversationId,
        )
      ).turns,
    ).toEqual(knownTurns);
  } finally {
    await app.cleanup();
  }
});

test("Navigation disclosures and installation forms share compact geometry without a code wall", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  const profile = path.join(app.temporary, "isolated-provider-profile");
  await mkdir(profile);
  app.environment.CODEX_HOME = profile;
  try {
    await app.start();
    const workspace = (await app.cli<AppState>("state")).workspaces[0];
    await app.app!.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [folder],
      })) as typeof dialog.showOpenDialog;
    }, app.folders[0]);
    await app.command("Add folder");
    await app.page
      .getByRole("button", { name: "Toggle files", exact: true })
      .click();
    const fileRoot = app.page
      .getByRole("tree", { name: "File tree", exact: true })
      .getByRole("treeitem", { name: "alpha repo", exact: true });
    const workspaceRow = app.row(workspace.name).first();
    const size = async (node: typeof fileRoot) =>
      node.locator(".tree-disclosure").evaluate((el) => ({
        w: el.getBoundingClientRect().width,
        h: el.getBoundingClientRect().height,
        offset:
          el.getBoundingClientRect().y -
          el.parentElement!.getBoundingClientRect().y,
      }));
    await expect(fileRoot).toBeVisible();
    expect(await size(fileRoot)).toEqual(await size(workspaceRow));
    await fileRoot.focus();
    await fileRoot.press("ArrowLeft");
    await expect(fileRoot).toHaveAttribute("aria-expanded", "false");
    await fileRoot.press("ArrowRight");
    await expect(fileRoot).toHaveAttribute("aria-expanded", "true");
    await app.page.screenshot({
      path: info.outputPath("aligned-navigation-disclosures.png"),
    });
    await app.command("Rename workspace");
    const rename = app.page.getByRole("textbox", {
      name: "Workspace name",
      exact: true,
    });
    const fieldStyle = await rename.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      radius: getComputedStyle(el).borderRadius,
      padding: getComputedStyle(el).padding,
    }));
    await app.page.screenshot({
      path: info.outputPath("shared-rename-form.png"),
    });
    await app.page.keyboard.press("Escape");
    await app.command("Install agent integration...");
    const dialog = app.page.getByRole("dialog");
    const directory = dialog.getByRole("textbox", {
      name: "Agent profile directory",
      exact: true,
    });
    await directory.fill(profile);
    expect(
      await directory.evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        radius: getComputedStyle(el).borderRadius,
        padding: getComputedStyle(el).padding,
      })),
    ).toEqual(fieldStyle);
    await dialog
      .getByRole("button", { name: "Preview changes", exact: true })
      .click();
    await expect(dialog).toContainText(
      "Existing unrelated settings are preserved",
    );
    await expect(dialog.locator("pre:visible")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Install integration", exact: true }),
    ).toBeInViewport();
    await app.page.screenshot({
      path: info.outputPath("integration-semantic-preview.png"),
    });
    await dialog.locator(".integration-changes > summary").click();
    await dialog
      .locator(".integration-changes details > summary")
      .first()
      .click();
    await expect(dialog.locator("pre:visible").first()).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Install integration", exact: true }),
    ).toBeInViewport();
    await app.page.screenshot({
      path: info.outputPath("integration-optional-details.png"),
    });
  } finally {
    await app.cleanup();
  }
});

test("Skills are discoverable from the first empty composer without a model turn", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  await app.configure({
    codex: { nativeInspection: true, skillPath: app.folders[0] + "/SKILL.md" },
  });
  try {
    await app.start();
    expect((await app.cli<AppState>("state")).conversations).toHaveLength(0);
    const composer = app.page.locator(".composer textarea");
    await composer.fill("/skills");
    await composer.press(`${modifier}+Enter`);
    const skills = app.page.getByRole("dialog", {
      name: "Session skills",
      exact: true,
    });
    await expect(skills).toContainText("fixture-review");
    expect(await app.prompts()).toHaveLength(0);
    const conversations = (await app.cli<AppState>("state")).conversations;
    expect(conversations).toHaveLength(1);
    expect(
      conversations[0].messages.filter((m) => m.role === "user"),
    ).toHaveLength(0);
    await app.page.screenshot({
      path: info.outputPath("first-use-native-skills.png"),
    });
    await app.page.keyboard.press("Escape");
    await expect(composer).toBeFocused();
    expect(await app.prompts()).toHaveLength(0);
  } finally {
    await app.cleanup();
  }
});

test("Imported native history does not invent duration and final-only live replies need no disclosure", async ({}, info) => {
  const app = new ChatApp();
  await app.prepare();
  const nativeId = "codex-invented-import";
  await mkdir(app.recording + ".sessions", { recursive: true });
  await writeFile(
    path.join(app.recording + ".sessions", nativeId + ".json"),
    JSON.stringify([
      {
        id: "old-native-turn",
        status: "completed",
        items: [
          {
            id: "old-user",
            type: "userMessage",
            content: [{ type: "text", text: "Imported task" }],
          },
          {
            id: "old-comment",
            type: "agentMessage",
            phase: "commentary",
            text: "I inspected the old fixture files.",
          },
          {
            id: "old-tool",
            type: "commandExecution",
            command: "echo old-fixture",
            status: "completed",
            aggregatedOutput: "Old fixture output",
          },
          {
            id: "old-final",
            type: "agentMessage",
            phase: "final_answer",
            text: "Imported final answer.",
          },
        ],
      },
    ]),
  );
  try {
    await app.start();
    const workspace = await app.create("Imported history");
    const chat = await app.cli<{ id: string; paneId: string }>(
      "conversation",
      "resume",
      "--workspace",
      workspace,
      "--provider",
      "codex",
      "--cwd",
      app.folders[0],
      "--native-id",
      nativeId,
    );
    const pane = app.pane(chat.paneId),
      activity = pane.locator("details.turn-activity");
    await expect(activity.locator(":scope > summary")).toHaveText("Activity");
    await expect(
      pane.getByText("Imported final answer.", { exact: true }),
    ).toBeVisible();
    await expect(
      pane.getByText("I inspected the old fixture files.", { exact: true }),
    ).toBeHidden();
    expect(
      (
        await app.cli<import("../../src/types").ConversationState>(
          "conversation",
          "inspect",
          "--id",
          chat.id,
        )
      ).turns ?? [],
    ).toHaveLength(0);
    await app.page.screenshot({
      path: info.outputPath("imported-history-unknown-duration.png"),
    });
    await app.configure({ codex: { finalOnly: true } });
    await app.send(chat.id, "A brief final-only answer");
    await expect(
      pane.getByText("DONE A brief final-only answer", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => (await app.inspect(chat.id)).status)
      .toBe("ready");
    await expect(pane.locator("div.turn-activity")).toHaveText(/Worked for/);
    await expect(pane.locator("details.turn-activity")).toHaveCount(1);
    await app.page.screenshot({
      path: info.outputPath("final-only-turn-duration.png"),
    });
  } finally {
    await app.cleanup();
  }
});
