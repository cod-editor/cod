#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const [name = "gallery", ...rest] = process.argv.slice(2);
const titles = new Map([
  ["gallery", "Cod component gallery"],
  ["workspace", "Cod workspace preview"],
]);
const title = titles.get(name);
if (!title || rest.length) {
  throw new Error(
    "Usage: node scripts/build-ui-preview.mjs [gallery|workspace]",
  );
}

const output = path.join(root, "artifacts", "ui-preview");
const { outputFiles } = await build({
  entryPoints: [
    path.join(root, "tests/support/ui-preview", `${name}.ts`),
    path.join(root, "tests/support/ui-preview/preview.css"),
  ],
  outdir: output,
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  target: "chrome130",
});
const script = outputFiles
  .find((file) => file.path.endsWith(".js"))
  .text.replace(/<\/script/gi, "<\\/script");
const styles = outputFiles
  .find((file) => file.path.endsWith(".css"))
  .text.replace(/<\/style/gi, "<\\/style");
const scriptHash = createHash("sha256").update(script).digest("base64");
const html = `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; form-action 'none'; base-uri 'none'">
  <title>${title}</title>
  <style>${styles}</style>
  <body>
    <script>${script}</script>
  </body>
</html>
`;
await mkdir(output, { recursive: true });
const file = path.join(output, `${name}.html`);
await writeFile(file, html);
console.log(file);
