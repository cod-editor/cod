# Cod status integration

Install through Cod's explicit integration preview for a selected provider profile. The installer preserves unrelated settings, backs up modified files, rejects edited managed hooks/scripts and requires a fresh preview when inputs change. It never modifies a profile on startup or grants native hook trust. Runtime files and the operating skill are copied into the profile's `cod-integration` directory.

The hook policy reports working on a submitted prompt and after a tool returns, waiting on an approval request, and ready on turn stop. Reports carry `source: hook`; the application preserves an explicit review status instead of overwriting it with a lifecycle report. Codex and Claude SessionStart supplies the operating skill through additionalContext. Hooks never approve permissions, submit reviews or block the provider. Technical process failures remain application state. Hooks with no Cod conversation/socket binding are inert; child-agent events with explicit child identity are ignored. The runner uses environment-bound identity, never a target supplied in hook input.

The application passes `COD_CONVERSATION_ID`, `COD_SOCKET_PATH`, `COD_NODE_PATH` and `COD_CLI_PATH` to owned provider subprocesses. Hooks invoke `conversation report-status` through that CLI. This integration does not claim to track independently launched terminal sessions or implement an agent message bus.

## Native configuration references

- [Codex hooks](https://learn.chatgpt.com/docs/hooks): user `hooks.json`, grouped command handlers, and explicit `/hooks` review/trust. Installing definitions does not establish trust. Cod does not write trust hashes or enable a bypass.
- [Claude hooks](https://code.claude.com/docs/en/hooks): hooks in user `settings.json`, command handlers and JSON event input.
- [Kimi hooks](https://moonshotai.github.io/kimi-code/en/customization/hooks): user `config.toml` uses `[[hooks]]` with event, command and timeout. The installer appends a marked block without rewriting unrelated TOML.

Kimi also receives the skill at `$KIMI_CODE_HOME/skills/cod/SKILL.md`, its documented [user skill scan location](https://moonshotai.github.io/kimi-code/en/customization/skills). The installed Kimi 2.5.2 JavaScript source was inspected: its hook output parser accepts `message`, while its SessionStart handler does not consume the result as prompt context. Its runner output therefore uses `message`, and skill discovery uses the native skill directory. This source inspection is distinct from authenticated hook execution, which remains blocked in the credential-free profile probe.

All three integrations register SessionStart, UserPromptSubmit, PermissionRequest, PostToolUse and Stop. Provider execution can reject or skip hooks independently of successful installation. Isolated installer and event-to-CLI tests do not prove authenticated native hook execution. Current native trust/authentication limitations must remain visible in release verification.

Run `node --test tests/agent-plugin.test.ts` for temporary-profile merge, backup, idempotence, edit/conflict rejection and event-routing checks. Tests never modify the user's real provider profiles.

`node experiments/verification/native-plugin-config.mjs` checks installed native parsers without a model prompt. It does not bypass hook trust or supply authentication; successful parsing is distinct from actual hook execution.
