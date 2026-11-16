import { pathToFileURL } from "node:url";
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { WorkspaceApp, modifier } from "./helpers/workspace-app";
interface BrowserRecord {
  id: string;
  paneId: string;
  workspaceId: string;
  url: string;
  title: string;
  visible: boolean;
  loading: boolean;
  error?: string;
}
let brokenPage = true;
let requests: string[] = [];
let slowResponse: import("node:http").ServerResponse | undefined;
let shell: WorkspaceApp,
  server: Server,
  origin: string,
  uploads: string,
  downloads: string;
async function inspect(id: string) {
  return shell.cli<BrowserRecord>("browser", "inspect", "--id", id);
}
async function open(workspace: string, route = "/one") {
  return shell.cli<BrowserRecord>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    origin + route,
  );
}
async function remote(route: string, source: string) {
  await expect
    .poll(() =>
      shell.app!.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .some((w) => w.getURL() === url && !w.isLoadingMainFrame()),
        origin + route,
      ),
    )
    .toBe(true);
  return shell.app!.evaluate(
    async ({ webContents }, { url, source }) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL() === url);
      if (!wc) throw new Error("Fixture browser view absent");
      return wc.executeJavaScript(source);
    },
    { url: origin + route, source },
  );
}
async function nativeView(route: string) {
  return shell.app!.evaluate(
    ({ BrowserWindow }, { url }) => {
      for (const w of BrowserWindow.getAllWindows())
        for (const child of w.contentView.children) {
          const view = child as unknown as {
            webContents?: { getURL(): string };
            getBounds(): {
              x: number;
              y: number;
              width: number;
              height: number;
            };
            getVisible(): boolean;
          };
          if (view.webContents?.getURL() === url)
            return { bounds: view.getBounds(), visible: view.getVisible() };
        }
      return null;
    },
    { url: origin + route },
  );
}
async function pageKey(
  route: string,
  keyCode: string,
  modifiers: Array<"meta" | "control" | "shift"> = [],
) {
  await shell.app!.evaluate(
    ({ webContents }, { url, keyCode, modifiers }) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL() === url)!;
      wc.focus();
      wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    },
    { url: origin + route, keyCode, modifiers },
  );
}
test.beforeEach(async () => {
  shell = new WorkspaceApp();
  await shell.prepare();
  downloads = path.join(shell.temporary, "downloads");
  await mkdir(downloads);
  shell.environment.COD_DOWNLOAD_DIR = downloads;
  uploads = "";
  brokenPage = true;
  requests = [];
  slowResponse = undefined;
  server = createServer((request, response) => {
    requests.push(request.url!);
    // Network-count assertions must observe loads rather than HTTP cache hits.
    response.setHeader("Cache-Control", "no-store");
    const route = new URL(request.url!, "http://fixture").pathname;
    if (route === "/new-tab-post") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        response.setHeader("Content-Type", "text/html");
        response.end(
          `<title>Posted tab fixture</title><body>${request.method}:${Buffer.concat(chunks).toString("utf8")}</body>`,
        );
      });
      return;
    }
    if (route === "/scrollbars") {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>Invented scrollbar fixture</title><style>
        body{margin:16px;background:#282c34;color:#abb2bf;font:14px sans-serif;min-height:1800px}
        .box{height:140px;width:220px;overflow:auto;border:1px solid #454b57;margin-bottom:18px}
        .content{height:650px;width:320px;padding:8px;box-sizing:border-box}
        #hidden{scrollbar-width:none}#hidden::-webkit-scrollbar{display:none}
        #custom::-webkit-scrollbar{width:18px;height:18px}#custom::-webkit-scrollbar-thumb{background:rgb(180,80,70);border-radius:0}
      </style><h3>Ordinary page scrollbar</h3><p>Nested scrolling stays independent of the page.</p>
      <div id="ordinary" class="box"><div class="content">Ordinary nested content</div></div>
      <div id="custom" class="box"><div class="content">Page-authored custom scrollbar</div></div>
      <div id="hidden" class="box"><div class="content">Page-authored hidden scrollbar</div></div><iframe id="frame" title="Invented frame" style="width:220px;height:100px" srcdoc='<style>body{min-height:600px}</style>Frame scrollbar fixture'></iframe>`);
      return;
    }
    if (route.startsWith("/oauth-loop/") && brokenPage) {
      response.writeHead(302, { Location: request.url! });
      response.end();
      return;
    }
    if (route === "/recoverable" && brokenPage) {
      request.socket.destroy();
      return;
    }
    if (route === "/oauth-start") {
      response.writeHead(302, { Location: "/oauth-callback?code=invented" });
      response.end();
      return;
    }
    if (route === "/oauth-callback") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<title>Invented OAuth callback</title><script>opener.postMessage('invented-auth-complete',location.origin);window.close()</script>`,
      );
      return;
    }
    if (route === "/slow") {
      slowResponse = response;
      return;
    }
    if (route === "/slow-download") {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="large.bin"',
        "Content-Length": 1024 * 1024,
      });
      let sent = 0;
      const timer = setInterval(() => {
        response.write(Buffer.alloc(16384));
        sent += 16384;
        if (sent >= 1024 * 1024) {
          clearInterval(timer);
          response.end();
        }
      }, 50);
      response.on("close", () => clearInterval(timer));
      return;
    }
    if (route === "/download") {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="fixture.txt"',
      });
      response.end("INVENTED_BROWSER_DOWNLOAD");
      return;
    }
    if (route === "/upload") {
      request.setEncoding("utf8");
      request.on("data", (chunk) => (uploads += chunk));
      request.on("end", () => response.end("Uploaded fixture"));
      return;
    }
    response.setHeader("Content-Type", "text/html");
    if (route === "/popup") {
      response.end(
        `<title>Popup fixture</title><script>opener.postMessage('fixture-popup','*')</script>`,
      );
      return;
    }
    response.end(
      `<!doctype html><title>Fixture ${route}</title><h1>Invented browser page ${route}</h1><input aria-label="Page input"><button onclick="window.open('/popup', 'fixture-popup', 'popup,width=500,height=500')">Popup</button><a href="/download">Download</a><form method="post" action="/upload" enctype="multipart/form-data"><input name="file" type="file"><button>Upload</button></form><script>window.identity=crypto.randomUUID();window.onmessage=e=>window.popupResult=e.data;</script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  await shell.start();
});
test.afterEach(async () => {
  await shell?.cleanup();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

test("Address bar searches text and opens bare addresses without sending addresses to search", async () => {
  const workspace = await shell.create("Address input");
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  await shell.page
    .getByRole("button", { name: "New browser tab", exact: true })
    .click();
  const address = shell.page.getByRole("textbox", {
    name: "Address",
    exact: true,
  });
  await expect(address).toBeFocused();
  await expect(address).toHaveValue("");
  await expect(address).toHaveAttribute(
    "placeholder",
    "Search or enter address",
  );
  await expect
    .poll(async () => {
      const state = await shell.cli<{
        browsers: Array<{ addons?: { adblock: { status: string } } }>;
      }>("state");
      return state.browsers[0]?.addons?.adblock.status;
    })
    .toBe("ready");
  await shell.app!.evaluate(({ session }, origin) => {
    session
      .fromPartition("persist:cod-browser")
      .webRequest.onBeforeRequest(
        { urls: ["https://www.google.com/search*"] },
        (details, callback) =>
          callback({
            redirectURL: origin + "/search" + new URL(details.url).search,
          }),
      );
  }, origin);
  await address.fill("invented search & example");
  await address.press("Enter");
  await expect
    .poll(() =>
      requests.some(
        (url) =>
          new URL(url, origin).searchParams.get("q") ===
          "invented search & example",
      ),
    )
    .toBe(true);
  const record = (
    await shell.cli<{ browsers: BrowserRecord[] }>("state")
  ).browsers.find((b) => b.workspaceId === workspace)!;
  await address.fill(origin.replace("http://", "") + "/bare-address");
  await address.press("Enter");
  await expect
    .poll(async () => (await inspect(record.id)).url)
    .toBe(origin + "/bare-address");
  await shell.cli(
    "browser",
    "navigate",
    "--id",
    record.id,
    "--url",
    "site:example.com invented",
  );
  await expect
    .poll(() =>
      requests.some(
        (url) =>
          new URL(url, origin).searchParams.get("q") ===
          "site:example.com invented",
      ),
    )
    .toBe(true);
});

test("Browser home keeps shared pinned sites through editing and restart", async ({}, info) => {
  const workspace = await shell.create("Home sites");
  const record = await shell.cli<BrowserRecord>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    "about:blank",
  );
  const home = shell.page.getByRole("region", { name: "Browser home" });
  await expect(home).toBeVisible();
  await expect(
    shell.page.getByRole("region", { name: "Browser content", exact: true }),
  ).toBeHidden();
  await home.getByRole("button", { name: "Pin a site" }).click();
  await home
    .getByRole("textbox", { name: "Pinned site address" })
    .fill(origin + "/one");
  await home
    .getByRole("textbox", { name: "Pinned site name" })
    .fill("Example workspace");
  await home.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    home.getByRole("button", { name: "Example workspace", exact: true }),
  ).toBeVisible();
  await home
    .getByRole("button", { name: "Example workspace", exact: true })
    .click({ button: "right" });
  await shell.page.getByRole("button", { name: "Rename", exact: true }).click();
  await home
    .getByRole("textbox", { name: "Pinned site name" })
    .fill("Example docs");
  await home.getByRole("textbox", { name: "Pinned site name" }).press("Enter");
  await expect(
    home.getByRole("button", { name: "Example docs", exact: true }),
  ).toBeVisible();
  await shell.cli(
    "browser",
    "pin",
    "--url",
    origin + "/two",
    "--title",
    "Example mail",
  );
  await home.screenshot({ path: info.outputPath("browser-home.png") });
  await home.getByRole("button", { name: "Example docs", exact: true }).click();
  await expect
    .poll(async () => (await inspect(record.id)).url)
    .toBe(origin + "/one");
  await expect(home).toBeHidden();
  await shell.stop();
  await shell.start();
  const other = await shell.create("Another workspace");
  await shell.cli(
    "browser",
    "open",
    "--workspace",
    other,
    "--url",
    "about:blank",
  );
  const restored = shell.page.getByRole("region", { name: "Browser home" });
  await expect(
    restored.getByRole("button", { name: "Example docs", exact: true }),
  ).toBeVisible();
  await restored
    .getByRole("button", { name: "Example docs", exact: true })
    .click({ button: "right" });
  await shell.page.getByRole("button", { name: "Unpin", exact: true }).click();
  await expect(
    restored.getByRole("button", { name: "Example docs", exact: true }),
  ).toHaveCount(0);
  await expect(
    restored.getByRole("button", { name: "Example mail", exact: true }),
  ).toBeVisible();
});

test("Browser AC1 UI and CLI navigation, history and address keyboard use real workspace views", async () => {
  const workspace = await shell.create("Browser navigation");
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  await shell.page
    .getByRole("button", { name: "New browser tab", exact: true })
    .click();
  await expect(shell.page.getByRole("dialog")).toHaveCount(0);
  const newAddress = shell.page.getByRole("textbox", {
    name: "Address",
    exact: true,
  });
  await expect(newAddress).toBeFocused();
  await newAddress.fill(origin + "/one");
  await newAddress.press("Enter");
  const record = (
    await shell.cli<{ browsers: BrowserRecord[] }>("state")
  ).browsers.find((row) => row.workspaceId === workspace)!;
  expect(record).toBeDefined();
  const address = shell
    .pane(record.paneId)
    .getByRole("textbox", { name: "Address", exact: true });
  await expect(address).toHaveValue(origin + "/one");
  await expect
    .poll(() => remote("/one", "document.title").catch(() => ""))
    .toBe("Fixture /one");
  await address.fill(origin + "/two");
  await address.press("Enter");
  await expect
    .poll(async () => (await inspect(record.id)).url)
    .toBe(origin + "/two");
  await shell
    .pane(record.paneId)
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await expect
    .poll(async () => (await inspect(record.id)).url)
    .toBe(origin + "/one");
  await shell.cli("browser", "forward", "--id", record.id);
  await expect
    .poll(async () => (await inspect(record.id)).url)
    .toBe(origin + "/two");
  const identity = await remote("/two", "window.identity");
  await shell
    .pane(record.paneId)
    .getByRole("button", { name: "Reload", exact: true })
    .click();
  await expect.poll(() => remote("/two", "window.identity")).not.toBe(identity);
  await shell.cli(
    "browser",
    "navigate",
    "--id",
    record.id,
    "--url",
    origin + "/three",
  );
  await expect(address).toHaveValue(origin + "/three");
  expect(
    (
      await shell.raw(
        "browser",
        "navigate",
        "--id",
        record.id,
        "--url",
        "file://remote-server/etc/passwd",
      )
    ).code,
  ).not.toBe(0);
  expect((await inspect(record.id)).url).toBe(origin + "/three");
});

test("Browser AC2 native bounds stay inside split panes and overlays hide views without losing page state", async ({}, info) => {
  const workspace = await shell.create("Browser layout");
  const browser = await open(workspace);
  const identity = await remote("/one", "window.identity");
  await shell.command("Split right");
  const content = shell
    .pane(browser.paneId)
    .getByRole("region", { name: "Browser content", exact: true });
  await expect
    .poll(async () => {
      const native = await nativeView("/one"),
        box = await content.boundingBox();
      return Boolean(
        native &&
        box &&
        Math.abs(native.bounds.x - box.x) <= 2 &&
        Math.abs(native.bounds.y - box.y) <= 2 &&
        Math.abs(native.bounds.width - box.width) <= 2 &&
        Math.abs(native.bounds.height - box.height) <= 2,
      );
    })
    .toBe(true);
  await pageKey("/one", "P", [
    process.platform === "darwin" ? "meta" : "control",
    "shift",
  ]);
  await expect(
    shell.page.getByRole("dialog", { name: "Command palette" }),
  ).toBeVisible();
  await expect
    .poll(async () => (await nativeView("/one"))?.visible)
    .toBe(false);
  await shell.page.keyboard.press("Escape");
  await expect.poll(async () => (await nativeView("/one"))?.visible).toBe(true);
  expect(await remote("/one", "window.identity")).toBe(identity);
  await pageKey("/one", "L", [
    process.platform === "darwin" ? "meta" : "control",
  ]);
  await expect(
    shell
      .pane(browser.paneId)
      .getByRole("textbox", { name: "Address", exact: true }),
  ).toBeFocused();
  await pageKey("/one", "W", [
    process.platform === "darwin" ? "meta" : "control",
    "shift",
  ]);
  const browserRow = shell.page.locator(
    `[role=treeitem][data-browser-id="${browser.id}"]`,
  );
  await expect(browserRow).toBeFocused();
  await expect(browserRow).toHaveAttribute("aria-selected", "true");
  await shell.command("Settings...");
  await expect
    .poll(async () => (await nativeView("/one"))?.visible)
    .toBe(false);
  await shell.page.keyboard.press("Escape");
  await expect.poll(async () => (await nativeView("/one"))?.visible).toBe(true);
  await shell.page.screenshot({
    path: info.outputPath("workspace-browser.png"),
  });
  // CDP captures the app renderer separately from its native child view.
  const nativeImage = await shell.app!.evaluate(
    async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL() === url)!;
      return (await contents.capturePage()).toPNG().toString("base64");
    },
    origin + "/one",
  );
  await writeFile(
    info.outputPath("native-browser-page.png"),
    Buffer.from(nativeImage, "base64"),
  );
});

test("Browser AC3 background views preserve focus and shared cookies survive restart with stable URL identity", async () => {
  const first = await shell.create("Browser first");
  const one = await open(first);
  await remote(
    "/one",
    `document.cookie='fixture_login=present; Max-Age=3600; Path=/'`,
  );
  const second = await shell.create("Browser second");
  const two = await open(second, "/two");
  expect(await remote("/two", "document.cookie")).toContain(
    "fixture_login=present",
  );
  const extra = await open(first, "/background");
  expect((await shell.state()).activeWorkspaceId).toBe(second);
  await expect
    .poll(async () => (await nativeView("/background"))?.visible)
    .toBe(false);
  const identity = await remote("/one", "window.identity");
  await shell.cli("workspace", "focus", "--id", first);
  expect(await remote("/one", "window.identity")).toBe(identity);
  await shell.cli("workspace", "focus", "--id", second);
  await shell.stop();
  await shell.start();
  for (const record of [one, two, extra])
    expect((await inspect(record.id)).paneId).toBe(record.paneId);
  await expect.poll(async () => Boolean(await nativeView("/two"))).toBe(true);
  await expect
    .poll(() => remote("/two", "document.cookie"))
    .toContain("fixture_login=present");
  expect((await inspect(two.id)).url).toBe(origin + "/two");
  await shell.cli("browser", "close", "--id", extra.id);
  expect(
    (await shell.raw("browser", "inspect", "--id", extra.id)).code,
  ).not.toBe(0);
  expect((await inspect(two.id)).url).toBe(origin + "/two");
});

test("Browser AC4 real uploads, visible downloads and popup opener work through integrated views", async () => {
  const workspace = await shell.create("Browser transfers");
  const record = await open(workspace);
  const upload = path.join(shell.temporary, "upload.txt");
  await writeFile(upload, "INVENTED_APP_UPLOAD");
  await shell.app!.evaluate(
    async ({ webContents }, { url, file }) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL() === url)!;
      wc.debugger.attach("1.3");
      try {
        const { root } = await wc.debugger.sendCommand("DOM.getDocument");
        const { nodeId } = await wc.debugger.sendCommand("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: "input[type=file]",
        });
        await wc.debugger.sendCommand("DOM.setFileInputFiles", {
          nodeId,
          files: [file],
        });
      } finally {
        wc.debugger.detach();
      }
    },
    { url: origin + "/one", file: upload },
  );
  await remote("/one", `document.querySelector('form').requestSubmit()`);
  await expect.poll(() => uploads).toContain("INVENTED_APP_UPLOAD");
  await shell.cli(
    "browser",
    "navigate",
    "--id",
    record.id,
    "--url",
    origin + "/one",
  );
  await remote("/one", `document.querySelector('a[href="/download"]').click()`);
  await expect
    .poll(async () => await readdir(downloads))
    .toContain("fixture.txt");
  await expect
    .poll(
      async () => await readFile(path.join(downloads, "fixture.txt"), "utf8"),
    )
    .toBe("INVENTED_BROWSER_DOWNLOAD");
  await expect
    .poll(async () => await shell.cli("browser", "downloads"))
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          basename: "fixture.txt",
          status: "completed",
          path: path.join(downloads, "fixture.txt"),
        }),
      ]),
    );
  await remote(
    "/one",
    `void window.open('/popup', 'fixture-popup', 'popup,width=500,height=500')`,
  );
  await expect
    .poll(() => remote("/one", "window.popupResult"))
    .toBe("fixture-popup");
  await shell.cli("browser", "close", "--id", record.id);
  await expect
    .poll(() =>
      shell.app!.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter((w) =>
            w.webContents.getURL().includes("/popup"),
          ).length,
      ),
    )
    .toBe(0);
});

test("Browser AC5 external pages have no Cod bridge or Node and denied permissions are explained", async () => {
  const workspace = await shell.create("Browser trust");
  const record = await open(workspace);
  expect(
    await remote(
      "/one",
      `({node:typeof require,process:typeof process,bridge:typeof window.cod})`,
    ),
  ).toEqual({ node: "undefined", process: "undefined", bridge: "undefined" });
  const preferences = await shell.app!.evaluate(({ webContents }, url) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => w.getURL() === url)! as unknown as {
      getLastWebPreferences(): {
        sandbox: boolean;
        contextIsolation: boolean;
        nodeIntegration: boolean;
        preload?: string;
      };
    };
    const p = wc.getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      preload: p.preload ?? "",
    };
  }, origin + "/one");
  expect(preferences).toEqual({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    preload: "",
  });
  const state = await shell.state();
  await remote("/one", `window.location.href='file:///etc/passwd'`);
  await expect
    .poll(async () => (await inspect(record.id)).url)
    .toBe(origin + "/one");
  expect(await shell.state()).toEqual(state);
  await remote(
    "/one",
    `navigator.geolocation.getCurrentPosition(()=>window.permissionResult='granted',error=>window.permissionResult=error.code,{timeout:10000});void 0`,
  );
  const prompt = shell
    .pane(record.paneId)
    .getByRole("region", { name: "Site permission request" });
  await expect(prompt).toContainText(origin);
  await prompt.getByRole("button", { name: "Block", exact: true }).click();
  await expect.poll(() => remote("/one", "window.permissionResult")).toBe(1);
  expect(await shell.cli("browser", "permissions")).toEqual([
    expect.objectContaining({
      origin,
      permission: "geolocation",
      decision: "block",
    }),
  ]);
});

test("Browser slow navigation does not block other workspaces and close cancels its owned view", async () => {
  const workspace = await shell.create("Slow browser fixture");
  const opening = shell.raw(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    origin + "/slow",
  );
  await expect.poll(() => Boolean(slowResponse)).toBe(true);
  const other = await shell.create("Unrelated workspace remains responsive");
  expect((await shell.state()).activeWorkspaceId).toBe(other);
  const pending = (await shell.cli<{ browsers: BrowserRecord[] }>("state"))
    .browsers[0];
  expect(pending.workspaceId).toBe(workspace);
  await shell.cli("workspace", "close", "--id", workspace);
  expect((await opening).code).not.toBe(0);
  slowResponse?.end("<!doctype html><title>Late fixture</title>");
  expect(
    (await shell.cli<{ browsers: BrowserRecord[] }>("state")).browsers,
  ).toEqual([]);
  expect((await shell.state()).activeWorkspaceId).toBe(other);
  await expect.poll(() => nativeView("/slow")).toBe(null);
});

test("Browser navigation can replace a pending initial page and recover after a failed URL", async () => {
  const workspace = await shell.create("Browser recovery fixture");
  const opening = shell.raw(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    origin + "/slow",
  );
  await expect.poll(() => Boolean(slowResponse)).toBe(true);
  const record = (await shell.cli<{ browsers: BrowserRecord[] }>("state"))
    .browsers[0];
  await shell.cli(
    "browser",
    "navigate",
    "--id",
    record.id,
    "--url",
    origin + "/one",
  );
  expect((await opening).code).not.toBe(0);
  expect(await remote("/one", "document.title")).toBe("Fixture /one");
  slowResponse?.end("Late response");
  expect(
    (
      await shell.raw(
        "browser",
        "navigate",
        "--id",
        record.id,
        "--url",
        "http://127.0.0.1:1/failed",
      )
    ).code,
  ).not.toBe(0);
  await expect(shell.pane(record.paneId)).toContainText(/ERR_|failed/i);
  await shell.cli(
    "browser",
    "navigate",
    "--id",
    record.id,
    "--url",
    origin + "/two",
  );
  expect(await remote("/two", "document.title")).toBe("Fixture /two");
  expect((await inspect(record.id)).paneId).toBe(record.paneId);
});

test("Browser native keyboard closes its own tab and retains the conversation workspace", async () => {
  const workspace = await shell.create("Browser native close");
  const draft = (await shell.workspace(workspace)).activePaneId;
  const record = await open(workspace);
  await pageKey("/one", "W", [
    process.platform === "darwin" ? "meta" : "control",
  ]);
  await expect(shell.pane(record.paneId)).toHaveCount(0);
  await expect.poll(() => nativeView("/one")).toBe(null);
  await expect(
    shell.pane(draft).getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  expect((await shell.state()).activeWorkspaceId).toBe(workspace);
});

test("Browser failed page-driven navigation stays inspectable and reload recovers", async ({}, info) => {
  const workspace = await shell.create("Browser failure recovery");
  const record = await open(workspace);
  await remote(
    "/one",
    "void setTimeout(() => location.href='/recoverable?code=invented-private-query', 0)",
  );
  await expect
    .poll(async () => (await inspect(record.id)).error)
    .toContain("ERR_EMPTY_RESPONSE");
  const failed = await inspect(record.id);
  expect(failed.url).toBe(origin + "/recoverable?code=invented-private-query");
  expect(failed.error).not.toContain("invented-private-query");
  expect(failed.loading).toBe(false);
  await expect(shell.pane(record.paneId)).toContainText("Page could not load");
  await expect
    .poll(
      async () =>
        (await nativeView("/recoverable?code=invented-private-query"))?.visible,
    )
    .toBe(false);
  await shell.page.screenshot({
    path: info.outputPath("page-load-failure.png"),
  });
  brokenPage = false;
  await shell
    .pane(record.paneId)
    .getByRole("button", { name: "Reload page", exact: true })
    .click();
  await expect
    .poll(async () => (await inspect(record.id)).error)
    .toBeUndefined();
  await expect
    .poll(async () => (await inspect(record.id)).title)
    .toBe("Fixture /recoverable");
  await shell.page.screenshot({
    path: info.outputPath("page-load-recovered.png"),
  });
});

test("Browser authentication popup follows redirects and retains its opener", async () => {
  const workspace = await shell.create("Invented popup authentication");
  await open(workspace);
  await remote("/one", "void window.open('/oauth-start', 'invented-auth')");
  await expect
    .poll(() => remote("/one", "window.popupResult"))
    .toBe("invented-auth-complete");
  expect(
    await remote("/one", "typeof window.require + ':' + typeof window.cod"),
  ).toBe("undefined:undefined");
});

test("Browser OAuth loop error stays compact and redacts parameters while retry preserves the destination", async ({}, info) => {
  const workspace = await shell.create("Invented authorization");
  await shell.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1270, 800),
  );
  const record = await open(workspace);
  const pathname =
    "/oauth-loop/" + "invented-authorization-destination-".repeat(5);
  const query =
    "?response_type=code&state=PRIVATE_STATE_SENTINEL&code_challenge=PRIVATE_CHALLENGE_SENTINEL&redirect_uri=https%3A%2F%2Fexample.invalid%2Fcallback";
  const fragment = "#PRIVATE_FRAGMENT_SENTINEL";
  const destination = origin + pathname + query + fragment;
  await remote(
    "/one",
    `void setTimeout(() => location.href=${JSON.stringify(destination)}, 0)`,
  );
  await expect
    .poll(async () => (await inspect(record.id)).error)
    .toContain("ERR_TOO_MANY_REDIRECTS");
  const pane = shell.pane(record.paneId);
  const failure = pane.locator(".browser-failure");
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("The site redirected too many times.");
  for (const secret of [
    "PRIVATE_STATE_SENTINEL",
    "PRIVATE_CHALLENGE_SENTINEL",
    "PRIVATE_FRAGMENT_SENTINEL",
    "response_type",
    "redirect_uri",
  ]) {
    await expect(failure).not.toContainText(secret);
    expect((await inspect(record.id)).error).not.toContain(secret);
  }
  expect((await inspect(record.id)).url).toBe(destination);
  const width = (await pane.boundingBox())!.width;
  expect(width).toBeGreaterThanOrEqual(510);
  expect(width).toBeLessThanOrEqual(550);
  expect(
    await failure.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await shell.page.screenshot({
    path: info.outputPath("narrow-oauth-error.png"),
  });
  const retry = pane.getByRole("button", { name: "Reload page", exact: true });
  await retry.focus();
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  await expect(
    shell.page.getByRole("dialog", { name: "Command palette" }),
  ).toBeVisible();
  await shell.page.keyboard.press("Escape");
  await expect(retry).toBeFocused();
  brokenPage = false;
  requests = [];
  await retry.press("Enter");
  await expect
    .poll(async () => (await inspect(record.id)).error)
    .toBeUndefined();
  await expect.poll(() => requests.includes(pathname + query)).toBe(true);
  expect((await inspect(record.id)).url).toBe(destination);
  await expect(failure).toBeHidden();
  expect(await remote(pathname + query + fragment, "location.href")).toBe(
    destination,
  );
});

test("Browser default scrollbars match Cod while authored nested scrolling survives reload", async ({}, info) => {
  const workspace = await shell.create("Scrollbar fixture");
  const browser = await open(workspace, "/scrollbars");
  await expect
    .poll(async () => (await inspect(browser.id)).loading)
    .toBe(false);
  const styles = () =>
    remote(
      "/scrollbars",
      `(() => {
    const ordinary=document.querySelector('#ordinary'), custom=document.querySelector('#custom'), hidden=document.querySelector('#hidden');
    return {width:getComputedStyle(ordinary,'::-webkit-scrollbar').width, thumb:getComputedStyle(ordinary,'::-webkit-scrollbar-thumb').backgroundColor,
      customWidth:getComputedStyle(custom,'::-webkit-scrollbar').width,customThumb:getComputedStyle(custom,'::-webkit-scrollbar-thumb').backgroundColor,
      hidden:getComputedStyle(hidden).scrollbarWidth,hiddenDisplay:getComputedStyle(hidden,'::-webkit-scrollbar').display};
  })()`,
    );
  const shellStyle = await shell.page
    .locator("#workspace-tree")
    .evaluate((node) => ({
      width: getComputedStyle(node, "::-webkit-scrollbar").width,
      thumb: getComputedStyle(node, "::-webkit-scrollbar-thumb")
        .backgroundColor,
    }));
  await expect.poll(styles).toMatchObject({
    ...shellStyle,
    customWidth: "18px",
    customThumb: "rgb(180, 80, 70)",
    hidden: "none",
    hiddenDisplay: "none",
  });
  async function capture(name: string) {
    const png = await shell.app!.evaluate(
      async ({ webContents }, url) =>
        (
          await webContents
            .getAllWebContents()
            .find((w) => w.getURL() === url)!
            .capturePage()
        )
          .toPNG()
          .toString("base64"),
      origin + "/scrollbars",
    );
    await writeFile(info.outputPath(name), Buffer.from(png, "base64"));
  }
  await expect
    .poll(() =>
      remote(
        "/scrollbars",
        `(() => {const frame=document.querySelector('#frame');return frame.contentWindow.getComputedStyle(frame.contentDocument.documentElement,'::-webkit-scrollbar').width})()`,
      ),
    )
    .toBe(shellStyle.width);
  await capture("native-scrollbar-defaults.png");
  const point = await remote(
    "/scrollbars",
    `(() => {const r=document.querySelector('#ordinary').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
  );
  await shell.app!.evaluate(
    ({ webContents }, args) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL() === args.url)!;
      wc.sendInputEvent({ type: "mouseMove", ...args.point });
      wc.sendInputEvent({
        type: "mouseWheel",
        ...args.point,
        deltaY: -100,
        canScroll: true,
        deltaX: 0,
      });
    },
    { url: origin + "/scrollbars", point },
  );
  await expect
    .poll(() =>
      remote("/scrollbars", "document.querySelector('#ordinary').scrollTop"),
    )
    .toBeGreaterThan(0);
  expect(
    await remote("/scrollbars", "document.scrollingElement.scrollTop"),
  ).toBe(0);
  await capture("native-scrollbar-nested-scrolled.png");
  await pageKey("/scrollbars", "PageDown");
  await expect
    .poll(() => remote("/scrollbars", "document.scrollingElement.scrollTop"))
    .toBeGreaterThan(0);
  await capture("native-scrollbar-page-scrolled.png");

  const requestsBefore = requests.filter(
    (route) => route === "/scrollbars",
  ).length;
  await shell
    .pane(browser.paneId)
    .getByRole("button", { name: "Reload", exact: true })
    .click();
  await expect
    .poll(() => requests.filter((route) => route === "/scrollbars").length)
    .toBeGreaterThan(requestsBefore);
  await expect
    .poll(async () => (await inspect(browser.id)).loading)
    .toBe(false);
  await expect.poll(styles).toMatchObject({
    ...shellStyle,
    customWidth: "18px",
    customThumb: "rgb(180, 80, 70)",
    hidden: "none",
    hiddenDisplay: "none",
  });
  await capture("native-scrollbar-reloaded.png");
  await shell.page.screenshot({
    path: info.outputPath("scrollbar-shell-and-page.png"),
  });
});

