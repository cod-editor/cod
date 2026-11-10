import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { WorkspaceApp } from "./helpers/workspace-app";
interface Browser {
  id: string;
  paneId: string;
  workspaceId: string;
  url: string;
  error?: string;
  title: string;
  lastSuccessfulUrl?: string;
}
let app: WorkspaceApp,
  server: Server,
  origin: string,
  browser: Browser,
  requests: string[];
async function inspect() {
  return app.cli<Browser>("browser", "inspect", "--id", browser.id);
}
async function script<T>(source: string): Promise<T> {
  return app.app!.evaluate(
    async ({ webContents }, { origin, source }) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith(origin));
      if (!contents) throw new Error("Invented browser view absent");
      return contents.executeJavaScript(source);
    },
    { origin, source },
  );
}
async function fail() {
  await script("location.href='/authorize?state=expired-invented-state'");
  await expect
    .poll(async () => (await inspect()).error)
    .toContain("ERR_TOO_MANY_REDIRECTS");
}
async function noReplay() {
  await expect(
    app
      .pane(browser.paneId)
      .getByText("The site redirected too many times.", { exact: true }),
  ).toBeVisible();
  expect((await inspect()).url).toBe(
    origin + "/authorize?state=expired-invented-state",
  );
  expect((await inspect()).lastSuccessfulUrl).toBe(origin + "/");
  expect((await inspect()).title).not.toBe("about:blank");
  await expect(
    app.page.locator(`[role="tab"][data-tab-id="${browser.paneId}"]`),
  ).not.toContainText("about:blank");
  expect(requests.filter((url) => url.startsWith("/authorize"))).toHaveLength(
    0,
  );
}
test.beforeEach(async () => {
  app = new WorkspaceApp();
  await app.prepare();
  requests = [];
  server = createServer((request, response) => {
    requests.push(request.url!);
    const url = new URL(request.url!, "http://fixture");
    if (
      url.pathname === "/authorize" &&
      url.searchParams.get("state") === "expired-invented-state"
    ) {
      response.writeHead(302, { Location: request.url! });
      response.end();
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      url.pathname === "/authorize"
        ? '<title>Invented login</title><form><label>Email <input name="email"></label></form>'
        : '<title>Invented Tracker landing</title><h1>Invented task service</h1><a id="login" href="/authorize?state=fresh-invented-state">Sign in</a>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  await app.start();
  const workspace = (await app.state()).workspaces[0].id;
  browser = await app.cli<Browser>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    origin + "/",
  );
});
test.afterEach(async () => {
  await app?.cleanup();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

test("Failed authorization restores without replay; Reload retries it and explicit recovery starts a fresh login", async ({}, info) => {
  await fail();
  expect((await inspect()).lastSuccessfulUrl).toBe(origin + "/");
  await app.stop();
  requests = [];
  await app.start();
  await noReplay();
  await app.page.screenshot({
    path: info.outputPath("restored-failed-authorization.png"),
  });
  await app
    .pane(browser.paneId)
    .getByRole("button", { name: "Reload page", exact: true })
    .click();
  await expect
    .poll(() => requests.filter((url) => url.startsWith("/authorize")).length)
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await inspect()).error)
    .toContain("ERR_TOO_MANY_REDIRECTS");
  expect((await inspect()).url).toBe(
    origin + "/authorize?state=expired-invented-state",
  );
  const recover = app
    .pane(browser.paneId)
    .getByRole("button", { name: "Return to previous page", exact: true });
  await recover.focus();
  await recover.press("Enter");
  await expect.poll(async () => (await inspect()).url).toBe(origin + "/");
  await expect.poll(async () => (await inspect()).error).toBeUndefined();
  await script("document.querySelector('#login').click()");
  await expect
    .poll(async () => (await inspect()).url)
    .toBe(origin + "/authorize?state=fresh-invented-state");
  expect(
    await script("Boolean(document.querySelector('input[name=email]'))"),
  ).toBe(true);
  expect((await inspect()).lastSuccessfulUrl).toBe(
    origin + "/authorize?state=fresh-invented-state",
  );
});

test("Closing and reopening a failed tab or workspace preserves failure without navigation and CLI recovery remains explicit", async () => {
  await fail();
  await app.cli(
    "pane",
    "close",
    "--workspace",
    browser.workspaceId,
    "--id",
    browser.paneId,
  );
  requests = [];
  await app.cli("pane", "reopen", "--workspace", browser.workspaceId);
  await noReplay();
  await app.cli("workspace", "close", "--id", browser.workspaceId);
  requests = [];
  await app.cli("workspace", "reopen", "--id", browser.workspaceId);
  await noReplay();
  await app.cli("browser", "recover", "--id", browser.id);
  await expect.poll(async () => (await inspect()).url).toBe(origin + "/");
  expect((await inspect()).error).toBeUndefined();
  expect(requests.some((url) => url === "/")).toBe(true);
});
