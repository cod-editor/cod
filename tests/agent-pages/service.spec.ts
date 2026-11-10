import {
  test,
  expect,
  _electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
let app: ElectronApplication,
  temporary: string,
  directory: string,
  server: Server,
  remote: string;
async function call(method: string, ...args: unknown[]) {
  return app.evaluate(
    async (_electron, { method, args }) =>
      (globalThis as any).agentFixture.service[method](...args),
    { method, args },
  );
}
async function js(id: string, source: string) {
  return app.evaluate(
    async (_electron, { id, source }) =>
      (globalThis as any).agentFixture.service
        .getWebContents(id)
        .executeJavaScript(source),
    { id, source },
  );
}
const open = (id = "one", conversationId = "conversation-one") =>
  call("open", {
    id,
    workspaceId: "workspace-one",
    conversationId,
    path: path.join(directory, "index.html"),
  });
test.beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "cod-agent-page-"));
  directory = path.join(temporary, "artifact");
  await mkdir(directory);
  await writeFile(path.join(directory, "asset.js"), "window.ASSET_LOADED=true");
  await writeFile(
    path.join(temporary, "private.txt"),
    "PRIVATE_OUTSIDE_SENTINEL",
  );
  await symlink(
    path.join(temporary, "private.txt"),
    path.join(directory, "escape.txt"),
  );
  await writeFile(
    path.join(directory, "index.html"),
    `<!doctype html><title>Invented agent form</title><script src="asset.js"></script><form><label>Answer<input name="answer"></label><button>Submit</button></form><output></output><script>window.onmessage=e=>window.childReport=e.data</script><iframe src="child.html"></iframe><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const answer=document.querySelector('input').value;document.querySelector('output').textContent=JSON.stringify(await codPage.submit({answer}));};</script>`,
  );
  await writeFile(
    path.join(directory, "child.html"),
    '<title>Nested fixture</title><script>let blocked=false;try{parent.codPage.submit({answer:"child spoof"})}catch{blocked=true};parent.postMessage({childBridge:typeof window.codPage,parentAccessBlocked:blocked},"*")</script>',
  );
  server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<title>Ordinary page</title><h1>Ordinary fixture</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  remote = `http://127.0.0.1:${address.port}`;
  app = await _electron.launch({
    args: [
      process.env.COD_AGENT_ENTRY!,
      `--user-data-dir=${path.join(temporary, "profile")}`,
    ],
    env: { ...process.env, COD_AGENT_PRELOAD: process.env.COD_AGENT_PRELOAD! },
    chromiumSandbox: true,
  });
  await expect
    .poll(() => app.evaluate(() => Boolean((globalThis as any).agentFixture)))
    .toBe(true);
});
test.afterEach(async () => {
  await app?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await rm(temporary, { recursive: true, force: true });
});

test("Agent page AC1 sandboxed registered assets and actual form interaction submit immutable originating identity", async () => {
  const snapshot = await open();
  expect(snapshot.visible).toBe(false);
  await call("setBounds", "one", { x: 0, y: 0, width: 600, height: 400 });
  await call("setVisible", "one", true);
  await call("focus", "one");
  expect(await js("one", "window.ASSET_LOADED")).toBe(true);
  expect(
    await js(
      "one",
      "({node:typeof require,app:typeof window.cod,bridge:Object.keys(window.codPage)})",
    ),
  ).toEqual({ node: "undefined", app: "undefined", bridge: ["submit"] });
  const page = app
    .context()
    .pages()
    .find((page) => page.url() === snapshot.url);
  expect(page, "Real artifact page should be automatable").toBeDefined();
  await page!.getByRole("textbox", { name: "Answer" }).fill("invented answer");
  await page!.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page!.locator("output")).toContainText('"ok":true');
  const submissions = await app.evaluate(
    () => (globalThis as any).agentFixture.submissions,
  );
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    pageId: "one",
    workspaceId: "workspace-one",
    conversationId: "conversation-one",
    payload: { answer: "invented answer" },
  });
  expect(submissions[0].submissionId).toMatch(/^[\da-f-]{36}$/);
  const preferences = await app.evaluate(() => {
    const wc = (globalThis as any).agentFixture.service.getWebContents("one");
    const p = wc.getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
    };
  });
  expect(preferences).toEqual({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  });
});

