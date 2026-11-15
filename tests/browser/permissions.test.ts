import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { SitePermissions } from "../../src/browser/permissions.ts";
import type {
  SitePolicy,
  SiteRequest,
} from "../../src/browser/permission-types.ts";
test("Permission policy distinguishes requesting/embedding origins and invalidates pending page grants", async () => {
  let check: any, request: any;
  const session = {
    setPermissionCheckHandler(handler: any) {
      check = handler;
    },
    setPermissionRequestHandler(handler: any) {
      request = handler;
    },
  };
  const contents = Object.assign(new EventEmitter(), {
    id: 1,
    getURL: () => "https://top.invalid/page",
  });
  const policies: SitePolicy[] = [];
  let pending: SiteRequest[] = [];
  const answers: boolean[] = [];
  const permissions = new SitePermissions({
    session: session as any,
    owner: () => "browser",
    policies: () => policies,
    save: async (policy) => {
      policies.push(policy);
    },
    changed: (items) => {
      pending = items;
    },
    denied: () => {},
  });
  const details = {
    requestingUrl: "https://frame.invalid/view",
    isMainFrame: false,
    mediaTypes: ["video"],
  };
  request(
    contents,
    "media",
    (allowed: boolean) => answers.push(allowed),
    details,
  );
  assert.equal(pending[0].origin, "https://frame.invalid");
  await permissions.answer(pending[0].id, "allow");
  assert.deepEqual(answers, [true]);
  assert.equal(
    check(contents, "media", "https://frame.invalid", { mediaType: "video" }),
    true,
  );
  assert.equal(
    check(contents, "media", "https://frame.invalid", { mediaType: "audio" }),
    false,
  );
  assert.equal(
    check(contents, "media", "https://other.invalid", { mediaType: "video" }),
    false,
  );
  request(
    contents,
    "geolocation",
    (allowed: boolean) => answers.push(allowed),
    details,
  );
  const id = pending[0].id;
  contents.emit("did-start-navigation");
  assert.equal(pending.length, 0);
  assert.deepEqual(answers, [true, false]);
  await assert.rejects(permissions.answer(id, "allow"));
  request(
    contents,
    "notifications",
    (allowed: boolean) => answers.push(allowed),
    { requestingUrl: "file:///private", isMainFrame: true },
  );
  assert.equal(answers.at(-1), false);
  permissions.dispose();
  assert.equal(
    check(contents, "media", "https://frame.invalid", { mediaType: "video" }),
    false,
  );
});
