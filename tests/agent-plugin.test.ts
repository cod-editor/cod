import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  realpath,
  rm,
  mkdir,
  lstat,
  readlink,
  symlink,
  truncate,
  rename,
  chmod,
  chown,
  readdir,
} from "node:fs/promises";
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
for (const provider of ["codex", "claude", "kimi"] as const) {
  test(`${provider}: a packaged plugin tree upgrades existing managed payloads without changing profile destinations`, async () => {
    const directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "cod-plugin-upgrade-")),
    );
    try {
      const profilePath = path.join(directory, "profile");
      const bundleRoot = path.join(directory, "package");
      await mkdir(profilePath);
      const skillPath = path.join(
        bundleRoot,
        "plugins/cod/skills/cod/SKILL.md",
      );
      const hookPath = path.join(
        bundleRoot,
        "plugins/cod/hooks/status-hook.mjs",
      );
      const skill = await readFile("plugins/cod/skills/cod/SKILL.md", "utf8");
      assert.match(skill, /^---\nname: cod\n/);
      const hook = await readFile("plugins/cod/hooks/status-hook.mjs", "utf8");
      await mkdir(path.dirname(skillPath), { recursive: true });
      await mkdir(path.dirname(hookPath), { recursive: true });
      // Reproduce the previously shipped payload and its normal ownership manifest.
      await writeFile(
        skillPath,
        skill.replace("name: cod\n", "name: cod-runtime\n"),
      );
      await writeFile(hookPath, hook);
      const options = { provider, profilePath, bundleRoot };
      const before = await inspectIntegration(options);
      await installIntegration({
        ...options,
        expectedPreviewHash: before.previewHash,
      });
      const destination = path.join(profilePath, "cod-integration");
      const oldManifest = JSON.parse(
        await readFile(path.join(destination, "manifest.json"), "utf8"),
      );
      await writeFile(skillPath, skill);
      const preview = await inspectIntegration(options);
      assert.ok(
        preview.changes.some(
          (change) => change.path === path.join(destination, "SKILL.md"),
        ),
      );
      const installed = await installIntegration({
        ...options,
        expectedPreviewHash: preview.previewHash,
      });
      assert.ok(installed.backups.length > 0);
      assert.equal(
        await readFile(path.join(destination, "SKILL.md"), "utf8"),
        skill,
      );
      assert.equal(
        await readFile(path.join(destination, "status-hook.mjs"), "utf8"),
        hook,
      );
      if (provider === "kimi")
        assert.equal(
          await readFile(path.join(profilePath, "skills/cod/SKILL.md"), "utf8"),
          skill,
        );
      const manifest = JSON.parse(
        await readFile(path.join(destination, "manifest.json"), "utf8"),
      );
      assert.deepEqual(
        Object.keys(manifest.hashes),
        Object.keys(oldManifest.hashes),
      );
      assert.equal(manifest.command, oldManifest.command);
      assert.equal((await inspectIntegration(options)).installed, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
test("install rejects config races and edited owned hook scripts", async () => {
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

test("linked Claude settings show a private diff and apply the reviewed hooks and Cod files together", async (context) => {
  const workspace = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "cod-linked-settings-")),
  );
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const profilePath = path.join(workspace, "claude-profile");
  await mkdir(profilePath);
  const target = path.join(workspace, "dotfiles-settings.json");
  const alias = path.join(profilePath, "settings.json");
  const existing = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "personal-hook" }] }],
    },
    env: { EXAMPLE_VALUE: "invented-private-setting" },
  };
  const original = JSON.stringify(existing, null, 2) + "\n";
  await writeFile(target, original);
  const targetInfo = await lstat(target);
  const targetGroup =
    process.getgroups?.().find((group) => group !== targetInfo.gid) ??
    targetInfo.gid;
  if (targetGroup !== targetInfo.gid)
    await chown(target, targetInfo.uid, targetGroup);
  await chmod(target, 0o640);
  await symlink("../dotfiles-settings.json", alias);
  const originalLink = (await lstat(alias)).ino;
  const options = {
    provider: "claude" as const,
    profilePath,
    bundleRoot: process.cwd(),
  };
  const targetOnly = await inspectIntegration(options);
  assert.equal(targetOnly.linkedSettings?.target, target);
  assert.equal(targetOnly.linkedSettings.review, undefined);
  assert.deepEqual(targetOnly.changes, []);
  await assert.rejects(
    installIntegration({
      ...options,
      expectedPreviewHash: targetOnly.previewHash,
    }),
    /preview changed/,
  );
  const reviewOptions = {
    ...options,
    expectedLinkedTargetHash: targetOnly.linkedSettings.identity,
  };
  const reviewed = await inspectIntegration(reviewOptions);
  assert.doesNotMatch(
    JSON.stringify(reviewed),
    /invented-private-setting|personal-hook/,
  );
  assert.equal(Object.keys(reviewed.linkedSettings!.review!.add).length, 5);
  const approving = {
    ...reviewOptions,
    expectedPreviewHash: reviewed.previewHash,
  };
  const applying = installIntegration(approving);
  await assert.rejects(installIntegration(approving), /already being applied/);
  const applied = await applying;
  assert.equal(applied.installed, true);
  assert.deepEqual(applied.changes, []);
  assert.equal(applied.backups.length, 1);
  assert.equal(await readFile(applied.backups[0], "utf8"), original);
  assert.equal((await lstat(applied.backups[0])).mode & 0o777, 0o600);
  assert.equal((await lstat(target)).mode & 0o777, 0o640);
  assert.equal((await lstat(target)).gid, targetGroup);
  assert.equal((await lstat(alias)).ino, originalLink);
  assert.equal(await readlink(alias), "../dotfiles-settings.json");
  const updated = {
    ...existing,
    hooks: {
      ...reviewed.linkedSettings!.review!.add,
      Stop: [
        ...existing.hooks.Stop,
        ...reviewed.linkedSettings!.review!.add.Stop,
      ],
    },
  };
  assert.match(
    await readFile(target, "utf8"),
    /"env": \{\n    "EXAMPLE_VALUE": "invented-private-setting"\n  \}/,
  );
  await assert.rejects(inspectIntegration(reviewOptions), /settings changed/);
  const updatedTarget = await inspectIntegration(options);
  const final = await inspectIntegration({
    ...options,
    expectedLinkedTargetHash: updatedTarget.linkedSettings!.identity,
  });
  assert.equal(final.installed, true);
  assert.equal((await lstat(alias)).ino, originalLink);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), updated);

  const upgrade = {
    ...options,
    nodePath: "/fixture/Cod-New",
    expectedLinkedTargetHash: final.linkedSettings!.identity,
  };
  const upgradePreview = await inspectIntegration(upgrade);
  const replacement = upgradePreview.linkedSettings!.review!;
  assert.deepEqual(replacement.remove, reviewed.linkedSettings!.review!.add);
  const upgradeApplied = await installIntegration({
    ...upgrade,
    expectedPreviewHash: upgradePreview.previewHash,
  });
  assert.equal(upgradeApplied.installed, true);
  assert.equal(upgradeApplied.backups.length, 2);
  assert.equal(Object.keys(replacement.add).length, 5);
  const upgraded = {
    ...existing,
    hooks: {
      ...replacement.add,
      Stop: [...existing.hooks.Stop, ...replacement.add.Stop],
    },
  };
  const finished = {
    ...upgrade,
    expectedLinkedTargetHash: upgradeApplied.linkedSettings!.identity,
  };
  const newPreview = await inspectIntegration(finished);
  assert.deepEqual(newPreview.linkedSettings!.review, { add: {}, remove: {} });
  const result = await installIntegration({
    ...finished,
    expectedPreviewHash: newPreview.previewHash,
  });
  assert.equal(result.installed, true);
  assert.equal((await lstat(alias)).ino, originalLink);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), upgraded);
  const edited = {
    ...upgraded,
    hooks: {
      ...upgraded.hooks,
      Stop: [
        ...existing.hooks.Stop,
        { ...replacement.add.Stop[0], matcher: "custom" },
      ],
    },
  };
  await writeFile(target, JSON.stringify(edited));
  const editedTarget = await inspectIntegration(options);
  await assert.rejects(
    inspectIntegration({
      ...finished,
      expectedLinkedTargetHash: editedTarget.linkedSettings!.identity,
    }),
    /Managed Stop hook was edited in linked settings/,
  );
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), edited);
});

