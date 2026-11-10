import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewService } from "../../src/reviews/index.ts";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
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
async function fixture(
  run: (value: {
    root: string;
    file: string;
    data: string;
    make: (maxStorageBytes?: number) => ReviewService;
  }) => Promise<void>,
) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "cod-review-")));
  const root = join(temp, "repo"),
    data = join(temp, "private");
  await mkdir(root);
  const file = join(root, "spec.md");
  await writeFile(file, "first\nselected line\nlast\n");
  const make = (maxStorageBytes?: number) =>
    new ReviewService({
      dataDirectory: data,
      workspaceFolders: async (id: string) => {
        if (id !== "workspace") throw new Error("Unknown workspace");
        return [root];
      },
      conversationWorkspace: async (id: string) =>
        id === "target"
          ? "workspace"
          : id === "other"
            ? "elsewhere"
            : undefined,
      maxStorageBytes,
    });
  try {
    await run({ root, file, data, make });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("R1 immutable document snapshots, private drafts, version checks and restart", () =>
  fixture(async ({ file, data, make }) => {
    const service = make();
    const review = await service.openDocument({
      workspaceId: "workspace",
      path: file,
    });
    const added = await service.addComment({
      id: review.id,
      roundId: review.currentRoundId,
      expectedVersion: review.version,
      body: "PRIVATE_DRAFT_MARKER",
      range: { startLine: 2, endLine: 2 },
    });
    assert(
      !JSON.stringify(await service.inspect(review.id)).includes(
        "PRIVATE_DRAFT_MARKER",
      ),
    );
    assert(!JSON.stringify(await service.list()).includes("selected line"));
    await assert.rejects(() =>
      service.addComment({
        id: review.id,
        roundId: review.currentRoundId,
        expectedVersion: review.version,
        body: "stale",
        range: { startLine: 1, endLine: 1 },
      }),
    );
    await writeFile(file, "changed\n");
    assert.equal((await service.changed(review.id)).changed, true);
    const restarted = make();
    const detail = await restarted.detail(review.id);
    assert.equal(detail.rounds[0].comments[0].body, "PRIVATE_DRAFT_MARKER");
    assert.equal(
      detail.snapshots[review.snapshotId].text,
      "first\nselected line\nlast\n",
    );
    assert.equal(detail.version, added.version);
    assert.equal((await stat(join(data, "reviews"))).mode & 0o077, 0);
    assert.equal(
      (await stat(join(data, "reviews/state.json"))).mode & 0o077,
      0,
    );
    await rm(file);
    assert.equal((await restarted.changed(review.id)).unavailable, true);
    assert.equal(
      (await restarted.detail(review.id)).snapshots[review.snapshotId].text,
      "first\nselected line\nlast\n",
    );
  }));

test("R2 refresh retains outdated anchors and reanchor history with exact saved-text changes", () =>
  fixture(async ({ file, make }) => {
    const service = make();
    let review = await service.openDocument({
      workspaceId: "workspace",
      path: file,
    });
    review = await service.addComment({
      id: review.id,
      roundId: review.currentRoundId,
      expectedVersion: review.version,
      body: "draft",
      range: { startLine: 2, endLine: 2 },
    });
    const original = await service.detail(review.id);
    await writeFile(file, "inserted\nfirst\nselected line\nlast\n");
    const refreshed = await service.refresh({
      id: review.id,
      expectedRoundId: review.currentRoundId,
      expectedVersion: review.version,
    });
    assert.notEqual(refreshed.currentRoundId, review.currentRoundId);
    const detail = await service.detail(review.id);
    assert.equal(detail.rounds[1].comments[0].outdated, true);
    assert.equal(
      detail.rounds[1].comments[0].anchor.snapshotId,
      review.snapshotId,
    );
    const comment = detail.rounds[1].comments[0];
    await service.reanchorComment({
      id: review.id,
      roundId: refreshed.currentRoundId,
      expectedVersion: refreshed.version,
      commentId: comment.id,
      range: { startLine: 3, endLine: 3 },
    });
    const final = await service.detail(review.id);
    assert.equal(final.rounds[1].comments[0].outdated, false);
    assert.deepEqual(
      final.rounds[1].comments[0].history[0],
      original.rounds[0].comments[0].anchor,
    );
    assert.deepEqual(final.rounds[0], original.rounds[0]);
    const changes = await service.documentChanges(review.id);
    assert.equal(changes.before, "first\nselected line\nlast\n");
    assert.equal(changes.after, "inserted\nfirst\nselected line\nlast\n");
    assert(
      changes.changes.some(
        (change) =>
          change.type === "insert" &&
          change.lines.join("").includes("inserted"),
      ),
    );
    await assert.rejects(() =>
      service.refresh({
        id: review.id,
        expectedRoundId: review.currentRoundId,
        expectedVersion: final.version,
      }),
    );
  }));

test("R3 real Git diff anchors validate old/new deleted lines and resolved branch identities", () =>
  fixture(async ({ root, file, make }) => {
    git(root, "init", "-b", "main");
    git(root, "add", "--all");
    git(root, "commit", "-m", "fixture");
    const base = git(root, "rev-parse", "HEAD");
    await writeFile(file, "first\nreplacement\nlast\n");
    git(root, "add", "--all");
    git(root, "commit", "-m", "changed");
    const head = git(root, "rev-parse", "HEAD");
    const service = make();
    let review = await service.openDiff({
      workspaceId: "workspace",
      repoRoot: root,
      base,
      head,
    });
    const detail = await service.detail(review.id);
    assert.equal(detail.snapshots[review.snapshotId].base, base);
    assert.equal(detail.snapshots[review.snapshotId].head, head);
    review = await service.addComment({
      id: review.id,
      roundId: review.currentRoundId,
      expectedVersion: review.version,
      body: "old side",
      range: { path: file, side: "old", startLine: 2, endLine: 2 },
    });
    const comment = (await service.detail(review.id)).rounds[0].comments[0];
    assert.equal(comment.quote, "selected line");
    await assert.rejects(() =>
      service.addComment({
        id: review.id,
        roundId: review.currentRoundId,
        expectedVersion: review.version,
        body: "invalid range",
        range: { path: file, side: "new", startLine: 200, endLine: 200 },
      }),
    );
    await assert.rejects(() =>
      service.openDiff({
        workspaceId: "workspace",
        repoRoot: root,
        base: "--help",
        head,
      }),
    );
  }));

test("R4 durable idempotent submissions and guarded dispatch recovery never resend uncertain work", () =>
  fixture(async ({ file, make }) => {
    let service = make();
    let review = await service.openDocument({
      workspaceId: "workspace",
      path: file,
    });
    review = await service.addComment({
      id: review.id,
      roundId: review.currentRoundId,
      expectedVersion: review.version,
      body: "submitted feedback",
      range: { startLine: 2, endLine: 2 },
    });
    const args = {
      id: review.id,
      roundId: review.currentRoundId,
      expectedVersion: review.version,
      conversationId: "target",
      requestId: "request-fixture",
    };
    await assert.rejects(() =>
      service.submit({ ...args, conversationId: "other" }),
    );
    const submitted = await service.submit(args);
    assert.equal(submitted.delivery.status, "queued");
    assert(submitted.envelope.includes("submitted feedback"));
    assert(submitted.envelope.includes("selected line"));
    assert.deepEqual(await service.submit(args), submitted);
    await assert.rejects(() =>
      service.submit({ ...args, conversationId: "missing" }),
    );
    assert(
      JSON.stringify(await service.inspect(review.id)).includes(
        "submitted feedback",
      ),
    );
    await assert.rejects(async () =>
      service.editComment({
        id: review.id,
        roundId: review.currentRoundId,
        expectedVersion: (await service.inspect(review.id)).version,
        commentId: "unknown",
        body: "overwrite",
      }),
    );
    const target = {
      id: review.id,
      roundId: review.currentRoundId,
      submissionId: submitted.id,
    };
    await service.markDispatching(target);
    await assert.rejects(() => service.markDispatching(target));
    service = make();
    assert.equal(
      (await service.inspect(review.id)).rounds[0].submission!.delivery.status,
      "uncertain",
    );
    await assert.rejects(() => service.markDispatching(target));
    await service.acknowledge({
      ...target,
      receipt: { nativeId: "invented-native", turnId: "invented-turn" },
    });
    await service.acknowledge({
      ...target,
      receipt: { nativeId: "invented-native", turnId: "invented-turn" },
    });
    await assert.rejects(() =>
      service.acknowledge({ ...target, receipt: { nativeId: "other" } }),
    );
    assert.equal(
      (await make().inspect(review.id)).rounds[0].submission!.delivery.status,
      "acknowledged",
    );
  }));

test("R5 invalid anchors, binary/oversized documents and quota failures preserve previous committed state", () =>
  fixture(async ({ root, file, data, make }) => {
    const service = make(12000);
    const review = await service.openDocument({
      workspaceId: "workspace",
      path: file,
    });
    const before = await readFile(join(data, "reviews/state.json"), "utf8");
    await assert.rejects(() =>
      service.addComment({
        id: review.id,
        roundId: review.currentRoundId,
        expectedVersion: review.version,
        body: "x".repeat(15000),
        range: { startLine: 1, endLine: 1 },
      }),
    );
    assert.equal(
      await readFile(join(data, "reviews/state.json"), "utf8"),
      before,
    );
    await assert.rejects(() =>
      service.addComment({
        id: review.id,
        roundId: review.currentRoundId,
        expectedVersion: review.version,
        body: "bad",
        range: { startLine: 0, endLine: 1 },
      }),
    );
    await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
    await assert.rejects(() =>
      service.openDocument({
        workspaceId: "workspace",
        path: join(root, "binary"),
      }),
    );
    await writeFile(join(root, "large"), "x".repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(() =>
      service.openDocument({
        workspaceId: "workspace",
        path: join(root, "large"),
      }),
    );
    await writeFile(join(data, "outside.txt"), "invented outside target");
    await assert.rejects(() =>
      service.openDocument({
        workspaceId: "workspace",
        path: join(data, "outside.txt"),
      }),
    );
    assert.equal((await make().list()).length, 1);
  }));

test("R6 real renamed Unicode paths and header-looking deleted lines retain correct diff-side anchors", () =>
  fixture(async ({ root, make }) => {
    git(root, "init", "-b", "main");
    const old = join(root, "old ü name.txt"),
      next = join(root, "new ü name.txt");
    await writeFile(
      old,
      "-- looks like header\nunchanged a\nunchanged b\nunchanged c\nunchanged d\n",
    );
    git(root, "add", "--all");
    git(root, "commit", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    git(root, "mv", "--", "old ü name.txt", "new ü name.txt");
    await writeFile(
      next,
      "++ replacement header\nunchanged a\nunchanged b\nunchanged c\nunchanged d\n",
    );
    git(root, "add", "--all");
    git(root, "commit", "-m", "rename");
    const service = make();
    let review = await service.openDiff({
      workspaceId: "workspace",
      repoRoot: root,
      base,
      head: "HEAD",
    });
    const snap = (await service.detail(review.id)).snapshots[review.snapshotId];
    assert(
      snap.files.some((file) => file.oldPath === old && file.newPath === next),
    );
    review = await service.addComment({
      id: review.id,
      roundId: review.currentRoundId,
      expectedVersion: review.version,
      body: "deleted line",
      range: { path: old, side: "old", startLine: 1, endLine: 1 },
    });
    review = await service.addComment({
      id: review.id,
      roundId: review.currentRoundId,
      expectedVersion: review.version,
      body: "new line",
      range: { path: next, side: "new", startLine: 1, endLine: 1 },
    });
    const comments = (await service.detail(review.id)).rounds[0].comments;
    assert.deepEqual(
      comments.map((comment) => comment.quote),
      ["-- looks like header", "++ replacement header"],
    );
  }));

test("R7 concurrent stale mutations cannot overwrite committed drafts and process restart recovers dispatch conservatively", () =>
  fixture(async ({ root, file, data, make }) => {
    const service = make();
    const review = await service.openDocument({
      workspaceId: "workspace",
      path: file,
    });
    const attempts = await Promise.allSettled(
      ["first draft", "second draft"].map((body) =>
        service.addComment({
          id: review.id,
          roundId: review.currentRoundId,
          expectedVersion: review.version,
          body,
          range: { startLine: 1, endLine: 1 },
        }),
      ),
    );
    assert.equal(
      attempts.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal((await make().detail(review.id)).rounds[0].comments.length, 1);
    const moduleURL = new URL("../../src/reviews/index.ts", import.meta.url)
      .href;
    const childSource = `import {ReviewService} from ${JSON.stringify(moduleURL)}; const service=new ReviewService({dataDirectory:${JSON.stringify(data)},workspaceFolders:async()=>[${JSON.stringify(root)}],conversationWorkspace:async()=>"workspace"});const summary=await service.inspect(${JSON.stringify(review.id)});const submission=await service.submit({id:summary.id,roundId:summary.currentRoundId,expectedVersion:summary.version,conversationId:"target",requestId:"process-crash-fixture"});await service.markDispatching({id:summary.id,roundId:summary.currentRoundId,submissionId:submission.id});process.exit(0);`;
    execFileSync(process.execPath, ["--input-type=module", "-e", childSource], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const recovered = await make().inspect(review.id);
    assert.equal(recovered.rounds[0].submission!.delivery.status, "uncertain");
    assert.equal(
      (await make().inspect(review.id)).rounds[0].submission!.id,
      recovered.rounds[0].submission!.id,
    );
  }));

test("R8 near-quota dispatch recovery remains readable without raising the storage bound or losing drafts", () =>
  fixture(async ({ file, data, make }) => {
    let service = make();
    let review = await service.openDocument({
      workspaceId: "workspace",
      path: file,
    });
    review = await service.addComment({
      id: review.id,
      roundId: review.currentRoundId,
      expectedVersion: review.version,
      body: "submitted fixture",
      range: { startLine: 1, endLine: 1 },
    });
    const submission = await service.submit({
      id: review.id,
      roundId: review.currentRoundId,
      expectedVersion: review.version,
      conversationId: "target",
      requestId: "near-quota",
    });
    let draft = await service.openDocument({
      workspaceId: "workspace",
      path: file,
    });
    draft = await service.addComment({
      id: draft.id,
      roundId: draft.currentRoundId,
      expectedVersion: draft.version,
      body: "PRIVATE_QUOTA_DRAFT",
      range: { startLine: 2, endLine: 2 },
    });
    const stored = JSON.parse(
      await readFile(join(data, "reviews/state.json"), "utf8"),
    );
    stored.reviews[review.id].rounds[0].submission.delivery = {
      status: "dispatching",
    };
    stored.reviews[review.id].version++;
    const quota = Buffer.byteLength(JSON.stringify(stored));
    service = make(quota);
    await service.markDispatching({
      id: review.id,
      roundId: review.currentRoundId,
      submissionId: submission.id,
    });
    assert.equal((await stat(join(data, "reviews/state.json"))).size, quota);
    const recovered = make(quota);
    assert.equal(
      (await recovered.inspect(review.id)).rounds[0].submission!.delivery
        .status,
      "uncertain",
    );
    assert.equal(
      (await recovered.detail(draft.id)).rounds[0].comments[0].body,
      "PRIVATE_QUOTA_DRAFT",
    );
    assert((await stat(join(data, "reviews/state.json"))).size <= quota);
    assert.equal(
      (await make(quota).inspect(review.id)).rounds[0].submission!.delivery
        .status,
      "uncertain",
    );
  }));

test("R9 repository diff-prefix configuration cannot corrupt immutable anchor paths", () =>
  fixture(async ({ root, make }) => {
    git(root, "init", "-b", "main");
    const file = join(root, "file.txt");
    await writeFile(file, "old line\n");
    git(root, "add", "--all");
    git(root, "commit", "-m", "base");
    git(root, "config", "diff.noprefix", "true");
    await writeFile(file, "new line\n");
    const config = await readFile(join(root, ".git/config"), "utf8");
    const service = make();
    let review = await service.openDiff({
      workspaceId: "workspace",
      repoRoot: root,
    });
    const snapshot = (await service.detail(review.id)).snapshots[
      review.snapshotId
    ];
    assert.equal(snapshot.files[0].oldPath, file);
    assert.equal(snapshot.files[0].newPath, file);
    review = await service.addComment({
      id: review.id,
      roundId: review.currentRoundId,
      expectedVersion: review.version,
      body: "anchored",
      range: { path: file, side: "new", startLine: 1, endLine: 1 },
    });
    assert.equal(
      (await service.detail(review.id)).rounds[0].comments[0].quote,
      "new line",
    );
    assert.equal(await readFile(join(root, ".git/config"), "utf8"), config);
  }));

test("R10 real working-tree quoted paths retain Unicode, quotes and filename whitespace", () =>
  fixture(async ({ root, make }) => {
    git(root, "init", "-b", "main");
    const names = ["same ü file.txt", 'literal "🌱 name.txt', "trailing ü "];
    for (const name of names)
      await writeFile(join(root, name), "old fixture\n");
    git(root, "add", "--all");
    git(root, "commit", "-m", "quoted baseline");
    for (const name of names)
      await writeFile(join(root, name), "new fixture\n");
    const service = make();
    for (const quoting of ["true", "false"]) {
      git(root, "config", "core.quotepath", quoting);
      let review = await service.openDiff({
        workspaceId: "workspace",
        repoRoot: root,
      });
      const snapshot = (await service.detail(review.id)).snapshots[
        review.snapshotId
      ];
      assert.deepEqual(
        snapshot.files.map((file) => file.oldPath).sort(),
        names.map((name) => join(root, name)).sort(),
      );
      assert.deepEqual(
        snapshot.files.map((file) => file.newPath).sort(),
        names.map((name) => join(root, name)).sort(),
      );
      for (const name of names)
        review = await service.addComment({
          id: review.id,
          roundId: review.currentRoundId,
          expectedVersion: review.version,
          body: "exact quoted path",
          range: {
            path: join(root, name),
            side: "new",
            startLine: 1,
            endLine: 1,
          },
        });
      assert.equal(
        (await service.detail(review.id)).rounds[0].comments.length,
        names.length,
      );
    }
  }));

test("review origin persists and rejects alternate delivery destination", () =>
  fixture(async ({ file, make }) => {
    const service = make();
    const review = await service.openDocument({
      workspaceId: "workspace",
      path: file,
      originConversationId: "target",
    });
    assert.equal(
      (await make().inspect(review.id)).originConversationId,
      "target",
    );
    await assert.rejects(
      service.submit({
        id: review.id,
        roundId: review.currentRoundId,
        expectedVersion: review.version,
        conversationId: "other",
        requestId: "origin-test",
      }),
      /originating/,
    );
  }));
