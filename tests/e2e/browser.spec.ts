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
    const route = new URL(request.url!, "http://fixture").pathname;
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
      `<!doctype html><title>Fixture ${route}</title><h1>Invented browser page ${route}</h1><input aria-label="Page input"><button onclick="window.open('/popup')">Popup</button><a href="/download">Download</a><form method="post" action="/upload" enctype="multipart/form-data"><input name="file" type="file"><button>Upload</button></form><script>window.identity=crypto.randomUUID();window.onmessage=e=>window.popupResult=e.data;</script>`,
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

test("Browser AC1 UI and CLI navigation, history and address keyboard use real workspace views", async () => {
  const workspace = await shell.create("Browser navigation");
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  await shell.page
    .getByRole("button", { name: "New browser", exact: true })
    .click();
  const dialog = shell.page.getByRole("dialog", {
    name: "New browser",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "URL", exact: true })
    .fill(origin + "/one");
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  await expect(dialog).toBeHidden();
  const record = (
    await shell.cli<{ browsers: BrowserRecord[] }>("state")
  ).browsers.find((row) => row.workspaceId === workspace)!;
  expect(record).toBeDefined();
  const address = shell
    .pane(record.paneId)
    .getByRole("textbox", { name: "Address", exact: true });
  await expect(address).toHaveValue(origin + "/one");
  expect(await remote("/one", "document.title")).toBe("Fixture /one");
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
        "file:///etc/passwd",
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
  await pageKey("/one", "E", [
    process.platform === "darwin" ? "meta" : "control",
    "shift",
  ]);
  await expect(shell.row("Browser layout")).toBeFocused();
  await shell.command("New workspace");
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
  await expect(shell.pane(record.paneId)).toContainText(
    path.join(downloads, "fixture.txt"),
  );
  await remote("/one", `void window.open('/popup')`);
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
  const permission = await remote(
    "/one",
    `new Promise(resolve=>navigator.geolocation.getCurrentPosition(()=>resolve('granted'),error=>resolve(error.code),{timeout:3000}))`,
  );
  expect(permission).toBe(1);
  await expect(shell.pane(record.paneId)).toContainText(
    /permission.*(denied|disabled|unavailable)|camera.*microphone/i,
  );
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
