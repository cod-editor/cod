import { test, expect } from "@playwright/test";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { WorkspaceApp } from "./helpers/workspace-app";
import type { AppState } from "../../src/types";

const marker = "INVENTED_PROFILE_MIGRATION_MARKER";
for (const cacheOnlyTarget of [false, true])
  test(`Default profile migration preserves workspace drafts and native browser and extension storage${cacheOnlyTarget ? " with incidental Chromium target" : ""}`, async ({}, info) => {
    test.skip(
      process.platform !== "linux",
      "Isolated Linux default-directory migration; no host profile access",
    );
    const app = new WorkspaceApp();
    await app.prepare();
    const config = path.join(app.temporary, "config");
    const legacy = path.join(config, "cod-restart");
    const target = path.join(config, "cod");
    const extension = path.join(app.temporary, "invented-extension");
    await mkdir(extension, { recursive: true });
    await writeFile(
      path.join(extension, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Invented migration fixture",
        version: "2026.10.2",
        permissions: ["storage"],
      }),
    );
    await writeFile(
      path.join(extension, "fixture.html"),
      "<!doctype html><title>Invented extension</title><body>Invented extension</body>",
    );
    const server = createServer((_request, response) =>
      response.end(
        "<!doctype html><title>Invented profile origin</title><body>Invented fixture</body>",
      ),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No fixture origin");
    const origin = `http://127.0.0.1:${address.port}`;
    app.profileUserData = true;
    app.data = legacy;
    app.environment.COD_DATA_DIR = legacy;
    app.environment.COD_SOCKET_PATH = path.join(legacy, "cod.sock");
    app.environment.XDG_CONFIG_HOME = config;
    app.environment.COD_BITWARDEN_EXTENSION_PATH = extension;
    async function expectRefused(environment: Record<string, string>) {
      // This process is expected to exit before opening a window. Attaching a
      // Playwright debugger races that intentional early shutdown.
      let code = 0;
      try {
        await promisify(execFile)(
          app.app!.process().spawnfile,
          [path.join(app.root, "dist/main.cjs")],
          {
            cwd: app.root,
            env: environment,
            timeout: 5000,
          },
        );
      } catch (error) {
        const failure = error as {
          code?: number | string;
          killed?: boolean;
          signal?: string;
        };
        expect(failure.killed).not.toBe(true);
        expect(failure.signal).toBeFalsy();
        expect(failure.code).toBe(1);
        code = 1;
      }
      expect([0, 1]).toContain(code);
    }
    async function installed() {
      await expect
        .poll(() =>
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
    async function values(
      url: string,
      write: boolean,
      extensionStorage: boolean,
    ) {
      return app.app!.evaluate(
        async ({ BrowserWindow, session }, args) => {
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
            await window.loadURL(args.url);
            return await window.webContents.executeJavaScript(`(async () => {
          const {write,marker,extensionStorage}=${JSON.stringify(args)};
          if(write) localStorage.setItem('fixture',marker);
          if(write && extensionStorage) await chrome.storage.local.set({fixture:marker});
          const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('invented-profile',1);r.onupgradeneeded=()=>r.result.createObjectStore('markers');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          if(write) await new Promise((resolve,reject)=>{const t=db.transaction('markers','readwrite');t.objectStore('markers').put(marker,'fixture');t.oncomplete=resolve;t.onerror=()=>reject(t.error);});
          const indexed=await new Promise((resolve,reject)=>{const r=db.transaction('markers').objectStore('markers').get('fixture');r.onsuccess=()=>resolve(r.result??null);r.onerror=()=>reject(r.error);});
          db.close();
          return {local:localStorage.getItem('fixture'),indexed,extension:extensionStorage?(await chrome.storage.local.get('fixture')).fixture??null:null};
        })()`);
          } finally {
            window.close();
          }
        },
        { url, write, extensionStorage, marker },
      );
    }
    try {
      await app.start();
      const workspace = await app.create("Invented retained task");
      const state = await app.cli<AppState>("state");
      const paneId = state.workspaces.find(
        (w) => w.id === workspace,
      )!.activePaneId;
      await app.cli(
        "conversation",
        "composer",
        "--workspace",
        workspace,
        "--pane-id",
        paneId,
        "--text",
        marker,
      );
      await app.cli(
        "workspace",
        "settings",
        "--id",
        workspace,
        "--settings",
        JSON.stringify({ workspacesWidth: 272 }),
      );
      const keymap = JSON.stringify({ "pane.next": ["Alt+Tab"] });
      await writeFile(path.join(legacy, "keymap.json"), keymap);
      const id = await installed();
      expect(await values(origin, true, false)).toEqual({
        local: marker,
        indexed: marker,
        extension: null,
      });
      expect(
        await values(`chrome-extension://${id}/fixture.html`, true, true),
      ).toEqual({ local: marker, indexed: marker, extension: marker });
      await app.app!.evaluate(
        async ({ session }, { origin, marker }) => {
          const partition = session.fromPartition("persist:cod-browser");
          await partition.cookies.set({
            url: origin,
            name: "invented",
            value: marker,
            expirationDate: Date.now() / 1000 + 86400,
          });
          await partition.cookies.flushStore();
          partition.flushStorageData();
        },
        { origin, marker },
      );
      const cacheBytes = Buffer.from("INVENTED_OLD_CHROMIUM_CACHE_BYTES");
      if (cacheOnlyTarget) {
        await mkdir(path.join(target, "Cache", "Cache_Data"), {
          recursive: true,
        });
        await writeFile(
          path.join(target, "Local State"),
          '{"fixture":"incidental chromium root"}',
        );
        await writeFile(
          path.join(target, "Cache", "Cache_Data", "data_0"),
          cacheBytes,
        );
      }
      // A second, new-default instance must refuse migration while the old
      // profile socket is served, without touching either profile or its owner.
      const beforeState = await readFile(path.join(legacy, "state.json"));
      const nextEnvironment = { ...app.environment };
      delete nextEnvironment.COD_DATA_DIR;
      delete nextEnvironment.COD_SOCKET_PATH;
      await expectRefused(nextEnvironment);
      expect(await readFile(path.join(legacy, "state.json"))).toEqual(
        beforeState,
      );
      if (cacheOnlyTarget) {
        expect(
          await readFile(path.join(target, "Cache", "Cache_Data", "data_0")),
        ).toEqual(cacheBytes);
        expect(await readFile(path.join(target, "Local State"), "utf8")).toBe(
          '{"fixture":"incidental chromium root"}',
        );
      } else await expect(access(target)).rejects.toThrow();
      expect(
        (await app.state()).workspaces.some((w) => w.id === workspace),
      ).toBe(true);
      await app.stop();
      delete app.environment.COD_DATA_DIR;
      delete app.environment.COD_SOCKET_PATH;
      app.data = target;
      for (let round = 0; round < 2; round++) {
        await app.start();
        expect(
          await app.app!.evaluate(({ app }) => app.getPath("userData")),
        ).toBe(path.join(target, "chromium"));
        if (round === 0) {
          await expectRefused({ ...app.environment });
          await expectRefused({
            ...app.environment,
            COD_DATA_DIR: target,
            COD_SOCKET_PATH: path.join(target, "cod.sock"),
          });
        }
        if (cacheOnlyTarget) {
          const preserved: string[] = [];
          for (const entry of await readdir(config, { withFileTypes: true })) {
            if (
              !entry.isDirectory() ||
              ["cod", "cod-restart"].includes(entry.name)
            )
              continue;
            const candidate = path.join(config, entry.name);
            try {
              if (
                (await readFile(
                  path.join(candidate, "Local State"),
                  "utf8",
                )) === '{"fixture":"incidental chromium root"}'
              )
                preserved.push(candidate);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }
          expect(preserved).toHaveLength(1);
          expect(
            await readFile(
              path.join(preserved[0], "Cache", "Cache_Data", "data_0"),
            ),
          ).toEqual(cacheBytes);
          await expect(
            access(path.join(target, "Local State")),
          ).rejects.toThrow();
        }
        const restored = await app.cli<AppState>("state");
        app.environment.COD_SOCKET_PATH = path.join(legacy, "cod.sock");
        expect((await app.state()).activeWorkspaceId).toBe(
          restored.activeWorkspaceId,
        );
        delete app.environment.COD_SOCKET_PATH;
        expect(
          restored.workspaces.filter((w) => w.id === workspace),
        ).toHaveLength(1);
        expect(
          restored.workspaces.find((w) => w.id === workspace)!.settings
            ?.workspacesWidth,
        ).toBe(272);
        expect(
          restored.workspaces.find((w) => w.id === workspace)!.chatDrafts?.[
            paneId
          ]?.text,
        ).toBe(marker);
        expect(await readFile(path.join(target, "keymap.json"), "utf8")).toBe(
          keymap,
        );
        await expect(
          app.page.getByRole("textbox", { name: "Message", exact: true }),
        ).toHaveValue(marker);
        if (round === 0)
          await app.page.screenshot({
            path: info.outputPath("migrated-workspace-draft.png"),
          });
        expect(await installed()).toBe(id);
        expect(await values(origin, false, false)).toEqual({
          local: marker,
          indexed: marker,
          extension: null,
        });
        expect(
          await values(`chrome-extension://${id}/fixture.html`, false, true),
        ).toEqual({ local: marker, indexed: marker, extension: marker });
        const cookies = await app.app!.evaluate(
          ({ session }, origin) =>
            session
              .fromPartition("persist:cod-browser")
              .cookies.get({ url: origin }),
          origin,
        );
        expect(cookies.find((c) => c.name === "invented")?.value).toBe(marker);
        await app.stop();
      }
    } finally {
      await app.cleanup();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
