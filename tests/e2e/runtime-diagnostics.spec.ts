import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ChatApp } from "./helpers/chat-fixture/harness";

test("Runtime diagnostics correlate real renderer PIDs with tabs, popups and workspace IDs without content", async ({}, info) => {
  test.setTimeout(65_000);
  const shell = new ChatApp();
  await shell.prepare();
  const secret = "PRIVATE_RUNTIME_DIAGNOSTIC_SENTINEL";
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<title>${secret}</title><h1>${secret}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  const url = `http://127.0.0.1:${address.port}/${secret}?token=${secret}`;
  const journal = async () =>
    (
      await readFile(
        path.join(shell.data, "diagnostics", "runtime.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  try {
    await shell.start();
    const workspace = await shell.create(secret);
    const browser = await shell.cli<{ id: string }>(
      "browser",
      "open",
      "--workspace",
      workspace,
      "--url",
      url,
    );
    const native = await shell.app!.evaluate(async ({ webContents }, url) => {
      const page = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === url);
      if (!page) throw new Error("Missing invented browser view");
      await page.executeJavaScript(
        'window.open("/PRIVATE_RUNTIME_DIAGNOSTIC_SENTINEL-popup", "auth", "width=360,height=240");void 0',
      );
      return { id: page.id, pid: page.getOSProcessId() };
    }, url);
    await expect
      .poll(
        async () =>
          (await journal()).find(
            (e) => e.event === "renderer-context" && e.id === native.id,
          )?.browserId,
      )
      .toBe(browser.id);
    await expect
      .poll(async () =>
        shell.app!.evaluate(({ webContents }) =>
          webContents
            .getAllWebContents()
            .some((c) => c.getURL().endsWith("SENTINEL-popup")),
        ),
      )
      .toBe(true);
    const origin = await shell.newChat(workspace, "codex");
    const file = path.join(shell.folders[0], secret + ".html");
    await writeFile(file, `<h1>${secret}</h1>`);
    const artifact = await shell.cli<{ id: string }>(
      "page",
      "open",
      "--workspace",
      workspace,
      "--conversation",
      origin.id,
      "--path",
      file,
    );
    await expect
      .poll(
        async () =>
          (await journal()).find(
            (e) =>
              e.event === "renderer-context" && e.browserId === artifact.id,
          )?.role,
      )
      .toBe("agent-page");
    // Wait for one normal periodic sample, without changing the app's timer or journal.
    await expect
      .poll(
        async () =>
          (await journal())
            .filter((e) => e.event === "memory")
            .find((e) =>
              e.contents?.some((c: any) => c.browserId === artifact.id),
            ),
        { timeout: 40_000 },
      )
      .toBeTruthy();
    const entries = await journal();
    const memory = entries
      .filter((e) => e.event === "memory")
      .find((e) => e.contents?.some((c: any) => c.browserId === artifact.id));
    const owner = memory.contents.find((c: any) => c.id === native.id);
    expect(owner).toMatchObject({
      ...native,
      browserId: browser.id,
      workspaceId: workspace,
      role: "browser",
    });
    expect(
      memory.contents.filter((c: any) => c.browserId === browser.id),
    ).toHaveLength(2);
    expect(
      memory.contents.find((c: any) => c.browserId === artifact.id),
    ).toMatchObject({ workspaceId: workspace, role: "agent-page" });
    expect(
      memory.processes.some((p: any) => p.pid === native.pid && p.memory),
    ).toBe(true);
    await shell.app!.evaluate(
      ({ webContents }, id) =>
        webContents.fromId(id)!.forcefullyCrashRenderer(),
      native.id,
    );
    await expect
      .poll(async () =>
        (await journal()).find(
          (e) => e.event === "renderer-gone" && e.id === native.id,
        ),
      )
      .toMatchObject({
        ...native,
        browserId: browser.id,
        workspaceId: workspace,
        role: "browser",
      });
    await shell.cli("browser", "reload", "--id", browser.id);
    await expect
      .poll(
        async () =>
          (await journal())
            .filter((e) => e.event === "renderer-context" && e.id === native.id)
            .at(-1)?.pid,
      )
      .not.toBe(native.pid);
    const recovered = (await journal())
      .filter((e) => e.event === "renderer-context" && e.id === native.id)
      .at(-1);
    expect(recovered).toMatchObject({
      browserId: browser.id,
      workspaceId: workspace,
      role: "browser",
    });
    expect(recovered.pid).toBeGreaterThan(0);
    expect(JSON.stringify(await journal())).not.toContain(secret);
  } finally {
    // Retain bounded metadata before fixture cleanup, including on failed assertions.
    await readFile(path.join(shell.data, "diagnostics/runtime.jsonl"))
      .then((body) =>
        info.attach("runtime-events", {
          body,
          contentType: "application/x-ndjson",
        }),
      )
      .catch(() => {});
    await shell.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("The live entry keeps its captured build identity when dist is rebuilt, and restart adopts the new build", async ({}, info) => {
  test.setTimeout(90_000);
  const execute = promisify(execFile);
  const shell = new ChatApp();
  await shell.prepare();
  try {
    await shell.start();
    type Build = {
      id: string;
      sourceHash: string;
      revision: string | null;
      dirty: boolean | null;
      version: string;
    };
    const caps = () =>
      shell.cli<{ runtime: { build: Build | null } }>("capabilities");
    const initial = (await caps()).runtime.build;
    expect(initial?.id).toMatch(/^[a-f0-9-]{36}$/);
    const journal = JSON.parse(
      (
        await readFile(
          path.join(shell.data, "diagnostics/runtime.jsonl"),
          "utf8",
        )
      )
        .split("\n")
        .find((line) => JSON.parse(line).event === "start")!,
    );
    expect(journal.build).toEqual(initial);
    // This is an isolated fixture build, never the user's checkout or running app.
    await execute(process.execPath, ["scripts/build.mjs"], {
      cwd: shell.root,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const rebuilt = JSON.parse(
      await readFile(path.join(shell.root, "dist/build-info.json"), "utf8"),
    ).build;
    expect(rebuilt.id).not.toBe(initial!.id);
    expect(rebuilt.sourceHash).toBe(initial!.sourceHash);
    expect((await caps()).runtime.build).toEqual(initial);
    const status = JSON.parse(
      (
        await execute(
          process.execPath,
          [
            "scripts/delivery-status.mjs",
            "--offline",
            "--json",
            "--socket",
            shell.socket,
          ],
          { cwd: shell.root, timeout: 10_000, maxBuffer: 65536 },
        )
      ).stdout,
    );
    expect(status.built.build.id).toBe(rebuilt.id);
    expect(status.running.build.id).toBe(initial!.id);
    expect(status.actions).toEqual({
      fetch: "UNKNOWN",
      build: "NO",
      restart: "YES",
    });
    expect(JSON.stringify(status)).not.toContain(shell.temporary);
    await shell.stop();
    await shell.start();
    const restarted = (await caps()).runtime.build;
    expect(restarted?.id).toBe(rebuilt.id);
    await writeFile(
      info.outputPath("delivery-status.json"),
      JSON.stringify({ initial, rebuilt, status, restarted }, null, 2),
    );
  } finally {
    await shell.cleanup();
  }
});
