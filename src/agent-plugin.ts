import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  readFile,
  writeFile,
  mkdir,
  lstat,
  readlink,
  open,
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
  expectedLinkedTargetHash?: string;
}
type ManagedHook = {
  hooks: [{ type: "command"; command: string; timeout: 5 }];
};
type LinkedSettings = {
  path: string;
  target: string;
  identity: string;
  review?: {
    add: Record<string, ManagedHook[]>;
    remove: Record<string, ManagedHook[]>;
  };
};
export interface IntegrationPreview {
  provider: IntegrationProvider;
  profilePath: string;
  changes: Array<{ path: string; before: string | null; after: string }>;
  trustInstructions: string;
  previewHash: string;
  installed: boolean;
  linkedSettings?: LinkedSettings;
}
const events = [
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
];
const hash = (contents: string | Buffer) =>
  createHash("sha256").update(contents).digest("hex");
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const begin = "# BEGIN Cod managed hooks";
const end = "# END Cod managed hooks";
const maxLinkedSettingsBytes = 4 * 1024 * 1024;
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
  linkedCommands?: string[];
};

function stamp(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

async function linkedSettings(
  file: string,
): Promise<LinkedSettings | undefined> {
  const info = await lstat(file, { bigint: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info?.isSymbolicLink()) return;
  const link = await readlink(file);
  const target = path.resolve(path.dirname(file), link);
  await safeAncestors(target);
  const targetInfo = await lstat(target, { bigint: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        `Linked Claude settings target does not exist: ${target}`,
      );
    throw error;
  });
  if (
    !targetInfo.isFile() ||
    targetInfo.uid !== BigInt(process.getuid?.() ?? -1)
  )
    throw new Error(
      "Linked Claude settings must point to a regular file you own",
    );
  return {
    path: file,
    target,
    identity: hash(
      JSON.stringify([file, link, stamp(info), target, stamp(targetInfo)]),
    ),
  };
}

async function readLinkedSettings(link: LinkedSettings): Promise<Buffer> {
  const file = await open(
    link.target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      (await linkedSettings(link.path))?.identity !== link.identity ||
      stamp(before) !== stamp(await lstat(link.target, { bigint: true }))
    )
      throw new Error(
        "Linked Claude settings changed. Review the target again.",
      );
    if (before.size > BigInt(maxLinkedSettingsBytes))
      throw new Error("Linked Claude settings exceed the 4 MiB review limit");
    const contents = Buffer.alloc(Number(before.size) + 1);
    const { bytesRead } = await file.read(contents, 0, contents.length, 0);
    if (
      BigInt(bytesRead) !== before.size ||
      stamp(before) !== stamp(await file.stat({ bigint: true })) ||
      (await linkedSettings(link.path))?.identity !== link.identity ||
      stamp(before) !== stamp(await lstat(link.target, { bigint: true }))
    )
      throw new Error(
        "Linked Claude settings changed. Review the target again.",
      );
    return contents.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

const managedHook = (command: string): ManagedHook => ({
  hooks: [{ type: "command", command, timeout: 5 }],
});

export async function inspectIntegration(
  options: IntegrationOptions,
): Promise<IntegrationPreview> {
  if (!["codex", "claude", "kimi"].includes(options.provider))
    throw new Error("Unsupported provider");
  if (!path.isAbsolute(options.profilePath))
    throw new Error("Provider profile path must be absolute");
  const profilePath = path.resolve(options.profilePath);
  await safeAncestors(profilePath);
  const configPath = path.join(
    profilePath,
    options.provider === "kimi"
      ? "config.toml"
      : options.provider === "claude"
        ? "settings.json"
        : "hooks.json",
  );
  const link =
    options.provider === "claude"
      ? await linkedSettings(configPath)
      : undefined;
  const directory = path.join(profilePath, "cod-integration");
  if (link?.target.startsWith(directory + path.sep))
    throw new Error(
      "Linked Claude settings must be outside Cod's managed files",
    );
  const expectedLink = options.expectedLinkedTargetHash;
  if (expectedLink !== undefined && link?.identity !== expectedLink)
    throw new Error("Linked Claude settings changed. Review the target again.");
  const trustInstructions =
    options.provider === "codex"
      ? "Open Codex with this CODEX_HOME, run /hooks, and review and trust the Cod hooks. Cod never grants hook trust itself. Restart the Cod conversation after approval."
      : "Restart the provider session to load these hooks. Review them in the provider's hook settings. Hooks report only sessions launched by Cod; native live compatibility is not established by installation.";
  if (link && expectedLink === undefined)
    return {
      provider: options.provider,
      profilePath,
      changes: [],
      previewHash: "",
      installed: false,
      trustInstructions,
      linkedSettings: link,
    };

  const root = options.bundleRoot ?? path.resolve(__dirname, "..");
  await safeAncestors(directory);
  const manifestPath = path.join(directory, "manifest.json");
  const previousText = await read(manifestPath);
  const previous: Manifest | undefined = previousText
    ? JSON.parse(previousText)
    : undefined;
  const runnerPath = path.join(directory, "status-hook.mjs");
  const command = `ELECTRON_RUN_AS_NODE=1 ${quote(options.nodePath ?? process.execPath)} ${quote(runnerPath)} ${quote(options.provider)}`;
  const runner = await readFile(
    path.join(root, "plugins/cod/hooks/status-hook.mjs"),
    "utf8",
  );
  const skill = await readFile(
    path.join(root, "plugins/cod/skills/cod/SKILL.md"),
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
  const linkedContents = link ? await readLinkedSettings(link) : undefined;
  const before = linkedContents?.toString("utf8") ?? (await read(configPath));
  const oldLinkedCommands = new Set<string>();
  let after = "",
    block: string | undefined;
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
    let config;
    try {
      config = before ? JSON.parse(before) : {};
    } catch (error) {
      if (link)
        throw new Error("Linked Claude settings must contain valid JSON");
      throw error;
    }
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error("Provider config must be an object");
    const hooks = config.hooks ?? {};
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks))
      throw new Error("Provider hooks must be an object");
    const reviewed: NonNullable<LinkedSettings["review"]> = {
      add: {},
      remove: {},
    };
    const desired = managedHook(command);
    const oldCommands = [
      previous?.command,
      ...(previous?.linkedCommands ?? []),
    ].filter((item): item is string => !!item && item !== command);
    for (const event of events) {
      let entries: unknown[] = hooks[event] ?? [];
      if (!Array.isArray(entries))
        throw new Error(`Invalid hook list: ${event}`);
      if (link) {
        const outdated = entries.flatMap((entry) => {
          const oldCommand = oldCommands.find((item) =>
            isDeepStrictEqual(entry, managedHook(item)),
          );
          if (!oldCommand) return [];
          oldLinkedCommands.add(oldCommand);
          return [managedHook(oldCommand)];
        });
        if (outdated.length) reviewed.remove[event] = outdated;
        if (!entries.some((entry) => isDeepStrictEqual(entry, desired)))
          reviewed.add[event] = [desired];
        continue;
      }
      if (previous) {
        const owned = managedHook(previous.command);
        const index = entries.findIndex(
          (entry) => JSON.stringify(entry) === JSON.stringify(owned),
        );
        if (index < 0)
          throw new Error(
            `Managed ${event} hook was edited; merge it manually`,
          );
        entries = entries.filter((_, at) => at !== index);
      }
      hooks[event] = [...entries, desired];
    }
    if (link) link.review = reviewed;
    else {
      config.hooks = hooks;
      after = JSON.stringify(config, null, 2) + "\n";
    }
  }
  if (!link && before !== after)
    changes.push({ path: configPath, before, after });
  const manifest: Manifest = {
    hashes: Object.fromEntries(
      Object.entries(payloads).map(([name, text]) => [name, hash(text)]),
    ),
    command,
    ...(block ? { block } : {}),
    ...(oldLinkedCommands.size
      ? { linkedCommands: [...oldLinkedCommands] }
      : {}),
  };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  if (previousText !== manifestText)
    changes.push({
      path: manifestPath,
      before: previousText,
      after: manifestText,
    });
  const needsManual =
    link &&
    (Object.keys(link.review!.add).length > 0 ||
      Object.keys(link.review!.remove).length > 0);
  return {
    provider: options.provider,
    profilePath,
    changes,
    previewHash: hash(
      JSON.stringify({
        provider: options.provider,
        profilePath,
        changes,
        ...(link ? { link, linkedContent: hash(linkedContents!) } : {}),
      }),
    ),
    installed: changes.length === 0 && !needsManual,
    trustInstructions,
    ...(link ? { linkedSettings: link } : {}),
  };
}
export async function installIntegration(
  options: IntegrationOptions & { expectedPreviewHash: string },
) {
  const preview = await inspectIntegration(options);
  if (
    (preview.linkedSettings && !preview.linkedSettings.review) ||
    preview.previewHash !== options.expectedPreviewHash
  )
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
    if (preview.linkedSettings)
      return { ...(await inspectIntegration(options)), backups };
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
        return {
          provider,
          profilePath,
          exists,
          installed: preview.installed,
          ...(preview.linkedSettings ? { linked: true } : {}),
        };
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
