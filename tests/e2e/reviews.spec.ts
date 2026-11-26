import { test, expect, type Locator } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { mkdir, writeFile, realpath, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ChatApp, type Provider } from "./helpers/chat-fixture/harness";
import { tabTo, modifier } from "./helpers/workspace-app";
import type { AppState, ConversationState } from "../../src/types";
import { LocalProviderOwner } from "../../src/providers/local-owner-client";
interface Opened {
  reviewId: string;
  roundId: string;
  snapshotId: string;
  paneId: string;
  version: number;
}
interface Submission {
  id: string;
  envelope: string;
  delivery: { status: "queued" | "dispatching" | "acknowledged" | "uncertain" };
}
interface Summary {
  id?: string;
  reviewId?: string;
  currentRoundId: string;
  version: number;
  rounds: Array<{
    id: string;
    status: string;
    commentCount: number;
    outdatedCount: number;
    submission?: Submission;
  }>;
}
let shell: ChatApp;
const children = new Set<ChildProcess>();
test.beforeEach(async () => {
  shell = new ChatApp();
  await shell.prepare();
  for (const provider of ["codex", "kimi"])
    shell.environment[`COD_${provider.toUpperCase()}_ARGS`] = JSON.stringify([
      path.join(shell.root, "tests/review-integration/provider-wrapper.mjs"),
      provider,
      shell.recording,
    ]);
  await writeFile(shell.file, "first line\nselected review line\nlast line\n");
  await shell.start();
});
test.afterEach(async () => {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  children.clear();
  await shell?.cleanup();
});
const pane = (review: Opened) => shell.pane(review.paneId);
const source = (review: Opened) =>
  pane(review).getByRole("textbox", { name: "Review source", exact: true });
const inspect = (review: Opened) =>
  shell.cli<Summary>("review", "inspect", "--id", review.reviewId);
async function open(workspace: string, file = shell.file) {
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    path.dirname(file),
  );
  const existing = await shell.cli<{
    conversations: Array<{ id: string; workspaceId: string }>;
  }>("state");
  const origin =
    existing.conversations.find((chat) => chat.workspaceId === workspace)?.id ??
    (await shell.newChat(workspace, "codex")).id;
  return shell.cli<Opened>(
    "review",
    "open-document",
    "--workspace",
    workspace,
    "--path",
    file,
    "--conversation",
    origin,
  );
}
async function comment(
  review: Opened,
  body: string,
  target: Locator = source(review),
) {
  if (
    await target.evaluate((node) =>
      node.classList.contains("review-source-editor"),
    )
  ) {
    await tabTo(shell.page, target);
    await target.press(`${modifier}+Home`);
    await target.press("ArrowDown");
    await target.press("Home");
  } else {
    const index = await target.evaluate((node) =>
      [...node.parentElement!.querySelectorAll(".review-line")].indexOf(node),
    );
    await tabTo(
      shell.page,
      target.locator("..").locator('.review-line[tabindex="0"]'),
    );
    await shell.page.keyboard.press("Home");
    for (let step = 0; step < index; step++)
      await shell.page.keyboard.press("ArrowDown");
    await expect(target).toBeFocused();
  }
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  await expect(
    pane(review).getByRole("textbox", { name: "Comment", exact: true }),
  ).toBeFocused();
  await shell.page.keyboard.type(body);
  await tabTo(
    shell.page,
    pane(review).getByRole("button", { name: "Save comment", exact: true }),
  );
  await shell.page.keyboard.press("Enter");
  await expect(
    pane(review).getByLabel("Draft comment", { exact: true }),
  ).toContainText(body);
  await expect(target).toBeFocused();
}
async function socketRequest(request: Record<string, unknown>) {
  return new Promise<{ ok: boolean; result?: unknown; error?: string }>(
    (resolve, reject) => {
      const socket = createConnection(shell.socket);
      let text = "";
      socket.setEncoding("utf8");
      socket.setTimeout(3000, () =>
        socket.destroy(new Error("Socket timeout")),
      );
      socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
      socket.on("data", (chunk) => {
        text += chunk;
        if (text.includes("\n")) {
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          } finally {
            socket.destroy();
          }
        }
      });
      socket.on("error", reject);
    },
  );
}
async function submit(
  review: Opened,
  conversationId: string,
  requestId = randomUUID(),
  roundId = review.roundId,
) {
  return shell.cli<Submission>(
    "review",
    "submit",
    "--id",
    review.reviewId,
    "--round",
    roundId,
    "--conversation",
    conversationId,
    "--request-id",
    requestId,
  );
}
const feedbackPrompts = async (id: string) =>
  (await shell.prompts()).filter((record) =>
    JSON.stringify(record.message?.params).includes(id),
  );
test("Detached review delivery leaves the live native turn open on desktop quit", async () => {
  const owner = new LocalProviderOwner(shell.data);
  try {
    await shell.cli(
      "settings",
      "update",
      "--values",
      '{"chat.detachedSessions":true}',
    );
    const workspace = await shell.create("Detached review fixture");
    const chat = await shell.newChat(workspace, "codex");
    const review = await open(workspace);
    await comment(review, "[hold] invented detached review");
    const submission = await submit(review, chat.id);
    await expect
      .poll(async () => (await shell.inspect(chat.id)).status)
      .toBe("working");
    await expect
      .poll(async () => (await feedbackPrompts(submission.id)).length)
      .toBe(1);
    const chatState = () =>
      shell.cli<ConversationState>("conversation", "inspect", "--id", chat.id);
    const turn = (await chatState()).turns!.at(-1)!;
    await shell.quitWithChoice("Leave Running");
    await shell.start();

    const resumed = await chatState();
    expect(resumed.nativeId).toBe(chat.nativeId);
    expect(resumed.status).toBe("working");
    expect(resumed.turns!.at(-1)!.id).toBe(turn.id);
    expect(resumed.turns!.at(-1)!.finishedAt).toBeUndefined();
    expect((await inspect(review)).rounds[0].submission?.delivery.status).toBe(
      "uncertain",
    );
    expect(await feedbackPrompts(submission.id)).toHaveLength(1);
    await shell.cli("conversation", "interrupt", "--id", chat.id);
    await expect
      .poll(async () => (await chatState()).turns!.at(-1)!.outcome)
      .toBe("cancelled");
  } finally {
    await owner.stop();
  }
});

function waitProcess(review: Opened, roundId: string, timeoutMs = 4000) {
  const child = spawn(
    process.execPath,
    [
      path.join(shell.root, "dist/cli.cjs"),
      "review",
      "wait",
      "--id",
      review.reviewId,
      "--round",
      roundId,
      "--timeout-ms",
      String(timeoutMs),
    ],
    {
      env: shell.environment,
      cwd: shell.root,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  let stdout = "",
    stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk));
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const result = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
  return { child, result };
}

test("Review AC1 keyboard drafts are private on every socket surface and survive real app restart", async () => {
  const workspace = await shell.create("Private review");
  const review = await open(workspace);
  const body = "PRIVATE_REVIEW_DRAFT";
  await comment(review, body);
  expect(JSON.stringify(await inspect(review))).not.toContain(body);
  expect(JSON.stringify(await shell.cli("state"))).not.toContain(body);
  expect(JSON.stringify(await shell.cli("capabilities"))).not.toContain(body);
  expect(await shell.prompts()).toHaveLength(0);
  for (const op of [
    "review.detail",
    "review.comment-add",
    "review.comment-edit",
    "review.comment-delete",
    "review.comment-reanchor",
  ]) {
    const reply = await socketRequest({
      op,
      id: review.reviewId,
      roundId: review.roundId,
      expectedVersion: (await inspect(review)).version,
      body: "unauthorized",
      range: { startLine: 1, endLine: 1 },
    });
    expect(reply.ok).toBe(false);
    expect(JSON.stringify(reply)).not.toContain(body);
  }
  await writeFile(shell.file, "disk changed after snapshot\n");
  await shell.stop();
  await shell.start();
  await expect(
    pane(review).getByLabel("Draft comment", { exact: true }),
  ).toContainText(body);
  await expect(
    pane(review).getByRole("region", { name: "Review content", exact: true }),
  ).toContainText("selected review line");
  expect((await inspect(review)).rounds[0].commentCount).toBe(1);
  expect(JSON.stringify(await inspect(review))).not.toContain(body);
});

test("Review comment Mod+Enter saves a private multiline draft even with a conflicting submit binding", async () => {
  await shell.stop();
  await writeFile(
    path.join(shell.data, "keymap.json"),
    JSON.stringify({ "chat.send": null, "review.submit": ["Mod+Enter"] }),
  );
  await shell.start();
  const keymap = await shell.page.evaluate(() => window.cod.getKeymap());
  expect(keymap.error).toBeUndefined();
  expect(keymap.overrides["review.submit"]).toEqual(["Mod+Enter"]);

  const review = await open(await shell.create("Invented keyboard review"));
  const editor = source(review);
  await editor.focus();
  await editor.press("ArrowDown");
  await editor.press(`${modifier}+Shift+M`);
  const host = pane(review);
  const input = host.getByRole("textbox", { name: "Comment", exact: true });
  await expect(input).toBeFocused();
  const save = host.getByRole("button", { name: "Save comment", exact: true });
  await expect(save).toHaveAttribute(
    "aria-keyshortcuts",
    process.platform === "darwin" ? "Meta+Enter" : "Control+Enter",
  );
  await input.fill("First point");
  await input.press("Enter");
  await input.pressSequentially("Second point");
  await input.press("Shift+Enter");
  await input.pressSequentially("Third point");
  await expect(input).toHaveValue("First point\nSecond point\nThird point");
  const chord = {
    key: "Enter",
    code: "Enter",
    ctrlKey: process.platform !== "darwin",
    metaKey: process.platform === "darwin",
  };
  await input.dispatchEvent("keydown", { ...chord, isComposing: true });
  await input.dispatchEvent("keydown", { ...chord, repeat: true });
  await expect(input).toBeFocused();
  expect((await inspect(review)).rounds[0].commentCount).toBe(0);

  await input.press(`${modifier}+Enter`);
  await expect(input).toBeHidden();
  await expect(host.getByLabel("Draft comment", { exact: true })).toContainText(
    /First point\s+Second point\s+Third point/,
  );
  await expect(editor).toBeFocused();
  expect((await inspect(review)).rounds[0]).toMatchObject({
    status: "draft",
    commentCount: 1,
  });
  expect((await inspect(review)).rounds[0].submission).toBeUndefined();
  expect(await shell.prompts()).toHaveLength(0);

  await editor.press(`${modifier}+Enter`);
  await expect
    .poll(async () => (await inspect(review)).rounds[0].submission?.id)
    .toBeTruthy();
});

