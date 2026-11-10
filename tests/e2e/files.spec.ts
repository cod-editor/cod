import { test, expect, type Locator } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFile, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { WorkspaceApp, tabTo, modifier } from "./helpers/workspace-app";

let app: WorkspaceApp;
let workspace: string;
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const marker = "INVENTED_PROJECT_SEARCH";
const source = (index: number) =>
  `export const greeting = "${marker}_${index}";\nexport const count = 1;\n`;
async function open(file: string) {
  const result = await app.cli<{ paneId: string }>(
    "file",
    "open",
    "--workspace",
    workspace,
    "--path",
    file,
  );
  return app.pane(result.paneId);
}
function editor(pane: Locator) {
  return pane.getByRole("textbox", { name: "File contents", exact: true });
}
async function focusTreeItem(target: Locator) {
  const alreadyInTree = await app.page.evaluate(() =>
    Boolean(
      document.activeElement?.closest('[role="tree"][aria-label="File tree"]'),
    ),
  );
  if (!alreadyInTree) {
    await app.page.keyboard.press(`${modifier}+Shift+P`);
    await expect(
      app.page.getByRole("textbox", { name: "Filter commands" }),
    ).toBeFocused();
    await app.page.keyboard.type("Focus files / return");
    await expect(
      app.page.getByRole("button", {
        name: "Focus files / return",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "true");
    await app.page.keyboard.press("Enter");
  }
  await app.page.keyboard.press("Home");
  for (let index = 0; index < 100; index++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await app.page.keyboard.press("ArrowDown");
  }
  await expect(target).toBeFocused();
}
async function activate(target: Locator) {
  if (
    await target.evaluate((node) => Boolean(node.closest(".searchable-list")))
  ) {
    const query = app.page.getByRole("dialog").getByRole("textbox");
    await expect(query).toBeFocused();
    const id = await target.getAttribute("id");
    for (let attempts = 0; attempts < 100; attempts++) {
      if ((await query.getAttribute("aria-activedescendant")) === id) break;
      await query.press("ArrowDown");
    }
    await expect(query).toHaveAttribute("aria-activedescendant", id!);
    await query.press("Enter");
    return;
  }
  if ((await target.getAttribute("role")) === "treeitem")
    await focusTreeItem(target);
  else await tabTo(app.page, target);
  await app.page.keyboard.press("Enter");
}

test.beforeEach(async () => {
  app = new WorkspaceApp();
  await app.prepare();
  app.folders = await Promise.all(
    app.folders.map((folder) => realpath(folder)),
  );
  for (const [index, folder] of app.folders.entries()) {
    git(folder, "checkout", "-B", "main");
    await writeFile(path.join(folder, "same.ts"), source(index));
    await writeFile(
      path.join(folder, "spec.md"),
      `# Repository ${index}\n\n${marker}\n`,
    );
    git(folder, "add", "--all");
    git(folder, "commit", "-m", "Invented baseline");
  }
  await app.start();
  workspace = await app.create("Files fixture");
  for (const folder of app.folders)
    await app.cli(
      "workspace",
      "add-folder",
      "--id",
      workspace,
      "--path",
      folder,
    );
  await app.page
    .getByRole("button", { name: "Toggle files", exact: true })
    .click();
});
test.afterEach(async () => {
  await app?.cleanup();
});

test("S3 keyboard tree, highlighted editing, save and reopening preserve the intended repository", async () => {
  const tree = app.page.getByRole("tree", { name: "File tree", exact: true });
  const root = tree.getByRole("treeitem", {
    name: path.basename(app.folders[1]),
    exact: true,
  });
  await focusTreeItem(root);
  await app.page.keyboard.press("ArrowRight");
  const file = root
    .locator("..")
    .getByRole("treeitem", { name: "same.ts", exact: true });
  await focusTreeItem(file);
  await app.page.keyboard.press(`${modifier}+Shift+W`);
  await expect(file).not.toBeFocused();
  await app.page.keyboard.press(`${modifier}+Shift+W`);
  await expect(file).toBeFocused();
  await activate(file);
  const pane = app.page
    .getByTestId("pane")
    .filter({
      has: app.page.getByRole("textbox", {
        name: "File contents",
        exact: true,
      }),
    })
    .last();
  await expect(editor(pane)).toHaveValue(source(1));
  await expect(pane.locator('[data-language="typescript"]')).toBeVisible();
  await expect(pane.locator("[data-syntax-token]").first()).toBeVisible();
  const changed = source(1) + "// keyboard edit\n";
  await editor(pane).fill(changed);
  await editor(pane).press(`${modifier}+s`);
  await expect
    .poll(() => readFile(path.join(app.folders[1], "same.ts"), "utf8"))
    .toBe(changed);
  expect(await readFile(path.join(app.folders[0], "same.ts"), "utf8")).toBe(
    source(0),
  );
  await expect(
    editor(await open(path.join(app.folders[1], "same.ts"))),
  ).toHaveValue(changed);
});

test("S3 workspace search uses both explicit roots, shows truncation and opens keyboard-selected result", async () => {
  await app.page.keyboard.press(`${modifier}+Shift+f`);
  const query = app.page.getByRole("textbox", {
    name: "Workspace search",
    exact: true,
  });
  await tabTo(app.page, query);
  await query.fill(marker);

  const results = app.page.getByRole("region", {
    name: "Search results",
    exact: true,
  });
  await expect(results).toContainText(
    `${path.basename(app.folders[0])}/same.ts`,
  );
  await expect(results).toContainText(
    `${path.basename(app.folders[1])}/same.ts`,
  );
  const target = results
    .getByRole("button")
    .filter({ hasText: `${path.basename(app.folders[1])}/same.ts` })
    .first();
  await activate(target);
  await expect(
    app.page
      .getByRole("textbox", { name: "File contents", exact: true })
      .last(),
  ).toHaveValue(source(1));
  const limited = await app.cli<{ matches: unknown[]; truncated: boolean }>(
    "project",
    "search",
    "--workspace",
    workspace,
    "--query",
    marker,
    "--max-results",
    "1",
  );
  expect(limited.matches).toHaveLength(1);
  expect(limited.truncated).toBe(true);
  await writeFile(
    path.join(app.folders[0], "many.txt"),
    `${marker}\n`.repeat(110),
  );
  await app.page.keyboard.press(`${modifier}+Shift+f`);
  await app.page
    .getByRole("textbox", { name: "Workspace search", exact: true })
    .fill(marker);
  await expect(results).toContainText(/truncat|limit/i);
});

test("S3 Markdown preview renders highlighted code and Mermaid without executing embedded content", async ({}, testInfo) => {
  const file = path.join(app.folders[0], "preview.md");
  await writeFile(
    file,
    '# Preview fixture\n\n```typescript\nconst answer = 42;\n```\n\n```mermaid\ngraph TD\n A[Start] --> B[Finish]\n```\n\n<script>window.COD_PREVIEW_ATTACK=true</script>\n<img src="missing" onerror="window.COD_PREVIEW_ATTACK=true">\n[Unsafe](javascript:window.COD_PREVIEW_ATTACK=true)\n',
  );
  const pane = await open(file);
  await app.page
    .getByRole("tab", { name: "preview.md", exact: true })
    .click({ button: "right" });
  await activate(
    app.page
      .getByRole("dialog", { name: "Actions" })
      .getByRole("button", { name: "Markdown preview", exact: true }),
  );
  const preview = app.page.getByRole("region", {
    name: "Markdown preview",
    exact: true,
  });
  await expect(preview).toBeVisible();
  const frame = preview.locator("iframe");
  const body = (await frame.count())
    ? frame.contentFrame().locator("body")
    : preview;
  await expect(body).toContainText("Preview fixture");
  await expect(body.locator("svg").first()).toBeVisible();
  await expect(
    body
      .locator("svg text")
      .filter({ hasText: /^Start$/ })
      .first(),
  ).toBeVisible();
  await expect(
    body
      .locator("svg text")
      .filter({ hasText: /^Finish$/ })
      .first(),
  ).toBeVisible();
  await app.page.screenshot({
    path: testInfo.outputPath("markdown-mermaid-preview.png"),
  });
  await expect(body.locator("pre code")).toContainText("const answer");
  await expect(body.locator("pre code span").first()).toBeVisible();
  expect(
    await app.page.evaluate(() => Boolean((window as any).COD_PREVIEW_ATTACK)),
  ).toBe(false);
  expect(
    await body.locator('a[href^="javascript:"],script,img[onerror]').count(),
  ).toBe(0);
  if (await frame.count())
    expect(
      await body.evaluate(() => ({
        attack: Boolean((window as any).COD_PREVIEW_ATTACK),
        bridge: typeof (window as any).cod,
      })),
    ).toEqual({ attack: false, bridge: "undefined" });
});

test("S3 same-named files keep repo-specific statuses, changed lines and local patches", async () => {
  for (const [index, folder] of app.folders.entries())
    await writeFile(
      path.join(folder, "same.ts"),
      source(index).replace("count = 1", `count = ${index + 20}`),
    );
  await writeFile(
    path.join(app.folders[1], "untracked.txt"),
    "invented untracked\n",
  );
  const repositories = await app.cli<{ repositories: Array<{ root: string }> }>(
    "git",
    "repositories",
    "--workspace",
    workspace,
  );
  expect(repositories.repositories.map((r) => r.root).sort()).toEqual(
    [...app.folders].sort(),
  );
  for (const [index, folder] of app.folders.entries()) {
    const changes = await app.cli<{
      repoRoot: string;
      files: Array<{ path: string }>;
    }>("git", "changes", "--workspace", workspace, "--repo-root", folder);
    expect(changes.repoRoot).toBe(folder);
    expect(
      changes.files.some((f) => f.path === path.join(folder, "same.ts")),
    ).toBe(true);
    const pane = await open(path.join(folder, "same.ts"));
    await expect(pane.locator('[data-changed-line="2"]')).toBeVisible();
    const result = await app.cli<{ paneId: string }>(
      "diff",
      "open",
      "--workspace",
      workspace,
      "--repo-root",
      folder,
    );
    const diff = app
      .pane(result.paneId)
      .getByRole("region", { name: "Repository diff", exact: true });
    await expect(diff).toContainText(folder);
    await expect(diff).toContainText(`+export const count = ${index + 20}`);
    await expect(diff).not.toContainText(
      `+export const count = ${1 - index + 20}`,
    );
  }
  await expect(
    app.page.getByRole("tree", { name: "File tree", exact: true }),
  ).toContainText("untracked.txt");
});

test("S3 branch comparison uses direct trees and background diff does not steal workspace focus", async () => {
  const folder = app.folders[0];
  git(folder, "checkout", "-b", "left");
  await writeFile(path.join(folder, "left.txt"), "LEFT_ONLY\n");
  git(folder, "add", "--all");
  git(folder, "commit", "-m", "Left");
  git(folder, "checkout", "main");
  git(folder, "checkout", "-b", "right");
  await writeFile(path.join(folder, "right.txt"), "RIGHT_ONLY\n");
  git(folder, "add", "--all");
  git(folder, "commit", "-m", "Right");
  const other = await app.create("Keep focused");
  await app.cli("workspace", "focus", "--id", other);
  const result = await app.cli<{ paneId: string }>(
    "diff",
    "open",
    "--workspace",
    workspace,
    "--repo-root",
    folder,
    "--base",
    "left",
    "--head",
    "right",
  );
  expect((await app.state()).activeWorkspaceId).toBe(other);
  await app.cli("workspace", "focus", "--id", workspace);
  const diff = app
    .pane(result.paneId)
    .getByRole("region", { name: "Repository diff", exact: true });
  await expect(diff).toContainText("-LEFT_ONLY");
  await expect(diff).toContainText("+RIGHT_ONLY");
  await expect(diff).toContainText("Direct two-tree comparison");
  await diff.getByRole("textbox", { name: "Base", exact: true }).fill("right");
  await diff.getByRole("textbox", { name: "Head", exact: true }).fill("left");
  await activate(
    diff.getByRole("button", { name: "Compare branches", exact: true }),
  );
  await expect(diff).toContainText("+LEFT_ONLY");
  await expect(diff).toContainText("-RIGHT_ONLY");
});

test("S3 unsaved drafts survive workspace switches and restart, with external-change conflict protection", async () => {
  const file = path.join(app.folders[0], "spec.md"),
    draft = "# Unsaved private fixture\n";
  const pane = await open(file);
  await editor(pane).fill(draft);
  const other = await app.create("Other draft task");
  await app.cli("workspace", "focus", "--id", other);
  await app.cli("workspace", "focus", "--id", workspace);
  await expect(editor(pane)).toHaveValue(draft);
  await app.stop();
  await writeFile(file, "# External replacement\n");
  await app.start();
  const restored = app.page
    .getByRole("textbox", { name: "File contents", exact: true })
    .last();
  await expect(restored).toHaveValue(draft);
  await expect(
    app.page
      .getByRole("status")
      .filter({ hasText: /conflict|changed.*disk|external/i })
      .first(),
  ).toBeVisible();
  await restored.press(`${modifier}+s`);
  expect(await readFile(file, "utf8")).toBe("# External replacement\n");
  await expect(restored).toHaveValue(draft);
});

test("S3 explicit chat file references show both matching roots and open the keyboard-chosen file", async () => {
  await app.stop();
  const recording = path.join(app.temporary, "reference-provider.jsonl");
  await writeFile(recording, "");
  app.environment.COD_CODEX_EXECUTABLE = process.execPath;
  app.environment.COD_CODEX_ARGS = JSON.stringify([
    path.join(app.root, "tests/e2e/helpers/chat-fixture/provider.mjs"),
    "codex",
    recording,
  ]);
  await app.start();
  const resolution = await app.cli<{ candidates: Array<{ path: string }> }>(
    "file",
    "resolve",
    "--workspace",
    workspace,
    "--path",
    "same.ts:2",
  );
  expect(
    resolution.candidates.map((candidate) => candidate.path).sort(),
  ).toEqual(app.folders.map((folder) => path.join(folder, "same.ts")).sort());
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
    "Please inspect `same.ts:2` in the intended repository.",
  );
  const transcript = app
    .pane(chat.paneId)
    .getByRole("region", { name: "Conversation transcript", exact: true });
  const reference = transcript
    .locator("button, a")
    .filter({ hasText: /^same\.ts:2$/ })
    .nth(1);
  await expect(reference).toBeVisible();
  await tabTo(app.page, reference);
  // Same-label user and streamed assistant references must retain distinct focus.
  // A real state update makes focus preservation deterministic, without waiting
  // for streaming to finish or mutating renderer/application state directly.
  await app.cli(
    "workspace",
    "rename",
    "--id",
    workspace,
    "--name",
    "Files fixture renamed during reference focus",
  );
  await expect(reference).toBeFocused();
  await app.page.keyboard.press("Enter");
  const chooser = app.page.getByRole("dialog", {
    name: "Choose file",
    exact: true,
  });
  await expect(chooser).toBeVisible();
  for (const folder of app.folders)
    await expect(
      chooser.getByRole("button", {
        name: path.join(folder, "same.ts"),
        exact: true,
      }),
    ).toBeVisible();
  await activate(
    chooser.getByRole("button", {
      name: path.join(app.folders[1], "same.ts"),
      exact: true,
    }),
  );
  await expect(chooser).toHaveCount(0);
  await expect(
    app.page
      .getByRole("textbox", { name: "File contents", exact: true })
      .last(),
  ).toHaveValue(source(1));
  expect(await readFile(path.join(app.folders[0], "same.ts"), "utf8")).toBe(
    source(0),
  );
});

test("S3 deleted file still restores its editable unsaved draft and refuses silent recreation", async ({}, testInfo) => {
  const file = path.join(app.folders[0], "spec.md"),
    draft = "# Retained deleted-file fixture\n";
  const pane = await open(file);
  await editor(pane).fill(draft);
  await app.stop();
  await rm(file);
  await app.start();
  const restored = app.page
    .getByRole("textbox", { name: "File contents", exact: true })
    .last();
  await expect(restored).toHaveValue(draft);
  await expect(
    app.page
      .getByRole("status")
      .filter({ hasText: /missing.*draft|draft.*missing/i })
      .first(),
  ).toBeVisible();
  await restored.press(`${modifier}+s`);
  await expect(restored).toHaveValue(draft);
  await expect(readFile(file, "utf8")).rejects.toThrow();
  await app.page.screenshot({
    path: testInfo.outputPath("retained-missing-file-draft.png"),
  });
});

test("S3 two panes share one canonical draft and saving either view preserves the latest text through restart", async () => {
  const file = path.join(app.folders[0], "spec.md");
  const first = await open(file);
  const firstId = await first.getAttribute("data-pane-id");
  const second = await open(file);
  const current = (await app.state()).workspaces.find(
    (w) => w.id === workspace,
  ) as any;
  const group = current.groups.find((g: any) => g.paneIds.includes(firstId));
  await app.cli(
    "group",
    "split",
    "--workspace",
    workspace,
    "--id",
    group.id,
    "--direction",
    "right",
    "--pane-id",
    firstId!,
  );
  await editor(first).fill("# First edit\n");
  await editor(second).fill("# Latest shared draft\n");
  await expect(editor(first)).toHaveValue("# Latest shared draft\n");
  await editor(first).press(`${modifier}+s`);
  await expect
    .poll(() => readFile(file, "utf8"))
    .toBe("# Latest shared draft\n");
  await app.stop();
  await app.start();
  for (const view of await app.page
    .getByRole("textbox", { name: "File contents", exact: true })
    .all())
    await expect(view).toHaveValue("# Latest shared draft\n");
});

test("S3 typing during a pending save retains and rebases the newer draft across restart", async () => {
  const file = path.join(app.folders[0], "spec.md"),
    pane = await open(file);
  await editor(pane).fill("# Save this revision\n");
  await app.app!.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as any)._invokeHandlers,
      original = handlers.get("cod:invoke");
    ipcMain.removeHandler("cod:invoke");
    ipcMain.handle("cod:invoke", async (event, request) => {
      if (request.op === "file.save")
        await new Promise((resolve) => setTimeout(resolve, 600));
      return original(event, request);
    });
  });
  await editor(pane).press(`${modifier}+s`);
  await editor(pane).fill("# Newer unsaved revision\n");
  await expect
    .poll(() => readFile(file, "utf8"))
    .toBe("# Save this revision\n");
  await expect(editor(pane)).toHaveValue("# Newer unsaved revision\n");
  await app.stop();
  await app.start();
  const restored = app.page
    .getByRole("textbox", { name: "File contents", exact: true })
    .last();
  await expect(restored).toHaveValue("# Newer unsaved revision\n");
  await restored.press(`${modifier}+s`);
  await expect
    .poll(() => readFile(file, "utf8"))
    .toBe("# Newer unsaved revision\n");
});

