import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReleaseInstaller } from "../../src/release-install.ts";
import {
  checkForReleaseUpdate,
  latestReleaseUpdate,
  packagedReleaseTag,
  pollReleaseUpdates,
  releaseImage,
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
      size: newest.assets[0].size,
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
    {
      version: "0.4.1",
      downloadUrl: stable.assets[0].browser_download_url,
      size: stable.assets[0].size,
    },
  );
});

test("stable notices work without a sidecar and accept only the asset digest for automatic verification", () => {
  const existing = release("v0.4.1");
  const diskImage = existing.assets[0];
  existing.assets.unshift({
    ...diskImage,
    name: `${diskImage.name}.sha256`,
    size: 94,
    browser_download_url: `${diskImage.browser_download_url}.sha256`,
  });
  const next = release("v0.4.2");

  assert.deepEqual(latestReleaseUpdate("v0.4.0", [existing]), {
    version: "0.4.1",
    downloadUrl: diskImage.browser_download_url,
    size: diskImage.size,
  });
  assert.deepEqual(latestReleaseUpdate("v0.4.0", [existing, next]), {
    version: "0.4.2",
    downloadUrl: next.assets[0].browser_download_url,
    size: next.assets[0].size,
  });
  Object.assign(next.assets[0], { digest: `sha256:${"a".repeat(64)}` });
  assert.equal(latestReleaseUpdate("v0.4.1", [next])?.sha256, "a".repeat(64));
  Object.assign(next.assets[0], { digest: `sha512:${"a".repeat(64)}` });
  assert.equal(latestReleaseUpdate("v0.4.1", [next])?.sha256, undefined);
});

test("preview discovery includes stable releases in version order", () => {
  const stable = release("v0.4.0");
  assert.deepEqual(
    latestReleaseUpdate(initial, [stable, release("v0.4.0-preview.999")]),
    {
      version: "0.4.0",
      downloadUrl: stable.assets[0].browser_download_url,
      size: stable.assets[0].size,
    },
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

const file = "An invented Cod update download.";
const version = "0.4.1";
const update = {
  version,
  downloadUrl: releaseImage(version).downloadUrl,
  size: Buffer.byteLength(file),
  sha256: createHash("sha256").update(file).digest("hex"),
};
const signal = () => new AbortController().signal;
async function installerFixture(context: TestContext) {
  const profile = await mkdtemp(path.join(tmpdir(), "cod-update-fixture-"));
  context.after(() => rm(profile, { recursive: true, force: true }));
  const storage = path.join(profile, "release-updates");
  const checked: string[] = [];
  const opened: string[] = [];
  const ejected: string[] = [];
  let busy = false;
  const desktop = {
    async quarantine(image: string, downloadUrl: string) {
      assert.equal(downloadUrl, update.downloadUrl);
      assert.equal(await readFile(image, "utf8"), file);
      checked.push(image);
    },
    async open(image: string) {
      assert.equal(await readFile(image, "utf8"), file);
      opened.push(image);
    },
    async isMounted() {
      return busy;
    },
    async eject(image: string) {
      ejected.push(image);
      return !busy;
    },
  };
  return {
    profile,
    storage,
    desktop,
    checked,
    opened,
    ejected,
    mountBusy: (value: boolean) => (busy = value),
  };
}

test("a verified image opens once during concurrent activation and is reused after restart", async (context) => {
  const fixture = await installerFixture(context);
  const requests: Array<string> = [];
  const installer = new ReleaseInstaller(
    fixture.profile,
    fixture.desktop,
    async (url, options) => {
      requests.push(String(url));
      assert.equal(options?.credentials, "omit");
      if (String(url) === update.downloadUrl) {
        assert.equal(options?.redirect, "manual");
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "https://release-assets.githubusercontent.com/invented-asset",
          },
        });
      }
      assert.equal(options?.redirect, "error");
      return new Response(file);
    },
  );
  assert.equal(await installer.ready(update), false);
  assert.deepEqual(requests, []);
  const first = installer.open(update, signal());
  assert.equal(first, installer.open(update, signal()));
  await first;
  assert.equal(requests.length, 2);
  assert.equal(fixture.checked.length, 1);
  assert.deepEqual(
    fixture.opened.map((image) => path.basename(image)),
    [releaseImage(version).name],
  );

  const restarted = new ReleaseInstaller(
    fixture.profile,
    fixture.desktop,
    async () => {
      throw new Error(
        "An already verified image should not be downloaded again",
      );
    },
  );
  assert.equal(await restarted.ready(update), true);
  await restarted.open(update, signal());
  assert.equal(fixture.opened.length, 2);
  assert.equal(fixture.opened[0], fixture.opened[1]);
});