test("Agent page AC2 independent origins cannot choose another target and child frames lack the bridge", async () => {
  const one = await open();
  const two = await open("two", "conversation-two");
  // Node URL reports null origin for custom schemes; compare registered authorities.
  expect(new URL(one.url).host).not.toBe(new URL(two.url).host);
  expect(
    (await js("one", `codPage.submit({conversationId:'conversation-two'})`)).ok,
  ).toBe(false);
  await expect
    .poll(() => js("one", "window.childReport"))
    .toEqual({ childBridge: "undefined", parentAccessBlocked: true });

  const forged = await app.evaluate(async ({ BrowserWindow }, url) => {
    const fixture = (globalThis as any).agentFixture;
    const owned = fixture.service.getWebContents("two");
    const preferences = owned.getLastWebPreferences();
    const outsider = new BrowserWindow({
      show: false,
      webPreferences: {
        session: owned.session,
        preload: preferences.preload,
        additionalArguments: preferences.additionalArguments,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    try {
      try {
        await outsider.loadURL(url);
      } catch {
        return { ok: false, blocked: true };
      }
      return await outsider.webContents.executeJavaScript(
        'typeof codPage === "undefined" ? {ok:false,bridgeAbsent:true} : codPage.submit({answer:"outsider"})',
      );
    } finally {
      outsider.destroy();
    }
  }, two.url);
  expect(forged.ok).toBe(false);
  const valid = await js("two", `codPage.submit({answer:'two'})`);
  expect(valid.ok).toBe(true);
  const rows = await app.evaluate(
    () => (globalThis as any).agentFixture.submissions,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].conversationId).toBe("conversation-two");
  expect(rows[0].pageId).toBe("two");
  const crossNavigation = await app.evaluate(async (_, url) => {
    try {
      await (globalThis as any).agentFixture.service
        .getWebContents("one")
        .loadURL(url);
      return false;
    } catch {
      return true;
    }
  }, two.url);
  expect(crossNavigation).toBe(true);
  expect(await js("one", "document.title")).not.toBe("Invented agent form");
  expect(
    await app.evaluate(
      () => (globalThis as any).agentFixture.submissions.length,
    ),
  ).toBe(1);
});

test("Agent page AC3 traversal, symlink escape and unknown origins never expose outside files", async () => {
  const snapshot = await open();
  const results = await js(
    "one",
    `Promise.all(['escape.txt','../private.txt','%2e%2e%2fprivate.txt','%252e%252e%252fprivate.txt'].map(async path=>{try{const r=await fetch(path);return {ok:r.ok,body:await r.text()};}catch{return {ok:false,body:''};}}))`,
  );
  for (const result of results) {
    expect(result.ok).toBe(false);
    expect(result.body).not.toContain("PRIVATE_OUTSIDE_SENTINEL");
  }
  const unknown = await app.evaluate(async ({ session }) => {
    try {
      const response = await session
        .fromPartition("invented-agent-pages")
        .fetch("cod-artifact://unregistered/index.html");
      return { denied: response.status >= 400, text: await response.text() };
    } catch {
      return { denied: true, text: "" };
    }
  });
  expect(unknown.denied).toBe(true);
  expect(unknown.text).not.toContain("PRIVATE_OUTSIDE_SENTINEL");
  expect((await call("snapshot", "one")).url).toBe(snapshot.url);
});

test("Agent page AC4 non-JSON, oversized and backend failures are bounded and page remains usable", async () => {
  await open();
  for (const expression of [
    "undefined",
    "NaN",
    "new Date()",
    "{value:BigInt(1)}",
    '{answer:"x".repeat(65537)}',
    "(()=>{const x={};x.self=x;return x})()",
  ]) {
    const result = await js("one", `codPage.submit(${expression})`);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result).length).toBeLessThan(300);
  }
  const failed = await js("one", "codPage.submit({fail:true})");
  expect(failed.ok).toBe(false);
  expect(JSON.stringify(failed)).not.toContain("PRIVATE_BACKEND_SENTINEL");
  expect(
    (await js("one", 'codPage.submit({answer:"after failures"})')).ok,
  ).toBe(true);
  expect(
    await app.evaluate(
      () => (globalThis as any).agentFixture.submissions.length,
    ),
  ).toBe(1);
});