test("S3 newer search results survive an older delayed response and failure", async () => {
  await writeFile(path.join(app.folders[0], "slow.txt"), "SLOW_TAG\n");
  await writeFile(path.join(app.folders[0], "fast.txt"), "FAST_TAG\n");
  await app.app!.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers.get("cod:invoke");
    ipcMain.removeHandler("cod:invoke");
    ipcMain.handle("cod:invoke", async (event, request) => {
      const result = await original(event, request);
      if (
        request.op === "project.search" &&
        ["SLOW_TAG", "ERROR_TAG"].includes(request.query)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (request.query === "ERROR_TAG")
          throw new Error("Invented delayed search error");
      }
      return result;
    });
  });
  await app.page.keyboard.press(`${modifier}+Shift+f`);
  const query = app.page.getByRole("textbox", {
      name: "Workspace search",
      exact: true,
    }),
    results = app.page.getByRole("region", {
      name: "Search results",
      exact: true,
    });
  for (const older of ["SLOW_TAG", "ERROR_TAG"]) {
    await query.fill(older);
    await app.page.waitForTimeout(220);
    await query.fill("FAST_TAG");
    await expect(results).toContainText("FAST_TAG");
    await app.page.waitForTimeout(800);
    await expect(results).toContainText("FAST_TAG");
    await expect(results).not.toContainText(/SLOW_TAG|delayed search error/);
    await expect(
      app.page
        .getByRole("status")
        .filter({ hasText: "Invented delayed search error" }),
    ).toHaveCount(0);
  }
});

