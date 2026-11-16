import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

test("CLI reads a fragmented large response with linear scan work and bounded memory", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cod-cli-large-"));
  const socket = path.join(temporary, "s");
  const size = 43 * 1024 * 1024;
  const chunk = "x".repeat(32768);
  const resourceFile = path.join(temporary, "resources.json");
  const preload = path.join(temporary, "scan-budget.mjs");
  await writeFile(
    preload,
    `
    import { writeFileSync } from 'node:fs';
    let scanned=0;
    const indexOf=String.prototype.indexOf;
    String.prototype.indexOf=function(search,position){
      if(search==='\\n') scanned+=this.length;
      return indexOf.call(this,search,position);
    };
    process.on('exit',()=>writeFileSync(process.env.COD_FIXTURE_RESOURCE_FILE,JSON.stringify({scanned,maxRssKiB:process.resourceUsage().maxRSS})));
  `,
  );
  const server = createServer((connection) => {
    connection.on("error", () => {});
    connection.once("data", () => {
      void (async () => {
        connection.write('{"ok":true,"result":{"fixture":"');
        for (let sent = 0; sent < size; sent += chunk.length) {
          if (!connection.write(chunk))
            await new Promise((resolve) => connection.once("drain", resolve));
        }
        connection.end('"}}\n');
      })();
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  try {
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(preload).href, "dist/cli.cjs", "state"],
      {
        env: {
          ...process.env,
          COD_SOCKET_PATH: socket,
          COD_FIXTURE_RESOURCE_FILE: resourceFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let bytes = 0,
      stderr = "";
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString().slice(0, 8192 - stderr.length);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    const result = await new Promise((resolve, reject) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });
    clearTimeout(timer);
    assert.equal(
      result.signal,
      null,
      "large response must finish within the fixture budget",
    );
    assert.equal(result.code, 0, stderr);
    assert.equal(bytes, size + Buffer.byteLength('{"fixture":""}\n'));
    const resources = JSON.parse(await readFile(resourceFile, "utf8"));
    assert.ok(
      resources.scanned < size * 2,
      `newline scans visited ${resources.scanned} characters for a ${size}-byte response`,
    );
    assert.ok(
      resources.maxRssKiB < 512 * 1024,
      `large response used ${resources.maxRssKiB} KiB RSS`,
    );
  } finally {
    server.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