test("Review AC2 separate real repositories retain old/new diff anchors and private comments", async ({}, testInfo) => {
  const workspace = await shell.create("Two repository reviews");
  const origin = await shell.newChat(workspace, "codex");
  const opened: Opened[] = [];
  for (const [index, folder] of shell.folders.entries()) {
    await shell.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      folder,
    );
    const file = path.join(folder, "same ü file.txt");
    await writeFile(file, `old repository ${index}\n`);
    const secondFile = path.join(folder, "other.txt");
    await writeFile(secondFile, "old second file\n");
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    execFileSync("git", ["add", "--all"], { cwd: folder, env });
    execFileSync("git", ["commit", "-m", "review fixture"], {
      cwd: folder,
      env,
      stdio: "pipe",
    });
    await writeFile(file, `new repository ${index}\n`);
    await writeFile(secondFile, "new second file\n");
    const canonicalFile = await realpath(file);
    const review = await shell.cli<Opened>(
      "review",
      "open-diff",
      "--workspace",
      workspace,
      "--repo-root",
      folder,
      "--conversation",
      origin.id,
    );
    opened.push(review);
    const headings = pane(review).getByRole("heading", { level: 3 });
    const tree = shell.page.getByRole("tree", { name: "Review files" });
    await expect(headings).toHaveCount(1);
    await tree
      .getByRole("treeitem", { name: "other.txt", exact: true })
      .click();
    await expect(
      headings.filter({ hasText: "other.txt" }),
    ).toHaveAccessibleDescription(await realpath(secondFile));
    await tree
      .getByRole("treeitem", { name: "same ü file.txt", exact: true })
      .click();
    await expect(
      headings.filter({ hasText: "same ü file.txt" }),
    ).toHaveAccessibleDescription(canonicalFile);
    if (index === 0)
      await pane(review).screenshot({
        path: testInfo.outputPath("review-two-file-diff.png"),
      });
    await comment(
      review,
      `PRIVATE_REPO_${index}`,
      pane(review).getByRole("button", {
        name: `Old line 1 ${canonicalFile}`,
        exact: true,
      }),
    );
    await expect(
      pane(review).getByRole("button", {
        name: `New line 1 ${canonicalFile}`,
        exact: true,
      }),
    ).toBeVisible();
    if (index === 0) {
      await pane(review)
        .getByRole("button", {
          name: `New line 1 ${canonicalFile}`,
          exact: true,
        })
        .scrollIntoViewIfNeeded();
      await pane(review).screenshot({
        path: testInfo.outputPath("review-two-file-diff-comment.png"),
      });
    }
    expect(JSON.stringify(await inspect(review))).not.toContain(
      `PRIVATE_REPO_${index}`,
    );
  }
  expect(opened[0].reviewId).not.toBe(opened[1].reviewId);
  for (const [index, review] of opened.entries())
    expect((await inspect(review)).rounds[0].commentCount).toBe(1);
  await shell.stop();
  await shell.start();
  for (const [index, review] of opened.entries()) {
    await shell.cli("review", "show", "--id", review.reviewId);
    await expect(
      pane(review).getByLabel("Draft comment", { exact: true }),
    ).toContainText(`PRIVATE_REPO_${index}`);
  }
});

test("Review AC3 refreshed rounds preserve outdated private anchors and compare saved untracked document revisions", async () => {
  const workspace = await shell.create("Iterative specification");
  const review = await open(workspace);
  await comment(review, "Keep this original anchor");
  await writeFile(
    shell.file,
    "inserted revision line\nfirst line\nselected review line\nlast line\n",
  );
  await pane(review)
    .getByRole("button", { name: "Review actions", exact: true })
    .click();
  await shell.page
    .getByRole("button", { name: "Refresh round", exact: true })
    .click();
  const current = await inspect(review);
  expect(current.currentRoundId).not.toBe(review.roundId);
  expect(current.rounds).toHaveLength(2);
  expect(current.rounds[1].outdatedCount).toBe(1);
  await expect(
    pane(review).getByLabel("Draft comment", { exact: true }),
  ).toContainText(/outdated/i);
  await pane(review)
    .getByRole("button", { name: "Review actions", exact: true })
    .click();
  await shell.page
    .getByRole("button", {
      name: "Changes since previous round",
      exact: true,
    })
    .click();
  const changes = pane(review).getByRole("region", {
    name: "Document changes",
    exact: true,
  });
  await expect(changes).toContainText("inserted revision line");
  await pane(review)
    .getByRole("combobox", { name: "Round", exact: true })
    .selectOption(review.roundId);
  await expect(
    pane(review).getByRole("region", { name: "Review content", exact: true }),
  ).not.toContainText("inserted revision line");
  await expect(
    pane(review).getByLabel("Draft comment", { exact: true }),
  ).toContainText("Keep this original anchor");
  expect(JSON.stringify(await inspect(review))).not.toContain(
    "Keep this original anchor",
  );
});

for (const provider of ["codex", "kimi"] as Provider[])
  test(`Review AC4 ${provider} origin-bound submission publishes frozen feedback once with stable identity`, async ({}, info) => {
    const workspace = await shell.create(`${provider} review destination`);
    const selected = await shell.newChat(workspace, provider);
    const decoy = await shell.newChat(workspace, provider);
    const review = await open(workspace);
    const body = `Feedback for ${provider}`;
    await comment(review, body);
    const destination = pane(review).getByRole("combobox", {
      name: "Destination conversation",
      exact: true,
    });
    await expect(destination).toHaveCount(0);
    await shell.page.screenshot({
      path: info.outputPath(`${provider}-private-origin-review.png`),
    });
    await pane(review)
      .getByRole("button", { name: "Send feedback", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await inspect(review)).rounds[0].submission?.delivery.status,
      )
      .toBe("acknowledged");
    const submission = (await inspect(review)).rounds[0].submission!;
    await shell.page.screenshot({
      path: info.outputPath(`${provider}-submitted-origin-review.png`),
    });
    expect(submission.envelope).toContain(body);
    expect(submission.envelope).toContain("selected review line");
    expect(submission.envelope).toContain(review.reviewId);
    expect(submission.envelope).toContain(review.roundId);
    await expect(
      pane(review).getByRole("region", {
        name: "Submitted feedback",
        exact: true,
      }),
    ).toContainText(body);
    await expect(
      pane(review).getByLabel("Sent comment", { exact: true }),
    ).toContainText(body);
    await expect(
      pane(review).locator("details").filter({ hasText: "Feedback details" }),
    ).not.toHaveAttribute("open");
    expect(await feedbackPrompts(submission.id)).toHaveLength(1);
    expect((await shell.inspect(decoy.id)).messages).toHaveLength(0);
    const before = JSON.stringify(await inspect(review));
    await shell.cli(
      "review",
      "deliver",
      "--id",
      review.reviewId,
      "--round",
      review.roundId,
    );
    expect(await feedbackPrompts(submission.id)).toHaveLength(1);
    expect(JSON.stringify(await inspect(review))).toBe(before);
    const other = await shell.create("Unrelated destination");
    const foreign = await shell.newChat(other, provider);
    await writeFile(shell.file, "next review revision\n");
    await shell.cli("workspace", "focus", "--id", workspace);
    const refreshed = await shell.cli<Summary>(
      "review",
      "refresh",
      "--id",
      review.reviewId,
      "--expected-round",
      review.roundId,
    );
    expect(
      (
        await shell.raw(
          "review",
          "submit",
          "--id",
          review.reviewId,
          "--round",
          refreshed.currentRoundId,
          "--conversation",
          foreign.id,
          "--request-id",
          randomUUID(),
        )
      ).code,
    ).not.toBe(0);
    const requestId = randomUUID();
    const frozen = await submit(
      review,
      selected.id,
      requestId,
      refreshed.currentRoundId,
    );
    const repeated = await submit(
      review,
      selected.id,
      requestId,
      refreshed.currentRoundId,
    );
    expect(repeated.id).toBe(frozen.id);
    await expect
      .poll(async () => (await feedbackPrompts(frozen.id)).length)
      .toBe(1);
    expect(
      (
        await shell.raw(
          "review",
          "submit",
          "--id",
          review.reviewId,
          "--round",
          refreshed.currentRoundId,
          "--conversation",
          decoy.id,
          "--request-id",
          requestId,
        )
      ).code,
    ).not.toBe(0);
  });

test("Review AC5 busy destinations remain queued and accepted-disconnected feedback never automatically resends", async () => {
  const workspace = await shell.create("Review dispatch recovery");
  const chat = await shell.newChat(workspace, "kimi");
  await shell.send(chat.id, "[hold] ordinary busy turn");
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("working");
  const review = await open(workspace);
  await comment(review, "[review-accepted-disconnect] durable feedback");
  const submission = await submit(review, chat.id);
  expect(submission.delivery.status).toBe("queued");
  expect(await feedbackPrompts(submission.id)).toHaveLength(0);
  await shell.cli("conversation", "interrupt", "--id", chat.id);
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("ready");
  await shell.raw(
    "review",
    "deliver",
    "--id",
    review.reviewId,
    "--round",
    review.roundId,
  );
  await expect
    .poll(async () => (await feedbackPrompts(submission.id)).length)
    .toBe(1);
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("failed");
  await shell.stop();
  await shell.start();
  const recovered = (await inspect(review)).rounds[0].submission!;
  expect(["uncertain", "acknowledged"]).toContain(recovered.delivery.status);
  const stoppedReview = await open(workspace);
  await comment(stoppedReview, "Queued for explicitly stopped destination");
  const stoppedSubmission = await submit(stoppedReview, chat.id);
  expect(stoppedSubmission.delivery.status).toBe("queued");
  expect(await feedbackPrompts(stoppedSubmission.id)).toHaveLength(0);

  expect(await feedbackPrompts(submission.id)).toHaveLength(1);
  await shell.raw(
    "review",
    "deliver",
    "--id",
    review.reviewId,
    "--round",
    review.roundId,
  );
  expect(await feedbackPrompts(submission.id)).toHaveLength(1);
  await shell.cli("review", "show", "--id", review.reviewId);
  await expect(
    pane(review).getByRole("region", { name: "Delivery status", exact: true }),
  ).toContainText(/uncertain|sent/i);
});

