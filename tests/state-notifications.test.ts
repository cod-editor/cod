import { test } from "node:test";
import assert from "node:assert/strict";
import { ApplicationStateStore } from "../src/application/state.ts";

test("A burst of provider changes publishes the latest snapshot without cloning every intermediate state", async () => {
  const store = new ApplicationStateStore("unused-notification-fixture");
  const observed: string[] = [];
  store.onDidChange = (state) => observed.push(state.activeWorkspaceId!);
  for (let index = 0; index < 1000; index++) {
    store.data.activeWorkspaceId = String(index);
    store.notify(true);
  }
  assert.equal(store.snapshot().activeWorkspaceId, "999");
  assert.equal(observed.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.deepEqual(observed, ["999"]);
  store.data.activeWorkspaceId = "user-action";
  store.notify(true);
  store.notify();
  assert.deepEqual(observed, ["999", "user-action"]);
  store.notify(true);
  store.closing = true;
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.deepEqual(observed, ["999", "user-action"]);
});
