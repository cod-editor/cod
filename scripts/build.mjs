import { build } from "esbuild";
import { copyFile, mkdir, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  buildInfoName,
  newBuild,
  outputHashes,
  sourceHash,
} from "./build-info.mjs";

const root = process.cwd();
const output = path.join(root, "dist");
const identity = await newBuild(root);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: [
    "electron",
    "@homebridge/node-pty-prebuilt-multiarch",
    "@anthropic-ai/claude-agent-sdk",
  ],
  // Bundle the parser's static imports in both the app and standalone host.
  alias: { "jsonc-parser": "jsonc-parser/lib/esm/main.js" },
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
    define: {
      __COD_BUILD_ID__: JSON.stringify(identity.id),
      "import.meta.dirname": "__dirname",
      "import.meta.filename": "__filename",
    },
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
  build({
    ...shared,
    entryPoints: ["src/browser/address-overlay-preload.ts"],
    outfile: "dist/address-overlay-preload.cjs",
  }),
  build({ ...shared, entryPoints: ["src/cli.ts"], outfile: "dist/cli.cjs" }),
  build({
    ...shared,
    entryPoints: ["src/application/sqlite-state-worker.ts"],
    outfile: "dist/sqlite-state-worker.cjs",
  }),
  build({
    ...shared,
    entryPoints: ["src/provider-owner.ts"],
    define: {
      __COD_OWNER_BUILD__: JSON.stringify(identity.sourceHash.slice(0, 24)),
    },
    outfile: "dist/provider-owner.cjs",
  }),
  ...(process.platform === "linux"
    ? [
        build({
          ...shared,
          entryPoints: ["src/workspace-host.ts"],
          define: {
            "import.meta.dirname": "__dirname",
            "import.meta.filename": "__filename",
          },
          outfile: "dist/workspace-host.cjs",
        }),
      ]
    : []),
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
  copyFile("src/browser/address-overlay.html", "dist/address-overlay.html"),
  copyFile("src/preview.html", "dist/preview.html"),
  copyFile("src/preview.css", "dist/preview.css"),
  copyFile("src/index.html", "dist/index.html"),
  build({
    entryPoints: ["src/styles.css"],
    bundle: true,
    outfile: "dist/styles.css",
  }),
  copyFile("src/scrollbars.css", "dist/scrollbars.css"),
  copyFile("assets/cod-icon.png", "dist/cod-icon.png"),
  copyFile("node_modules/@xterm/xterm/css/xterm.css", "dist/xterm.css"),
]);
if ((await sourceHash(root)) !== identity.sourceHash)
  throw new Error("Source changed during build; rebuild from stable inputs");
await writeFile(
  path.join(output, buildInfoName + ".tmp"),
  JSON.stringify({
    schema: 1,
    build: identity,
    outputs: await outputHashes(output),
  }) + "\n",
);

await rename(
  path.join(output, buildInfoName + ".tmp"),
  path.join(output, buildInfoName),
);
