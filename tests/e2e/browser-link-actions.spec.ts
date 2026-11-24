import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ChatApp } from "./helpers/chat-fixture/harness";
import { modifier } from "./helpers/workspace-app";
import { orderedGroups } from "../../src/workspace-layout";
import type { AppState } from "../../src/types";
const execute = promisify(execFile);
let app: ChatApp, server: Server, origin: string, workspace: string;
test.beforeEach(async () => {
  server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    const send = () =>
      response.end(
        '<title>Invented link page</title><h1>Link actions</h1><div id="neutral" style="position:fixed;top:4px;left:4px;width:12px;height:12px;cursor:default"></div><a id="target" href="/destination?q=one%26two#part">Destination</a><input id="field" value="Retain this form"><select id="choice"><option>First</option><option>Second</option></select><a id="unsafe" href="javascript:void(0)">Unsupported link</a><script>window.identity=crypto.randomUUID()</script>',
      );
    if (_request.url === "/slow") setTimeout(send, 2000);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Fixture server absent");
  origin = `http://127.0.0.1:${address.port}`;
  app = new ChatApp();
  await app.prepare();
  await app.configure({ codex: {} });
  await app.start();
  workspace = await app.create("Link actions");
  await app.app!.evaluate(
    ({ shell, app: electron, Menu, dialog, clipboard }) => {
      clipboard.writeText("Invented clipboard");
      Object.assign(globalThis, {
        externalUrls: [],
        defaultHandler: false,
        externalFailure: false,
        pageActionErrors: [],
        nativeMenu: {
          labels: [],
          enabled: [],
          shown: false,
          closed: true,
          clicked: [],
        },
        nativePopupDelay: 0,
      });
      shell.openExternal = async (url) => {
        (globalThis as any).externalUrls.push(url);
        if ((globalThis as any).externalFailure)
          throw Error("Invented platform handoff failure");
      };
      electron.isDefaultProtocolClient = () =>
        Boolean((globalThis as any).defaultHandler);
      Object.assign(dialog, {
        showMessageBox: async (
          _window: unknown,
          options: { detail: string },
        ) => {
          (globalThis as any).pageActionErrors.push(options.detail);
          return { response: 0, checkboxChecked: false };
        },
      });
      const popup = Menu.prototype.popup;
      Menu.prototype.popup = function (options) {
        const state = {
          labels: this.items.map((i) => i.label),
          enabled: this.items
            .filter((i) => i.type !== "separator" && i.enabled)
            .map((i) => i.label),
          shown: false,
          closing: false,
          closed: false,
          clicked: [] as string[],
        };
        Object.assign(globalThis, { nativeMenu: state });
        this.once("menu-will-show", () => {
          state.shown = true;
        });
        this.once("menu-will-close", () => {
          state.closing = true;
        });
        for (const item of this.items) {
          const click = item.click;
          item.click = (...args: unknown[]) => {
            state.clicked.push(item.label);
            return click.apply(item, args);
          };
        }
        // The native request can precede presentation. The controlled fixture
        // exercises that gap while the zero-delay path keeps the real call intact.
        const show = () =>
          popup.call(this, {
            ...options,
            callback: () => {
              try {
                options?.callback?.();
              } finally {
                state.closed = true;
              }
            },
          });
        const delay = (globalThis as any).nativePopupDelay;
        if (delay > 0) setTimeout(show, delay);
        else show();
      };
    },
  );
});
test.afterEach(async ({}, info) => {
  if (app?.app && info.status !== info.expectedStatus) {
    try {
      console.error(
        "Native context input state",
        JSON.stringify(
          await app.app.evaluate(({ BrowserWindow }) => ({
            menu: (globalThis as any).nativeMenu,
            request: (globalThis as any).nativeContextSerial,
            pointer: (globalThis as any).nativePointerProof,
            kind: (globalThis as any).nativeContextKind,
            windows: BrowserWindow.getAllWindows().map((w) => ({
              focused: w.isFocused(),
              visible: w.isVisible(),
            })),
          })),
        ),
      );
    } catch {
      console.error("Native context input state unavailable");
    }
  }
  await app?.cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const handoffs = () =>
  app.app!.evaluate(() => (globalThis as any).externalUrls as string[]);
const browserRecords = async () => (await app.cli<AppState>("state")).browsers;
async function openBrowser() {
  const record = await app.cli<{ id: string; paneId: string }>(
    "browser",
    "open",
    "--workspace",
    workspace,
    "--url",
    origin + "/source",
  );
  await expect
    .poll(() =>
      app.app!.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .some((c) => c.getURL() === url && !c.isLoadingMainFrame()),
        origin + "/source",
      ),
    )
    .toBe(true);
  await expect(app.pane(record.paneId)).toBeVisible();
  return record;
}
async function pageValue(source: string, url = origin + "/source") {
  return app.app!.evaluate(
    ({ webContents }, { source, url }) =>
      webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)!
        .executeJavaScript(source),
    { source, url },
  );
}
async function nativeContext(
  selector: string,
  keyboard = false,
  url = origin + "/source",
) {
  await expect
    .poll(
      () =>
        app.app!.evaluate(({ BrowserWindow, webContents }, url) => {
          const contents = webContents
            .getAllWebContents()
            .find((c) => c.getURL() === url);
          const view = BrowserWindow.getAllWindows()
            .flatMap((w) => w.contentView.children)
            .find((v) => (v as any).webContents?.id === contents?.id);
          return (
            !!view?.getVisible() &&
            view.getBounds().width > 0 &&
            view.getBounds().height > 0
          );
        }, url),
      { message: "Native page has an actual visible viewport" },
    )
    .toBe(true);
  const point = await app.app!.evaluate(
    async (
      { webContents, BrowserWindow, screen },
      { url, selector, keyboard },
    ) => {
      const contents = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)!;
      const window = BrowserWindow.getAllWindows().find((w) =>
        w.contentView.children.some(
          (v) => (v as any).webContents?.id === contents.id,
        ),
      )!;
      const view = window.contentView.children.find(
        (v) => (v as any).webContents?.id === contents.id,
      )!;
      const local = await contents.executeJavaScript(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});${keyboard ? "e.focus();" : ""}const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
      );
      const viewport = view.getBounds(),
        desktop = window.getContentBounds();
      const point = {
        x: desktop.x + viewport.x + local.x,
        y: desktop.y + viewport.y + local.y,
      };
      const serial = ((globalThis as any).nativeContextSerial ?? 0) + 1;
      contents.once("context-menu", (_event, params) =>
        Object.assign(globalThis, {
          nativeContextSerial: serial,
          nativeLinkURL: params.linkURL,
          nativeContextKind: params.menuSourceType,
          nativePointerProof: {
            expected: point,
            actual: screen.getCursorScreenPoint(),
          },
        }),
      );
      window.focus();
      contents.focus();
      if (keyboard) {
        contents.sendInputEvent({
          type: "keyDown",
          keyCode: "F10",
          modifiers: ["shift"],
        });
        contents.sendInputEvent({
          type: "keyUp",
          keyCode: "F10",
          modifiers: ["shift"],
        });
      }
      return { ...point, serial };
    },
    { url, selector, keyboard },
  );
  // Keep the established native-key entry. Mouse input and native popup
  // selection share OS input so the real pointer reaches the popup's source.
  if (!keyboard)
    await execute("xdotool", [
      "mousemove",
      "--sync",
      String(point.x),
      String(point.y),
      "click",
      "--clearmodifiers",
      "3",
    ]);
  await expect
    .poll(
      () => app.app!.evaluate(() => (globalThis as any).nativeContextSerial),
      { message: "The native page received the OS context action" },
    )
    .toBe(point.serial);
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).nativeMenu.shown), {
      message: "Native context menu reached menu-will-show",
    })
    .toBe(true);
  if (!keyboard) {
    const pointer = await app.app!.evaluate(
      () => (globalThis as any).nativePointerProof,
    );
    expect(pointer.actual).toEqual(pointer.expected);
  }
}
async function chooseNative(label: string) {
  const enabled = await app.app!.evaluate(
    () => (globalThis as any).nativeMenu.enabled as string[],
  );
  expect(enabled).toContain(label);
  await execute("xdotool", [
    "key",
    "--delay",
    "80",
    "--clearmodifiers",
    "Home",
    ...Array(enabled.indexOf(label)).fill("Down"),
    "Return",
  ]);
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).nativeMenu.closed))
    .toBe(true);
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).nativeMenu.clicked))
    .toEqual([label]);
}
async function command(label: string) {
  await app.page.keyboard.press(`${modifier}+Shift+p`);
  const dialog = app.page.getByRole("dialog", { name: "Command palette" });
  await dialog.getByRole("textbox").fill(label);
  await dialog.getByRole("button", { name: label, exact: true }).click();
}

