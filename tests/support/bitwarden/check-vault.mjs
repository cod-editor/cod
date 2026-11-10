import { fixturePath } from "./paths.mjs";
import https from "node:https";
import { readFileSync } from "node:fs";
const base = "https://localhost:18781";
const ca = readFileSync(fixturePath("certs/localhost.crt"));
for (const path of ["/alive", "/api/config", "/"]) {
  await new Promise((resolve, reject) => {
    https
      .get(base + path, { ca }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          if (response.statusCode !== 200)
            return reject(new Error(`${path}: HTTP ${response.statusCode}`));
          if (
            path === "/api/config" &&
            JSON.parse(body).environment?.vault !== base
          )
            return reject(new Error("Unexpected vault origin"));
          console.log(`PASS ${path}: HTTP ${response.statusCode}`);
          resolve();
        });
      })
      .on("error", reject);
  });
}
