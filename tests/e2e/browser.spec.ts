import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  openWorkspaceState,
  readWorkspaceState,
  writeWorkspaceState,
} from "../support/workspace-state";
import { pathToFileURL } from "node:url";
import { test, expect, type Locator } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { WorkspaceApp, modifier } from "./helpers/workspace-app";
import type { BrowserDownload } from "../../src/browser/download-types";
import type { BrowserLayout } from "../../src/types";
interface BrowserRecord {
  id: string;
  paneId: string;
  workspaceId: string;
  url: string;
  title: string;
  visible: boolean;
  loading: boolean;
  error?: string;
  httpFallback?: { id: string; url: string };
}
let brokenPage = true;
let requests: string[] = [];
let slowResponse: import("node:http").ServerResponse | undefined;
let delayedIcons: import("node:http").ServerResponse[] = [];
let fixtureJpeg: Buffer | undefined;
const fixtureIcon = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGN4O0+TJMQwqmFUw/DVAACONLQQCHI4yQAAAABJRU5ErkJggg==",
  "base64",
);
const delayedIcon = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOQrjlFEmIY1TCqYfhqAAD7pWEQU6IliAAAAABJRU5ErkJggg==",
  "base64",
);
const iconHeader = Buffer.from([
  0,
  0,
  1,
  0,
  1,
  0,
  16,
  16,
  0,
  0,
  1,
  0,
  32,
  0,
  fixtureIcon.length,
  0,
  0,
  0,
  22,
  0,
  0,
  0,
]);
const fixtureIco = Buffer.concat([iconHeader, fixtureIcon]);
const bitmapSize = 16;
const bitmap = Buffer.alloc(40 + bitmapSize * bitmapSize * 4 + 4 * bitmapSize);
bitmap.writeUInt32LE(40, 0);
bitmap.writeInt32LE(bitmapSize, 4);
bitmap.writeInt32LE(bitmapSize * 2, 8);
bitmap.writeUInt16LE(1, 12);
bitmap.writeUInt16LE(32, 14);
for (let row = 0; row < bitmapSize; row++)
  for (let column = 0; column < bitmapSize; column++) {
    const offset = 40 + (row * bitmapSize + column) * 4;
    bitmap[offset] = row < 8 ? 232 : 96;
    bitmap[offset + 1] = 181;
    bitmap[offset + 2] = column < 8 ? 65 : 241;
    bitmap[offset + 3] = column === 0 ? 0 : column === 1 ? 128 : 255;
  }