test("Local address suggestions, searchable history and search engine settings survive restart", async ({}, info) => {
  const workspace = await shell.create("History fixture");
  const record = await open(workspace, "/history-fixture");
  await expect
    .poll(() =>
      shell.cli<Array<{ url: string }>>(
        "browser",
        "history",
        "--query",
        "history-fixture",
      ),
    )
    .toEqual([expect.objectContaining({ url: origin + "/history-fixture" })]);
  const home = await shell.cli<BrowserRecord>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    "about:blank",
  );
  const address = shell
    .pane(home.paneId)
    .getByRole("textbox", { name: "Address", exact: true });
  await address.focus();
  await address.fill("history-fixture");
  await expect(shell.pane(home.paneId).getByRole("option")).toContainText(
    "Fixture /history-fixture",
  );
  await shell.page.screenshot({
    path: info.outputPath("address-suggestions.png"),
  });
  await address.press("ArrowDown");
  await address.press("Enter");
  await expect
    .poll(async () => (await inspect(home.id)).url)
    .toBe(origin + "/history-fixture");
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  await shell.page
    .getByRole("textbox", { name: "Filter commands" })
    .fill("Browser settings");
  await shell.page.keyboard.press("Enter");
  await shell.page
    .getByLabel("Search engine", { exact: true })
    .selectOption("duckduckgo");
  await shell.page.getByRole("button", { name: "Done", exact: true }).click();
  await expect
    .poll(() => shell.cli("browser", "settings"))
    .toEqual({ searchEngine: "duckduckgo" });
  await shell.stop();
  await shell.start();
  expect(await shell.cli("browser", "settings")).toEqual({
    searchEngine: "duckduckgo",
  });
  await info.attach("restored-address-state", {
    body: JSON.stringify({
      url: shell.page.url(),
      state: await shell.cli("state"),
      html: await shell.page.locator("body").innerText(),
    }),
    contentType: "application/json",
  });
  await shell.page.screenshot({
    path: info.outputPath("restored-address.png"),
  });
  await shell
    .pane(home.paneId)
    .getByRole("textbox", { name: "Address", exact: true })
    .click();
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  await shell.page
    .getByRole("textbox", { name: "Filter commands" })
    .fill("Browsing history");
  await shell.page.keyboard.press("Enter");
  await shell.page
    .getByRole("textbox", { name: "Search history" })
    .fill("history-fixture");
  await expect(
    shell.page.getByRole("dialog", { name: "Browsing history" }),
  ).toContainText(origin + "/history-fixture");
  await shell.page
    .getByRole("button", { name: "Clear history", exact: true })
    .click();
  expect(await shell.cli("browser", "history")).toEqual([]);
});

