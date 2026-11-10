import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkspaceApp } from "./helpers/workspace-app";

test.setTimeout(60_000);
let app: WorkspaceApp;
let sources: string[];
const marker = "INVENTED_EXTENSION_STORAGE_MARKER";
test.beforeEach(async () => {
  app = new WorkspaceApp();
  await app.prepare();
  sources = [
    path.join(app.temporary, "release-one", "extension"),
    path.join(app.temporary, "release-two", "extension"),
  ];
  for (const [index, folder] of sources.entries()) {
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Invented extension persistence fixture",
        version: "2026.10.2",
        permissions: ["storage"],
      }),
    );
    await writeFile(
      path.join(folder, "fixture.html"),
      `<!doctype html><title>Invented extension</title><body>Payload ${index + 1}</body>`,
    );
  }
});
test.afterEach(async () => {
  await app?.cleanup();
});
async function load(source: string) {
  return app.app!.evaluate(
    async ({ session }, source) =>
      (
        await session
          .fromPartition("persist:cod-browser")
          .extensions.loadExtension(source)
      ).id,
    source,
  );
}
async function storage(id: string, write = false) {
  return (await app.app!.evaluate(
    async ({ BrowserWindow, session }, { id, write, marker }) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          session: session.fromPartition("persist:cod-browser"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      try {
        await window.loadURL(`chrome-extension://${id}/fixture.html`);
        return await window.webContents.executeJavaScript(`(async () => {
          const write = ${JSON.stringify(write)}, marker = ${JSON.stringify(marker)};
          if (write) await chrome.storage.local.set({fixture:marker});
          const db = await new Promise((resolve,reject) => {
            const request = indexedDB.open('invented-upgrade',1);
            request.onupgradeneeded=()=>request.result.createObjectStore('markers');
            request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
          });
          if(write) await new Promise((resolve,reject)=> {const tx=db.transaction('markers','readwrite');tx.objectStore('markers').put(marker,'fixture');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
          const indexed=await new Promise((resolve,reject)=>{const request=db.transaction('markers').objectStore('markers').get('fixture');request.onsuccess=()=>resolve(request.result??null);request.onerror=()=>reject(request.error);});
          db.close();
          const local=await chrome.storage.local.get('fixture');
          return {marker:local.fixture??null,indexed,payload:document.body.textContent};
        })()`);
      } finally {
        window.close();
      }
    },
    { id, write, marker },
  )) as { marker: string | null; indexed: string | null; payload: string };
}
async function installed() {
  await expect
    .poll(async () =>
      app.app!.evaluate(
        ({ session }) =>
          session
            .fromPartition("persist:cod-browser")
            .extensions.getAllExtensions().length,
      ),
    )
    .toBe(1);
  return app.app!.evaluate(
    ({ session }) =>
      session
        .fromPartition("persist:cod-browser")
        .extensions.getAllExtensions()[0].id,
  );
}
test("Unkeyed unpacked extension paths reproduce separate identities and storage across release directories", async () => {
  await app.start();
  const first = await load(sources[0]);
  expect((await storage(first, true)).marker).toBe(marker);
  await app.stop();
  await app.start();
  const second = await load(sources[1]);
  expect(second).not.toBe(first);
  expect(await storage(second)).toEqual({
    marker: null,
    indexed: null,
    payload: "Payload 2",
  });
  await app.stop();
  await app.start();
  const restored = await load(sources[0]);
  expect(restored).toBe(first);
  expect((await storage(restored)).marker).toBe(marker);
});
test("Packaged extension updates retain the installed identity and storage while replacing source payload", async () => {
  app.environment.COD_BITWARDEN_EXTENSION_PATH = sources[0];
  await app.start();
  const first = await installed();
  expect(await storage(first, true)).toEqual({
    marker,
    indexed: marker,
    payload: "Payload 1",
  });
  await app.stop();
  app.environment.COD_BITWARDEN_EXTENSION_PATH = sources[1];
  await app.start();
  const second = await installed();
  expect(second).toBe(first);
  expect(await storage(second)).toEqual({
    marker,
    indexed: marker,
    payload: "Payload 2",
  });
  await app.stop();
  await app.start();
  expect(await installed()).toBe(first);
  expect(await storage(first)).toEqual({
    marker,
    indexed: marker,
    payload: "Payload 2",
  });
});
