import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
function subscriptionEnv() {
  const env = { ...process.env };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
    "CLAUDECODE",
  ])
    delete env[name];
  return env;
}

export class Rpc {
  constructor(command, args, cwd) {
    this.messages = [];
    this.pending = new Map();
    this.sequence = 0;
    this.child = spawn(command, args, {
      cwd,
      env: subscriptionEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = false;
    this.child.on("error", (error) => {
      this.failure = error;
      this.rejectPending(error);
    });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.failure = new Error(`Provider exited (${code ?? signal})`);
      this.rejectPending(this.failure);
    });
    this.child.stdin.on("error", (error) => {
      this.failure = error;
      this.rejectPending(error);
    });
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      this.messages.push(message);
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          clearTimeout(pending.timeout);
          message.error
            ? pending.reject(new Error(JSON.stringify(message.error)))
            : pending.resolve(message.result);
        }
      } else if (message.id !== undefined && message.method) {
        this.onRequest?.(message);
      }
    });
  }
  rejectPending(error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timeout);
      p.reject(error);
    }
    this.pending.clear();
  }
  send(message) {
    if (this.failure || this.exited)
      throw this.failure ?? new Error("Provider exited");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method, params, timeoutMs = 90000) {
    if (this.failure || this.exited)
      return Promise.reject(this.failure ?? new Error("Provider exited"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async wait(predicate, after = 0, timeoutMs = 90000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const message = this.messages.slice(after).find(predicate);
      if (message) return message;
      if (this.failure || this.exited)
        throw this.failure ?? new Error("Provider exited");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timeout waiting for event");
  }
  async close(signal = "SIGTERM") {
    for (const p of this.pending.values()) {
      clearTimeout(p.timeout);
      p.reject(new Error("Closed"));
    }
    this.pending.clear();
    if (this.exited) return;
    if (signal === "SIGTERM") this.child.stdin.end();
    this.child.kill(signal);
    await new Promise((resolve) => {
      if (
        this.exited ||
        this.child.exitCode !== null ||
        this.child.signalCode !== null
      )
        resolve();
      else {
        this.child.once("exit", resolve);
        setTimeout(() => {
          this.child.kill("SIGKILL");
          resolve();
        }, 2000).unref();
      }
    });
  }
}
