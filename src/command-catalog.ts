import type { OperationRequest } from "./types";

// One catalog supplies CLI validation, help and advertised application operations.
export const commands = {
  "settings.get": [],
  "settings.update": ["values?", "reset?"],
  "review.open-document": ["workspace", "path", "conversation?"],
  "review.open-diff": [
    "workspace",
    "repo-root",
    "base?",
    "head?",
    "conversation?",
  ],
  "review.inspect": ["id"],
  "review.show": ["id"],
  "review.refresh": ["id", "expected-round"],
  "review.submit": ["id", "round", "conversation?", "request-id"],
  "review.deliver": ["id", "round"],
  "review.wait": ["id", "round", "timeout-ms?"],
  "page.open": ["workspace", "conversation", "path"],
  "agent-integration.profiles": [],
  "agent-integration.inspect": ["provider", "profile-path"],
  "agent-integration.install": [
    "provider",
    "profile-path",
    "expected-preview-hash",
  ],
  context: ["conversation?"],
  state: [],
  capabilities: [],
  "workspace.create": ["name", "focus?"],
  "workspace.reopen": ["id?"],
  "workspace.rename": ["id", "name"],
  "workspace.focus": ["id"],
  "workspace.add-folder": ["id", "path"],
  "workspace.remove-folder": ["id", "path"],
  "workspace.settings": ["id", "settings"],
  "group.ensure": ["workspace", "side"],
  "group.split": ["workspace", "id", "direction", "pane-id?"],
  "group.focus": ["workspace", "id"],
  "group.visibility": ["workspace", "id", "hidden?"],
  "group.toggle-split": ["workspace"],
  "group.resize": ["workspace", "id", "ratio"],
  "pane.move": ["workspace", "id", "group", "index?"],
  "conversation.discover": ["workspace", "provider", "cwd?"],
  "conversation.handoff": ["id"],
  "conversation.rename": ["id", "name"],
  "conversation.reclaim": ["id"],
  "browser.default-status": [],
  "browser.register-default": [],
  "conversation.draft": [
    "workspace?",
    "replace-pane?",
    "source-pane?",
    "group?",
    "focus?",
    "provider?",
    "initial-selection?",
    "cwd?",
  ],
  "conversation.start": ["workspace", "pane-id", "provider", "cwd?"],
  "conversation.show": ["id"],
  "conversation.remove": ["id"],
  "conversation.composer": [
    "workspace",
    "pane-id",
    "text?",
    "images?",
    "skills?",
    "provider?",
  ],
  "conversation.acknowledge": ["id"],
  "conversation.report-status": ["id", "status", "context?", "source?"],
  "conversation.options": ["id"],
  "conversation.option": ["id", "option", "value"],
  "workspace.close": ["id", "force?"],
  "project.list": ["workspace", "path?"],
  "project.search": ["workspace", "query", "max-results?"],
  "git.repositories": ["workspace"],
  "git.changes": ["workspace", "repo-root"],
  "git.diff": ["workspace", "repo-root", "base?", "head?"],
  "diff.open": ["workspace", "repo-root", "base?", "head?"],
  "preview.read": ["workspace", "id"],
  "preview.open": ["workspace", "path", "source-pane?", "group?", "focus?"],
  "file.draft": [
    "workspace",
    "pane-id",
    "content",
    "expected-content",
    "source-key?",
  ],
  "file.lines": ["workspace", "pane-id"],
  "file.image": ["workspace", "path"],
  "file.resolve": ["workspace", "path"],
  "file.new": [
    "workspace",
    "group?",
    "source-pane?",
    "replace-pane?",
    "focus?",
  ],
  "file.open": [
    "workspace",
    "path",
    "line?",
    "replace-pane?",
    "source-pane?",
    "group?",
    "focus?",
  ],
  "file.version": ["workspace", "pane-id"],
  "file.read": ["workspace", "pane-id"],
  "file.save": ["workspace", "pane-id", "content", "expected-content"],
  "file.save-as": [
    "workspace",
    "pane-id",
    "path",
    "content",
    "expected-content?",
  ],
  "pane.new": ["workspace", "group?", "same-as?", "source-pane?", "focus?"],
  "pane.split": ["workspace", "id", "direction"],
  "pane.focus": ["workspace", "id"],
  "pane.reopen": ["workspace", "new-shell?"],
  "pane.pin": ["workspace", "id", "pinned"],
  "pane.close": ["workspace", "id", "include-pinned?"],
  "pane.close-many": ["workspace", "group", "scope", "id?"],
  "pane.resize": ["workspace", "id", "ratio"],
  "conversation.create": ["workspace", "provider", "cwd"],
  "conversation.resume": ["workspace", "provider", "cwd", "native-id"],
  "conversation.queue-edit": [
    "id",
    "message-id",
    "text?",
    "images?",
    "images-file?",
    "skills?",
    "editing?",
  ],
  "conversation.queue-remove": ["id", "message-id"],
  "conversation.queue-resume": ["id"],
  "conversation.send": ["id", "text?", "images?", "images-file?", "skills?"],
  "conversation.send-tool-result": ["id", "name", "output", "namespace?"],
  "conversation.interrupt": ["id"],
  "conversation.permission": ["id", "request-id", "option-id"],
  "conversation.inspect": ["id"],
  "conversation.earlier-history": ["id"],
  "conversation.native-inspect": ["id", "section"],
  "conversation.move": ["id", "workspace", "follow?"],
  "browser.blocking-retry": ["id"],
  "browser.diagnostics": ["id", "action"],
  "browser.blocking": ["id", "enabled"],
  "browser.open-external": ["url"],
  "browser.open-link": ["id", "url"],
  "browser.open": [
    "workspace",
    "url",
    "replace-pane?",
    "source-pane?",
    "group?",
    "focus?",
  ],
  "browser.navigate": ["id", "url"],
  "browser.bookmarks": ["query?"],
  "browser.bookmark": ["url", "title?", "id?"],
  "browser.bookmark-delete": ["id"],
  "browser.downloads": [],
  "browser.download-action": ["id", "action"],
  "browser.permissions": [],
  "browser.permission-answer": ["request-id", "decision"],
  "browser.permission-set": ["origin", "top-origin?", "permission", "decision"],
  "browser.settings": ["search-engine?"],
  "browser.history": ["query?", "limit?"],
  "browser.history-delete": ["url"],
  "browser.history-clear": [],
  "browser.suggest": ["query"],
  "browser.pin": ["url", "title?"],
  "browser.unpin": ["url"],
  "browser.back": ["id"],
  "browser.forward": ["id"],
  "browser.reload": ["id"],
  "browser.recover": ["id"],
  "browser.inspect": ["id"],
  "browser.close": ["id", "include-pinned?"],
  "terminal.open": [
    "workspace",
    "cwd?",
    "replace-pane?",
    "source-pane?",
    "group?",
    "focus?",
  ],
  "terminal.write": ["id", "data"],
  "terminal.resize": ["id", "cols", "rows"],
  "terminal.inspect": ["id"],
  "terminal.close": ["id", "include-pinned?"],
} satisfies Record<string, string[]>;
export const trustedReviewOperations = [
  "review.detail",
  "review.cancel",
  "review.comment-add",
  "review.comment-edit",
  "review.comment-delete",
  "review.comment-reanchor",
  "review.changes",
  "review.changed",
] as const;
export type OperationName =
  keyof typeof commands | (typeof trustedReviewOperations)[number];