test("Review AC6 CLI wait times out without publishing, reconnects after restart and multiple waiters see one frozen round", async () => {
  const workspace = await shell.create("Waitable specification");
  const chat = await shell.newChat(workspace, "codex");
  const review = await open(workspace);
  await comment(review, "PRIVATE_WAIT_DRAFT");
  const timeout = await waitProcess(review, review.roundId, 100).result;
  expect(timeout.code).toBe(2);
  expect(timeout.stdout + timeout.stderr).not.toContain("PRIVATE_WAIT_DRAFT");
  expect(await shell.prompts()).toHaveLength(0);
  const abandoned = waitProcess(review, review.roundId);
  await new Promise((resolve) => setTimeout(resolve, 100));
  abandoned.child.kill("SIGTERM");
  await abandoned.result;
  await shell.stop();
  await shell.start();
  const first = waitProcess(review, review.roundId),
    second = waitProcess(review, review.roundId);
  const submission = await submit(review, chat.id);
  for (const result of await Promise.all([first.result, second.result])) {
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(submission.id);
    expect(result.stdout).toContain("PRIVATE_WAIT_DRAFT");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  }
  const refreshed = await shell.cli<Summary>(
    "review",
    "refresh",
    "--id",
    review.reviewId,
    "--expected-round",
    review.roundId,
  );
  expect(refreshed.currentRoundId).not.toBe(review.roundId);
  const old = await waitProcess(review, review.roundId, 100).result;
  expect(old.code).toBe(0);
  expect(old.stdout).toContain(submission.id);
  expect(
    (await waitProcess(review, refreshed.currentRoundId, 100).result).code,
  ).toBe(2);
});

for (const provider of ["codex", "kimi"] as Provider[])
  test(`Review native reconciliation ${provider} uses fresh history, never cached submitted text`, async () => {
    const workspace = await shell.create("Native receipt evidence");
    const chat = await shell.newChat(workspace, provider);
    const review = await open(workspace);
    await comment(review, "[review-accepted-disconnect] verify native receipt");
    const submission = await submit(review, chat.id);
    await expect
      .poll(
        async () =>
          (await inspect(review)).rounds[0].submission?.delivery.status,
      )
      .toBe("uncertain");
    expect(
      (await shell.inspect(chat.id)).messages.some(
        (m) => m.role === "user" && m.text === submission.envelope,
      ),
    ).toBe(true);
    // Stop the failed fixture's process group before altering its on-disk history.
    // This also proves cached submitted text survives restart without becoming receipt evidence.
    await shell.stop();
    await shell.start();
    const nativeFile = path.join(
      shell.recording + ".sessions",
      chat.nativeId + ".json",
    );
    const authoritative = await readFile(nativeFile, "utf8");
    expect(() => JSON.parse(authoritative)).not.toThrow();
    // Simulate a native history response without this item while the app cache still contains it.
    await writeFile(nativeFile, "[]");
    const missing = await shell.raw(
      "review",
      "deliver",
      "--id",
      review.reviewId,
      "--round",
      review.roundId,
    );
    expect(missing.code).not.toBe(0);
    expect((await inspect(review)).rounds[0].submission?.delivery.status).toBe(
      "uncertain",
    );
    expect(await feedbackPrompts(submission.id)).toHaveLength(1);
    await writeFile(nativeFile, authoritative);
    await shell.cli(
      "review",
      "deliver",
      "--id",
      review.reviewId,
      "--round",
      review.roundId,
    );
    expect((await inspect(review)).rounds[0].submission?.delivery.status).toBe(
      "acknowledged",
    );
    expect(await feedbackPrompts(submission.id)).toHaveLength(1);
  });

test("Review preflight failure retains definitely unsent feedback queued", async () => {
  const workspace = await shell.create("Missing provider executable");
  const chat = await shell.newChat(workspace, "codex");
  const review = await open(workspace);
  await comment(review, "Preserve unsent feedback");
  await shell.stop();
  shell.environment.COD_CODEX_EXECUTABLE = path.join(
    shell.temporary,
    "no-such-provider",
  );
  await shell.start();
  const submission = await submit(review, chat.id);
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("failed");
  expect((await inspect(review)).rounds[0].submission?.delivery.status).toBe(
    "queued",
  );
  expect(await feedbackPrompts(submission.id)).toHaveLength(0);
});

test("Review closed panes reopen from Overview and private drafts protect workspace closure", async () => {
  const workspace = await shell.create("Persistent review access");
  const review = await open(workspace);
  await comment(review, "Keep accessible after pane close");
  await shell.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    review.paneId,
  );
  const failed = await shell.raw("workspace", "close", "--id", workspace);
  expect(failed.code).not.toBe(0);
  expect(failed.stderr).toContain("review drafts");
  const row = (await shell.overview()).getByRole("gridcell", {
    name: "Review: spec.md, Review requested",
    exact: true,
  });
  await row.click();
  const state = await shell.cli<{
    workspaces: Array<{
      id: string;
      panes: Array<{ id: string; kind: string; reviewId?: string }>;
    }>;
  }>("state");
  const reopened = state.workspaces
    .find((w) => w.id === workspace)!
    .panes.find((p) => p.reviewId === review.reviewId)!;
  expect(reopened.id).not.toBe(review.paneId);
  await expect(
    shell.pane(reopened.id).getByLabel("Draft comment", { exact: true }),
  ).toContainText("Keep accessible after pane close");
  await shell.stop();
  await shell.start();
  const shown = await shell.cli<Opened>(
    "review",
    "show",
    "--id",
    review.reviewId,
  );
  expect(shown.paneId).toBe(reopened.id);
  await expect(
    shell.pane(reopened.id).getByLabel("Draft comment", { exact: true }),
  ).toContainText("Keep accessible after pane close");
});

test("Review keyboard ranges and comment edits keep immutable quotes and show disk changes", async ({}, testInfo) => {
  const workspace = await shell.create("Keyboard review ranges");
  const review = await open(workspace);
  await tabTo(shell.page, source(review));
  await shell.page.keyboard.press(`${modifier}+Home`);
  await shell.page.keyboard.press("Shift+ArrowDown");
  await shell.page.keyboard.press("Shift+End");
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  await shell.page.keyboard.type("Range comment");
  await pane(review)
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  const comments = pane(review).getByLabel("Draft comment", { exact: true });
  await expect(source(review)).toContainText("first line");
  await expect(source(review)).toContainText("selected review line");
  await comments.click();
  await pane(review)
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Edited range comment");
  await pane(review)
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect(comments).toContainText("Edited range comment");
  await expect(comments.locator("blockquote")).toHaveText(
    "first line\nselected review line",
  );
  await writeFile(shell.file, "changed externally\n");
  await expect(pane(review).getByRole("status")).toContainText(
    "Changed on disk",
  );
  await expect(source(review)).toContainText("first line");
  await expect(source(review)).toContainText("selected review line");
  await pane(review).screenshot({
    path: testInfo.outputPath("review-keyboard-range.png"),
  });
});

test("Review unfinished comment editor survives immediate restart without publishing", async () => {
  const workspace = await shell.create("Unfinished private review");
  const review = await open(workspace);
  await source(review).focus();
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  await pane(review)
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Unfinished private observation");
  await shell.stop();
  await shell.start();
  const editor = pane(review).getByRole("textbox", {
    name: "Comment",
    exact: true,
  });
  await expect(editor).toHaveValue("Unfinished private observation");
  expect(JSON.stringify(await shell.cli("state"))).not.toContain(
    "Unfinished private observation",
  );
  expect((await inspect(review)).rounds[0].submission).toBeUndefined();
  await pane(review)
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect(
    pane(review).getByLabel("Draft comment", { exact: true }),
  ).toContainText("Unfinished private observation");
});

test("Markdown review eye switches source and Mermaid preview and preserves exact fragment comments", async ({}, info) => {
  const workspace = await shell.create("Markdown review");
  const file = path.join(path.dirname(shell.file), "review.md");
  await writeFile(
    file,
    "# Review fixture\r\n\r\nHello **world** and friends.\r\n\r\n```mermaid\r\ngraph TD\r\n A[Start] --> B[Finish]\r\n```\r\n",
  );
  const review = await open(workspace, file);
  const host = pane(review);
  const editor = source(review);
  await expect(editor).toBeVisible();
  await editor.focus();
  await editor.press(`${modifier}+F`);
  const find = shell.page.getByRole("textbox", {
    name: "Find in current content",
    exact: true,
  });
  await find.fill("Hello **world**");
  await expect(
    shell.page.getByRole("status", { name: "Find results" }),
  ).toHaveText("1 of 1");
  await find.press("Escape");
  const immutableSource = await editor
    .locator(".review-source-text")
    .allTextContents();
  await editor.focus();
  await shell.page.keyboard.type("Must not edit the saved revision");
  expect(await editor.locator(".review-source-text").allTextContents()).toEqual(
    immutableSource,
  );
  await editor
    .locator('[data-source-line="3"] .review-source-text')
    .evaluate((node) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const start = text.textContent!.indexOf("world");
        if (start < 0) continue;
        window.getSelection()!.setBaseAndExtent(text, start, text, start + 5);
        return;
      }
      throw new Error("Expected a highlighted source fragment");
    });
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  await host
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Source fragment with CRLF");
  await host.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(
    host.getByLabel("Draft comment", { exact: true }).locator("blockquote"),
  ).toHaveText("world");
  await expect(
    host.locator(".review-source-editor .hljs-section"),
  ).toBeVisible();
  await host.screenshot({ path: info.outputPath("review-source.png") });
  const eye = host.locator("[data-preview-toggle]");
  await eye.click();
  const rendered = host.getByRole("document", { name: "Review preview" });
  await expect(
    rendered.getByRole("heading", { name: "Review fixture" }),
  ).toBeVisible();
  await expect(rendered.locator("svg")).toBeVisible();
  await rendered.locator("strong").evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    node.closest<HTMLElement>("article")!.focus();
  });
  await shell.page.keyboard.type("Must not replace selected Markdown");
  await expect(rendered.locator("strong")).toHaveText("world");
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  await host
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Clarify this word");
  await host.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(
    host.getByLabel("Draft comment", { exact: true }).locator("blockquote"),
  ).toHaveText(["world", "world"]);
  await host.screenshot({ path: info.outputPath("review-preview.png") });
  await eye.click();
  await expect(editor).toContainText("Hello **world**");
  await shell.stop();
  await shell.start();
  await expect(
    pane(review)
      .getByLabel("Draft comment", { exact: true })
      .locator("blockquote"),
  ).toHaveText(["world", "world"]);
});

