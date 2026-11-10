import { execFile } from "node:child_process";
import { realpath, stat, lstat, opendir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, sep, dirname } from "node:path";

const SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "target",
]);
const MAX_ENTRIES = 20_000;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const MAX_GIT_BYTES = 8 * 1024 * 1024;
const inside = (root: string, path: string) =>
  path === root ||
  (!relative(root, path).startsWith(`..${sep}`) &&
    relative(root, path) !== ".." &&
    !isAbsolute(relative(root, path)));
interface Repository {
  root: string;
  branch: string | null;
  head: string | null;
}
interface Entry {
  name: string;
  path: string;
  kind: "file" | "directory";
  root: string;
}
interface Match {
  path: string;
  root: string;
  line: number;
  text: string;
}

function git(cwd: string, args: string[]): Promise<string> {
  const environment = { ...process.env };
  // Git must address cwd, not an inherited repository/index/object store or injected config.
  for (const key of Object.keys(environment)) {
    if (
      [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_PREFIX",
        "GIT_CONFIG",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
      ].includes(key) ||
      /^GIT_CONFIG_(KEY|VALUE)_/.test(key)
    )
      delete environment[key];
  }
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-pager", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_GIT_BYTES,
        timeout: 15_000,
        env: {
          ...environment,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                ? "Git output exceeded 8 MiB limit"
                : `Git command failed (${String(error.code ?? "unknown")})`,
            ),
          );
        else resolve(stdout);
      },
    );
  });
}

