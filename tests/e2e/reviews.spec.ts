import { test, expect, type Locator } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { writeFile, realpath, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ChatApp, type Provider } from "./helpers/chat-fixture/harness";
import { tabTo } from "./helpers/workspace-app";
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
const line = (review: Opened, number: number) =>
  pane(review).getByRole("button", { name: `Line ${number}`, exact: true });
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
  target: Locator = line(review, 2),
) {
  // Review source is one roving Tab stop; arrows reach an anchored line.
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
  await shell.page.keyboard.press("Alt+Enter");
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
    await expect(
      pane(review).getByRole("heading", {
        name: `Old: ${canonicalFile}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      pane(review).getByRole("heading", {
        name: `New: ${await realpath(secondFile)}`,
        exact: true,
      }),
    ).toBeVisible();
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

test("Review closed panes reopen from workspace panel and private drafts protect workspace closure", async () => {
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
  const row = shell.page.getByRole("treeitem", {
    name: "spec.md",
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
  await tabTo(shell.page, line(review, 1));
  await shell.page.keyboard.press("Shift+ArrowDown");
  await shell.page.keyboard.press("Alt+Enter");
  await shell.page.keyboard.type("Range comment");
  await pane(review)
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  const comments = pane(review).getByLabel("Draft comment", { exact: true });
  await expect(line(review, 1)).toContainText("first line");
  await expect(line(review, 2)).toContainText("selected review line");
  await comments.click();
  await pane(review)
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Edited range comment");
  await pane(review)
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect(comments).toContainText("Edited range comment");
  await expect(line(review, 1)).toHaveAttribute("aria-pressed", "true");
  await expect(line(review, 2)).toHaveAttribute("aria-pressed", "true");
  await writeFile(shell.file, "changed externally\n");
  await expect(pane(review).getByRole("status")).toContainText(
    "Changed on disk",
  );
  await expect(line(review, 1)).toContainText("first line");
  await expect(line(review, 2)).toContainText("selected review line");
  await pane(review).screenshot({
    path: testInfo.outputPath("review-keyboard-range.png"),
  });
});

test("Review unfinished comment editor survives immediate restart without publishing", async () => {
  const workspace = await shell.create("Unfinished private review");
  const review = await open(workspace);
  await line(review, 2).focus();
  await shell.page.keyboard.press("Alt+Enter");
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