test("Site media permissions require a page-bound decision and retain only remembered grants", async ({}, info) => {
  await shell.stop();
  shell.launchArguments.push("--use-fake-device-for-media-stream");
  await shell.start();
  const workspace = await shell.create("Media permissions");
  const record = await open(workspace, "/media-fixture");
  const request = () =>
    remote(
      "/media-fixture",
      `window.mediaResult='pending';navigator.mediaDevices.getUserMedia({audio:true,video:true}).then(stream=>{window.mediaResult=stream.getTracks().map(track=>track.kind).sort().join(',');stream.getTracks().forEach(track=>track.stop());},error=>window.mediaResult=error.name);void 0`,
    );
  await request();
  const prompt = () =>
    shell
      .pane(record.paneId)
      .getByRole("region", { name: "Site permission request" });
  await expect(prompt()).toContainText("camera");
  await expect(prompt()).toContainText("microphone");
  await shell.page.screenshot({ path: info.outputPath("site-permission.png") });
  await prompt()
    .getByRole("button", { name: "Allow once", exact: true })
    .click();
  await expect
    .poll(() => remote("/media-fixture", "window.mediaResult"))
    .toBe("audio,video");
  expect(await shell.cli("browser", "permissions")).toEqual([]);
  await shell.cli("browser", "reload", "--id", record.id);
  await request();
  await expect(prompt()).toBeVisible();
  await prompt()
    .getByRole("button", { name: "Always allow", exact: true })
    .click();
  await expect
    .poll(() => remote("/media-fixture", "window.mediaResult"))
    .toBe("audio,video");
  await shell.stop();
  await shell.start();
  await request();
  await expect
    .poll(() => remote("/media-fixture", "window.mediaResult"))
    .toBe("audio,video");
  await expect(prompt()).toHaveCount(0);
  await shell.command("Site permissions");
  await shell.page
    .getByRole("dialog", { name: "Site permissions" })
    .getByLabel(`Camera for ${origin}`, { exact: true })
    .selectOption("ask");
  await shell.page.getByRole("button", { name: "Done", exact: true }).click();
  await expect
    .poll(async () =>
      (
        await shell.cli<Array<{ permission: string }>>("browser", "permissions")
      ).some((item) => item.permission === "camera"),
    )
    .toBe(false);
  await shell.cli("browser", "reload", "--id", record.id);
  await request();
  await expect(prompt()).toBeVisible();
  const stale = (
    await shell.cli<{ permissionRequests: Array<{ id: string }> }>(
      "browser",
      "inspect",
      "--id",
      record.id,
    )
  ).permissionRequests[0].id;
  await shell.cli(
    "browser",
    "navigate",
    "--id",
    record.id,
    "--url",
    origin + "/other-page",
  );
  expect(
    (
      await shell.raw(
        "browser",
        "permission-answer",
        "--request-id",
        stale,
        "--decision",
        "allow",
      )
    ).code,
  ).not.toBe(0);
  await expect(prompt()).toHaveCount(0);
  await remote(
    "/other-page",
    `Notification.requestPermission().then(result=>window.notificationResult=result);void 0`,
  );
  await expect(prompt()).toContainText("notifications");
  await prompt()
    .getByRole("button", { name: "Allow once", exact: true })
    .click();
  await expect
    .poll(() => remote("/other-page", "window.notificationResult"))
    .toBe("granted");
  expect(await remote("/other-page", "Notification.permission")).toBe(
    "granted",
  );
});

