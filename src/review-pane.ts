import { shortcutTitle } from "./ui/keyboard-ui";
import { conversationLabel } from "./ui/message-label";
import { readPreference, writePreference } from "./ui/preferences";
import { iconButton, menu } from "./ui/controls";
import type { AppState, ReviewSummary } from "./types";
import type { Invoke } from "./ui/contracts";
import type { ReviewService } from "./reviews/index";
type Detail = Awaited<ReturnType<ReviewService["detail"]>>;
type Range = import("./reviews/snapshots").Range;
const updates = new WeakMap<HTMLElement, (state: AppState) => void>();
export function updateReview(element: HTMLElement, state: AppState) {
  updates.get(element)?.(state);
}
export function reviewPane(
  id: string,
  initial: AppState,
  invoke: Invoke,
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
  };
  let pending = readPreference<PendingEditor | null>(
      `review-editor.${id}`,
      null,
    ),
    restored = false,
    staleEditor = false;
  const remember = () => {
    if (!detail) return;
    pending = {
      roundId: selectedRound,
      snapshotId: detail.rounds.find((r) => r.id === selectedRound)!.snapshotId,
      selection,
      end,
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
  let shownError = false;
  let diskTimer: ReturnType<typeof setTimeout> | undefined;
  let ranges: Range[] = [],
    buttons: HTMLButtonElement[] = [];
  const header = document.createElement("div"),
    content = region("Review content"),
    comments = region("Draft comments"),
    feedback = region("Submitted feedback"),
    delivery = region("Delivery status"),
    changes = region("Document changes"),
    status = document.createElement("div");
  status.setAttribute("role", "status");
  const roundSelect = select("Round");
  const form = document.createElement("div"),
    input = document.createElement("textarea");
  input.setAttribute("aria-label", "Comment");
  form.hidden = true;
  const save = button("Save comment", async () => {
    if (!detail || staleEditor) return;
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
      const range = selectedRange();
      await invoke(editing ? "review.comment-edit" : "review.comment-add", {
        id,
        roundId: selectedRound,
        expectedVersion: detail.version,
        body: input.value,
        ...(editing ? { commentId: editing } : { range }),
      });
      form.hidden = true;
      forget();
      editing = undefined;
      input.value = "";
      await reload();
      if (restoreSelection) focusSelection();
      status.textContent = "Saved";
    } finally {
      document.removeEventListener("focusin", movedFocus, true);
    }
  });
  form.append(
    input,
    save,
    button("Cancel comment", () => {
      forget();
      form.hidden = true;
      draw();
      focusSelection();
    }),
  );
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      form.hidden = true;
      focusSelection();
    }
  });
  function openComment(commentId?: string, body = "") {
    if (pending?.body.trim() && commentId && commentId !== pending.editing) {
      status.textContent = "Save or cancel the unfinished comment first.";
      return;
    }
    editing = commentId;
    input.value = body || (!commentId ? (pending?.body ?? "") : "");
    staleEditor = false;
    save.disabled = false;
    restored = true;
    remember();
    form.hidden = false;
    buttons[end]?.after(form);
    input.focus();
  }
  input.addEventListener("input", () => {
    remember();
    submit.disabled = !!input.value.trim();
  });
  function focusSelection() {
    const line = buttons[selection];
    if (!line) return;
    line.dataset.rangeMove = "true";
    line.focus();
    delete line.dataset.rangeMove;
  }
  function selectedRange(): Range {
    const a = ranges[Math.min(selection, end)],
      b = ranges[Math.max(selection, end)];
    if (!a || !b || a.path !== b.path || a.side !== b.side)
      throw new Error("Select lines on the same file and side");
    return { ...a, endLine: b.endLine };
  }
  host.addEventListener("cod:add-comment", () => {
    const round = detail?.rounds.find((r) => r.id === selectedRound);
    if (round?.status === "draft" && round.id === detail?.currentRoundId)
      openComment();
  });
  host.addEventListener("cod:submit-review", () => {
    if (!submit.disabled && !submit.hidden) submit.click();
  });
  const addComment = button("Add comment", () => openComment());
  addComment.title = shortcutTitle("review.addComment", "Add comment");
  const refresh = button("Refresh round", async () => {
    if (!detail) return;
    await invoke("review.refresh", {
      id,
      expectedRound: detail.currentRoundId,
      expectedVersion: detail.version,
    });
    selectedRound = "";
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
    await invoke("review.submit", {
      id,
      round: selectedRound,
      requestId: crypto.randomUUID(),
      expectedVersion: detail.version,
    });
    await reload();
  });
  header.className = "review-header";
  const originLabel = document.createElement("span");
  originLabel.className = "review-origin";
  const more = iconButton("more", "Review actions", () =>
    menu(more, [
      {
        label: "Add comment",
        disabled: addComment.disabled,
        run: () => addComment.click(),
      },
      { label: "Refresh round", run: () => refresh.click() },
      {
        label: "Changes since previous round",
        disabled: compare.disabled,
        run: () => compare.click(),
      },
    ]),
  );
  header.append(roundSelect, originLabel, more, submit);
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
  roundSelect.addEventListener("change", () => {
    selectedRound = roundSelect.value;
    selection = end = 0;
    draw();
  });
  function draw() {
    if (!detail) return;
    const round =
      detail.rounds.find((r) => r.id === selectedRound) ??
      detail.rounds.at(-1)!;
    selectedRound = round.id;
    roundSelect.replaceChildren(
      ...detail.rounds.map((r) => new Option(`Round ${r.number}`, r.id)),
    );
    roundSelect.value = round.id;
    const snapshot = detail.snapshots[round.snapshotId];
    if (
      pending &&
      (pending.roundId !== round.id || pending.snapshotId !== round.snapshotId)
    ) {
      staleEditor = true;
      save.disabled = true;
      shownError = true;
      status.textContent =
        "Unfinished comment belongs to an older revision. Select lines and choose Add comment to re-anchor it.";
    }
    if (pending && !restored) {
      restored = true;
      input.value = pending.body;
      editing = pending.editing;
      selection = pending.selection;
      end = pending.end;
      form.hidden = false;
      staleEditor =
        pending.roundId !== round.id || pending.snapshotId !== round.snapshotId;
      save.disabled = staleEditor;
      if (staleEditor) {
        shownError = true;
        status.textContent =
          "Unfinished comment belongs to an older revision. Select lines and choose Add comment to re-anchor it.";
      }
    }
    const label = document.createElement("p");
    label.className = "review-source";
    label.textContent =
      detail.target.kind === "document"
        ? detail.target.path
        : detail.target.repoRoot;
    label.title = `Saved revision ${snapshot.hash}`;
    content.replaceChildren(label);
    if (detail.target.kind === "diff") {
      const comparison = document.createElement("p");
      comparison.textContent = detail.target.base
        ? `${detail.target.base} (${snapshot.base}) → ${detail.target.head} (${snapshot.head})`
        : "Local tracked changes (saved working-tree diff)";
      content.append(comparison);
    }
    ranges = [];
    buttons = [];
    function add(text: string, name: string, range: Range) {
      const index = buttons.length;
      const line = document.createElement("button");
      line.type = "button";
      line.tabIndex = index === end ? 0 : -1;
      line.className = "review-line";
      line.textContent = text;
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
                i >= Math.min(selection, end) && i <= Math.max(selection, end),
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
            disabled:
              round.status !== "draft" || round.id !== detail!.currentRoundId,
            run: () => openComment(),
          },
        ]);
      };
      content.append(line);
    }
    if (snapshot.kind === "document") {
      const lines = snapshot.text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      lines.forEach((text, i) =>
        add(`${i + 1}  ${text}`, `Line ${i + 1}`, {
          startLine: i + 1,
          endLine: i + 1,
        }),
      );
    } else
      for (const file of snapshot.files)
        for (const side of ["old", "new"] as const) {
          const sidePath = side === "old" ? file.oldPath : file.newPath;
          if (sidePath) {
            const heading = document.createElement("h3");
            heading.textContent = `${side === "old" ? "Old" : "New"}: ${sidePath}`;
            content.append(heading);
          }
          for (const [number, text] of Object.entries(file[side])) {
            const path = side === "old" ? file.oldPath : file.newPath;
            if (path)
              add(
                `${side === "old" ? "-" : "+"}${number}  ${text}`,
                `${side === "old" ? "Old" : "New"} line ${number} ${path}`,
                {
                  startLine: Number(number),
                  endLine: Number(number),
                  path,
                  side,
                },
              );
          }
        }
    comments.replaceChildren();
    for (const comment of round.comments) {
      const item = document.createElement("div"),
        body = document.createElement("p");
      item.className = "review-comment";
      item.tabIndex = 0;
      const commentState =
        round.status === "draft"
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
      if (comment.outdated) {
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
        : ranges.findIndex(
            (range) =>
              range.endLine === comment.anchor?.endLine &&
              (!range.path || range.path === comment.anchor.path) &&
              range.side === comment.anchor?.side,
          );
      if (anchorIndex >= 0) buttons[anchorIndex].after(item);
      else comments.append(item);
    }
    if (!form.hidden) {
      if (staleEditor) content.after(form);
      else buttons[Math.min(end, buttons.length - 1)]?.after(form);
    }
    compare.disabled =
      detail.target.kind !== "document" || detail.rounds.length < 2;
    addComment.disabled =
      round.status !== "draft" || round.id !== detail.currentRoundId;
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
  }
  async function reload() {
    const generation = ++loading;
    const next = await invoke<Detail>("review.detail", { id });
    if (generation !== loading) return;
    detail = next;
    shownError = false;
    version = next.version;
    draw();
    void invoke<{ changed: boolean; unavailable: boolean }>("review.changed", {
      id,
    })
      .then((value) => {
        if (generation === loading && !staleEditor)
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
    if (summary && summary.version !== version) void reload().catch(showError);
  }
  function showError(error: unknown) {
    shownError = true;
    status.textContent = error instanceof Error ? error.message : String(error);
  }
  function button(label: string, action: () => unknown) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", () => {
      Promise.resolve().then(action).catch(showError);
    });
    return element;
  }
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
