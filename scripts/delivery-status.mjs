#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInfoName,
  checkout,
  git,
  outputHashes,
  sourceHash,
} from "./build-info.mjs";

const execute = promisify(execFile);
const unknown = (reason) => ({ status: "UNKNOWN", reason });
function safeBuild(value) {
  if (
    !value ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    !/^[a-f0-9]{64}$/.test(value.sourceHash) ||
    !(value.revision === null || /^[a-f0-9]{40,64}$/.test(value.revision)) ||
    !(value.dirty === null || typeof value.dirty === "boolean") ||
    typeof value.version !== "string" ||
    !/^[a-zA-Z0-9.+-]{1,64}$/.test(value.version)
  )
    return null;
  return {
    id: value.id,
    sourceHash: value.sourceHash,
    revision: value.revision,
    dirty: value.dirty,
  };
}
export function checkedMerge(value) {
  const branch = value?.data?.repository?.defaultBranchRef;
  const tip = branch?.target;
  if (
    !/^[a-f0-9]{40}$/.test(tip?.oid ?? "") ||
    !/^[a-zA-Z0-9_/-]+$/.test(branch.name ?? "")
  )
    return unknown("upstream_unavailable");
  for (const pr of tip.associatedPullRequests?.nodes ?? []) {
    const commit = pr.commits?.nodes?.at(-1)?.commit;
    if (
      !pr.merged ||
      pr.mergeCommit?.oid !== tip.oid ||
      commit?.oid !== pr.headRefOid ||
      !/^[a-f0-9]{40}$/.test(pr.headRefOid) ||
      !Number.isInteger(pr.number)
    )
      continue;
    if (commit.statusCheckRollup?.contexts?.pageInfo?.hasNextPage !== false)
      continue;
    const checks = commit.statusCheckRollup?.contexts?.nodes ?? [];
    const required = [
      "Fast checks",
      "Service tests",
      "Electron shard 1/3",
      "Electron shard 2/3",
      "Electron shard 3/3",
      "e2e",
    ];
    if (
      required.every((name) =>
        checks.some(
          (c) =>
            c.name === name &&
            c.status === "COMPLETED" &&
            c.conclusion === "SUCCESS",
        ),
      ) &&
      checks.every((c) =>
        c.name
          ? ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion)
          : c.state === "SUCCESS",
      )
    )
      return {
        status: "KNOWN",
        revision: tip.oid,
        checkedHead: pr.headRefOid,
        pullRequest: pr.number,
        branch: branch.name,
      };
  }
  return unknown("checked_merge_unproven");
}
async function upstream(root, offline) {
  if (offline) return unknown("offline");
  const remote = await git(root, ["remote", "get-url", "origin"]);
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(
      remote ?? "",
    );
  if (!match) return unknown("github_remote_unavailable");
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name target{... on Commit{oid associatedPullRequests(first:5){nodes{number merged mergeCommit{oid} headRefOid commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:50){pageInfo{hasNextPage} nodes{... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}}}}}}}}`;
  try {
    const response = await execute(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${match[1]}`,
        "-f",
        `name=${match[2]}`,
      ],
      { timeout: 6000, maxBuffer: 262144 },
    );
    return checkedMerge(JSON.parse(response.stdout));
  } catch {
    return unknown("github_unavailable");
  }
}
async function built(dist) {
  try {
    const file = path.join(dist, buildInfoName);
    const info = await lstat(file);
    if (!info.isFile() || info.size > 65536)
      return unknown("invalid_build_metadata");
    const text = await readFile(file, "utf8");
    const data = JSON.parse(text),
      build = safeBuild(data.build);
    if (data.schema !== 1 || !build) return unknown("invalid_build_metadata");
    const actual = await outputHashes(dist);
    if (
      !data.outputs ||
      Object.keys(data.outputs).length !== Object.keys(actual).length ||
      Object.keys(actual).some((name) => actual[name] !== data.outputs[name]) ||
      (await readFile(file, "utf8")) !== text
    )
      return unknown("changed_build_outputs");
    return { status: "KNOWN", build };
  } catch {
    return unknown("build_unidentified");
  }
}
async function running(dist, socket) {
  try {
    // Reuse the existing bounded read-only operation and profile/socket resolution.
    const response = await execute(
      process.execPath,
      [path.join(dist, "cli.cjs"), "capabilities"],
      {
        timeout: 3000,
        maxBuffer: 65536,
        env: { ...process.env, ...(socket ? { COD_SOCKET_PATH: socket } : {}) },
      },
    );
    const build = safeBuild(JSON.parse(response.stdout)?.runtime?.build);
    return build ? { status: "KNOWN", build } : unknown("runtime_unidentified");
  } catch {
    return unknown("runtime_unavailable");
  }
}
export async function deliveryStatus({
  repo = process.cwd(),
  dist,
  offline = false,
  socket,
} = {}) {
  repo = path.resolve(repo);
  dist = path.resolve(dist ?? path.join(repo, "dist"));
  const [latest, local, build, live, source] = await Promise.all([
    upstream(repo, offline),
    checkout(repo),
    built(dist),
    running(dist, socket),
    sourceHash(repo).catch(() => null),
  ]);
  let relation = "UNKNOWN",
    fetch = "UNKNOWN";
  if (latest.status === "KNOWN") {
    const tracking = await git(repo, [
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${latest.branch}`,
    ]);
    fetch = tracking === latest.revision ? "NO" : "YES";
    if (local.revision === latest.revision) relation = "EQUAL";
    else if (
      local.revision &&
      (await git(repo, ["cat-file", "-e", `${latest.revision}^{commit}`])) !==
        null
    ) {
      if (
        (await git(repo, [
          "merge-base",
          "--is-ancestor",
          latest.revision,
          local.revision,
        ])) !== null
      )
        relation = "AHEAD";
      else if (
        (await git(repo, [
          "merge-base",
          "--is-ancestor",
          local.revision,
          latest.revision,
        ])) !== null
      )
        relation = "BEHIND";
      else relation = "DIVERGED";
    }
  }
  // No remote names, local filenames, paths, raw command errors or profile content.
  const { branch: _branch, ...sanitizedLatest } = latest;
  return {
    latestChecked: sanitizedLatest,
    checkout: {
      status: local.revision && local.dirty !== null ? "KNOWN" : "UNKNOWN",
      ...local,
      relation,
    },
    built: build,
    running: live,
    actions: {
      fetch,
      build:
        source && build.status === "KNOWN"
          ? source === build.build.sourceHash
            ? "NO"
            : "YES"
          : "UNKNOWN",
      restart:
        build.status === "KNOWN" && live.status === "KNOWN"
          ? build.build.id === live.build.id
            ? "NO"
            : "YES"
          : "UNKNOWN",
    },
  };
}
async function main() {
  const options = {},
    args = process.argv.slice(2);
  let json = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--help") {
      console.log(
        "Usage: npm run --silent delivery:status -- [--offline] [--json] [--repo PATH] [--dist PATH] [--socket PATH]\nRead-only: checked merge, checkout, built and running identities. UNKNOWN is not current. Never fetches, builds or restarts.",
      );
      return;
    }
    if (arg === "--json") json = true;
    else if (arg === "--offline") options.offline = true;
    else if (
      ["--repo", "--dist", "--socket"].includes(arg) &&
      args[0] &&
      !args[0].startsWith("--")
    )
      options[arg.slice(2)] = args.shift();
    else {
      console.error("Invalid delivery-status arguments; use --help");
      process.exitCode = 2;
      return;
    }
  }
  const result = await deliveryStatus(options);
  if (json) console.log(JSON.stringify(result));
  else {
    console.log(`Checked merge: ${result.latestChecked.revision ?? "UNKNOWN"}`);
    console.log(
      `Checkout: ${result.checkout.revision ?? "UNKNOWN"} dirty=${result.checkout.dirty ?? "UNKNOWN"} ${result.checkout.relation}`,
    );
    for (const [label, value] of [
      ["Built", result.built],
      ["Running", result.running],
    ])
      console.log(
        `${label}: ${value.build ? `${value.build.id} commit=${value.build.revision ?? "UNKNOWN"} dirty=${value.build.dirty ?? "UNKNOWN"}` : `UNKNOWN (${value.reason})`}`,
      );
    console.log(
      `Actions: fetch=${result.actions.fetch} build=${result.actions.build} restart=${result.actions.restart}`,
    );
    if (
      result.checkout.relation === "BEHIND" ||
      result.checkout.relation === "DIVERGED"
    )
      console.log("Checkout differs from checked merge; review it explicitly.");
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    console.error("Delivery status unavailable");
    process.exitCode = 1;
  });