test("Rendered Markdown Review and Preview follow the chat text size", async ({}, info) => {
  const workspace = await shell.create("Reading size fixture");
  const chat = await shell.newChat(workspace, "codex");
  await shell.send(chat.id, "The reading pane should match this chat.");
  const chatBody = shell
    .pane(chat.paneId)
    .locator(".chat-message.assistant")
    .filter({ hasText: "DONE The reading pane should match this chat." });
  await expect(chatBody).toBeVisible();
  const file = path.join(path.dirname(shell.file), "reading-size.md");
  const paragraph = "Everyone can read the same short release note.";
  await writeFile(
    file,
    [
      "# Release notes",
      "",
      paragraph,
      "",
      "- Record the current build.",
      "- Reopen the release note.",
      "",
      "| Step | Result |",
      "| --- | --- |",
      "| Open notes | Ready |",
      "",
      "```ts",
      'const status = "ready";',
      "```",
      "",
    ].join("\n"),
  );
  const review = await open(workspace, file);
  const host = pane(review);
  const sourceSize = await source(review).evaluate(
    (node) => getComputedStyle(node).fontSize,
  );
  const header = host.locator(".review-header");
  const headerSize = await header.evaluate(
    (node) => getComputedStyle(node).fontSize,
  );
  const eye = host.locator("[data-preview-toggle]");
  await eye.click();
  const rendered = host.getByRole("document", { name: "Review preview" });
  const reviewBody = rendered.getByText(paragraph, { exact: true });
  const size = async (value: number) => {
    await shell.cli(
      "settings",
      "update",
      "--values",
      JSON.stringify({ "chat.fontSize": value }),
    );
    await expect(chatBody).toHaveCSS("font-size", `${value}px`);
  };
  const matchesChat = async (body: Locator, image: string, size: string) => {
    await expect(body).toBeVisible();
    await expect(chatBody).toHaveCSS("font-size", size);
    await shell.page.screenshot({ path: info.outputPath(image) });
    await expect(body).toHaveCSS("font-size", size);
  };
  await matchesChat(reviewBody, "markdown-review-default.png", "15px");
  await size(20);
  await matchesChat(reviewBody, "markdown-review-scaled.png", "20px");
  await expect(header).toHaveCSS("font-size", headerSize);
  await eye.click();
  await expect(source(review)).toHaveCSS("font-size", sourceSize);
  await size(15);
  const preview = await shell.cli<{ paneId: string }>(
    "preview",
    "open",
    "--workspace",
    workspace,
    "--path",
    file,
    "--source-pane",
    review.paneId,
    "--focus",
    "true",
  );
  const previewHost = shell.pane(preview.paneId);
  const frame = previewHost.locator("iframe");
  const previewBody = frame
    .contentFrame()
    .getByText(paragraph, { exact: true });
  await matchesChat(previewBody, "markdown-preview-default.png", "15px");
  await size(20);
  await matchesChat(previewBody, "markdown-preview-scaled.png", "20px");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  expect(
    await previewBody.evaluate(
      (node) => typeof node.ownerDocument.defaultView?.cod,
    ),
  ).toBe("undefined");
});

test("Markdown review keeps a pending exact fragment through wrap, focus and view changes", async ({}, info) => {
  const workspace = await shell.create("Release notes workshop");
  const file = path.join(path.dirname(shell.file), "review-fragment.md");
  await writeFile(
    file,
    "# Release checklist\n\nBefore publishing, **verify download integrity** against the signed release manifest and confirm that the `version selector` shows the new release.\n\nArchive the results with the draft announcement.\n",
  );
  const review = await open(workspace, file);
  const host = pane(review);
  const eye = host.locator("[data-preview-toggle]");
  const preview = host.getByRole("document", { name: "Review preview" });
  const commentBox = host.getByRole("textbox", {
    name: "Comment",
    exact: true,
  });
  const context = host.locator(".review-comment-editor .review-anchor-context");
  await eye.click();
  const strong = preview.locator("strong");
  await expect(strong).toHaveText("verify download integrity");
  const quote =
    "download integrity against the signed release manifest and confirm that the version";
  await preview.focus();
  await strong.evaluate((node) =>
    window.getSelection()!.setPosition(node.firstChild!, 7),
  );
  for (let i = 0; i < quote.length; i++)
    await shell.page.keyboard.press("Shift+ArrowRight");
  expect(
    await shell.page.evaluate(() => window.getSelection()!.toString()),
  ).toBe(quote);
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  await expect(commentBox).toBeFocused();
  await commentBox.fill("Which step verifies the downloaded archive?");
  const marked = () =>
    shell.page.evaluate(() =>
      [...(CSS.highlights.get("cod-review-draft") ?? [])]
        .map((range) => range.toString())
        .join(""),
    );
  await expect.poll(marked).toBe(quote);
  await expect(context).toBeHidden();
  await expect(commentBox).toHaveAccessibleDescription(quote);
  await shell.page.screenshot({
    path: info.outputPath("markdown-pending-wide.png"),
  });

  await shell.page.setViewportSize({ width: 460, height: 710 });
  await expect.poll(marked).toBe(quote);
  expect(
    await shell.page.evaluate(() => {
      const range = [...CSS.highlights.get("cod-review-draft")!][0] as Range;
      return new Set(
        [...range.getClientRects()].map((rect) => Math.floor(rect.top)),
      ).size;
    }),
  ).toBeGreaterThan(1);
  await shell.page.screenshot({
    path: info.outputPath("markdown-pending-narrow.png"),
  });
  await eye.click();
  await expect(source(review)).toBeVisible();
  await expect.poll(marked).toBe("");
  await expect(context.locator("blockquote")).toHaveText(quote);
  await expect(context).toBeVisible();
  await shell.page.screenshot({
    path: info.outputPath("markdown-pending-source-quote.png"),
  });
  await eye.click();
  await expect.poll(marked).toBe(quote);
  await expect(context).toBeHidden();
  await expect(commentBox).toHaveValue(
    "Which step verifies the downloaded archive?",
  );

  // A different native selection and a passive review refresh must not
  // redirect the existing draft or alter its saved fragment.
  await preview
    .locator("p")
    .last()
    .evaluate((node) =>
      window
        .getSelection()!
        .setBaseAndExtent(node.firstChild!, 0, node.firstChild!, 7),
    );
  await shell.page.keyboard.press("Shift+ArrowRight");
  expect(
    await shell.page.evaluate(() => window.getSelection()!.toString()),
  ).toBe("Archive ");
  await shell.page.evaluate((request) => window.cod.invoke(request), {
    op: "review.comment-add",
    id: review.reviewId,
    roundId: review.roundId,
    expectedVersion: (await inspect(review)).version,
    body: "A separate draft comment",
    range: { startLine: 1, endLine: 1 },
  });
  await expect(host.getByLabel("Draft comment", { exact: true })).toContainText(
    "A separate draft comment",
  );
  await expect.poll(marked).toBe(quote);
  await commentBox.press(`${modifier}+Enter`);
  await expect.poll(marked).toBe("");
  await expect(
    host
      .getByLabel("Draft comment", { exact: true })
      .filter({ hasText: "Which step verifies" })
      .locator("blockquote"),
  ).toHaveText(quote);

  const last = preview.locator("p").last();
  await last.dblclick({ position: { x: 13, y: 8 } });
  const pointerQuote = await shell.page.evaluate(() =>
    window.getSelection()!.toString(),
  );
  expect(pointerQuote).toBe("Archive");
  await last.click({ button: "right", position: { x: 13, y: 8 } });
  await shell.page
    .getByRole("dialog", { name: "Actions" })
    .getByRole("button", { name: "Add comment", exact: true })
    .click();
  await expect(commentBox).toBeFocused();
  await expect.poll(marked).toBe(pointerQuote);
  await host
    .getByRole("button", { name: "Cancel comment", exact: true })
    .click();
  await expect.poll(marked).toBe("");
  await expect(commentBox).toBeHidden();

  // A source-only anchor has no equivalent formatted coordinates.
  await eye.click();
  await source(review).focus();
  await source(review)
    .locator('[data-source-line="3"] .review-source-text')
    .evaluate((node) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const start = walker.nextNode()!;
      window.getSelection()!.setBaseAndExtent(start, 0, start, 6);
    });
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  await commentBox.fill("Source-only review draft");
  await eye.click();
  await expect(context.locator("blockquote")).toHaveText("Before");
  await expect(context).toBeVisible();
  await expect.poll(marked).toBe("");
  await host
    .getByRole("button", { name: "Cancel comment", exact: true })
    .click();
  await expect(commentBox).toBeHidden();
  await preview.focus();
  await preview.evaluate((article) => {
    const blocks = article.querySelectorAll(":scope > .markdown-block > p");
    window
      .getSelection()!
      .setBaseAndExtent(
        blocks[0].lastChild!,
        1,
        blocks[1].firstChild!,
        "Archive".length,
      );
  });
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  await expect(commentBox).toBeFocused();
  await expect.poll(marked).toBe("shows the new release.\nArchive");
  expect(
    await shell.page.evaluate(
      () => CSS.highlights.get("cod-review-draft")!.size,
    ),
  ).toBe(2);
  await shell.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    review.paneId,
  );
  await expect.poll(marked).toBe("");
});

test("Review comments stay beside their anchors without rebuilding or jumping to the top", async ({}, info) => {
  const workspace = await shell.create("Anchored review");
  const file = path.join(path.dirname(shell.file), "long-review.md");
  await writeFile(
    file,
    Array.from(
      { length: 70 },
      (_, i) =>
        `## Section ${i}\n\nParagraph ${i} with **selected words** for review.\n`,
    ).join("\n"),
  );
  const review = await open(workspace, file);
  const host = pane(review);
  await host.locator("[data-preview-toggle]").click();
  const document = host.getByRole("document", { name: "Review preview" });
  const target = document.locator("strong").nth(35);
  await target.scrollIntoViewIfNeeded();
  await target.evaluate((node) => {
    const range = window.document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    node.closest<HTMLElement>("article")!.focus({ preventScroll: true });
    node.closest<HTMLElement>("article")!.dataset.testIdentity = "retained";
  });
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  const input = host.getByRole("textbox", { name: "Comment", exact: true });
  await input.fill("Explain this paragraph");
  const before = await host
    .locator(".review-body")
    .evaluate((node) => node.scrollTop);
  expect(before).toBeGreaterThan(100);
  await host.getByRole("button", { name: "Save comment", exact: true }).click();
  const thread = host.getByLabel("Draft comment", { exact: true });
  await expect(thread).toContainText("Explain this paragraph");
  await expect(document).toHaveAttribute("data-test-identity", "retained");
  expect(
    await thread.evaluate((node) => node.previousElementSibling?.textContent),
  ).toContain("Paragraph 35");
  const after = await host
    .locator(".review-body")
    .evaluate((node) => node.scrollTop);
  expect(Math.abs(after - before)).toBeLessThan(100);
  await thread.click();
  await input.fill("Edited at the same anchor");
  await host.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(thread).toContainText("Edited at the same anchor");
  expect(
    await host.locator(".review-body").evaluate((node) => node.scrollTop),
  ).toBeGreaterThan(100);
  const geometry = await host.locator(".review-header").evaluate((node) => ({
    top: node.getBoundingClientRect().top,
    parent: node.parentElement!.getBoundingClientRect().top,
    height: node.getBoundingClientRect().height,
  }));
  expect(Math.abs(geometry.top - geometry.parent)).toBeLessThan(2);
  expect(geometry.height).toBeLessThanOrEqual(40);
  await shell.page.screenshot({ path: info.outputPath("anchored-review.png") });
});

