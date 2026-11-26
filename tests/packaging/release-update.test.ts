import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkForReleaseUpdate,
  latestReleaseUpdate,
  packagedReleaseTag,
} from "../../src/release-update.ts";

function release(tag: string) {
  const name = `Cod-${tag.slice(1)}-macOS-arm64.dmg`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: tag.includes("-preview."),
    assets: [
      {
        name,
        state: "uploaded",
        size: 150_000_000,
        browser_download_url: `https://github.com/cod-editor/cod/releases/download/${tag}/${name}`,
      },
    ],
  };
}
const initial = "v0.4.0-preview.2";

test("only packaged Apple Silicon builds opt into release checks", () => {
  assert.equal(
    packagedReleaseTag(true, "darwin", "arm64", initial.slice(1)),
    initial,
  );
  assert.equal(
    packagedReleaseTag(false, "darwin", "arm64", initial.slice(1)),
    undefined,
  );
  assert.equal(
    packagedReleaseTag(true, "linux", "arm64", initial.slice(1)),
    undefined,
  );
  assert.equal(
    packagedReleaseTag(true, "darwin", "x64", initial.slice(1)),
    undefined,
  );
  assert.equal(packagedReleaseTag(true, "darwin", "arm64", "0.4.0"), "v0.4.0");
  assert.equal(
    packagedReleaseTag(true, "darwin", "arm64", "0.4.0-preview.02"),
    undefined,
  );
});

test("choose the newest published preview with the matching uploaded Apple Silicon asset", () => {
  const newest = release("v0.4.0-preview.12");
  const notPublished = { ...release("v0.5.0-preview.0"), draft: true };
  const notPreview = { ...release("v0.6.0-preview.0"), prerelease: false };
  const noDiskImage = { ...release("v0.7.0-preview.0"), assets: [] };
  assert.deepEqual(
    latestReleaseUpdate(initial, [
      release("v0.4.0-preview.9"),
      notPublished,
      newest,
      noDiskImage,
      release("v0.4.0-preview.10"),
      notPreview,
      release("v0.4.0-preview.013"),
    ]),
    {
      version: "0.4.0-preview.12",
      downloadUrl: newest.assets[0].browser_download_url,
    },
  );
  assert.equal(
    latestReleaseUpdate(initial, [
      release(initial),
      release("v0.3.99-preview.100"),
    ]),
    undefined,
  );
  assert.equal(
    latestReleaseUpdate("v0.9.99-preview.100", [release("v0.10.0-preview.0")])
      ?.version,
    "0.10.0-preview.0",
  );
});

test("stable release discovery excludes previews and inconsistent release tags", () => {
  const stable = release("v0.4.1");
  assert.deepEqual(
    latestReleaseUpdate("v0.4.0", [
      release("v0.4.0"),
      release("v0.7.0-preview.1"),
      release("v0.5.00"),
      release("v0.6.0\n"),
      { ...release("v0.6.0"), prerelease: true },
      { ...release("v0.5.0"), draft: true },
      stable,
    ]),
    { version: "0.4.1", downloadUrl: stable.assets[0].browser_download_url },
  );
});

test("preview discovery includes stable releases in version order", () => {
  const stable = release("v0.4.0");
  assert.deepEqual(
    latestReleaseUpdate(initial, [stable, release("v0.4.0-preview.999")]),
    { version: "0.4.0", downloadUrl: stable.assets[0].browser_download_url },
  );
  assert.equal(
    latestReleaseUpdate(initial, [release("v0.5.0-preview.0"), stable])
      ?.version,
    "0.5.0-preview.0",
  );
});

test("reject misleading release links and incomplete or wrong-platform disk images", () => {
  const candidate = release("v9.0.0-preview.1");
  const asset = candidate.assets[0];
  for (const change of [
    { name: asset.name.replace("arm64", "x64") },
    { state: "starter" },
    { size: 0 },
    {
      browser_download_url: asset.browser_download_url.replace(
        "github.com",
        "untrusted.invalid",
      ),
    },
    {
      browser_download_url: asset.browser_download_url.replace(
        "cod-editor/cod",
        "someone-else/cod",
      ),
    },
    {
      browser_download_url:
        asset.browser_download_url + "?redirect=https://untrusted.invalid/",
    },
  ]) {
    assert.equal(
      latestReleaseUpdate(initial, [
        { ...candidate, assets: [{ ...asset, ...change }] },
      ]),
      undefined,
    );
  }
});

test("the release request stays on the fixed unauthenticated feed and handles bounded failures", async () => {
  const stop = new AbortController();
  const respond = (body: unknown) => async () => Response.json(body);
  assert.equal(
    (
      await checkForReleaseUpdate(
        initial,
        stop.signal,
        respond([release("v0.5.0-preview.1")]),
      )
    )?.version,
    "0.5.0-preview.1",
  );
  await checkForReleaseUpdate(initial, stop.signal, async (url, options) => {
    assert.equal(
      url,
      "https://api.github.com/repos/cod-editor/cod/releases?per_page=30",
    );
    assert.equal(options?.redirect, "error");
    assert.deepEqual(options?.headers, {
      Accept: "application/vnd.github+json",
    });
    stop.abort();
    assert.ok(options?.signal?.aborted);
    return Response.json([]);
  });
  const signal = new AbortController().signal;
  await assert.rejects(
    checkForReleaseUpdate(
      initial,
      signal,
      async () => new Response("", { status: 403 }),
    ),
    /unavailable/,
  );
  await assert.rejects(
    checkForReleaseUpdate(initial, signal, respond({ message: "bad feed" })),
    /metadata/,
  );
  await assert.rejects(
    checkForReleaseUpdate(initial, signal, respond("a".repeat(1024 * 1024))),
    /too large/,
  );
  await assert.rejects(
    checkForReleaseUpdate(initial, signal, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
});
