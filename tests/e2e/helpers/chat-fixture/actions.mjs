// Invented provider actions call the real packaged CLI; no application state is simulated here.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
export function inspectionResponse(method, config, nativeId) {
  if (!config.nativeInspection) return undefined;
  if (method === "skills/list")
    return {
      data: [
        {
          skills: [
            {
              name: "fixture-review",
              path: config.skillPath,
              description: "Review invented fixture content",
              enabled: true,
            },
            ...(config.duplicateSkillPath
              ? [
                  {
                    name: "fixture-review",
                    path: config.duplicateSkillPath,
                    description: "Review from another fixture scope",
                    enabled: true,
                  },
                ]
              : []),
          ],
          errors: [],
        },
      ],
    };
  if (method === "account/rateLimits/read")
    return {
      rateLimits: {
        primary: {
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAt: 1900000000,
        },
        secondary: { usedPercent: 34, windowDurationMins: 10080 },
      },
    };
  if (method === "plugin/installed")
    return {
      marketplaces: [
        {
          plugins: [
            {
              id: "fixture-plugin",
              name: "Invented plugin",
              installed: true,
              enabled: true,
              version: "1.0",
            },
          ],
        },
      ],
    };
  if (method === "config/read")
    return {
      config: {
        model: "fixture-model",
        model_reasoning_effort: "medium",
        sandbox_mode: "workspace-write",
        api_key: "MUST_NOT_RENDER_SECRET",
        env: { TOKEN: "MUST_NOT_RENDER_ENV" },
      },
    };
  if (method === "thread/list")
    return {
      data: [
        {
          id: "fixture-child",
          parentThreadId: nativeId,
          agentNickname: "Invented reviewer",
          status: { type: "idle" },
        },
        {
          id: "foreign-child",
          parentThreadId: "foreign-native",
          agentNickname: "MUST_NOT_RENDER_FOREIGN",
          status: { type: "idle" },
        },
      ],
      nextCursor: null,
    };
}
export async function moveConversation(configuration, record) {
  const config = configuration();
  const cli = async (...args) => {
    const result = await execute(
      process.env.COD_NODE_PATH,
      [process.env.COD_CLI_PATH, ...args],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 10000 },
    );
    return JSON.parse(result.stdout);
  };
  const conversation = process.env.COD_CONVERSATION_ID;
  const source = process.env.COD_WORKSPACE_ID;
  await cli(
    "workspace",
    "add-folder",
    "--id",
    source,
    "--path",
    config.moveFolder,
  );
  const review = await cli(
    "review",
    "open-document",
    "--workspace",
    source,
    "--conversation",
    conversation,
    "--path",
    config.moveFile,
  );
  record("move-prepared", { conversation, source, review });
  const deadline = Date.now() + 20000;
  while (!configuration().moveNow) {
    if (Date.now() > deadline) throw new Error("Fixture move was not released");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const target = await cli("workspace", "create", "--name", config.moveName);
  await cli(
    "workspace",
    "add-folder",
    "--id",
    target.id,
    "--path",
    config.moveFolder,
  );
  const moved = await cli(
    "conversation",
    "move",
    "--id",
    conversation,
    "--workspace",
    target.id,
  );
  record("conversation-moved", {
    conversation,
    source,
    target: target.id,
    moved,
    review,
  });
  return target.id;
}
