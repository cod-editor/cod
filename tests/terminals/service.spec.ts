import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TerminalService } from "../../src/terminals/index";

interface Disposable {
  dispose(): void;
}
export interface NativePty {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): Disposable;
}
export type NativeSpawn = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    cols: number;
    rows: number;
    name: string;
    env: Record<string, string>;
  },
) => NativePty;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, message: string, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(20);
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Runs in real Electron main with the prebuilt native PTY injected by the launcher. */
export async function runTerminalAcceptance(spawn: NativeSpawn) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "cod-terminal-service-"));
  const checks: Record<string, boolean> = {};
  const events: Array<{
    id: string;
    workspaceId: string;
    type: string;
    data?: string;
    exitCode?: number;
    message?: string;
  }> = [];
  const ownedToolPids = new Set<number>();
  let service = new TerminalService({
    spawn,
    onEvent: (event) => events.push(event),
  });
  const options = (id: string, workspaceId: string) => ({
    id,
    workspaceId,
    cwd,
    cols: 80,
    rows: 24,
    shell: "/bin/bash",
    args: ["--noprofile", "--norc", "-i"],
    env: {
      PATH: "/usr/bin:/bin",
      TERM: "xterm-256color",
      PS1: "COD_FIXTURE> ",
      HISTFILE: "/dev/null",
      LC_ALL: "C",
      BASH_SILENCE_DEPRECATION_WARNING: "1",
    },
  });
  const output = (id: string) => service.snapshot(id).output.replace(/\r/g, "");
  async function open(id: string, workspaceId: string) {
    const snapshot = await service.create(options(id, workspaceId));
    assert.equal(snapshot.id, id);
    assert.equal(snapshot.workspaceId, workspaceId);
    await waitFor(
      () => output(id).includes("COD_FIXTURE> "),
      "Shell prompt did not arrive",
    );
    await command(id, "set +H; stty -echo");
    return snapshot;
  }
  async function command(id: string, input: string) {
    const marker = randomUUID();
    const begin = `\nBEGIN-${marker}\n`,
      end = `\nEND-${marker}\n`;
    service.write(
      id,
      `printf '\\nBEGIN-${marker}\\n'; ${input}; printf '\\nEND-${marker}\\n'\r`,
    );
    await waitFor(
      () => output(id).includes(begin) && output(id).includes(end),
      "Terminal command did not complete",
    );
    return output(id).split(begin).at(-1)!.split(end)[0].trim();
  }
  try {
    const first = await open("terminal-a", "workspace-a");
    assert.equal(
      await command(
        first.id,
        "if [ -t 0 ] && [ -t 1 ] && [ -t 2 ]; then printf REAL_TTY; else printf PIPE; fi",
      ),
      "REAL_TTY",
    );
    assert(
      events.some(
        (event) =>
          event.type === "data" &&
          event.id === first.id &&
          event.workspaceId === "workspace-a" &&
          event.data?.includes("REAL_TTY"),
      ),
    );
    assert.equal(service.snapshot(first.id).status, "running");
    checks.AC1_realTTYAndEventRouting = true;

    service.resize(first.id, 111, 37);
    assert.equal(await command(first.id, "stty size"), "37 111");
    assert.equal(service.snapshot(first.id).cols, 111);
    assert.equal(service.snapshot(first.id).rows, 37);
    checks.AC2_nativeResize = true;

    const second = await open("terminal-b", "workspace-b");
    await command(first.id, "COD_FIXTURE_STATE=alpha");
    await command(second.id, "COD_FIXTURE_STATE=beta");
    assert.equal(
      await command(first.id, 'printf "$COD_FIXTURE_STATE"'),
      "alpha",
    );
    assert.equal(
      await command(second.id, 'printf "$COD_FIXTURE_STATE"'),
      "beta",
    );
    await assert.rejects(async () =>
      service.create(options(first.id, "wrong-workspace")),
    );
    await assert.rejects(async () =>
      service.create({
        ...options("bad-cwd", "workspace-a"),
        cwd: path.join(cwd, "missing"),
      }),
    );
    await assert.rejects(async () =>
      service.create({ ...options("bad-size", "workspace-a"), cols: 0 }),
    );
    assert.throws(() => service.write("unknown-terminal", "exit\r"));
    assert.throws(() => service.resize(first.id, Number.NaN, 24));
    assert.throws(() => service.resize(second.id, 80, 1.5));
    assert.equal(service.snapshot(first.id).workspaceId, "workspace-a");
    assert.equal(service.snapshot(first.id).cols, 111);
    assert.equal(service.snapshot(second.id).rows, 24);
    assert.equal(
      await command(second.id, 'printf "$COD_FIXTURE_STATE"'),
      "beta",
    );
    checks.AC3_sessionsAndInvalidInputsIsolated = true;

    service.write(first.id, "sleep 30\r");
    await delay(150);
    service.write(first.id, "\x03");
    assert.equal(
      await command(first.id, "printf AFTER_INTERRUPT"),
      "AFTER_INTERRUPT",
    );
    checks.AC4_foregroundControlC = true;

    const marker = randomUUID();
    service.write(
      first.id,
      `sleep 30 & printf '\\nTOOL-${marker}=%s\\n' "$!"; fg %1\r`,
    );
    const pattern = new RegExp(`\\nTOOL-${marker}=([0-9]+)\\n`);
    await waitFor(
      () => pattern.test(output(first.id)),
      "Foreground PID marker did not arrive",
    );
    const toolPid = Number(output(first.id).match(pattern)![1]);
    ownedToolPids.add(toolPid);
    assert(alive(toolPid));
    await delay(100);
    await service.close(first.id);
    await waitFor(
      () => !alive(first.pid) && !alive(toolPid),
      "Owned shell/ordinary foreground process survived close",
    );
    ownedToolPids.delete(toolPid);
    assert.equal(service.snapshot(first.id).status, "exited");
    assert(
      events.some(
        (event) =>
          event.type === "exit" &&
          event.id === first.id &&
          event.workspaceId === "workspace-a",
      ),
    );
    await service.close(first.id);
    assert.equal(
      await command(second.id, "printf STILL_INDEPENDENT"),
      "STILL_INDEPENDENT",
    );
    checks.AC5_ownedForegroundShutdownAndIdempotency = true;

    const oldPid = second.pid;
    await service.dispose();
    await service.dispose();
    await waitFor(() => !alive(oldPid), "Disposed shell survived");
    service = new TerminalService({
      spawn,
      onEvent: (event) => events.push(event),
    });
    const fresh = await open("terminal-b", "workspace-b");
    assert.notEqual(fresh.pid, oldPid);
    assert.equal(
      await command(fresh.id, 'printf "${COD_FIXTURE_STATE-unset}"'),
      "unset",
    );
    assert(!output(fresh.id).includes("STILL_INDEPENDENT"));
    checks.AC6_freshServiceDoesNotReplayShell = true;

    let notifications = 0;
    const unsubscribe = service.subscribe(() => {
      notifications++;
    });
    const unsubscribeThrower = service.subscribe(() => {
      throw new Error("Invented listener failure");
    });
    const overflowMarker = randomUUID();
    service.write(
      fresh.id,
      `head -c 2097152 /dev/zero | tr '\\000' x; printf '\\nLATEST-${overflowMarker}\\n'\r`,
    );
    await waitFor(
      () => output(fresh.id).includes(`\nLATEST-${overflowMarker}\n`),
      "Latest output lost after overflow",
      10000,
    );
    assert(
      service.snapshot(fresh.id).output.length <= 1024 * 1024,
      "Display cache exceeds1MiB limit",
    );
    assert(notifications > 0);
    unsubscribe();
    unsubscribe();
    unsubscribeThrower();
    const count = notifications;
    assert.equal(
      await command(fresh.id, "printf AFTER_UNSUBSCRIBE"),
      "AFTER_UNSUBSCRIBE",
    );
    await delay(100);
    assert.equal(notifications, count);
    await assert.rejects(async () =>
      service.create({
        ...options("bad-shell", "workspace-b"),
        shell: path.join(cwd, "no-shell"),
      }),
    );
    assert.equal(
      await command(fresh.id, "printf AFTER_SPAWN_ERROR"),
      "AFTER_SPAWN_ERROR",
    );
    checks.AC7_boundedTailAndListenerIsolation = true;
    return {
      result: "PASS",
      runtime: `Electron ${process.versions.electron}`,
      platform: process.platform,
      arch: process.arch,
      checks,
    };
  } finally {
    await service.dispose();
    // Failure cleanup targets only PID values reported by our invented shell job.
    for (const pid of ownedToolPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await rm(cwd, { recursive: true, force: true });
  }
}
