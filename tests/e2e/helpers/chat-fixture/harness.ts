import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkspaceApp } from "../workspace-app";

export type Provider = "codex" | "kimi";
export interface Chat {
  id: string;
  paneId: string;
  provider: Provider;
  nativeId: string;
  status: "starting" | "ready" | "working" | "waiting" | "failed" | "closed";
  messages: Array<{ id: string; role: string; text: string }>;
  tools: unknown[];
  pendingPermissions: Array<{
    id: string;
    options: Array<{ id: string; label: string }>;
  }>;
}
export interface ProtocolRecord {
  event: string;
  pid?: number;
  provider: Provider;
  nativeId?: string;
  message?: { method?: string; params?: Record<string, unknown> };
}
export class ChatApp extends WorkspaceApp {
  recording = "";
  async prepare() {
    await super.prepare();
    this.recording = path.join(this.temporary, "native-protocol.jsonl");
    await writeFile(this.recording, "");
    const fixture = path.join(
      this.root,
      "tests/e2e/helpers/chat-fixture/provider.mjs",
    );
    for (const provider of ["codex", "kimi"] as const) {
      this.environment[`COD_${provider.toUpperCase()}_EXECUTABLE`] =
        process.execPath;
      this.environment[`COD_${provider.toUpperCase()}_ARGS`] = JSON.stringify([
        fixture,
        provider,
        this.recording,
      ]);
    }
  }
  inspect(id: string) {
    return this.cli<Chat>("conversation", "inspect", "--id", id);
  }
  newChat(workspace: string, provider: Provider) {
    return this.cli<{ id: string; paneId: string; nativeId: string }>(
      "conversation",
      "create",
      "--workspace",
      workspace,
      "--provider",
      provider,
      "--cwd",
      this.folders[0],
    );
  }
  send(id: string, text: string) {
    return this.cli("conversation", "send", "--id", id, "--text", text);
  }
  async configure(value: Record<string, unknown>) {
    await writeFile(this.recording + ".config.json", JSON.stringify(value));
  }
  async records(): Promise<ProtocolRecord[]> {
    return (await readFile(this.recording, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  async prompts() {
    return (await this.records()).filter((record) =>
      ["turn/start", "session/prompt"].includes(record.message?.method ?? ""),
    );
  }
}
