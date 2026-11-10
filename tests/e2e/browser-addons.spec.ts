import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { WorkspaceApp } from "./helpers/workspace-app";

// Cache cases start two sandboxed Electron processes; individual assertions stay bounded.
test.setTimeout(60_000);

// Prepared second-checkpoint tests. No fake engine: the application fetches these
// deterministic rules through its approved real list-loader interface.
interface AddonBrowser {
  id: string;
  paneId: string;
  addons: {
    bitwarden: { status: "missing" | "loading" | "ready" | "failed" };
    adblock: {
      status: "loading" | "ready" | "failed";
      enabled: boolean;
      hostname: string;
      error?: string;
      cached?: boolean;
    };
  };
}
let shell: WorkspaceApp, server: Server, base: string;
let listFails = false,
  resourcesFail = false;
let requests: string[];
const filterList = `[Adblock Plus 2.0]\n! Title: Invented integration fixture\n/blocked-fixture.js$script\n##.fixture-sponsored\n`;
async function inspect(id: string) {
  return shell.cli<AddonBrowser>("browser", "inspect", "--id", id);
}
async function open(workspace: string, hostname = "127.0.0.1") {
  const url = new URL("/page", base);
  url.hostname = hostname;
  return shell.cli<AddonBrowser>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    url.href,
  );
}
async function observe(hostname = "127.0.0.1") {
  const url = new URL("/page", base);
  url.hostname = hostname;
  return shell.app!.evaluate(async ({ webContents }, url) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL() === url);
    if (!contents) throw new Error("Actual browser fixture view is absent");
    return contents.executeJavaScript(
      `({allowed:window.ALLOWED_FIXTURE===true,blocked:window.BLOCKED_FIXTURE===true,cosmetic:getComputedStyle(document.querySelector('.fixture-sponsored')).display})`,
    );
  }, url.href);
}
async function ready(id: string) {
  await expect
    .poll(async () => (await inspect(id)).addons.adblock.status)
    .toBe("ready");
  await shell.cli("browser", "reload", "--id", id);
}
test.beforeEach(async () => {
  shell = new WorkspaceApp();
  await shell.prepare();
  requests = [];
  listFails = false;
  resourcesFail = false;
  server = createServer((request, response) => {
    const route = new URL(request.url!, "http://fixture").pathname;
    requests.push(`${request.headers.host}${route}`);
    if (route.startsWith("/resources")) {
      response.writeHead(resourcesFail ? 503 : 200, {
        "Content-Type": "application/json",
      });
      response.end(
        resourcesFail
          ? "Invented resources unavailable"
          : JSON.stringify({ scriptlets: [], redirects: [] }),
      );
    } else if (route.startsWith("/filters")) {
      response.writeHead(listFails ? 503 : 200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      response.end(
        listFails
          ? "Invented list failure"
          : route === "/filters-alternate"
            ? "[Adblock Plus 2.0]\n@@/blocked-fixture.js$script\n"
            : route === "/filters-csp"
              ? "[Adblock Plus 2.0]\n/page-csp$csp=script-src 'none',document\n/blocked-fixture.js$script\n"
              : filterList,
      );
    } else if (route === "/page-csp") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<!doctype html><title>Invented CSP fixture</title><h1>CSP fixture</h1><script>window.INLINE_FIXTURE=true;window.onmessage=event=>{if(event.data?.kind==='fixture-child')window.CHILD_FIXTURE=event.data.executed}</script><iframe src="${base.replace("127.0.0.1", "localhost")}/child"></iframe>`,
      );
    } else if (route === "/child") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<!doctype html><script src="/blocked-fixture.js"></script><script>parent.postMessage({kind:'fixture-child',executed:window.BLOCKED_FIXTURE===true},'*')</script>`,
      );
    } else if (route.endsWith(".js")) {
      response.setHeader("Content-Type", "text/javascript");
      response.end(
        route === "/blocked-fixture.js"
          ? "window.BLOCKED_FIXTURE=true"
          : "window.ALLOWED_FIXTURE=true",
      );
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><title>Invented blocking fixture</title><h1>Local fixture</h1><div class="fixture-sponsored">Invented sponsored content</div><script src="/allowed.js"></script><script src="/blocked-fixture.js"></script>',
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture port missing");
  base = `http://127.0.0.1:${address.port}`;
  shell.environment.COD_ADBLOCK_FILTER_LIST_URLS = JSON.stringify([
    base + "/filters",
  ]);
  shell.environment.COD_ADBLOCK_RESOURCE_URL = base + "/resources.json";
  shell.environment.COD_BITWARDEN_EXTENSION_PATH =
    shell.temporary + "/no-extension-fixture";
});
test.afterEach(async () => {
  await shell?.cleanup();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

test("Add-ons AC1 real engine blocks requests and cosmetic elements, with per-host UI/CLI toggle retained across restart", async () => {
  await shell.start();
  const workspace = await shell.create("Invented blocking");
  const browser = await open(workspace);
  await ready(browser.id);
  await expect
    .poll(() => observe())
    .toMatchObject({ allowed: true, blocked: false, cosmetic: "none" });
  // Ignore initial startup navigation; a ready-engine reload must issue no matching request.
  requests = [];
  await shell.cli("browser", "reload", "--id", browser.id);
  expect(requests.some((item) => item.endsWith("/blocked-fixture.js"))).toBe(
    false,
  );
  const toggle = shell
    .pane(browser.paneId)
    .getByRole("button", { name: "Ad blocking", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.focus();
  await toggle.press("Enter");
  const protection = shell.page.getByRole("dialog", {
    name: "Site protection",
    exact: true,
  });
  await protection
    .getByRole("checkbox", { name: "Block ads on this site", exact: true })
    .uncheck();
  await shell.page.keyboard.press("Escape");
  await expect
    .poll(async () => (await inspect(browser.id)).addons.adblock.enabled)
    .toBe(false);
  await shell.cli("browser", "reload", "--id", browser.id);
  await expect
    .poll(() => observe())
    .toMatchObject({ allowed: true, blocked: true });
  expect((await observe()).cosmetic).not.toBe("none");
  expect(requests.some((item) => item.endsWith("/blocked-fixture.js"))).toBe(
    true,
  );
  const other = await open(workspace, "localhost");
  await ready(other.id);
  await expect
    .poll(() => observe("localhost"))
    .toMatchObject({ blocked: false, cosmetic: "none" });
  await shell.stop();
  await shell.start();
  expect((await inspect(browser.id)).addons.adblock.enabled).toBe(false);
  expect((await inspect(other.id)).addons.adblock.enabled).toBe(true);
  await shell.cli(
    "browser",
    "blocking",
    "--id",
    browser.id,
    "--enabled",
    "true",
  );
  await ready(browser.id);
  await expect
    .poll(() => observe())
    .toMatchObject({ blocked: false, cosmetic: "none" });
});

test("Add-ons AC2 first list failure and missing extension remain visible and never claim active protection", async () => {
  listFails = true;
  await shell.start();
  const workspace = await shell.create("Invented setup failure");
  const browser = await open(workspace);
  await expect
    .poll(async () => (await inspect(browser.id)).addons.adblock.status)
    .toBe("failed");
  expect((await inspect(browser.id)).addons.bitwarden.status).toBe("missing");
  const pane = shell.pane(browser.paneId);
  await expect(
    pane.getByRole("button", { name: "Ad blocking", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    pane.getByRole("button", { name: "Ad blocking", exact: true }),
  ).toBeEnabled();
  await pane.getByRole("button", { name: "Ad blocking", exact: true }).click();
  const protection = shell.page.getByRole("dialog", {
    name: "Site protection",
    exact: true,
  });
  await expect(
    protection.getByRole("checkbox", {
      name: "Block ads on this site",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    protection.getByRole("region", {
      name: "Browser add-on status",
      exact: true,
    }),
  ).toContainText(/failed|unavailable/i);
  await shell.page.keyboard.press("Escape");
  await expect
    .poll(() => observe())
    .toMatchObject({ allowed: true, blocked: true });
});

test("Add-ons AC3 cached engines stay bound to their actual filter configuration", async () => {
  await shell.start();
  const workspace = await shell.create("Invented filter cache");
  const browser = await open(workspace);
  await ready(browser.id);
  await expect.poll(() => observe()).toMatchObject({ blocked: false });
  await shell.stop();
  shell.environment.COD_ADBLOCK_FILTER_LIST_URLS = JSON.stringify([
    base + "/filters-alternate",
  ]);
  await shell.start();
  await ready(browser.id);
  await expect
    .poll(() => observe())
    .toMatchObject({ allowed: true, blocked: true });
  expect(requests.some((item) => item.endsWith("/filters-alternate"))).toBe(
    true,
  );
  expect((await observe()).cosmetic).not.toBe("none");
});

test("Add-ons AC4 failed updates retain the verified engine and visibly report cached protection", async () => {
  await shell.start();
  const workspace = await shell.create("Invented cached fallback");
  const browser = await open(workspace);
  await ready(browser.id);
  await expect
    .poll(() => observe())
    .toMatchObject({ blocked: false, cosmetic: "none" });
  await shell.stop();
  listFails = true;
  requests = [];
  await shell.start();
  await expect
    .poll(async () => (await inspect(browser.id)).addons.adblock.error ?? "")
    .toMatch(/update failed.*last-known-good/i);
  expect((await inspect(browser.id)).addons.adblock).toMatchObject({
    status: "ready",
    enabled: true,
    cached: true,
  });
  expect(requests.some((item) => item.endsWith("/filters"))).toBe(true);
  await shell.cli("browser", "reload", "--id", browser.id);
  await expect
    .poll(() => observe())
    .toMatchObject({ allowed: true, blocked: false, cosmetic: "none" });
  await shell
    .pane(browser.paneId)
    .getByRole("button", { name: "Ad blocking", exact: true })
    .click();
  await expect(
    shell.page
      .getByRole("dialog", { name: "Site protection", exact: true })
      .getByRole("region", { name: "Browser add-on status", exact: true }),
  ).toContainText(/update failed.*last-known-good/i);
  await shell.page.keyboard.press("Escape");
});

test("Add-ons AC5 resource URL identity cannot borrow an engine cached for another resource configuration", async () => {
  await shell.start();
  const workspace = await shell.create("Invented resource identity");
  const browser = await open(workspace);
  await ready(browser.id);
  await expect.poll(() => observe()).toMatchObject({ blocked: false });
  await shell.stop();
  resourcesFail = true;
  requests = [];
  shell.environment.COD_ADBLOCK_RESOURCE_URL =
    base + "/resources-alternate.json";
  await shell.start();
  await expect
    .poll(async () => (await inspect(browser.id)).addons.adblock.status)
    .toBe("failed");
  expect((await inspect(browser.id)).addons.adblock.enabled).toBe(false);
  expect(
    requests.some((item) => item.endsWith("/resources-alternate.json")),
  ).toBe(true);
  await shell.cli("browser", "reload", "--id", browser.id);
  await expect
    .poll(() => observe())
    .toMatchObject({ allowed: true, blocked: true });
  expect((await observe()).cosmetic).not.toBe("none");
});

test("Add-ons AC6 host disable bypasses engine CSP headers and cross-origin child requests", async () => {
  shell.environment.COD_ADBLOCK_FILTER_LIST_URLS = JSON.stringify([
    base + "/filters-csp",
  ]);
  await shell.start();
  const workspace = await shell.create("Invented CSP and frame toggle");
  const browser = await shell.cli<AddonBrowser>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    base + "/page-csp",
  );
  await ready(browser.id);
  const observeCsp = () =>
    shell.app!.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL() === url);
      if (!contents) throw new Error("CSP fixture view absent");
      return contents.executeJavaScript(
        "({inline:window.INLINE_FIXTURE===true,child:window.CHILD_FIXTURE===true})",
      );
    }, base + "/page-csp");
  await expect.poll(observeCsp).toMatchObject({ inline: false, child: false });
  requests = [];
  await shell.cli(
    "browser",
    "blocking",
    "--id",
    browser.id,
    "--enabled",
    "false",
  );
  await shell.cli("browser", "reload", "--id", browser.id);
  await expect.poll(observeCsp).toEqual({ inline: true, child: true });
  expect(
    requests.some(
      (item) =>
        item.startsWith("localhost:") && item.endsWith("/blocked-fixture.js"),
    ),
  ).toBe(true);
});

test("Add-ons failed initial filters can be retried without restarting the browser", async ({}, info) => {
  listFails = true;
  await shell.start();
  const workspace = await shell.create("Filter retry");
  const browser = await open(workspace);
  expect((await inspect(browser.id)).addons.adblock.status).toBe("failed");
  listFails = false;
  await shell
    .pane(browser.paneId)
    .getByRole("button", { name: "Ad blocking", exact: true })
    .click();
  const protection = shell.page.getByRole("dialog", {
    name: "Site protection",
    exact: true,
  });
  const checkbox = protection.getByRole("checkbox", {
    name: "Block ads on this site",
    exact: true,
  });
  const geometry = await checkbox.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const label = node.parentElement!.getBoundingClientRect();
    return { width: box.width, offset: box.left - label.left };
  });
  expect(geometry.width).toBeLessThanOrEqual(20);
  expect(geometry.offset).toBeLessThanOrEqual(2);
  await expect(protection).not.toContainText(
    "Blocking unavailable: Blocking unavailable",
  );
  await shell.page.screenshot({
    path: info.outputPath("filter-update-failure.png"),
  });
  await shell.page
    .getByRole("dialog", { name: "Site protection", exact: true })
    .getByRole("button", { name: "Retry filter update", exact: true })
    .click();
  await expect
    .poll(async () => (await inspect(browser.id)).addons.adblock.status)
    .toBe("ready");
  await expect(
    protection.getByRole("button", {
      name: "Retry filter update",
      exact: true,
    }),
  ).toBeHidden();
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).toBeChecked();
  await shell.page.screenshot({
    path: info.outputPath("filter-update-recovered.png"),
  });
  await shell.page.keyboard.press("Escape");
  await shell.cli("browser", "blocking-retry", "--id", browser.id);
  expect((await inspect(browser.id)).addons.adblock.status).toBe("ready");
  expect((await inspect(browser.id)).addons.adblock.error).toBeUndefined();
  await shell.cli("browser", "reload", "--id", browser.id);
  await expect
    .poll(() => observe())
    .toMatchObject({ blocked: false, cosmetic: "none" });
});