test("Native right-click opens an independent background tab in the source group and restart retains both", async () => {
  const source = await openBrowser();
  await app.cli(
    "pane",
    "pin",
    "--workspace",
    workspace,
    "--id",
    source.paneId,
    "--pinned",
    "true",
  );
  const identity = await pageValue("window.identity");
  await nativeContext("#target");
  await chooseNative("Open link in new tab");
  await expect.poll(async () => (await browserRecords()).length).toBe(2);
  const target = (await browserRecords()).find((b) => b.id !== source.id)!;
  expect(target.url).toBe(origin + "/destination?q=one%26two#part");
  const state = (await app.cli<AppState>("state")).workspaces.find(
    (w) => w.id === workspace,
  )!;
  const group = state.groups!.find((g) => g.paneIds.includes(source.paneId))!;
  expect(group.paneIds).toContain(target.paneId);
  expect(state.activePaneId).toBe(source.paneId);
  await expect
    .poll(() =>
      app.app!.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .some((c) => c.getURL() === url && c.isFocused()),
        origin + "/source",
      ),
    )
    .toBe(true);
  expect(
    await pageValue("[window.identity,document.querySelector('#field').value]"),
  ).toEqual([identity, "Retain this form"]);
  await expect
    .poll(() =>
      app.app!.evaluate(
        ({ webContents }, url) =>
          webContents.getAllWebContents().some((c) => c.getURL() === url),
        target.url,
      ),
    )
    .toBe(true);
  expect(
    await pageValue(
      "[window.opener,typeof window.cod,typeof require]",
      target.url,
    ),
  ).toEqual([null, "undefined", "undefined"]);
  await nativeContext("#target");
  await chooseNative("Open link in new tab");
  await expect.poll(async () => (await browserRecords()).length).toBe(3);
  const last = (await browserRecords()).find(
    (b) => b.id !== source.id && b.id !== target.id,
  )!;
  expect(
    (await app.workspace(workspace)).groups.find(
      (item) => item.id === group.id,
    )!.paneIds,
  ).toEqual([...group.paneIds, last.paneId]);
  await app.stop();
  await app.start();
  expect((await browserRecords()).map((b) => b.url)).toEqual(
    expect.arrayContaining([origin + "/source", target.url]),
  );
  expect(
    (await app.cli<AppState>("state")).workspaces.find(
      (w) => w.id === workspace,
    )!.activePaneId,
  ).toBe(source.paneId);
});

