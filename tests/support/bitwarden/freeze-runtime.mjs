import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
async function manifest(root) {
  const hashes = {};
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile())
        hashes[file] = createHash("sha256")
          .update(await readFile(path.join(root, file)))
          .digest("hex");
      else throw new Error("Unexpected non-file build artifact");
    }
  }
  await walk("dist");
  await walk("runtime-skills");
  await walk("runtime-plugins");
  for (const name of ["package.json", "package-lock.json"])
    hashes[name] = createHash("sha256")
      .update(await readFile(path.join(root, name)))
      .digest("hex");
  return hashes;
}
export async function freezeRuntime(checkout, destination, evidence) {
  checkout = await realpath(checkout);
  const before = await manifest(checkout);
  await mkdir(destination, { recursive: true });
  destination = await realpath(destination);
  // COPYFILE_FICLONE avoids duplicating blocks on supported filesystems; the
  // copy remains independent if the checkout is subsequently rebuilt/reinstalled.
  for (const name of [
    "dist",
    "runtime-skills",
    "runtime-plugins",
    "node_modules",
    "package.json",
    "package-lock.json",
  ])
    await cp(path.join(checkout, name), path.join(destination, name), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
  const after = await manifest(checkout),
    copied = await manifest(destination);
  if (
    JSON.stringify(before) !== JSON.stringify(after) ||
    JSON.stringify(before) !== JSON.stringify(copied)
  )
    throw new Error("Build changed during runtime freeze");
  const require = createRequire(path.join(destination, "package.json"));
  const versions = {};
  for (const name of [
    "electron",
    "electron-chrome-extensions",
    "@ghostery/adblocker-electron",
  ])
    versions[name] = JSON.parse(
      await readFile(
        path.join(destination, "node_modules", name, "package.json"),
        "utf8",
      ),
    ).version;
  await writeFile(
    path.join(evidence, "runtime-input.json"),
    JSON.stringify({ hashes: copied, versions }, null, 2) + "\n",
  );
  return {
    root: destination,
    executablePath:
      process.env.COD_TEST_ELECTRON_EXECUTABLE || require("electron"),
  };
}
