// Prepared actual-app acceptance runner. Execute only after add-on handback.
import { _electron, expect } from "@playwright/test";
import { createHash, X509Certificate } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { freezeRuntime } from "./freeze-runtime.mjs";
import { startLoginFixture } from "./login-fixture.mjs";

const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const checkoutRoot = path.resolve(here, "../../..");
let root = checkoutRoot,
  executablePath;
const verification = path.resolve(
  process.env.COD_TEST_VAULT_DIRECTORY ||
    path.join(checkoutRoot, "artifacts/bitwarden-fixture"),
);
const version = "2026.10.2";
// Official pinned release fetched by npm run prepare:bitwarden.
const archiveHash =
  "2ebc61246a2ea82a65c589b8484e26a5678253fa6474c26dc5b6a7a7fcacbda4";
const archive = path.resolve(
  process.env.COD_TEST_BITWARDEN_ARCHIVE ||
    path.join(checkoutRoot, `artifacts/bitwarden/bitwarden-${version}.zip`),
);
const bytes = await readFile(archive);
if (createHash("sha256").update(bytes).digest("hex") !== archiveHash)
  throw new Error(
    "Official fixture archive differs from recorded release bytes",
  );
const certificate = new X509Certificate(
  await readFile(path.join(verification, "certs/localhost.crt")),
);
if (Date.parse(certificate.validTo) <= Date.now())
  throw new Error(
    "Existing fixture certificate expired; no automatic fixture mutation permitted",
  );
const spki = createHash("sha256")
  .update(certificate.publicKey.export({ type: "spki", format: "der" }))
  .digest("base64");
const account = JSON.parse(
  await readFile(path.join(verification, "account.json"), "utf8"),
);
if (!account.email || !account.password)
  throw new Error("Existing invented fixture account unavailable");