test("linked settings reject dangling links, same-content retargets and stale edits", async (context) => {
  const profilePath = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "cod-linked-settings-race-")),
  );
  context.after(() => rm(profilePath, { recursive: true, force: true }));
  const alias = path.join(profilePath, "settings.json");
  const target = path.join(profilePath, "original.json");
  const other = path.join(profilePath, "other.json");
  const options = {
    provider: "claude" as const,
    profilePath,
    bundleRoot: process.cwd(),
  };
  await symlink(target, alias);
  await assert.rejects(inspectIntegration(options), /target does not exist/);
  await writeFile(target, '{"invalid":"invented-private-setting"');
  const metadata = await inspectIntegration(options);
  assert.equal(metadata.linkedSettings?.target, target);
  await assert.rejects(
    inspectIntegration({
      ...options,
      expectedLinkedTargetHash: metadata.linkedSettings.identity,
    }),
    (error: Error) =>
      error.message === "Linked Claude settings must contain valid JSON",
  );
  await Promise.all([writeFile(target, "{}"), writeFile(other, "{}")]);
  const approved = await inspectIntegration(options);
  const reviewed = {
    ...options,
    expectedLinkedTargetHash: approved.linkedSettings!.identity,
  };
  const review = await inspectIntegration(reviewed);
  await rm(alias);
  await symlink(other, alias);
  await assert.rejects(
    installIntegration({
      ...reviewed,
      expectedPreviewHash: review.previewHash,
    }),
    /settings changed/,
  );
  const otherMetadata = await inspectIntegration(options);
  const otherReviewed = {
    ...options,
    expectedLinkedTargetHash: otherMetadata.linkedSettings!.identity,
  };
  const otherReview = await inspectIntegration(otherReviewed);
  await writeFile(other, '{"localEdit":true}');
  await assert.rejects(
    installIntegration({
      ...otherReviewed,
      expectedPreviewHash: otherReview.previewHash,
    }),
    /settings changed/,
  );
  const afterEdit = await inspectIntegration(options);
  const afterEditOptions = {
    ...options,
    expectedLinkedTargetHash: afterEdit.linkedSettings!.identity,
  };
  const afterEditPreview = await inspectIntegration(afterEditOptions);
  const replacementFile = path.join(profilePath, "new-settings.json");
  await writeFile(replacementFile, '{"localEdit":true}');
  await rename(replacementFile, other);
  await assert.rejects(
    installIntegration({
      ...afterEditOptions,
      expectedPreviewHash: afterEditPreview.previewHash,
    }),
    /settings changed/,
  );
  await assert.rejects(lstat(path.join(profilePath, "cod-integration")), {
    code: "ENOENT",
  });
  assert.equal(await readFile(other, "utf8"), '{"localEdit":true}');
  assert.equal(await readlink(alias), other);

  await truncate(other, 4 * 1024 * 1024 + 1);
  const oversized = await inspectIntegration(options);
  await assert.rejects(
    inspectIntegration({
      ...options,
      expectedLinkedTargetHash: oversized.linkedSettings!.identity,
    }),
    /4 MiB review limit/,
  );

  const directory = path.join(profilePath, "cod-integration");
  await mkdir(directory);
  const manifest = path.join(directory, "manifest.json");
  await writeFile(manifest, "{}");
  await rm(alias);
  await symlink(manifest, alias);
  await assert.rejects(
    inspectIntegration(options),
    /outside Cod's managed files/,
  );
  assert.equal(await readFile(manifest, "utf8"), "{}");

  const nested = path.join(profilePath, "external", "nested");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(profilePath, "external", "original.json"), "{}");
  await symlink(nested, path.join(profilePath, "indirect"));
  await rm(alias);
  await symlink("indirect/../original.json", alias);
  await assert.rejects(
    inspectIntegration(options),
    /must resolve directly to the reviewed target/,
  );
});

