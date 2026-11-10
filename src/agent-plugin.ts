import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  lstat,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type IntegrationProvider = "codex" | "claude" | "kimi";
export interface IntegrationOptions {
  provider: IntegrationProvider;
  profilePath: string;
  bundleRoot?: string;
  nodePath?: string;
}
export interface IntegrationPreview {
  provider: IntegrationProvider;
  profilePath: string;
  changes: Array<{ path: string; before: string | null; after: string }>;
  trustInstructions: string;
  previewHash: string;
  installed: boolean;
}
const events = [
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const begin = "# BEGIN Cod managed hooks";
const end = "# END Cod managed hooks";
async function read(file: string): Promise<string | null> {
  try {
    if ((await lstat(file)).isSymbolicLink())
      throw new Error(`Refusing symlink: ${file}`);
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function safeAncestors(file: string) {
  let current = path.resolve(file);
  while (current !== path.dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Refusing symlink: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
}
type Manifest = {
  hashes: Record<string, string>;
  command: string;
  block?: string;
};
export async function inspectIntegration(
  options: IntegrationOptions,
): Promise<IntegrationPreview> {
  if (!["codex", "claude", "kimi"].includes(options.provider))
    throw new Error("Unsupported provider");
  if (!path.isAbsolute(options.profilePath))
    throw new Error("Provider profile path must be absolute");
  const profilePath = path.resolve(options.profilePath);
  await safeAncestors(profilePath);
  const root = options.bundleRoot ?? path.resolve(__dirname, "..");
  const directory = path.join(profilePath, "cod-integration");
  await safeAncestors(directory);
  const manifestPath = path.join(directory, "manifest.json");
  const previousText = await read(manifestPath);
  const previous: Manifest | undefined = previousText
    ? JSON.parse(previousText)
    : undefined;
  const runnerPath = path.join(directory, "status-hook.mjs");
  const command = `ELECTRON_RUN_AS_NODE=1 ${quote(options.nodePath ?? process.execPath)} ${quote(runnerPath)} ${quote(options.provider)}`;
  const runner = await readFile(
    path.join(root, "runtime-plugins/cod/status-hook.mjs"),
    "utf8",
  );
  const skill = await readFile(
    path.join(root, "runtime-skills/cod/SKILL.md"),
    "utf8",
  );
  const payloads: Record<string, string> = {
    "status-hook.mjs": runner,
    "SKILL.md": skill,
    ...(options.provider === "kimi" ? { "../skills/cod/SKILL.md": skill } : {}),
  };
  const changes: IntegrationPreview["changes"] = [];
  for (const [name, after] of Object.entries(payloads)) {
    const file = path.join(directory, name);
    await safeAncestors(file);
    const before = await read(file);
    if (
      before !== null &&
      (!previous || previous.hashes[name] !== hash(before))
    )
      throw new Error(
        `Integration file was edited or is not owned by Cod: ${file}`,
      );
    if (before !== after) changes.push({ path: file, before, after });
  }
  const configPath = path.join(
    profilePath,
    options.provider === "kimi"
      ? "config.toml"
      : options.provider === "claude"
        ? "settings.json"
        : "hooks.json",
  );
  const before = await read(configPath);
  let after: string, block: string | undefined;
  if (options.provider === "kimi") {
    let remainder = before ?? "";
    if (previous?.block) {
      if (!remainder.includes(previous.block))
        throw new Error(
          "Managed Kimi hook block was edited; merge it manually",
        );
      remainder = remainder.replace(previous.block, "");
    }
    if (remainder.includes(begin) || remainder.includes(end))
      throw new Error("Unowned Cod hook marker found");
    block = `${begin}\n${events.map((event) => `[[hooks]]\nevent = ${JSON.stringify(event)}\ncommand = ${JSON.stringify(command)}\ntimeout = 5\n`).join("\n")}${end}\n`;
    after = remainder.replace(/\n*$/, "") + "\n\n" + block;
  } else {
    const config = before ? JSON.parse(before) : {};
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error("Provider config must be an object");
    const hooks = config.hooks ?? {};
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks))
      throw new Error("Provider hooks must be an object");
    for (const event of events) {
      let entries: unknown[] = hooks[event] ?? [];
      if (!Array.isArray(entries))
        throw new Error(`Invalid hook list: ${event}`);
      if (previous) {
        const owned = {
          hooks: [{ type: "command", command: previous.command, timeout: 5 }],
        };
        const index = entries.findIndex(
          (entry) => JSON.stringify(entry) === JSON.stringify(owned),
        );
        if (index < 0)
          throw new Error(
            `Managed ${event} hook was edited; merge it manually`,
          );
        entries = entries.filter((_, at) => at !== index);
      }
      hooks[event] = [
        ...entries,
        { hooks: [{ type: "command", command, timeout: 5 }] },
      ];
    }
    config.hooks = hooks;
    after = JSON.stringify(config, null, 2) + "\n";
  }
  if (before !== after) changes.push({ path: configPath, before, after });
  const manifest: Manifest = {
    hashes: Object.fromEntries(
      Object.entries(payloads).map(([name, text]) => [name, hash(text)]),
    ),
    command,
    ...(block ? { block } : {}),
  };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  if (previousText !== manifestText)
    changes.push({
      path: manifestPath,
      before: previousText,
      after: manifestText,
    });
  return {
    provider: options.provider,
    profilePath,
    changes,
    previewHash: hash(
      JSON.stringify({ provider: options.provider, profilePath, changes }),
    ),
    installed: changes.length === 0,
    trustInstructions:
      options.provider === "codex"
        ? "Open Codex with this CODEX_HOME, run /hooks, and review and trust the Cod hooks. Cod never grants hook trust itself. Restart the Cod conversation after approval."
        : "Restart the provider session to load these hooks. Review them in the provider's hook settings. Hooks report only sessions launched by Cod; native live compatibility is not established by installation.",
  };
}
export async function installIntegration(
  options: IntegrationOptions & { expectedPreviewHash: string },
) {
  const preview = await inspectIntegration(options);
  if (preview.previewHash !== options.expectedPreviewHash)
    throw new Error(
      "Integration preview changed; review the updated files before installing",
    );
  const backups: string[] = [];
  const written: IntegrationPreview["changes"] = [];
  try {
    for (const change of preview.changes) {
      await safeAncestors(change.path);
      if ((await read(change.path)) !== change.before)
        throw new Error("Configuration changed during installation");
      await mkdir(path.dirname(change.path), { recursive: true });
      if (change.before !== null) {
        const backup = `${change.path}.cod-backup-${randomUUID()}`;
        await writeFile(backup, change.before, { flag: "wx", mode: 0o600 });
        backups.push(backup);
      }
      const temporary = `${change.path}.cod-new-${randomUUID()}`;
      await writeFile(temporary, change.after, { flag: "wx", mode: 0o600 });
      await rename(temporary, change.path);
      written.push(change);
    }
  } catch (error) {
    for (const change of written.reverse()) {
      if ((await read(change.path)) !== change.after) continue;
      if (change.before === null) await rm(change.path);
      else await writeFile(change.path, change.before, { mode: 0o600 });
    }
    throw error;
  }
  return { ...(await inspectIntegration(options)), backups };
}

export async function discoverIntegrationProfiles(
  options: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    bundleRoot?: string;
    nodePath?: string;
  } = {},
) {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  return Promise.all(
    (["codex", "claude", "kimi"] as const).map(async (provider) => {
      const variable = {
        codex: "CODEX_HOME",
        claude: "CLAUDE_CONFIG_DIR",
        kimi: "KIMI_CODE_HOME",
      }[provider];
      const profilePath = path.resolve(
        env[variable] || path.join(home, `.${provider}`),
      );
      let exists = false;
      try {
        exists = (await lstat(profilePath)).isDirectory();
        const preview = await inspectIntegration({
          provider,
          profilePath,
          bundleRoot: options.bundleRoot,
          nodePath: options.nodePath,
        });
        return { provider, profilePath, exists, installed: preview.installed };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { provider, profilePath, exists: false, installed: false };
        return {
          provider,
          profilePath,
          exists,
          installed: false,
          error:
            "Could not inspect the provider profile. Open integration settings to review it.",
        };
      }
    }),
  );
}