export const operations = Object.keys(commands);
export const help = `Cod local workspace CLI

Usage: codctl OPERATION [arguments]

${Object.entries(commands)
  .map(
    ([op, flags]) =>
      `  ${op.replace(".", " ")}${flags.map((flag) => (flag.endsWith("?") ? ` [--${flag.slice(0, -1)} VALUE]` : ` --${flag} ${flag.toUpperCase().replaceAll("-", "_")}`)).join("")}`,
  )
  .join("\n")}

Flags in brackets are optional. provider: codex|kimi; direction: right|down; ratio: greater than 0 and less than 1; cols/rows: integers 1..1000. Content/data values may be empty; conversation send requires text or at least one image. terminal write sends exact input without an implicit newline. file save requires expected-content for conflict detection.
Commands print one JSON result and return nonzero on errors. conversation send starts a turn or durably queues a message when busy; queue-edit and queue-remove change waiting messages, and queue-resume continues a paused queue; inspect or state reports progress. conversation send-tool-result submits a retained Codex tool result and returns its native turn ID after acceptance. Review wait returns submitted feedback or cancellation (timeout exits 2). Only humans submit draft reviews unless explicitly delegated. Uncertain delivery requires native-history reconciliation, never blind resending. Native model/reasoning selection is available through conversation options/option. Claude and mode selection are unavailable. workspace create is background by default; use --focus true or workspace focus explicitly. Closing a conversation tab preserves its session; conversation show restores it. conversation remove detaches an idle chat from its workspace without deleting native provider history; pane reopen restores its local snapshot. file open --workspace ID --path ABSOLUTE_PDF_PATH opens a PDF in a Cod browser tab; browser open also accepts properly encoded local file:// URLs. No HTTP server or external viewer is required. Review feedback is bound to its origin conversation at creation. settings and images flags accept JSON.
`;
const camel = (flag: string) =>
  flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