test("failed, unsigned and off-origin downloads do not reach the desktop and leave a safe retry", async (context) => {
  const fixture = await installerFixture(context);
  let response: () => Response = () => new Response("x".repeat(update.size));
  const requests: string[] = [];
  const installer = new ReleaseInstaller(
    fixture.profile,
    fixture.desktop,
    async (url) => {
      requests.push(String(url));
      return response();
    },
  );
  await assert.rejects(
    installer.open({ ...update, sha256: undefined }, signal()),
    /verifiable/,
  );
  assert.equal(requests.length, 0);
  await assert.rejects(installer.open(update, signal()), /checksum/);
  assert.deepEqual(await readdir(fixture.storage), []);
  response = () =>
    new Response(null, {
      status: 302,
      headers: {
        location:
          "https://release-assets.githubusercontent.com.example.invalid/file",
      },
    });
  await assert.rejects(installer.open(update, signal()), /redirected/);
  assert.equal(requests.length, 2);
  response = () => new Response(file + "too many bytes");
  await assert.rejects(
    installer.open(update, signal()),
    /larger than expected/,
  );
  response = () => new Response("x");
  await assert.rejects(installer.open(update, signal()), /checksum/);
  response = () => {
    throw new Error("invented network loss");
  };
  await assert.rejects(installer.open(update, signal()), /network loss/);
  assert.deepEqual(fixture.opened, []);
  assert.deepEqual(fixture.checked, []);
  assert.deepEqual(await readdir(fixture.storage), []);
  response = () => new Response(file);
  await installer.open(update, signal());
  assert.equal(fixture.opened.length, 1);
});

test("cleanup only ejects and removes the recorded update once its version is installed", async (context) => {
  const fixture = await installerFixture(context);
  const installer = new ReleaseInstaller(
    fixture.profile,
    fixture.desktop,
    async () => new Response(file),
  );
  await installer.open(update, signal());
  const unrelated = path.join(fixture.storage, "v0.1.0-foreign");
  await mkdir(unrelated, { mode: 0o700 });
  await writeFile(path.join(unrelated, "user.dmg"), "Keep this image");
  await installer.cleanup("0.4.0", "/Applications/Cod.app/Contents/MacOS/Cod");
  assert.equal(fixture.ejected.length, 0);
  assert.equal(await installer.ready(update), true);

  fixture.mountBusy(true);
  await installer.cleanup("0.4.1", "/Applications/Cod.app/Contents/MacOS/Cod");
  assert.equal(await installer.ready(update), true);
  fixture.mountBusy(false);
  await installer.cleanup("0.4.1", "/Applications/Cod.app/Contents/MacOS/Cod");
  assert.equal(await installer.ready(update), false);
  assert.deepEqual(fixture.ejected, [fixture.opened[0], fixture.opened[0]]);
  assert.equal(
    await readFile(path.join(unrelated, "user.dmg"), "utf8"),
    "Keep this image",
  );
});

test("cache path collisions, symlinks and replaced files cannot be opened or removed", async (context) => {
  const fixture = await installerFixture(context);
  const installer = new ReleaseInstaller(
    fixture.profile,
    fixture.desktop,
    async () => new Response(file),
  );
  await installer.ready(update);
  const foreign = path.join(fixture.profile, "outside");
  await mkdir(foreign, { mode: 0o700 });
  const unknown = path.join(foreign, releaseImage(version).name);
  await writeFile(unknown, "Unrelated file");
  const destination = path.join(
    fixture.storage,
    `v${version}-${update.sha256}`,
  );
  await symlink(foreign, destination);
  await assert.rejects(installer.open(update, signal()), /private/);
  await installer.cleanup("0.4.1", "/Applications/Cod.app/Contents/MacOS/Cod");
  assert.equal(await readFile(unknown, "utf8"), "Unrelated file");

  await rm(destination);
  await installer.open(update, signal());
  const owned = fixture.opened[0];
  await rm(owned);
  await symlink(unknown, owned);
  await assert.rejects(installer.open(update, signal()));
  await installer.cleanup("0.4.1", "/Applications/Cod.app/Contents/MacOS/Cod");
  assert.equal(await readFile(owned, "utf8"), "Unrelated file");
  assert.deepEqual(fixture.ejected, []);
  assert.equal(fixture.opened.length, 1);
});