await mkdir(path.join(checkoutRoot, "artifacts/bitwarden-runs"), {
  recursive: true,
});
const evidence = await mkdtemp(
  path.join(checkoutRoot, "artifacts/bitwarden-runs/integrated-"),
);
const temporary = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "cod-addon-")),
);
let app, main, loginFixture, filters;
let env;
let stage = "runtime-freeze";
const results = [];
const diagnostics = {};
async function cli(...args) {
  const result = await execute(
    process.execPath,
    [path.join(root, "dist/cli.cjs"), ...args],
    { cwd: root, env, timeout: 20000 },
  );
  return JSON.parse(result.stdout);
}
async function launch() {
  app = await _electron.launch({
    cwd: root,
    executablePath,
    chromiumSandbox: true,
    env,
    args: [
      path.join(root, "dist/main.cjs"),
      `--user-data-dir=${path.join(temporary, "chromium")}`,
      `--ignore-certificate-errors-spki-list=${spki}`,
    ],
  });
  const url = pathToFileURL(path.join(root, "dist/index.html")).href;
  await expect
    .poll(
      () => {
        main = app
          .context()
          .pages()
          .find((p) => !p.isClosed() && p.url() === url);
        return Boolean(main);
      },
      { timeout: 20000 },
    )
    .toBe(true);
  main.setDefaultTimeout(15000);
  await main
    .getByRole("button", { name: "Switch workspace", exact: true })
    .waitFor();
}
async function nativePage(url) {
  let page;
  await expect
    .poll(
      () => {
        page = app
          .context()
          .pages()
          .find(
            (p) =>
              !p.isClosed() &&
              p.url().replace(/\/$/, "") === url.replace(/\/$/, ""),
          );
        return Boolean(page);
      },
      { timeout: 15000 },
    )
    .toBe(true);
  return page;
}
async function popup(paneId, extensionId) {
  const content = await nativePage(loginFixture.url);
  await content
    .getByRole("heading", { name: "Cod fixture login", exact: true })
    .click();
  await main.bringToFront();
  const pane = main
    .getByTestId("pane")
    .and(main.locator(`[data-pane-id=${JSON.stringify(paneId)}]`));
  await pane.locator("browser-action-list button.action").first().click();
  let page;
  await expect
    .poll(
      async () => {
        for (const candidate of app.context().pages()) {
          if (
            candidate.isClosed() ||
            !candidate
              .url()
              .startsWith(`chrome-extension://${extensionId}/popup/index.html`)
          )
            continue;
          try {
            const window = await app.browserWindow(candidate);
            if (
              await window.evaluate((w) => w.isVisible() && !w.isDestroyed())
            ) {
              page = candidate;
              return true;
            }
          } catch {}
        }
        return false;
      },
      { timeout: 15000 },
    )
    .toBe(true);
  const window = await app.browserWindow(page);
  await window.evaluate((w) => w.focus());
  for (let i = 0; i < 5; i++) {
    await expect
      .poll(() =>
        window.evaluate((w) => ({
          focused: w.isFocused(),
          width: w.getBounds().width,
          height: w.getBounds().height,
        })),
      )
      .toMatchObject({ focused: true, width: 480, height: 600 });
    await page.waitForTimeout(100);
  }
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  // Proven native settling bound; DOM activation is never an acceptance substitute.
  await page.waitForTimeout(1000);
  page.setDefaultTimeout(15000);
  return page;
}
try {
  ({ root, executablePath } = await freezeRuntime(
    checkoutRoot,
    path.join(temporary, "runtime"),
    evidence,
  ));
  console.log(`Frozen runtime copied; evidence ${evidence}`);
  stage = "fixture-setup";
  const extension = path.join(temporary, "extension");
  await mkdir(extension);
  await execute("unzip", ["-q", archive, "-d", extension]);
  const manifest = JSON.parse(
    await readFile(path.join(extension, "manifest.json"), "utf8"),
  );
  if (manifest.version !== version)
    throw new Error("Pinned extension manifest mismatch");
  loginFixture = await startLoginFixture();
  filters = createServer((request, response) => {
    if (request.url === "/resources.json") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ scriptlets: [], redirects: [] }));
      return;
    }
    response.setHeader("Content-Type", "text/plain");
    response.end(
      "[Adblock Plus 2.0]\n/invented-never-requested-addon-fixture$script\n",
    );
  });
  await new Promise((resolve) => filters.listen(0, "127.0.0.1", resolve));
  env = {
    ...process.env,
    COD_DATA_DIR: path.join(temporary, "data"),
    COD_SOCKET_PATH: path.join(temporary, "app.sock"),
    COD_BITWARDEN_EXTENSION_PATH: extension,
    COD_ADBLOCK_RESOURCE_URL: `http://127.0.0.1:${filters.address().port}/resources.json`,
    COD_ADBLOCK_FILTER_LIST_URLS: JSON.stringify([
      `http://127.0.0.1:${filters.address().port}/filters`,
    ]),
  };
  stage = "app-launch";
  await launch();
  const workspace = await cli(
    "workspace",
    "create",
    "--name",
    "Invented integrated vault",
  );
  await cli("workspace", "focus", "--id", workspace.id);
  const browser = await cli(
    "browser",
    "open",
    "--workspace",
    workspace.id,
    "--url",
    loginFixture.url,
  );
  let extensionId;
  await expect
    .poll(
      async () => {
        const state = await cli("browser", "inspect", "--id", browser.id);
        extensionId = state.addons.bitwarden.extensionId;
        return state.addons.bitwarden.status;
      },
      { timeout: 20000 },
    )
    .toBe("ready");
  if (!extensionId) throw new Error("Ready extension has no ID");
  stage = "extension-login";
  let vault = await popup(browser.paneId, extensionId);
  await vault.getByRole("button", { name: "Log in", exact: true }).click();
  await vault
    .getByRole("button", { name: "bitwarden.com", exact: true })
    .click();
  await vault.getByText("self-hosted", { exact: true }).click();
  await vault
    .locator("#self_hosted_env_settings_form_input_base_url")
    .fill("https://localhost:18781");
  await vault.getByRole("button", { name: "Save", exact: true }).click();
  await vault.locator("#email").fill(account.email);
  await vault.getByRole("button", { name: "Continue", exact: true }).click();
  await vault.locator("#masterPassword").fill(account.password);
  await vault.getByRole("button", { name: "Log in", exact: true }).click();
  await vault.getByText("Generator", { exact: true }).click();
  const generated = () =>
    vault
      .locator("bit-color-password [data-password-character]")
      .allTextContents()
      .then((chars) => chars.join(""));
  const before = await generated();
  await vault
    .getByRole("button", { name: "Generate password", exact: true })
    .click();
  await expect.poll(async () => (await generated()) !== before).toBe(true);
  const password = await generated();
  if (!password) throw new Error("Generator produced no password");
  results.push("real-ui-login-and-generation");
  await vault.getByText("Vault", { exact: true }).click();
  if (await vault.getByText("New login", { exact: true }).count())
    await vault.getByText("New login", { exact: true }).click();
  else {
    await vault.getByText("Add", { exact: true }).click();
    await vault.getByText("Login", { exact: true }).click();
  }
  const item = `Cod integrated ${path.basename(evidence)}`;
  await vault.getByLabel("Item name", { exact: false }).fill(item);
  await vault.getByLabel("Username", { exact: true }).fill("cod-invented-user");
  await vault.getByLabel("Password", { exact: true }).fill(password);
  await vault
    .getByLabel("Website (URI)", { exact: false })
    .fill(loginFixture.url);
  await vault.getByRole("button", { name: "Save", exact: true }).click();
  await expect(vault.getByText(item, { exact: true }).first()).toBeVisible();
  results.push("manual-vault-save");
  stage = "post-unlock-reload";
  await cli("browser", "reload", "--id", browser.id);
  results.push("post-unlock-page-reload");
  stage = "reopen-saved-item-popup";
  vault = await popup(browser.paneId, extensionId);
  stage = "saved-item-hover";
  diagnostics.savedItemMatches = await vault
    .getByText(item, { exact: true })
    .count();
  diagnostics.activeTab = await vault.evaluate(async (expected) => {
    const tabs = await globalThis.chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return {
      count: tabs.length,
      matchesFixture: tabs.some((tab) => tab.url?.startsWith(expected)),
    };
  }, loginFixture.url);
  diagnostics.initialAutofillButtons = await vault
    .getByRole("button", { name: /^Autofill - / })
    .count();
  const fillName = `Autofill - ${item} - cod-invented-user`;
  await vault.getByText(item, { exact: true }).first().hover();
  stage = "saved-item-autofill-button";
  diagnostics.hoveredAutofillButtons = await vault
    .getByRole("button", { name: /^Autofill - / })
    .count();
  await vault.getByRole("button", { name: fillName, exact: true }).click();
  let page = await nativePage(loginFixture.url);
  async function verifyFill() {
    // A boolean-only assertion prevents Playwright diffs from logging credentials.
    await expect
      .poll(
        async () =>
          (await page.getByLabel("Username").inputValue()) ===
            "cod-invented-user" &&
          (await page.getByLabel("Password").inputValue()) === password,
      )
      .toBe(true);
  }
  stage = "content-script-fill-values";
  await verifyFill();
  results.push("real-content-script-autofill");
  stage = "restart-unlock";
  await app.close();
  app = undefined;
  await launch();
  await cli("workspace", "focus", "--id", workspace.id);
  vault = await popup(browser.paneId, extensionId);
  await vault
    .getByLabel("Master password", { exact: false })
    .fill(account.password);
  await vault.getByRole("button", { name: "Unlock", exact: true }).click();
  await vault.getByText(item, { exact: true }).first().hover();
  await vault.getByRole("button", { name: fillName, exact: true }).click();
  page = await nativePage(loginFixture.url);
  await verifyFill();
  results.push("process-restart-ui-unlock-and-autofill");
  await writeFile(
    path.join(evidence, "result.json"),
    JSON.stringify(
      {
        status: "PASS",
        version,
        archiveHash,
        diagnostics,
        checks: results,
        automaticPageCapture: "NOT_ESTABLISHED",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`PASS integrated extension flow; sanitized evidence ${evidence}`);
} catch (error) {
  if (stage === "app-launch")
    diagnostics.launchError = String(error?.message ?? error).slice(0, 4000);
  await writeFile(
    path.join(evidence, "result.json"),
    JSON.stringify(
      {
        status:
          stage === "runtime-freeze" || stage === "fixture-setup"
            ? "BLOCKED"
            : "FAIL",
        stage,
        diagnostics,
        checks: results,
        errorType: error?.constructor?.name ?? "Error",
      },
      null,
      2,
    ) + "\n",
  );
  // Locator errors can contain input values or vault content; keep raw errors private in memory.
  console.error(
    `FAIL integrated extension flow at ${stage}; sanitized evidence ${evidence}`,
  );
  process.exitCode = 1;
} finally {
  await app?.close();
  await loginFixture?.close();
  if (filters) await new Promise((resolve) => filters.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
