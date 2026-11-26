import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ClaudeApiStatus =
  | { kind: "native" | "unavailable" | "locked" }
  | { kind: "saved"; endpoint: string };

export type ClaudeApiRequest =
  | { action: "status" | "remove" }
  | { action: "save"; endpoint: string; token: string };

export type ClaudeApiCrypto = {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string }>;
};

type ClaudeApiRoute = { endpoint: string; token: string };
const maxCiphertextBytes = 64 * 1024;
const unavailable = "Secure Claude API storage is unavailable on this device.";
const locked = "Allow Cod to access Keychain and try again.";

function parseRoute(value: unknown): ClaudeApiRoute {
  const route = value as Partial<ClaudeApiRoute> | null;
  const endpoint =
    typeof route?.endpoint === "string" ? route.endpoint.trim() : "";
  let url: URL | undefined;
  try {
    if (endpoint.length <= 2048 && !/[\s\\?#]/.test(endpoint))
      url = new URL(endpoint);
  } catch {
    // Report invalid routes without repeating user-supplied values.
  }
  if (
    !url ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Enter a valid HTTPS API URL or a local loopback URL.");
  const token = route?.token;
  if (typeof token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(token))
    throw new Error("Enter a valid API token.");
  return { endpoint: url.href, token };
}

export class ClaudeApiSettings {
  private readonly root: string;
  private readonly file: string;
  private readonly crypto?: ClaudeApiCrypto;
  private queue: Promise<unknown> = Promise.resolve();
  private version = 0;

  constructor(root: string, crypto?: ClaudeApiCrypto) {
    this.root = root;
    this.crypto = crypto;
    this.file = path.join(root, "claude-api.enc");
  }

  get revision(): number {
    return this.version;
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async ciphertext(): Promise<Buffer | undefined> {
    const file = await open(
      this.file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    });
    if (!file) return;
    try {
      const stat = await file.stat();
      const { size } = stat;
      if (
        !stat.isFile() ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (stat.mode & 0o077) !== 0 ||
        size < 1 ||
        size > maxCiphertextBytes
      )
        throw new Error(locked);
      const buffer = Buffer.alloc(size + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== size) throw new Error(locked);
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }

  private async route(): Promise<ClaudeApiRoute | undefined> {
    if (!this.crypto) return;
    try {
      const data = await this.ciphertext();
      if (!data) return;
      if (!(await this.crypto.isAsyncEncryptionAvailable()))
        throw new Error(locked);
      const { result } = await this.crypto.decryptStringAsync(data);
      return parseRoute(JSON.parse(result));
    } catch {
      throw new Error(locked);
    }
  }

  command(request: ClaudeApiRequest): Promise<ClaudeApiStatus> {
    return this.run(async () => {
      if (!this.crypto) {
        if (request?.action === "status") return { kind: "unavailable" };
        throw new Error(unavailable);
      }
      switch (request?.action) {
        case "status":
          try {
            const saved = await this.route();
            return saved
              ? { kind: "saved", endpoint: saved.endpoint }
              : { kind: "native" };
          } catch {
            return { kind: "locked" };
          }
        case "save": {
          const route = parseRoute(request);
          if (
            !(await this.crypto.isAsyncEncryptionAvailable().catch(() => false))
          )
            throw new Error(locked);
          const bytes = await this.crypto
            .encryptStringAsync(JSON.stringify(route))
            .catch(() => {
              throw new Error(locked);
            });
          const temporary = `${this.file}.${randomUUID()}.tmp`;
          try {
            if (bytes.length < 1 || bytes.length > maxCiphertextBytes)
              throw new Error();
            await mkdir(this.root, { recursive: true, mode: 0o700 });
            await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
            await rename(temporary, this.file);
          } catch {
            throw new Error("Could not save Claude API authentication.");
          } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
          }
          this.version++;
          return { kind: "saved", endpoint: route.endpoint };
        }
        case "remove":
          await rm(this.file, { force: true }).catch(() => {
            throw new Error("Could not remove Claude API authentication.");
          });
          this.version++;
          return { kind: "native" };
        default:
          throw new Error("Unknown Claude API settings action.");
      }
    });
  }

  environment(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    return this.run(async () => {
      const route = await this.route();
      if (!route) return env;
      const effective = { ...env };
      // This explicitly chosen route applies only to the managed Claude process.
      for (const name of [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_CUSTOM_HEADERS",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
      ])
        delete effective[name];
      return {
        ...effective,
        ANTHROPIC_BASE_URL: route.endpoint,
        ANTHROPIC_AUTH_TOKEN: route.token,
      };
    });
  }
}
