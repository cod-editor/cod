import { fixturePath } from "./paths.mjs";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
execFileSync("docker", ["compose", "down", "--volumes"], {
  cwd: fileURLToPath(new URL(".", import.meta.url)),
  stdio: "inherit",
});
rmSync(fixturePath("account.json"), { force: true });