test("Downloads survive tab closure and retain history across restart", async () => {
  const workspace = await shell.create("Downloads");
  const record = await open(workspace);
  await remote(
    "/one",
    `const a = document.createElement('a'); a.href='/slow-download'; document.body.append(a); a.click();`,
  );
  const entries = () =>
    shell.cli<Array<{ id: string; status: string; receivedBytes: number }>>(
      "browser",
      "downloads",
    );
  await expect.poll(async () => (await entries()).length).toBe(1);
  const id = (await entries())[0]!.id;
  await shell.cli(
    "browser",
    "download-action",
    "--id",
    id,
    "--action",
    "pause",
  );
  await expect.poll(async () => (await entries())[0]?.status).toBe("paused");
  await shell.cli("browser", "close", "--id", record.id);
  await shell.cli(
    "browser",
    "download-action",
    "--id",
    id,
    "--action",
    "resume",
  );
  await expect.poll(async () => (await entries())[0]?.status).toBe("completed");
  expect((await readFile(path.join(downloads, "large.bin"))).length).toBe(
    1024 * 1024,
  );
  await shell.stop();
  await shell.start();
  await expect.poll(async () => (await entries())[0]?.status).toBe("completed");
  await shell.page
    .getByRole("treeitem", { name: "Downloads, Idle", exact: true })
    .click();
  await shell.command("Downloads");
  const dialog = shell.page!.getByRole("dialog", {
    name: "Downloads",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Show in folder" }),
  ).toBeVisible();
  await shell.page!.screenshot({
    path: test.info().outputPath("downloads.png"),
  });
  await dialog.getByRole("button", { name: "Remove from list" }).click();
  await expect.poll(async () => (await entries()).length).toBe(0);
  expect((await readFile(path.join(downloads, "large.bin"))).length).toBe(
    1024 * 1024,
  );
});

test("Interrupted downloads retry explicitly and cancellations retain no partial file", async () => {
  const workspace = await shell.create("Interrupted downloads");
  await open(workspace);
  const entries = () =>
    shell.cli<Array<{ id: string; status: string }>>("browser", "downloads");
  await remote("/one", `location.href='/slow-download'`);
  await expect.poll(async () => (await entries()).length).toBe(1);
  const id = (await entries())[0]!.id;
  await shell.stop();
  await shell.start();
  expect((await entries())[0]?.status).toBe("interrupted");
  await shell.cli(
    "browser",
    "download-action",
    "--id",
    id,
    "--action",
    "retry",
  );
  await expect.poll(async () => (await entries()).length).toBe(2);
  const retry = (await entries())[0]!.id;
  await shell.cli(
    "browser",
    "download-action",
    "--id",
    retry,
    "--action",
    "cancel",
  );
  await expect.poll(async () => (await entries())[0]?.status).toBe("cancelled");
  await expect.poll(async () => (await readdir(downloads)).length).toBe(0);
  await shell.cli(
    "browser",
    "download-action",
    "--id",
    retry,
    "--action",
    "retry",
  );
  await expect.poll(async () => (await entries())[0]?.status).toBe("completed");
});

test("Optional bookmarks edit in place and stay separate from home pins", async () => {
  const workspace = await shell.create("Bookmarks");
  const record = await open(workspace);
  await shell
    .pane(record.paneId)
    .getByRole("textbox", { name: "Address", exact: true })
    .click();
  await shell.command("Bookmark current page");
  await expect
    .poll(
      async () => (await shell.cli<unknown[]>("browser", "bookmarks")).length,
    )
    .toBe(1);
  await shell.command("Bookmarks");
  const dialog = () =>
    shell.page.getByRole("dialog", { name: "Bookmarks", exact: true });
  await dialog().getByRole("button", { name: "Edit", exact: true }).click();
  await dialog()
    .getByRole("textbox", { name: "Bookmark name" })
    .fill("Reading list");
  await dialog()
    .getByRole("textbox", { name: "Bookmark address" })
    .fill(origin + "/reading");
  await dialog().getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    dialog().getByRole("button", { name: "Reading list", exact: true }),
  ).toBeVisible();
  await shell.page.screenshot({
    path: test.info().outputPath("bookmarks.png"),
  });
  await dialog().getByRole("button", { name: "Done", exact: true }).click();
  await shell.cli("browser", "history-clear");
  await shell.stop();
  await shell.start();
  expect(await shell.cli("browser", "bookmarks", "--query", "reading")).toEqual(
    [
      expect.objectContaining({
        title: "Reading list",
        url: origin + "/reading",
      }),
    ],
  );
  const state = await shell.cli<{ pinnedSites: unknown[] }>("state");
  expect(state.pinnedSites).toEqual([]);
  const suggestions = await shell.cli<Array<{ title: string }>>(
    "browser",
    "suggest",
    "--query",
    "reading",
  );
  expect(suggestions[0]?.title).toBe("Reading list");
  await shell
    .pane(record.paneId)
    .getByRole("textbox", { name: "Address", exact: true })
    .click();
  await shell.command("Bookmarks");
  await dialog()
    .getByRole("textbox", { name: "Search bookmarks" })
    .fill("reading");
  await dialog()
    .getByRole("textbox", { name: "Search bookmarks" })
    .press("ArrowDown");
  await expect(
    dialog().getByRole("button", { name: "Reading list", exact: true }),
  ).toBeFocused();
  await shell.page.keyboard.press("Enter");
  await expect
    .poll(async () =>
      (await shell.cli<{ browsers: BrowserRecord[] }>("state")).browsers.some(
        (item) => item.url === origin + "/reading",
      ),
    )
    .toBe(true);
  await expect(dialog()).toHaveCount(0);
  await shell.command("Bookmarks");
  await dialog().getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog()).toContainText("No bookmarks");
});

