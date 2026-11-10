import { fixturePath } from "./paths.mjs";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { X509Certificate } from "node:crypto";
const directory = fixturePath("certs");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const certificate = `${directory}/localhost.crt`;
const key = `${directory}/localhost.key`;
if (!existsSync(certificate) || !existsSync(key)) {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "3",
      "-keyout",
      key,
      "-out",
      certificate,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
}
const parsed = new X509Certificate(readFileSync(certificate));
if (Date.parse(parsed.validTo) <= Date.now())
  throw new Error(
    "Fixture certificate expired; remove the disposable fixture certs directory and rerun preparation, then recreate the fixture container",
  );
console.log(`Local test certificate SHA256: ${parsed.fingerprint256}`);