const bitmapIconHeader = Buffer.from(iconHeader);
bitmapIconHeader.writeUInt32LE(bitmap.length, 14);
const fixtureBitmapIco = Buffer.concat([bitmapIconHeader, bitmap]);
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
async function remote(route: string, source: string, pageOrigin = origin) {
  await expect
    .poll(() =>
      shell.app!.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .some((w) => w.getURL() === url && !w.isLoadingMainFrame()),
        pageOrigin + route,
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
    { url: pageOrigin + route, source },
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
const execute = promisify(execFile);
async function nativeBrowserFrame(points: { x: number; y: number }[]) {
  return shell.app!.evaluate(
    async ({ BrowserWindow, desktopCapturer, screen }, points) => {
      const bounds = BrowserWindow.getAllWindows()[0].getContentBounds();
      const [display] = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: screen.getPrimaryDisplay().size,
      });
      const png = display.thumbnail.crop(bounds);
      return {
        colors: points.map(({ x, y }) => {
          const pixel = png.crop({ x, y, width: 1, height: 1 }).toBitmap();
          return [pixel[2], pixel[1], pixel[0]];
        }),
        image: png.toPNG().toString("base64"),
      };
    },
    points,
  );
}
async function clickNativeBrowser(x: number, y: number, button = 1) {
  const bounds = await shell.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentBounds(),
  );
  await execute("xdotool", [
    "mousemove",
    "--sync",
    String(Math.round(x + bounds.x)),
    String(Math.round(y + bounds.y)),
    "click",
    String(button),
  ]);
}
async function scrollManager(dialog: Locator, last: Locator) {
  const heading = dialog.getByRole("heading", { level: 2 });
  const done = dialog.getByRole("button", { name: "Done", exact: true });
  const headingBounds = await heading.boundingBox();
  const doneBounds = await done.boundingBox();
  await expect(last).not.toBeInViewport();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(heading).toBeInViewport({ ratio: 1 });
  await expect(done).toBeInViewport({ ratio: 1 });
  expect(await heading.boundingBox()).toEqual(headingBounds);
  expect(await done.boundingBox()).toEqual(doneBounds);
  for (const surface of [dialog, dialog.locator(".ui-dialog-body")]) {
    expect(await surface.evaluate((node) => node.scrollWidth)).toBe(
      await surface.evaluate((node) => node.clientWidth),
    );
  }
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
  delayedIcons = [];
  fixtureJpeg = undefined;
  server = createServer((request, response) => {
    requests.push(request.url!);
    // Network-count assertions must observe loads rather than HTTP cache hits.
    response.setHeader("Cache-Control", "no-store");
    const route = new URL(request.url!, "http://fixture").pathname;
    if (route === "/fixture-icon.png") {
      response.setHeader("Content-Type", "image/png");
      response.end(fixtureIcon);
      return;
    }
    if (route === "/fixture-icon.ico") {
      response.setHeader("Content-Type", "image/x-icon");
      response.end(fixtureIco);
      return;
    }
    if (route === "/fixture-bitmap.ico") {
      response.setHeader("Content-Type", "image/x-icon");
      response.end(fixtureBitmapIco);
      return;
    }
    if (route === "/site-with-bitmap-icon") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><title>Bitmap icon fixture</title><link rel="shortcut icon" href="/fixture-bitmap.ico"><h1>Bitmap icon fixture</h1>',
      );
      return;
    }
    if (route === "/fixture-icon.jpg") {
      response.setHeader("Content-Type", "image/jpeg");
      response.end(fixtureJpeg);
      return;
    }
    if (route === "/delayed-icon.png") {
      delayedIcons.push(response);
      return;
    }
    if (route === "/fixture-icon.svg") {
      response.setHeader("Content-Type", "image/svg+xml");
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>',
      );
      return;
    }
    const siteIcon = new Map([
      ["/site-with-icon", "/fixture-icon.png"],
      ["/site-with-ico", "/fixture-icon.ico"],
      ["/site-with-jpeg", "/fixture-icon.jpg"],
      ["/site-with-delayed-icon", "/delayed-icon.png"],
      [
        "/site-with-cross-origin-icon",
        `${origin.replace("127.0.0.1", "localhost")}/fixture-icon.png`,
      ],
      ["/site-with-svg-icon", "/fixture-icon.svg"],
    ]);
    const href = siteIcon.get(route);
    if (href) {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<!doctype html><title>Invented site</title><link rel="icon" href="${href}"><h1>Invented site</h1>`,
      );
      return;
    }
    if (route === "/overlay-fixture") {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>Overlay fixture</title>
        <style>
          body { background: rgb(14, 122, 86); color: white; font: 20px sans-serif; min-height: 1600px }
          header { position: sticky; top: 0; background: rgb(14, 122, 86) }
          main { padding: 320px 12px 50px; line-height: 2 }
        </style>
        <header>Invented browser page</header>
        <main>Browser controls should leave this page in place.</main>
        <script>window.pageClicks=0; document.addEventListener("click", () => pageClicks++);</script>`);
      return;
    }
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
    if (route === "/clipboard-fixture") {
      response.setHeader("Content-Type", "text/html");
      response.end(`<!doctype html><title>Clipboard fixture</title>
        <button id="copy">Copy</button><button id="read">Read</button><output></output>
        <script>
          const status = document.querySelector("output");
          document.querySelector("#copy").onclick = () => {
            status.value = "pending";
            const value = new URLSearchParams(location.search).get("value");
            navigator.clipboard.writeText(value).then(
              () => status.value = "copied",
              error => status.value = error.name,
            );
          };
          document.querySelector("#read").onclick = () => {
            status.value = "pending";
            navigator.clipboard.readText().then(
              () => status.value = "read",
              error => status.value = error.name,
            );
          };
        </script>`);
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
  shell.launchArguments.push(
    "--host-resolver-rules=MAP cleartext.example.test 127.0.0.1",
  );
  await shell.start();
});
test.afterEach(async () => {
  await shell?.cleanup();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

test("Address bar searches text and opens bare addresses without sending addresses to search", async ({}, info) => {
  const workspace = await shell.create("Address input");
  await shell.page.keyboard.press(`${modifier}+Shift+P`);
  await shell.page
    .getByRole("button", { name: "New browser tab", exact: true })
    .click();
  const address = shell.page.getByRole("combobox", {
    name: "Address",
    exact: true,
  });
  await expect(address).toBeFocused();
  await expect(address).toHaveValue("");
  await shell.page.screenshot({ path: info.outputPath("browser-home.png") });
  await expect
    .soft(shell.page.getByRole("tab", { name: "Home", exact: true }))
    .toBeVisible();
  await address.press(`${modifier}+Shift+o`);
  const overview = shell.page.getByRole("dialog", {
    name: "Overview",
    exact: true,
  });
  await expect(overview).toBeVisible();
  await shell.page.screenshot({
    path: info.outputPath("browser-home-overview.png"),
  });
  await expect.soft(overview.getByText("Home", { exact: true })).toBeVisible();
  await overview
    .getByRole("combobox", { name: "Search Overview" })
    .press("Escape");
  await expect(address).toBeFocused();
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

test("Site favicons follow the loaded tab and survive in Home pins without a fetch", async ({}, info) => {
  const workspace = await shell.create("Site icon fixture");
  const record = await open(workspace, "/site-with-icon");
  const tab = shell.page.getByRole("tab", {
    name: "Invented site",
    exact: true,
  });
  await expect(tab).toBeVisible();
  const tabIcon = tab.locator("img.site-favicon");
  await expect.soft(tabIcon).toHaveJSProperty("naturalWidth", 16);
  await shell.page.screenshot({
    path: info.outputPath("browser-favicon-tab.png"),
  });

  await shell.cli(
    "browser",
    "pin",
    "--url",
    record.url,
    "--title",
    "Invented docs",
  );
  const otherOrigin = origin.replace("127.0.0.1", "localhost");
  await shell.cli(
    "browser",
    "pin",
    "--url",
    otherOrigin + "/one",
    "--title",
    "Other site",
  );
  requests = [];
  await shell.page.keyboard.press(`${modifier}+t`);
  const home = shell.page.getByRole("region", { name: "Browser home" });
  await expect(home).toBeVisible();
  const pin = home.getByRole("button", { name: "Invented docs" });
  const pinIcon = pin.locator("img.site-favicon");
  await expect.soft(pinIcon).toHaveJSProperty("naturalWidth", 16);
  await expect(
    home.getByRole("button", { name: "Other site" }).locator("img"),
  ).toHaveCount(0);
  expect(requests).toEqual([]);
  await shell.page.screenshot({
    path: info.outputPath("browser-favicon-home.png"),
  });

  await shell.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    record.paneId,
  );
  await shell.stop();
  requests = [];
  await shell.start();
  const restoredHome = shell.page.getByRole("region", { name: "Browser home" });
  await expect(restoredHome).toBeVisible();
  await expect(
    restoredHome
      .getByRole("button", { name: "Invented docs" })
      .locator("img.site-favicon"),
  ).toHaveJSProperty("naturalWidth", 16);
  expect(requests).toEqual([]);
});

test("Home uses sharp site art while tabs keep small favicons", async ({}, info) => {
  const pngs = await shell.app!.evaluate(({ nativeImage }) => {
    const width = 160;
    const pixels = Buffer.alloc(width * width * 4);
    const png = () =>
      nativeImage
        .createFromBitmap(pixels, { width, height: width })
        .toPNG()
        .toString("base64");
    for (let y = 0; y < width; y++)
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const star = Math.abs(x - 80) / 46 + Math.abs(y - 80) / 49 < 1;
        pixels.set(star ? [255, 243, 220, 255] : [225, 102, 43, 255], offset);
      }
    const cover = png();
    pixels.fill(0);
    for (let y = 20; y < 140; y++)
      for (let x = 20; x < 140; x++) {
        const diamond = Math.abs(x - 80) + Math.abs(y - 80);
        if (diamond > 60) continue;
        const color = diamond > 30 ? [154, 190, 252, 255] : [89, 136, 250, 255];
        pixels.set(color, (y * width + x) * 4);
      }
    return { cover, mark: png() };
  });
  const assets = {
    cover: Buffer.from(pngs.cover, "base64"),
    mark: Buffer.from(pngs.mark, "base64"),
  };
  const fixtures: Array<{
    server: Server;
    url: string;
    label: string;
    requests: string[];
  }> = [];
  const serve = async (label: string, links: string) => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      const target = request.url!;
      requests.push(target);
      response.setHeader("Cache-Control", "no-store");
      if (target === "/00-small.png" || target === "/10-art.png") {
        response.setHeader("Content-Type", "image/png");
        response.end(
          target === "/00-small.png"
            ? fixtureIcon
            : label === "Atlas"
              ? assets.cover
              : assets.mark,
        );
      } else if (target === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end(
          `<!doctype html><title>${label}</title><link rel="icon" href="/00-small.png">${links}`,
        );
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture server did not bind");
    const fixture = {
      server,
      url: `http://127.0.0.1:${address.port}/`,
      label,
      requests,
    };
    fixtures.push(fixture);
    return fixture;
  };
  try {
    const atlas = await serve(
      "Atlas",
      '<link rel="icon" sizes="160x160" href="/10-art.png">',
    );
    const relay = await serve(
      "Relay",
      '<link rel="apple-touch-icon" sizes="160x160" href="/10-art.png">',
    );
    await serve(
      "Forum",
      `<link rel="apple-touch-icon" href="${relay.url}not-same-origin.png">`,
    );
    const missing = atlas.url.replace("127.0.0.1", "localhost");
    const workspace = await shell.create("Favorite artwork fixture");
    for (const site of [...fixtures, { url: missing, label: "Notebook" }])
      await shell.cli(
        "browser",
        "pin",
        "--url",
        site.url,
        "--title",
        site.label,
      );
    expect(fixtures.every((site) => !site.requests.length)).toBe(true);
    const tabs: BrowserRecord[] = [];
    for (const site of fixtures) {
      tabs.push(
        await shell.cli<BrowserRecord>(
          "browser",
          "open",
          "--workspace",
          workspace,
          "--url",
          site.url,
        ),
      );
      await expect(
        shell.page
          .getByRole("tab", { name: site.label, exact: true })
          .locator("img.site-favicon"),
      ).toHaveJSProperty("naturalWidth", 16);
    }
    await shell.page.keyboard.press(`${modifier}+t`);
    const home = () => shell.page.getByRole("region", { name: "Browser home" });
    const art = (label: string) =>
      home()
        .getByRole("button", { name: label, exact: true })
        .locator(".browser-home-monogram");
    const image = (label: string) => art(label).locator("img.site-favicon");
    const verify = async () => {
      await expect(home()).toBeVisible();
      await expect(art("Atlas")).toHaveAttribute("data-art", "cover");
      await expect(image("Atlas")).toHaveJSProperty("naturalWidth", 128);
      await expect(image("Atlas")).toHaveCSS("width", "64px");
      await expect(art("Relay")).toHaveAttribute("data-art", "mark");
      await expect(image("Relay")).toHaveJSProperty("naturalWidth", 120);
      await expect(image("Relay")).toHaveCSS("width", "52px");
      await expect(art("Relay")).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await expect(image("Forum")).toHaveJSProperty("naturalWidth", 16);
      await expect(image("Forum")).toHaveCSS("width", "16px");
      await expect(art("Notebook")).toHaveText("N");
      await expect(image("Notebook")).toHaveCount(0);
      expect(relay.requests).not.toContain("/not-same-origin.png");
    };
    await verify();
    await shell.page.screenshot({
      path: info.outputPath("home-favorite-art.png"),
    });
    await shell.app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(760, 620),
    );
    await expect.poll(() => shell.page.evaluate(() => innerWidth)).toBe(760);
    await expect
      .poll(async () => (await home().boundingBox())?.width)
      .toBeLessThan(460);
    await verify();
    await shell.page.screenshot({
      path: info.outputPath("home-favorite-art-narrow.png"),
    });
    for (const tab of tabs)
      await shell.cli(
        "pane",
        "close",
        "--workspace",
        workspace,
        "--id",
        tab.paneId,
      );
    await shell.stop();
    for (const site of fixtures) site.requests.length = 0;
    await shell.start();
    await verify();
    expect(fixtures.every((site) => !site.requests.length)).toBe(true);
  } finally {
    for (const fixture of fixtures) {
      fixture.server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        fixture.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});

test("Site favicon accepts JPEG and a PNG embedded in an ICO", async () => {
  fixtureJpeg = Buffer.from(
    await shell.app!.evaluate(
      ({ nativeImage }, encoded) =>
        nativeImage
          .createFromBuffer(Buffer.from(encoded, "base64"))
          .resize({ width: 12 })
          .toJPEG(80)
          .toString("base64"),
      fixtureIcon.toString("base64"),
    ),
    "base64",
  );
  const workspace = await shell.create("Site icon formats");
  const record = await open(workspace, "/site-with-ico");
  const icon = shell.page
    .getByRole("tab", { name: "Invented site", exact: true })
    .locator("img.site-favicon");
  await expect(icon).toHaveJSProperty("naturalWidth", 16);
  await shell.cli(
    "browser",
    "navigate",
    "--id",
    record.id,
    "--url",
    origin + "/site-with-jpeg",
  );
  await expect(icon).toHaveJSProperty("naturalWidth", 12);
  await shell.cli("browser", "reload", "--id", record.id);
  await expect(icon).toHaveJSProperty("naturalWidth", 12);
});

test("A bitmap ICO appears on a visited tab and updates an existing Home pin", async ({}, info) => {
  const workspace = await shell.create("Bitmap site icon fixture");
  const route = "/site-with-bitmap-icon";
  const site = origin + route;
  await shell.cli("browser", "pin", "--url", site, "--title", "Bitmap docs");
  expect(requests).toEqual([]);
  const record = await open(workspace, route);
  await expect(
    shell.page.getByRole("tab", { name: "Bitmap icon fixture", exact: true }),
  ).toBeVisible();
  const icon = () =>
    shell.page
      .getByRole("tab", { name: "Bitmap icon fixture", exact: true })
      .locator("img.site-favicon");
  // Chromium itself decodes the ICO. Cod should learn that usable icon too.
  expect(
    await remote(
      route,
      `(async () => {
      const image = new Image();
      image.src = document.querySelector('link[rel="shortcut icon"]').href;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    })()`,
    ),
  ).toEqual([bitmapSize, bitmapSize]);
  await expect
    .soft(icon())
    .toHaveJSProperty("naturalWidth", bitmapSize, { timeout: 5_000 });
  await shell.page.screenshot({
    path: info.outputPath("browser-bitmap-tab.png"),
  });

  await shell.page.keyboard.press(`${modifier}+t`);
  const pinIcon = () =>
    shell.page
      .getByRole("region", { name: "Browser home" })
      .getByRole("button", { name: "Bitmap docs", exact: true })
      .locator("img.site-favicon");
  await expect
    .soft(pinIcon())
    .toHaveJSProperty("naturalWidth", bitmapSize, { timeout: 5_000 });
  await shell.page.screenshot({
    path: info.outputPath("browser-bitmap-home.png"),
  });
  await shell.stop();
  requests = [];
  await shell.start();
  await expect
    .soft(pinIcon())
    .toHaveJSProperty("naturalWidth", bitmapSize, { timeout: 5_000 });
  expect(requests).toEqual([]);
  await shell.page
    .getByRole("tab", { name: "Bitmap icon fixture", exact: true })
    .click();
  await expect(icon()).toHaveJSProperty("naturalWidth", bitmapSize, {
    timeout: 5_000,
  });
  requests = [];
  await shell.cli("browser", "reload", "--id", record.id);
  await expect.poll(() => requests.includes("/fixture-bitmap.ico")).toBe(true);
  await expect(icon()).toHaveJSProperty("naturalWidth", bitmapSize, {
    timeout: 5_000,
  });
  expect(
    await icon().evaluate((image: HTMLImageElement) => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return [
        Array.from(context.getImageData(0, 0, 1, 1).data),
        Array.from(context.getImageData(1, 0, 1, 1).data),
        Array.from(context.getImageData(9, 14, 1, 1).data),
      ];
    }),
  ).toEqual([
    [0, 0, 0, 0],
    [66, 181, 96, 128],
    [241, 181, 232, 255],
  ]);
});

test("Site favicon cannot follow a superseded navigation or come from a different origin or SVG", async () => {
  const workspace = await shell.create("Site icon navigation fixture");
  const record = await open(workspace, "/site-with-icon");
  const tab = shell.page.locator(
    `[role="tab"][data-tab-id="${record.paneId}"]`,
  );
  const favicon = tab.locator("img.site-favicon");
  await expect(favicon).toHaveJSProperty("naturalWidth", 16);
  const navigate = (url: string) =>
    shell.cli("browser", "navigate", "--id", record.id, "--url", url);
  try {
    await navigate(origin + "/site-with-delayed-icon");
    await expect.poll(() => delayedIcons.length).toBeGreaterThan(0);
    const next = origin.replace("127.0.0.1", "localhost") + "/two";
    await navigate(next);
    for (const response of delayedIcons)
      if (!response.destroyed) response.end(delayedIcon);
    await expect(favicon).toHaveCount(0);
    await expect(tab).toHaveAccessibleName("Fixture /two");
    expect((await inspect(record.id)).url).toBe(next);
  } finally {
    for (const response of delayedIcons)
      if (!response.destroyed && !response.writableEnded) response.end();
  }
  for (const route of ["/site-with-cross-origin-icon", "/site-with-svg-icon"]) {
    await navigate(origin + route);
    await expect(favicon).toHaveCount(0);
    await expect(tab).toHaveAccessibleName("Invented site");
  }
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
  const pin = home.getByRole("button", {
    name: "Example workspace",
    exact: true,
  });
  await expect(pin).toBeVisible();
  const pinBounds = (await pin.boundingBox())!;
  const menu = shell.page.getByRole("dialog", { name: "Actions" });
  await pin.click({ button: "right", position: { x: 50, y: 50 } });
  await expect(menu).toBeVisible();
  await expect(pin).toHaveAttribute("aria-expanded", "true");
  const pointerMenu = (await menu.boundingBox())!;
  expect(Math.abs(pointerMenu.x - pinBounds.x - 50)).toBeLessThanOrEqual(1);
  expect(Math.abs(pointerMenu.y - pinBounds.y - 50)).toBeLessThanOrEqual(1);
  await shell.page.screenshot({
    path: info.outputPath("home-pointer-menu.png"),
  });
  await shell.page.keyboard.press("Escape");
  await expect(pin).toBeFocused();
  await expect.poll(() => pin.getAttribute("aria-expanded")).toBeNull();
  await pin.press("Shift+F10");
  await expect(menu).toBeVisible();
  const keyboardMenu = (await menu.boundingBox())!;
  expect(keyboardMenu.x).toBeCloseTo(pinBounds.x, 0);
  expect(keyboardMenu.y).toBeCloseTo(pinBounds.y + pinBounds.height, 0);
  await shell.page.screenshot({
    path: info.outputPath("home-keyboard-menu.png"),
  });
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
  const newAddress = shell.page.getByRole("combobox", {
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
    .getByRole("combobox", { name: "Address", exact: true });
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

test("Browser reload shortcut targets the focused page or address and leaves other surfaces intact", async () => {
  const workspace = await shell.create("Reload shortcut fixture");
  await open(workspace, "/other-tab");
  const record = await open(workspace);
  const identity = () => remote("/one", "window.identity");
  const otherIdentity = await remote("/other-tab", "window.identity");
  const reloadCount = () => requests.filter((url) => url === "/one").length;
  const rendererIdentity = () =>
    shell.page.evaluate(() => document.body.dataset.reloadFixture);
  await shell.page.evaluate(() => {
    document.body.dataset.reloadFixture = "retain";
  });

  const initial = await identity();
  const initialRequests = reloadCount();
  await pageKey("/one", "R", [
    process.platform === "darwin" ? "meta" : "control",
  ]);
  await expect.poll(identity).not.toBe(initial);
  expect(reloadCount()).toBe(initialRequests + 1);
  await expect
    .poll(() =>
      shell.app!.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .some(
              (contents) => contents.getURL() === url && contents.isFocused(),
            ),
        origin + "/one",
      ),
    )
    .toBe(true);

  const address = shell
    .pane(record.paneId)
    .getByRole("combobox", { name: "Address", exact: true });
  const afterNative = await identity();
  await address.fill("Keep unsent address text");
  await address.press(`${modifier}+r`);
  await expect.poll(identity).not.toBe(afterNative);
  await expect(address).toBeFocused();
  await expect(address).toHaveValue("Keep unsent address text");
  expect(reloadCount()).toBe(initialRequests + 2);
  expect(await remote("/other-tab", "window.identity")).toBe(otherIdentity);
  expect(await rendererIdentity()).toBe("retain");

  const file = await shell.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    shell.file,
  );
  const editor = shell
    .pane(file.paneId)
    .getByRole("textbox", { name: "File contents" });
  await editor.fill("Keep editor draft");
  const afterAddress = await identity();
  await editor.press(`${modifier}+r`);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("Keep editor draft");
  expect(await identity()).toBe(afterAddress);
  expect(reloadCount()).toBe(initialRequests + 2);
  expect(await rendererIdentity()).toBe("retain");
});

test("Browser reload shortcut works from a newly selected tab header", async () => {
  const workspace = await shell.create("Reload from browser tab strip");
  const browser = await open(workspace);
  await remote("/one", "window.identity");
  await open(workspace, "/other-tab");
  await remote("/other-tab", "window.identity");
  const tab = shell.page.getByRole("tab", {
    name: "Fixture /one",
    exact: true,
  });
  const otherTab = shell.page.getByRole("tab", {
    name: "Fixture /other-tab",
    exact: true,
  });
  const reloadCount = () => requests.filter((url) => url === "/one").length;

  await otherTab.click();
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(tab).toBeFocused();
  const initial = reloadCount();
  await shell.page.keyboard.press(`${modifier}+r`);
  await expect.poll(reloadCount).toBe(initial + 1);
  await expect(tab).toBeFocused();
  await remote("/one", "window.identity");

  await otherTab.click();
  await otherTab.press("ArrowLeft");
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(tab).toBeFocused();
  await shell.page.keyboard.press(`${modifier}+r`);
  await expect.poll(reloadCount).toBe(initial + 2);
  await remote("/one", "window.identity");

  const overview = await shell.overview();
  const search = overview.getByRole("combobox");
  await search.press(`${modifier}+r`);
  await expect(overview).toBeVisible();
  await expect(search).toBeFocused();
  expect(reloadCount()).toBe(initial + 2);
  await search.fill("Fixture /other-tab");
  await expect(
    overview.getByRole("gridcell", { name: "Fixture /other-tab", exact: true }),
  ).toBeVisible();
  await search.press("Enter");
  await expect(overview).toBeHidden();
  await expect(otherTab).toHaveAttribute("aria-selected", "true");
  const otherCount = requests.filter((url) => url === "/other-tab").length;
  await shell.page.keyboard.press(`${modifier}+r`);
  await expect
    .poll(() => requests.filter((url) => url === "/other-tab").length)
    .toBe(otherCount + 1);
  expect(reloadCount()).toBe(initial + 2);

  await shell.command("Move tab to right pane");
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const file = await shell.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    shell.file,
  );
  await shell.page.locator(`[data-tab-id="${file.paneId}"]`).click();
  await expect(shell.pane(file.paneId)).toBeVisible();
  await expect
    .poll(async () => (await nativeView("/other-tab"))?.visible)
    .toBe(true);
  await shell.page.keyboard.press(`${modifier}+r`);
  expect(requests.filter((url) => url === "/other-tab").length).toBe(
    otherCount + 1,
  );
});

test("Browser AC2 native bounds stay inside split panes and overlays hide views without losing page state", async ({}, info) => {
  const workspace = await shell.create("Browser layout");
  const browser = await open(workspace);
  const identity = await remote("/one", "window.identity");
  await shell.command("Move tab to right pane");
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
  const split = shell.page.getByRole("button", {
    name: "Toggle split view",
    exact: true,
  });
  await expect(split).toHaveAttribute("aria-pressed", "true");
  await pageKey("/one", "Escape", ["shift"]);
  await expect(split).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await nativeView("/one"))?.visible).toBe(true);
  expect(await remote("/one", "window.identity")).toBe(identity);
  await pageKey("/one", "Escape", ["shift"]);
  await expect(split).toHaveAttribute("aria-pressed", "true");
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
      .getByRole("combobox", { name: "Address", exact: true }),
  ).toBeFocused();
  await pageKey("/one", "O", [
    process.platform === "darwin" ? "meta" : "control",
    "shift",
  ]);
  const overview = shell.page.getByRole("dialog", {
    name: "Overview",
    exact: true,
  });
  const browserRow = overview.locator(
    `.overview-item[data-navigation-key="browser:${browser.id}"]`,
  );
  await expect(overview.getByRole("combobox")).toBeFocused();
  await expect(browserRow).toHaveAttribute("aria-selected", "true");
  await shell.page.keyboard.press("Escape");
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

test("Closing the main window retains browser tabs and navigation for restart", async () => {
  const workspace = await shell.create("Window close recovery");
  const first = await open(workspace, "/one");
  const second = await open(workspace, "/two");
  await shell.cli(
    "browser",
    "navigate",
    "--id",
    second.id,
    "--url",
    origin + "/background",
  );
  const inactiveWorkspace = await shell.create("Inactive pinned recovery");
  const pinned = await open(inactiveWorkspace, "/inactive-pinned");
  await shell.cli(
    "pane",
    "pin",
    "--workspace",
    inactiveWorkspace,
    "--id",
    pinned.paneId,
    "--pinned",
    "true",
  );
  await shell.cli("workspace", "focus", "--id", workspace);
  const app = shell.app!;
  const closed = app.waitForEvent("close");
  await app.evaluate(({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().endsWith("/index.html"),
    );
    if (!host) throw new Error("Fixture main window missing");
    setTimeout(() => {
      host.close();
      if (!host.isDestroyed()) host.close();
    }, 0);
  });
  await closed;
  shell.app = undefined;
  const saved = readWorkspaceState(shell.data);
  expect(saved.browsers.map((item: BrowserRecord) => item.id)).toEqual([
    first.id,
    second.id,
    pinned.id,
  ]);
  expect(
    saved.workspaces
      .find((item) => item.id === inactiveWorkspace)
      ?.panes.find((item) => item.id === pinned.paneId)?.pinned,
  ).toBe(true);
  await shell.start();
  expect((await inspect(pinned.id)).url).toBe(origin + "/inactive-pinned");
  expect(await nativeView("/inactive-pinned")).toBeNull();
  expect((await inspect(first.id)).url).toBe(origin + "/one");
  expect((await inspect(second.id)).url).toBe(origin + "/background");
  await shell.cli("browser", "back", "--id", second.id);
  await expect
    .poll(async () => (await inspect(second.id)).url)
    .toBe(origin + "/two");
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

test("Inferred HTTPS failure offers one explicit HTTP visit for its own tab", async ({}, info) => {
  const workspace = await shell.create("Invented HTTP fallback");
  const tab = await open(workspace);
  const host = `cleartext.example.test:${new URL(origin).port}`;
  const fallbackPath = "/http-only?fixture=hidden";
  const destination = host + fallbackPath + "#selected";
  const pane = shell.pane(tab.paneId);
  const address = pane.getByRole("combobox", { name: "Address", exact: true });
  const proceed = pane.getByRole("button", { name: "Open over HTTP" });
  const submit = async (value: string) => {
    await address.fill(value);
    await address.press("Enter");
  };
  await submit("https://" + destination);
  await expect(
    pane.getByRole("heading", { name: "Page could not load" }),
  ).toBeVisible();
  await expect(proceed).toBeHidden();
  expect(requests).not.toContain(fallbackPath);
  await shell.page.screenshot({
    path: info.outputPath("explicit-https-failure.png"),
  });
  await submit(destination);
  await expect(
    pane.getByRole("heading", { name: "Secure connection unavailable" }),
  ).toBeVisible();
  await expect(pane.locator(".browser-failure code")).toHaveText(
    "http://" + host,
  );
  await expect(pane.locator(".browser-failure")).not.toContainText(
    "fixture=hidden",
  );
  await expect(proceed).toBeVisible();
  expect(requests).not.toContain(fallbackPath);
  const firstOffer = (await inspect(tab.id)).httpFallback!.id;

  const other = await open(workspace, "/other");
  await expect(
    shell.pane(other.paneId).locator(".browser-failure"),
  ).toBeHidden();
  await expect(
    shell.pane(other.paneId).getByRole("button", { name: "Open over HTTP" }),
  ).toBeHidden();
  await shell.cli(
    "pane",
    "focus",
    "--workspace",
    workspace,
    "--id",
    tab.paneId,
  );
  const cancel = pane.getByRole("button", { name: "Return to previous page" });
  await expect(cancel).toBeVisible();
  await cancel.focus();
  await expect(cancel).toBeFocused();
  await shell.page.screenshot({
    path: info.outputPath("http-fallback-warning.png"),
  });
  await cancel.press("Enter");
  await expect
    .poll(async () => (await inspect(tab.id)).url)
    .toBe(origin + "/one");
  await expect(proceed).toBeHidden();
  expect(requests).not.toContain(fallbackPath);
  await submit(destination);
  await expect(proceed).toBeVisible();
  await expect(
    shell.cli(
      "browser",
      "http-fallback",
      "--id",
      tab.id,
      "--offer",
      firstOffer,
    ),
  ).rejects.toThrow("This HTTP option is no longer available");
  expect(requests).not.toContain(fallbackPath);
  await proceed.click();
  const http = "http://" + destination;
  await expect.poll(async () => (await inspect(tab.id)).url).toBe(http);
  await expect(pane.locator(".browser-failure")).toBeHidden();
  await expect(address).toHaveAccessibleDescription("Not secure");
  await shell.page.screenshot({
    path: info.outputPath("http-page-not-secure.png"),
  });
  await expect
    .poll(() => requests.filter((route) => route === fallbackPath))
    .toHaveLength(1);
  expect((await inspect(tab.id)).httpFallback).toBeUndefined();

  await pane.getByRole("button", { name: "Back", exact: true }).click();
  await expect
    .poll(async () => (await inspect(tab.id)).url)
    .toBe(origin + "/one");
  await expect(proceed).toBeHidden();
  await expect(address).not.toHaveAccessibleDescription("Not secure");
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
    BrowserWindow.getAllWindows()[0].setContentSize(1060, 800),
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
    .locator("#project-panel")
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

test("Browser tab actions keep the native page painted and preserve keyboard access", async ({}, info) => {
  test.skip(process.platform !== "linux", "Requires the isolated X11 desktop");
  const workspace = await shell.create("Browser tab actions");
  const route = "/overlay-fixture";
  const record = await open(workspace, route);
  await expect.poll(async () => (await inspect(record.id)).visible).toBe(true);
  const tab = shell.page.getByRole("tab", {
    name: "Overlay fixture",
    exact: true,
  });
  const tabBox = (await tab.boundingBox())!;
  const area = (await shell
    .pane(record.paneId)
    .getByRole("region", { name: "Browser content" })
    .boundingBox())!;
  const pagePoint = {
    x: Math.floor(area.x + area.width / 2),
    y: Math.ceil(area.y + area.height / 2),
  };
  const anchor = {
    x: Math.ceil(tabBox.x + 44),
    y: Math.ceil(tabBox.y + tabBox.height / 2),
  };
  const menuPoint = { x: anchor.x + 12, y: anchor.y + 100 };
  const frame = () => nativeBrowserFrame([menuPoint, pagePoint]);
  const pageColor = [14, 122, 86];
  await expect
    .poll(async () => (await frame()).colors)
    .toEqual([pageColor, pageColor]);
  await clickNativeBrowser(anchor.x, anchor.y, 3);
  await expect
    .poll(async () => (await frame()).colors[0])
    .not.toEqual(pageColor);
  const opened = await frame();
  expect(opened.colors[1]).toEqual(pageColor);
  await expect(shell.page.locator("dialog[open]")).toHaveCount(0);
  await writeFile(
    info.outputPath("live-browser-tab-menu.png"),
    Buffer.from(opened.image, "base64"),
  );
  await execute("xdotool", ["key", "Escape"]);
  await expect
    .poll(async () => (await frame()).colors)
    .toEqual([pageColor, pageColor]);

  await tab.focus();
  await tab.press("Shift+F10");
  await expect
    .poll(async () => (await frame()).colors[0])
    .not.toEqual(pageColor);
  await execute("xdotool", ["key", "Escape"]);
  await expect(tab).toBeFocused();
  await tab.press("Shift+F10");
  await expect
    .poll(async () => (await frame()).colors[0])
    .not.toEqual(pageColor);
  await execute("xdotool", ["key", "Down"]);
  await writeFile(
    info.outputPath("live-browser-tab-menu-keyboard.png"),
    Buffer.from((await frame()).image, "base64"),
  );
  await execute("xdotool", ["key", "Return"]);
  await expect(tab).toHaveAttribute("data-pinned", "true");
  const restored = await frame();
  expect(restored.colors).toEqual([pageColor, pageColor]);
});

test("Shell menus and dialogs preserve the view of native background pages", async ({}, info) => {
  test.skip(process.platform !== "linux", "Requires the isolated X11 desktop");
  const workspace = await shell.create("Browser overlay coverage");
  const route = "/overlay-fixture";
  const left = await open(workspace, route);
  const chat = await shell.cli<{ paneId: string }>(
    "pane",
    "split",
    "--workspace",
    workspace,
    "--id",
    left.paneId,
    "--direction",
    "right",
  );
  await expect.poll(async () => (await inspect(left.id)).visible).toBe(true);
  const chatTab = shell.page.locator(`[data-tab-id="${chat.paneId}"]`);
  const leftPane = shell.pane(left.paneId);
  const area = leftPane.getByRole("region", { name: "Browser content" });
  const bounds = (await area.boundingBox())!;
  const pagePoint = {
    x: bounds.x + 30,
    y: bounds.y + bounds.height / 2 + 100,
  };
  const reportLayout = (layout: BrowserLayout) =>
    shell.page.evaluate(
      async ({ id, layout }) => {
        window.cod.browserLayout(layout);
        // Both messages go through the same desktop renderer IPC connection.
        return window.cod.invoke<{ visible: boolean }>({
          op: "browser.inspect",
          id,
        });
      },
      { id: left.id, layout },
    );
  expect(await reportLayout({ rectangles: [] })).toMatchObject({
    visible: true,
  });
  expect(
    await reportLayout({ rectangles: [{ id: left.id, ...bounds, width: 0 }] }),
  ).toMatchObject({ visible: true });
  const pageColor = [14, 122, 86];
  const pointColor = async () =>
    (await nativeBrowserFrame([pagePoint])).colors[0];
  await expect.poll(pointColor).toEqual(pageColor);
  await remote(route, "window.scrollTo(0, 150)");
  const pageGeometry = () =>
    remote(
      route,
      "({ width: innerWidth, height: innerHeight, scroll: scrollY })",
    );
  await expect.poll(pageGeometry).toMatchObject({ scroll: 150 });
  const initial = await pageGeometry();
  const tabBox = (await chatTab.boundingBox())!;
  const popupPoint = {
    x: Math.ceil(tabBox.x + 20),
    y: Math.ceil(tabBox.y + tabBox.height + 25),
  };
  const frame = () => nativeBrowserFrame([pagePoint, popupPoint]);
  const previousFrame = await frame();
  await chatTab.focus();
  await chatTab.press("Shift+F10");
  await expect
    .poll(async () => (await frame()).colors[1])
    .not.toEqual(previousFrame.colors[1]);
  expect(await inspect(left.id)).toMatchObject({ visible: true });
  await expect(shell.page.locator("dialog[open]")).toHaveCount(0);
  expect(await pointColor()).toEqual(pageColor);
  await writeFile(
    info.outputPath("browser-adjacent-chat-menu.png"),
    Buffer.from((await frame()).image, "base64"),
  );
  await execute("xdotool", ["key", "Escape"]);
  await expect(chatTab).toBeFocused();
  await expect
    .poll(async () => (await frame()).colors)
    .toEqual(previousFrame.colors);

  await shell.cli(
    "pane",
    "focus",
    "--workspace",
    workspace,
    "--id",
    chat.paneId,
  );
  const rightRoute = route + "?right";
  const right = await shell.cli<BrowserRecord>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    origin + rightRoute,
    "--source-pane",
    chat.paneId,
    "--focus",
    "true",
  );
  await expect.poll(async () => (await inspect(right.id)).visible).toBe(true);
  await expect.poll(async () => (await inspect(left.id)).visible).toBe(true);
  const block = leftPane.getByRole("button", {
    name: "Ad blocking",
    exact: true,
  });
  const dialog = shell.page.getByRole("dialog", { name: "Site protection" });
  const leftStill = area.locator("img.browser-overview-backdrop");
  const rightPane = shell.pane(right.paneId);
  const rightStill = rightPane.locator("img.browser-overview-backdrop");
  const rightPaused = rightPane.getByText(
    "Page paused while this dialog is open",
  );
  function done() {
    return dialog.getByRole("button", { name: "Done", exact: true }).click();
  }
  await block.click();
  await expect(dialog).toHaveCSS("opacity", "1");
  await expect(leftStill).toBeVisible();
  await expect(rightStill).toBeVisible();
  await expect(rightPaused).toBeHidden();
  expect(await inspect(left.id)).toMatchObject({ visible: false });
  expect(await inspect(right.id)).toMatchObject({ visible: false });
  expect(
    await reportLayout({ rectangles: [{ id: left.id, ...bounds }] }),
  ).toMatchObject({ visible: false });
  expect(
    await reportLayout({
      rectangles: [{ id: left.id, ...bounds }],
      resumeModal: -1,
    }),
  ).toMatchObject({ visible: false });
  await clickNativeBrowser(pagePoint.x, pagePoint.y);
  expect(await remote(route, "pageClicks")).toBe(0);
  await shell.page.screenshot({
    path: info.outputPath("browser-both-backed-under-modal.png"),
  });
  await done();
  await expect.poll(async () => (await inspect(right.id)).visible).toBe(true);
  await expect.poll(async () => (await inspect(left.id)).visible).toBe(true);
  await expect(leftStill).toHaveCount(0);

  // Only one capture stalls. Its neighbor must retain the real page image,
  // and the modal must appear without waiting for the stalled browser.
  await shell.app!.evaluate(({ webContents }, url) => {
    const wc = webContents
      .getAllWebContents()
      .find((item) => item.getURL() === url)!;
    wc.capturePage = () => new Promise(() => undefined);
  }, origin + rightRoute);
  await block.click();
  await expect(dialog).toHaveCSS("opacity", "1");
  await expect(leftStill).toBeVisible();
  await expect(rightStill).toHaveCount(0);
  await expect(rightPaused).toBeVisible();
  expect(await inspect(left.id)).toMatchObject({ visible: false });
  expect(await inspect(right.id)).toMatchObject({ visible: false });
  await shell.page.screenshot({
    path: info.outputPath("browser-modal-capture-fallback.png"),
  });
  // The genuine modal close can arrive ahead of layout settling.
  await area.evaluate((slot) => {
    slot.getBoundingClientRect = () => new DOMRect();
  });
  await done();
  await expect(rightPaused).toBeHidden();
  await expect.poll(async () => (await inspect(left.id)).visible).toBe(true);
  await expect.poll(async () => (await inspect(right.id)).visible).toBe(true);
  await area.evaluate((slot) =>
    Reflect.deleteProperty(slot, "getBoundingClientRect"),
  );
  await expect.poll(pageGeometry).toEqual(initial);
});

test("A shell reload releases its modal and a crashed page exposes its recovery controls", async () => {
  const workspace = await shell.create("Browser presentation lifecycle");
  const route = "/overlay-fixture";
  const { id, paneId } = await open(workspace, route);
  await expect.poll(async () => (await inspect(id)).visible).toBe(true);
  await remote(route, "window.scrollTo(0, 175)");
  const pane = shell.pane(paneId);
  await pane.getByRole("button", { name: "Ad blocking" }).click();
  const modal = shell.page.getByRole("dialog", { name: "Site protection" });
  await expect(modal).toHaveCSS("opacity", "1");
  expect(await inspect(id)).toMatchObject({ visible: false });

  await shell.app!.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const loaded = new Promise<void>((resolve) =>
      contents.once("did-finish-load", () => resolve()),
    );
    contents.reload();
    await loaded;
  });
  await expect(modal).toHaveCount(0);
  await expect.poll(async () => (await inspect(id)).visible).toBe(true);
  expect(await remote(route, "scrollY")).toBe(175);

  await shell.app!.evaluate(({ webContents }, url) => {
    const website = webContents
      .getAllWebContents()
      .find((wc) => wc.getURL() === url)!;
    website.forcefullyCrashRenderer();
  }, origin + route);
  const error = pane.getByRole("region", { name: "Page could not load" });
  await expect(error).toBeVisible();
  await expect.poll(async () => (await inspect(id)).visible).toBe(false);
  await error.getByRole("button", { name: "Reload page" }).click();
  await expect(error).toBeHidden();
  await expect.poll(async () => (await inspect(id)).visible).toBe(true);
});

test("Browser toolbar matches the tab height and fits larger interface text", async ({}, info) => {
  const workspace = await shell.create("Toolbar fixture");
  const route = "/toolbar-fixture";
  const record = await open(workspace, route);
  await remote(route, `document.querySelector('a[href="/download"]').click()`);
  const pane = shell.pane(record.paneId);
  const toolbar = pane.locator(".browser-navigation");
  const address = toolbar.getByRole("combobox", { name: "Address" });
  await expect(
    toolbar.getByRole("button", { name: "Downloads" }),
  ).toBeVisible();

  const fit = () =>
    toolbar.evaluate((row) => {
      const { left, right, top, bottom } = row.getBoundingClientRect();
      return [...row.querySelectorAll("input, button")]
        .filter((element) => element.getClientRects().length > 0)
        .every((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            bounds.left >= left &&
            bounds.right <= right &&
            bounds.top >= top &&
            bounds.bottom <= bottom
          );
        });
    });
  const screenshot = async (name: string) => {
    if (process.platform === "linux")
      await writeFile(
        info.outputPath(name),
        Buffer.from((await nativeBrowserFrame([])).image, "base64"),
      );
  };
  const tabs = shell.page.locator(".tab-bar").filter({
    has: shell.page.getByRole("tab", { name: "Fixture " + route }),
  });
  expect((await tabs.boundingBox())?.height).toBe(32);
  expect((await toolbar.boundingBox())?.height).toBe(32);
  expect((await address.boundingBox())?.height).toBe(28);
  for (const button of await toolbar.getByRole("button").all()) {
    expect(await button.boundingBox()).toMatchObject({ width: 28, height: 28 });
  }
  expect(await fit()).toBe(true);
  await screenshot("browser-toolbar-default.png");

  await shell.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(760, 620),
  );
  await expect
    .poll(async () => (await toolbar.boundingBox())?.width)
    .toBeLessThan(460);
  expect(await fit()).toBe(true);
  await address.focus();
  await expect(address).toBeFocused();
  await screenshot("browser-toolbar-narrow.png");

  await shell.cli(
    "settings",
    "update",
    "--values",
    JSON.stringify({ "ui.fontSize": 32 }),
  );
  await expect(address).toHaveCSS("font-size", "32px");
  expect((await toolbar.boundingBox())!.height).toBeGreaterThan(32);
  expect((await address.boundingBox())!.height).toBeGreaterThanOrEqual(52);
  expect(await fit()).toBe(true);
  await screenshot("browser-toolbar-large-text.png");
});

test("Address suggestions overlay a live browser and leave page input and geometry intact", async ({}, info) => {
  test.skip(process.platform !== "linux", "Requires the isolated X11 desktop");
  const workspace = await shell.create("Address suggestions over a page");
  const route = "/overlay-fixture";
  const destination = route + "?destination=one";
  await open(workspace, route + "?destination=three");
  await open(workspace, route + "?destination=two");
  await open(workspace, destination);
  await expect
    .poll(() => shell.cli("browser", "history", "--query", destination))
    .toEqual([expect.objectContaining({ url: origin + destination })]);
  const record = await open(workspace, route);
  await expect.poll(async () => (await inspect(record.id)).visible).toBe(true);
  await shell.cli("browser", "zoom", "--id", record.id, "--action", "in");
  await shell.cli("browser", "zoom", "--id", record.id, "--action", "in");
  const pane = shell.pane(record.paneId);
  const address = pane.getByRole("combobox", { name: "Address", exact: true });
  const viewport = pane.getByRole("region", { name: "Browser content" });
  const option = pane.getByRole("option", { name: /destination=one/ });
  const overlay = (paint = true) =>
    shell.app!.evaluate(async ({ BrowserWindow }, paint) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
        (view) =>
          "webContents" in view &&
          (view as Electron.WebContentsView).webContents
            .getURL()
            .endsWith("/address-overlay.html"),
      );
      if (!view?.getVisible()) return null;
      if (!paint) return view.getBounds();
      return {
        ...view.getBounds(),
        list: await (
          view as Electron.WebContentsView
        ).webContents.executeJavaScript(
          `(() => {
            const list = document.querySelector(".browser-suggestions");
            return {
              rows: list.children.length,
              overflow: list.scrollHeight - list.clientHeight,
              selected: list.querySelector('[aria-selected="true"] small')?.textContent,
            };
          })()`,
        ),
      };
    }, paint);
  const pageState = () =>
    remote(route, "({ width: innerWidth, height: innerHeight, top: scrollY })");
  const pageColor = [14, 122, 86];
  await remote(route, "window.scrollTo(0,80)");
  await expect.poll(pageState).toMatchObject({ top: 80 });
  const original = await pageState();
  const box = (await viewport.boundingBox())!;
  const point = (dy: number) => ({
    x: Math.floor(box.x + box.width / 2),
    y: Math.ceil(box.y + dy),
  });
  const baselinePoints = [point(16), point(box.height / 2)];
  const closed = () => nativeBrowserFrame(baselinePoints);
  await expect
    .poll(async () => (await closed()).colors)
    .toEqual([pageColor, pageColor]);
  await writeFile(
    info.outputPath("address-overlay-closed.png"),
    Buffer.from((await closed()).image, "base64"),
  );
  await address.focus();
  await address.fill("overlay-fixture");
  await expect(option).toBeVisible();
  expect(await viewport.boundingBox()).toEqual(box);
  expect(await pageState()).toEqual(original);
  await expect
    .poll(overlay)
    .toMatchObject({ y: box.y, width: Math.floor(box.width) });
  await address.press("ArrowDown");
  await expect(option).toHaveAttribute("aria-selected", "true");
  await expect(address).toHaveAttribute(
    "aria-activedescendant",
    (await option.getAttribute("id"))!,
  );
  await expect.poll(overlay).toMatchObject({
    list: { rows: 3, overflow: 0, selected: origin + destination },
  });
  await address.press("ArrowDown");
  await expect(
    pane.getByRole("option", { name: /destination=two/ }),
  ).toHaveAttribute("aria-selected", "true");
  await address.press("ArrowUp");
  await expect(option).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(async () => (await closed()).colors[0])
    .not.toEqual(pageColor);
  const opened = await closed();
  expect(opened.colors[1]).toEqual(pageColor);
  await writeFile(
    info.outputPath("address-overlay-open.png"),
    Buffer.from(opened.image, "base64"),
  );
  await expect(address).toBeFocused();
  expect(
    await remote(route, "typeof cod + ',' + typeof codAddressOverlay"),
  ).toBe("undefined,undefined");

  await address.dispatchEvent("compositionstart");
  await expect(option).toBeHidden();
  await expect.poll(overlay).toBeNull();
  await address.fill("overlay-fixture");
  await expect(address).toHaveAttribute("aria-expanded", "false");
  await address.dispatchEvent("compositionend");
  await expect(option).toBeVisible();
  await expect.poll(overlay).not.toBeNull();
  await address.press("Escape");
  await expect(option).toBeHidden();
  await expect.poll(overlay).toBeNull();
  await expect(address).toBeFocused();
  expect(await pageState()).toEqual(original);

  await address.fill("overlay-fixture");
  await expect.poll(overlay).not.toBeNull();
  await clickNativeBrowser(baselinePoints[1].x, baselinePoints[1].y);
  await expect.poll(() => remote(route, "pageClicks")).toBe(1);
  await expect(option).toBeHidden();
  await expect.poll(overlay).toBeNull();
  expect(await pageState()).toEqual(original);

  await address.focus();
  await address.fill("overlay-fixture");
  await expect.poll(overlay).not.toBeNull();
  await shell.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(960, 620),
  );
  await expect
    .poll(async () => (await viewport.boundingBox())?.width)
    .toBeLessThan(box.width);
  const narrow = (await viewport.boundingBox())!;
  await expect
    .poll(overlay)
    .toMatchObject({ y: narrow.y, width: Math.floor(narrow.width) });
  await writeFile(
    info.outputPath("address-overlay-narrow.png"),
    Buffer.from((await nativeBrowserFrame([])).image, "base64"),
  );
  await address.press(`${modifier}+Shift+o`);
  const overview = shell.page.getByRole("dialog", {
    name: "Overview",
    exact: true,
  });
  await expect(overview).toBeVisible();
  await expect(overview).not.toHaveAttribute("data-browser-preparing", "");
  await expect.poll(async () => (await nativeView(route))?.visible).toBe(false);
  await expect.poll(overlay).toBeNull();
  const dialog = (await overview.boundingBox())!;
  const backdropPoint = {
    x: Math.round(dialog.x + dialog.width / 3),
    y: Math.round(dialog.y + 100),
  };
  const dialogColor = await overview.evaluate((node) =>
    getComputedStyle(node)
      .backgroundColor.match(/\d+/g)!
      .slice(0, 3)
      .map(Number),
  );
  let modalFrame = await nativeBrowserFrame([backdropPoint]);
  await expect
    .poll(async () => {
      modalFrame = await nativeBrowserFrame([backdropPoint]);
      return modalFrame.colors[0];
    })
    .toEqual(dialogColor);
  await writeFile(
    info.outputPath("address-overlay-overview.png"),
    Buffer.from(modalFrame.image, "base64"),
  );
  await overview
    .getByRole("combobox", { name: "Search Overview" })
    .press("Escape");
  await expect(overview).toBeHidden();
  await expect(option).toBeHidden();

  await address.focus();
  await address.fill("overlay-fixture");
  await expect.poll(overlay).toMatchObject({ list: { rows: 3 } });
  await shell.app!.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents();
    const popup = contents.find((view) =>
      view.getURL().endsWith("/address-overlay.html"),
    )!;
    const renderer = popup.getOSProcessId();
    if (
      renderer <= 1 ||
      contents.some(
        (view) => view !== popup && view.getOSProcessId() === renderer,
      )
    )
      throw new Error("Expected a renderer dedicated to the test overlay");
    const gone = new Promise<void>((resolve) =>
      popup.once("render-process-gone", () => resolve()),
    );
    process.kill(renderer, "SIGKILL");
    await gone;
  });
  await expect.poll(() => overlay(false)).toBeNull();
  await expect(option).toBeHidden();
  await expect(address).toBeFocused();

  await address.fill("overlay-fixture");
  await expect.poll(overlay).toMatchObject({ list: { rows: 3 } });
  const row = (await option.boundingBox())!;
  await clickNativeBrowser(row.x + 30, row.y + row.height / 2);
  await expect
    .poll(async () => (await inspect(record.id)).url)
    .toBe(origin + destination);
  await expect.poll(overlay).toBeNull();
  await expect.poll(async () => (await inspect(record.id)).loading).toBe(false);
  await address.fill("overlay-fixture");
  await expect(
    pane
      .getByRole("option")
      .filter({ hasText: origin + route })
      .first(),
  ).toBeVisible();
  await address.press("ArrowDown");
  await address.press("Enter");
  await expect
    .poll(async () => (await inspect(record.id)).url)
    .toBe(origin + route);
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
    .getByRole("combobox", { name: "Address", exact: true });
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
  await shell.page.getByRole("button", { name: "Close", exact: true }).click();
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
    .getByRole("combobox", { name: "Address", exact: true })
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