test("Native keyboard context handoff and current-page Commands use the exact validated URL once", async () => {
  const source = await openBrowser();
  await nativeContext("#target", true);
  await chooseNative("Open link in system browser");
  await expect
    .poll(() => handoffs())
    .toEqual([origin + "/destination?q=one%26two#part"]);
  expect(await browserRecords()).toHaveLength(1);
  await app
    .pane(source.paneId)
    .getByRole("combobox", { name: "Address", exact: true })
    .focus();
  await command("Open in system browser");
  await expect
    .poll(() => handoffs())
    .toEqual([origin + "/destination?q=one%26two#part", origin + "/source"]);
  const result = await app.cli(
    "browser",
    "open-external",
    "--url",
    origin + "/cli?q=retained#fragment",
  );
  expect(result).toEqual({ url: origin + "/cli?q=retained#fragment" });
  expect(await browserRecords()).toHaveLength(1);
  for (const url of [
    "javascript:alert(1)",
    "file:///tmp/not-a-web-link",
    "mailto:fixture@example.org",
  ])
    expect(
      (await app.raw("browser", "open-external", "--url", url)).code,
    ).not.toBe(0);
  await app.app!.evaluate(() =>
    Object.assign(globalThis, { defaultHandler: true }),
  );
  expect(
    (await app.raw("browser", "open-external", "--url", origin + "/loop"))
      .stderr,
  ).toContain("default browser");
  expect(await handoffs()).toHaveLength(3);
  expect(await browserRecords()).toHaveLength(1);
  await app.app!.evaluate(() =>
    Object.assign(globalThis, { defaultHandler: false, externalFailure: true }),
  );
  await nativeContext("#target", true);
  await chooseNative("Open link in system browser");
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).pageActionErrors))
    .toEqual(["Invented platform handoff failure"]);
  expect(await browserRecords()).toHaveLength(1);
  expect(await pageValue("document.querySelector('#field').value")).toBe(
    "Retain this form",
  );
});

async function makeCertificate(
  name: string,
  hostname: string,
  san: string,
  expired = false,
) {
  const keyPath = path.join(app.data, `${name}-key.pem`);
  const certPath = path.join(app.data, `${name}-cert.pem`);
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    `/CN=${hostname}`,
    "-addext",
    `subjectAltName=${san}`,
  ]);
  if (!expired)
    return { key: await readFile(keyPath), cert: await readFile(certPath) };
  const { stdout } = await execute("openssl", [
    "x509",
    "-signkey",
    keyPath,
    "-days",
    "-1",
    "-in",
    certPath,
  ]);
  return { key: await readFile(keyPath), cert: stdout };
}