test("Reopening a saved comment preserves its unfinished rewrite and Escape leaves recovery visible", async () => {
  const workspace = await shell.create("Comment rewrite safety");
  const review = await open(workspace);
  const host = pane(review);
  await source(review).focus();
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  const input = () =>
    host.getByRole("textbox", { name: "Comment", exact: true });
  await input().fill("Original saved comment");
  await host.getByRole("button", { name: "Save comment", exact: true }).click();
  const card = () => host.getByLabel("Draft comment", { exact: true });
  await card().click();
  await input().fill("Carefully rewritten unfinished comment");
  await card().click();
  await expect(input()).toHaveValue("Carefully rewritten unfinished comment");
  await input().press("Escape");
  await expect(input()).toBeVisible();
  await expect(
    host.getByRole("button", { name: "Save comment", exact: true }),
  ).toBeVisible();
  await expect(
    host.getByRole("button", { name: "Cancel comment", exact: true }),
  ).toBeVisible();
  await expect(
    host.getByRole("button", { name: "Send feedback", exact: true }),
  ).toBeDisabled();
  await card().click();
  await expect(input()).toHaveValue("Carefully rewritten unfinished comment");
  await shell.stop();
  await shell.start();
  const restored = pane(review).getByRole("textbox", {
    name: "Comment",
    exact: true,
  });
  await expect(restored).toHaveValue("Carefully rewritten unfinished comment");
  await pane(review)
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect(
    pane(review).getByLabel("Draft comment", { exact: true }),
  ).toContainText("Carefully rewritten unfinished comment");
  await expect(
    pane(review).getByRole("button", { name: "Send feedback", exact: true }),
  ).toBeEnabled();
});

test("Diff review keeps unchanged context neutral and anchors keyboard comments on removed lines", async ({}, info) => {
  const workspace = await shell.create("Unified diff review");
  const folder = shell.folders[0];
  const file = path.join(folder, "unified.txt");
  const original = Array.from({ length: 30 }, (_, i) => `unchanged ${i + 1}`);
  await writeFile(file, original.join("\n") + "\n");
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  execFileSync("git", ["add", "--all"], { cwd: folder, env });
  execFileSync("git", ["commit", "-m", "Invented baseline"], {
    cwd: folder,
    env,
  });
  const next = [...original];
  next[2] = "replacement 3";
  next[25] = "replacement 26";
  await writeFile(file, next.join("\n") + "\n");
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    folder,
  );
  const chat = await shell.newChat(workspace, "codex");
  const review = await shell.cli<Opened>(
    "review",
    "open-diff",
    "--workspace",
    workspace,
    "--repo-root",
    folder,
    "--conversation",
    chat.id,
  );
  const host = pane(review);
  await expect(host.locator(".review-line")).toHaveCount(32);
  const context = host
    .locator('.review-line[data-diff-kind="context"]')
    .filter({ hasText: "unchanged 1" })
    .first();
  await expect(context).toBeVisible();
  expect(
    (await context.textContent())?.trimStart().startsWith("unchanged"),
  ).toBe(false); // Both line-number columns precede the content.
  expect((await context.textContent())?.trimStart()).not.toMatch(/^[+-]/);
  await expect(
    host.locator('.review-line[data-diff-kind="removed"]'),
  ).toHaveCount(2);
  await expect(
    host.locator('.review-line[data-diff-kind="added"]'),
  ).toHaveCount(2);
  await expect(
    host
      .locator('.review-line[data-diff-kind="context"]')
      .filter({ hasText: /unchanged 1$/ }),
  ).toHaveCount(1);
  const canonical = await realpath(file);
  const removed = host.getByRole("button", {
    name: `Old line 3 ${canonical}`,
    exact: true,
  });
  await removed.focus();
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  const input = host.getByRole("textbox", { name: "Comment", exact: true });
  await expect(input).toBeFocused();
  await input.fill("Removed line needs discussion");
  await input.press(`${modifier}+Enter`);
  await expect(host.getByLabel("Draft comment", { exact: true })).toContainText(
    "Removed line needs discussion",
  );
  await expect(removed).toBeFocused();
  expect((await inspect(review)).rounds[0].submission).toBeUndefined();
  await host.screenshot({ path: info.outputPath("unified-diff.png") });
});

test("Diff review highlights Java source while preserving line text and comment anchors", async ({}, info) => {
  const workspace = await shell.create("Java diff review");
  const folder = shell.folders[0];
  const java = path.join(folder, "Example.java");
  const notes = path.join(folder, "notes.txt");
  const oldLine = '    return "before";';
  const newLine = '    return "<img src=x onerror=alert(1)>";';
  const javaSource = (line: string) =>
    [
      "public class Example {",
      "  String message() {",
      line,
      "  }",
      "}",
      "",
    ].join("\n");
  await writeFile(java, javaSource(oldLine));
  await writeFile(notes, "public return before\n");
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  execFileSync("git", ["add", "--all"], { cwd: folder, env });
  execFileSync("git", ["commit", "-m", "Invented baseline"], {
    cwd: folder,
    env,
  });
  await writeFile(java, javaSource(newLine));
  await writeFile(notes, "public return after\n");
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    folder,
  );
  const chat = await shell.newChat(workspace, "codex");
  const review = await shell.cli<Opened>(
    "review",
    "open-diff",
    "--workspace",
    workspace,
    "--repo-root",
    folder,
    "--conversation",
    chat.id,
  );
  const host = pane(review);
  const javaPath = await realpath(java);
  const added = host.getByRole("button", {
    name: `New line 3 ${javaPath}`,
    exact: true,
  });
  const removed = host.getByRole("button", {
    name: `Old line 3 ${javaPath}`,
    exact: true,
  });
  const context = host.getByRole("button", {
    name: `New line 1 ${javaPath}`,
    exact: true,
  });
  const plainText = host.getByRole("button", {
    name: `New line 1 ${await realpath(notes)}`,
    exact: true,
  });
  await expect(added).toBeVisible();
  await shell.page.screenshot({ path: info.outputPath("java-diff.png") });
  await expect(added).toHaveAttribute("data-diff-kind", "added");
  await expect(removed).toHaveAttribute("data-diff-kind", "removed");
  await expect(context).toHaveAttribute("data-diff-kind", "context");
  await expect(added.locator(".hljs-keyword")).toHaveText("return");
  await expect(added.locator(".hljs-string")).toHaveText(
    '"<img src=x onerror=alert(1)>"',
  );
  await expect(removed.locator(".hljs-keyword")).toHaveText("return");
  await expect(context.locator(".hljs-keyword")).toHaveText([
    "public",
    "class",
  ]);

  await expect(host.locator(".review-line img")).toHaveCount(0);
  expect(await added.textContent()).toBe("+        3  " + newLine);
  expect(await removed.textContent()).toBe("-   3       " + oldLine);
  expect(
    await added.evaluate((line) => {
      const selection = window.getSelection()!;
      selection.selectAllChildren(line);
      const selected = selection.toString();
      selection.removeAllRanges();
      return selected;
    }),
  ).toBe("+        3  " + newLine);
  await removed.focus();
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  const input = host.getByRole("textbox", { name: "Comment", exact: true });
  await expect(input).toBeFocused();
  await input.fill("Removed return value");
  await input.press(`${modifier}+Enter`);
  await expect(host.getByLabel("Draft comment", { exact: true })).toContainText(
    "Removed return value",
  );
  await expect(removed).toBeFocused();
  await shell.page
    .getByRole("tree", { name: "Review files" })
    .getByRole("treeitem", { name: "notes.txt", exact: true })
    .click();
  await expect(plainText).toBeVisible();
  await expect(plainText.locator("span")).toHaveCount(0);
});