test("Development builds explain why default browser registration needs a package", async () => {
  const status = await shell.cli<{ available: boolean; reason: string }>(
    "browser",
    "default-status",
  );
  expect(status.available).toBe(false);
  expect(status.reason).toContain("packaged");
  expect((await shell.raw("browser", "register-default")).code).not.toBe(0);
  await shell.page
    .getByRole("button", { name: "Overview", exact: true })
    .focus();
  await shell.command("Default browser...");
  const dialog = shell.page.getByRole("dialog", {
    name: "Default browser",
    exact: true,
  });
  await expect(dialog).toContainText("packaged");
  await expect(
    dialog.getByRole("button", { name: "Make default browser" }),
  ).toHaveCount(0);
});

test("Guarded tab close keeps the page and form on Stay and removes them only on Leave", async () => {
  const workspace = await shell.create("Protected form");
  const browser = await open(workspace);
  await expect
    .poll(async () => (await inspect(browser.id)).loading)
    .toBe(false);
  await remote(
    "/one",
    `document.body.innerHTML = '<input id="unsaved" value="Invented unsaved form">'; document.querySelector('input').focus(); window.onbeforeunload = () => false; void 0;`,
  );
  await pageKey("/one", "A");
  const typed = await remote("/one", `document.querySelector('input').value`);
  await shell.app!.evaluate(({ dialog }) => {
    Object.assign(globalThis, { formClosePrompts: [], formCloseResponse: 0 });
    Object.assign(dialog, {
      showMessageBox: async (...args: any[]) => {
        const state = globalThis as any;
        state.formClosePrompts.push(args.at(-1));
        return { response: state.formCloseResponse, checkboxChecked: false };
      },
    });
  });
  // Exercise the real page key route and pane.close, not a synthetic DOM event.
  await pageKey("/one", "W", [
    process.platform === "darwin" ? "meta" : "control",
  ]);
  await expect
    .poll(() =>
      shell.app!.evaluate(() => (globalThis as any).formClosePrompts.length),
    )
    .toBe(1);
  await expect(shell.pane(browser.paneId)).toBeVisible();
  expect(await remote("/one", `document.querySelector('input').value`)).toBe(
    typed,
  );
  const state = await shell.cli<any>("state");
  expect(
    state.workspaces.find((w: any) => w.id === workspace).closedTabs ?? [],
  ).toHaveLength(0);
  await shell.app!.evaluate(() => {
    (globalThis as any).formCloseResponse = 1;
  });
  const closed = await shell.cli<{ closed: boolean }>(
    "browser",
    "close",
    "--id",
    browser.id,
  );
  expect(closed.closed).toBe(true);
  await expect(shell.pane(browser.paneId)).toHaveCount(0);
});