test("Untrusted HTTPS domain explains the certificate error and offers an explicit handoff", async ({}, info) => {
  let pageRequests = 0;
  let cleartextRequests = 0;
  const tls = createHttpsServer(
    await makeCertificate("untrusted", "localhost", "DNS:localhost"),
    (_request, response) => {
      pageRequests++;
      response.end("Invented untrusted page");
    },
  );
  tls.on("tlsClientError", (error) => {
    if ((error as NodeJS.ErrnoException).code === "ERR_SSL_HTTP_REQUEST")
      cleartextRequests++;
  });
  await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
  try {
    const tlsAddress = tls.address();
    if (!tlsAddress || typeof tlsAddress === "string")
      throw Error("TLS fixture unavailable");
    const destination = `https://localhost:${tlsAddress.port}/fixture?state=invented#test`;
    const record = await openBrowser();
    await app.app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
    );
    const pane = app.pane(record.paneId);
    const address = pane.getByRole("combobox", {
      name: "Address",
      exact: true,
    });
    const failure = pane.locator(".browser-failure");
    const handoff = failure.getByRole("button", {
      name: "Open in system browser",
    });
    const retry = failure.getByRole("button", { name: "Reload page" });
    await address.fill(destination);
    await address.press("Enter");
    await expect(failure).toBeVisible();
    await expect
      .poll(
        async () =>
          (await browserRecords()).find(({ id }) => id === record.id)?.error,
      )
      .toContain("ERR_CERT_AUTHORITY_INVALID");
    await app.page.screenshot({
      path: info.outputPath("untrusted-https-page.png"),
    });
    await expect(
      failure.getByRole("heading", { name: "Certificate not trusted" }),
    ).toBeVisible();
    await expect(failure).toContainText("certificate issuer");
    await expect(failure.locator("code")).toHaveText(
      `https://localhost:${tlsAddress.port}/fixture`,
    );
    await expect(
      failure.getByRole("button", { name: "Open over HTTP" }),
    ).toHaveCount(0);
    await expect(retry).toBeVisible();
    expect(await handoffs()).toEqual([]);
    await retry.focus();
    await retry.press("Enter");
    await expect(
      failure.getByRole("heading", { name: "Certificate not trusted" }),
    ).toBeVisible();
    expect(await handoffs()).toEqual([]);
    expect(pageRequests).toBe(0);
    expect(cleartextRequests).toBe(0);
    await handoff.focus();
    await expect(handoff).toBeFocused();
    await app.page.screenshot({
      path: info.outputPath("untrusted-https-handoff-focus.png"),
    });
    await handoff.press("Enter");
    await expect.poll(() => handoffs()).toEqual([destination]);
    await expect(failure).toBeVisible();
    expect(pageRequests).toBe(0);
    expect(cleartextRequests).toBe(0);
    await failure
      .getByRole("button", { name: "Return to previous page" })
      .click();
    await expect(failure).toBeHidden();
    await expect
      .poll(
        async () =>
          (await browserRecords()).find(({ id }) => id === record.id)?.url,
      )
      .toBe(origin + "/source");
    expect(await handoffs()).toEqual([destination]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      tls.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("Untrusted local HTTPS opens only an isolated temporary Cod tab", async ({}, info) => {
  const originalCert = await makeCertificate(
    "local-one",
    "127.0.0.1",
    "IP:127.0.0.1",
  );
  let visits = 0;
  let foreignRequests = 0;
  const receivedCookies: string[] = [];
  server.on("request", (request) => {
    if (request.url === "/isolated-escape") foreignRequests++;
  });
  const tls = createHttpsServer(originalCert, (request, response) => {
    response.setHeader("Connection", "close");
    if (request.url === "/fixture") {
      visits++;
      receivedCookies.push(request.headers.cookie ?? "");
    }
    response.setHeader("Content-Type", "text/html");
    response.setHeader("Set-Cookie", "temporary=yes; Secure");
    response.end(
      `<title>Invented local HTTPS</title><h1>Invented local HTTPS</h1><a href="${origin}/isolated-escape">Another origin</a>`,
    );
  });
  await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
  try {
    const tlsAddress = tls.address();
    if (!tlsAddress || typeof tlsAddress === "string")
      throw Error("TLS fixture unavailable");
    const target = `https://127.0.0.1:${tlsAddress.port}/fixture`;
    const record = await openBrowser();
    await app.app!.evaluate(async ({ BrowserWindow, session }, url) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1000, 680);
      await session
        .fromPartition("persist:cod-browser")
        .cookies.set({ url, name: "regular", value: "invented", secure: true });
    }, target);
    const pane = app.pane(record.paneId);
    const address = pane.getByRole("combobox", {
      name: "Address",
      exact: true,
    });
    const failure = pane.locator(".browser-failure");
    const proceed = failure.getByRole("button", {
      name: "Open in temporary tab",
    });
    await address.fill(target);
    await address.press("Enter");
    await expect(failure).toBeVisible();
    await app.page.screenshot({
      path: info.outputPath("local-certificate-warning.png"),
    });
    await expect(proceed).toBeVisible();
    await expect(
      failure.getByRole("button", { name: "Open in system browser" }),
    ).toHaveCount(0);
    expect(visits).toBe(0);
    expect(await handoffs()).toEqual([]);
    await proceed.focus();
    await expect(proceed).toBeFocused();
    await app.page.screenshot({
      path: info.outputPath("local-certificate-warning-focus.png"),
    });
    await proceed.press("Enter");
    await expect.poll(() => visits).toBe(1);
    expect(receivedCookies).toEqual([""]);
    const temporary = (await browserRecords()).find(
      (item) => item.temporaryCertificate,
    )!;
    const temporaryPane = app.pane(temporary.paneId);
    await expect(
      temporaryPane.getByText("Certificate not verified", { exact: true }),
    ).toBeVisible();
    await expect(temporaryPane.locator(".browser-content")).toBeVisible();
    const nativePage = await app.app!.evaluate(
      async ({ desktopCapturer, screen, webContents }, id) => {
        const contents = webContents.fromId(id)!;
        await contents.executeJavaScript(
          "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        const [source] = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: screen.getPrimaryDisplay().size,
        });
        return source.thumbnail.toPNG().toString("base64");
      },
      temporary.nativeTabId!,
    );
    await writeFile(
      info.outputPath("local-certificate-active.png"),
      Buffer.from(nativePage, "base64"),
    );
    expect(await handoffs()).toEqual([]);
    await app.app!.evaluate(
      async ({ session, webContents }, { id, url, foreign }) => {
        const contents = webContents.fromId(id)!;
        const shared = session.fromPartition("persist:cod-browser");
        const prefs = (
          contents as Electron.WebContents & {
            getLastWebPreferences(): Electron.WebPreferences;
          }
        ).getLastWebPreferences();
        if (
          contents.session === shared ||
          !prefs.sandbox ||
          !prefs.contextIsolation ||
          prefs.nodeIntegration ||
          prefs.preload
        )
          throw Error("Temporary tab isolation unavailable");
        await contents.executeJavaScript(
          `fetch(${JSON.stringify(foreign)}).catch(() => undefined)`,
        );
        const cookies = await shared.cookies.get({ url });
        if (cookies.some(({ name }) => name === "temporary"))
          throw Error("Temporary cookie escaped");
      },
      {
        id: temporary.nativeTabId!,
        url: target,
        foreign: origin + "/isolated-escape",
      },
    );
    expect(foreignRequests).toBe(0);
    await app.app!.evaluate(({ webContents }, id) => {
      return webContents
        .fromId(id)!
        .executeJavaScript("document.querySelector('a').click()");
    }, temporary.nativeTabId!);
    await expect(
      temporaryPane
        .getByRole("status")
        .filter({ hasText: "Open a regular tab" }),
    ).toBeVisible();
    expect(foreignRequests).toBe(0);
    await app.cli("browser", "reload", "--id", temporary.id);
    await expect.poll(() => visits).toBe(2);
    expect(receivedCookies[1]).toContain("temporary=yes");

    const ordinary = await openBrowser();
    const ordinaryPane = app.pane(ordinary.paneId);
    const ordinaryAddress = ordinaryPane.getByRole("combobox", {
      name: "Address",
      exact: true,
    });
    await ordinaryAddress.fill(target);
    await ordinaryAddress.press("Enter");
    await expect(
      ordinaryPane.getByRole("button", { name: "Open in temporary tab" }),
    ).toBeVisible();
    expect(visits).toBe(2);

    tls.setSecureContext(
      await makeCertificate("local-two", "127.0.0.1", "IP:127.0.0.1"),
    );
    await app.cli("browser", "reload", "--id", temporary.id);
    await expect
      .poll(
        async () =>
          (await browserRecords()).find(({ id }) => id === temporary.id)?.error,
      )
      .toContain("ERR_CERT_AUTHORITY_INVALID");
    expect(visits).toBe(2);
    await app.cli("browser", "close", "--id", temporary.id);
    expect((await browserRecords()).some(({ id }) => id === temporary.id)).toBe(
      false,
    );
    const currentOffer = async () =>
      (await browserRecords()).find(({ id }) => id === ordinary.id)
        ?.certificateOffer;
    const firstOffer = await currentOffer();
    await app.cli("browser", "reload", "--id", ordinary.id);
    const nextOffer = ordinaryPane.getByRole("button", {
      name: "Open in temporary tab",
    });
    // Native state may have the replacement token before the next UI batch.
    await expect
      .poll(async () => {
        const token = await nextOffer.getAttribute("data-offer");
        return Boolean(
          token && token !== firstOffer && token === (await currentOffer()),
        );
      })
      .toBe(true);
    await nextOffer.click();
    await expect.poll(() => visits).toBe(3);
    expect(receivedCookies[2]).toBe("");
    const activeTemporary = (await browserRecords()).find(
      ({ temporaryCertificate }) => temporaryCertificate,
    )!;
    await app.stop();
    await app.start();
    expect(
      (await browserRecords()).find(({ id }) => id === activeTemporary.id)
        ?.temporaryCertificate,
    ).toBeUndefined();
    await app.cli("browser", "reload", "--id", activeTemporary.id);
    await expect(
      app
        .pane(activeTemporary.paneId)
        .getByRole("heading", { name: "Certificate not trusted" }),
    ).toBeVisible();
    expect(visits).toBe(3);

    const ineligible = [
      await makeCertificate("local-mismatch", "127.0.0.2", "IP:127.0.0.2"),
      await makeCertificate("local-expired", "127.0.0.1", "IP:127.0.0.1", true),
    ];
    for (const certificate of ineligible) {
      tls.setSecureContext(certificate);
      await app.cli("browser", "reload", "--id", activeTemporary.id);
      await expect
        .poll(
          async () =>
            (await browserRecords()).find(({ id }) => id === activeTemporary.id)
              ?.error,
        )
        .toContain("ERR_CERT_");
      await expect(
        app
          .pane(activeTemporary.paneId)
          .getByRole("button", { name: "Open in temporary tab" }),
      ).toBeHidden();
      expect(visits).toBe(3);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      tls.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("Native keyboard handoff waits for deferred popup presentation before selecting the requested action", async () => {
  await openBrowser();
  for (const delay of [40, 120]) {
    await app.app!.evaluate((_electron, delay) => {
      Object.assign(globalThis, { nativePopupDelay: delay, externalUrls: [] });
    }, delay);
    await nativeContext("#target", true);
    await chooseNative("Open link in system browser");
    await expect
      .poll(handoffs)
      .toEqual([origin + "/destination?q=one%26two#part"]);
    expect(await browserRecords()).toHaveLength(1);
    expect(await pageValue("document.querySelector('#field').value")).toBe(
      "Retain this form",
    );
  }
});

test("Native mouse context input moves the physical pointer to its target before OS keyboard selection", async () => {
  await openBrowser();
  await execute("xdotool", ["mousemove", "--sync", "1", "1"]);
  await nativeContext("#target");
  await chooseNative("Open link in system browser");
  await expect
    .poll(handoffs)
    .toEqual([origin + "/destination?q=one%26two#part"]);
  expect(await browserRecords()).toHaveLength(1);
});

test("Native editable menus retain clipboard/select/selection focus, reject unsafe links and close with the owner", async () => {
  const source = await openBrowser();
  await pageValue(
    "(()=>{const e=document.querySelector('#field');e.focus();e.setSelectionRange(2,6)})()",
  );
  await nativeContext("#field", true);
  const enabled = await app.app!.evaluate(
    () => (globalThis as any).nativeMenu.enabled as string[],
  );
  expect(enabled).toEqual(
    expect.arrayContaining(["Cut", "Copy", "Paste", "Select all"]),
  );
  await execute("xdotool", ["key", "--clearmodifiers", "Escape"]);
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).nativeMenu.closed))
    .toBe(true);
  expect(
    await pageValue(
      "(()=>{const e=document.querySelector('#field');return[e.value,e.selectionStart,e.selectionEnd,document.activeElement===e,document.querySelector('select').value]})()",
    ),
  ).toEqual(["Retain this form", 2, 6, true, "First"]);
  const points = await app.app!.evaluate(
    async ({ BrowserWindow, webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url)!;
      Object.assign(globalThis, { pageCursors: [] });
      contents.on("cursor-changed", (_event, type) =>
        (globalThis as any).pageCursors.push(type),
      );
      const window = BrowserWindow.getAllWindows()[0];
      const view = window.contentView.children.find(
        (v) => (v as any).webContents?.id === contents.id,
      )!;
      const bounds = view.getBounds(),
        content = window.getContentBounds();
      const relative = await contents.executeJavaScript(
        "['#target','#field','#choice','#neutral'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})",
      );
      return relative.map((p: { x: number; y: number }) => ({
        x: content.x + bounds.x + p.x,
        y: content.y + bounds.y + p.y,
      }));
    },
    origin + "/source",
  );
  await pageValue(
    "window.nativeMouseTarget='';document.addEventListener('mousemove',e=>window.nativeMouseTarget=e.target.id||e.target.tagName);void 0",
  );
  // Establish a different hover target before observing cursor-changed. The
  // pointer may already be over the link after an earlier native interaction.
  await execute("xdotool", [
    "mousemove",
    "--sync",
    String(points[3].x),
    String(points[3].y),
  ]);
  await expect
    .poll(() => pageValue("window.nativeMouseTarget"))
    .toBe("neutral");
  await execute("xdotool", [
    "mousemove",
    "--sync",
    String(points[0].x),
    String(points[0].y),
  ]);
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).pageCursors))
    .toContain("hand");
  await execute("xdotool", [
    "mousemove",
    "--sync",
    String(points[1].x),
    String(points[1].y),
  ]);
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).pageCursors))
    .toContain("text");
  await execute("xdotool", [
    "mousemove",
    "--sync",
    String(points[2].x),
    String(points[2].y),
    "click",
    "1",
  ]);
  await execute("xdotool", ["key", "--clearmodifiers", "Down", "Return"]);
  await expect
    .poll(() => pageValue("document.querySelector('select').value"))
    .toBe("Second");
  await nativeContext("#unsafe");
  const labels = await app.app!.evaluate(
    () => (globalThis as any).nativeMenu.labels as string[],
  );
  expect(labels).not.toContain("Open link in new tab");
  expect(labels).not.toContain("Open link in system browser");
  await chooseNative("Copy link address");
  expect(await app.app!.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    await app.app!.evaluate(() => (globalThis as any).nativeLinkURL),
  );
  expect(
    (
      await app.raw(
        "browser",
        "open-link",
        "--id",
        source.id,
        "--url",
        "file:///tmp/private",
      )
    ).code,
  ).not.toBe(0);
  await nativeContext("#target");
  await app.cli(
    "pane",
    "close",
    "--workspace",
    workspace,
    "--id",
    source.paneId,
  );
  await expect
    .poll(() => app.app!.evaluate(() => (globalThis as any).nativeMenu.closed))
    .toBe(true);
});