test("Whole-file Git review uses frozen contents and sends changed and unchanged anchors together", async ({}, info) => {
  const workspace = await shell.create("Whole-file review");
  const folder = shell.folders[0];
  const canonical = await realpath(folder);
  await mkdir(path.join(folder, "src"));
  const changed = path.join(folder, "src", "aaa.js");
  const untouched = path.join(folder, "src", "bbb.js");
  const later = path.join(folder, "src", "ccc.js");
  const removed = path.join(folder, "000-deleted.txt");
  const before = Array.from(
    { length: 25 },
    (_, index) => `// retained line ${index + 1}`,
  );
  await writeFile(changed, before.join("\n") + "\n");
  await writeFile(untouched, "export const original = 42;\n");
  await writeFile(later, before.join("\n") + "\n");
  await writeFile(removed, "The removed source\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: folder,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
  git("add", "--all");
  git("commit", "-m", "Invented baseline");
  const after = [...before];
  after[2] = "export const savedChange = 43;";
  await writeFile(changed, after.join("\n") + "\n");
  const laterLines = [...before];
  laterLines[23] = "export const lateChange = 44;";
  await writeFile(later, laterLines.join("\n") + "\n");
  await unlink(removed);
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    folder,
  );
  const origin = await shell.newChat(workspace, "codex");
  const review = await shell.cli<Opened>(
    "review",
    "open-diff",
    "--workspace",
    workspace,
    "--repo-root",
    folder,
    "--conversation",
    origin.id,
  );
  await writeFile(changed, "// live file changed after review opened\n");
  await writeFile(untouched, "export const live = 444;\n");

  const host = pane(review);
  const tree = shell.page.getByRole("tree", { name: "Review files" });
  const file = (name: string) =>
    tree.getByRole("treeitem", { name, exact: true });
  const line = (relative: string, number: number, side = "New") =>
    host.getByRole("button", {
      name: `${side} line ${number} ${path.join(canonical, relative)}`,
      exact: true,
    });
  await expect(file("aaa.js")).toHaveAttribute("aria-selected", "true");
  await expect(line("src/aaa.js", 25)).toHaveText(/retained line 25/);
  await expect(line("src/aaa.js", 3)).toHaveText(/savedChange = 43/);
  await file("aaa.js").focus();
  await shell.page.screenshot({
    path: info.outputPath("whole-git-review-changed.png"),
  });
  const add = async (target: Locator, body: string) => {
    await target.focus();
    await shell.page.keyboard.press(`${modifier}+Shift+M`);
    const input = host.getByRole("textbox", { name: "Comment", exact: true });
    await expect(input).toBeFocused();
    await input.fill(body);
    await input.press(`${modifier}+Enter`);
    await expect(
      host
        .getByLabel("Draft comment", { exact: true })
        .filter({ hasText: body }),
    ).toBeVisible();
  };
  await add(line("src/aaa.js", 3), "Discuss the saved addition");
  await host.getByRole("button", { name: "First change" }).click();
  await host.getByRole("button", { name: "Next change" }).click();
  await expect(line("src/ccc.js", 24, "Old")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await host.getByRole("button", { name: "Next change" }).click();
  await expect(line("000-deleted.txt", 1, "Old")).toHaveText(/removed source/);
  await expect(file("000-deleted.txt")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await file("aaa.js").focus();
  await file("aaa.js").press("ArrowDown");
  await expect(file("bbb.js")).toBeFocused();
  await file("bbb.js").press("Enter");
  await expect(file("bbb.js")).toHaveAttribute("aria-selected", "true");
  await expect(line("src/bbb.js", 1)).toHaveText(/original = 42/);
  await host.getByRole("button", { name: "Previous change" }).click();
  await expect(line("src/aaa.js", 3, "Old")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await file("bbb.js").click();
  await host.getByRole("button", { name: "Next change" }).click();
  await expect(line("src/ccc.js", 24, "Old")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await file("bbb.js").click();
  await file("ccc.js").click();
  await expect(line("src/ccc.js", 24, "Old")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(line("src/ccc.js", 1)).toHaveText(/retained line 1/);
  await file("bbb.js").click();
  await add(line("src/bbb.js", 1), "Name the original constant");
  const source = host.locator(".review-git-source");
  expect((await source.boundingBox())!.height).toBeGreaterThan(120);
  await shell.page.screenshot({
    path: info.outputPath("whole-git-review-unchanged.png"),
  });
  const round = (await inspect(review)).rounds[0];
  expect(round.commentCount).toBe(2);
  await host
    .getByRole("button", { name: "Send feedback", exact: true })
    .click();
  await expect
    .poll(async () => Boolean((await inspect(review)).rounds[0].submission))
    .toBe(true);
  const envelope = JSON.parse(
    (await inspect(review)).rounds[0].submission!.envelope,
  );
  expect(envelope.comments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        quote: "export const savedChange = 43;",
        anchor: expect.objectContaining({ startLine: 3, side: "new" }),
      }),
      expect.objectContaining({
        quote: "export const original = 42;",
        anchor: expect.objectContaining({ startLine: 1, side: "new" }),
      }),
    ]),
  );
  await expect.poll(async () => (await shell.prompts()).length).toBe(1);
});

test("Diff review headings keep paths and revision labels compact in a narrow pane", async ({}, info) => {
  const workspace = await shell.create("Compact diff review");
  const folder = shell.folders[0];
  const canonical = await realpath(folder);
  const same = "model.txt";
  const dir = "collection-" + "nested".repeat(23);
  const old = `${dir}/old report.txt`;
  const next = `${dir}/renamed report.txt`;
  const branch = "review-" + "revision".repeat(20);
  const namedRevision = `refs/heads/${branch}`;
  const previousLines = Array.from({ length: 24 }, (_, i) => `item ${i + 1}`);
  await mkdir(path.join(folder, dir));
  await writeFile(path.join(folder, old), previousLines.join("\n") + "\n");
  await writeFile(path.join(folder, same), "Original value\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: folder,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
  git("add", "--all");
  git("commit", "-m", "Invented baseline");
  const base = git("rev-parse", "HEAD");
  git("mv", old, next);
  const updatedLines = [...previousLines];
  updatedLines[2] = "changed item 3";
  await writeFile(path.join(folder, next), updatedLines.join("\n") + "\n");
  await writeFile(path.join(folder, same), "Modified value\n");
  git("add", "--all");
  git("commit", "-m", "Invented changes");
  const head = git("rev-parse", "HEAD");
  git("update-ref", namedRevision, head);
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    folder,
  );
  const origin = await shell.newChat(workspace, "codex");
  const review = await shell.cli<Opened>(
    "review",
    "open-diff",
    "--workspace",
    workspace,
    "--repo-root",
    folder,
    "--base",
    base,
    "--head",
    namedRevision,
    "--conversation",
    origin.id,
  );
  await shell.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(760, 680),
  );
  const host = pane(review);
  const content = host.getByRole("region", {
    name: "Review content",
    exact: true,
  });
  const headings = content.getByRole("heading", { level: 3 });
  await expect(headings).toHaveCount(1);
  const tree = shell.page.getByRole("tree", { name: "Review files" });
  await tree.getByRole("treeitem", { name: same, exact: true }).click();
  const regular = headings.filter({ hasText: /^model\.txt$/ });
  await expect(regular).toHaveText(same);
  await expect(regular).toHaveAccessibleDescription(path.join(canonical, same));
  expect(
    await regular.evaluate((node) => node.scrollWidth - node.clientWidth),
  ).toBeLessThanOrEqual(1);
  await tree
    .getByRole("treeitem", { name: "renamed report.txt", exact: true })
    .click();
  const renamed = headings.filter({ hasText: `${old} → ${next}` });
  const fullRename = `${path.join(canonical, old)} → ${path.join(canonical, next)}`;
  await expect(renamed).toHaveAttribute("title", fullRename);
  await expect(renamed).toHaveAccessibleDescription(fullRename);
  const comparison = content.locator(".review-diff-comparison");
  const fullRevisions = `${base} → ${namedRevision} (${head})`;
  await expect(comparison).toHaveText(`${base.slice(0, 12)} → ${branch}`);
  await expect(comparison).toHaveAttribute("title", fullRevisions);
  await expect(comparison).toHaveAccessibleDescription(fullRevisions);
  await expect
    .poll(async () => (await host.boundingBox())!.width)
    .toBeLessThan(390);
  for (const label of [comparison, renamed]) {
    expect(
      await label.evaluate((node) => node.scrollWidth - node.clientWidth),
    ).toBeLessThanOrEqual(1);
  }
  for (const part of [
    comparison.locator("span").first(),
    comparison.locator("span").last(),
    renamed.locator(".review-diff-path > :last-child").first(),
    renamed.locator(".review-diff-path > :last-child").last(),
  ]) {
    await expect(part).toBeVisible();
    expect((await part.boundingBox())!.width).toBeGreaterThan(50);
  }
  await host.screenshot({
    path: info.outputPath("compact-diff-headings-narrow.png"),
  });

  const removed = content.getByRole("button", {
    name: `Old line 3 ${path.join(canonical, old)}`,
    exact: true,
  });
  await removed.focus();
  await removed.press(`${modifier}+Shift+M`);
  const input = host.getByRole("textbox", { name: "Comment", exact: true });
  await input.fill("Old path remains anchored");
  await input.press(`${modifier}+Enter`);
  await expect(removed.locator("+ .review-comment")).toContainText(
    "Old path remains anchored",
  );
  await expect(removed).toBeFocused();
  expect((await inspect(review)).rounds[0].submission).toBeUndefined();
});

for (const feedback of [false, true])
  test(`Narrow review toolbar keeps ${feedback ? "Send feedback" : "Approve"} visible through keyboard, resizing and restart`, async ({}, info) => {
    const workspace = await shell.create("Invented compact review");
    const origin = await shell.newChat(workspace, "codex");
    const name = (
      "Invented long origin " + "with readable review context ".repeat(9)
    ).slice(0, 240);
    await shell.cli(
      "conversation",
      "rename",
      "--id",
      origin.id,
      "--name",
      name,
    );
    const review = await open(workspace);
    const label = feedback ? "Send feedback" : "Approve";
    const host = () => pane(review);
    const primary = () =>
      host().getByRole("button", { name: label, exact: true });
    const round = () =>
      host().getByRole("combobox", { name: "Round", exact: true });
    const preview = () => host().locator("[data-preview-toggle]");
    const resize = async (width: number, size: number) => {
      await shell.app!.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0].setContentSize(width, 700),
        width,
      );
      await shell.cli(
        "settings",
        "update",
        "--values",
        JSON.stringify({ "ui.fontSize": size }),
      );
      await expect
        .poll(() => shell.page.evaluate(() => innerWidth))
        .toBe(width);
      await expect
        .poll(() =>
          primary().evaluate((node) => getComputedStyle(node).fontSize),
        )
        .toBe(`${size}px`);
    };
    const fit = async (phase: string, compact = false) => {
      await expect(primary()).toBeVisible();
      await expect(round()).toHaveValue(review.roundId);
      await expect(host().locator(".review-origin")).toContainText(name);
      await expect(host().locator(".review-origin")).toHaveAttribute(
        "title",
        `Feedback to ${name}`,
      );
      const geometry = await host()
        .locator(".review-header")
        .evaluate((header) => {
          const pane = header.parentElement!.getBoundingClientRect();
          const controls = [
            ...header.querySelectorAll<HTMLElement>(
              "button:not([hidden], select > button), select",
            ),
          ].map((control) => {
            const box = control.getBoundingClientRect();
            const points = [
              [box.left + 3, box.top + box.height / 2],
              [box.right - 3, box.top + box.height / 2],
              [box.left + box.width / 2, box.top + 3],
              [box.left + box.width / 2, box.bottom - 3],
            ];
            return {
              label: control.getAttribute("aria-label") || control.textContent,
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              hits: points.every(([x, y]) => {
                const hit = document.elementFromPoint(x, y);
                return hit === control || (!!hit && control.contains(hit));
              }),
            };
          });
          return {
            height: header.getBoundingClientRect().height,
            width: header.clientWidth,
            scrollWidth: header.scrollWidth,
            pane: { left: pane.left, right: pane.right },
            controls,
          };
        });
      await writeFile(
        info.outputPath(`${phase}-geometry.json`),
        JSON.stringify(geometry, null, 2),
      );
      await shell.page.screenshot({
        path: info.outputPath(`${phase}-review.png`),
      });
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
      for (const control of geometry.controls) {
        expect(control.left, control.label ?? "Control").toBeGreaterThanOrEqual(
          geometry.pane.left,
        );
        expect(control.right, control.label ?? "Control").toBeLessThanOrEqual(
          geometry.pane.right,
        );
        expect(control.hits, control.label ?? "Control").toBe(true);
      }
      if (compact) expect(geometry.height).toBeLessThanOrEqual(40);
    };
    if (feedback) {
      await comment(review, "Private feedback before resizing");
      await source(review).focus();
      await source(review).press(`${modifier}+Shift+M`);
      await host()
        .getByRole("textbox", { name: "Comment", exact: true })
        .fill("Unfinished private note before restart");
      await expect(primary()).toBeDisabled();
    }
    await resize(1280, 14);
    await fit(`${label}-normal`, true);
    await resize(800, 20);
    await fit(`${label}-narrow`);
    await resize(800, 32);
    await fit(`${label}-maximum-text`);
    await resize(1280, 14);
    await fit(`${label}-resized-wide`, true);
    await resize(800, 20);
    await shell.stop();
    await shell.start();
    await resize(800, 20);
    await fit(`${label}-restored`);
    const detail = await shell.cli<Summary & { originConversationId: string }>(
      "review",
      "inspect",
      "--id",
      review.reviewId,
    );
    expect(detail.originConversationId).toBe(origin.id);
    expect(detail.currentRoundId).toBe(review.roundId);
    expect(detail.rounds[0].submission).toBeUndefined();
    if (feedback) {
      await expect(
        host().getByLabel("Draft comment", { exact: true }),
      ).toContainText("Private feedback before resizing");
      const pending = host().getByRole("textbox", {
        name: "Comment",
        exact: true,
      });
      await expect(pending).toHaveValue(
        "Unfinished private note before restart",
      );
      await expect(primary()).toBeDisabled();
      await tabTo(
        shell.page,
        host().getByRole("button", { name: "Save comment", exact: true }),
      );
      await shell.page.keyboard.press("Enter");
      await expect(
        host().getByLabel("Draft comment", { exact: true }),
      ).toHaveCount(2);
    }
    await expect(primary()).toBeEnabled();
    await source(review).focus();
    await tabTo(shell.page, round());
    await shell.page.keyboard.press("Home");
    await expect(round()).toHaveValue(review.roundId);
    const more = host().getByRole("button", {
      name: "Review actions",
      exact: true,
    });
    await tabTo(shell.page, more);
    await shell.page.keyboard.press("Enter");
    await expect(
      shell.page
        .locator(".context-menu")
        .getByRole("button", { name: "Add comment", exact: true })
        .locator("kbd"),
    ).toHaveText(process.platform === "darwin" ? "⌘⇧M" : "Ctrl+Shift+M");
    await shell.page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await tabTo(shell.page, preview());
    await shell.page.keyboard.press("Space");
    await expect(
      host().getByRole("document", { name: "Review preview", exact: true }),
    ).toBeFocused();
    await tabTo(shell.page, preview());
    await shell.page.keyboard.press("Space");
    await expect(source(review)).toBeVisible();
    await fit(`${label}-ready`);
    await tabTo(shell.page, primary());
    if (feedback) await shell.page.keyboard.press("Enter");
    else {
      const box = (await primary().boundingBox())!;
      await shell.page.mouse.click(
        box.x + box.width - 3,
        box.y + box.height / 2,
      );
    }
    await expect
      .poll(
        async () =>
          (await inspect(review)).rounds[0].submission?.delivery.status,
      )
      .toBe("acknowledged");
    const submission = (await inspect(review)).rounds[0].submission!;
    const packet = JSON.parse(submission.envelope);
    expect(packet.reviewId).toBe(review.reviewId);
    expect(packet.roundId).toBe(review.roundId);
    expect(packet.comments.map((item: { body: string }) => item.body)).toEqual(
      feedback
        ? [
            "Private feedback before resizing",
            "Unfinished private note before restart",
          ]
        : [],
    );
    expect(await feedbackPrompts(submission.id)).toHaveLength(1);
  });

