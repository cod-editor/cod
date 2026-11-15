import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChatApp } from "./helpers/chat-fixture/harness";

test("Runtime diagnostics correlate real renderer PIDs with tabs, popups and workspace IDs without content", async () => {
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
    await shell.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
