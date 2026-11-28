import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

const sdk = () => import("@anthropic-ai/claude-agent-sdk");

function requireClaudeId(id: string): void {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    throw new Error("Claude Code session ID must be a UUID");
}

async function matchingDirectory(saved: string | undefined, cwd: string) {
  if (!saved || !isAbsolute(saved)) return false;
  if (resolve(saved) === resolve(cwd)) return true;
  try {
    return (await realpath(saved)) === (await realpath(cwd));
  } catch {
    return false;
  }
}

export async function discoverClaudeSessions(cwd: string) {
  const { listSessions } = await sdk();
  const sessions = await listSessions({ dir: cwd, includeWorktrees: false });
  const matches = await Promise.all(
    sessions.map((session) => matchingDirectory(session.cwd, cwd)),
  );
  return sessions.filter((_, index) => matches[index]);
}

export async function findClaudeSession(cwd: string, id: string) {
  requireClaudeId(id);
  const { getSessionInfo } = await sdk();
  const session = await getSessionInfo(id, { dir: cwd });
  if (
    !session ||
    session.sessionId !== id ||
    !(await matchingDirectory(session.cwd, cwd))
  )
    return undefined;
  return session;
}

export async function readClaudeMessages(
  cwd: string,
  id: string,
  limit?: number,
) {
  const { getSessionMessages } = await sdk();
  return getSessionMessages(id, { dir: cwd, limit });
}

export async function readClaudeSession(cwd: string, id: string) {
  const session = await findClaudeSession(cwd, id);
  if (!session) return undefined;
  return { session, messages: await readClaudeMessages(cwd, id) };
}

export function claudeHandoffArgs(id: string, hasHistory: boolean): string[] {
  requireClaudeId(id);
  return [hasHistory ? "--resume" : "--session-id", id];
}

type ClaudeSessionOptions = {
  cwd: string;
  executable: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  environment?: () => Promise<NodeJS.ProcessEnv>;
  nativeId: string;
  resume: boolean;
  persistSession?: boolean;
  allowBypass?: boolean;
  canUseTool?: Options["canUseTool"];
};

function within<T>(promise: Promise<T>, timeoutMs: number, reason: string) {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function openClaudeSession(
  options: ClaudeSessionOptions,
  prompt: AsyncIterable<SDKUserMessage>,
): Promise<{
  query: Query;
  ready: Promise<unknown>;
  dispose(): Promise<void>;
}> {
  requireClaudeId(options.nativeId);
  if (!isAbsolute(options.cwd) || !isAbsolute(options.executable))
    throw new Error("Claude Code cwd and executable must be absolute paths");
  const { query } = await sdk();
  let child: ChildProcessWithoutNullStreams | undefined;
  let childExit: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  const session = query({
    prompt,
    options: {
      cwd: options.cwd,
      env: options.environment ? await options.environment() : options.env,
      ...(options.resume
        ? { resume: options.nativeId }
        : { sessionId: options.nativeId }),
      pathToClaudeCodeExecutable: options.executable,
      persistSession: options.persistSession ?? true,
      settingSources: [],
      strictMcpConfig: true,
      tools: { type: "preset", preset: "claude_code" },
      permissionMode: "default",
      ...(options.allowBypass && { allowDangerouslySkipPermissions: true }),
      includePartialMessages: true,
      extraArgs: { "replay-user-messages": null },
      canUseTool: options.canUseTool,
      spawnClaudeCodeProcess({ command, args, cwd, env, signal }) {
        const process = spawn(command, [...(options.args ?? []), ...args], {
          cwd,
          env,
          signal,
        });
        // The SDK does not consume stderr for a custom spawner.
        process.stderr.resume();
        child = process;
        childExit = new Promise((done) => process.once("close", () => done()));
        return process;
      },
    },
  });
  const dispose = () =>
    (disposal ??= (async () => {
      session.close();
      if (!childExit) return;
      try {
        await within(childExit, 5_000, "Claude Code did not exit");
      } catch {
        if (child?.exitCode === null && child?.signalCode === null)
          child.kill("SIGKILL");
        await within(
          childExit,
          2_000,
          "Claude Code did not release the session",
        );
      }
    })().catch((error) => {
      disposal = undefined;
      throw error;
    }));
  const ready = within(
    session.initializationResult(),
    10_000,
    "Claude Code did not initialize",
  );
  return { query: session, ready, dispose };
}