test("Inline source comments keep their anchor, quote and caret when a pane narrows", async ({}, info) => {
  const lines = Array.from(
    { length: 80 },
    (_, index) => `Invented paragraph ${index + 1}: exact source anchor.`,
  );
  lines[34] = "Anchor A";
  lines[35] = "Anchor B";
  const quote = lines.slice(34, 36).join("\n");
  await writeFile(shell.file, lines.join("\n"));
  const review = await open(await shell.create("Responsive anchored review"));
  const host = pane(review);
  const editor = source(review);
  const pending = host.getByRole("textbox", { name: "Comment", exact: true });
  const viewport = host.locator(".review-body");
  const lastAnchor = host.locator('[data-source-line="36"]');
  const resize = async (width: number, size: number) => {
    await shell.app!.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setContentSize(width, 700),
      width,
    );
    await shell.cli(
      "settings",
      "update",
      "--values",
      JSON.stringify({ "ui.fontSize": size }),
    );
    await expect.poll(() => shell.page.evaluate(() => innerWidth)).toBe(width);
  };
  await resize(1280, 14);
  await editor.focus();
  await editor.press(`${modifier}+Home`);
  for (let index = 0; index < 34; index++) await editor.press("ArrowDown");
  await editor.press("Home");
  await editor.press("Shift+ArrowDown");
  await editor.press("Shift+End");
  await editor.press(`${modifier}+Shift+M`);
  await expect(pending).toBeFocused();
  await shell.page.keyboard.type("Private anchored draft");
  await pending.press("Home");
  await pending.press("ArrowRight");
  await pending.press("Shift+ArrowRight");
  const selection = await pending.evaluate((node: HTMLTextAreaElement) => [
    node.selectionStart,
    node.selectionEnd,
  ]);
  const scroll = await viewport.evaluate((node) => node.scrollTop);
  expect(scroll).toBeGreaterThan(100);
  await resize(800, 20);
  await expect(pending).toBeFocused();
  expect(
    await pending.evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
    ]),
  ).toEqual(selection);
  expect(await viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(
    100,
  );
  const context = host.locator(".review-comment-editor .review-anchor-context");
  await expect(context).toBeVisible();
  await expect(context).toContainText("Lines 35-36");
  await expect(lastAnchor.locator("+ .review-comment-editor")).toContainText(
    "Anchor A",
  );
  const expectQuote = async (block: Locator) => {
    expect(await block.textContent()).toBe(quote);
    const positions = await block.evaluate((node) => {
      const text = node.firstChild!,
        split = text.textContent!.indexOf("\n") + 1;
      const first = document.createRange(),
        second = document.createRange();
      first.setStart(text, 0);
      first.setEnd(text, 1);
      second.setStart(text, split);
      second.setEnd(text, split + 1);
      return {
        firstBottom: first.getBoundingClientRect().bottom,
        secondTop: second.getBoundingClientRect().top,
      };
    });
    expect(positions.secondTop).toBeGreaterThan(positions.firstBottom - 1);
  };
  await expectQuote(context.locator("blockquote"));
  const save = host.getByRole("button", { name: "Save comment", exact: true });
  const cancel = host.getByRole("button", {
    name: "Cancel comment",
    exact: true,
  });
  for (const button of [save, cancel]) {
    await button.scrollIntoViewIfNeeded();
    const readable = await button.evaluate((node) => {
      const text = node.firstChild!;
      const words = [...(text.textContent ?? "").matchAll(/\S+/g)];
      return words.every((word) => {
        const range = document.createRange();
        range.setStart(text, word.index!);
        range.setEnd(text, word.index! + word[0].length);
        return range.getClientRects().length === 1;
      });
    });
    expect(readable).toBe(true);
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual((await host.boundingBox())!.x);
    expect(box.x + box.width).toBeLessThanOrEqual(
      (await host.boundingBox())!.x + (await host.boundingBox())!.width,
    );
    expect(
      await shell.page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest("button")?.textContent,
        { x: box.x + box.width - 3, y: box.y + box.height / 2 },
      ),
    ).toContain(await button.textContent());
  }
  await host.screenshot({
    path: info.outputPath("review-source-inline-range.png"),
  });
  await tabTo(shell.page, save);
  await shell.page.keyboard.press("Enter");
  const card = host.getByLabel("Draft comment", { exact: true });
  await expect(card).toContainText("Private anchored draft");
  await expect(card.locator(".review-anchor-label")).toHaveText(
    " / Lines 35-36",
  );
  await expectQuote(card.locator("blockquote"));
  await expect(lastAnchor.locator("+ .review-comment")).toContainText(
    "Private anchored draft",
  );
  expect(await viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(
    100,
  );
  await card.focus();
  await card.press("Enter");
  await expect(pending).toBeFocused();
  await pending.fill("Recovered anchored edit");
  await resize(1280, 14);
  await expect(pending).toBeFocused();
  await expect(context).toBeVisible();
  await resize(800, 20);
  await shell.stop();
  await shell.start();
  await resize(800, 20);
  const restored = pane(review).getByRole("textbox", {
    name: "Comment",
    exact: true,
  });
  await expect(restored).toHaveValue("Recovered anchored edit");
  await expect(
    pane(review).locator(".review-comment-editor .review-anchor-context"),
  ).toContainText("Anchor A");
  expect(
    await pane(review)
      .locator(".review-comment-editor .review-anchor-context blockquote")
      .textContent(),
  ).toBe(quote);
  await tabTo(
    shell.page,
    pane(review).getByRole("button", { name: "Cancel comment", exact: true }),
  );
  await shell.page.keyboard.press("Enter");
  await expect(
    pane(review).getByLabel("Draft comment", { exact: true }),
  ).toContainText("Private anchored draft");
  expect((await inspect(review)).rounds[0].submission).toBeUndefined();
});

test("Document Review scrolls long lines at the bottom and opens comments from the gutter", async ({}, info) => {
  const lines = Array.from({ length: 75 }, (_, index) =>
    index === 3
      ? "Invented long review line ".repeat(40)
      : `Invented line ${index + 1}`,
  );
  await writeFile(shell.file, lines.join("\n"));
  const review = await open(await shell.create("Inline source review"));
  const host = pane(review);
  const viewport = host.locator(".review-body");
  const line = host.locator('[data-source-line="4"]');
  await expect(line).toContainText(lines[3]);
  const bounds = await viewport.evaluate((node) => ({
    width: node.clientWidth,
    scrollWidth: node.scrollWidth,
    height: node.clientHeight,
    scrollHeight: node.scrollHeight,
    bottom: node.getBoundingClientRect().bottom,
    paneBottom: node.parentElement!.getBoundingClientRect().bottom,
  }));
  expect(bounds.scrollWidth).toBeGreaterThan(bounds.width);
  expect(bounds.scrollHeight).toBeGreaterThan(bounds.height);
  expect(Math.abs(bounds.bottom - bounds.paneBottom)).toBeLessThanOrEqual(1);

  await line.hover({ position: { x: 35, y: 10 } });
  await host
    .getByRole("button", { name: "Add comment to line 4", exact: true })
    .click();
  const form = line.locator("+ .review-comment-editor");
  const comment = form.getByRole("textbox", { name: "Comment", exact: true });
  await expect(comment).toBeFocused();
  await comment.fill("Comment tied to the long line");
  await expect(form.locator("blockquote")).toHaveText(lines[3].trim());

  await viewport.evaluate((node) => {
    node.scrollLeft = 600;
  });
  expect(await viewport.evaluate((node) => node.scrollLeft)).toBeGreaterThan(
    300,
  );
  const save = form.getByRole("button", { name: "Save comment", exact: true });
  const button = (await save.boundingBox())!;
  const viewportBox = (await viewport.boundingBox())!;
  expect(button.x).toBeGreaterThanOrEqual(viewportBox.x);
  expect(button.x + button.width).toBeLessThanOrEqual(
    viewportBox.x + viewportBox.width,
  );
  const header = host.locator(".review-header");
  await expect(header.getByLabel("Round", { exact: true })).toBeVisible();
  expect(
    await header.evaluate((node) => {
      const { x, y } = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(x + 3, y + 3));
    }),
  ).toBe(true);
  await host.screenshot({
    path: info.outputPath("review-inline-horizontal.png"),
  });
  await save.click();
  const card = line.locator("+ .review-comment");
  await expect(card).toContainText("Comment tied to the long line");
  await expect(card.locator("blockquote")).toHaveText(lines[3].trim());
  await expect(
    host.getByRole("button", { name: "Send feedback" }),
  ).toBeVisible();
});

