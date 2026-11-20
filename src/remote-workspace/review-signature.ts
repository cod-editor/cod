import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const signatureLimit = 16 * 1024;
const namespace = "cod-review";

function challengeContent(challenge: string): string {
  if (!/^[a-zA-Z0-9_-]{43}$/.test(challenge))
    throw new Error("Invalid remote review challenge");
  return "cod-review/v1\n" + challenge + "\n";
}

function keygen(args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/ssh-keygen", args, {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 8000,
      env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" },
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.length > signatureLimit) child.kill();
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && output.length <= signatureLimit) resolve(output);
      else reject(new Error("The paired SSH key could not authorize review"));
    });
  });
}

export async function signWorkspaceReview(
  publicKey: string,
  challenge: string,
): Promise<string> {
  if (!path.isAbsolute(publicKey) || !publicKey.endsWith(".pub"))
    throw new Error("Choose an absolute SSH public key path ending in .pub");
  const content = challengeContent(challenge);
  const entry = await lstat(publicKey);
  if (!entry.isFile() || entry.size > signatureLimit)
    throw new Error("Choose an SSH public key file");
  return keygen(["-Y", "sign", "-f", publicKey, "-n", namespace], content);
}

export function workspaceReviewChallenge(): string {
  return randomBytes(32).toString("base64url");
}

export async function readWorkspaceSigners(profile: string): Promise<Buffer> {
  const file = await open(
    path.join(profile, "desktop-signers"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const entry = await file.stat();
    if (
      !entry.isFile() ||
      entry.uid !== process.getuid?.() ||
      (entry.mode & 0o022) !== 0 ||
      entry.size > signatureLimit
    )
      throw new Error("The Linux workspace has no valid desktop signers");
    const contents = Buffer.alloc(signatureLimit + 1);
    const { bytesRead } = await file.read(contents, 0, contents.length, 0);
    if (bytesRead > signatureLimit)
      throw new Error("The Linux workspace desktop signers file is too large");
    return contents.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

export function workspaceSignersDigest(signers: Buffer): string {
  return createHash("sha256").update(signers).digest("base64");
}

export async function verifyWorkspaceReview(
  signers: Buffer,
  challenge: string,
  signature: string,
): Promise<void> {
  if (!signature || Buffer.byteLength(signature) > signatureLimit)
    throw new Error("Invalid remote review signature");
  const content = challengeContent(challenge);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cod-proof-"));
  try {
    const allowed = path.join(temporary, "signers");
    const proof = path.join(temporary, "signature");
    await Promise.all([
      writeFile(allowed, signers, { mode: 0o600 }),
      writeFile(proof, signature, { mode: 0o600 }),
    ]);
    await keygen(
      [
        "-Y",
        "verify",
        "-f",
        allowed,
        "-I",
        "cod-desktop",
        "-n",
        namespace,
        "-s",
        proof,
      ],
      content,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