export class ProjectService {
  private readonly configured: string[];
  constructor(options: { roots: string[] }) {
    if (
      !Array.isArray(options.roots) ||
      options.roots.some(
        (root) => typeof root !== "string" || !isAbsolute(root),
      )
    )
      throw new Error("Project roots must be absolute directories");
    this.configured = [...options.roots];
  }
  private async roots(): Promise<string[]> {
    const roots = await Promise.all(
      this.configured.map(async (root) => {
        const path = await realpath(root);
        if (!(await stat(path)).isDirectory())
          throw new Error("Project root is not a directory");
        return path;
      }),
    );
    return [...new Set(roots)];
  }
  private rootFor(roots: string[], path: string): string {
    const root = roots
      .filter((root) => inside(root, path))
      .sort((a, b) => b.length - a.length)[0];
    if (!root) throw new Error("Path is outside project roots");
    return root;
  }
  async list(directory?: string): Promise<Entry[]> {
    const roots = await this.roots();
    const dirs = directory ? [await realpath(directory)] : roots;
    if (directory) {
      const root = this.rootFor(roots, dirs[0]);
      let cursor = directory;
      if (!isAbsolute(cursor)) throw new Error("Directory must be absolute");
      while (true) {
        if ((await lstat(cursor)).isSymbolicLink())
          throw new Error("Directory symlink traversal is not allowed");
        if ((await realpath(cursor)) === root) break;
        const parent = dirname(cursor);
        if (parent === cursor)
          throw new Error("Directory is outside project roots");
        cursor = parent;
      }
    }
    const found = new Map<string, Entry>();
    for (const dir of dirs) {
      const root = this.rootFor(roots, dir);
      if (!(await stat(dir)).isDirectory())
        throw new Error("Target is not a directory");
      // Explicit paths must not bypass excluded directories.
      if (
        relative(root, dir)
          .split(sep)
          .some((part) => SKIP.has(part))
      )
        throw new Error("Directory is excluded");
      for await (const item of await opendir(dir)) {
        if (SKIP.has(item.name)) continue;
        const path = join(dir, item.name);
        if (item.isDirectory() || item.isFile())
          found.set(path, {
            name: item.name,
            path,
            kind: item.isDirectory() ? "directory" : "file",
            root,
          });
        else if (item.isSymbolicLink()) {
          try {
            if ((await stat(path)).isFile())
              found.set(path, { name: item.name, path, kind: "file", root });
          } catch {
            /* broken links are not navigable */
          }
        }
        if (found.size > MAX_ENTRIES)
          throw new Error("Directory listing exceeds entry limit");
      }
    }
    return [...found.values()].sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name)
        : a.kind === "directory"
          ? -1
          : 1,
    );
  }
  private async walk(
    roots: string[],
    visit: (path: string, root: string, isDir: boolean) => Promise<void>,
  ): Promise<boolean> {
    const seen = new Set<string>();
    let count = 0,
      truncated = false;
    const walk = async (dir: string, root: string): Promise<void> => {
      if (relative(root, dir).split(sep).length > 128) {
        truncated = true;
        return;
      }
      if (
        (await lstat(dir)).isSymbolicLink() ||
        !inside(root, await realpath(dir))
      ) {
        truncated = true;
        return;
      }
      if (seen.has(dir)) return;
      seen.add(dir);
      await visit(dir, root, true);
      for await (const item of await opendir(dir)) {
        if (SKIP.has(item.name) || item.isSymbolicLink()) continue;
        if (++count > MAX_ENTRIES) {
          truncated = true;
          return;
        }
        const path = join(dir, item.name);
        if (item.isDirectory()) await walk(path, root);
        else if (item.isFile()) await visit(path, root, false);
        if (truncated) return;
      }
    };
    for (const root of roots) {
      await walk(root, root);
      if (truncated) break;
    }
    return truncated;
  }
  async repositories(): Promise<{
    repositories: Repository[];
    truncated: boolean;
  }> {
    const roots = await this.roots();
    const repos = new Map<string, Repository>();
    const discover = async (path: string) => {
      let top: string;
      try {
        top = await realpath(
          (await git(path, ["rev-parse", "--show-toplevel"])).replace(
            /\n$/,
            "",
          ),
        );
      } catch {
        return;
      }
      if (repos.has(top)) return;
      let head: string | null = null,
        branch: string | null = null;
      try {
        head = (await git(top, ["rev-parse", "--verify", "HEAD"])).trim();
      } catch {
        /* unborn */
      }
      try {
        branch = (
          await git(top, ["symbolic-ref", "--quiet", "--short", "HEAD"])
        ).trim();
      } catch {
        /* detached */
      }
      repos.set(top, { root: top, branch, head });
    };
    for (const root of roots) await discover(root);
    const truncated = await this.walk(roots, async (path, _root, isDir) => {
      if (!isDir) return;
      try {
        await stat(join(path, ".git"));
        await discover(path);
      } catch {
        /* ordinary folder */
      }
    });
    return {
      repositories: [...repos.values()].sort((a, b) =>
        a.root.localeCompare(b.root),
      ),
      truncated,
    };
  }
  async search(options: {
    query: string;
    maxResults?: number;
  }): Promise<{ matches: Match[]; truncated: boolean }> {
    if (typeof options.query !== "string" || !options.query.length)
      throw new Error("Search query must not be empty");
    const max = options.maxResults ?? 100;
    if (!Number.isInteger(max) || max < 1 || max > 1000)
      throw new Error("Search result limit must be 1-1000");
    const roots = await this.roots();
    const discovery = await this.repositories();
    let truncated = discovery.truncated,
      bytes = 0;
    const allowed = new Map<string, Set<string>>();
    for (const repo of discovery.repositories) {
      try {
        allowed.set(
          repo.root,
          new Set(
            (
              await git(repo.root, [
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
              ])
            )
              .split("\0")
              .filter(Boolean)
              .map((path) => join(repo.root, path)),
          ),
        );
      } catch {
        truncated = true;
        allowed.set(repo.root, new Set());
      }
    }
    const repoRoots = [...allowed.keys()].sort((a, b) => b.length - a.length);
    const matches: Match[] = [];
    const query = options.query.toLowerCase();
    const walkTruncated = await this.walk(roots, async (path, root, isDir) => {
      if (isDir) return;
      const repo = repoRoots.find((repo) => inside(repo, path));
      if (repo && !allowed.get(repo)!.has(path)) return;
      // Bound reads themselves, not just a size observed before a concurrent write.
      if (!inside(root, await realpath(path))) {
        truncated = true;
        return;
      }
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let content: Buffer;
      try {
        const size = (await handle.stat()).size;
        if (size > MAX_FILE || bytes + size > MAX_SEARCH_BYTES) {
          truncated = true;
          return;
        }
        const buffer = Buffer.alloc(
          Math.min(MAX_FILE + 1, MAX_SEARCH_BYTES - bytes + 1),
        );
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const chunk = await handle.read(
            buffer,
            bytesRead,
            buffer.length - bytesRead,
            bytesRead,
          );
          if (!chunk.bytesRead) break;
          bytesRead += chunk.bytesRead;
        }
        if (bytesRead > MAX_FILE || bytes + bytesRead > MAX_SEARCH_BYTES) {
          truncated = true;
          return;
        }
        bytes += bytesRead;
        content = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      if (content.includes(0)) return;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch {
        return;
      }
      for (const [index, line] of text.split(/\r?\n/).entries())
        if (line.toLowerCase().includes(query)) {
          if (matches.length >= max) {
            truncated = true;
            return;
          }
          matches.push({ path, root, line: index + 1, text: line });
        }
    });
    return { matches, truncated: truncated || walkTruncated };
  }
  private async repository(repoRoot: string): Promise<Repository> {
    if (!isAbsolute(repoRoot))
      throw new Error("Repository path must be absolute");
    const path = await realpath(repoRoot);
    const found = (await this.repositories()).repositories.find(
      (repo) => repo.root === path,
    );
    if (!found) throw new Error("Repository is not part of configured roots");
    return found;
  }
  async changes(repoRoot: string) {
    const repo = await this.repository(repoRoot);
    const parts = (
      await git(repo.root, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ])
    ).split("\0");
    const files: Array<{
      path: string;
      relativePath: string;
      indexStatus: string;
      worktreeStatus: string;
      oldPath?: string;
    }> = [];
    for (let i = 0; i < parts.length; i++) {
      const item = parts[i];
      if (!item) continue;
      const indexStatus = item[0],
        worktreeStatus = item[1],
        relativePath = item.slice(3);
      const oldPath =
        indexStatus === "R" ||
        indexStatus === "C" ||
        worktreeStatus === "R" ||
        worktreeStatus === "C"
          ? join(repo.root, parts[++i])
          : undefined;
      files.push({
        path: join(repo.root, relativePath),
        relativePath,
        indexStatus,
        worktreeStatus,
        ...(oldPath ? { oldPath } : {}),
      });
    }
    return { repoRoot: repo.root, files };
  }
  async diff(options: { repoRoot: string; base?: string; head?: string }) {
    const repo = await this.repository(options.repoRoot);
    if ((options.base === undefined) !== (options.head === undefined))
      throw new Error("Both base and head are required");
    const resolve = async (ref: string) => {
      if (
        typeof ref !== "string" ||
        !ref ||
        ref.startsWith("-") ||
        ref.includes("\0")
      )
        throw new Error("Invalid Git revision");
      return (
        await git(repo.root, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${ref}^{commit}`,
        ])
      ).trim();
    };
    const base =
      options.base === undefined ? null : await resolve(options.base);
    const head =
      options.head === undefined ? null : await resolve(options.head);
    const workingBase =
      repo.head ??
      (await git(repo.root, ["hash-object", "-t", "tree", "/dev/null"])).trim();
    const patch = await git(repo.root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      ...(base && head ? [base, head] : [workingBase]),
      "--",
    ]);
    return { repoRoot: repo.root, base, head, patch, truncated: false };
  }
}
