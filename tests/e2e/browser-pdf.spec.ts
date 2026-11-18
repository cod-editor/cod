import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WorkspaceApp } from "./helpers/workspace-app";

function fixturePdf() {
  const stream =
    "1 0 0 rg 70 400 220 220 re f\n0 0 1 rg 320 160 220 220 re f\nBT /F1 24 Tf 70 720 Td (Invented PDF page content) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

interface PdfTab {
  id: string;
  paneId: string;
  nativeTabId: number;
  url: string;
}
async function pagePixels(app: WorkspaceApp, id: string) {
  const tab = await app.cli<PdfTab>("browser", "inspect", "--id", id);
  return app.app!.evaluate(async ({ webContents }, contentsId) => {
    const contents = webContents.fromId(contentsId);
    if (!contents) return { red: 0, blue: 0 };
    const bitmap = (await contents.capturePage()).toBitmap();
    let red = 0,
      blue = 0;
    for (let i = 0; i < bitmap.length; i += 4) {
      if (bitmap[i] < 30 && bitmap[i + 1] < 30 && bitmap[i + 2] > 220) red++;
      if (bitmap[i] > 220 && bitmap[i + 1] < 30 && bitmap[i + 2] < 30) blue++;
    }
    return { red, blue };
  }, tab.nativeTabId);
}
async function rendered(app: WorkspaceApp, id: string) {
  await expect
    .poll(async () => {
      const pixels = await pagePixels(app, id);
      return pixels.red > 1000 && pixels.blue > 1000;
    })
    .toBe(true);
}
async function screenshot(app: WorkspaceApp, id: string, filename: string) {
  const tab = await app.cli<PdfTab>("browser", "inspect", "--id", id);
  const png = await app.app!.evaluate(
    async ({ webContents }, id) =>
      (await webContents.fromId(id)!.capturePage()).toPNG().toString("base64"),
    tab.nativeTabId,
  );
  await writeFile(filename, Buffer.from(png, "base64"));
}

async function desktopScreenshot(app: WorkspaceApp, filename: string) {
  const png = await app.app!.evaluate(async ({ desktopCapturer }) => {
    const [screen] = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1280, height: 900 },
    });
    return screen.thumbnail.toPNG().toString("base64");
  });
  await writeFile(filename, Buffer.from(png, "base64"));
}