test("S3 newer branch comparison survives an older delayed comparison", async () => {
  const folder = app.folders[0];
  git(folder, "checkout", "-b", "left");
  await writeFile(path.join(folder, "left.txt"), "LEFT_ONLY\n");
  git(folder, "add", "--all");
  git(folder, "commit", "-m", "Left fixture");
  git(folder, "checkout", "main");
  git(folder, "checkout", "-b", "right");
  await writeFile(path.join(folder, "right.txt"), "RIGHT_ONLY\n");
  git(folder, "add", "--all");
  git(folder, "commit", "-m", "Right fixture");
  const result = await app.cli<{ paneId: string }>(
    "diff",
    "open",
    "--workspace",
    workspace,
    "--repo-root",
    folder,
  );
  const diff = app
    .pane(result.paneId)
    .getByRole("region", { name: "Repository diff", exact: true });
  await app.app!.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers.get("cod:invoke");
    ipcMain.removeHandler("cod:invoke");
    ipcMain.handle("cod:invoke", async (event, request) => {
      const result = await original(event, request);
      if (request.op === "git.diff" && request.base === "left")
        await new Promise((resolve) => setTimeout(resolve, 600));
      return result;
    });
  });
  const base = diff.getByRole("textbox", { name: "Base", exact: true }),
    head = diff.getByRole("textbox", { name: "Head", exact: true }),
    compare = diff.getByRole("button", {
      name: "Compare branches",
      exact: true,
    });
  await base.fill("left");
  await head.fill("right");
  await compare.click();
  await base.fill("right");
  await head.fill("left");
  await compare.click();
  await expect(diff).toContainText("+LEFT_ONLY");
  await app.page.waitForTimeout(800);
  await expect(diff).toContainText("+LEFT_ONLY");
  await expect(diff).not.toContainText("+RIGHT_ONLY");
});

test("S3 expanded file tree reconciles externally committed files without losing keyboard focus", async () => {
  const tree = app.page.getByRole("tree", { name: "File tree", exact: true });
  const root = tree.getByRole("treeitem", {
    name: path.basename(app.folders[0]),
    exact: true,
  });
  const file = root
    .locator("..")
    .getByRole("treeitem", { name: "same.ts", exact: true });
  await focusTreeItem(file);
  const newPath = path.join(app.folders[0], "committed-after-open.ts");
  await writeFile(newPath, "export const committed = true;\n");
  git(app.folders[0], "add", "committed-after-open.ts");
  git(app.folders[0], "commit", "-m", "Add committed tree fixture");
  expect(git(app.folders[0], "status", "--porcelain")).toBe("");
  await expect(
    root
      .locator("..")
      .getByRole("treeitem", { name: "committed-after-open.ts", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(file).toBeFocused();
  await app.page.keyboard.press("Enter");
  await expect(
    app.page
      .getByRole("textbox", { name: "File contents", exact: true })
      .last(),
  ).toHaveValue(source(0));
});