test("Agent page AC5 navigation loses bridge, hide/show retains document and close revokes origin without affecting host", async () => {
  const first = await open();
  await js("one", 'window.identity="retained"');
  await call("setVisible", "one", true);
  await call("setVisible", "one", false);
  expect(await js("one", "window.identity")).toBe("retained");
  await call("setVisible", "one", true);
  await call("focus", "one");
  await app.evaluate(async ({ session }, url) => {
    await (
      globalThis as any
    ).agentFixture.window.webContents.session.cookies.set({
      url,
      name: "app_private",
      value: "invented",
    });
    await session
      .fromPartition("persist:invented-everyday-browser")
      .cookies.set({ url, name: "browser_private", value: "invented" });
  }, remote);
  await js("one", `location.href=${JSON.stringify(remote)}`);
  await expect.poll(() => js("one", "location.href")).toBe(remote + "/");
  expect(await js("one", "typeof window.codPage")).toBe("undefined");
  expect(await js("one", "typeof window.cod")).toBe("undefined");
  expect(await js("one", "document.cookie")).not.toMatch(
    /app_private|browser_private/,
  );
  await call("close", "one");
  await call("close", "one");
  const response = await app.evaluate(async ({ session }, url) => {
    try {
      const response = await session
        .fromPartition("invented-agent-pages")
        .fetch(url);
      return response.status >= 400;
    } catch {
      return true;
    }
  }, first.url);
  expect(response).toBe(true);
  await call("dispose");
  await call("dispose");
  expect(await call("list")).toEqual([]);
  expect(
    await app.evaluate(() =>
      (globalThis as any).agentFixture.window.isDestroyed(),
    ),
  ).toBe(false);
});

test("Agent page AC6 asset requests require their registered owner and cannot survive navigation away", async () => {
  const first = await open();
  const otherDirectory = path.join(temporary, "other-artifact");
  await mkdir(otherDirectory);
  await writeFile(path.join(directory, "local.txt"), "INVENTED_OWNER_A");
  await writeFile(
    path.join(otherDirectory, "index.html"),
    "<title>Owner B</title>",
  );
  await call("open", {
    id: "two",
    workspaceId: "workspace-two",
    conversationId: "conversation-two",
    path: path.join(otherDirectory, "index.html"),
  });
  const target = new URL("local.txt", first.url).href;
  const read = (id: string) =>
    js(
      id,
      `fetch(${JSON.stringify(target)}).then(async r=>({ok:r.ok,text:await r.text()})).catch(()=>({ok:false,text:''}))`,
    );
  expect(await read("one")).toEqual({ ok: true, text: "INVENTED_OWNER_A" });
  const denied = async (id: string) => {
    const result = await read(id);
    expect(result.ok).toBe(false);
    expect(result.text).not.toContain("INVENTED_OWNER_A");
  };
  await denied("two");
  for (const id of ["two", "one"]) {
    await app.evaluate(
      async (_, { id, remote }) =>
        (globalThis as any).agentFixture.service
          .getWebContents(id)
          .loadURL(remote),
      { id, remote },
    );
    await denied(id);
  }
  await denied("two");
});
