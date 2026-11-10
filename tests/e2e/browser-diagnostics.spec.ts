import { test, expect } from "@playwright/test";
import { WorkspaceApp } from "./helpers/workspace-app";

test.setTimeout(60_000);
const origin = "https://auth.cloud.yandex.ru";
const secret = "INVENTED_PRIVATE_DIAGNOSTIC_SENTINEL";
const initialUrl = `${origin}/oauth/authorize?state=${secret}#${secret}`;
let app: WorkspaceApp;
let browser: { id: string; paneId: string };
interface Report {
  state: string;
  events: Array<{ kind: string; route: string; status?: number }>;
}
async function diagnostics(action: "start" | "read" | "stop") {
  return app.cli<Report>(
    "browser",
    "diagnostics",
    "--id",
    browser.id,
    "--action",
    action,
  );
}
async function page<T>(source: string): Promise<T> {
  return app.app!.evaluate(async ({ webContents }, source) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) =>
        item.getURL().startsWith("https://auth.cloud.yandex.ru/"),
      );
    if (!contents) throw new Error("Invented diagnostic view absent");
    return contents.executeJavaScript(source);
  }, source);
}
test.beforeEach(async () => {
  app = new WorkspaceApp();
  await app.prepare();
  await app.start();
  await app.app!.evaluate(async ({ session }, secret) => {
    const profile = session.fromPartition("persist:cod-browser");
    await profile.cookies.set({
      url: "https://auth.cloud.yandex.ru",
      name: "fixture",
      value: secret,
      secure: true,
      sameSite: "no_restriction",
    });
    await profile.protocol.handle("https", (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "auth.cloud.yandex.ru")
        throw new Error("External network is forbidden in this fixture");
      if (url.searchParams.get("fail") === "true") return Response.error();
      if (url.searchParams.get("redirect") === "private")
        return new Response(null, {
          status: 302,
          headers: { location: `/private/${secret}?code=${secret}` },
        });
      return new Response(
        `<!doctype html><title>${secret}</title><body>${secret}<script>window.fixtureMarker=${JSON.stringify(secret)};window.fixtureLoads=1;localStorage.setItem('fixture',${JSON.stringify(secret)})</script>`,
        {
          status: 200,
          headers: {
            "content-type": "text/html",
            "x-private-response": secret,
            "set-cookie": `fixture=${secret}; Secure; SameSite=None; Path=/`,
          },
        },
      );
    });
  }, secret);
  const workspace = (await app.state()).workspaces[0].id;
  browser = await app.cli(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    initialUrl,
  );
});
test.afterEach(async () => {
  await app?.cleanup();
});

test("Browser diagnostics observe only allowlisted route metadata without exposing or mutating session data", async () => {
  const before = await page(
    "({url:location.href,marker:window.fixtureMarker,loads:window.fixtureLoads,storage:localStorage.getItem('fixture'),cookies:document.cookie})",
  );
  await diagnostics("start");
  expect(
    await page(
      "({url:location.href,marker:window.fixtureMarker,loads:window.fixtureLoads,storage:localStorage.getItem('fixture'),cookies:document.cookie})",
    ),
  ).toEqual(before);
  await app.cli(
    "browser",
    "navigate",
    "--id",
    browser.id,
    "--url",
    `${origin}/oauth/authorize?code=${secret}&access_token=${secret}#${secret}`,
  );
  await expect
    .poll(async () =>
      (await diagnostics("read")).events.some(
        (event) => event.kind === "response" && event.status === 200,
      ),
    )
    .toBe(true);
  const read = await diagnostics("read");
  expect(read.state).toBe("recording");
  const other = await app.cli<{ id: string; paneId: string }>(
    "browser",
    "open",
    "--workspace",
    (await app.state()).activeWorkspaceId!,
    "--url",
    `${origin}/oauth/authorize?state=OTHER_VIEW_${secret}`,
  );
  expect((await diagnostics("read")).events).toEqual(read.events);
  await app.cli(
    "pane",
    "close",
    "--workspace",
    (await app.state()).activeWorkspaceId!,
    "--id",
    other.paneId,
  );
  const output = JSON.stringify(read);
  expect(output).not.toContain(secret);
  expect(output).not.toContain("access_token");
  expect(output).not.toContain("x-private-response");
  expect(output).not.toContain("set-cookie");
  expect(output).toContain("/oauth/authorize");
  const stable = await page(
    "({url:location.href,marker:window.fixtureMarker,loads:window.fixtureLoads,storage:localStorage.getItem('fixture'),cookies:document.cookie})",
  );
  await diagnostics("stop");
  expect(
    await page(
      "({url:location.href,marker:window.fixtureMarker,loads:window.fixtureLoads,storage:localStorage.getItem('fixture'),cookies:document.cookie})",
    ),
  ).toEqual(stable);
  const stopped = await diagnostics("read");
  expect(stopped.state).toBe("stopped");
  await app.cli(
    "browser",
    "navigate",
    "--id",
    browser.id,
    "--url",
    `${origin}/oauth/authorize?state=OTHER_${secret}`,
  );
  expect(await diagnostics("read")).toEqual(stopped);
});

