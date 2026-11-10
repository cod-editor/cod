import { fixturePath } from "./paths.mjs";
import { chromium } from "@playwright/test";
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const certificate = new X509Certificate(
  readFileSync(fixturePath("certs/localhost.crt")),
);
const spki = createHash("sha256")
  .update(certificate.publicKey.export({ type: "spki", format: "der" }))
  .digest("base64");
const executablePath = process.env.CHROME_PATH || undefined;
for (const [name, args, expected] of [
  ["default rejects self-signed fixture", [], false],
  [
    "wrong SPKI rejects fixture",
    [
      `--ignore-certificate-errors-spki-list=${Buffer.alloc(32).toString("base64")}`,
    ],
    false,
  ],
  [
    "fixture SPKI accepts fixture",
    [`--ignore-certificate-errors-spki-list=${spki}`],
    true,
  ],
]) {
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args,
  });
  try {
    const page = await browser.newPage();
    let accepted = false;
    try {
      accepted =
        (await page.goto("https://localhost:18781/alive"))?.status() === 200;
    } catch (error) {
      if (!String(error).includes("ERR_CERT_AUTHORITY_INVALID")) throw error;
    }
    if (accepted !== expected) throw new Error(`FAIL ${name}`);
    console.log(`PASS ${name}`);
  } finally {
    await browser.close();
  }
}
