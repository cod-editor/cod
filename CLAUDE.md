@AGENTS.md

## Claude Code specifics

- You are the worker described in AGENTS.md. Do the work yourself; delegate to a subagent only when it clearly helps.
- Skills are in `.claude/skills/`, a symlink to `.agents/skills/`. Edit them there, not through the symlink, so Claude Code and Codex stay in sync.