test("an interrupted download is cleared when the profile reopens, with unrelated paths preserved", async (context) => {
  const fixture = await installerFixture(context);
  await mkdir(fixture.storage, { mode: 0o700 });
  const interrupted = path.join(fixture.storage, ".partial-123AbC");
  const unrelated = path.join(fixture.storage, ".partial-456DeF");
  for (const directory of [interrupted, unrelated])
    await mkdir(directory, { mode: 0o700 });
  const imageName = releaseImage(version).name;
  await writeFile(path.join(interrupted, ".cod-download"), imageName + "\n");
  await writeFile(path.join(interrupted, imageName), "Half a download");
  await writeFile(path.join(unrelated, imageName), "Keep");
  const installer = new ReleaseInstaller(
    fixture.profile,
    fixture.desktop,
    async () => new Response(file),
  );
  assert.equal(await installer.ready(update), false);
  assert.deepEqual(await readdir(fixture.storage), [path.basename(unrelated)]);
  assert.equal(await readFile(path.join(unrelated, imageName), "utf8"), "Keep");
  await installer.open(update, signal());
  assert.equal(await installer.ready(update), true);
});

test("retrying a Finder failure reuses the verified image", async (context) => {
  const fixture = await installerFixture(context);
  let requested = 0;
  let attempts = 0;
  const installer = new ReleaseInstaller(
    fixture.profile,
    {
      ...fixture.desktop,
      async open(image) {
        if (++attempts === 1) throw new Error("Invented Finder failure");
        await fixture.desktop.open(image);
      },
    },
    async () => {
      requested++;
      return new Response(file);
    },
  );
  await assert.rejects(installer.open(update, signal()), /Finder failure/);
  assert.equal(await installer.ready(update), true);
  await installer.open(update, signal());
  assert.equal(requested, 1);
  assert.equal(fixture.opened.length, 1);
});

test("owned corrupt cache recovers on retry without touching a mounted image", async (context) => {
  const fixture = await installerFixture(context);
  let requests = 0;
  const installer = new ReleaseInstaller(
    fixture.profile,
    fixture.desktop,
    async () => {
      requests++;
      return new Response(file);
    },
  );
  await installer.open(update, signal());
  const old = fixture.opened[0];
  const damaged = "x".repeat(update.size);
  await writeFile(old, damaged);
  fixture.mountBusy(true);
  await assert.rejects(installer.open(update, signal()), /Eject/);
  assert.equal(await readFile(old, "utf8"), damaged);
  assert.deepEqual(fixture.ejected, []);
  assert.equal(requests, 1);

  fixture.mountBusy(false);
  await installer.open(update, signal());
  assert.equal(requests, 2);
  assert.equal(await readFile(old, "utf8"), file);
  assert.equal(fixture.opened.length, 2);
});

test("release checks are serial every 15 minutes and wait through GitHub retry times", async () => {
  const stop = new AbortController();
  const finishTurn = () => new Promise((resolve) => setImmediate(resolve));
  const interval = 15 * 60 * 1000;
  let now = 1_800_000_000_000;
  let timeout: { at: number; callback: () => void } | undefined;
  const clock = {
    now: () => now,
    schedule(callback: () => void, delay: number) {
      assert.equal(timeout, undefined);
      timeout = { callback, at: now + delay };
      return () => {
        timeout = undefined;
      };
    },
  };
  const nextTime = () => timeout?.at;
  const fire = async () => {
    assert.ok(timeout);
    const current = timeout;
    timeout = undefined;
    now = current.at;
    current.callback();
    await finishTurn();
  };
  let checks = 0;
  let visibleVersion: string | undefined;
  let finishFirst: (response: Response) => void = () => {};
  pollReleaseUpdates(
    async () => {
      checks++;
      const result = await checkForReleaseUpdate(
        "v0.4.0",
        stop.signal,
        async () => {
          if (checks === 1)
            return new Promise((resolve) => (finishFirst = resolve));
          if (checks === 2)
            return new Response(null, {
              status: 429,
              headers: { "Retry-After": "2700" },
            });
          if (checks === 3)
            return new Response(null, {
              status: 403,
              headers: { "X-RateLimit-Reset": String(now / 1000 + 3600) },
            });
          throw new Error("Invented network failure");
        },
      );
      visibleVersion = result?.version;
    },
    stop.signal,
    clock,
  );

  assert.equal(checks, 1);
  assert.equal(timeout, undefined);
  finishFirst(Response.json([release("v0.4.1")]));
  await finishTurn();
  assert.equal(visibleVersion, "0.4.1");
  assert.equal(nextTime(), now + interval);
  await fire();
  assert.equal(nextTime(), now + 2700 * 1000);
  await fire();
  assert.equal(nextTime(), now + 3600 * 1000);
  await fire();
  assert.equal(nextTime(), now + interval);
  assert.equal(visibleVersion, "0.4.1");
  assert.equal(checks, 4);
  stop.abort();
  assert.equal(timeout, undefined);
});
