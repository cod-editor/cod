#!/usr/bin/env node
// Freeze through the ordinary runner, then transport the immutable input over SSH.
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tooling = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
let repo = process.cwd();
const children = new Set();
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
])
  process.once(signal, () => {
    for (const child of children) child.kill(signal);
    process.exit(code);
  });
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const sshOptions = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=10",
  "-o",
  "ServerAliveCountMax=3",
];
async function command(file, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: repo,
      stdio: ["pipe", "pipe", "inherit"],
      ...options,
    });
    children.add(child);
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      output += data;
      if (output.length > 4 * 1024 * 1024) child.kill();
    });
    child.on("error", (error) => {
      children.delete(child);
      reject(error);
    });
    child.on("close", (code) => {
      children.delete(child);
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `${file} failed (${code}); any accepted remote run is retained`,
            ),
          );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
const bootstrap = `
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
(async () => {
 const [id, mode] = process.argv.slice(2);
 if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw Error('Invalid run ID');
 const root = path.join(os.homedir(), '.cod-electron-tests'), marker = 'Cod finite SSH test jobs v1\\n';
 const stat = await fs.lstat(root).catch(e => { if(e.code !== 'ENOENT') throw e; });
 if (stat && (!stat.isDirectory() || await fs.readFile(path.join(root,'.owner'),'utf8').catch(()=> '') !== marker)) throw Error('Remote root exists and is not owned by this helper');
 if (!stat) {
  if (mode !== 'create') throw Error('No remote runs exist');
  await fs.mkdir(root, {mode:448}); await fs.writeFile(path.join(root,'.owner'), marker, {flag:'wx',mode:384});
 }
 await fs.mkdir(path.join(root,'runs'),{recursive:true});
 const run = path.join(root,'runs',id);
 let previous;
 if (mode === 'create') {
  const entries = await fs.readdir(path.join(root,'runs'));
  let pending=0;
  for(const name of entries) if (/^[0-9a-f-]{36}$/.test(name) && !await fs.access(path.join(root,'runs',name,'result.json')).then(()=>true,()=>false)) pending++;
  if(pending >= 4) throw Error('Four remote runs already pending; retrieve or inspect them first');
  await fs.mkdir(run); await fs.mkdir(path.join(run,'source'));
  const saved = await fs.readFile(path.join(root,'previous-source.json'),'utf8').then(JSON.parse,()=>null);
  if(saved && /^[0-9a-f-]{36}$/.test(saved.id)) {
   const candidate=path.join(root,'runs',saved.id,'source');
   if(await fs.stat(candidate).then(s=>s.isDirectory(),()=>false)) previous=candidate;
  }
 }
 console.log(JSON.stringify({root,run,previous}));
})().catch(e=>{console.error(String(e));process.exitCode=1});
`;
async function noSymlinks(directory, total = { bytes: 0 }) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new Error("Remote input cannot contain source symlinks");
    if (entry.isDirectory())
      await noSymlinks(path.join(directory, entry.name), total);
    else if (entry.isFile()) {
      total.bytes += (await fs.stat(path.join(directory, entry.name))).size;
      if (total.bytes > 64 * 1024 * 1024)
        throw new Error("Remote source exceeds 64 MiB");
    }
  }
}
async function trimLocalEvidence(current) {
  const base = path.join(repo, "artifacts/remote-verification"),
    complete = [];
  for (const id of await fs.readdir(base)) {
    if (!/^[0-9a-f-]{36}$/.test(id)) continue;
    const result = await fs
      .readFile(path.join(base, id, "result.json"), "utf8")
      .then(JSON.parse, () => null);
    if (result) complete.push({ id, result });
  }
  complete.sort((a, b) => b.result.finished.localeCompare(a.result.finished));
  for (const { id } of complete.slice(3)) {
    if (id === current) continue;
    const record = await fs
      .readFile(path.join(base, id, "request.json"), "utf8")
      .then(JSON.parse, () => null);
    const frozen = record?.frozen;
    if (
      frozen?.startsWith(
        path.join(repo, "artifacts/verification") + path.sep,
      ) &&
      (await fs
        .readFile(path.join(frozen, ".remote-owned"), "utf8")
        .catch(() => "")) === id
    )
      await fs.rm(frozen, { recursive: true });
    await fs.rm(path.join(base, id), { recursive: true });
  }
}
async function main() {
  const values = process.argv.slice(2);
  let host = process.env.COD_TEST_SSH_HOST,
    id,
    noWait = false,
    config;
  while (values.length && values[0] !== "--") {
    const option = values[0];
    if (option === "--source") {
      values.shift();
      repo = path.resolve(values.shift());
    } else if (option === "--host") {
      values.shift();
      host = values.shift();
    } else if (option === "--result") {
      values.shift();
      id = values.shift();
    } else if (option === "--config") {
      values.shift();
      config = values.shift();
    } else if (option === "--no-wait") {
      values.shift();
      noWait = true;
    } else break;
  }
  if (values[0] === "--") values.shift();
  if (!host && config)
    host = JSON.parse(await fs.readFile(config, "utf8")).host;
  if (typeof host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host))
    throw new Error(
      "Provide a configured SSH alias with --host, --config or COD_TEST_SSH_HOST",
    );
  if (
    id &&
    (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) || values.length)
  )
    throw new Error("Result retrieval requires only a valid run ID");
  if (values.includes("--freeze-only"))
    throw new Error("--freeze-only is reserved for input preparation");
  const creating = !id;
  id ??= randomUUID();
  const local = path.join(repo, "artifacts/remote-verification", id);
  await fs.mkdir(local, { recursive: true, mode: 0o700 });
  if (creating)
    console.log(`Remote run prepared: ${id}; local evidence: ${local}`);
  const ssh = (text, input) =>
    command("ssh", [...sshOptions, host, text], input);
  let expected, frozen;
  if (creating) {
    const prepared = await command(
      path.join(tooling, "scripts/verify-electron-linux.sh"),
      ["--freeze-only"],
      undefined,
      { env: { ...process.env, COD_TEST_SOURCE_DIR: repo } },
    );
    frozen = /^Frozen input and evidence: (.+)$/m.exec(prepared)?.[1];
    if (
      !frozen ||
      !frozen.startsWith(path.join(repo, "artifacts/verification") + path.sep)
    )
      throw new Error("Input freeze returned an unexpected path");
    await noSymlinks(path.join(frozen, "input"));
    await fs.writeFile(path.join(frozen, ".remote-owned"), id, { flag: "wx" });
    const manifest = await fs.readFile(
      path.join(frozen, "input-sha256.txt"),
      "utf8",
    );
    expected = createHash("sha256")
      .update(manifest.trim().split("\n").sort().join("\n") + "\n")
      .digest("hex");
    await fs.writeFile(
      path.join(local, "request.json"),
      JSON.stringify({ id, host, frozen, expected, args: values }, null, 2) +
        "\n",
      { mode: 0o600 },
    );
  }
  const locations = JSON.parse(
    await ssh(`node - ${quote(id)} ${creating ? "create" : "read"}`, bootstrap),
  );
  const worker = path.posix.join(locations.run, "remote-electron-worker.mjs");
  const invoke = (mode, input) =>
    ssh(`node ${quote(worker)} ${mode} ${quote(id)}`, input);
  if (creating) {
    const transport = "ssh " + sshOptions.map(quote).join(" ");
    const args = [
      "-a",
      "--delete",
      "-e",
      transport,
      ...(locations.previous ? [`--link-dest=${locations.previous}`] : []),
      path.join(frozen, "input") + "/",
      `${host}:${quote(locations.run + "/source/")}`,
    ];
    await command("rsync", args);
    await command("rsync", [
      "-a",
      "-e",
      transport,
      path.join(frozen, "input-sha256.txt"),
      `${host}:${quote(locations.run + "/expected-sha256.txt")}`,
    ]);
    await command("rsync", [
      "-a",
      "-e",
      transport,
      path.join(tooling, "scripts/remote-electron-worker.mjs"),
      path.join(tooling, "scripts/verify-electron-linux.sh"),
      `${host}:${quote(locations.run + "/")}`,
    ]);
    const accepted = JSON.parse(await invoke("start", JSON.stringify(values)));
    if (accepted.id !== id || !accepted.accepted)
      throw new Error("Remote acceptance did not match the input");
    console.log(`Remote run accepted: ${id}`);
    console.log(`Local evidence: ${local}`);
    if (noWait) return;
  } else {
    expected = await fs
      .readFile(path.join(local, "request.json"), "utf8")
      .then(JSON.parse)
      .then((x) => x.expected)
      .catch(() => undefined);
  }
  const result = JSON.parse(await invoke("result"));
  if (result.id !== id) throw new Error("Result does not match requested run");
  const transport = "ssh " + sshOptions.map(quote).join(" ");
  await command("rsync", [
    "-a",
    "-e",
    transport,
    `${host}:${quote(locations.run + "/evidence/")}`,
    local + "/",
  ]);
  await fs.writeFile(
    path.join(local, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      id,
      exitCode: result.exitCode,
      inputIdentity: result.inputIdentity,
      durationMs: result.durationMs,
      omittedEvidenceFiles: result.omittedEvidenceFiles,
      evidence: local,
    }),
  );
  await trimLocalEvidence(id);
  if (expected && result.inputIdentity !== expected)
    throw new Error(
      "Result input identity differs from accepted source; retained evidence must be inspected",
    );
  if (result.error) console.error(result.error);
  process.exitCode = result.exitCode;
}
main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