export function parseArguments(argv: string[]): OperationRequest | undefined {
  if (
    !argv.length ||
    (argv.length === 1 && ["--help", "help"].includes(argv[0]))
  )
    return undefined;
  const single = ["context", "state", "capabilities"].includes(argv[0]);
  const op = single ? argv[0] : `${argv[0]}.${argv[1]}`;
  const allowed = Object.hasOwn(commands, op)
    ? commands[op as keyof typeof commands]
    : undefined;
  if (!allowed) throw new Error("Unknown operation; use codctl --help");
  const values: Record<string, unknown> = {};
  const flags = argv.slice(single ? 1 : 2);
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i];
    const value = flags[i + 1];
    const name = flag.startsWith("--") ? flag.slice(2) : "";
    if (!allowed.some((flag) => flag.replace(/\?$/, "") === name))
      throw new Error(`Unknown or reserved flag: ${flag}`);
    const key = camel(name);
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate flag: ${flag}`);
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    const text = [
      "content",
      "expected-content",
      "data",
      "text",
      "output",
    ].includes(name);
    if (!text && (!value.length || value.startsWith("--")))
      throw new Error(`Missing value for ${flag}`);
    values[key] = value;
  }
  for (const flag of allowed)
    if (!flag.endsWith("?") && !Object.hasOwn(values, camel(flag)))
      throw new Error(`Missing --${flag}`);
  if (
    values.provider !== undefined &&
    !(
      op.startsWith("agent-integration.")
        ? ["codex", "kimi", "claude"]
        : ["codex", "kimi"]
    ).includes(String(values.provider))
  )
    throw new Error("provider must be codex or kimi");
  if (
    values.direction !== undefined &&
    !["right", "down"].includes(String(values.direction))
  )
    throw new Error("direction must be right or down");
  for (const key of ["ratio", "cols", "rows", "maxResults", "line"])
    if (values[key] !== undefined) {
      const number = Number(values[key]);
      if (
        !String(values[key]).trim() ||
        !Number.isFinite(number) ||
        (key === "ratio"
          ? number <= 0 || number >= 1
          : !Number.isInteger(number) ||
            number < 1 ||
            number > (key === "line" ? 1_000_000 : 1000))
      )
        throw new Error(`Invalid ${key}`);
      values[key] = number;
    }
  if (values.index !== undefined) {
    const index = Number(values.index);
    if (!String(values.index).trim() || !Number.isInteger(index) || index < 0)
      throw new Error("index must be a nonnegative integer");
    values.index = index;
  }
  if ((values.base === undefined) !== (values.head === undefined))
    throw new Error("Both --base and --head are required");
  for (const name of [
    "settings",
    "values",
    "images",
    "skills",
    "initialSelection",
  ])
    if (typeof values[name] === "string") {
      try {
        values[name] = JSON.parse(values[name] as string);
      } catch {
        throw new Error(`${name} must be valid JSON`);
      }
    }
  if (typeof values.reset === "string") {
    if (!["true", "false"].includes(values.reset))
      throw new Error("reset must be true or false");
    values.reset = values.reset === "true";
  }
  if (typeof values.hidden === "string") {
    if (!["true", "false"].includes(values.hidden))
      throw new Error("hidden must be true or false");
    values.hidden = values.hidden === "true";
  }
  if (typeof values.editing === "string") {
    if (!["true", "false"].includes(values.editing))
      throw new Error("editing must be true or false");
    values.editing = values.editing === "true";
  }
  return { ...values, op };
}