test("PDF pages render over HTTP and local Unicode paths, reload and restart", async ({}, info) => {
  test.setTimeout(90000);
  const app = new WorkspaceApp();
  const pdf = fixturePdf();
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/pdf");
    response.end(pdf);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture server");
  try {
    await app.prepare();
    app.launchArguments.push(
      "--host-resolver-rules=MAP pdf.example.test 127.0.0.1",
    );
    const file = path.join(app.folders[0], "Résumé отчет.pdf");
    await writeFile(file, pdf);
    await app.start();
    const workspace = (await app.state()).workspaces[0].id;
    for (const [label, url] of [
      ["localhost", `http://127.0.0.1:${address.port}/fixture.pdf`],
      ["web-host", `http://pdf.example.test:${address.port}/fixture.pdf`],
      ["local", pathToFileURL(file).href],
    ]) {
      const tab = await app.cli<PdfTab>(
        "browser",
        "open",
        "--workspace",
        workspace,
        "--url",
        url,
      );
      await rendered(app, tab.id);
      await screenshot(app, tab.id, info.outputPath(`${label}-pdf.png`));
      await app.cli("browser", "close", "--id", tab.id);
    }
    const tab = await app.cli<PdfTab>(
      "file",
      "open",
      "--workspace",
      workspace,
      "--path",
      file,
    );
    expect(tab.url).toBe(pathToFileURL(file).href);
    await rendered(app, tab.id);
    await expect(
      app
        .pane(tab.paneId)
        .getByRole("textbox", { name: "File contents", exact: true }),
    ).toHaveCount(0);
    await app.cli("browser", "reload", "--id", tab.id);
    await rendered(app, tab.id);
    const line = await app.raw(
      "file",
      "open",
      "--workspace",
      workspace,
      "--path",
      file,
      "--line",
      "1",
    );
    expect(line.code).not.toBe(0);
    expect(line.stderr).toContain(
      "PDF documents do not have editable source lines",
    );
    await app.stop();
    await app.start();
    await rendered(app, tab.id);
    await screenshot(app, tab.id, info.outputPath("restarted-pdf.png"));
    await desktopScreenshot(app, info.outputPath("pdf-in-split.png"));
    for (const url of [
      "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
      "chrome-extension://invented-extension/index.html",
    ]) {
      const result = await app.raw(
        "browser",
        "navigate",
        "--id",
        tab.id,
        "--url",
        url,
      );
      expect(result.code).not.toBe(0);
      expect(
        (await app.cli<PdfTab>("browser", "inspect", "--id", tab.id)).url,
      ).toBe(pathToFileURL(file).href);
    }
  } finally {
    await app.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("PDF chat references and file tree use the same native document viewer", async ({}, info) => {
  const app = new WorkspaceApp();
  try {
    await app.prepare();
    const file = path.join(app.folders[0], "report.pdf");
    await writeFile(file, fixturePdf());
    const recording = path.join(app.temporary, "pdf-provider.jsonl");
    await writeFile(recording, "");
    app.environment.COD_CODEX_EXECUTABLE = process.execPath;
    app.environment.COD_CODEX_ARGS = JSON.stringify([
      path.join(app.root, "tests/e2e/helpers/chat-fixture/provider.mjs"),
      "codex",
      recording,
    ]);
    await app.start();
    const workspace = await app.create("PDF fixtures");
    await app.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      app.folders[0],
    );
    await app.page
      .getByRole("button", { name: "Toggle files", exact: true })
      .click();
    const tree = app.page.getByRole("tree", {
      name: "File tree",
      exact: true,
    });
    const root = tree.getByRole("treeitem", {
      name: path.basename(app.folders[0]),
      exact: true,
    });
    await root.focus();
    await app.page.keyboard.press("ArrowRight");
    await expect(root).toHaveAttribute("aria-expanded", "true");
    await tree
      .getByRole("treeitem", { name: "report.pdf", exact: true })
      .click();
    await expect
      .poll(async () =>
        (await app.cli<{ browsers: PdfTab[] }>("state")).browsers.some(
          (tab) => tab.url === pathToFileURL(file).href,
        ),
      )
      .toBe(true);
    let state = await app.cli<{ browsers: PdfTab[] }>("state");
    const fileTab = state.browsers.find(
      (tab) => tab.url === pathToFileURL(file).href,
    )!;
    expect(fileTab).toBeDefined();
    await rendered(app, fileTab.id);
    await app.cli("browser", "close", "--id", fileTab.id);
    const chat = await app.cli<{ id: string; paneId: string }>(
      "conversation",
      "create",
      "--workspace",
      workspace,
      "--provider",
      "codex",
      "--cwd",
      app.folders[0],
    );
    await app.cli(
      "conversation",
      "send",
      "--id",
      chat.id,
      "--text",
      "Open `report.pdf`",
    );
    const reference = app
      .pane(chat.paneId)
      .getByRole("region", { name: "Conversation transcript", exact: true })
      .getByRole("button", { name: "report.pdf", exact: true })
      .first();
    await reference.focus();
    await app.page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          (await app.cli<{ browsers: PdfTab[] }>("state")).browsers.length,
      )
      .toBe(1);
    state = await app.cli<{ browsers: PdfTab[] }>("state");
    await rendered(app, state.browsers[0].id);
    await screenshot(
      app,
      state.browsers[0].id,
      info.outputPath("chat-pdf-page.png"),
    );
    await desktopScreenshot(app, info.outputPath("chat-pdf-reference.png"));
  } finally {
    await app.cleanup();
  }
});