test("Chat link menus preserve a cancelled composer draft and explicit handoff never creates a Cod tab", async () => {
  const chat = await app.newChat(workspace, "codex");
  await app.send(
    chat.id,
    `[Fixture link](${origin}/from-chat?q=one%26two#part) [Slow link](${origin}/slow)`,
  );
  await expect
    .poll(async () => (await app.inspect(chat.id)).status)
    .toBe("ready");
  const link = app
    .pane(chat.paneId)
    .getByRole("link", { name: "Fixture link", exact: true })
    .last();
  await expect(link).toBeVisible();
  const composer = app
    .pane(chat.paneId)
    .getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Retain this unsent draft");
  await link.focus();
  await link.press("Shift+F10");
  await expect(
    app.page.getByRole("dialog", { name: "Actions", exact: true }),
  ).toBeVisible();
  await app.page.keyboard.press("Escape");
  await expect(link).toBeFocused();
  await expect(composer).toHaveValue("Retain this unsent draft");
  await link.click({ button: "right" });
  await app.page
    .getByRole("dialog", { name: "Actions", exact: true })
    .getByRole("button", { name: "Open in system browser", exact: true })
    .click();
  await expect
    .poll(() => handoffs())
    .toEqual([origin + "/from-chat?q=one%26two#part"]);
  expect(await browserRecords()).toHaveLength(0);
  await link.focus();
  await command("Open link");
  await expect.poll(async () => (await browserRecords()).length).toBe(1);
  expect((await browserRecords())[0].workspaceId).toBe(workspace);
  expect((await browserRecords())[0].url).toBe(
    origin + "/from-chat?q=one%26two#part",
  );
  const first = (await browserRecords())[0];
  await expect
    .poll(async () => (await app.workspace(workspace)).activePaneId)
    .toBe(first.paneId);
  const [left, right] = orderedGroups(await app.workspace(workspace));
  expect(left.activePaneId).toBe(chat.paneId);
  expect(right.activePaneId).toBe(first.paneId);

  // A second link starts opening beside the chat. Newer chat focus wins
  // even when the navigation result arrives later.
  await app
    .pane(chat.paneId)
    .getByRole("link", { name: "Slow link", exact: true })
    .last()
    .click();
  await composer.click();
  await expect
    .poll(
      async () =>
        (await browserRecords()).find(
          (record) => record.url === origin + "/slow",
        )?.loading,
    )
    .toBe(false);
  await expect(composer).toBeFocused();
  const current = await app.workspace(workspace);
  expect(current.activePaneId).toBe(chat.paneId);
  expect(orderedGroups(current)[1].paneIds).toEqual([
    first.paneId,
    (await browserRecords()).find((record) => record.url === origin + "/slow")!
      .paneId,
  ]);
});