test("Browser pickers keep long results readable and let the keyboard target row actions", async ({}, info) => {
  const workspace = await shell.create("Browser picker review");
  const routes = ["alpha", "beta"].map(
    (name) => `/picker-fixture-${name}-${"notes".repeat(45)}`,
  );
  for (const route of routes) {
    await open(workspace, route);
    await expect
      .poll(() =>
        shell.cli<Array<{ url: string }>>(
          "browser",
          "history",
          "--query",
          route,
        ),
      )
      .toEqual([expect.objectContaining({ url: origin + route })]);
  }
  await shell.cli(
    "browser",
    "bookmark",
    "--url",
    origin + routes[0],
    "--title",
    `Research notes ${"reference ".repeat(24)}`,
  );
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
    .getByRole("combobox", { name: "Address", exact: true });
  await address.fill("picker-fixture");
  const option = shell.pane(home.paneId).getByRole("option");
  await expect(option).toHaveCount(2);
  await address.press("ArrowDown");
  const activeOption = shell
    .pane(home.paneId)
    .locator('[role="option"][aria-selected="true"]');
  await expect(activeOption.locator("small")).toHaveCSS(
    "color",
    "rgb(220, 224, 229)",
  );
  await address.press("Escape");
  await address.fill("Keep this input");
  await address.evaluate((element) =>
    (element as HTMLInputElement).setSelectionRange(5, 9),
  );

  await shell.command("Browsing history");
  const history = shell.page.getByRole("dialog", {
    name: "Browsing history",
    exact: true,
  });
  const query = history.getByRole("textbox", {
    name: "Search history",
    exact: true,
  });
  await query.fill("picker-fixtureX");
  await query.press("End");
  await query.press("ArrowLeft");
  await query.press("Delete");
  await expect(query).toHaveValue("picker-fixture");
  const rows = history.locator(".browser-history-link");
  await expect(rows).toHaveCount(2);
  await query.press("ArrowDown");
  await expect(query).toBeFocused();
  const selected = history.locator(".browser-history-link.selected");
  const target = (await selected.locator("small").textContent())!;
  await expect(selected).toHaveAccessibleDescription(target);
  const other = routes
    .map((route) => origin + route)
    .find((url) => url !== target)!;
  const actionsButton = selected
    .locator("..")
    .getByRole("button", { name: /^Actions for / });
  const popup = shell.page.getByRole("dialog", {
    name: "Actions",
    exact: true,
  });
  const remove = popup.getByRole("button", {
    name: "Remove from history",
    exact: true,
  });
  const checkHistory = async (state: string) => {
    await expect(selected.locator("small")).toHaveCSS(
      "color",
      "rgb(220, 224, 229)",
    );
    await expect(actionsButton).toBeVisible();
    const geometry = await selected.evaluate((element) => {
      const row = element.parentElement!;
      const action = row.querySelector<HTMLElement>(
        ".browser-history-actions",
      )!;
      const detail = element.querySelector("small")!;
      return {
        clipped: detail.scrollWidth > detail.clientWidth,
        actionFits:
          action.getBoundingClientRect().right <=
          row.getBoundingClientRect().right,
        square: action.offsetWidth === action.offsetHeight,
      };
    });
    expect(geometry).toEqual({ clipped: true, actionFits: true, square: true });
    await shell.page.screenshot({
      path: info.outputPath(`browser-history-${state}.png`),
    });
  };
  await checkHistory("normal");
  await shell.cli(
    "settings",
    "update",
    "--values",
    JSON.stringify({ "ui.fontSize": 20 }),
  );
  await shell.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(760, 680),
  );
  await expect.poll(() => shell.page.evaluate(() => innerWidth)).toBe(760);
  await checkHistory("narrow");
  await query.press("Shift+F10");
  await expect(remove).toBeFocused();
  await expect(actionsButton).toHaveAttribute("aria-haspopup", "dialog");
  await expect(actionsButton).toHaveAttribute("aria-expanded", "true");
  await shell.page.screenshot({
    path: info.outputPath("browser-history-actions.png"),
  });
  await remove.press("Escape");
  await expect(query).toBeFocused();
  await query.press("Tab");
  await expect(actionsButton).toBeFocused();
  await actionsButton.press("Enter");
  await expect(remove).toBeFocused();
  await remove.press("Escape");
  await expect(actionsButton).toBeFocused();
  await actionsButton.press("Space");
  await remove.press("Enter");
  await expect(rows).toHaveCount(1);
  await expect(selected.locator("small")).toHaveText(other);
  await expect(query).toHaveValue("picker-fixture");
  await expect(query).toBeFocused();
  expect(
    await shell.cli("browser", "history", "--query", "picker-fixture"),
  ).toEqual([expect.objectContaining({ url: other })]);
  await query.press("Escape");
  await expect(address).toBeFocused();
  await expect(address).toHaveValue("Keep this input");
  expect(
    await address.evaluate((element: HTMLInputElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([5, 9]);

  await shell.command("Bookmarks");
  const bookmarks = shell.page.getByRole("dialog", {
    name: "Bookmarks",
    exact: true,
  });
  const bookmarkQuery = bookmarks.getByRole("textbox", {
    name: "Search bookmarks",
    exact: true,
  });
  await bookmarkQuery.fill("research notes");
  const bookmark = bookmarks.getByRole("button", { name: /^Research notes/ });
  await expect(bookmark).toBeVisible();
  await bookmarkQuery.press("ArrowDown");
  await expect(bookmark).toBeFocused();
  await expect(bookmark).toHaveAccessibleDescription(origin + routes[0]);
  await expect(bookmark.locator("small")).toHaveCSS(
    "color",
    "rgb(220, 224, 229)",
  );
  expect(
    await bookmark.evaluate((button) => {
      const row = button.parentElement!;
      const actions = row.querySelector<HTMLElement>(".bookmark-actions")!;
      const detail = button.querySelector("small")!;
      return (
        detail.scrollWidth > detail.clientWidth &&
        actions.getBoundingClientRect().right <=
          row.getBoundingClientRect().right
      );
    }),
  ).toBe(true);
  await shell.page.screenshot({
    path: info.outputPath("browser-bookmarks-narrow.png"),
  });
  await bookmark.press("Tab");
  const edit = bookmarks.getByRole("button", { name: "Edit", exact: true });
  await expect(edit).toBeFocused();
  await edit.press("Tab");
  const removeBookmark = bookmarks.getByRole("button", {
    name: "Remove",
    exact: true,
  });
  await expect(removeBookmark).toBeFocused();
  await removeBookmark.press("Enter");
  await expect(bookmarks.getByText("No bookmarks")).toBeVisible();
  await expect(bookmarkQuery).toHaveValue("research notes");
  await expect(bookmarkQuery).toBeFocused();
});

test("Site clipboard write follows tab permissions and keeps clipboard reads separate", async () => {
  const route = "/clipboard-fixture?value=";
  const workspace = await shell.create("Clipboard permissions");
  let currentRoute = route + "temporary";
  let currentOrigin = origin;
  const otherOrigin = origin.replace("127.0.0.1", "localhost");
  const record = await open(workspace, currentRoute);
  const prompt = () =>
    shell
      .pane(record.paneId)
      .getByRole("region", { name: "Site permission request" });
  const action = (label: string) =>
    prompt().getByRole("button", { name: label, exact: true });
  const status = () =>
    remote(
      currentRoute,
      "document.querySelector('output').value",
      currentOrigin,
    );
  const readClipboard = () =>
    shell.app!.evaluate(({ clipboard }) => clipboard.readText());
  const clickPage = async (button: "copy" | "read") => {
    const point = await remote(
      currentRoute,
      `(() => {
        const { x, y, width, height } = document.getElementById("${button}").getBoundingClientRect();
        return { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
      })()`,
      currentOrigin,
    );
    await shell.app!.evaluate(
      ({ webContents }, { url, point }) => {
        const contents = webContents
          .getAllWebContents()
          .find((page) => page.getURL() === url)!;
        contents.focus();
        contents.sendInputEvent({
          type: "mouseDown",
          button: "left",
          clickCount: 1,
          ...point,
        });
        contents.sendInputEvent({
          type: "mouseUp",
          button: "left",
          clickCount: 1,
          ...point,
        });
      },
      { url: currentOrigin + currentRoute, point },
    );
  };
  const navigate = async (value: string, site = origin) => {
    currentRoute = route + value;
    currentOrigin = site;
    await shell.cli(
      "browser",
      "navigate",
      "--id",
      record.id,
      "--url",
      site + currentRoute,
    );
  };
  const policies = () => shell.cli("browser", "permissions");

  await clickPage("copy");
  await expect(prompt()).toContainText("copy to clipboard");
  await action("Allow once").click();
  await expect.poll(status).toBe("copied");
  expect(await readClipboard()).toBe("temporary");
  expect(await policies()).toEqual([]);

  await navigate("remembered");
  await clickPage("copy");
  await expect(prompt()).toContainText(origin);
  await action("Always allow").click();
  await expect.poll(status).toBe("copied");
  expect(await readClipboard()).toBe("remembered");

  await clickPage("read");
  await expect(prompt()).toContainText("read from clipboard");
  await action("Block").click();
  await expect.poll(status).toBe("NotAllowedError");

  await navigate("blocked", otherOrigin);
  await clickPage("copy");
  await expect(prompt()).toContainText(otherOrigin);
  await action("Block").click();
  await expect.poll(status).toBe("NotAllowedError");
  expect(await readClipboard()).toBe("remembered");

  await shell.stop();
  await shell.start();
  await clickPage("copy");
  await expect.poll(status).toBe("NotAllowedError");
  await expect(prompt()).toHaveCount(0);

  await navigate("after-restart");
  await clickPage("copy");
  await expect.poll(status).toBe("copied");
  await expect(prompt()).toHaveCount(0);
  expect(await readClipboard()).toBe("after-restart");
  expect(await policies()).toEqual(
    expect.arrayContaining([
      {
        origin,
        topOrigin: origin,
        permission: "clipboard-sanitized-write",
        decision: "allow",
      },
      {
        origin,
        topOrigin: origin,
        permission: "clipboard-read",
        decision: "block",
      },
      {
        origin: otherOrigin,
        topOrigin: otherOrigin,
        permission: "clipboard-sanitized-write",
        decision: "block",
      },
    ]),
  );
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
  await shell.page.screenshot({
    path: info.outputPath("site-permissions-selects.png"),
  });
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

test("Site permission rejection restores the committed choice and ignores a superseded error", async ({}, info) => {
  const workspace = await shell.create("Site permission recovery");
  const browser = await open(workspace, "/permission-recovery");
  const address = shell.pane(browser.paneId).getByRole("combobox", {
    name: "Address",
    exact: true,
  });
  await address.focus();
  await shell.command("Site permissions");
  await expect
    .poll(async () => (await nativeView("/permission-recovery"))?.visible)
    .toBe(false);
  const dialog = shell.page.getByRole("dialog", { name: "Site permissions" });
  const camera = dialog.getByLabel(`Camera for ${origin}`, { exact: true });
  const set = (decision: string) =>
    shell.cli(
      "browser",
      "permission-set",
      "--origin",
      origin,
      "--permission",
      "camera",
      "--decision",
      decision,
    );
  await expect(camera).toHaveValue("ask");
  await expect(camera).toBeFocused();
  await set("allow");

  await shell.app!.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: any[]) => unknown>;
      }
    )._invokeHandlers;
    const original = handlers.get("cod:invoke")!;
    const fixture = {
      attempts: 0,
      release: undefined as (() => void) | undefined,
    };
    Object.assign(globalThis, { permissionFailure: fixture });
    ipcMain.removeHandler("cod:invoke");
    ipcMain.handle("cod:invoke", async (event, request) => {
      if (
        request.op !== "browser.permission-set" ||
        request.decision !== "block" ||
        ++fixture.attempts > 2
      )
        return original(event, request);
      if (fixture.attempts === 2)
        await new Promise<void>((resolve) => (fixture.release = resolve));
      throw new Error("Invented permissions write failed");
    });
  });
  await camera.focus();
  await camera.selectOption("block");
  await expect(dialog.getByRole("alert")).toContainText(
    "Invented permissions write failed",
  );
  await expect(camera).toHaveValue("allow");
  await expect(camera).toBeFocused();
  await shell.page.screenshot({
    path: info.outputPath("site-permission-rollback.png"),
  });
  await shell.page.setViewportSize({ width: 460, height: 700 });
  await expect(camera).toBeInViewport();
  await expect(dialog.getByRole("alert")).toBeInViewport();
  await shell.page.screenshot({
    path: info.outputPath("site-permission-rollback-narrow.png"),
  });

  await camera.selectOption("block");
  await expect
    .poll(() =>
      shell.app!.evaluate(
        () =>
          typeof (
            globalThis as unknown as {
              permissionFailure: { release?: () => void };
            }
          ).permissionFailure.release,
      ),
    )
    .toBe("function");
  try {
    await camera.selectOption("ask");
    await expect.poll(() => shell.cli("browser", "permissions")).toEqual([]);
  } finally {
    await shell.app!.evaluate(() =>
      (
        globalThis as unknown as {
          permissionFailure: { release?: () => void };
        }
      ).permissionFailure.release?.(),
    );
  }
  await camera.selectOption("block");
  await expect
    .poll(() => shell.cli("browser", "permissions"))
    .toEqual([
      { origin, topOrigin: origin, permission: "camera", decision: "block" },
    ]);
  await expect(camera).toHaveValue("block");
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  const longOrigin = `https://${"long".repeat(14)}.example.test`;
  await shell.cli(
    "browser",
    "permission-set",
    "--origin",
    longOrigin,
    "--top-origin",
    origin,
    "--permission",
    "camera",
    "--decision",
    "block",
  );
  await shell.page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(address).toBeFocused();
  await expect
    .poll(async () => (await nativeView("/permission-recovery"))?.visible)
    .toBe(true);

  await shell.cli(
    "settings",
    "update",
    "--values",
    JSON.stringify({ "ui.fontSize": 20 }),
  );
  await shell.page.setViewportSize({ width: 420, height: 560 });
  await expect(shell.page.locator("html")).toHaveCSS("font-size", "20px");
  await shell.command("Site permissions");
  const longSection = dialog.getByRole("heading", {
    name: `${longOrigin} inside ${origin}`,
    exact: true,
  });
  await expect(longSection).toBeVisible();
  await scrollManager(
    dialog,
    dialog.getByText("Changes apply to new requests.", { exact: false }),
  );
  await shell.page.screenshot({
    path: info.outputPath("site-permissions-scrolled-narrow.png"),
  });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(address).toBeFocused();
});

