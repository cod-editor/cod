// Same Check commands and shard boundaries, with independent fresh job directories.
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const groups = [
  {
    name: "Fast checks",
    minutes: 10,
    graphical: false,
    commands: [
      ["npm", "run", "check"],
      ["npm", "run", "build"],
      ["npm", "run", "test:unit"],
    ],
  },
  {
    name: "Service tests",
    minutes: 10,
    graphical: true,
    commands: [
      ["npm", "run", "build"],
      ["xvfb-run", "-a", "node", "tests/support/electron/check-sandbox.mjs"],
      ["xvfb-run", "-a", "node", "tests/support/electron/run-services.mjs"],
    ],
  },
  ...[1, 2, 3].map((shard) => ({
    name: `Electron shard ${shard}/3`,
    minutes: 20,
    graphical: true,
    commands: [
      ["npm", "run", "build"],
      ["xvfb-run", "-a", "node", "tests/support/electron/check-sandbox.mjs"],
      [
        "xvfb-run",
        "-a",
        "npm",
        "run",
        "test:e2e",
        "--",
        `--shard=${shard}/3`,
        "--workers=1",
      ],
    ],
  })),
];
export function validateWorkflow(text) {
  const commands = [...text.matchAll(/^      - run: (.+)$/gm)].map(
    (match) => match[1],
  );
  const expected = [
    "npm ci --ignore-scripts",
    "npm run check",
    "npm run build",
    "npm run test:unit",
    "npm ci --ignore-scripts",
    "node node_modules/electron/install.js",
    "npm run build",
    "xvfb-run -a node tests/support/electron/check-sandbox.mjs",
    "xvfb-run -a node tests/support/electron/run-services.mjs",
    "npm ci --ignore-scripts",
    "node node_modules/electron/install.js",
    "npm run build",
    "xvfb-run -a node tests/support/electron/check-sandbox.mjs",
    "xvfb-run -a npm run test:e2e -- --shard=${{ matrix.shard }}/3 --workers=1",
  ];
  if (
    JSON.stringify(commands) !== JSON.stringify(expected) ||
    !/shard: \[1, 2, 3\]/.test(text) ||
    !/fail-fast: false/.test(text) ||
    !/node-version: 24/.test(text)
  )
    throw new Error(
      "Check workflow changed; update the full preflight plan before using it",
    );
}
export async function executeGroups(execute) {
  const results = [];
  for (const group of groups) {
    if (results[0]?.status === "FAIL") {
      results.push({ name: group.name, status: "SKIP" });
      continue;
    }
    const started = Date.now();
    try {
      await execute(group);
      results.push({
        name: group.name,
        status: "PASS",
        durationMs: Date.now() - started,
      });
    } catch (error) {
      results.push({
        name: group.name,
        status: "FAIL",
        durationMs: Date.now() - started,
      });
      console.error(`${group.name} failed: ${String(error)}`);
    }
  }
  return results;
}
async function command(file, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: "inherit", detached: true });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error(`${file} exited ${signal ?? code}`));
    });
  });
}
async function main() {
  const [input, output] = process.argv.slice(2);
  if (
    !input ||
    !output ||
    process.platform !== "linux" ||
    process.getuid?.() !== 0
  )
    throw new Error(
      "Full preflight runs only inside the isolated Linux container",
    );
  validateWorkflow(
    await readFile(path.join(input, ".github/workflows/check.yml"), "utf8"),
  );
  const results = await executeGroups(async (group) => {
    const directory = path.join(
      "/work/jobs",
      group.name.replaceAll(/[^a-zA-Z0-9]/g, "-"),
    );
    await mkdir(directory, { recursive: true });
    await cp(input, directory, { recursive: true });
    const deadline = Date.now() + group.minutes * 60_000;
    const run = (file, args) =>
      command(file, args, directory, Math.max(1, deadline - Date.now()));
    console.log(`PREFLIGHT ${group.name}`);
    await run("npm", ["ci", "--ignore-scripts"]);
    if (group.graphical)
      await run("node", ["node_modules/electron/install.js"]);
    await run("chown", ["-R", "node:node", directory, output]);
    if (group.graphical) {
      const sandbox = path.join(
        directory,
        "node_modules/electron/dist/chrome-sandbox",
      );
      await run("chown", ["root:root", sandbox]);
      await chmod(sandbox, 0o4755);
    }
    try {
      for (const [file, ...args] of group.commands)
        await run("runuser", ["-u", "node", "--", file, ...args]);
    } finally {
      for (const name of [
        "test-results",
        "artifacts/services",
        "artifacts/terminals",
      ]) {
        await cp(
          path.join(directory, name),
          path.join(output, path.basename(directory), name),
          { recursive: true },
        ).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  });
  const environment = {
    node: process.version,
    platform: process.platform,
    osRelease: (await readFile("/etc/os-release", "utf8"))
      .split("\n")
      .filter((line) => /^(ID|VERSION_ID)=/.test(line)),
  };
  await writeFile(
    path.join(output, "preflight.json"),
    JSON.stringify({ mode: "full-ci", environment, results }, null, 2) + "\n",
  );
  // Copied directories are created by the container's root orchestrator; the
  // unprivileged host collector must be able to remove them after retrieval.
  await command("chown", ["-R", "node:node", output], "/work", 30_000);
  if (results.some((result) => result.status !== "PASS")) process.exitCode = 1;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
