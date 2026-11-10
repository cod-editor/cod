import {
  test,
  expect,
  _electron,
  type ElectronApplication,
} from "@playwright/test";
import { createServer, type Server } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
let application: ElectronApplication,
  server: Server,
  origin: string,
  temporary: string,
  downloads: string,
  uploaded = "",
  loads = 0;
const bytes = "Invented download bytes: seedling.\n";
async function start() {
  application = await _electron.launch({
    args: [
      process.env.COD_BROWSER_TEST_ENTRY!,
      `--user-data-dir=${path.join(temporary, "profile")}`,
    ],
    env: { ...process.env, COD_BROWSER_DOWNLOADS: downloads },
    chromiumSandbox: true,
  });
  await expect
    .poll(() =>
      application.evaluate(() => Boolean((globalThis as any).browserFixture)),
    )
    .toBe(true);
}
async function call(method: string, ...args: unknown[]) {
  return application.evaluate(
    async (_electron, { method, args }) => {
      const { service } = (globalThis as any).browserFixture;
      return await service[method](...args);
    },
    { method, args },
  );
}
async function js(id: string, source: string) {
  return application.evaluate(
    async (_electron, { id, source }) =>
      (globalThis as any).browserFixture.service
        .getWebContents(id)
        .executeJavaScript(source),
    { id, source },
  );
}
async function open(id: string, route = "/one", workspaceId = id) {
  return call("open", { id, workspaceId, url: origin + route });
}
async function url(id: string, ending: string) {
  await expect
    .poll(async () => (await call("snapshot", id)).url)
    .toBe(origin + ending);
}
async function denies(method: string, ...args: unknown[]) {
  let denied = false;
  try {
    await call(method, ...args);
  } catch {
    denied = true;
  }
  expect(denied, `${method} should reject`).toBe(true);
}
test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "cod-browser-"));
  downloads = path.join(temporary, "downloads");
  await mkdir(downloads);
  uploaded = "";
  loads = 0;
  server = createServer((request, response) => {
    const route = new URL(request.url!, "http://fixture").pathname;
    if (route === "/download") {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="../fixture.txt"',
      });
      response.end(bytes);
      return;
    }
    if (route === "/upload") {
      request.setEncoding("utf8");
      request.on("data", (chunk) => (uploaded += chunk));
      request.on("end", () => {
        response.end("Uploaded invented file");
      });
      return;
    }
    response.setHeader("Content-Type", "text/html");
    if (route === "/popup") {
      response.end(
        `<!doctype html><title>Popup fixture</title><script>opener.postMessage('invented-popup-ready','*');onmessage=e=>document.title=e.data;</script><button onclick="window.open('/popup-child')">Nested popup</button>`,
      );
      return;
    }
    response.end(
      `<!doctype html><title>${route}</title><h1>${route}</h1><span id="load">${++loads}</span><a href="/two">Next</a><button onclick="window.open('/popup')">Popup</button><form action="/upload" method="post" enctype="multipart/form-data"><input type="file" name="file"><button>Upload</button></form><a href="/download">Download</a><script>window.pageIdentity=crypto.randomUUID();onmessage=e=>{window.popupMessage=e.data;e.source.postMessage('invented-opener-ack','*')};</script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  await start();
});
test.afterEach(async () => {
  await application?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await rm(temporary, { recursive: true, force: true });
});

test("B1 AC1 real navigation, history and reload preserve independent views and reject bad IDs", async () => {
  const first = await open("one");
  expect(first).toMatchObject({
    id: "one",
    workspaceId: "one",
    url: origin + "/one",
    title: "/one",
    loading: false,
  });
  await open("two", "/other");
  await call("navigate", "one", origin + "/two");
  await url("one", "/two");
  expect((await call("snapshot", "one")).canGoBack).toBe(true);
  await call("back", "one");
  await url("one", "/one");
  expect((await call("snapshot", "one")).canGoForward).toBe(true);
  await call("forward", "one");
  await url("one", "/two");
  const identity = await js("one", "window.pageIdentity");
  await call("reload", "one");
  await expect.poll(() => js("one", "window.pageIdentity")).not.toBe(identity);
  expect((await call("snapshot", "two")).url).toBe(origin + "/other");
  await denies("open", {
    id: "one",
    workspaceId: "duplicate",
    url: origin + "/two",
  });
  await denies("navigate", "missing", origin + "/one");
  await denies("snapshot", "missing");
  expect(await call("list")).toHaveLength(2);
  const events = await application.evaluate(
    () => (globalThis as any).browserFixture.events,
  );
  expect(
    events.some(
      (event: any) =>
        event.type === "changed" &&
        event.id === "one" &&
        event.snapshot?.url === origin + "/two",
    ),
  ).toBe(true);
  expect(() => JSON.stringify(events)).not.toThrow();
});

test("B1 AC2 persistent shared-session cookies survive actual Electron restart", async () => {
  await open("one");
  await js(
    "one",
    `document.cookie='invented_cookie=shared_value; Max-Age=3600; Path=/'`,
  );
  await open("two", "/other");
  expect(await js("two", "document.cookie")).toContain(
    "invented_cookie=shared_value",
  );
  await call("navigate", "one", origin + "/two");
  expect((await call("snapshot", "two")).url).toBe(origin + "/other");
  await application.evaluate(async () => {
    await (globalThis as any).browserFixture.service
      .getWebContents("one")
      .session.cookies.flushStore();
  });
  await application.close();
  await start();
  await open("restored");
  expect(await js("restored", "document.cookie")).toContain(
    "invented_cookie=shared_value",
  );
});

test("B1 AC3 sandboxed views and recursive popups reject unsafe navigation and preserve opener messaging", async () => {
  await open("one");
  const preferences = await application.evaluate(() => {
    const wc = (globalThis as any).browserFixture.service.getWebContents("one");
    const p = wc.getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      preload: p.preload ?? "",
    };
  });
  expect(preferences).toEqual({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    preload: "",
  });
  expect(
    await js("one", `({node:typeof require,bridge:typeof window.cod})`),
  ).toEqual({ node: "undefined", bridge: "undefined" });
  for (const unsafe of [
    "file:///etc/passwd",
    'javascript:document.title="unsafe"',
    "cod://private",
    "chrome://settings",
  ])
    await denies("navigate", "one", unsafe);
  await js("one", `window.location.href='file:///etc/passwd'`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await url("one", "/one");
  await js("one", `void window.open('/popup')`);
  await expect
    .poll(() => js("one", "window.popupMessage"))
    .toBe("invented-popup-ready");
  await expect
    .poll(() =>
      application.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter((w) =>
            w.webContents.getURL().includes("/popup"),
          ).length,
      ),
    )
    .toBe(1);
  const popup = await application.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes("/popup"),
    )!;
    const p = (
      w.webContents as unknown as {
        getLastWebPreferences(): {
          sandbox?: boolean;
          contextIsolation?: boolean;
          nodeIntegration?: boolean;
          preload?: string;
        };
      }
    ).getLastWebPreferences();
    return {
      id: w.id,
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      preload: p.preload ?? "",
    };
  });
  expect(popup).toMatchObject({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    preload: "",
  });
  await expect
    .poll(() =>
      application.evaluate(
        ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.getTitle(),
        popup.id,
      ),
    )
    .toBe("invented-opener-ack");
  expect(
    await application.evaluate(
      async ({ BrowserWindow }, id) =>
        BrowserWindow.fromId(id)!.webContents.executeJavaScript(
          `({node:typeof require,bridge:typeof window.cod})`,
        ),
      popup.id,
    ),
  ).toEqual({ node: "undefined", bridge: "undefined" });
  await application.evaluate(async ({ BrowserWindow }, id) => {
    await BrowserWindow.fromId(id)!.webContents.executeJavaScript(
      `window.open('/popup-child');void window.open('file:///etc/passwd')`,
    );
  }, popup.id);
  await expect
    .poll(() =>
      application.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter((w) =>
            w.webContents.getURL().includes("/popup"),
          ).length,
      ),
    )
    .toBe(2);
  await call("close", "one");
  await expect
    .poll(() =>
      application.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    )
    .toBe(1);
});

test("B1 AC4 Chromium file upload and safe collision-preserving download transfer exact invented bytes", async () => {
  await open("one");
  const upload = path.join(temporary, "invented.txt");
  await writeFile(upload, "INVENTED_UPLOAD_MARKER");
  await application.evaluate(
    async (_electron, { id, file }) => {
      const wc = (globalThis as any).browserFixture.service.getWebContents(id);
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
    { id: "one", file: upload },
  );
  await js("one", `document.querySelector('form').requestSubmit()`);
  await expect.poll(() => uploaded).toContain("INVENTED_UPLOAD_MARKER");
  await call("navigate", "one", origin + "/one");
  await writeFile(path.join(downloads, "fixture.txt"), "PREEXISTING_KEEP");
  await js("one", `document.querySelector('a[href="/download"]').click()`);
  await expect
    .poll(async () => {
      const files = await readdir(downloads);
      return files.length;
    })
    .toBe(2);
  await expect
    .poll(() =>
      application.evaluate(() =>
        (globalThis as any).browserFixture.events.find(
          (event: any) =>
            event.type === "download" && event.status === "completed",
        ),
      ),
    )
    .toBeTruthy();
  const completed = await application.evaluate(() =>
    (globalThis as any).browserFixture.events.find(
      (event: any) => event.type === "download" && event.status === "completed",
    ),
  );
  expect(completed.id).toBe("one");
  expect(path.basename(completed.basename)).toBe(completed.basename);
  expect(path.dirname(completed.path)).toBe(downloads);
  expect(await readFile(completed.path, "utf8")).toBe(bytes);
  expect(await readFile(path.join(downloads, "fixture.txt"), "utf8")).toBe(
    "PREEXISTING_KEEP",
  );
  expect((await readdir(temporary)).sort()).toEqual([
    "downloads",
    "invented.txt",
    "profile",
  ]);
  const unrelated = await application.evaluate(
    async (_electron, { url, destination }) => {
      const fixture = (globalThis as any).browserFixture;
      const browserSession = fixture.service.getWebContents("one").session;
      const before = fixture.events.filter(
        (event: any) => event.type === "download",
      ).length;
      const result = await new Promise<{ status: string; nullOrigin: boolean }>(
        (resolve, reject) => {
          browserSession.once(
            "will-download",
            (_event: unknown, item: any, contents: any) => {
              item.setSavePath(destination);
              item.once("done", (_event: unknown, status: string) =>
                resolve({ status, nullOrigin: contents === null }),
              );
            },
          );
          browserSession.downloadURL(url);
          setTimeout(
            () => reject(new Error("Unrelated session download timed out")),
            5000,
          ).unref();
        },
      );
      return {
        ...result,
        eventsAdded:
          fixture.events.filter((event: any) => event.type === "download")
            .length - before,
      };
    },
    {
      url: origin + "/download",
      destination: path.join(temporary, "unrelated-download.txt"),
    },
  );
  expect(unrelated).toEqual({
    status: "completed",
    nullOrigin: true,
    eventsAdded: 0,
  });
  expect(
    await readFile(path.join(temporary, "unrelated-download.txt"), "utf8"),
  ).toBe(bytes);
});

test("B1 AC5 visibility retains page identity, bounds validate and disposal preserves unrelated resources", async () => {
  await open("one");
  await call("setBounds", "one", { x: 10, y: 20, width: 400, height: 300 });
  await call("setVisible", "one", true);
  await call("focus", "one");
  const identity = await js("one", "window.pageIdentity");
  await call("setVisible", "one", false);
  expect((await call("snapshot", "one")).visible).toBe(false);
  expect(await js("one", "window.pageIdentity")).toBe(identity);
  await call("setVisible", "one", true);
  await call("focus", "one");
  expect(await js("one", "window.pageIdentity")).toBe(identity);
  for (const bounds of [
    { x: -1, y: 0, width: 20, height: 20 },
    { x: 0, y: 0, width: 0, height: 20 },
    { x: 0, y: 0, width: 20.5, height: 20 },
    { x: Infinity, y: 0, width: 20, height: 20 },
  ])
    await denies("setBounds", "one", bounds);
  const unrelated = await application.evaluate(
    async ({ BrowserWindow, session }) => {
      const w = new BrowserWindow({
        show: false,
        webPreferences: {
          session: session.fromPartition("persist:invented-unrelated"),
          sandbox: true,
        },
      });
      await w.loadURL("about:blank");
      return w.id;
    },
  );
  const nativeId = await application.evaluate(
    () => (globalThis as any).browserFixture.service.getWebContents("one").id,
  );
  await call("close", "one");
  await call("close", "one");
  expect(
    await application.evaluate(
      ({ webContents }, id) => Boolean(webContents.fromId(id)),
      nativeId,
    ),
  ).toBe(false);
  await open("two");
  await call("dispose");
  await call("dispose");
  expect(await call("list")).toEqual([]);
  expect(
    await application.evaluate(
      ({ BrowserWindow }, id) => Boolean(BrowserWindow.fromId(id)),
      unrelated,
    ),
  ).toBe(true);
  expect(
    await application.evaluate(
      () =>
        (globalThis as any).browserFixture.window.contentView.children.length,
    ),
  ).toBe(0);
});
