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

export async function readClaudeSession(cwd: string, id: string) {
  requireClaudeId(id);
  const { getSessionInfo, getSessionMessages } = await sdk();
  const session = await getSessionInfo(id, { dir: cwd });
  if (
    !session ||
    session.sessionId !== id ||
    !(await matchingDirectory(session.cwd, cwd))
  )
    return undefined;
  return { session, messages: await getSessionMessages(id, { dir: cwd }) };
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
  nativeId: string;
  resume: boolean;
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
): Promise<{ query: Query; dispose(): Promise<void> }> {
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
      env: options.env,
      ...(options.resume
        ? { resume: options.nativeId }
        : { sessionId: options.nativeId }),
      pathToClaudeCodeExecutable: options.executable,
      persistSession: true,
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: "default",
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
    })());
  try {
    await within(
      session.initializationResult(),
      10_000,
      "Claude Code did not initialize",
    );
    return { query: session, dispose };
  } catch {
    await dispose();
    throw new Error("Could not open the native Claude Code session");
  }
}
