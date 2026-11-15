import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApplicationStateStore } from "../../src/application/state.ts";
import type { WorkspaceState } from "../../src/types";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cod-drafts-"));
  const store = new ApplicationStateStore(root);
  await store.load();
  store.data.workspaces.push({
    id: "w",
    name: "Fixture",
    folders: [],
    panes: [{ id: "p", kind: "document", draftChat: true }],
    activePaneId: "p",
    layout: { type: "leaf", paneId: "p" },
    chatDrafts: {
      p: {
        text: "original",
        images: [{ mimeType: "image/png", data: "fixture" }],
      },
    },
  } as unknown as WorkspaceState);
  Object.assign(store.data, {
    inventedHistory: "fixture-history ".repeat(1_600_000),
  });
  await store.persist();
  return {
    root,
    store,
    edit: (text: string) =>
      store.changeDraft("composer", () => {
        const workspace = store.data.workspaces[0];
        workspace.chatDrafts!.p = { ...workspace.chatDrafts!.p, text };
        return text;
      }),
  };
}
test("rapid edits never rewrite or clone large history, remain durable and preserve ordering", async () => {
  const { root, store, edit } = await fixture();
  try {
    const original = await readFile(path.join(root, "state.json"), "utf8");
    let snapshots = 0;
    const snapshot = store.snapshot.bind(store);
    store.snapshot = () => {
      snapshots++;
      return snapshot();
    };
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => edit(`draft-${i}`)),
    );
    assert.equal(snapshots, 0);
    assert.equal(
      await readFile(path.join(root, "state.json"), "utf8"),
      original,
    );
    const overlay = await readFile(
      path.join(root, "composer-text.json"),
      "utf8",
    );
    assert.ok(overlay.length < 1000);
    assert.ok(!overlay.includes("images"));
    const restarted = new ApplicationStateStore(root);
    await restarted.load();
    assert.equal(restarted.data.workspaces[0].chatDrafts!.p.text, "draft-99");
    assert.equal(
      restarted.data.workspaces[0].chatDrafts!.p.images![0].data,
      "fixture",
    );
    const first = edit("before-send");
    const barrier = store.change(() => {
      store.data.workspaces[0].chatDrafts!.p = { text: "sent-and-cleared" };
    });
    const last = edit("after-send");
    await Promise.all([first, barrier, last]);
    const final = new ApplicationStateStore(root);
    await final.load();
    assert.equal(final.data.workspaces[0].chatDrafts!.p.text, "after-send");
    await store.change(() => {
      store.data.workspaces[0].chatDrafts!.p = { text: "" };
    });
    const cleared = new ApplicationStateStore(root);
    await cleared.load();
    assert.equal(cleared.data.workspaces[0].chatDrafts!.p.text, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("draft write failure rejects all pending callers and retains the original draft", async () => {
  const { root, store, edit } = await fixture();
  try {
    await mkdir(path.join(root, "composer-text.json"));
    const results = await Promise.allSettled([edit("first"), edit("latest")]);
    assert.ok(results.every((result) => result.status === "rejected"));
    assert.equal(store.data.workspaces[0].chatDrafts!.p.text, "original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
