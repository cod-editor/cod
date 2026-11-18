// Status policy belongs to this shipped integration, not the application transport.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const identity = process.env.COD_CONVERSATION_ID;
if (identity && process.env.COD_SOCKET_PATH) {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1024 * 1024) process.exit(0);
  }
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  // A child agent must not overwrite its parent's attention state.
  if (event.agent_id || event.subagent_id || event.is_subagent) process.exit(0);
  const name = event.hook_event_name;
  if (name === "SessionStart") {
    try {
      const skill = await readFile(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "SKILL.md"),
        "utf8",
      );
      process.stdout.write(
        JSON.stringify(
          process.argv[2] === "kimi"
            ? { message: skill }
            : {
                hookSpecificOutput: {
                  hookEventName: "SessionStart",
                  additionalContext: skill,
                },
              },
        ),
      );
    } catch {
      /* Missing context must not block the agent. */
    }
  }
  const status = {
    UserPromptSubmit: "working",
    PermissionRequest: "waiting",
    PostToolUse: "working",
    Stop: "ready",
  }[name];
  if (name === "Stop") process.stdout.write("{}");
  if (status && process.env.COD_NODE_PATH && process.env.COD_CLI_PATH) {
    await new Promise((resolve) => {
      execFile(
        process.env.COD_NODE_PATH,
        [
          process.env.COD_CLI_PATH,
          "conversation",
          "report-status",
          "--id",
          identity,
          "--status",
          status,
          "--source",
          "hook",
          "--context",
          name === "PermissionRequest" ? "Approval requested" : "",
        ],
        {
          timeout: 2500,
          maxBuffer: 16384,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
        () => resolve(),
      );
    });
  }
}
