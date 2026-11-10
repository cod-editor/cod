import { isAbsolute } from "node:path";
import type { ContextServer, ProviderId } from "./types.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && !value.includes("\0");

/** Validate and snapshot before any subprocess starts; callers cannot mutate the wire configuration. */
export function validateContextServer(
  value: unknown,
): ContextServer | undefined {
  if (value === undefined) return undefined;
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !["name", "command", "args", "env"].includes(key),
    ) ||
    typeof value.name !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(value.name) ||
    !text(value.command) ||
    !isAbsolute(value.command) ||
    !Array.isArray(value.args) ||
    !value.args.every(text) ||
    !record(value.env) ||
    Object.entries(value.env).some(
      ([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !text(item),
    )
  )
    throw new Error("Invalid context server configuration");
  return {
    name: value.name,
    command: value.command,
    args: [...value.args] as string[],
    env: { ...value.env } as Record<string, string>,
  };
}

export function contextParams(
  provider: ProviderId,
  server?: ContextServer,
): Record<string, unknown> {
  if (provider === "kimi")
    return {
      mcpServers: server
        ? [
            {
              name: server.name,
              command: server.command,
              args: server.args,
              env: Object.entries(server.env).map(([name, value]) => ({
                name,
                value,
              })),
            },
          ]
        : [],
    };
  return server
    ? {
        config: {
          [`mcp_servers.${server.name}`]: {
            command: server.command,
            args: server.args,
            env: server.env,
          },
        },
      }
    : {};
}
