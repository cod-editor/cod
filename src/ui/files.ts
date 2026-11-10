import { focusReadyEditor } from "./document-views";
import { createSearchList } from "./search-list";
import { readPreference, writePreference } from "./preferences";
import type { WorkspaceState } from "../types";
import type { Invoke } from "./contracts";
import { icon, menu } from "./controls";
interface Entry {
  name: string;
  path: string;
  kind: "file" | "directory";
  root: string;
}
export class FileTree {
  private timer: ReturnType<typeof setInterval>;
  private workspace?: WorkspaceState;
  private key = "";
  private generation = 0;
  private groupSequence = 0;
  private changes = new Map<string, string>();
  private refreshing = false;
  private directories = new Set<{
    element: HTMLElement;
    refresh: () => Promise<void>;
  }>();
  private expanded = readPreference<Record<string, boolean>>(
    "file-expansion",
    {},
  );
  constructor(
    private host: HTMLElement,
    private invoke: Invoke,
    private addFolder: (workspace: string) => void,
  ) {
    host.tabIndex = 0;
    host.addEventListener("focusin", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>(
        '[role="treeitem"]',
      );
      if (!row) return;
      host.tabIndex = -1;
      for (const item of host.querySelectorAll<HTMLElement>(
        '[role="treeitem"]',
      ))
        item.tabIndex = item === row ? 0 : -1;
    });
    host.addEventListener("keydown", (event) => {
      if (
        event.target === host &&
        !event.isComposing &&
        ["ArrowDown", "ArrowRight", "Home"].includes(event.key)
      ) {
        event.preventDefault();
        host.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
      }
    });
    host.oncontextmenu = (event) => {
      if (event.defaultPrevented || !this.workspace) return;
      event.preventDefault();
      const id = this.workspace.id;
      menu({ x: event.clientX, y: event.clientY }, [
        { label: "Add folder...", run: () => this.addFolder(id) },
      ]);
    };
    this.timer = setInterval(() => {
      void this.refreshChanges();
      for (const directory of this.directories) {
        if (directory.element.isConnected) void directory.refresh();
        else this.directories.delete(directory);
      }
    }, 3000);
  }
  dispose(): void {
    clearInterval(this.timer);
    this.generation++;
    this.directories.clear();
  }
  update(workspace: WorkspaceState | undefined): void {
    this.workspace = workspace;
    const key = JSON.stringify([workspace?.id, workspace?.folders]);
    if (key === this.key) return;
    this.key = key;
    this.generation++;
    this.directories.clear();
    this.host.replaceChildren();
    this.host.tabIndex = 0;
    void this.refreshChanges();
    this.host.setAttribute("role", "tree");
    this.host.setAttribute("aria-label", "File tree");
    if (!workspace) return;
    for (const root of workspace.folders)
      this.host.append(
        this.directory(root, root.split("/").pop() || root, 0, true),
      );
  }
  private directory(
    path: string,
    name: string,
    depth: number,
    root = false,
  ): HTMLElement {
    const group = document.createElement("div"),
      row = document.createElement("div"),
      children = document.createElement("div");
    row.className = "file-row";
    row.tabIndex = -1;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-label", name);
    row.setAttribute("aria-expanded", "false");
    row.title = path;
    row.dataset.path = path;
    group.dataset.entryPath = path;
    group.dataset.entryKind = "directory";
    row.style.paddingLeft = `${8 + depth * 16}px`;
    const folderIcon = icon("folder");
    folderIcon.classList.add("folder-state");
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = name;
    row.append(folderIcon, label);
    children.className = "file-children";
    children.style.setProperty("--guide-offset", `${16 + depth * 16}px`);
    children.hidden = true;
    children.setAttribute("role", "group");
    children.id = `file-group-${++this.groupSequence}`;
    row.setAttribute("aria-owns", children.id);
    group.append(row, children);
    let signature = "",
      refreshing = false;
    const workspaceId = this.workspace!.id,
      generation = this.generation;
    const refresh = async () => {
      if (children.hidden || refreshing) return;
      refreshing = true;
      try {
        const entries = await this.invoke<Entry[]>(
          "project.list",
          { workspace: workspaceId, path },
          { reportError: false },
        );
        if (generation !== this.generation || !group.isConnected) return;
        const nextSignature = JSON.stringify(entries);
        if (nextSignature === signature) return;
        if (!signature) children.replaceChildren();
        signature = nextSignature;
        const active =
          document.activeElement instanceof HTMLElement &&
          children.contains(document.activeElement)
            ? document.activeElement
            : undefined;
        const focusedPath = active?.dataset.path,
          scrollTop = this.host.scrollTop;
        const existing = new Map(
          [...children.children].map((element) => [
            (element as HTMLElement).dataset.entryPath,
            element as HTMLElement,
          ]),
        );
        entries.forEach((entry, index) => {
          let element = existing.get(entry.path);
          if (element?.dataset.entryKind !== entry.kind) {
            element?.remove();
            element = undefined;
          }
          existing.delete(entry.path);
          element ??=
            entry.kind === "directory"
              ? this.directory(entry.path, entry.name, depth + 1)
              : this.file(entry, depth + 1);
          if (children.children[index] !== element)
            children.insertBefore(element, children.children[index] ?? null);
        });
        for (const element of existing.values()) element.remove();
        if (focusedPath && document.activeElement !== active) {
          const restored = [
            ...children.querySelectorAll<HTMLElement>("[data-path]"),
          ].find((row) => row.dataset.path === focusedPath);
          (restored ?? row).focus({ preventScroll: true });
        }
        this.host.scrollTop = scrollTop;
      } catch (error) {
        if (generation === this.generation && !signature)
          children.textContent = String(error);
      } finally {
        refreshing = false;
      }
    };
    this.directories.add({ element: group, refresh });
    const toggle = async (force?: boolean) => {
      const open = force ?? Boolean(children.hidden);
      this.expanded[`${workspaceId}:${path}`] = open;
      writePreference("file-expansion", this.expanded);
      children.hidden = !open;
      row.setAttribute("aria-expanded", String(open));
      const nextIcon = icon(open ? "folder-open" : "folder");
      nextIcon.classList.add("folder-state");
      row.querySelector(".folder-state")?.replaceWith(nextIcon);
      if (open) await refresh();
    };
    row.onclick = () => void toggle();
    row.onkeydown = (e) => {
      if (e.isComposing) return;
      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        if (e.key === "ArrowRight" && !children.hidden)
          children.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
        else void toggle(true);
      } else if (e.key === "ArrowLeft" && !children.hidden) {
        e.preventDefault();
        void toggle(false);
      } else this.navigate(e, row);
    };
    const context = (x: number, y: number) =>
      menu({ x, y }, [
        { label: "Search in files...", run: () => this.search() },
        {
          label: "Open terminal here",
          run: () =>
            void this.invoke("terminal.open", {
              workspace: this.workspace!.id,
              cwd: path,
            }),
        },
        ...(root
          ? [
              null,
              {
                label: "Show changes",
                run: () =>
                  void this.invoke("diff.open", {
                    workspace: this.workspace!.id,
                    repoRoot: path,
                  }),
              },
              {
                label: "Review changes",
                run: () =>
                  void this.invoke("review.open-diff", {
                    workspace: this.workspace!.id,
                    repoRoot: path,
                  }),
              },
              null,
              {
                label: "Add folder...",
                run: () => this.addFolder(workspaceId),
              },
              {
                label: "Remove from workspace",
                run: () =>
                  void this.invoke("workspace.remove-folder", {
                    id: this.workspace!.id,
                    path,
                  }),
              },
            ]
          : []),
      ]);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      context(e.clientX, e.clientY);
    };
    if (this.expanded[`${this.workspace?.id}:${path}`] ?? root)
      void toggle(true);
    return group;
  }
  private file(entry: Entry, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "file-row";
    row.tabIndex = -1;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-label", entry.name);
    row.title = entry.path;
    row.dataset.path = entry.path;
    row.dataset.entryPath = entry.path;
    row.dataset.entryKind = "file";
    row.style.paddingLeft = `${8 + depth * 16}px`;
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = entry.name;
    row.append(icon("file"), label);
    this.decorate(row);
    const open = () => void this.openFile(entry.path);
    row.onclick = open;
    row.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        open();
      } else this.navigate(e, row);
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      menu({ x: e.clientX, y: e.clientY }, [
        { label: "Open", run: open },
        {
          label: "Review document",
          run: () =>
            void this.invoke("review.open-document", {
              workspace: this.workspace!.id,
              path: entry.path,
            }),
        },
        ...(/\.md$/i.test(entry.path)
          ? [
              {
                label: "Markdown preview",
                run: () =>
                  void this.invoke("preview.open", {
                    workspace: this.workspace!.id,
                    path: entry.path,
                  }),
              },
            ]
          : []),
      ]);
    };
    return row;
  }
  private decorate(row: HTMLElement): void {
    const status = this.changes.get(row.dataset.path ?? "");
    row.querySelector(".file-status")?.remove();
    if (status) {
      const badge = document.createElement("span");
      badge.className = "file-status";
      badge.textContent = status;
      row.append(badge);
    }
  }
  private async refreshChanges(): Promise<void> {
    const workspace = this.workspace;
    if (!workspace?.folders.length || this.refreshing) return;
    this.refreshing = true;
    try {
      const result = await this.invoke<{
        repositories: Array<{ root: string }>;
      }>(
        "git.repositories",
        { workspace: workspace.id },
        { reportError: false },
      );
      const changes = new Map<string, string>();
      for (const repo of result.repositories) {
        const result = await this.invoke<{
          files: Array<{
            path: string;
            indexStatus: string;
            worktreeStatus: string;
          }>;
        }>(
          "git.changes",
          { workspace: workspace.id, repoRoot: repo.root },
          { reportError: false },
        );
        for (const file of result.files)
          changes.set(
            file.path,
            file.worktreeStatus.trim() || file.indexStatus.trim() || "M",
          );
      }
      if (this.workspace?.id !== workspace.id) return;
      this.changes = changes;
      for (const row of this.host.querySelectorAll<HTMLElement>("[data-path]"))
        this.decorate(row);
    } catch {
    } finally {
      this.refreshing = false;
    }
  }
  private navigate(event: KeyboardEvent, row: HTMLElement): void {
    if (event.isComposing) return;
    if (event.key === "ArrowLeft") {
      const parentGroup =
        row.parentElement?.closest<HTMLElement>('[role="group"]');
      const parent = parentGroup?.previousElementSibling;
      if (parent instanceof HTMLElement) {
        event.preventDefault();
        parent.focus();
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const rows = [
      ...this.host.querySelectorAll<HTMLElement>("[role=treeitem]"),
    ].filter((e) => e.getClientRects().length);
    const i = rows.indexOf(row);
    rows[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : Math.max(
              0,
              Math.min(
                rows.length - 1,
                i + (event.key === "ArrowDown" ? 1 : -1),
              ),
            )
    ]?.focus();
  }
  private async openFile(path: string, line?: number): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) return;
    // Native dialog focus restoration is not a new user navigation intent.
    // A later real key/pointer action is, and must cancel deferred autofocus.
    const intent = new AbortController();
    const cancel = (event: Event) => {
      if (event.isTrusted) intent.abort();
    };
    for (const type of ["keydown", "pointerdown"])
      document.addEventListener(type, cancel, {
        capture: true,
        signal: intent.signal,
      });
    try {
      const result = await this.invoke<{ paneId: string }>("file.open", {
        workspace: workspace.id,
        path,
        ...(line ? { line } : {}),
      });
      requestAnimationFrame(() => {
        if (intent.signal.aborted) return;
        const editor = document.querySelector<HTMLTextAreaElement>(
          `[data-pane-id="${result.paneId}"] .file-editor`,
        );
        if (editor)
          focusReadyEditor(
            editor,
            () => this.workspace?.id === workspace.id,
            intent,
          );
        else intent.abort();
      });
    } catch (error) {
      intent.abort();
      throw error;
    }
  }
  search(path?: string): void {
    this.openPicker(false, path);
  }
  quickOpen(): void {
    this.openPicker(true);
  }
  private openPicker(files: boolean, path?: string): void {
    const workspace = this.workspace;
    if (!workspace) return;
    const dialog = document.createElement("dialog");
    dialog.className = "picker search-picker";
    dialog.setAttribute("aria-label", files ? "Open file" : "Search workspace");
    const input = document.createElement("input");
    input.placeholder = files ? "Open file..." : "Search in files...";
    input.setAttribute("aria-label", files ? "Open file" : "Workspace search");
    const results = document.createElement("div");
    results.className = "command-list";
    results.setAttribute("role", "region");
    results.setAttribute("aria-label", "Search results");
    dialog.append(input, results);
    document.body.append(dialog);
    dialog.onclose = () => dialog.remove();
    const selection = createSearchList(input, results);
    let generation = 0,
      timer: ReturnType<typeof setTimeout>;
    let fileList: Entry[] = [];
    const fill = (
      matches: Array<{ path: string; line?: number; text?: string }>,
      truncated = false,
    ) => {
      results.replaceChildren();
      for (const match of matches.slice(0, 100)) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent =
          match.path.replace(
            (workspace.folders.find((root) =>
              match.path.startsWith(root + "/"),
            ) || "") + "/",
            "",
          ) + (match.line ? `:${match.line}  ${match.text || ""}` : "");
        if (workspace.folders.length > 1) {
          const root = workspace.folders.find((root) =>
            match.path.startsWith(root + "/"),
          );
          if (root)
            button.textContent = `${root.split("/").pop()}/${button.textContent}`;
        }
        button.title = match.path;
        button.onclick = () => {
          dialog.close();
          void this.openFile(match.path, match.line);
        };
        results.append(button);
      }
      if (!matches.length) results.textContent = "No matches";
      else if (truncated || matches.length > 100) {
        const limit = document.createElement("div");
        limit.className = "search-limit";
        limit.textContent = "Results limited. Refine the search.";
        results.append(limit);
      }
      selection.update();
    };
    const search = async () => {
      const current = ++generation;
      if (files) {
        fill(
          fileList.filter((f) =>
            f.path.toLowerCase().includes(input.value.toLowerCase()),
          ),
        );
        return;
      }
      if (!input.value.trim()) {
        results.replaceChildren();
        return;
      }
      try {
        const result = await this.invoke<{
          matches: Array<{ path: string; line: number; text: string }>;
          truncated?: boolean;
        }>(
          "project.search",
          {
            workspace: workspace.id,
            query: input.value,
            ...(path ? { path } : {}),
          },
          { reportError: false },
        );
        if (current === generation) fill(result.matches, result.truncated);
      } catch (e) {
        if (current === generation) results.textContent = String(e);
      }
    };
    if (files) {
      results.textContent = "Loading files...";
      const walk = async (dir: string, depth = 0): Promise<void> => {
        if (depth > 20 || fileList.length > 10000) return;
        const entries = await this.invoke<Entry[]>("project.list", {
          workspace: workspace.id,
          path: dir,
        });
        for (const e of entries) {
          if (e.kind === "file") fileList.push(e);
          else if (!["node_modules", ".git", "dist", "target"].includes(e.name))
            await walk(e.path, depth + 1);
        }
      };
      void Promise.all(workspace.folders.map((root) => walk(root)))
        .then(() => search())
        .catch((e) => (results.textContent = String(e)));
    }
    input.oninput = () => {
      ++generation;
      clearTimeout(timer);
      results.replaceChildren();
      selection.update();
      timer = setTimeout(() => void search(), 150);
    };
    dialog.showModal();
    input.focus();
  }
}