test("Guarded workspace close cancels before removing the workspace or its page", async () => {
  const workspace = await shell.create("Protected workspace form");
  const browser = await open(workspace);
  await expect
    .poll(async () => (await inspect(browser.id)).loading)
    .toBe(false);
  await remote(
    "/one",
    `document.body.innerHTML = '<input value="Workspace draft">'; document.querySelector('input').focus(); window.onbeforeunload = () => false; void 0;`,
  );
  await pageKey("/one", "A");
  await shell.app!.evaluate(({ dialog }) => {
    Object.assign(dialog, {
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    });
  });
  const result = await shell.cli<{ closed: boolean }>(
    "workspace",
    "close",
    "--id",
    workspace,
  );
  expect(result.closed).toBe(false);
  expect((await inspect(browser.id)).id).toBe(browser.id);
  expect(
    await remote("/one", `document.querySelector('input').value`),
  ).toContain("Workspace draft");
  await expect(shell.row("Protected workspace form")).toBeVisible();
});

test("File search covers the native browser with the Cod surface and restores its page", async () => {
  const workspace = await shell.create("File search cover");
  await shell.cli(
    "workspace",
    "add-folder",
    "--id",
    workspace,
    "--path",
    shell.folders[0],
  );
  const browser = await open(workspace);
  await expect
    .poll(async () => (await inspect(browser.id)).loading)
    .toBe(false);
  await remote(
    "/one",
    `document.body.innerHTML = '<input id="retained" value="Invented retained form">'; document.querySelector('input').focus(); void 0;`,
  );
  const identity = await remote("/one", "window.identity");
  // Linux reserves a website's Ctrl+P for printing. Exercise the shared Open
  // file action through Commands, independent of platform shortcut defaults.
  await shell.app!.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.focus();
  });
  await shell.command("Open file");
  const search = shell.page.getByRole("dialog", {
    name: "Open file",
    exact: true,
  });
  await expect(search).toBeVisible();
  await expect
    .poll(async () => (await nativeView("/one"))?.visible)
    .toBe(false);
  const cover = shell
    .pane(browser.paneId)
    .getByRole("region", { name: "Browser content", exact: true });
  const colors = await cover.evaluate((node) => ({
    cover: getComputedStyle(node).backgroundColor,
    panel: getComputedStyle(document.documentElement)
      .getPropertyValue("--panel")
      .trim(),
  }));
  expect(colors.cover).toBe("rgb(47, 52, 61)");
  await shell.page.keyboard.press("Escape");
  await expect.poll(async () => (await nativeView("/one"))?.visible).toBe(true);
  expect(await remote("/one", "window.identity")).toBe(identity);
  expect(await remote("/one", `document.querySelector('input').value`)).toBe(
    "Invented retained form",
  );
});

test("Restart loads only visible browser tabs and leaves inactive workspace pages dormant", async () => {
  const first = await shell.create("Visible browser workspace");
  const active = await open(first, "/one");
  const second = await shell.create("Dormant browser workspace");
  const inactive = await open(second, "/two");
  await shell.cli("workspace", "focus", "--id", first);
  await expect.poll(async () => (await nativeView("/one"))?.visible).toBe(true);
  await shell.stop();
  requests = [];
  await shell.start();
  await expect.poll(() => nativeView("/one")).not.toBeNull();
  await expect
    .poll(() => remote("/one", "document.querySelector('h1')?.textContent"))
    .toBe("Invented browser page /one");
  await expect.poll(() => requests.some((url) => url === "/one")).toBe(true);
  // A read-only inspection and unrelated state notification must not wake it.
  expect((await inspect(inactive.id)).url).toBe(origin + "/two");
  await shell.cli(
    "workspace",
    "rename",
    "--id",
    first,
    "--name",
    "Still visible",
  );
  await expect(shell.row("Still visible")).toBeVisible();
  expect(requests.some((url) => url === "/two")).toBe(false);
  expect(await nativeView("/two")).toBeNull();
  await shell.cli("workspace", "focus", "--id", second);
  await expect.poll(async () => (await nativeView("/two"))?.visible).toBe(true);
  expect(requests.filter((url) => url === "/two")).toHaveLength(1);
  const identity = await remote("/two", "window.identity");
  await remote(
    "/two",
    `document.body.innerHTML = '<input value="Retained workspace form">'; void 0;`,
  );
  await shell.cli("workspace", "focus", "--id", first);
  await shell.cli("workspace", "focus", "--id", second);
  await expect.poll(async () => (await nativeView("/two"))?.visible).toBe(true);
  expect(await remote("/two", "window.identity")).toBe(identity);
  expect(await remote("/two", `document.querySelector('input').value`)).toBe(
    "Retained workspace form",
  );
  expect(requests.filter((url) => url === "/two")).toHaveLength(1);
  expect((await inspect(active.id)).url).toBe(origin + "/one");
});

test("Quitting while a page-close decision is pending preserves its tab for restart", async () => {
  const workspace = await shell.create("Pending close during quit");
  const browser = await open(workspace);
  await expect
    .poll(async () => (await inspect(browser.id)).loading)
    .toBe(false);
  await remote(
    "/one",
    `document.body.innerHTML = '<input value="Invented unsaved form">'; document.querySelector('input').focus(); window.onbeforeunload = () => false; void 0;`,
  );
  await pageKey("/one", "A");
  await shell.app!.evaluate(({ dialog }) => {
    Object.assign(globalThis, { pendingCloseShown: false });
    Object.assign(dialog, {
      showMessageBox: () => {
        (globalThis as any).pendingCloseShown = true;
        return new Promise(() => {});
      },
    });
  });
  await pageKey("/one", "W", [
    process.platform === "darwin" ? "meta" : "control",
  ]);
  await expect
    .poll(() =>
      shell.app!.evaluate(() => (globalThis as any).pendingCloseShown),
    )
    .toBe(true);
  await shell.stop();
  const saved = JSON.parse(
    await readFile(path.join(shell.data, "state.json"), "utf8"),
  );
  expect(saved.browsers.some((item: any) => item.id === browser.id)).toBe(true);
  await shell.start();
  expect((await inspect(browser.id)).paneId).toBe(browser.paneId);
});

