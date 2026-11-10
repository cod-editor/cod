import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const output = path.join(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["electron", "@homebridge/node-pty-prebuilt-multiarch"],
};

await Promise.all([
  build({
    ...shared,
    external: [
      ...shared.external,
      "electron-chrome-extensions",
      "@ghostery/adblocker-electron",
    ],
    entryPoints: ["src/main.ts"],
    outfile: "dist/main.cjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/preload.ts"],
    outfile: "dist/preload.cjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/agent-pages/preload.ts"],
    outfile: "dist/agent-page-preload.cjs",
  }),
  build({ ...shared, entryPoints: ["src/cli.ts"], outfile: "dist/cli.cjs" }),
  build({
    entryPoints: ["src/renderer.ts"],
    outfile: "dist/renderer.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome130",
    sourcemap: true,
  }),
  build({
    entryPoints: ["src/preview.ts"],
    outfile: "dist/preview.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome130",
    sourcemap: true,
  }),
  copyFile("src/preview.html", "dist/preview.html"),
  copyFile("src/preview.css", "dist/preview.css"),
  copyFile("src/index.html", "dist/index.html"),
  copyFile("src/styles.css", "dist/styles.css"),
  copyFile("src/scrollbars.css", "dist/scrollbars.css"),
  copyFile("assets/cod-icon.png", "dist/cod-icon.png"),
  copyFile("node_modules/@xterm/xterm/css/xterm.css", "dist/xterm.css"),
]);
