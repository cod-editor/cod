import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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

test("Extension toolbar popup stays inside the owning display after opening and resizing", async ({}, info) => {
  test.skip(
    process.platform !== "linux",
    "The positioned window fixture uses X11",
  );
  const extension = path.join(shell.temporary, "toolbar-popup-extension");
  await mkdir(extension);
  await writeFile(
    path.join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Invented toolbar popup",
      version: "2026.10.2",
      permissions: ["tabs"],
      action: { default_title: "Invented vault", default_popup: "popup.html" },
    }),
  );
  await writeFile(
    path.join(extension, "popup.html"),
    '<!doctype html><title>Invented vault</title><body style="margin:0"><main style="box-sizing:border-box;width:400px;height:450px;padding:16px"><h1>Invented vault</h1><output></output><p><label>Filter <input></label></p><button>Expand contents</button></main><script src="popup.js"></script>',
  );
  await writeFile(
    path.join(extension, "popup.js"),
    `chrome.tabs.query({active:true,currentWindow:true}).then(([tab]) => {
      document.querySelector("output").textContent = tab?.url || "";
    });
    document.querySelector("button").onclick = () => {
      const main = document.querySelector("main");
      main.style.width = "560px";
      main.style.height = "580px";
    };`,
  );
  shell.environment.COD_BITWARDEN_EXTENSION_PATH = extension;
  await shell.start();
  const workspace = await shell.create("Extension popup placement");
  const target = await shell.cli<{ groupId: string; paneId: string }>(
    "group",
    "ensure",
    "--workspace",
    workspace,
    "--side",
    "right",
  );
  const browser = await shell.cli<AddonBrowser>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    base + "/page",
    "--group",
    target.groupId,
    "--source-pane",
    target.paneId,
    "--focus",
    "true",
  );
  expect((await inspect(browser.id)).addons.bitwarden.status).toBe("ready");
  const toolbarAction = shell
    .pane(browser.paneId)
    .locator("browser-action-list button.action");
  await expect(toolbarAction).toBeVisible();
  const placeOwner = (corner: boolean) =>
    shell.app!.evaluate(({ BrowserWindow, screen }, corner) => {
      const owner = BrowserWindow.getAllWindows()[0]!;
      const area = screen.getPrimaryDisplay().workArea;
      owner.setBounds(
        corner
          ? {
              x: area.x - 620,
              y: area.y + area.height - 200,
              width: 760,
              height: 480,
            }
          : area,
      );
      owner.focus();
      return area;
    }, corner);
  for (const corner of [false, true]) {
    const area = await placeOwner(corner);
    const anchor = (await toolbarAction.boundingBox())!;
    await toolbarAction.click();
    const findPopup = () =>
      shell.app!.windows().find((item) => item.url().endsWith("/popup.html"));
    await expect.poll(() => Boolean(findPopup())).toBe(true);
    const popup = findPopup()!;
    const window = await shell.app!.browserWindow(popup);
    await expect(
      popup.getByText(base + "/page", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => window.evaluate((win) => win.isVisible() && win.isFocused()))
      .toBe(true);
    const geometry = () => window.evaluate((win) => win.getBounds());
    const fitting = (bounds: Electron.Rectangle) =>
      bounds.x >= area.x &&
      bounds.y >= area.y &&
      bounds.x + bounds.width <= area.x + area.width &&
      bounds.y + bounds.height <= area.y + area.height;
    const capture = async (name: string) => {
      const image = await shell.app!.evaluate(
        async ({ desktopCapturer, screen }) => {
          const { width, height } = screen.getPrimaryDisplay().size;
          const [source] = await desktopCapturer.getSources({
            types: ["screen"],
            thumbnailSize: { width, height },
          });
          return source?.thumbnail.toPNG().toString("base64");
        },
      );
      if (!image) throw new Error("Isolated display screenshot unavailable");
      await writeFile(info.outputPath(name), Buffer.from(image, "base64"));
    };
    if (!corner) await capture("toolbar-popup.png");
    const opened = await geometry();
    await info.attach(corner ? "corner geometry" : "right edge geometry", {
      body: JSON.stringify({ opened, anchor, area }),
      contentType: "application/json",
    });
    if (!corner)
      expect
        .soft(
          Math.abs(
            opened.x + opened.width - (area.x + anchor.x + anchor.width),
          ),
        )
        .toBeLessThanOrEqual(2);
    expect.soft(fitting(opened)).toBe(true);
    await popup
      .getByRole("textbox", { name: "Filter" })
      .fill("invented filter");
    await expect(popup.getByRole("textbox", { name: "Filter" })).toBeFocused();
    await popup.getByRole("button", { name: "Expand contents" }).click();
    // Headless X11 does not deliver the preferred-size notification for this
    // fixture. Send it through the real WebContents and PopupView path.
    await window.evaluate((win) =>
      win.webContents.emit(
        "preferred-size-changed",
        {},
        { width: 560, height: 580 },
      ),
    );
    await expect.poll(async () => (await geometry()).width).toBe(560);
    if (!corner) await capture("toolbar-popup-resized.png");
    expect.soft(fitting(await geometry())).toBe(true);
    if (!corner) {
      await shell.page.bringToFront();
      await shell.page
        .locator(".app-header")
        .click({ position: { x: 350, y: 16 } });
      await expect.poll(() => popup.isClosed()).toBe(true);
    }
  }
});

test("Add-ons AC1 real engine blocks requests and cosmetic elements, with per-host UI/CLI toggle retained across restart", async ({}, info) => {
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
  const switchControl = protection.getByRole("switch", {
    name: "Block ads on this site",
    exact: true,
  });
  await expect(switchControl).toBeChecked();
  await switchControl.focus();
  await shell.page.screenshot({
    path: info.outputPath("site-protection-switch-enabled.png"),
  });
  await switchControl.press("Space");
  await expect(switchControl).not.toBeChecked();
  await expect(switchControl).toBeEnabled();
  await shell.page.screenshot({
    path: info.outputPath("site-protection-switch-off.png"),
  });
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
  await expect
    .poll(async () => (await inspect(other.id)).addons.adblock.enabled)
    .toBe(true);
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

test("Add-ons AC2 first list failure and missing extension remain visible and never claim active protection", async ({}, info) => {
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
    protection.getByRole("switch", {
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
  await shell.page.screenshot({
    path: info.outputPath("site-protection-switch-disabled.png"),
  });
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
  const protection = shell.page.getByRole("dialog", {
    name: "Site protection",
    exact: true,
  });
  await expect(
    protection.getByRole("region", {
      name: "Browser add-on status",
      exact: true,
    }),
  ).toContainText("Filter update failed. Saved filters remain active.");
  const blocking = protection.getByRole("switch", {
    name: "Block ads on this site",
    exact: true,
  });
  await expect(blocking).toBeChecked();
  await expect(blocking).toBeEnabled();
  await expect(
    protection.getByRole("button", {
      name: "Retry filter update",
      exact: true,
    }),
  ).toBeVisible();
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
  const control = protection.getByRole("switch", {
    name: "Block ads on this site",
    exact: true,
  });
  const geometry = () =>
    control.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const label = node.parentElement!.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        inset: label.right - box.right,
      };
    });
  const disabledGeometry = await geometry();
  expect(disabledGeometry).toEqual({ width: 32, height: 20, inset: 0 });
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
  await expect(control).toBeEnabled();
  await expect(control).toBeChecked();
  expect(await geometry()).toEqual(disabledGeometry);
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
