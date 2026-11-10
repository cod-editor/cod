import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  inspectIntegration,
  installIntegration,
  discoverIntegrationProfiles,
} from "../src/agent-plugin.ts";

for (const provider of ["codex", "claude", "kimi"] as const) {
  test(`${provider}: explicit preview, preserving settings, backups, idempotence and edited-hook rejection`, async () => {
    const profilePath = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "cod-plugin-")),
    );
    try {
      const options = { provider, profilePath, bundleRoot: process.cwd() };
      const configPath = path.join(
        profilePath,
        provider === "kimi"
          ? "config.toml"
          : provider === "claude"
            ? "settings.json"
            : "hooks.json",
      );
      const original =
        provider === "kimi"
          ? 'telemetry = false\n\n[[hooks]]\nevent = "Stop"\ncommand = "echo personal-hook"\n'
          : JSON.stringify({
              custom: true,
              hooks: {
                Stop: [
                  {
                    hooks: [{ type: "command", command: "echo personal-hook" }],
                  },
                ],
              },
            });
      await writeFile(configPath, original);
      const preview = await inspectIntegration(options);
      assert.equal(await readFile(configPath, "utf8"), original);
      assert.ok(preview.changes.length >= 3);
      await assert.rejects(
        installIntegration({ ...options, expectedPreviewHash: "stale" }),
        /preview changed/,
      );
      const installed = await installIntegration({
        ...options,
        expectedPreviewHash: preview.previewHash,
      });
      assert.equal(installed.installed, true);
      assert.equal(await readFile(installed.backups[0], "utf8"), original);
      assert.match(await readFile(configPath, "utf8"), /personal-hook/);
      const second = await installIntegration({
        ...options,
        expectedPreviewHash: installed.previewHash,
      });
      assert.deepEqual(second.changes, []);
      assert.deepEqual(second.backups, []);
      await writeFile(
        configPath,
        (await readFile(configPath, "utf8")).replace(
          "status-hook.mjs",
          "edited-hook.mjs",
        ),
      );
      await assert.rejects(inspectIntegration(options), /edited/);
    } finally {
      await rm(profilePath, { recursive: true, force: true });
    }
  });
}
test("install rejects config races and edited owned runtime scripts", async () => {
  const profilePath = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "cod-plugin-")),
  );
  try {
    const options = {
      provider: "claude" as const,
      profilePath,
      bundleRoot: process.cwd(),
    };
    const preview = await inspectIntegration(options);
    await writeFile(
      path.join(profilePath, "settings.json"),
      '{"newUserSetting":true}',
    );
    await assert.rejects(
      installIntegration({
        ...options,
        expectedPreviewHash: preview.previewHash,
      }),
      /preview changed/,
    );
    const revised = await inspectIntegration(options);
    await installIntegration({
      ...options,
      expectedPreviewHash: revised.previewHash,
    });
    await writeFile(
      path.join(profilePath, "cod-integration/status-hook.mjs"),
      "// user customized\n",
    );
    await assert.rejects(inspectIntegration(options), /edited or is not owned/);
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});

test("SessionStart delivers operating instructions in the native output shape and Kimi installs a discoverable skill", async () => {
  const profilePath = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "cod-plugin-")),
  );
  try {
    const options = {
      provider: "kimi" as const,
      profilePath,
      bundleRoot: process.cwd(),
    };
    const preview = await inspectIntegration(options);
    await installIntegration({
      ...options,
      expectedPreviewHash: preview.previewHash,
    });
    const skill = await readFile(
      path.join(profilePath, "skills/cod/SKILL.md"),
      "utf8",
    );
    assert.match(skill, /capabilities/);
    for (const provider of ["codex", "claude", "kimi"]) {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.join(profilePath, "cod-integration/status-hook.mjs"), provider],
          {
            env: {
              ...process.env,
              COD_CONVERSATION_ID: "bound",
              COD_SOCKET_PATH: "unused",
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stdout = "";
        child.stdout.on("data", (data) => (stdout += data));
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve(stdout) : reject(new Error(`Hook exit ${code}`)),
        );
        child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart" }));
      });
      const parsed = JSON.parse(output);
      assert.equal(
        provider === "kimi"
          ? parsed.message
          : parsed.hookSpecificOutput.additionalContext,
        skill,
      );
    }
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});
test("hook events invoke status CLI for the bound conversation, not payload identity; unrelated sessions and subagents stay untouched", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cod-hooks-"));
  try {
    const recording = path.join(directory, "calls.jsonl");
    const cli = path.join(directory, "cli.mjs");
    await writeFile(
      cli,
      `import{appendFileSync}from'node:fs';appendFileSync(process.env.RECORDING,JSON.stringify(process.argv.slice(2))+'\\n')`,
    );
    const hook = path.resolve("runtime-plugins/cod/status-hook.mjs");
    const invoke = (
      event: Record<string, unknown>,
      extra: Record<string, string> = {},
    ) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [hook], {
          env: {
            ...process.env,
            COD_CONVERSATION_ID: "bound-conversation",
            COD_SOCKET_PATH: path.join(directory, "fixture.sock"),
            COD_NODE_PATH: process.execPath,
            COD_CLI_PATH: cli,
            RECORDING: recording,
            ...extra,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`Hook exit ${code}`)),
        );
        child.stdin.end(JSON.stringify(event));
      });
    for (const event of [
      "UserPromptSubmit",
      "PermissionRequest",
      "PostToolUse",
      "Stop",
    ])
      await invoke({
        hook_event_name: event,
        session_id: "untrusted-payload-identity",
      });
    await invoke({ hook_event_name: "Stop", agent_id: "child" });
    await invoke({ hook_event_name: "Stop" }, { COD_CONVERSATION_ID: "" });
    const calls = (await readFile(recording, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 4);
    assert.deepEqual(
      calls.map((call) => call[5]),
      ["working", "waiting", "working", "ready"],
    );
    for (const call of calls)
      assert.deepEqual(call.slice(0, 4), [
        "conversation",
        "report-status",
        "--id",
        "bound-conversation",
      ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile discovery respects native homes without creating or exposing configuration", async () => {
  const home = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "cod-profile-discovery-")),
  );
  try {
    const profilePath = path.join(home, "custom-codex");
    const options = {
      provider: "codex" as const,
      profilePath,
      bundleRoot: process.cwd(),
    };
    const preview = await inspectIntegration(options);
    await installIntegration({
      ...options,
      expectedPreviewHash: preview.previewHash,
    });
    const profiles = await discoverIntegrationProfiles({
      home,
      env: { CODEX_HOME: profilePath },
      bundleRoot: process.cwd(),
    });
    assert.deepEqual(profiles[0], {
      provider: "codex",
      profilePath,
      exists: true,
      installed: true,
    });
    assert.deepEqual(profiles[1], {
      provider: "claude",
      profilePath: path.join(home, ".claude"),
      exists: false,
      installed: false,
    });
    assert.deepEqual(profiles[2], {
      provider: "kimi",
      profilePath: path.join(home, ".kimi"),
      exists: false,
      installed: false,
    });
    await assert.rejects(readFile(path.join(home, ".kimi", "config.toml")), {
      code: "ENOENT",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
