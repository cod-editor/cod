import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApplicationStateStore } from "../../src/application/state.ts";

test("rapid edits save the latest draft once with large history and retain operation ordering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cod-drafts-"));
  try {
    const store = new ApplicationStateStore(root);
    await store.load();
    // Equivalent persistence load to a long session, using invented text only.
    Object.assign(store.data, {
      inventedHistory: "fixture-history ".repeat(1_600_000),
    });
    let writes = 0;
    const persist = store.persist.bind(store);
    store.persist = async () => {
      writes++;
      await persist();
    };
    let text = "";
    const edits = Array.from({ length: 100 }, (_, i) =>
      store.changeDraft("composer", () => {
        text = `draft-${i}`;
        Object.assign(store.data, { inventedDraft: text });
        return text;
      }),
    );
    await Promise.all(edits);
    assert.equal(text, "draft-99");
    assert.equal(writes, 1);
    assert.equal(
      JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))
        .inventedDraft,
      text,
    );
    const order: string[] = [];
    const first = store.changeDraft("composer", () => {
      order.push("before-send");
    });
    const barrier = store.change(() => {
      order.push("send");
    });
    const last = store.changeDraft("composer", () => {
      order.push("after-send");
    });
    await Promise.all([first, barrier, last]);
    assert.deepEqual(order, ["before-send", "send", "after-send"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coalesced draft failure rejects pending callers and rolls back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cod-draft-failure-"));
  try {
    const store = new ApplicationStateStore(root);
    await store.load();
    store.persist = async () => {
      throw new Error("disk unavailable");
    };
    const first = store.changeDraft("composer", () => {
      store.data.activeWorkspaceId = "old";
    });
    const last = store.changeDraft("composer", () => {
      store.data.activeWorkspaceId = "latest";
    });
    const results = await Promise.allSettled([first, last]);
    assert.ok(results.every((result) => result.status === "rejected"));
    assert.equal(store.data.activeWorkspaceId, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
