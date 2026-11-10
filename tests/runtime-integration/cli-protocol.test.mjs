import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
async function fixture(run, reply) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cod-cli-"));
  const socket = path.join(temporary, "s");
  let connections = 0;
  const server = createServer((connection) => {
    connections++;
    connection.on("error", () => {});
    connection.once("data", () =>
      connection.end(reply ?? '{"ok":true,"result":{}}\n'),
    );
  });
  await new Promise((r) => server.listen(socket, r));
  try {
    await run(
      async (args) => {
        const child = spawn(process.execPath, ["dist/cli.cjs", ...args], {
          env: { ...process.env, COD_SOCKET_PATH: socket },
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (c) => (stdout += c));
        child.stderr.on("data", (c) => (stderr += c));
        const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        const result = await new Promise((r) =>
          child.once("exit", (code, signal) =>
            r({ code, signal, stdout, stderr }),
          ),
        );
        clearTimeout(timer);
        return result;
      },
      () => connections,
    );
  } finally {
    await new Promise((r) => server.close(r));
    await rm(temporary, { recursive: true, force: true });
  }
}
test("CLI rejects malformed/reserved/duplicate/numeric flags before connecting", async () =>
  fixture(async (run, count) => {
    const cases = [
      [
        "workspace",
        "create",
        "--name",
        "fixture",
        "--op",
        "workspace.close",
        "--id",
        "existing",
      ],
      ["workspace", "create", "--name", "one", "--name", "two"],
      ["workspace", "create", "--name", "fixture", "--unknown", "value"],
      ["workspace", "create", "--name"],
      ["workspace", "not-real"],
      ["pane", "resize", "--workspace", "w", "--id", "p", "--ratio", "NaN"],
      ["pane", "resize", "--workspace", "w", "--id", "p", "--ratio", "2"],
      ["terminal", "resize", "--id", "t", "--cols", "1.5", "--rows", "30"],
      ["terminal", "resize", "--id", "t", "--cols", "0", "--rows", "30"],
    ];
    for (const args of cases) {
      const result = await run(args);
      assert.notEqual(result.code, 0, JSON.stringify(args));
      assert.equal(result.signal, null);
      assert.equal(typeof JSON.parse(result.stderr).error, "string");
    }
    assert.equal(count(), 0, "invalid operations must never reach socket");
  }));
for (const [name, reply] of [
  ["malformed", "not-json\n"],
  ["invalid envelope", "{}\n"],
  ["empty EOF", ""],
  ["empty frame", "\n"],
  ["overlong", "x".repeat(9 * 1024 * 1024)],
]) {
  test(`CLI bounds ${name} response`, async () =>
    fixture(async (run) => {
      const result = await run(["state"]);
      assert.notEqual(result.code, 0);
      assert.equal(result.signal, null, "must finish before fixture deadline");
      assert.equal(result.stdout, "");
      assert.equal(typeof JSON.parse(result.stderr).error, "string");
    }, reply));
}
