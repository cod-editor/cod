import { diffHunks } from "./diff-hunks";
import { highlight, languageFor } from "./editor-highlight";
import { isMarkdownDocument } from "./markdown-document";
import {
  uiButton,
  actionRow,
  selectField,
  toolbar,
  iconButton,
} from "./ui-kit";
import { reviewDocument } from "./ui/review-document";
import { formatBinding } from "./keyboard";
import {
  isReviewCommentSave,
  keyboardPlatform,
  shortcutTitle,
} from "./ui/keyboard-ui";
import { conversationLabel } from "./message-label";
import { readPreference, writePreference } from "./ui/preferences";
import { menu } from "./ui/controls";
import type { AppState, ReviewSummary } from "./types";
import type { Invoke } from "./ui/contracts";
import type { ReviewService } from "./reviews/index";
import type { ReviewedGitFile } from "./reviews/git-source";
import type { ReviewFilesSource } from "./ui/files";
type Detail = Awaited<ReturnType<ReviewService["detail"]>>;
type Range = import("./reviews/snapshots").Range;
function revisionLabels(ref: string, commit: string | null) {
  const literalCommit = commit !== null && commit.startsWith(ref.toLowerCase());
  return {
    display: literalCommit
      ? ref.slice(0, 12)
      : ref.replace(/^refs\/heads\//, ""),
    full: !commit ? ref : literalCommit ? commit : `${ref} (${commit})`,
  };
}
function labelPart(text: string): HTMLElement {
  const part = document.createElement("span");
  part.textContent = text;
  return part;
}

function diffPathLabel(path: string): HTMLElement {
  const label = document.createElement("span");
  label.className = "review-diff-path";
  const basename = path.lastIndexOf("/") + 1;
  if (basename) label.append(labelPart(path.slice(0, basename)));
  label.append(labelPart(path.slice(basename)));
  return label;
}

function fileTreeOrder(left: string, right: string): number {
  const a = left.split("/"),
    b = right.split("/");
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const depthOrder = Number(i < b.length - 1) - Number(i < a.length - 1);
    return depthOrder || a[i].localeCompare(b[i]);
  }
  return a.length - b.length;
}

