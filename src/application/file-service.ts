import { isUtf8 } from "node:buffer";
import os from "node:os";
import path from "node:path";
import {
  realpath,
  stat,
  readFile,
  writeFile,
  open,
  chmod,
  rename,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  OperationRequest,
  WorkspaceState,
  PaneState,
  FileDraft,
} from "../types";
import { ProjectService } from "../projects";
import { changedLines } from "../git-lines";
import { ApplicationStateStore } from "./state";
import { requiredString } from "./request";
import { leaf, replaceLeaf, removeLeaf } from "./layout";

async function readTextFile(file: string): Promise<string> {
  const bytes = await readFile(file);
  if (bytes.includes(0) || !isUtf8(bytes))
    throw new Error("Binary files cannot be opened or saved as text");
  return bytes.toString("utf8");
}

export class FileApplicationService {
  constructor(private readonly store: ApplicationStateStore) {}
  async openFile(request: OperationRequest): Promise<{ paneId: string }> {
    const filePath = await realpath(
      path.resolve(requiredString(request, "path")),
    );
    if (/\.(png|jpe?g|gif|webp|apng)$/i.test(filePath))
      return this.openResourcePane({
        ...request,
        op: "preview.open",
        path: filePath,
      });
    return this.store.change(() => this.openTextFile(request));
  }
  private async openTextFile(
    request: OperationRequest,
  ): Promise<{ paneId: string }> {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const filePath = path.resolve(requiredString(request, "path"));
    const canonicalPath = await realpath(filePath);
    const line = request.line === undefined ? undefined : Number(request.line);
    if (line !== undefined && (!Number.isInteger(line) || line < 1))
      throw new Error("line must be a positive integer");
    if (!(await stat(filePath)).isFile())
      throw new Error("File path is not a regular file");
    await readTextFile(filePath);
    const opening = this.store.openingPane(workspace, request);
    const existing = workspace.panes.find(
      (pane) =>
        pane.kind === "document" && pane.canonicalPath === canonicalPath,
    );
    if (existing && existing.kind === "document") {
      existing.line = line;
      if (opening.kind === "empty" && opening.launcher) {
        if (opening.pinned) existing.pinned = true;
        workspace.panes = workspace.panes.filter(
          (pane) => pane.id !== opening.id,
        );
        workspace.layout =
          removeLeaf(workspace.layout, opening.id) ?? leaf(existing.id);
      }
      workspace.activePaneId = existing.id;
      return { paneId: existing.id };
    }
    let pane = opening;
    if (pane.kind === "empty" && pane.launcher) {
      const document: PaneState = {
        id: pane.id,
        pinned: pane.pinned,
        kind: "document",
        filePath,
        canonicalPath,
        ...(line ? { line } : {}),
      };
      workspace.panes[workspace.panes.indexOf(pane)] = document;
      pane = document;
    } else if (pane.kind !== "document" || pane.filePath || pane.draftChat) {
      const document: PaneState = {
        id: randomUUID(),
        kind: "document",
        filePath,
        canonicalPath,
        ...(line ? { line } : {}),
      };
      workspace.panes.push(document);
      workspace.layout = replaceLeaf(workspace.layout, workspace.activePaneId, {
        type: "split",
        direction: "right",
        ratio: 0.5,
        first: leaf(workspace.activePaneId),
        second: leaf(document.id),
      });
      pane = document;
    } else {
      pane.filePath = filePath;
      pane.canonicalPath = canonicalPath;
      pane.line = line;
    }
    workspace.activePaneId = pane.id;
    return { paneId: pane.id };
  }