test("linked installation rejects a changed target ancestor even when the file snapshot is unchanged", async (context) => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "cod-linked-parent-")),
  );
  context.after(() => rm(root, { recursive: true, force: true }));
  const profilePath = path.join(root, "claude");
  const directory = path.join(root, "dotfiles");
  const nested = path.join(directory, "nested");
  const target = path.join(nested, "settings.json");
  const previous = path.join(root, "old-dotfiles");
  await mkdir(profilePath);
  await mkdir(nested, { recursive: true });
  await writeFile(target, "{}");
  const targetInfo = await lstat(target, { bigint: true });
  await symlink(target, path.join(profilePath, "settings.json"));
  const options = {
    provider: "claude" as const,
    profilePath,
    bundleRoot: process.cwd(),
  };
  const metadata = await inspectIntegration(options);
  const reviewed = {
    ...options,
    expectedLinkedTargetHash: metadata.linkedSettings!.identity,
  };
  const preview = await inspectIntegration(reviewed);
  await rename(directory, previous);
  await mkdir(directory);
  await rename(path.join(previous, "nested"), nested);
  const moved = await lstat(target, { bigint: true });
  assert.equal(moved.ino, targetInfo.ino);
  assert.equal(moved.ctimeNs, targetInfo.ctimeNs);
  await assert.rejects(
    installIntegration({
      ...reviewed,
      expectedPreviewHash: preview.previewHash,
    }),
    /settings changed/,
  );
  assert.equal(await readFile(target, "utf8"), "{}");
  assert.deepEqual(await readdir(profilePath), ["settings.json"]);
});

test(
  "linked installation rolls back its helper writes when the approved destination cannot be replaced",
  { skip: process.getuid?.() === 0 },
  async (context) => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "cod-linked-rollback-")),
    );
    const profilePath = path.join(root, "claude");
    const directory = path.join(root, "dotfiles");
    const target = path.join(directory, "settings.json");
    context.after(async () => {
      await chmod(directory, 0o700);
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(profilePath);
    await mkdir(directory);
    await writeFile(target, "{}");
    await symlink(target, path.join(profilePath, "settings.json"));
    const options = {
      provider: "claude" as const,
      profilePath,
      bundleRoot: process.cwd(),
    };
    const metadata = await inspectIntegration(options);
    const reviewed = {
      ...options,
      expectedLinkedTargetHash: metadata.linkedSettings!.identity,
    };
    const preview = await inspectIntegration(reviewed);
    await chmod(directory, 0o500);
    await assert.rejects(
      installIntegration({
        ...reviewed,
        expectedPreviewHash: preview.previewHash,
      }),
      { code: "EACCES" },
    );
    assert.equal(await readFile(target, "utf8"), "{}");
    assert.equal(
      await readlink(path.join(profilePath, "settings.json")),
      target,
    );
    assert.deepEqual(
      await readdir(path.join(profilePath, "cod-integration")),
      [],
    );
  },
);

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
    const hook = path.resolve("plugins/cod/hooks/status-hook.mjs");
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