const updates = new WeakMap<HTMLElement, (state: AppState) => void>();
const fileTrees = new WeakMap<HTMLElement, ReviewFilesSource>();
export function reviewFileTree(element?: HTMLElement | null) {
  if (element) return fileTrees.get(element);
}
export function updateReview(element: HTMLElement, state: AppState) {
  updates.get(element)?.(state);
}
export function reviewPane(
  id: string,
  paneId: string,
  initial: AppState,
  invoke: Invoke,
  filesChanged: (source: ReviewFilesSource) => void,
): HTMLElement {
  const host = document.createElement("div");
  host.className = "pane-body review-body";
  let state = initial,
    detail: Detail | undefined,
    selectedRound = "",
    version = -1,
    selection = 0,
    end = 0,
    editing: string | undefined,
    loading = 0;
  type PendingEditor = {
    roundId: string;
    snapshotId: string;
    selection: number;
    end: number;
    body: string;
    editing?: string;
    range?: Range;
  };
  let pending = readPreference<PendingEditor | null>(
      `review-editor.${id}`,
      null,
    ),
    restored = false,
    staleEditor = false;
  const markdownDraftRange = () =>
    pending?.range?.fragment?.view === "markdown" ? pending.range : undefined;
  const remember = (range: Range | undefined) => {
    if (!detail) return;
    if (staleEditor && pending) {
      pending = { ...pending, body: input.value };
      writePreference(`review-editor.${id}`, pending);
      return;
    }
    pending = {
      roundId: selectedRound,
      snapshotId: detail.rounds.find((r) => r.id === selectedRound)!.snapshotId,
      selection,
      end,
      range,
      body: input.value,
      ...(editing ? { editing } : {}),
    };
    writePreference(`review-editor.${id}`, pending);
  };
  const forget = () => {
    pending = null;
    writePreference(`review-editor.${id}`, null);
    staleEditor = false;
  };
  const pendingSubmissionKey = `review-submission.${id}`;
  let pendingSubmission = readPreference<{
    round: string;
    version: number;
    requestId: string;
  } | null>(pendingSubmissionKey, null);
  let remoteConnected: boolean | undefined;
  let textRange: Range | undefined;
  let presentationToken: string | undefined;
  let presentCurrent = false;
  let documentView: ReturnType<typeof reviewDocument> | undefined;
  let documentSnapshot = "";
  let previewMode = readPreference<boolean>(`review-preview.${id}`, false);
  let shownError = false;
  let diskTimer: ReturnType<typeof setTimeout> | undefined;
  let diffAnchors: Array<{ old?: Range; new?: Range }> = [];
  let gitPath: string | undefined,
    gitRequest = "",
    gitFile: ReviewedGitFile | undefined,
    gitError = "",
    changeIndex = -1,
    lastGitRound = "";
  type Change = { file: string; line: number; side: "old" | "new" };
  type ChangeFocus = { signal: AbortSignal; origin: Element | null };
  let navigation: Change[] = [],
    jump: (Change & { focus?: ChangeFocus }) | undefined;
  function showGitFile(
    file: string,
    point = navigation.find((change) => change.file === file),
    focus?: ChangeFocus,
  ) {
    gitPath = file;
    writePreference(`review-file.${id}`, { round: selectedRound, path: file });
    selection = end = 0;
    jump = point && { ...point, focus };
    changeIndex = point ? navigation.indexOf(point) : -1;
    draw();
    if (!point) host.scrollTop = 0;
  }
  function adjacentChange(direction: 1 | -1): Change | undefined {
    if (changeIndex >= 0) return navigation[changeIndex + direction];
    const path = gitPath;
    if (!path) return direction > 0 ? navigation[0] : navigation.at(-1);
    const matches = (point: Change) =>
      direction * fileTreeOrder(point.file, path) > 0;
    if (direction > 0) return navigation.find(matches);
    for (let index = navigation.length - 1; index >= 0; index--)
      if (matches(navigation[index])) return navigation[index];
  }
  function stepChange(direction: 1 | -1, signal?: AbortSignal) {
    const point = adjacentChange(direction);
    if (point)
      showGitFile(
        point.file,
        point,
        signal && { signal, origin: document.activeElement },
      );
  }
  let ranges: Range[] = [],
    buttons: HTMLButtonElement[] = [];
  const header = toolbar(),
    content = region("Review content"),
    comments = region("Draft comments"),
    feedback = region("Submitted feedback"),
    delivery = region("Delivery status"),
    changes = region("Document changes"),
    status = document.createElement("div");
  status.setAttribute("role", "status");
  content.className = "review-content";
  const roundSelect = select("Round");
  const form = document.createElement("div"),
    input = document.createElement("textarea");
  input.setAttribute("aria-label", "Comment");
  form.hidden = true;
  let savingComment = false;
  const save = button("Save comment", async () => {
    if (!detail || staleEditor || savingComment) return;
    savingComment = true;
    let restoreSelection = form.contains(document.activeElement);
    const movedFocus = (event: FocusEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target !== document.body &&
        !form.contains(event.target)
      )
        restoreSelection = false;
    };
    document.addEventListener("focusin", movedFocus, true);
    try {
      const range = editing
        ? undefined
        : (pending?.range ?? markdownDraftRange() ?? selectedRange());
      await invoke(editing ? "review.comment-edit" : "review.comment-add", {
        id,
        roundId: selectedRound,
        expectedVersion: detail.version,
        body: input.value,
        ...(editing ? { commentId: editing } : { range }),
      });
      form.hidden = true;
      documentView?.clearDraftAnchor();
      forget();
      editing = undefined;
      input.value = "";
      await reload();
      if (restoreSelection) focusSelection();
      status.textContent = "";
    } finally {
      document.removeEventListener("focusin", movedFocus, true);
      savingComment = false;
    }
  });
  const saveShortcut = formatBinding(
    { code: "Enter", mod: true, surfaces: ["review"] },
    keyboardPlatform,
  );
  save.title = `Save comment (${saveShortcut})`;
  save.setAttribute(
    "aria-keyshortcuts",
    keyboardPlatform === "darwin" ? "Meta+Enter" : "Control+Enter",
  );
  form.addEventListener("keydown", (event) => {
    if (!isReviewCommentSave(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) save.click();
  });
  form.append(
    input,
    actionRow(
      save,
      button("Cancel comment", () => {
        forget();
        form.hidden = true;
        shownError = false;
        status.textContent = "";
        draw();
        focusSelection();
      }),
    ),
  );
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      // Leave the draft and its actions visible when returning to the document.
      // Hiding it would leave submission blocked without a recovery affordance.
      status.textContent = pending?.body.trim()
        ? "Unfinished comment retained. Save or cancel it before sending feedback."
        : "";
      focusSelection();
    }
  });
  function openComment(commentId?: string, body = "", anchor?: Range) {
    if (pending?.body.trim()) {
      if (staleEditor && !commentId) {
        if (documentView) textRange = anchor ?? documentView.capture();
        if (documentView && !textRange) {
          status.textContent = "Select a text fragment first.";
          return;
        }
        editing = undefined;
        staleEditor = false;
        save.disabled = false;
        remember(documentView ? textRange : selectedRange());
        draw();
        status.textContent = "";
        input.focus();
        return;
      }
      const sameComment = commentId === pending.editing;
      status.textContent = sameComment
        ? ""
        : "Save or cancel the unfinished comment first.";
      // Reopening the same comment resumes its editor; the saved card is not
      // authoritative while a newer, persisted rewrite exists.
      form.hidden = false;
      draw();
      input.focus({ preventScroll: true });
      return;
    }
    if (!commentId && documentView) {
      textRange = anchor ?? documentView.capture();
      if (!textRange) {
        status.textContent = "Select a text fragment first";
        return;
      }
    }
    const existingComment = detail?.rounds
      .find((r) => r.id === selectedRound)
      ?.comments.find((c) => c.id === commentId);
    if (existingComment && !existingComment.outdated)
      textRange = existingComment.anchor;
    editing = commentId;
    input.value = body || (!commentId ? (pending?.body ?? "") : "");
    staleEditor = false;
    save.disabled = false;
    restored = true;
    remember(
      documentView ? textRange : (existingComment?.anchor ?? selectedRange()),
    );
    form.hidden = false;
    if (existingComment?.outdated) comments.after(form);
    else if (documentView)
      documentView.place(
        form,
        commentId
          ? detail!.rounds
              .find((r) => r.id === selectedRound)!
              .comments.find((c) => c.id === commentId)!.anchor
          : selectedRange(),
      );
    else buttons[end]?.after(form);
    input.focus();
  }
  input.addEventListener("input", () => {
    remember(pending?.range ?? markdownDraftRange() ?? textRange);
    submit.disabled = !!input.value.trim();
  });
  function focusSelection() {
    if (documentView) {
      documentView.focus(textRange);
      return;
    }
    const line = buttons[selection];
    if (!line) return;
    line.dataset.rangeMove = "true";
    line.focus({ preventScroll: true });
    delete line.dataset.rangeMove;
  }
  function selectedRange(): Range {
    if (documentView) {
      const range = textRange ?? documentView.capture();
      if (!range) throw new Error("Select a text fragment first");
      return range;
    }
    if (diffAnchors.length) {
      const rows = diffAnchors.slice(
        Math.min(selection, end),
        Math.max(selection, end) + 1,
      );
      const side = rows.some((row) => !row.new) ? "old" : "new";
      if (
        !rows.length ||
        rows.some(
          (row, index) =>
            !row[side] ||
            row[side]!.path !== rows[0][side]?.path ||
            row[side]!.startLine !== (rows[0][side]?.startLine ?? 0) + index,
        )
      )
        throw new Error("Select consecutive lines on the same file and side");
      return { ...rows[0][side]!, endLine: rows.at(-1)![side]!.endLine };
    }
    const a = ranges[Math.min(selection, end)],
      b = ranges[Math.max(selection, end)];
    if (!a || !b || a.path !== b.path || a.side !== b.side)
      throw new Error("Select lines on the same file and side");
    return { ...a, endLine: b.endLine };
  }
  host.addEventListener("cod:add-comment", () => {
    const round = detail?.rounds.find((r) => r.id === selectedRound);
    if (
      round?.status === "draft" &&
      round.id === detail?.currentRoundId &&
      !addComment.disabled
    )
      openComment();
  });
  host.addEventListener("cod:submit-review", () => {
    if (!submit.disabled && !submit.hidden) submit.click();
  });
  const addComment = button("Add comment", () => openComment());
  const refresh = button("Refresh round", async () => {
    if (!detail) return;
    await invoke("review.refresh", {
      id,
      expectedRound: detail.currentRoundId,
      expectedVersion: detail.version,
    });
    presentCurrent = true;
    await reload();
  });
  const compare = button("Changes since previous round", async () => {
    const value = await invoke<
      Awaited<ReturnType<ReviewService["documentChanges"]>>
    >("review.changes", { id });
    changes.textContent = value.changes
      .map((c) =>
        c.lines
          .map(
            (line) =>
              `${c.type === "insert" ? "+" : c.type === "delete" ? "-" : " "}${line}`,
          )
          .join(""),
      )
      .join("");
  });
  const submit = button("Submit round", async () => {
    if (!detail) return;
    let requestId: string = crypto.randomUUID();
    if (remoteConnected) {
      if (
        pendingSubmission?.round === selectedRound &&
        pendingSubmission.version === detail.version
      )
        requestId = pendingSubmission.requestId;
      pendingSubmission = {
        round: selectedRound,
        version: detail.version,
        requestId,
      };
      writePreference(pendingSubmissionKey, pendingSubmission);
    }
    await invoke("review.submit", {
      id,
      round: selectedRound,
      requestId,
      expectedVersion: detail.version,
    });
    await reload();
  });
  async function cancelReview() {
    const round = detail?.rounds.find((r) => r.id === selectedRound);
    if (
      !detail ||
      !round ||
      round.id !== detail.currentRoundId ||
      round.status !== "draft"
    )
      return;
    if (pending?.body.trim()) {
      form.hidden = false;
      draw();
      shownError = true;
      status.textContent =
        "Save or cancel the unfinished comment before cancelling the review.";
      input.focus();
      return;
    }
    await invoke("review.cancel", {
      id,
      roundId: round.id,
      expectedVersion: detail.version,
    });
    if (!pending?.body.trim()) {
      forget();
      editing = undefined;
      form.hidden = true;
    }
    await reload();
    if (document.activeElement === document.body)
      more.focus({ preventScroll: true });
  }
  header.className = "review-header ui-toolbar";
  form.className = "review-comment-editor ui-stack";
  const originLabel = document.createElement("span");
  originLabel.className = "review-origin";
  const more = iconButton("more", "Review actions", () =>
    menu(more, [
      {
        label: "Add comment",
        command: "review.addComment",
        surface: "review",
        disabled: addComment.disabled,
        run: () => addComment.click(),
      },
      ...(selectedRound === detail?.currentRoundId && !addComment.disabled
        ? [
            {
              label: "Cancel review",
              run: () => void cancelReview().catch(showError),
            },
          ]
        : []),
      { label: "Refresh round", run: () => refresh.click() },
      {
        label: "Changes since previous round",
        disabled: compare.disabled,
        run: () => compare.click(),
      },
    ]),
  );
  const previewButton = iconButton("eye", "Preview Markdown", () => {
    if (!documentView) return;
    previewMode = documentView.toggle();
    writePreference(`review-preview.${id}`, previewMode);
    previewButton.setAttribute("aria-pressed", String(previewMode));
    previewButton.title = previewMode ? "Show source" : "Preview Markdown";
    previewButton.setAttribute("aria-label", previewButton.title);
  });
  previewButton.dataset.previewToggle = "";
  host.addEventListener("cod:toggle-preview", () => {
    if (!previewButton.hidden) previewButton.click();
  });
  const context = document.createElement("div");
  context.className = "review-context";
  context.append(selectField(roundSelect), originLabel);
  const controls = document.createElement("div");
  controls.className = "review-controls";
  controls.append(more, previewButton, submit);
  const gitControls = document.createElement("div");
  gitControls.className = "review-change-controls";
  const previousChange = iconButton("chevron", "Previous change", () =>
    stepChange(-1),
  );
  previousChange.classList.add("review-previous-change");
  host.addEventListener("cod:previous-change", (event) =>
    stepChange(-1, (event as CustomEvent<AbortSignal>).detail),
  );
  const nextChange = iconButton("chevron", "Next change", () => stepChange(1));
  nextChange.classList.add("review-next-change");
  host.addEventListener("cod:next-change", (event) =>
    stepChange(1, (event as CustomEvent<AbortSignal>).detail),
  );
  function updateShortcutTitles() {
    addComment.title = shortcutTitle("review.addComment", "Add comment");
    previousChange.title = shortcutTitle(
      "review.previousChange",
      "Previous change",
    );
    nextChange.title = shortcutTitle("review.nextChange", "Next change");
  }
  updateShortcutTitles();
  document.addEventListener("cod:keymap-changed", updateShortcutTitles);
  const firstChange = button("First change", () => {
    const first = navigation.find((point) => point.file === gitPath);
    if (first) showGitFile(first.file, first);
  });
  const position = document.createElement("span");
  gitControls.append(previousChange, position, nextChange, firstChange);
  header.append(context, gitControls, controls);
  host.append(
    header,
    status,
    content,
    form,
    comments,
    feedback,
    delivery,
    changes,
  );
  function chooseRound(roundId: string) {
    selectedRound = roundId;
    selection = end = 0;
    textRange = undefined;
  }
  roundSelect.addEventListener("change", () => {
    presentCurrent = false;
    chooseRound(roundSelect.value);
    draw();
  });
  function draw() {
    if (!detail) return;
    const focused = host.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : undefined;
    const focusedLine = focused?.classList.contains("review-line")
      ? focused.getAttribute("aria-label")
      : undefined;
    const focusedSource = focused?.matches(
      ".review-source-editor, .review-markdown",
    );
    const { scrollTop, scrollLeft } = host;
    const round =
      detail.rounds.find((r) => r.id === selectedRound) ??
      detail.rounds.at(-1)!;
    selectedRound = round.id;
    roundSelect.length = 0;
    roundSelect.append(
      ...detail.rounds.map(
        (r) =>
          new Option(
            r.status === "cancelled"
              ? `Round ${r.number} (cancelled)`
              : `Round ${r.number}`,
            r.id,
          ),
      ),
    );
    roundSelect.value = round.id;
    const snapshot = detail.snapshots[round.snapshotId];
    gitControls.hidden = detail.target.kind !== "diff";
    host.toggleAttribute("data-git-review", !gitControls.hidden);
    const gitHunks =
      detail.target.kind === "diff" ? diffHunks(snapshot.text) : [];
    if (detail.target.kind === "diff") {
      const enteringRound = lastGitRound !== round.id;
      if (enteringRound) {
        lastGitRound = round.id;
        changeIndex = -1;
        const saved = readPreference<{ round: string; path: string } | null>(
          `review-file.${id}`,
          null,
        );
        const original =
          (pending?.roundId === round.id ? pending.range?.path : undefined) ??
          (saved?.round === round.id ? saved.path : undefined);
        gitPath =
          snapshot.files.find(({ oldPath }) => oldPath === original)?.newPath ??
          original ??
          snapshot.files
            .map(({ newPath, oldPath }) => newPath ?? oldPath)
            .filter((file) => file !== null)
            .sort(fileTreeOrder)[0];
      }
      navigation = snapshot.files
        .flatMap((file, index) => {
          const display = file.newPath ?? file.oldPath;
          if (!display) return [];
          return (gitHunks[index] ?? []).flatMap((hunk) => {
            let previousChanged = false;
            return hunk.rows.flatMap((row): Change[] => {
              const changed = row.kind !== "context";
              const first = changed && !previousChanged;
              previousChanged = changed;
              return first
                ? [
                    {
                      file: display,
                      line: row.newLine ?? row.oldLine!,
                      side: row.newLine === undefined ? "old" : "new",
                    },
                  ]
                : [];
            });
          });
        })
        .sort((left, right) => fileTreeOrder(left.file, right.file));
      if (enteringRound && !pending?.body.trim()) {
        changeIndex = navigation.findIndex((point) => point.file === gitPath);
        jump = navigation[changeIndex];
      }
      const root = detail.target.repoRoot;
      const fileKey = JSON.stringify([round.id, gitPath]);
      if (gitPath && gitRequest !== fileKey) {
        gitRequest = fileKey;
        gitFile = undefined;
        gitError = "";
        void invoke<ReviewedGitFile>(
          "review.file-source",
          { id, roundId: round.id, path: gitPath },
          { reportError: false },
        ).then(
          (file) => {
            if (gitRequest !== fileKey) return;
            gitFile = file;
            draw();
          },
          () => {
            if (gitRequest !== fileKey) return;
            gitError = "Saved source is unavailable";
            draw();
          },
        );
      }
      if (!gitPath) {
        gitRequest = fileKey;
        gitFile = undefined;
      }
      const changes = new Map<string, string>();
      for (const { oldPath, newPath } of snapshot.files) {
        const path = newPath ?? oldPath;
        if (path)
          changes.set(
            path,
            !oldPath ? "A" : !newPath ? "D" : oldPath === newPath ? "M" : "R",
          );
      }
      const commentsByFile = new Map<string, number>();
      for (const comment of round.comments) {
        const path =
          snapshot.files.find(({ oldPath }) => oldPath === comment.anchor.path)
            ?.newPath ?? comment.anchor.path;
        commentsByFile.set(path, (commentsByFile.get(path) ?? 0) + 1);
      }
      const files: ReviewFilesSource = {
        key: JSON.stringify([id, round.id, snapshot.id]),
        root,
        selected: gitPath,
        changes,
        comments: commentsByFile,
        list: (path) =>
          invoke(
            "review.file-tree",
            { id, roundId: round.id, path },
            { reportError: false },
          ),
        select: (path) => showGitFile(path),
      };
      fileTrees.set(host, files);
      filesChanged(files);
      position.textContent =
        changeIndex >= 0 ? `${changeIndex + 1}/${navigation.length}` : "—";
      previousChange.disabled = !adjacentChange(-1);
      nextChange.disabled = !adjacentChange(1);
      firstChange.disabled = !navigation.some(
        (point) => point.file === gitPath,
      );
    }

    if (pending && !restored) {
      restored = true;
      input.value = pending.body;
      editing = pending.editing;
      selection = pending.selection;
      end = pending.end;
      textRange = pending.range;
      form.hidden = false;
    }
    const wasStale = staleEditor;
    staleEditor =
      !!pending &&
      (pending.roundId !== detail.currentRoundId ||
        pending.roundId !== round.id ||
        pending.snapshotId !== snapshot.id ||
        round.status === "cancelled");
    save.disabled = staleEditor;
    if (staleEditor) {
      shownError = true;
      status.textContent =
        round.status === "cancelled" && round.id === detail.currentRoundId
          ? "Review cancelled. Copy or discard the unfinished comment."
          : pending!.roundId === detail.currentRoundId
            ? "Your unfinished comment is in the current round. Switch back to continue writing."
            : "Unfinished comment belongs to an older revision. Select lines and choose Add comment to re-anchor it.";
    } else if (wasStale) {
      shownError = false;
      status.textContent = "";
    }
    const reuseDocument =
      snapshot.kind === "document" &&
      documentView &&
      documentSnapshot === snapshot.id;
    documentView?.clearAnnotations(
      reuseDocument && !form.hidden ? form : undefined,
    );
    if (!reuseDocument) {
      documentView?.dispose();
      const label = document.createElement("p");
      label.className = "review-source";
      const sourcePath =
        detail.target.kind === "document"
          ? detail.target.path
          : detail.target.repoRoot;
      label.textContent =
        detail.target.kind === "diff" && gitPath
          ? gitPath.slice(sourcePath.length + 1)
          : sourcePath;
      label.title = `Saved revision ${snapshot.hash}`;
      label.hidden = detail.target.kind === "diff" && Boolean(gitPath);
      content.replaceChildren(label);
      if (detail.target.kind === "diff") {
        const comparison = document.createElement("p");
        comparison.className = "review-diff-comparison";
        if (detail.target.base && detail.target.head) {
          const base = revisionLabels(detail.target.base, snapshot.base);
          const head = revisionLabels(detail.target.head, snapshot.head);
          comparison.append(
            labelPart(base.display),
            " → ",
            labelPart(head.display),
          );
          comparison.title = `${base.full} → ${head.full}`;
          comparison.setAttribute("aria-description", comparison.title);
        } else {
          comparison.textContent =
            "Local tracked changes (saved working-tree diff)";
        }
        content.append(comparison);
      }
      ranges = [];
      diffAnchors = [];
      buttons = [];
      let sourceRows: HTMLElement = content;
      function add(
        prefix: string,
        text: string,
        name: string,
        range: Range,
        highlightSource: boolean,
      ) {
        const index = buttons.length;
        const line = document.createElement("button");
        line.type = "button";
        line.tabIndex = index === end ? 0 : -1;
        line.className = "review-line";
        line.textContent = prefix + text;
        if (highlightSource && range.path && text.length <= 4_000) {
          const language = languageFor(range.path);
          if (language !== "plaintext") {
            const source = document.createElement("span");
            // The shared highlighter escapes source text. Keep the original
            // row if the HTML parser normalizes any source characters.
            source.innerHTML = highlight(text, language);
            if (source.childElementCount && source.textContent === text)
              line.replaceChildren(prefix, source);
          }
        }
        line.setAttribute("aria-label", name);
        line.setAttribute(
          "aria-pressed",
          String(
            index >= Math.min(selection, end) &&
              index <= Math.max(selection, end),
          ),
        );
        ranges.push(range);
        buttons.push(line);
        line.addEventListener("focus", () => {
          for (const item of buttons) item.tabIndex = item === line ? 0 : -1;
          if (!line.dataset.rangeMove) selection = end = index;
        });
        line.addEventListener("keydown", (event) => {
          if (event.isComposing) return;
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next = Math.max(
              0,
              Math.min(
                buttons.length - 1,
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : index + (event.key === "ArrowDown" ? 1 : -1),
              ),
            );
            if (event.shiftKey) end = next;
            else selection = end = next;
            buttons[next].dataset.rangeMove = "true";
            buttons[next].focus();
            delete buttons[next].dataset.rangeMove;
            buttons.forEach((b, i) =>
              b.setAttribute(
                "aria-pressed",
                String(
                  i >= Math.min(selection, end) &&
                    i <= Math.max(selection, end),
                ),
              ),
            );
          }
        });
        line.oncontextmenu = (event) => {
          event.preventDefault();
          selection = end = index;
          menu({ x: event.clientX, y: event.clientY }, [
            {
              label: "Add comment",
              command: "review.addComment",
              surface: "review",
              disabled:
                round.status !== "draft" || round.id !== detail!.currentRoundId,
              run: () => openComment(),
            },
          ]);
        };
        sourceRows.append(line);
      }
      previewButton.hidden =
        snapshot.kind !== "document" ||
        detail.target.kind !== "document" ||
        !isMarkdownDocument(detail.target.path);
      previewButton.setAttribute("aria-pressed", String(previewMode));
      previewButton.title = previewMode ? "Show source" : "Preview Markdown";
      previewButton.setAttribute("aria-label", previewButton.title);
      if (snapshot.kind === "document" && detail.target.kind === "document") {
        if (documentSnapshot && documentSnapshot !== snapshot.id && !pending)
          textRange = undefined;
        documentSnapshot = snapshot.id;
        documentView = reviewDocument(
          snapshot.text,
          detail.target.path,
          !previewButton.hidden && previewMode,
          textRange,
          (range) => {
            textRange = range;
          },
          (range) => {
            if (!addComment.disabled) openComment(undefined, "", range);
          },
          (message) => {
            status.textContent = message;
          },
        );
        content.append(documentView.element);
      } else {
        documentView = undefined;
        if (gitFile && gitPath) {
          const heading = document.createElement("h3");
          heading.className = "review-diff-file";
          const paths = [...new Set([gitFile.oldPath, gitFile.newPath])].filter(
            (path) => path !== null,
          );
          paths.forEach((path, index) => {
            if (index) heading.append(" → ");
            heading.append(diffPathLabel(path.slice(sourcePath.length + 1)));
          });
          heading.title = paths.join(" → ");
          heading.setAttribute("aria-description", heading.title);
          content.append(heading);
          if (!gitFile.complete)
            content.append(
              labelPart(
                gitFile.rows.length
                  ? "Only saved change lines are available"
                  : "Saved source is unavailable",
              ),
            );
          const rows = gitFile.rows;
          const syntax =
            rows.length <= 2_000 &&
            rows.reduce((size, row) => size + row.text.length, 0) <= 200_000;
          sourceRows = document.createElement("div");
          sourceRows.className = "review-git-source";
          content.append(sourceRows);
          for (const row of rows) {
            const old =
              row.oldLine !== undefined && gitFile.oldPath
                ? {
                    path: gitFile.oldPath,
                    side: "old" as const,
                    startLine: row.oldLine,
                    endLine: row.oldLine,
                  }
                : undefined;
            const next =
              row.newLine !== undefined && gitFile.newPath
                ? {
                    path: gitFile.newPath,
                    side: "new" as const,
                    startLine: row.newLine,
                    endLine: row.newLine,
                  }
                : undefined;
            const anchor = next ?? old;
            if (!anchor) continue;
            const mark =
              row.kind === "removed" ? "-" : row.kind === "added" ? "+" : " ";
            add(
              `${mark}${String(row.oldLine ?? "").padStart(4)} ${String(row.newLine ?? "").padStart(4)}  `,
              row.text,
              `${anchor.side === "old" ? "Old" : "New"} line ${anchor.startLine} ${anchor.path}`,
              anchor,
              syntax,
            );
            buttons.at(-1)!.dataset.diffKind = row.kind;
            diffAnchors.push({ old, new: next });
            if (row.noNewline) {
              const note = document.createElement("div");
              note.className = "review-diff-note";
              note.textContent = "No newline at end of file";
              sourceRows.append(note);
            }
          }
          const requested = jump;
          const target = requested
            ? diffAnchors.findIndex(
                (row) => row[requested.side]?.startLine === requested.line,
              )
            : -1;
          if (requested && target >= 0) {
            jump = undefined;
            selection = end = target;
            for (const [index, line] of buttons.entries()) {
              line.setAttribute("aria-pressed", String(index === target));
              line.tabIndex = index === target ? 0 : -1;
            }
            const line = buttons[target];
            queueMicrotask(() => {
              if (!line.isConnected) return;
              line.scrollIntoView({ block: "center" });
              const focus = requested.focus;
              if (
                focus &&
                !focus.signal.aborted &&
                host.closest('[data-pane-id][data-active="true"]') &&
                (document.activeElement === focus.origin ||
                  (document.activeElement === document.body &&
                    !focus.origin?.isConnected))
              )
                line.focus({ preventScroll: true });
            });
          }
        } else
          content.append(
            labelPart(
              gitError ||
                (gitPath ? "Loading saved source…" : "Choose a file in Files"),
            ),
          );
      }
    }
    comments.replaceChildren();
    for (const comment of round.comments) {
      if (
        detail.target.kind === "diff" &&
        !comment.outdated &&
        gitFile &&
        (comment.anchor.side === "old" ? gitFile.oldPath : gitFile.newPath) !==
          comment.anchor.path
      )
        continue;
      const item = document.createElement("div"),
        body = document.createElement("p");
      item.className = "review-comment";
      item.tabIndex = 0;
      const commentState =
        round.status === "cancelled"
          ? "Unsent"
          : round.status === "draft"
            ? "Draft"
            : round.submission?.delivery.status === "acknowledged"
              ? "Sent"
              : "Submitted";
      item.setAttribute("aria-label", `${commentState} comment`);
      const caption = document.createElement("div");
      caption.className = "review-comment-caption";
      caption.textContent = comment.outdated
        ? `${commentState} · Outdated anchor`
        : commentState;
      body.textContent = comment.body;
      item.append(caption, body);
      if (comment.quote) {
        const quote = document.createElement("blockquote");
        quote.textContent = comment.quote;
        item.append(quote);
      }
      if (round.status === "draft" && round.id === detail.currentRoundId) {
        item.onclick = () => openComment(comment.id, comment.body);
        item.onkeydown = (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            openComment(comment.id, comment.body);
          }
        };
        item.oncontextmenu = (event) => {
          event.preventDefault();
          menu({ x: event.clientX, y: event.clientY }, [
            {
              label: "Edit comment",
              run: () => openComment(comment.id, comment.body),
            },
            {
              label: "Delete comment",
              run: () => {
                void invoke("review.comment-delete", {
                  id,
                  roundId: round.id,
                  expectedVersion: detail!.version,
                  commentId: comment.id,
                })
                  .then(reload)
                  .catch(showError);
              },
            },
            {
              label: "Re-anchor to selected lines",
              run: () => {
                void invoke("review.comment-reanchor", {
                  id,
                  roundId: round.id,
                  expectedVersion: detail!.version,
                  commentId: comment.id,
                  range: selectedRange(),
                })
                  .then(reload)
                  .catch(showError);
              },
            },
          ]);
        };
      }
      const anchorIndex = comment.outdated
        ? -1
        : ranges.findIndex((range, index) => {
            const candidate = comment.anchor?.side
              ? (diffAnchors[index]?.[comment.anchor.side] ?? range)
              : range;
            return (
              candidate.endLine === comment.anchor?.endLine &&
              (!candidate.path || candidate.path === comment.anchor.path) &&
              candidate.side === comment.anchor?.side
            );
          });
      if (documentView && !comment.outdated)
        documentView.place(item, comment.anchor);
      else if (anchorIndex >= 0) buttons[anchorIndex].after(item);
      else comments.append(item);
    }
    if (!form.hidden) {
      if (staleEditor || round.comments.find((c) => c.id === editing)?.outdated)
        comments.after(form);
      else if (documentView)
        documentView.place(
          form,
          editing
            ? round.comments.find((c) => c.id === editing)!.anchor
            : (markdownDraftRange() ?? selectedRange()),
        );
      else {
        const saved = pending?.range;
        const index = saved
          ? diffAnchors.findIndex(
              (row) =>
                saved.side &&
                row[saved.side]?.path === saved.path &&
                row[saved.side]?.endLine === saved.endLine,
            )
          : end;
        const line = buttons[index];
        if (line) line.after(form);
        else comments.after(form);
      }
    }
    compare.disabled =
      detail.target.kind !== "document" || detail.rounds.length < 2;
    addComment.disabled =
      round.status !== "draft" ||
      round.id !== detail.currentRoundId ||
      (detail.target.kind === "diff" && !buttons.length);
    documentView?.setCommenting(!addComment.disabled);
    submit.textContent = round.comments.length ? "Send feedback" : "Approve";
    submit.disabled =
      round.status !== "draft" ||
      round.id !== detail.currentRoundId ||
      !!pending?.body.trim();
    submit.hidden = round.status !== "draft";
    feedback.replaceChildren();
    if (round.submission) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Feedback details";
      const payload = document.createElement("pre");
      payload.className = "feedback-envelope";
      try {
        payload.textContent = JSON.stringify(
          JSON.parse(round.submission.envelope),
          null,
          2,
        );
      } catch {
        payload.textContent = round.submission.envelope;
      }
      details.append(summary, payload);
      feedback.append(details);
    }
    delivery.replaceChildren();
    if (round.submission) {
      const text = document.createElement("p");
      text.textContent = {
        queued: "Feedback queued",
        dispatching: "Sending feedback",
        acknowledged: "Feedback sent",
        uncertain: "Delivery uncertain. Check native history before retrying.",
      }[round.submission.delivery.status];
      delivery.append(text);
      if (["queued", "uncertain"].includes(round.submission.delivery.status))
        delivery.append(
          button(
            round.submission.delivery.status === "uncertain"
              ? "Reconcile native history"
              : "Deliver queued feedback",
            async () => {
              await invoke("review.deliver", { id, round: round.id });
              await reload();
            },
          ),
        );
    }
    // Refreshing saved comments can replace diff rows or temporarily detach the
    // retained comment form. Keep keyboard focus on the same visible control.
    if (focused && document.activeElement === document.body) {
      const target = focused.isConnected
        ? focused
        : focusedLine
          ? buttons.find(
              (line) => line.getAttribute("aria-label") === focusedLine,
            )
          : undefined;
      if (target?.getClientRects().length)
        target.focus({ preventScroll: true });
      else if (focusedSource) documentView?.focus(textRange);
    }
    host.scrollTop = scrollTop;
    host.scrollLeft = scrollLeft;
  }
  async function reload() {
    const generation = ++loading;
    const next = await invoke<Detail>("review.detail", { id });
    if (generation !== loading) return;
    const followCurrent =
      presentCurrent ||
      !selectedRound ||
      selectedRound === detail?.currentRoundId;
    presentCurrent = false;
    detail = next;
    if (
      pendingSubmission &&
      next.rounds.some(
        (round) =>
          round.id === pendingSubmission?.round && round.status !== "draft",
      )
    ) {
      pendingSubmission = null;
      writePreference(pendingSubmissionKey, null);
    }
    if (followCurrent && selectedRound !== next.currentRoundId)
      chooseRound(next.currentRoundId);
    shownError = false;
    version = next.version;
    draw();
    void invoke<{ changed: boolean; unavailable: boolean }>("review.changed", {
      id,
    })
      .then((value) => {
        if (generation === loading && !shownError)
          status.textContent = value.changed
            ? `Changed on disk${value.unavailable ? " (unavailable)" : ""}; saved revision retained`
            : "";
      })
      .catch(() => {});
  }
  function pollDisk() {
    diskTimer = undefined;
    if (!host.isConnected) return;
    const generation = loading;
    void invoke<{ changed: boolean; unavailable: boolean }>(
      "review.changed",
      { id },
      { reportError: false },
    )
      .then((value) => {
        if (generation === loading && host.isConnected && !shownError)
          status.textContent = value.changed
            ? `Changed on disk${value.unavailable ? " (unavailable)" : ""}; saved revision retained`
            : "";
      })
      .catch(() => {})
      .finally(() => {
        if (host.isConnected) diskTimer = setTimeout(pollDisk, 2000);
      });
  }
  function update(next: AppState) {
    state = next;
    const review = state.reviews?.find((r) => r.id === id);
    const remote = state.remoteWorkspace;
    const connected =
      review && remote?.ids.includes(review.workspaceId)
        ? remote.connected
        : undefined;
    if (connected !== remoteConnected) {
      remoteConnected = connected;
      if (connected === true) {
        version = -1;
        if (gitError) gitRequest = "";
      }
    }
    if (connected === false) {
      status.textContent = "Reconnect to use this review.";
      return;
    }
    const origin = state.conversations.find(
      (c) => c.id === review?.originConversationId,
    );
    originLabel.textContent = origin
      ? `Feedback to ${conversationLabel(origin, state)}`
      : "";
    originLabel.title = originLabel.textContent ?? "";
    if (!diskTimer) diskTimer = setTimeout(pollDisk, 2000);
    const summary: ReviewSummary | undefined = state.reviews?.find(
      (r) => r.id === id,
    );
    const presentation = state.reviewPresentation;
    if (
      presentation?.paneId === paneId &&
      presentation.token !== presentationToken
    ) {
      presentationToken = presentation.token;
      presentCurrent = true;
    }
    if (summary && summary.version !== version) void reload().catch(showError);
    else if (presentCurrent && detail) {
      presentCurrent = false;
      if (selectedRound !== detail.currentRoundId) {
        chooseRound(detail.currentRoundId);
        draw();
      }
    }
  }
  function showError(error: unknown) {
    shownError = true;
    status.textContent = error instanceof Error ? error.message : String(error);
  }
  function button(label: string, action: () => unknown) {
    const element = uiButton(label);
    element.addEventListener("click", () => {
      Promise.resolve().then(action).catch(showError);
    });
    return element;
  }
  host.addEventListener(
    "cod:dispose-view",
    () => {
      loading++;
      clearTimeout(diskTimer);
      documentView?.clearAnnotations();
      documentView?.dispose();
      document.removeEventListener("cod:keymap-changed", updateShortcutTitles);
      updates.delete(host);
    },
    { once: true },
  );
  updates.set(host, update);
  update(initial);
  return host;
}
function region(label: string) {
  const el = document.createElement("div");
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", label);
  return el;
}
function select(label: string) {
  const el = document.createElement("select");
  el.setAttribute("aria-label", label);
  return el;
}