test("Ordinary target blank links become managed tabs in the opener group and survive restart", async () => {
  const workspace = await shell.create("Managed browser tabs");
  const parent = await open(workspace);
  await remote(
    "/one",
    `{
    window.parentIdentity = window.identity;
    const a = document.createElement('a'); a.target = '_blank'; a.href = '/two'; document.body.append(a); a.click();
  }`,
  );
  const tabs = async () =>
    (await shell.cli<{ browsers: BrowserRecord[] }>("state")).browsers;
  await expect
    .poll(
      async () =>
        (await tabs()).filter((item) => item.url === origin + "/two").length,
    )
    .toBe(1);
  await expect.poll(() => nativeView("/two")).not.toBeNull();
  await expect
    .poll(() => remote("/two", "document.readyState"))
    .toBe("complete");
  const child = (await tabs()).find((item) => item.url === origin + "/two")!;
  expect((await shell.workspace(workspace)).activePaneId).toBe(child.paneId);
  expect(
    await remote("/one", "window.identity === window.parentIdentity"),
  ).toBe(true);
  expect(await remote("/two", "window.opener === null")).toBe(true);
  expect(
    await shell.app!.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);
  const state = await shell.cli<import("../../src/types").AppState>("state");
  expect(
    state.workspaces
      .find((w) => w.id === workspace)!
      .groups!.find((g) => g.paneIds.includes(parent.paneId))!.paneIds,
  ).toContain(child.paneId);
  expect(await remote("/two", "typeof require + ':' + typeof window.cod")).toBe(
    "undefined:undefined",
  );
  await expect.poll(async () => (await nativeView("/two"))?.visible).toBe(true);
  // Main-window capture excludes native child views. Capture the page itself
  // as well as checking its real attachment, bounds and visibility above.
  const screenshot = await shell.app!.evaluate(async ({ webContents }, url) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL() === url)!;
    return (await contents.capturePage()).toPNG().toString("base64");
  }, origin + "/two");
  await writeFile(
    test.info().outputPath("managed-browser-tab.png"),
    Buffer.from(screenshot, "base64"),
  );
  const identity = await remote("/two", "window.identity");
  await remote(
    "/two",
    "document.querySelector('input').value = 'invented unsaved form'",
  );
  await shell.cli("browser", "close", "--id", parent.id);
  expect(await remote("/two", "window.identity")).toBe(identity);
  expect(await remote("/two", "document.querySelector('input').value")).toBe(
    "invented unsaved form",
  );
  await shell.stop();
  await shell.start();
  expect((await tabs()).map((item) => item.id)).toEqual(
    expect.arrayContaining([child.id]),
  );
});

test("Unnamed authentication tabs retain opener messaging, POST navigation and page self-close", async () => {
  const workspace = await shell.create("Tab opener compatibility");
  const parent = await open(workspace);
  await remote("/one", `void window.open('/popup')`);
  await expect
    .poll(() => remote("/one", "window.popupResult"))
    .toBe("fixture-popup");
  const tabs = async () =>
    (await shell.cli<{ browsers: BrowserRecord[] }>("state")).browsers;
  await expect
    .poll(
      async () =>
        (await tabs()).filter((item) => item.url === origin + "/popup").length,
    )
    .toBe(1);
  expect(await remote("/popup", "window.opener !== null")).toBe(true);
  await remote("/popup", "window.close()");
  await expect
    .poll(async () =>
      (await tabs()).some((item) => item.url === origin + "/popup"),
    )
    .toBe(false);
  await shell.cli(
    "pane",
    "focus",
    "--workspace",
    workspace,
    "--id",
    parent.paneId,
  );
  await remote(
    "/one",
    `{
    const form = document.createElement('form'); form.method = 'post'; form.action = '/new-tab-post'; form.target = '_blank';
    const input = document.createElement('input'); input.name = 'fixture'; input.value = 'invented'; form.append(input); document.body.append(form); form.submit();
  }`,
  );
  await expect.poll(() => nativeView("/new-tab-post")).not.toBeNull();
  await expect
    .poll(() => remote("/new-tab-post", "document.body.textContent"))
    .toBe("POST:fixture=invented");
  await expect
    .poll(async () =>
      (await tabs()).some((item) => item.url === origin + "/new-tab-post"),
    )
    .toBe(true);
  expect(
    await shell.app!.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);
});

test("New browser tabs opened in a background workspace retain their origin without stealing focus", async () => {
  const first = await shell.create("Origin workspace");
  const parent = await open(first);
  const second = await shell.create("Foreground workspace");
  const activePane = (await shell.workspace(second)).activePaneId;
  await remote("/one", "void window.open('/two')");
  const tabs = async () =>
    (await shell.cli<{ browsers: BrowserRecord[] }>("state")).browsers;
  await expect
    .poll(async () =>
      (await tabs()).some((item) => item.url === origin + "/two"),
    )
    .toBe(true);
  const child = (await tabs()).find((item) => item.url === origin + "/two")!;
  expect(child.workspaceId).toBe(first);
  expect((await shell.state()).activeWorkspaceId).toBe(second);
  expect((await shell.workspace(second)).activePaneId).toBe(activePane);
  expect((await shell.workspace(first)).activePaneId).toBe(parent.paneId);
  await expect.poll(() => nativeView("/two")).not.toBeNull();
  expect((await nativeView("/two"))?.visible).toBe(false);
});

test("Reopening a browser tab restores Back and Forward without extra history requests or form payloads", async () => {
  const workspace = await shell.create("Tab navigation history");
  const record = await open(workspace);
  for (const route of ["/two", "/three"])
    await shell.cli(
      "browser",
      "navigate",
      "--id",
      record.id,
      "--url",
      origin + route,
    );
  await shell.cli("browser", "back", "--id", record.id);
  await expect
    .poll(async () => (await inspect(record.id)).url)
    .toBe(origin + "/two");
  await shell.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    record.paneId,
  );
  requests = [];
  await shell.cli("pane", "reopen", "--workspace", workspace);
  await expect
    .poll(async () => (await inspect(record.id)).url)
    .toBe(origin + "/two");
  await expect.poll(() => nativeView("/two")).not.toBeNull();
  await expect
    .poll(() => remote("/two", "document.querySelector('h1')?.textContent"))
    .toBe("Invented browser page /two");
  expect(
    requests.filter((route) => ["/one", "/two", "/three"].includes(route)),
  ).toEqual(["/two"]);
  const state = await shell.cli<import("../../src/types").AppState>("state");
  const restored = state.browsers.find((item) => item.id === record.id)!;
  expect(restored.canGoBack).toBe(true);
  expect(restored.canGoForward).toBe(true);
  expect(restored.navigation?.entries.map((item) => item.url)).toEqual(
    ["/one", "/two", "/three"].map((route) => origin + route),
  );
  expect(restored.navigation?.index).toBe(1);
  for (const [operation, destination] of [
    ["back", "/one"],
    ["forward", "/two"],
    ["forward", "/three"],
  ]) {
    await shell.cli("browser", operation, "--id", record.id);
    await expect
      .poll(async () => (await inspect(record.id)).url)
      .toBe(origin + destination);
  }
  await shell.stop();
  requests = [];
  await shell.start();
  await expect.poll(() => nativeView("/three")).not.toBeNull();
  await shell.cli("browser", "back", "--id", record.id);
  await expect
    .poll(async () => (await inspect(record.id)).url)
    .toBe(origin + "/two");
});

test("Restoring tab history never resubmits a POST form", async () => {
  const workspace = await shell.create("POST-safe history");
  const record = await open(workspace);
  await remote(
    "/one",
    `{
    const form = document.createElement('form'); form.method = 'post'; form.action = '/new-tab-post';
    const input = document.createElement('input'); input.name = 'fixture'; input.value = 'private-form-value';
    form.append(input); document.body.append(form); form.submit();
  }`,
  );
  await expect.poll(() => nativeView("/new-tab-post")).not.toBeNull();
  await expect
    .poll(() => remote("/new-tab-post", "document.body.textContent"))
    .toBe("POST:fixture=private-form-value");
  await shell.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    record.paneId,
  );
  const saved = await readFile(path.join(shell.data, "state.json"), "utf8");
  expect(saved).not.toContain("private-form-value");
  expect(saved).not.toContain('"pageState"');
  await shell.cli("pane", "reopen", "--workspace", workspace);
  await expect
    .poll(() => remote("/new-tab-post", "document.body.textContent"))
    .toBe("GET:");
  await shell.cli("browser", "back", "--id", record.id);
  await expect
    .poll(async () => (await inspect(record.id)).url)
    .toBe(origin + "/one");
});

test("Failed tab restoration keeps navigation passive and explicit recovery retains older Back entries", async () => {
  const workspace = await shell.create("Failed page history");
  const record = await open(workspace);
  await shell.cli(
    "browser",
    "navigate",
    "--id",
    record.id,
    "--url",
    origin + "/two",
  );
  const failed = await shell.raw(
    "browser",
    "navigate",
    "--id",
    record.id,
    "--url",
    origin + "/recoverable",
  );
  expect(failed.code).not.toBe(0);
  await expect
    .poll(async () => Boolean((await inspect(record.id)).error))
    .toBe(true);
  await shell.stop();
  requests = [];
  await shell.start();
  await expect(
    shell.pane(record.paneId).locator(".browser-failure"),
  ).toBeVisible();
  expect(
    requests.filter((route) =>
      ["/one", "/two", "/recoverable"].includes(route),
    ),
  ).toEqual([]);
  await shell.cli("browser", "recover", "--id", record.id);
  await expect
    .poll(async () => (await inspect(record.id)).url)
    .toBe(origin + "/two");
  await shell.cli("browser", "back", "--id", record.id);
  await expect
    .poll(async () => (await inspect(record.id)).url)
    .toBe(origin + "/one");
});

