import { appendFileSync, readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { serveRuntimeContext } from "../../src/runtime-context/index";

const [configuration, audit, mode] = process.argv.slice(2);
const config = () => JSON.parse(readFileSync(configuration, "utf8"));
const handle = serveRuntimeContext({
  ...(mode?.startsWith("output-error")
    ? {
        output: new Writable({
          write(_chunk, _encoding, callback) {
            if (mode === "output-error-close")
              setImmediate(() => handle.close());
            setTimeout(
              () =>
                callback(
                  Object.assign(new Error("Invented peer closed"), {
                    code: "EPIPE",
                  }),
                ),
              mode === "output-error" ? 0 : 20,
            );
          },
        }),
      }
    : {}),
  workspaceId: "bound-workspace",
  conversationId: "bound-conversation",
  cliCommand: "node /invented/cod/dist/cli.cjs",
  helpText:
    "CURRENT_FIXTURE_HELP: state, capabilities, workspace focus --id ID. Unsupported: deploy-everything.",
  invoke: async (request) => {
    appendFileSync(audit, JSON.stringify({ op: request.op }) + "\n");
    const current = config();
    if (current.delayMs)
      await new Promise((resolve) => setTimeout(resolve, current.delayMs));
    if (current.failOp === request.op)
      throw new Error(current.failMessage ?? "Invented operation failure");
    if (request.op === "state") return current.state;
    if (request.op === "capabilities") return current.capabilities;
    throw new Error("Fixture rejects non-read-only operations");
  },
});
if (mode === "double-close")
  setTimeout(() => {
    handle.close();
    handle.close();
  }, 50);
