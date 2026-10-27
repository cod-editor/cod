---
name: cod-control
description: Control the running Cod editor with codctl when working in a Cod workspace, including opening files, showing diffs, asking questions in page tabs, and updating agent session status.
---

<!-- cod-control-skill -->

# Control Cod

Use `codctl` to show relevant work in the user's editor when it helps the current task. Run `codctl --help` for the installed command syntax. Commands require Cod to be running. If `codctl` is not on PATH, use `/usr/local/bin/codctl` on macOS or `~/.local/bin/codctl` on Linux after running Help > Install codctl.

## Choose the workspace

Agents started inside Cod receive `COD_WORKSPACE`. Keep that environment value: it selects the workspace for file, diff, pane and session new/list commands. Use `--workspace <id-or-exact-name>` to target another workspace deliberately. Without either, those commands use the active window's workspace, which may change while you work. Use `codctl workspace list --json` when you need to discover the target.

## Show files and changes

Open a relevant file at a one-based line and optional column:

```sh
codctl open src/main.rs:42:5
```

Use absolute file paths when your working directory differs from the project root. Show changes with `codctl diff HEAD~1 HEAD`, or compare two files with `codctl diff /tmp/before.rs /path/to/after.rs`. Diff arguments containing `/` are treated as files; git revision arguments must contain no `/`. Use file paths containing `/` to avoid ambiguity.

## Ask through a page

When a question benefits from a form or visual choices, write a local HTML file and open it with `codctl open --html /tmp/cod-question.html --wait`. The command waits for an answer, prints the submitted value, and exits 0 after the tab closes. Exit 2 means the user closed the tab without answering; do not treat that as a selection or approval.

This minimal page works without JavaScript:

```html
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Choose a name</title>
<body style="background:var(--cod-background);color:var(--cod-text);font-family:var(--cod-font)">
<label for="answer">What should this workspace be called?</label>
<input id="answer" autofocus>
<button data-cod="submit" data-cod-value-from="#answer">Send</button>
</body>
</html>
```

Use real labels and keyboard-accessible inputs and buttons. Cod provides the theme variables `--cod-background`, `--cod-text`, `--cod-accent` and `--cod-font`. Its declarative bridge also supports `data-cod="open-file" data-cod-path="src/main.rs:42"` and `data-cod="focus-session" data-cod-session="<session-id>"`.

Only add `--js` when the page needs its own inline scripts. With it, scripts can submit using `window.cod.call('submit', {value: 'chosen-value'})`. The bridge actions are limited to `submit`, `open-file` and `focus-session`; the page does not have direct filesystem access. Without `--wait`, opening prints a page ID immediately. Use that ID with `codctl page get <page-id>` or `codctl page close <page-id>`.

## Set session status

Use `codctl session list --json` to discover provider session IDs and identify the session you are working in from reliable context. `COD_WORKSPACE` identifies a workspace, not a session. Do not invent a session environment variable or update a different session when your own identity is unclear.

When you know your session ID, set a short status describing the current work:

```sh
codctl session status <session-id> --line "Checking the build"
codctl session status <session-id> --line ""
```

Clear the line when the work finishes. Without `--line`, the command reads the state and status. Session commands taking an ID find it across all workspaces. `session send` sends a user message and starts that agent; use it only when the task calls for directing that session.