test("Downloads survive tab closure and retain history across restart", async () => {
  const workspace = await shell.create("Downloads");
  const record = await open(workspace);
  await remote(
    "/one",
    `const a = document.createElement('a'); a.href='/slow-download'; document.body.append(a); a.click();`,
  );
  const entries = () => shell.cli<BrowserDownload[]>("browser", "downloads");
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
  const completed = (await entries())[0]!;
  await shell.stop();
  const state = readWorkspaceState(shell.data);
  state.browserDownloads = [
    ...Array.from({ length: 14 }, (_, index) => ({
      ...completed,
      id: `fixture-download-${index}`,
      basename:
        index === 13
          ? `invented-${"long".repeat(20)}.txt`
          : `fixture-archive-${index}.zip`,
      path: undefined,
      receivedBytes: 0,
      status: "cancelled" as const,
    })),
    completed,
  ];
  writeWorkspaceState(shell.data, state);
  await shell.start();
  await expect
    .poll(
      async () =>
        (await entries()).find(({ id }) => id === completed.id)?.status,
    )
    .toBe("completed");
  const overview = await shell.overview();
  await shell.row("Downloads").click();
  await expect(overview).toBeHidden();
  await shell.command("Downloads");
  const dialog = shell.page!.getByRole("dialog", {
    name: "Downloads",
    exact: true,
  });
  const done = dialog.getByRole("button", { name: "Done", exact: true });
  await expect(done).toBeFocused();
  const row = dialog.getByRole("region", { name: "large.bin", exact: true });
  const lastAction = row.getByRole("button", { name: "Show in folder" });
  await expect(lastAction).toBeVisible();
  await shell.page.screenshot({
    path: test.info().outputPath("downloads.png"),
  });
  await shell.page.setViewportSize({ width: 420, height: 560 });
  await shell.cli(
    "settings",
    "update",
    "--values",
    JSON.stringify({ "ui.fontSize": 20 }),
  );
  await expect(shell.page.locator("html")).toHaveCSS("font-size", "20px");
  await scrollManager(dialog, lastAction);
  await shell.page.screenshot({
    path: test.info().outputPath("downloads-scrolled-narrow.png"),
  });
  await shell.app!.evaluate(({ ipcMain }, id) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: any[]) => unknown>;
      }
    )._invokeHandlers;
    const original = handlers.get("cod:invoke")!;
    const fixture = { reject: undefined as (() => void) | undefined };
    Object.assign(globalThis, { downloadFailure: fixture });
    ipcMain.removeHandler("cod:invoke");
    ipcMain.handle("cod:invoke", async (event, request) => {
      if (
        request.op !== "browser.download-action" ||
        request.action !== "remove" ||
        request.id !== id ||
        fixture.reject
      )
        return original(event, request);
      await new Promise<void>((resolve) => (fixture.reject = resolve));
      throw new Error("Invented download action failed");
    });
  }, completed.id);
  const remove = row.getByRole("button", { name: "Remove from list" });
  await remove.click();
  await expect(remove).toBeDisabled();
  await expect(remove).toHaveAttribute("aria-busy", "true");
  await expect(done).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      shell.app!.evaluate(
        () =>
          typeof (
            globalThis as unknown as {
              downloadFailure: { reject?: () => void };
            }
          ).downloadFailure.reject,
      ),
    )
    .toBe("function");
  await shell.app!.evaluate(() => {
    const fixture = globalThis as unknown as {
      downloadFailure: { reject: () => void };
    };
    fixture.downloadFailure.reject();
  });
  const error = dialog.getByRole("alert");
  await expect(error).toHaveText("Invented download action failed");
  await expect(error).toBeInViewport({ ratio: 1 });
  await expect(remove).toBeEnabled();
  await shell.page.screenshot({
    path: test.info().outputPath("downloads-action-error-narrow.png"),
  });
  await remove.click();
  await expect(error).toHaveCount(0);
  await expect
    .poll(async () => (await entries()).some(({ id }) => id === completed.id))
    .toBe(false);
  await shell.page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
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
    .getByRole("combobox", { name: "Address", exact: true })
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
    .getByRole("combobox", { name: "Address", exact: true })
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
  const divider = shell.page.getByRole("separator", { name: "Resize panes" });
  await expect(divider).toBeVisible();
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
  await expect(divider).toBeVisible();
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
  await expect(divider).toBeHidden();
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
  const overview = await shell.overview();
  const search = overview.getByRole("combobox");
  const target = overview.locator(
    `.overview-item[data-navigation-key="browser:${browser.id}"]`,
  );
  await target.hover();
  await search.press(`${modifier}+w`);
  await expect(search).toBeFocused();
  await expect(target).toBeVisible();
  expect((await inspect(browser.id)).id).toBe(browser.id);
  await search.press("Escape");
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
  await shell.overview();
  await expect(shell.row("Protected workspace form")).toBeVisible();
  await shell.page.keyboard.press("Escape");
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
  expect(colors.cover).toBe("rgb(47, 52, 62)");
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
  await shell.overview();
  await expect(shell.row("Still visible")).toBeVisible();
  await shell.page.keyboard.press("Escape");
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
  const saved = readWorkspaceState(shell.data);
  expect(saved.browsers.some((item) => item.id === browser.id)).toBe(true);
  await shell.start();
  expect((await inspect(browser.id)).paneId).toBe(browser.paneId);
});

