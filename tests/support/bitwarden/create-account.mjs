import { fixturePath } from "./paths.mjs";
import { chromium } from "@playwright/test";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

mkdirSync(fixturePath(), { recursive: true, mode: 0o700 });
const accountPath = fixturePath("account.json");
const account = existsSync(accountPath)
  ? JSON.parse(readFileSync(accountPath, "utf8"))
  : {
      url: "https://localhost:18781",
      email: "cod-fixture@example.test",
      password: `Cod-Fixture-${randomBytes(18).toString("base64url")}`,
      created: false,
    };
writeFileSync(accountPath, JSON.stringify(account, null, 2) + "\n", {
  mode: 0o600,
});
const executablePath = process.env.CHROME_PATH || undefined;
const browser = await chromium.launch({ executablePath, headless: true });
try {
  // This is an isolated local fixture context, not Cod's production browser.
  let page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "localhost"
      ? route.continue()
      : route.abort(),
  );
  await page.goto(account.url);
  if (!account.created) {
    await page
      .getByRole("link", { name: "Create account", exact: true })
      .click();
    await page.locator("#register-start_form_input_email").fill(account.email);
    await page.locator("#register-start_form_input_name").fill("Cod Fixture");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .locator("#input-password-form_new-password")
      .fill(account.password);
    await page
      .locator("#input-password-form_new-password-confirm")
      .fill(account.password);
    await page.locator("#input-password-form_check-for-breaches").uncheck();
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await page.getByRole("button", { name: "Log in", exact: true }).waitFor();
    account.created = true;
    writeFileSync(accountPath, JSON.stringify(account, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log("PASS invented local fixture account created");
  }
  await page.close();
  page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "localhost"
      ? route.continue()
      : route.abort(),
  );
  await page.goto(account.url);
  await page.getByLabel("Email address", { exact: false }).fill(account.email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  const onboarding = page.getByText("Add it later", { exact: true });
  await Promise.race([onboarding.waitFor(), page.waitForURL("**/#/vault")]);
  if (await onboarding.isVisible()) {
    await onboarding.click();
    await page.getByText("Skip to web app", { exact: true }).click();
  }
  await page.waitForURL("**/#/vault", { timeout: 15000 });
  console.log("PASS fixture vault login through real Chrome UI");
  console.log(
    "Credentials remain in ignored .fixture-account.json; no browser profile persisted",
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replaceAll(account.password, "<fixture-password>"));
  process.exitCode = 1;
} finally {
  await browser.close();
}
