import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** lsof escapes file names even with NUL-delimited fields. Decode once as bytes. */
export function lsofDirectory(output: Buffer): string {
  const fields: Buffer[] = [];
  for (let start = 0; start < output.length;) {
    let end = output.indexOf(0, start);
    if (end < 0) end = output.length;
    if (output[start] === 110) fields.push(output.subarray(start + 1, end));
    start = end + 1;
  }
  if (fields.length !== 1)
    throw new Error("Current terminal directory is unavailable");
  const field = fields[0],
    bytes: number[] = [];
  const controls: Record<string, number> = {
    "\\": 92,
    a: 7,
    b: 8,
    e: 27,
    f: 12,
    n: 10,
    r: 13,
    t: 9,
    v: 11,
  };
  for (let i = 0; i < field.length; i++) {
    if (field[i] !== 92) {
      bytes.push(field[i]);
      continue;
    }
    const code = String.fromCharCode(field[++i] ?? 0);
    if (code in controls) {
      bytes.push(controls[code]);
      continue;
    }
    if (code === "x") {
      const value = field.subarray(i + 1, i + 3).toString("ascii");
      if (!/^[0-9a-f]{2}$/i.test(value))
        throw new Error("Invalid terminal directory field");
      bytes.push(parseInt(value, 16));
      i += 2;
      continue;
    }
    if (/^[0-7]$/.test(code)) {
      let value = code;
      while (
        value.length < 3 &&
        i + 1 < field.length &&
        field[i + 1] >= 48 &&
        field[i + 1] <= 55
      )
        value += String.fromCharCode(field[++i]);
      const byte = parseInt(value, 8);
      if (byte > 255) throw new Error("Invalid terminal directory field");
      bytes.push(byte);
      continue;
    }
    throw new Error("Invalid terminal directory field");
  }
  const decoded = Buffer.from(bytes);
  if (decoded.includes(0) || !isUtf8(decoded))
    throw new Error("Invalid terminal directory encoding");
  const directory = decoded.toString("utf8");
  if (!path.isAbsolute(directory))
    throw new Error("Current terminal directory is unavailable");
  return directory;
}

export async function terminalDirectory(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Terminal process is unavailable");
  if (process.platform === "linux") return readlink(`/proc/${pid}/cwd`);
  if (process.platform === "darwin") {
    const { stdout } = await run(
      "/usr/sbin/lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn0"],
      { encoding: "buffer", timeout: 2000, maxBuffer: 64 * 1024 },
    );
    return lsofDirectory(stdout);
  }
  throw new Error(
    "Live terminal directory lookup is unavailable on this platform",
  );
}