test("Ordinary target blank links become managed tabs in the opener group and survive restart", async () => {
  const workspace = await shell.create("Managed browser tabs");
  const parent = await open(workspace);
  const existing = await open(workspace, "/existing");
  const before = (await shell.workspace(workspace)).groups.find((group) =>
    group.paneIds.includes(parent.paneId),
  )!;
  expect(before.paneIds.at(-1)).toBe(existing.paneId);
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
  ).toEqual([...before.paneIds, child.paneId]);
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

test("A failed native file reopen preserves the pinned closed entry and can be retried", async () => {
  const workspace = await shell.create("Recover a closed local page");
  const file = path.join(shell.folders[0], "recover local page.html");
  const markup = "<title>Recovered local page</title><h1>Local fixture</h1>";
  await writeFile(file, markup);
  const url = pathToFileURL(file).href;
  const browser = await shell.cli<BrowserRecord>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    url,
  );
  await shell.cli(
    "pane",
    "pin",
    "--workspace",
    workspace,
    "--id",
    browser.paneId,
    "--pinned",
    "true",
  );
  const live = await shell.workspace(workspace);
  await shell.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    browser.paneId,
    "--include-pinned",
    "true",
  );
  const appState = () => shell.cli<import("../../src/types").AppState>("state");
  const saved = (await appState()).workspaces
    .find((item) => item.id === workspace)
    ?.closedTabs?.at(-1);
  expect(saved?.pane.id).toBe(browser.paneId);
  await unlink(file);

  const failed = await shell.raw("pane", "reopen", "--workspace", workspace);
  expect(failed.code).not.toBe(0);
  const afterFailure = await appState();
  const closedWorkspace = afterFailure.workspaces.find(
    (item) => item.id === workspace,
  )!;
  expect(closedWorkspace.closedTabs?.at(-1)).toEqual(saved);
  expect(closedWorkspace.panes.some((pane) => pane.id === browser.paneId)).toBe(
    false,
  );
  expect(afterFailure.browsers.some((item) => item.id === browser.id)).toBe(
    false,
  );

  await writeFile(file, markup);
  const reopened = await shell.cli<{ paneId: string }>(
    "pane",
    "reopen",
    "--workspace",
    workspace,
  );
  expect(reopened.paneId).toBe(browser.paneId);
  const afterRetry = await appState();
  const reopenedWorkspace = afterRetry.workspaces.find(
    (item) => item.id === workspace,
  )!;
  expect(
    reopenedWorkspace.closedTabs?.some(
      (item) => item.pane.id === browser.paneId,
    ),
  ).not.toBe(true);
  expect(
    reopenedWorkspace.panes.filter((pane) => pane.id === browser.paneId),
  ).toEqual([saved?.pane]);
  const group = live.groups?.find((item) =>
    item.paneIds.includes(browser.paneId),
  );
  expect(
    reopenedWorkspace.groups?.find((item) => item.id === group?.id)?.paneIds,
  ).toEqual(group?.paneIds);
  expect(
    afterRetry.browsers.filter((item) => item.id === browser.id),
  ).toHaveLength(1);
  await expect
    .poll(() =>
      shell.app!.evaluate(
        ({ webContents }, address) =>
          webContents
            .getAllWebContents()
            .find(
              (item) => item.getURL() === address && !item.isLoadingMainFrame(),
            )
            ?.getTitle(),
        url,
      ),
    )
    .toBe("Recovered local page");
});