test("Review follows the current round, respects deliberate history, and preserves unfinished text", async ({}, info) => {
  const review = await open(await shell.create("Review revision selection"));
  const host = pane(review);
  const round = host.getByLabel("Round", { exact: true });
  const caption = round.locator("selectedcontent");
  await expect(round).toBeVisible();
  await expect(caption).toHaveText("Round 1");
  await round.focus();
  await shell.page.screenshot({
    path: info.outputPath("review-round-select.png"),
  });
  const refresh = async (text: string) => {
    const current = await inspect(review);
    await writeFile(shell.file, text + "\n");
    return shell.cli<{ currentRoundId: string }>(
      "review",
      "refresh",
      "--id",
      review.reviewId,
      "--expected-round",
      current.currentRoundId,
    );
  };
  await expect(round).toHaveValue(review.roundId);
  await source(review).focus();
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  const draft = host.getByRole("textbox", { name: "Comment", exact: true });
  await draft.fill("Unfinished text before refreshing");
  const second = await refresh("Second invented revision");
  await expect(round).toHaveValue(second.currentRoundId);
  await expect(caption).toHaveText("Round 2");
  await expect(source(review)).toContainText("Second invented revision");
  await expect(draft).toHaveValue("Unfinished text before refreshing");
  await expect(host.getByRole("status")).toContainText("older revision");
  const save = host.getByRole("button", { name: "Save comment", exact: true });
  await expect(save).toBeDisabled();
  await draft.fill("Updated unfinished text after refreshing");
  await expect(save).toBeDisabled();

  await round.selectOption(review.roundId);
  const third = await refresh("Third invented revision");
  await expect(round.locator("option")).toHaveCount(3);
  await expect(round).toHaveValue(review.roundId);
  await expect(caption).toHaveText("Round 1");
  await expect(source(review)).toContainText("first line");
  await expect(draft).toHaveValue("Updated unfinished text after refreshing");

  const shown = await shell.cli<{ roundId: string; paneId: string }>(
    "review",
    "show",
    "--id",
    review.reviewId,
  );
  expect(shown).toMatchObject({
    roundId: third.currentRoundId,
    paneId: review.paneId,
  });
  await expect(round).toHaveValue(third.currentRoundId);
  await expect(caption).toHaveText("Round 3");
  await expect(source(review)).toContainText("Third invented revision");
  await expect(draft).toHaveValue("Updated unfinished text after refreshing");
  await expect(save).toBeDisabled();

  await source(review).focus();
  await shell.page.keyboard.press(`${modifier}+Home`);
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  await expect(draft).toBeFocused();
  await expect(save).toBeEnabled();
  await save.click();
  const comment = host.getByLabel("Draft comment", { exact: true });
  await expect(comment).toContainText(
    "Updated unfinished text after refreshing",
  );
  await expect(comment.locator("blockquote")).toHaveText(
    "Third invented revision",
  );
  expect(await shell.prompts()).toHaveLength(0);
});

test("Cancel review leaves history and resolves waiters without delivering to a working chat", async () => {
  const workspace = await shell.create("Cancel review fixture");
  const chat = await shell.newChat(workspace, "kimi");
  await shell.send(chat.id, "[hold] continuing fixture");
  await expect
    .poll(async () => (await shell.inspect(chat.id)).status)
    .toBe("working");
  const document = await open(workspace);
  await comment(document, "Saved but never sent");
  const folder = shell.folders[0];
  const gitOptions = {
    cwd: folder,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  };
  execFileSync("git", ["add", "--", path.basename(shell.file)], gitOptions);
  execFileSync("git", ["commit", "-qm", "Invented baseline"], gitOptions);
  await writeFile(shell.file, "first line\nchanged diff fixture\nlast line\n");
  const diff = await shell.cli<Opened>(
    "review",
    "open-diff",
    "--workspace",
    workspace,
    "--repo-root",
    folder,
    "--conversation",
    chat.id,
  );
  const report = await shell.cli(
    "conversation",
    "report-status",
    "--id",
    chat.id,
    "--status",
    "review",
  );
  expect(report.taskStatus).toBe("review");
  const outside = await socketRequest({
    op: "review.cancel",
    id: document.reviewId,
    roundId: document.roundId,
    expectedVersion: (await inspect(document)).version,
  });
  expect(outside.ok).toBe(false);
  const conversation = async () =>
    (
      await shell.cli<Pick<AppState, "conversations">>("state")
    ).conversations.find((c) => c.id === chat.id)!;
  const show = async (review: Opened) => {
    const opened = await shell.cli<Opened>(
      "review",
      "show",
      "--id",
      review.reviewId,
    );
    review.paneId = opened.paneId;
  };
  const actions = (review: Opened) =>
    pane(review).getByRole("button", { name: "Review actions", exact: true });
  const cancelItem = () =>
    shell.page
      .getByRole("dialog", { name: "Actions", exact: true })
      .getByRole("button", { name: "Cancel review", exact: true });
  const round = (review: Opened) =>
    pane(review).getByRole("combobox", { name: "Round", exact: true });
  const cancelled = (review: Opened) => ({
    status: "cancelled",
    reviewId: review.reviewId,
    roundId: review.roundId,
  });

  await show(document);
  await source(document).focus();
  await shell.page.keyboard.press(`${modifier}+Shift+M`);
  const editor = pane(document).getByRole("textbox", {
    name: "Comment",
    exact: true,
  });
  await editor.fill("Unfinished separate comment");
  await actions(document).click();
  await cancelItem().click();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("Unfinished separate comment");
  await expect(pane(document).getByRole("status")).toContainText(
    "Save or cancel the unfinished comment",
  );
  expect((await inspect(document)).rounds[0].status).toBe("draft");
  await pane(document)
    .getByRole("button", { name: "Cancel comment", exact: true })
    .click();
  const waiter = waitProcess(document, document.roundId, 10000);
  await tabTo(shell.page, actions(document));
  await shell.page.keyboard.press("Enter");
  await shell.page.keyboard.press("ArrowDown");
  await expect(cancelItem()).toBeFocused();
  await shell.page.keyboard.press("Enter");

  const outcome = await waiter.result;
  expect(outcome.code, outcome.stderr).toBe(0);
  expect(JSON.parse(outcome.stdout)).toEqual(cancelled(document));
  await expect(round(document).locator("option:checked")).toHaveText(
    "Round 1 (cancelled)",
  );
  await expect(actions(document)).toBeFocused();
  await expect(
    pane(document).getByLabel("Unsent comment", { exact: true }),
  ).toContainText("Saved but never sent");
  await expect(source(document)).toContainText("selected review line");
  await expect(
    pane(document).getByRole("button", { name: "Send feedback", exact: true }),
  ).toBeHidden();
  expect(JSON.stringify(await inspect(document))).not.toContain(
    "Saved but never sent",
  );
  expect((await inspect(diff)).rounds[0].status).toBe("draft");
  expect((await conversation()).taskStatus).toBe("review");
  expect((await conversation()).status).toBe("working");

  for (const review of [document, diff]) {
    await shell.cli(
      "pane",
      "close",
      "--workspace",
      workspace,
      "--id",
      review.paneId,
    );
  }
  const overview = await shell.overview();
  const result = (review: Opened) =>
    overview.locator(
      `.overview-item[data-navigation-key="review:${review.reviewId}"]`,
    );
  await expect(result(document)).toHaveCount(0);
  await expect(result(diff)).toBeVisible();
  const showClosed = overview.getByRole("button", {
    name: "Show closed workspaces and cancelled reviews",
    exact: true,
  });
  await showClosed.click();
  await expect(result(document)).toHaveAccessibleName(/Cancelled/);
  await result(document).click({ button: "right" });
  await shell.page
    .getByRole("button", { name: "Open review", exact: true })
    .click();
  await expect
    .poll(async () => {
      const reopened = (await shell.workspace(workspace)).panes.find(
        (candidate) =>
          candidate.kind === "review" &&
          candidate.reviewId === document.reviewId,
      );
      if (reopened) document.paneId = reopened.id;
      return reopened?.id;
    })
    .toBeTruthy();
  await expect(round(document).locator("option:checked")).toHaveText(
    "Round 1 (cancelled)",
  );

  await shell.overview();
  await result(document).hover();
  await expect(overview.locator(".picker-footer")).toContainText("Close tab");
  await overview.getByRole("combobox").press(`${modifier}+w`);
  await expect(result(document)).toHaveCount(0);
  await expect(result(diff)).toBeVisible();
  await shell.page.keyboard.press("Escape");
  expect((await inspect(diff)).rounds[0].status).toBe("draft");

  await show(diff);
  await expect(
    pane(diff).getByRole("button", { name: "Approve", exact: true }),
  ).toBeEnabled();
  await actions(diff).click();
  await cancelItem().click();
  await expect(round(diff).locator("option:checked")).toHaveText(
    "Round 1 (cancelled)",
  );
  await expect(
    pane(diff).getByRole("button", { name: "Approve", exact: true }),
  ).toBeHidden();
  await expect
    .poll(async () => (await conversation()).taskStatus)
    .toBeUndefined();
  expect((await conversation()).status).toBe("working");
  expect(await shell.prompts()).toHaveLength(1);
  await shell.stop();
  await shell.start();
  await show(document);
  await expect(round(document).locator("option:checked")).toHaveText(
    "Round 1 (cancelled)",
  );
  await expect(
    pane(document).getByLabel("Unsent comment", { exact: true }),
  ).toContainText("Saved but never sent");
  expect((await conversation()).taskStatus).toBeUndefined();
  const reconnected = await waitProcess(diff, diff.roundId, 200).result;
  expect(reconnected.code, reconnected.stderr).toBe(0);
  expect(JSON.parse(reconnected.stdout)).toEqual(cancelled(diff));
  expect(await shell.prompts()).toHaveLength(1);
});