test("Markdown preview and source caret share handoff actions without granting a preview bridge to other frames", async ({}, info) => {
  const file = path.join(app.folders[0], "links.md");
  const url = origin + "/from-file?q=one%26two#part";
  await writeFile(file, `# Links\n\n[Preview link](${url})\n`);
  const opened = await app.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    file,
  );
  const editor = app
    .pane(opened.paneId)
    .getByRole("textbox", { name: "File contents", exact: true });
  await expect(editor).toBeEnabled();
  await editor.evaluate((e: HTMLTextAreaElement) => {
    e.focus();
    const p = e.value.indexOf("?q=");
    e.setSelectionRange(p, p);
  });
  await command("Open in system browser");
  await expect.poll(() => handoffs()).toEqual([url]);
  await editor.focus();
  await editor.press("Shift+F10");
  await expect(
    app.page.getByRole("dialog", { name: "Actions", exact: true }),
  ).toBeVisible();
  await app.page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  const preview = await app.cli<{ paneId: string }>(
    "preview",
    "open",
    "--workspace",
    workspace,
    "--path",
    file,
  );
  const frame = app.pane(preview.paneId).locator("iframe").contentFrame();
  const link = frame.getByRole("link", { name: "Preview link", exact: true });
  await expect(link).toBeVisible();
  await link.focus();
  await link.press("Shift+F10");
  await app.page.keyboard.press("Escape");
  await expect(link).toBeFocused();
  await link.click({ button: "right" });
  await app.page.screenshot({
    path: info.outputPath("preview-link-actions.png"),
  });
  await app.page
    .getByRole("dialog", { name: "Actions", exact: true })
    .getByRole("button", { name: "Open in system browser", exact: true })
    .click();
  await expect.poll(() => handoffs()).toEqual([url, url]);
  expect(await browserRecords()).toHaveLength(0);
  await app.page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.addEventListener("message", () => resolve(), { once: true });
        window.postMessage(
          {
            type: "cod-preview-link-menu",
            href: "https://example.org/spoof",
            x: 0,
            y: 0,
          },
          "*",
        );
      }),
  );
  await expect(
    app.page.getByRole("dialog", { name: "Actions", exact: true }),
  ).toHaveCount(0);
  expect(await handoffs()).toEqual([url, url]);
});