test("An in-flight browser reopen keeps the closed entry private and admits it only once", async () => {
  const workspace = await shell.create("Admit a closed page once");
  const release = () => {
    slowResponse?.end("<title>Delayed browser fixture</title>");
    slowResponse = undefined;
  };
  const opened = open(workspace, "/slow");
  await expect.poll(() => Boolean(slowResponse)).toBe(true);
  release();
  const browser = await opened;
  await shell.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    browser.paneId,
  );
  requests = [];

  const appState = () => shell.cli<import("../../src/types").AppState>("state");
  const before = (await appState()).workspaces.find(
    (item) => item.id === workspace,
  )!;
  const reopening = shell.raw("pane", "reopen", "--workspace", workspace);
  try {
    await expect.poll(() => Boolean(slowResponse)).toBe(true);
    const pending = await appState();
    expect(pending.workspaces.find((item) => item.id === workspace)).toEqual(
      before,
    );
    expect(pending.browsers.some((item) => item.id === browser.id)).toBe(false);
    const second = await shell.raw("pane", "reopen", "--workspace", workspace);
    expect(second.code).not.toBe(0);
  } finally {
    // Release the actual native request even if a transaction assertion fails.
    release();
    await reopening;
  }

  const result = await reopening;
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ paneId: browser.paneId });
  const restored = await appState();
  const active = restored.workspaces.find((item) => item.id === workspace)!;
  expect(
    active.panes.filter((pane) => pane.id === browser.paneId),
  ).toHaveLength(1);
  expect(
    restored.browsers.filter((item) => item.id === browser.id),
  ).toHaveLength(1);
  expect(requests.filter((route) => route === "/slow")).toEqual(["/slow"]);
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
  {
    using db = openWorkspaceState(shell.data, true);
    const saved = db.prepare("SELECT body FROM records").all();
    expect(
      saved.some(({ body }) => String(body).includes("private-form-value")),
    ).toBe(false);
    expect(saved.some(({ body }) => String(body).includes('"pageState"'))).toBe(
      false,
    );
  }
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
  const address = pane.getByRole("combobox", { name: "Address", exact: true });
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
      .getByRole("combobox", { name: "Address", exact: true }),
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
    .getByRole("combobox", { name: "Address", exact: true });
  const results = shell
    .pane(current.paneId)
    .getByRole("listbox", { name: "Address suggestions" });
  await pageKey("/quiet-current", "L", [
    process.platform === "darwin" ? "meta" : "control",
  ]);
  await expect(address).toBeFocused();
  await expect(address).toHaveAttribute("aria-expanded", "false");
  await expect(address).not.toHaveAttribute("aria-activedescendant");
  await expect(address).toMatchAriaSnapshot('- combobox "Address"');

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
  await expect(address).toBeFocused();
  await expect(address).toHaveAttribute("aria-expanded", "true");
  const controlled = await results.getAttribute("id");
  await expect(address).toHaveAttribute("aria-controls", controlled!);
  const selectedId = await results
    .getByRole("option", { selected: true })
    .getAttribute("id");
  await expect(address).toHaveAttribute("aria-activedescendant", selectedId!);
  expect(await address.ariaSnapshot()).toContain("[expanded]");
  expect(await results.ariaSnapshot()).toContain("[selected]");

  await expect(results).not.toContainText(origin + "/quiet-current");
  await expect(results.getByRole("option").first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await address.press("Escape");
  await expect(address).toBeFocused();
  await expect(address).toHaveValue(origin + "/quiet-current");
  await expect(results).toBeHidden();
  await expect(address).toHaveAttribute("aria-expanded", "false");
  await expect(address).not.toHaveAttribute("aria-activedescendant");
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

test("Address selection uses current navigation state before a pending render and retains an active edit", async () => {
  const workspace = await shell.create("Address render fixture");
  const current = await open(workspace, "/address-before-render");
  await remote("/address-before-render", "document.title");
  const address = shell
    .pane(current.paneId)
    .getByRole("combobox", { name: "Address", exact: true });
  await expect(address).toHaveValue(origin + "/address-before-render");
  await shell.page.evaluate(() => {
    const original = window.requestAnimationFrame.bind(window),
      pending: FrameRequestCallback[] = [];
    Object.assign(globalThis, {
      addressStateUrl: "",
      releaseAddressRender: () => {
        window.requestAnimationFrame = original;
        for (const callback of pending) original(callback);
      },
    });
    window.cod.onState((state) => {
      (globalThis as any).addressStateUrl = state.browsers.at(-1)?.url;
    });
    window.requestAnimationFrame = (callback) => {
      pending.push(callback);
      return 0;
    };
  });
  try {
    await shell.cli(
      "browser",
      "navigate",
      "--id",
      current.id,
      "--url",
      origin + "/address-after-render",
    );
    await remote("/address-after-render", "document.title");
    await expect
      .poll(() =>
        shell.page.evaluate(() => (globalThis as any).addressStateUrl),
      )
      .toBe(origin + "/address-after-render");
    await pageKey("/address-after-render", "L", [
      process.platform === "darwin" ? "meta" : "control",
    ]);
    await expect(address).toBeFocused();
    await expect(address).toHaveValue(origin + "/address-after-render");
    expect(
      await address.evaluate((input: HTMLInputElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    ).toEqual([0, (origin + "/address-after-render").length]);
  } finally {
    await shell.page.evaluate(() => (globalThis as any).releaseAddressRender());
  }
  await address.fill("An unfinished address edit");
  await address.press(`${modifier}+l`);
  await expect(address).toHaveValue("An unfinished address edit");
  expect(
    await address.evaluate((input: HTMLInputElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([0, "An unfinished address edit".length]);
});

test("Address suggestions discard dismissed and superseded replies and wait for committed composition", async ({}, info) => {
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
      if (
        request.query === "delayed" ||
        request.query === "delayed-alternativ" ||
        request.query.endsWith("/delayed-submit")
      )
        await new Promise<void>((resolve) => {
          state.releaseSuggestion = resolve;
        });
      return response;
    });
  });
  const address = shell
    .pane(current.paneId)
    .getByRole("combobox", { name: "Address", exact: true });
  const results = shell
    .pane(current.paneId)
    .getByRole("listbox", { name: "Address suggestions" });
  const queries = () =>
    shell.app!.evaluate(
      () =>
        (globalThis as unknown as { suggestionQueries: string[] })
          .suggestionQueries,
    );
  const release = async () => {
    await expect
      .poll(() =>
        shell.app!.evaluate(
          () =>
            typeof (globalThis as unknown as { releaseSuggestion?: () => void })
              .releaseSuggestion,
        ),
      )
      .toBe("function");
    await shell.app!.evaluate(() => {
      const fixture = globalThis as unknown as {
        releaseSuggestion?: () => void;
      };
      const resolve = fixture.releaseSuggestion;
      fixture.releaseSuggestion = undefined;
      resolve?.();
    });
  };
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

  await address.fill("delayed-alternative");
  const previous = results.getByRole("option", { name: /delayed-alternative/ });
  await expect(previous).toBeVisible();
  await address.press("ArrowDown");
  await expect(previous).toHaveAttribute("aria-selected", "true");
  await shell.page.screenshot({
    path: info.outputPath("suggestions-before-edit.png"),
  });
  const submit = origin + "/delayed-submit";
  await address.fill(submit);
  await expect.poll(() => queries()).toContain(submit);
  await shell.page.screenshot({
    path: info.outputPath("suggestions-pending.png"),
  });
  await expect(results).toBeVisible();
  await expect(address).toHaveAttribute("aria-expanded", "true");
  await expect(previous).toHaveAttribute("aria-disabled", "true");
  await expect(address).not.toHaveAttribute("aria-activedescendant");
  await expect(address).toBeFocused();
  await expect(address).toHaveValue(submit);
  const point = await previous.boundingBox();
  expect(point).not.toBeNull();
  await shell.page.mouse.click(point!.x + 6, point!.y + 6);
  await expect(address).toBeFocused();
  await expect(address).toHaveValue(submit);
  expect((await inspect(current.id)).url).toBe(origin + "/delayed-current");
  await address.press("Enter");
  await expect.poll(async () => (await inspect(current.id)).url).toBe(submit);
  await release();
  await expect(results).toBeHidden();

  await address.focus();
  await address.fill("delayed-alternative");
  await expect(previous).toBeVisible();
  const beforeRefresh = (await queries()).length;
  await address.fill("delayed-alternativ");
  await expect.poll(() => queries()).toHaveLength(beforeRefresh + 1);
  await address.press("ArrowDown");
  await release();
  await expect(previous).toHaveAttribute("aria-selected", "true");
  await shell.page.screenshot({
    path: info.outputPath("suggestions-refreshed.png"),
  });
  await address.press("Escape");
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
  await address.press(`${modifier}+F`);
  const find = shell.page.getByRole("textbox", {
    name: "Find in current content",
    exact: true,
  });
  await expect(find).toBeFocused();
  await address.fill("delayed-alternative");
  await expect(results).toBeVisible();
  await address.press("Escape");
  await expect(results).toBeHidden();
  await expect(find).toBeVisible();
  await address.press("Escape");
  await expect(find).toBeHidden();
  await expect(address).toBeFocused();
});

test("Google autocomplete supplements local rows and cancels on edits or dismissal", async ({}, info) => {
  const workspace = await shell.create("Search suggestions fixture");
  const record = await open(workspace, "/suggestions-start");
  await remote("/suggestions-start", "document.title");
  await expect
    .poll(async () => {
      const browser = await shell.cli<{
        addons?: { adblock: { status: string } };
      }>("browser", "inspect", "--id", record.id);
      return browser.addons?.adblock.status;
    })
    .toBe("ready");
  const localTitle = "Grow basil in the local guide";
  await shell.cli(
    "browser",
    "pin",
    "--url",
    origin + "/basil-guide",
    "--title",
    localTitle,
  );

  const requestsSeen: Array<{ query: string; credentialed: boolean }> = [];
  const disconnected: string[] = [];
  const held = new Map<string, () => void>();
  const literal = "http://example.test/path";
  const fixture = createServer((request, response) => {
    const query = new URL(request.url!, "http://fixture").searchParams.get(
      "q",
    )!;
    requestsSeen.push({
      query,
      credentialed: Boolean(
        request.headers.cookie ||
        request.headers.authorization ||
        request.headers.referer,
      ),
    });
    response.on("close", () => {
      if (!response.writableEnded) disconnected.push(query);
    });
    held.set(query, () =>
      response.end(JSON.stringify([query, [literal, "basil in pots"]])),
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureAddress = fixture.address();
  if (!fixtureAddress || typeof fixtureAddress === "string")
    throw new Error("Autocomplete fixture could not open a loopback socket");
  try {
    await shell.app!.evaluate(
      ({ session }, { completionOrigin, pageOrigin }) => {
        const request = globalThis.fetch;
        const cancellations: Array<[string, string]> = [];
        Object.assign(globalThis, { autocompleteCancellations: cancellations });
        globalThis.fetch = (target, options) => {
          const url = new URL(String(target));
          if (
            url.origin === "https://www.google.com" &&
            url.pathname === "/complete/search"
          ) {
            const signal = options?.signal;
            signal?.addEventListener(
              "abort",
              () => {
                cancellations.push([
                  url.searchParams.get("q")!,
                  signal.reason.name,
                ]);
              },
              { once: true },
            );
            return request(completionOrigin + url.search, options);
          }
          return request(target, options);
        };
        session
          .fromPartition("persist:cod-browser")
          .webRequest.onBeforeRequest(
            { urls: ["https://duckduckgo.com/*"] },
            (details, callback) =>
              callback({
                redirectURL:
                  pageOrigin +
                  "/fixture-engine-result" +
                  new URL(details.url).search,
              }),
          );
      },
      {
        completionOrigin: `http://127.0.0.1:${fixtureAddress.port}`,
        pageOrigin: origin,
      },
    );

    const pane = shell.pane(record.paneId);
    const address = pane.getByRole("combobox", {
      name: "Address",
      exact: true,
    });
    const results = pane.getByRole("listbox", { name: "Address suggestions" });
    const search = results.getByRole("option", {
      name: /example\.test\/path Search/,
    });
    await address.fill("grow basil");
    const guide = results.getByRole("option", { name: new RegExp(localTitle) });
    await expect(guide).toBeVisible();
    await address.press("ArrowDown");
    await expect(guide).toHaveAttribute("aria-selected", "true");
    await shell.page.screenshot({
      path: info.outputPath("suggestions-local.png"),
    });
    await expect
      .poll(() => requestsSeen)
      .toEqual([{ query: "grow basil", credentialed: false }]);
    held.get("grow basil")!();
    await expect(search).toBeVisible();
    await expect(guide).toHaveAttribute("aria-selected", "true");
    await expect(address).toHaveValue("grow basil");
    await expect(address).toBeFocused();
    await shell.page.screenshot({
      path: info.outputPath("suggestions-combined.png"),
    });

    await address.fill("plant basil");
    await expect.poll(() => held.has("plant basil")).toBe(true);
    await address.fill("plant thyme");
    await expect.poll(() => disconnected).toContain("plant basil");
    await expect.poll(() => held.has("plant thyme")).toBe(true);
    await address.press("Escape");
    await expect.poll(() => disconnected).toContain("plant thyme");
    const cancellations = await shell.app!.evaluate(
      () =>
        (
          globalThis as unknown as {
            autocompleteCancellations: Array<[string, string]>;
          }
        ).autocompleteCancellations,
    );
    expect(cancellations).toContainEqual(["plant basil", "AbortError"]);
    expect(cancellations).toContainEqual(["plant thyme", "AbortError"]);
    await expect(results).toBeHidden();
    await expect(address).toHaveValue("plant thyme");
    await address.fill("example.test path");
    await shell.page.waitForTimeout(380);
    expect(requestsSeen.map(({ query }) => query)).toEqual([
      "grow basil",
      "plant basil",
      "plant thyme",
    ]);

    await address.fill("grow basil");
    await expect.poll(() => requestsSeen).toHaveLength(4);
    held.get("grow basil")!();
    await expect(search).toBeVisible();
    await shell.cli("browser", "settings", "--search-engine", "duckduckgo");
    await address.press("ArrowDown");
    await address.press("ArrowDown");
    await address.press("Enter");
    await expect
      .poll(() =>
        requests.some((value) => {
          const url = new URL(value, origin);
          return (
            url.pathname === "/fixture-engine-result" &&
            url.searchParams.get("q") === literal
          );
        }),
      )
      .toBe(true);
    await address.fill("find garden");
    await shell.page.waitForTimeout(380);
    expect(requestsSeen).toHaveLength(4);
  } finally {
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});

test("Browser page zoom follows its site and keeps the surrounding workspace unchanged", async ({}, info) => {
  const workspace = await shell.create("Page zoom fixture");
  const sameSite = await open(workspace, "/zoom-same-site");
  await remote("/zoom-same-site", "window.identity");
  const otherOrigin = origin.replace("127.0.0.1", "localhost");
  const otherSite = await shell.cli<BrowserRecord>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    otherOrigin + "/zoom-other-site",
  );
  await remote("/zoom-other-site", "window.identity", otherOrigin);
  const browser = await open(workspace, "/zoom-current");
  await remote("/zoom-current", "window.identity");

  const zoom = (url: string) =>
    shell.app!.evaluate(
      ({ webContents }, target) =>
        webContents
          .getAllWebContents()
          .find((item) => item.getURL() === target)
          ?.getZoomFactor(),
      url,
    );
  const nativeFocus = () =>
    shell.app!.evaluate(
      ({ webContents }, target) =>
        Boolean(
          webContents
            .getAllWebContents()
            .find((item) => item.getURL() === target)
            ?.isFocused(),
        ),
      origin + "/zoom-current",
    );
  const pane = () => shell.pane(browser.paneId);
  const address = () =>
    pane().getByRole("combobox", { name: "Address", exact: true });
  const notice = () => pane().locator('output[aria-label="Page zoom"]');
  await expect(notice()).toBeHidden();
  const chat = shell.page.getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  await expect(chat).toBeVisible();
  const appSettings = await shell.cli("settings", "get");
  const shellFont = await chat.evaluate(
    (element) => getComputedStyle(element).fontSize,
  );
  const currentRatio = (await remote(
    "/zoom-current",
    "window.devicePixelRatio",
  )) as number;
  await shell.page.screenshot({ path: info.outputPath("zoom-default.png") });
  await expect(notice()).toHaveCount(1);

  await pageKey("/zoom-current", "=", [
    process.platform === "darwin" ? "meta" : "control",
  ]);
  await expect(notice()).toHaveText("110%");
  await shell.page.screenshot({
    path: info.outputPath("zoom-adjusted-native.png"),
  });
  await expect.poll(nativeFocus).toBe(true);
  await expect.poll(() => zoom(origin + "/zoom-current")).toBeCloseTo(1.1);
  await expect.poll(() => zoom(origin + "/zoom-same-site")).toBeCloseTo(1.1);
  expect(await zoom(otherOrigin + "/zoom-other-site")).toBeCloseTo(1);
  await expect
    .poll(
      async () =>
        Number(await remote("/zoom-current", "window.devicePixelRatio")) /
        currentRatio,
    )
    .toBeCloseTo(1.1);
  expect(
    await chat.evaluate((element) => getComputedStyle(element).fontSize),
  ).toBe(shellFont);
  expect(await shell.cli("settings", "get")).toEqual(appSettings);

  await expect(notice()).toBeHidden();

  await address().fill("keep this address draft");
  await address().press(`${modifier}+Minus`);
  await expect(notice()).toHaveText("100%");
  await expect(address()).toHaveValue("keep this address draft");
  await expect(address()).toBeFocused();
  await address().press(`${modifier}+Shift+Equal`);
  await expect(notice()).toHaveText("110%");
  await shell.page.screenshot({
    path: info.outputPath("zoom-adjusted-address.png"),
  });

  await address().press(`${modifier}+Shift+P`);
  await shell.page
    .getByRole("button", { name: "Zoom browser page in", exact: true })
    .click();
  await expect(notice()).toHaveText("125%");
  await expect.poll(() => zoom(origin + "/zoom-same-site")).toBeCloseTo(1.25);

  await shell.stop();
  await shell.start();
  await remote("/zoom-current", "window.identity");
  await expect.poll(() => zoom(origin + "/zoom-current")).toBeCloseTo(1.25);
  await shell.cli(
    "pane",
    "focus",
    "--workspace",
    workspace,
    "--id",
    sameSite.paneId,
  );
  await remote("/zoom-same-site", "window.identity");
  expect(await zoom(origin + "/zoom-same-site")).toBeCloseTo(1.25);
  await shell.cli(
    "pane",
    "focus",
    "--workspace",
    workspace,
    "--id",
    otherSite.paneId,
  );
  await remote("/zoom-other-site", "window.identity", otherOrigin);
  expect(await zoom(otherOrigin + "/zoom-other-site")).toBeCloseTo(1);
  await shell.cli(
    "pane",
    "focus",
    "--workspace",
    workspace,
    "--id",
    browser.paneId,
  );
  await address().press(`${modifier}+0`);
  await expect(notice()).toHaveText("100%");
  await expect.poll(() => zoom(origin + "/zoom-same-site")).toBeCloseTo(1);
  expect(await shell.cli("settings", "get")).toEqual(appSettings);
  expect(
    await shell.cli("browser", "zoom", "--id", sameSite.id, "--action", "out"),
  ).toEqual({ zoomPercent: 90 });
  await expect.poll(() => zoom(origin + "/zoom-current")).toBeCloseTo(0.9);
  expect(await zoom(otherOrigin + "/zoom-other-site")).toBeCloseTo(1);
  expect((await inspect(otherSite.id)).url).toBe(
    otherOrigin + "/zoom-other-site",
  );
});