test("Browser diagnostics refuse debugger collisions and private paths, and detach on scope exit and tab closure", async () => {
  await app.app!.evaluate(({ webContents }) => {
    webContents
      .getAllWebContents()
      .find((item) =>
        item.getURL().startsWith("https://auth.cloud.yandex.ru/"),
      )!
      .debugger.attach("1.3");
  });
  const collision = await app.raw(
    "browser",
    "diagnostics",
    "--id",
    browser.id,
    "--action",
    "start",
  );
  expect(collision.code).not.toBe(0);
  expect(
    await app.app!.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .find((item) =>
          item.getURL().startsWith("https://auth.cloud.yandex.ru/"),
        )!
        .debugger.isAttached(),
    ),
  ).toBe(true);
  await app.app!.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .find((item) =>
        item.getURL().startsWith("https://auth.cloud.yandex.ru/"),
      )!
      .debugger.detach(),
  );
  await diagnostics("start");
  const privateUrl = `${origin}/private/${secret}?code=${secret}`;
  await app.cli("browser", "navigate", "--id", browser.id, "--url", privateUrl);
  await expect
    .poll(() =>
      app.app!.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .find((item) =>
            item.getURL().startsWith("https://auth.cloud.yandex.ru/"),
          )!
          .debugger.isAttached(),
      ),
    )
    .toBe(false);
  expect((await diagnostics("read")).state).toBe("scope-left");
  expect(JSON.stringify(await diagnostics("read"))).not.toContain(secret);
  const denied = await app.raw(
    "browser",
    "diagnostics",
    "--id",
    browser.id,
    "--action",
    "start",
  );
  expect(denied.code).not.toBe(0);
  expect(denied.stderr + denied.stdout).not.toContain(secret);
  await app.cli("browser", "navigate", "--id", browser.id, "--url", initialUrl);
  await diagnostics("start");
  await app.cli(
    "pane",
    "close",
    "--workspace",
    (await app.state()).activeWorkspaceId!,
    "--id",
    browser.paneId,
  );
  const closed = await app.raw(
    "browser",
    "diagnostics",
    "--id",
    browser.id,
    "--action",
    "read",
  );
  expect(closed.code).not.toBe(0);
  expect(closed.stderr + closed.stdout).not.toContain(secret);
});

test("Browser diagnostics automatically release their debugger at the bounded lifetime", async () => {
  const before = await page(
    "({url:location.href,marker:window.fixtureMarker,storage:localStorage.getItem('fixture'),cookies:document.cookie})",
  );
  const started = await diagnostics("start");
  expect(started.state).toBe("recording");
  await expect
    .poll(
      () =>
        app.app!.evaluate(({ webContents }) =>
          webContents
            .getAllWebContents()
            .find((item) =>
              item.getURL().startsWith("https://auth.cloud.yandex.ru/"),
            )!
            .debugger.isAttached(),
        ),
      { timeout: 48000, intervals: [1000] },
    )
    .toBe(false);
  expect((await diagnostics("read")).state).toBe("expired");
  expect(
    await page(
      "({url:location.href,marker:window.fixtureMarker,storage:localStorage.getItem('fixture'),cookies:document.cookie})",
    ),
  ).toEqual(before);
});

test("Browser diagnostics detach before a server redirect leaves the exact public route", async () => {
  await diagnostics("start");
  await app.cli(
    "browser",
    "navigate",
    "--id",
    browser.id,
    "--url",
    `${origin}/oauth/authorize?redirect=private&state=${secret}`,
  );
  await expect
    .poll(() =>
      app.app!.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .find((item) =>
            item.getURL().startsWith("https://auth.cloud.yandex.ru/"),
          )!
          .debugger.isAttached(),
      ),
    )
    .toBe(false);
  const report = await diagnostics("read");
  expect(report.state).toBe("scope-left");
  expect(JSON.stringify(report)).not.toContain(secret);
  expect(
    report.events.every((event) => event.route === `${origin}/oauth/authorize`),
  ).toBe(true);
  expect(await page("location.pathname")).toBe(`/private/${secret}`);
});

test("Restored failed authorization diagnostics stay passive until an explicit reload", async () => {
  const failedUrl = `${origin}/oauth/authorize?fail=true&state=${secret}`;
  expect(
    (
      await app.raw(
        "browser",
        "navigate",
        "--id",
        browser.id,
        "--url",
        failedUrl,
      )
    ).code,
  ).not.toBe(0);
  await app.stop();
  await app.start();
  await app.app!.evaluate(async ({ session }) => {
    await session
      .fromPartition("persist:cod-browser")
      .protocol.handle("https", (request) => {
        if (new URL(request.url).hostname !== "auth.cloud.yandex.ru")
          throw new Error("External request forbidden");
        return new Response(
          "<!doctype html><title>Invented recovered authorization</title>",
          { headers: { "content-type": "text/html" } },
        );
      });
  });
  expect((await diagnostics("start")).state).toBe("recording");
  expect((await diagnostics("read")).events).toEqual([]);
  await app.cli("browser", "reload", "--id", browser.id);
  await expect
    .poll(async () =>
      (await diagnostics("read")).events.some(
        (event) => event.kind === "response" && event.status === 200,
      ),
    )
    .toBe(true);
  expect(JSON.stringify(await diagnostics("stop"))).not.toContain(secret);
});
