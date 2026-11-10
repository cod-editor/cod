import { spawn } from "node:child_process";
const suites = {
  browser: "tests/browser/run.mjs",
  "agent-pages": "tests/agent-pages/run.mjs",
  terminals: "tests/support/terminals/run-service.mjs",
};
const selected = process.argv.slice(2);
for (const name of selected.length ? selected : Object.keys(suites)) {
  if (!Object.hasOwn(suites, name))
    throw new Error(`Unknown service suite: ${name}`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [suites[name]], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${name} failed (${signal ?? code})`)),
    );
  });
}
