---
name: report-problem
description: Turn a Cod "Report problem" folder (screenshot, app state, recent logs, workspace and session IDs) or a problem Mikhail describes into a scrubbed GitHub issue, so nothing work-related becomes public. Use when Mikhail hands over a report path or describes a problem.
---

# Report a problem

Output: a scrubbed GitHub issue in `cod-editor/cod`, labelled `bug` and a priority.

The report folder is private. It may contain work URLs, internal page screenshots, names and tokens. Nothing from it goes into the repo or an issue until it is scrubbed.

## Steps

1. Read the folder from the path given (under Cod's data directory). Expect: `screenshot.png`, `state.json`, `logs/`, `ids.json` (active workspace and session IDs). Do not copy it into the repo; the repo ignores report folders.
2. Understand the problem: what Mikhail did, what he expected, what happened. Use the logs and state to find the failing step.
3. Scrub before writing anything public:
   - replace work URLs and hostnames with invented ones;
   - replace internal project, team, people and product names with invented ones;
   - remove tokens, cookies, emails and session contents from logs;
   - never attach the original screenshot if it shows a work page; describe it in words.
     Then grep your draft for the employer's names and domains and for anything that looks like a secret. If unsure, leave it out.
4. Create the issue with sections What happened, Expected, Steps to reproduce, Environment (OS, Cod version):

   ```
   gh issue create --title "<what goes wrong, in user terms>" --label bug --label p1 --body-file <file>
   ```

   Use `p1` when it stops or annoys Mikhail in daily use, otherwise `p2`. The worker picks it up from the queue.