  projects(request: OperationRequest): ProjectService {
    return new ProjectService({
      roots: this.store.workspace(requiredString(request, "workspace")).folders,
    });
  }
  async openResourcePane(
    request: OperationRequest,
  ): Promise<{ paneId: string }> {
    const workspaceId = requiredString(request, "workspace");
    this.store.workspace(workspaceId);
    let resource:
      | Omit<import("../types").PreviewPane, "id">
      | Omit<import("../types").DiffPane, "id">;
    if (request.op === "preview.open") {
      const filePath = await realpath(requiredString(request, "path"));
      if (!(await stat(filePath)).isFile())
        throw new Error("Preview path must be a file");
      resource = {
        kind: "preview",
        filePath,
        ...(/\.(png|jpe?g|gif|webp|apng)$/i.test(filePath)
          ? { format: "image" as const }
          : {}),
      };
    } else {
      const diff = await this.projects(request).diff({
        repoRoot: requiredString(request, "repoRoot"),
        base: request.base as string | undefined,
        head: request.head as string | undefined,
      });
      resource = {
        kind: "diff",
        repoRoot: diff.repoRoot,
        ...(request.base === undefined
          ? {}
          : { base: String(request.base), head: String(request.head) }),
      };
    }
    return this.store.change(() => {
      const workspace = this.store.workspace(workspaceId);
      const opening = this.store.openingPane(workspace, request);
      const existing =
        resource.kind === "preview"
          ? workspace.panes.find(
              (p) => p.kind === "preview" && p.filePath === resource.filePath,
            )
          : undefined;
      if (existing) {
        if (existing.kind === "preview" && resource.kind === "preview")
          existing.format = resource.format;
        if (opening.kind === "empty" && opening.launcher) {
          if (opening.pinned) existing.pinned = true;
          workspace.panes = workspace.panes.filter(
            (pane) => pane.id !== opening.id,
          );
          workspace.layout =
            removeLeaf(workspace.layout, opening.id) ?? leaf(existing.id);
        }
        workspace.activePaneId = existing.id;
        return { paneId: existing.id };
      }
      const launcher =
        opening.kind === "empty" && opening.launcher ? opening : undefined;
      if (launcher) {
        workspace.panes[workspace.panes.indexOf(launcher)] = {
          id: launcher.id,
          pinned: launcher.pinned,
          ...resource,
        };
        workspace.activePaneId = launcher.id;
        return { paneId: launcher.id };
      }
      const active = workspace.activePaneId,
        id = randomUUID();
      workspace.panes.push({ id, ...resource });
      workspace.layout = replaceLeaf(workspace.layout, active, {
        type: "split",
        direction: "right",
        ratio: 0.5,
        first: leaf(active),
        second: leaf(id),
      });
      workspace.activePaneId = id;
      return { paneId: id };
    });
  }
  async saveDraft(request: OperationRequest): Promise<{ saved: true }> {
    const { pane } = this.filePane(request);
    if (pane.kind !== "document") throw new Error("Not a document");
    if (
      typeof request.content !== "string" ||
      typeof request.expectedContent !== "string"
    )
      throw new Error("Draft content and expectedContent must be strings");
    const canonical = pane.canonicalPath ?? (await realpath(pane.filePath!));
    this.store.data.drafts[canonical] = {
      content: request.content,
      expectedContent: request.expectedContent,
    };
    this.store.schedulePersist();
    return { saved: true };
  }
  async fileLines(
    request: OperationRequest,
  ): Promise<{ lines: number[]; error?: string }> {
    const { pane } = this.filePane(request);
    if (pane.kind !== "document") throw new Error("Not a document");
    const file = await realpath(pane.filePath!);
    const service = this.projects(request),
      discovery = await service.repositories();
    const repo = discovery.repositories
      .filter((repo) => file.startsWith(repo.root + path.sep))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (!repo) return { lines: [] };
    const diff = await service.diff({ repoRoot: repo.root });
    return { lines: changedLines(diff.patch, repo.root, file) };
  }
  async readImage(
    request: OperationRequest,
  ): Promise<import("../providers/types").ImageAttachment> {
    const result = await this.resolveFile(request);
    if (result.candidates.length !== 1)
      throw new Error(
        "Image reference must resolve to one file inside workspace folders",
      );
    const file = result.candidates[0]!.path;
    const roots = await Promise.all(
      this.store
        .workspace(requiredString(request, "workspace"))
        .folders.map((root) => realpath(root).catch(() => "")),
    );
    if (!roots.some((root) => root && file.startsWith(root + path.sep)))
      throw new Error(
        "Automatic image previews are limited to workspace folders",
      );
    return this.readImageFile(file);
  }
  private async readImageFile(
    file: string,
  ): Promise<import("../providers/types").ImageAttachment> {
    const expected = await stat(file);
    if (expected.size > 20 * 1024 * 1024)
      throw new Error("Image exceeds 20 MiB");
    const handle = await open(file, "r");
    try {
      const actual = await handle.stat();
      if (
        actual.ino !== expected.ino ||
        actual.dev !== expected.dev ||
        !actual.isFile()
      )
        throw new Error("Image file changed while opening");
      const buffer = Buffer.alloc(
        Math.min(actual.size + 1, 20 * 1024 * 1024 + 1),
      );
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > actual.size || length > 20 * 1024 * 1024)
        throw new Error("Image grew while reading");
      const bytes = buffer.subarray(0, length);
      const mimeType = bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          ? "image/jpeg"
          : ["GIF87a", "GIF89a"].includes(
                bytes.subarray(0, 6).toString("ascii"),
              )
            ? "image/gif"
            : bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
                bytes.subarray(8, 12).toString("ascii") === "WEBP"
              ? "image/webp"
              : undefined;
      if (!mimeType) throw new Error("Unsupported or invalid image file");
      return {
        mimeType,
        data: bytes.toString("base64"),
        name: path.basename(file),
      };
    } finally {
      await handle.close();
    }
  }

  async resolveFile(
    request: OperationRequest,
  ): Promise<{ candidates: Array<{ path: string }>; line?: number }> {
    const workspace = this.store.workspace(
        requiredString(request, "workspace"),
      ),
      reference = requiredString(request, "path");
    const find = async (reference: string) => {
      if (path.isAbsolute(reference) || reference.startsWith("~/")) {
        try {
          const file = await realpath(
            reference.startsWith("~/")
              ? path.join(os.homedir(), reference.slice(2))
              : reference,
          );
          return (await stat(file)).isFile() ? [{ path: file }] : [];
        } catch {
          return [];
        }
      }
      const matches = new Set<string>();
      for (const folder of workspace.folders)
        try {
          const root = await realpath(folder),
            candidate = await realpath(path.resolve(root, reference));
          if (
            candidate.startsWith(root + path.sep) &&
            (await stat(candidate)).isFile()
          )
            matches.add(candidate);
        } catch {
          /* A missing candidate does not authorize another implicit root. */
        }
      return [...matches].map((path) => ({ path }));
    };
    const exact = await find(reference);
    if (exact.length) return { candidates: exact };
    const suffix = reference.match(/:(\d+)$/);
    return suffix
      ? {
          candidates: await find(reference.slice(0, -suffix[0].length)),
          line: Number(suffix[1]),
        }
      : { candidates: [] };
  }

  filePane(request: OperationRequest): {
    workspace: WorkspaceState;
    pane: Extract<PaneState, { kind: "document" }>;
  } {
    const workspace = this.store.workspace(
      requiredString(request, "workspace"),
    );
    const pane = this.store.pane(workspace, requiredString(request, "paneId"));
    if (pane.kind !== "document" || !pane.filePath)
      throw new Error("Pane has no open file");
    return { workspace, pane };
  }

  async fileVersion(request: OperationRequest): Promise<{ version: string }> {
    const { pane } = this.filePane(request);
    try {
      const metadata = await stat(pane.filePath!, { bigint: true });
      return {
        version: `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`,
      };
    } catch {
      return { version: "unavailable" };
    }
  }
  async readPaneFile(request: OperationRequest): Promise<{
    content: string;
    draft?: FileDraft;
    unavailable?: boolean;
    version?: string;
  }> {
    const { pane } = this.filePane(request);
    if (pane.kind !== "document") throw new Error("Pane has no open file");
    let canonical = pane.canonicalPath ?? path.resolve(pane.filePath!);
    try {
      canonical = await realpath(pane.filePath!);
      const version = (await this.fileVersion(request)).version;
      const content = await readTextFile(canonical),
        draft = this.store.data.drafts[canonical];
      return {
        content,
        version,
        ...(draft ? { draft: structuredClone(draft) } : {}),
      };
    } catch (error) {
      const draft = this.store.data.drafts[canonical];
      if (draft)
        return {
          content: "",
          draft: structuredClone(draft),
          unavailable: true,
        };
      throw error;
    }
  }

  async savePaneFile(
    request: OperationRequest,
  ): Promise<{ saved: boolean; conflict: boolean }> {
    const { pane } = this.filePane(request);
    if (pane.kind !== "document") throw new Error("Pane has no open file");
    const content = request.content;
    const expectedContent = request.expectedContent;
    if (typeof content !== "string" || typeof expectedContent !== "string") {
      throw new Error("content and expectedContent must be strings");
    }
    const targetPath = await realpath(pane.filePath!);
    const current = await readTextFile(targetPath);
    if (current !== expectedContent) return { saved: false, conflict: true };
    const mode = (await stat(targetPath)).mode;
    const temporary = `${targetPath}.cod-${randomUUID()}.tmp`;
    await writeFile(temporary, content, "utf8");
    await chmod(temporary, mode);
    await rename(temporary, targetPath);
    const draft = this.store.data.drafts[targetPath];
    if (draft?.content === content && draft.expectedContent === expectedContent)
      delete this.store.data.drafts[targetPath];
    await this.store.persist();
    return { saved: true, conflict: false };
  }

  async handle(
    request: OperationRequest,
    _trustedUi = false,
  ): Promise<unknown> {
    switch (request.op) {
      case "file.open":
        return this.openFile(request);

      case "project.list":
        return this.projects(request).list(
          typeof request.path === "string" ? request.path : undefined,
        );

      case "project.search":
        return this.projects(request).search({
          query: requiredString(request, "query"),
          maxResults: request.maxResults as number | undefined,
        });

      case "git.repositories":
        return this.projects(request).repositories();

      case "git.changes":
        return this.projects(request).changes(
          requiredString(request, "repoRoot"),
        );

      case "git.diff":
        return this.projects(request).diff({
          repoRoot: requiredString(request, "repoRoot"),
          base: request.base as string | undefined,
          head: request.head as string | undefined,
        });

      case "preview.read": {
        const pane = this.store.pane(
          this.store.workspace(requiredString(request, "workspace")),
          requiredString(request, "id"),
        );
        if (pane.kind !== "preview") throw new Error("Not a preview pane");
        const canonical = await realpath(pane.filePath);
        if (pane.format === "image")
          return { image: await this.readImageFile(canonical) };
        if ((await stat(canonical)).size > 2_000_000)
          throw new Error("Preview exceeds 2 MB limit");
        return {
          content:
            this.store.data.drafts[canonical]?.content ??
            (await readTextFile(canonical)),
        };
      }

      case "preview.open":

      case "diff.open":
        return this.openResourcePane(request);

      case "file.draft":
        return this.store.serialize(() => this.saveDraft(request));

      case "file.lines":
        return this.fileLines(request);

      case "file.image":
        return this.readImage(request);

      case "file.resolve":
        return this.resolveFile(request);

      case "file.version":
        return this.fileVersion(request);

      case "file.read":
        return this.readPaneFile(request);

      case "file.save":
        return this.store.serialize(() => this.savePaneFile(request));

      default:
        throw new Error("Unknown file operation");
    }
  }

  async restoreIdentity(): Promise<void> {
    for (const workspace of this.store.data.workspaces)
      for (const pane of workspace.panes) {
        if (pane.kind === "document" && pane.filePath && !pane.canonicalPath) {
          try {
            pane.canonicalPath = await realpath(pane.filePath);
          } catch {
            /* Missing file drafts retain their saved identity. */
          }
        }
      }
  }
}