test("Registered form link actions retain the response owner and never copy its bridge to an ordinary tab", async () => {
  const conversation = await app.newChat(workspace, "codex");
  const file = path.join(app.folders[0], "link-form.html");
  await writeFile(
    file,
    `<title>Invented form</title><input id="answer" value="Unsaved answer"><a id="target" href="${origin}/destination">Destination</a>`,
  );
  const form = await app.cli<{ id: string; paneId: string; url: string }>(
    "page",
    "open",
    "--workspace",
    workspace,
    "--conversation",
    conversation.id,
    "--path",
    file,
  );
  const record = await app.cli<{ url: string }>(
    "browser",
    "inspect",
    "--id",
    form.id,
  );
  Object.assign(form, { url: record.url });
  await expect
    .poll(async () => pageValue("typeof codPage.submit", form.url))
    .toBe("function");
  await nativeContext("#target", true, form.url);
  const labels = await app.app!.evaluate(
    () => (globalThis as any).nativeMenu.labels,
  );
  expect(labels).not.toContain("Inspect element");
  await chooseNative("Open link in new tab");
  await expect.poll(async () => (await browserRecords()).length).toBe(2);
  const target = (await browserRecords()).find((b) => b.id !== form.id)!;
  expect(target.agentPage).toBeUndefined();
  expect(
    await pageValue("[typeof codPage,typeof cod,typeof require]", target.url),
  ).toEqual(["undefined", "undefined", "undefined"]);
  expect(
    await pageValue(
      "[document.querySelector('#answer').value,typeof codPage.submit]",
      form.url,
    ),
  ).toEqual(["Unsaved answer", "function"]);
  expect((await app.inspect(conversation.id)).messages).toEqual([]);
  await nativeContext("#target", true, form.url);
  await chooseNative("Open link in system browser");
  expect(
    await app.app!.evaluate(() => (globalThis as any).externalUrls),
  ).toEqual([origin + "/destination"]);
  expect((await browserRecords()).length).toBe(2);
});

test("A background link finishing a slow load does not take focus from newer address editing", async () => {
  await openBrowser();
  await pageValue(
    `document.querySelector('#target').href=${JSON.stringify(origin + "/slow")}`,
  );
  await nativeContext("#target");
  await chooseNative("Open link in new tab");
  await expect.poll(async () => (await browserRecords()).length).toBe(2);
  await app.app!.evaluate(({ webContents }, url) => {
    const contents = webContents
      .getAllWebContents()
      .find((c) => c.getURL() === url)!;
    contents.sendInputEvent({
      type: "keyDown",
      keyCode: "L",
      modifiers: [process.platform === "darwin" ? "meta" : "control"],
    });
    contents.sendInputEvent({
      type: "keyUp",
      keyCode: "L",
      modifiers: [process.platform === "darwin" ? "meta" : "control"],
    });
  }, origin + "/source");
  const address = app.page.getByRole("combobox", { name: "Address" });
  await expect(address).toBeFocused();
  await address.fill("unfinished.example");
  await expect
    .poll(
      async () =>
        (await browserRecords()).find((b) => b.url === origin + "/slow")
          ?.loading,
    )
    .toBe(false);
  await expect(address).toBeFocused();
  await expect(address).toHaveValue("unfinished.example");
});
