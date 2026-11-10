import { _electron } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.platform !== "linux" || process.getuid() === 0)
  throw new Error("Sandbox verification requires nonroot Linux");
const fixture = await mkdtemp(path.join(os.tmpdir(), "cod-sandbox-"));
let app;
try {
  app = await _electron.launch({
    args: [
      path.resolve("dist/main.cjs"),
      `--user-data-dir=${path.join(fixture, "chromium")}`,
    ],
    chromiumSandbox: true,
    env: {
      ...process.env,
      COD_DATA_DIR: path.join(fixture, "data"),
      COD_SOCKET_PATH: path.join(fixture, "app.sock"),
    },
  });
  const page = await app.firstWindow();
  await page
    .getByRole("button", { name: "Switch workspace", exact: true })
    .waitFor();
  const renderers = await app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === "window")
      .map((contents) => {
        const preferences = contents.getLastWebPreferences();
        return {
          pid: contents.getOSProcessId(),
          sandbox: preferences.sandbox,
          contextIsolation: preferences.contextIsolation,
          nodeIntegration: preferences.nodeIntegration,
        };
      }),
  );
  if (!renderers.length) throw new Error("No production renderer found");
  for (const renderer of renderers) {
    const status = await readFile(`/proc/${renderer.pid}/status`, "utf8");
    const command = await readFile(`/proc/${renderer.pid}/cmdline`, "utf8");
    const fields = Object.fromEntries(
      status
        .split("\n")
        .filter((line) => /^(Seccomp|Seccomp_filters|NoNewPrivs):/.test(line))
        .map((line) => line.split(":").map((value) => value.trim())),
    );
    if (
      !renderer.sandbox ||
      !renderer.contextIsolation ||
      renderer.nodeIntegration ||
      fields.Seccomp !== "2" ||
      fields.NoNewPrivs !== "1" ||
      command.split("\0").includes("--no-sandbox")
    )
      throw new Error(
        `Renderer sandbox verification failed: ${JSON.stringify({ ...renderer, ...fields })}`,
      );
    console.log(
      "PASS production renderer kernel sandbox",
      JSON.stringify({ ...renderer, ...fields }),
    );
  }
} finally {
  if (app) await app.close();
  await rm(fixture, { recursive: true, force: true });
}
