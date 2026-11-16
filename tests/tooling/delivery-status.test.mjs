import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOutputs,
  outputHashes,
  sourceHash,
} from "../../scripts/build-info.mjs";
import {
  checkedMerge,
  deliveryStatus,
} from "../../scripts/delivery-status.mjs";
const run = promisify(execFile);
const tool = fileURLToPath(
  new URL("../../scripts/delivery-status.mjs", import.meta.url),
);
async function fixture() {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "PRIVATE_DELIVERY_PROFILE-"),
  );
  const repo = path.join(temp, "repo");
  await mkdir(repo);
  const git = async (...args) =>
    (await run("git", ["-C", repo, ...args])).stdout.trim();
  await git("init", "--initial-branch=master");
  await git("config", "user.name", "Invented fixture");
  await git("config", "user.email", "fixture@example.invalid");
  for (const folder of ["src", "assets", "scripts", "dist"])
    await mkdir(path.join(repo, folder));
  for (const name of ["package.json", "package-lock.json", "tsconfig.json"])
    await writeFile(path.join(repo, name), '{"version":"0.0.0"}');
  for (const name of [
    "src/main.ts",
    "assets/icon.png",
    "scripts/build.mjs",
    "scripts/build-info.mjs",
    "README.md",
  ])
    await writeFile(path.join(repo, name), "invented initial input");
  await writeFile(path.join(repo, ".gitignore"), "dist/\n");
  const commit = async () => {
    await git("add", ".");
    await git("commit", "-m", "Change invented fixture");
    return git("rev-parse", "HEAD");
  };
  await commit();
  const build = async (live, cli) => {
    const info = {
      id: randomUUID(),
      sourceHash: await sourceHash(repo),
      revision: await git("rev-parse", "HEAD"),
      dirty: !!(await git("status", "--porcelain")),
      version: "0.0.0",
    };
    for (const name of buildOutputs)
      await writeFile(
        path.join(repo, "dist", name),
        "invented output " + info.id,
      );
    await writeFile(
      path.join(repo, "dist/cli.cjs"),
      cli ??
        `if(process.argv[2]!=='capabilities')throw Error('PRIVATE_STATE_REQUEST');process.stdout.write(${JSON.stringify(JSON.stringify({ runtime: { build: live ?? info }, privatePath: temp }))});`,
    );
    await writeFile(
      path.join(repo, "dist/build-info.json"),
      JSON.stringify({
        schema: 1,
        build: info,
        outputs: await outputHashes(path.join(repo, "dist")),
      }),
    );
    return info;
  };
  return {
    temp,
    repo,
    git,
    commit,
    build,
    close: () => rm(temp, { recursive: true, force: true }),
  };
}
function payload(tip, head = tip) {
  const nodes = [
    "Fast checks",
    "Service tests",
    "Electron shard 1/3",
    "Electron shard 2/3",
    "Electron shard 3/3",
    "e2e",
  ].map((name) => ({ name, status: "COMPLETED", conclusion: "SUCCESS" }));
  const pr = {
    number: 123,
    merged: true,
    mergeCommit: { oid: tip },
    headRefOid: head,
    commits: {
      nodes: [
        {
          commit: {
            oid: head,
            statusCheckRollup: {
              contexts: { pageInfo: { hasNextPage: false }, nodes },
            },
          },
        },
      ],
    },
  };
  return {
    data: {
      repository: {
        defaultBranchRef: {
          name: "master",
          target: { oid: tip, associatedPullRequests: { nodes: [pr] } },
        },
      },
    },
  };
}
test("offline status separates source/build/runtime and leaves Git, outputs and private paths untouched", async () => {
  const f = await fixture();
  try {
    const first = await f.build(),
      before = await readFile(path.join(f.repo, ".git/index")),
      marker = await readFile(path.join(f.repo, "dist/build-info.json"));
    const r = await deliveryStatus({ repo: f.repo, offline: true });
    assert.equal(r.latestChecked.status, "UNKNOWN");
    assert.equal(r.checkout.dirty, false);
    assert.equal(r.built.build.id, first.id);
    assert.equal(r.running.build.id, first.id);
    assert.deepEqual(r.actions, {
      fetch: "UNKNOWN",
      build: "NO",
      restart: "NO",
    });
    assert.ok(!JSON.stringify(r).includes(f.temp));
    assert.deepEqual(await readFile(path.join(f.repo, ".git/index")), before);
    assert.deepEqual(
      await readFile(path.join(f.repo, "dist/build-info.json")),
      marker,
    );
  } finally {
    await f.close();
  }
});
test("checkout movement and dirty code require build; a new build does not update an old live entry", async () => {
  const f = await fixture();
  try {
    const first = await f.build();
    await writeFile(path.join(f.repo, "src/main.ts"), "changed source");
    let r = await deliveryStatus({ repo: f.repo, offline: true });
    assert.equal(r.checkout.dirty, true);
    assert.equal(r.actions.build, "YES");
    assert.equal(r.actions.restart, "NO");
    const revision = await f.commit();
    r = await deliveryStatus({ repo: f.repo, offline: true });
    assert.equal(r.checkout.revision, revision);
    assert.notEqual(r.built.build.revision, revision);
    assert.equal(r.actions.build, "YES");
    const next = await f.build(first);
    r = await deliveryStatus({ repo: f.repo, offline: true });
    assert.equal(r.built.build.id, next.id);
    assert.equal(r.running.build.id, first.id);
    assert.deepEqual(r.actions, {
      fetch: "UNKNOWN",
      build: "NO",
      restart: "YES",
    });
    assert.equal(await f.git("rev-parse", "HEAD"), revision);
    await writeFile(path.join(f.repo, "README.md"), "PRIVATE_DOCUMENT_CONTENT");
    r = await deliveryStatus({ repo: f.repo, offline: true });
    assert.equal(r.checkout.dirty, true);
    assert.equal(r.actions.build, "NO");
    assert.ok(!JSON.stringify(r).includes("PRIVATE_DOCUMENT"));
  } finally {
    await f.close();
  }
});
test("missing, modified and legacy identities remain UNKNOWN; runtime probes are bounded and sanitized", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await deliveryStatus({ repo: f.repo, offline: true })).built.status,
      "UNKNOWN",
    );
    await f.build();
    await writeFile(path.join(f.repo, "dist/main.cjs"), "modified after build");
    let r = await deliveryStatus({ repo: f.repo, offline: true });
    assert.equal(r.built.status, "UNKNOWN");
    assert.equal(r.actions.restart, "UNKNOWN");
    await f.build(
      null,
      "process.stdout.write(JSON.stringify({operations:[]}));",
    );
    r = await deliveryStatus({ repo: f.repo, offline: true });
    assert.equal(r.built.status, "KNOWN");
    assert.equal(r.running.status, "UNKNOWN");
    await f.build(
      null,
      "process.stderr.write('PRIVATE_DELIVERY_PROFILE/error');process.stdout.write('x'.repeat(100000));",
    );
    const output = await run(process.execPath, [
      tool,
      "--repo",
      f.repo,
      "--offline",
      "--json",
    ]);
    assert.equal(JSON.parse(output.stdout).running.status, "UNKNOWN");
    assert.equal(output.stderr, "");
    assert.ok(!output.stdout.includes(f.temp));
    await f.build(null, "setInterval(()=>{},1000);");
    const start = performance.now();
    assert.equal(
      (await deliveryStatus({ repo: f.repo, offline: true })).running.status,
      "UNKNOWN",
    );
    assert.ok(performance.now() - start < 5000);
  } finally {
    await f.close();
  }
});
test("checked merge proof rejects wrong heads, missing/failing gates and truncated metadata", () => {
  const tip = "a".repeat(40),
    head = "b".repeat(40),
    data = payload(tip, head);
  assert.equal(checkedMerge(data).revision, tip);
  const pr =
    data.data.repository.defaultBranchRef.target.associatedPullRequests
      .nodes[0];
  pr.commits.nodes[0].commit.oid = "c".repeat(40);
  assert.equal(checkedMerge(data).status, "UNKNOWN");
  pr.commits.nodes[0].commit.oid = head;
  const contexts = pr.commits.nodes[0].commit.statusCheckRollup.contexts;
  contexts.nodes.at(-1).conclusion = "FAILURE";
  assert.equal(checkedMerge(data).status, "UNKNOWN");
  contexts.nodes.at(-1).conclusion = "SUCCESS";
  contexts.pageInfo.hasNextPage = true;
  assert.equal(checkedMerge(data).status, "UNKNOWN");
});
test("read-only upstream proof distinguishes real Git behind/ahead/diverged without fetching", async () => {
  const f = await fixture(),
    oldPath = process.env.PATH;
  try {
    const a = await f.git("rev-parse", "HEAD");
    await f.git(
      "remote",
      "add",
      "origin",
      "https://github.com/invented/cod.git",
    );
    await writeFile(path.join(f.repo, "src/main.ts"), "second source");
    const b = await f.commit();
    await f.git("update-ref", "refs/remotes/origin/master", a);
    const bin = path.join(f.temp, "bin");
    await mkdir(bin);
    const output = path.join(f.temp, "github.json"),
      called = path.join(f.temp, "called");
    await writeFile(
      path.join(bin, "gh"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(called)},'called');process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(output)}));`,
      { mode: 0o755 },
    );
    process.env.PATH = bin + path.delimiter + oldPath;
    await writeFile(output, JSON.stringify(payload(b)));
    await deliveryStatus({ repo: f.repo, offline: true });
    await assert.rejects(access(called));
    await f.git("checkout", "--detach", a);
    let r = await deliveryStatus({ repo: f.repo });
    assert.equal(r.checkout.relation, "BEHIND");
    assert.equal(r.actions.fetch, "YES");
    assert.equal(await f.git("rev-parse", "refs/remotes/origin/master"), a);
    await writeFile(output, JSON.stringify(payload(a)));
    await f.git("checkout", "--detach", b);
    assert.equal(
      (await deliveryStatus({ repo: f.repo })).checkout.relation,
      "AHEAD",
    );
    await f.git("checkout", "--detach", a);
    await writeFile(path.join(f.repo, "src/main.ts"), "different branch");
    await f.commit();
    await writeFile(output, JSON.stringify(payload(b)));
    assert.equal(
      (await deliveryStatus({ repo: f.repo })).checkout.relation,
      "DIVERGED",
    );
    await writeFile(output, "PRIVATE_INVALID_GITHUB_RESPONSE");
    r = await deliveryStatus({ repo: f.repo });
    assert.equal(r.latestChecked.status, "UNKNOWN");
    assert.ok(!JSON.stringify(r).includes("PRIVATE_"));
  } finally {
    process.env.PATH = oldPath;
    await f.close();
  }
});