test("Local HTML uses ordinary browser navigation, recovery and persisted history", async ({}, info) => {
  const workspace = await shell.create("Local reports");
  const folder = path.join(shell.folders[0], "reports");
  await mkdir(folder);
  const file = path.join(folder, "report #1%.html");
  const evidence = path.join(shell.folders[0], "evidence.txt");
  await writeFile(evidence, "INVENTED_LOCAL_EVIDENCE");
  await writeFile(
    path.join(folder, "theme.css"),
    "h1 { color: rgb(12, 34, 56); }",
  );
  await writeFile(
    file,
    `<!doctype html><title>Local fixture report</title><link rel="stylesheet" href="theme.css"><h1>Local report</h1><a href="../evidence.txt">Evidence</a><a href="missing.html">Missing evidence</a><form><input aria-label="Local answer"></form><!--${"x".repeat(2_100_000)}-->`,
  );
  const url = pathToFileURL(file).href;
  const opened = await shell.cli<BrowserRecord>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    url,
  );
  const pane = shell.pane(opened.paneId);
  const address = pane.getByRole("textbox", { name: "Address", exact: true });
  await expect(address).toHaveValue(url);
  const page = async () => {
    await expect
      .poll(() =>
        shell
          .app!.context()
          .pages()
          .some((p) => p.url() === url),
      )
      .toBe(true);
    return shell
      .app!.context()
      .pages()
      .find((p) => p.url() === url)!;
  };
  let content = await page();
  await expect(
    content.getByRole("heading", { name: "Local report" }),
  ).toBeVisible();
  expect(
    await content
      .getByRole("heading")
      .evaluate((e) => getComputedStyle(e).color),
  ).toBe("rgb(12, 34, 56)");
  expect(
    await content.evaluate(() => ({
      cod: typeof window.cod,
      node: typeof (window as any).require,
      bridge: typeof (window as any).codPage,
    })),
  ).toEqual({ cod: "undefined", node: "undefined", bridge: "undefined" });
  await content.getByRole("link", { name: "Evidence", exact: true }).click();
  await expect(content.locator("body")).toContainText(
    "INVENTED_LOCAL_EVIDENCE",
  );
  await pane.getByRole("button", { name: "Back", exact: true }).click();
  await expect(
    content.getByRole("heading", { name: "Local report" }),
  ).toBeVisible();
  await pane.getByRole("button", { name: "Forward", exact: true }).click();
  await expect(content.locator("body")).toContainText(
    "INVENTED_LOCAL_EVIDENCE",
  );
  await shell.stop();
  await shell.start();
  await expect(
    shell
      .pane(opened.paneId)
      .getByRole("textbox", { name: "Address", exact: true }),
  ).toHaveValue(pathToFileURL(evidence).href);
  await shell
    .pane(opened.paneId)
    .getByRole("button", { name: "Back", exact: true })
    .click();
  content = await page();
  await expect(
    content.getByRole("heading", { name: "Local report" }),
  ).toBeVisible();
  await content
    .getByRole("link", { name: "Missing evidence", exact: true })
    .click();
  await expect(
    shell
      .pane(opened.paneId)
      .getByRole("region", { name: "Page could not load", exact: true }),
  ).toBeVisible();
  await shell
    .pane(opened.paneId)
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await expect(
    (await page()).getByRole("heading", { name: "Local report" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      shell.app!.evaluate(({ BrowserWindow }, url) => {
        const view = BrowserWindow.getAllWindows()
          .flatMap((w) => w.contentView.children)
          .find((v) => (v as any).webContents?.getURL() === url);
        return (
          !!view &&
          view.getVisible() &&
          view.getBounds().width > 100 &&
          view.getBounds().height > 100
        );
      }, url),
    )
    .toBe(true);
  await (
    await page()
  ).screenshot({ path: info.outputPath("local-report-content.png") });
  await shell.page.screenshot({
    path: info.outputPath("local-report-browser.png"),
  });
});

test("Selecting an address stays quiet; explicit suggestions exclude the current page and preserve navigation", async ({}, info) => {
  const workspace = await shell.create("Quiet address fixture");
  const other = await open(workspace, "/quiet-alternative");
  await remote("/quiet-alternative", "document.title");
  const current = await open(workspace, "/quiet-current");
  await remote("/quiet-current", "document.title");
  const address = shell
    .pane(current.paneId)
    .getByRole("textbox", { name: "Address", exact: true });
  const results = shell
    .pane(current.paneId)
    .getByRole("listbox", { name: "Address suggestions" });
  await pageKey("/quiet-current", "L", [
    process.platform === "darwin" ? "meta" : "control",
  ]);
  await expect(address).toBeFocused();
  expect(
    await address.evaluate((input: HTMLInputElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([0, (origin + "/quiet-current").length]);
  await address.press(`${modifier}+c`);
  expect(
    await shell.app!.evaluate(({ clipboard }) => clipboard.readText()),
  ).toBe(origin + "/quiet-current");
  await shell.page.waitForTimeout(160);
  await expect(results).toBeHidden();
  await shell
    .pane(current.paneId)
    .getByRole("button", { name: "Reload", exact: true })
    .focus();
  await address.click();
  await address.press(`${modifier}+a`);
  await shell.page.waitForTimeout(120);
  await expect(results).toBeHidden();
  await address.press("ArrowDown");
  await expect(results.getByRole("option")).toContainText("quiet-alternative");
  await expect(results).not.toContainText(origin + "/quiet-current");
  await expect(results.getByRole("option").first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await address.press("Escape");
  await expect(address).toBeFocused();
  await expect(address).toHaveValue(origin + "/quiet-current");
  await expect(results).toBeHidden();
  await address.fill("quiet");
  await expect(results.getByRole("option")).toContainText("quiet-alternative");
  await expect(results).not.toContainText(origin + "/quiet-current");
  await address.fill(origin + "/quiet-current");
  await expect(results).toBeHidden();
  await address.fill("quiet-alternative");
  await expect(results.getByRole("option")).toContainText("quiet-alternative");
  await address.press("ArrowDown");
  await address.press("Enter");
  await expect
    .poll(async () => (await inspect(current.id)).url)
    .toBe(origin + "/quiet-alternative");
  await remote("/quiet-alternative", "document.title");
  await address.focus();
  await address.fill(origin + "/quiet-alternative");
  await shell.page.waitForTimeout(160);
  await expect(results).toBeHidden();
  await shell.page.screenshot({
    path: info.outputPath("quiet-address-selection.png"),
  });
  expect((await inspect(other.id)).url).toBe(origin + "/quiet-alternative");
});

test("Address suggestions discard dismissed and superseded replies and wait for committed composition", async () => {
  const workspace = await shell.create("Delayed address fixture");
  await open(workspace, "/delayed-alternative");
  await remote("/delayed-alternative", "document.title");
  const current = await open(workspace, "/delayed-current");
  await remote("/delayed-current", "document.title");
  await shell.app!.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: any[]) => unknown>;
      }
    )._invokeHandlers;
    const original = handlers.get("cod:invoke")!;
    Object.assign(globalThis, {
      suggestionQueries: [] as string[],
      releaseSuggestion: undefined,
    });
    ipcMain.removeHandler("cod:invoke");
    ipcMain.handle("cod:invoke", async (event, request) => {
      if (request.op !== "browser.suggest") return original(event, request);
      const state = globalThis as unknown as {
        suggestionQueries: string[];
        releaseSuggestion?: () => void;
      };
      state.suggestionQueries.push(request.query);
      const response = await original(event, request);
      if (request.query === "delayed")
        await new Promise<void>((resolve) => {
          state.releaseSuggestion = resolve;
        });
      return response;
    });
  });
  const address = shell
    .pane(current.paneId)
    .getByRole("textbox", { name: "Address", exact: true });
  const results = shell
    .pane(current.paneId)
    .getByRole("listbox", { name: "Address suggestions" });
  const queries = () =>
    shell.app!.evaluate(
      () =>
        (globalThis as unknown as { suggestionQueries: string[] })
          .suggestionQueries,
    );
  const release = () =>
    shell.app!.evaluate(() =>
      (
        globalThis as unknown as { releaseSuggestion?: () => void }
      ).releaseSuggestion?.(),
    );
  await address.focus();
  await shell.page.waitForTimeout(160);
  expect(await queries()).toEqual([]);
  await address.fill("delayed");
  await expect.poll(() => queries()).toEqual(["delayed"]);
  await address.press("Escape");
  await release();
  await shell.page.waitForTimeout(120);
  await expect(results).toBeHidden();
  await address.fill("delayed");
  await expect.poll(() => queries()).toEqual(["delayed", "delayed"]);
  await address.fill("no-matching-fixture");
  await expect.poll(() => queries()).toContain("no-matching-fixture");
  await release();
  await shell.page.waitForTimeout(120);
  await expect(results).toBeHidden();
  const before = (await queries()).length;
  await address.dispatchEvent("compositionstart");
  await address.fill("delayed-alternative");
  await shell.page.waitForTimeout(160);
  expect((await queries()).length).toBe(before);
  await expect(results).toBeHidden();
  await address.dispatchEvent("compositionend");
  await expect(results.getByRole("option")).toContainText(
    "delayed-alternative",
  );
  await shell
    .pane(current.paneId)
    .getByRole("button", { name: "Reload", exact: true })
    .focus();
  await expect(results).toBeHidden();
  await address.focus();
  await shell.page.waitForTimeout(120);
  await expect(results).toBeHidden();
});
