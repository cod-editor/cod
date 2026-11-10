// Credential-free native parser/discovery probe. Never trusts hooks or sends a prompt.
import { mkdtemp, realpath, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inspectIntegration,
  installIntegration,
} from "../../../src/agent-plugin.ts";
import { Rpc } from "./rpc.mjs";

const root = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "cod-native-plugin-")),
);
const results = [];
try {
  for (const provider of ["codex", "kimi"]) {
    const profilePath = path.join(root, provider);
    await mkdir(profilePath);
    const options = { provider, profilePath, bundleRoot: process.cwd() };
    const preview = await inspectIntegration(options);
    await installIntegration({
      ...options,
      expectedPreviewHash: preview.previewHash,
    });
    const rpc = new Rpc(
      "env",
      [
        `${provider === "codex" ? "CODEX_HOME" : "KIMI_CODE_HOME"}=${profilePath}`,
        provider,
        ...(provider === "codex" ? ["app-server", "--stdio"] : ["acp"]),
      ],
      root,
    );
    try {
      await rpc.request(
        "initialize",
        provider === "codex"
          ? {
              clientInfo: { name: "cod_plugin_config_probe", version: "0.0.0" },
              capabilities: { experimentalApi: true },
            }
          : {
              protocolVersion: 1,
              clientInfo: { name: "cod_plugin_config_probe", version: "0.0.0" },
              clientCapabilities: {},
            },
        15000,
      );
      if (provider === "codex") {
        rpc.send({ method: "initialized", params: {} });
        const created = await rpc.request(
          "thread/start",
          {
            cwd: root,
            ephemeral: true,
            sandbox: "read-only",
            approvalPolicy: "never",
          },
          15000,
        );
        const listed = await rpc.request(
          "hooks/list",
          { threadId: created.thread.id },
          15000,
        );
        const hooks = listed.data.flatMap((source) =>
          source.hooks.map((hook) => ({
            event: hook.eventName,
            enabled: hook.enabled,
            trust: hook.trustStatus,
          })),
        );
        if (hooks.length !== 5)
          throw new Error(
            `Expected 5 installed hook definitions, got ${hooks.length}`,
          );
        results.push({
          provider,
          configuration: "PASS",
          hooks,
          execution: "BLOCKED: native trust review required",
        });
      } else {
        try {
          await rpc.request(
            "session/new",
            { cwd: root, mcpServers: [] },
            15000,
          );
          results.push({
            provider,
            configuration: "PASS",
            execution: "NOT TESTED: no model turn requested",
          });
        } catch (error) {
          if (!/auth/i.test(error.message)) throw error;
          results.push({
            provider,
            configuration: "PARTIAL: initialize accepted configuration",
            execution: "BLOCKED: isolated profile has no authentication",
          });
        }
      }
    } catch (error) {
      results.push({ provider, configuration: "FAIL", reason: error.message });
    } finally {
      await rpc.close();
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
