import { object, string } from "./transport.ts";
import type { ProviderId } from "./types.ts";
export type InspectionSection =
  "status" | "skills" | "plugins" | "config" | "agents";
export interface InspectionEntry {
  id: string;
  label: string;
  detail: string;
  skill?: { name: string; path: string };
}
export interface ProviderInspection {
  section: InspectionSection;
  provider: ProviderId;
  nativeId: string;
  fields: { label: string; value: string }[];
  entries: InspectionEntry[];
  unavailable: string[];
}
type Request = (method: string, params: unknown) => Promise<unknown>;
const rows = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.map(object) : [];
const number = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
export class NativeInspection {
  private usage?: Record<string, unknown>;
  updateUsage(value: unknown) {
    this.usage = object(value);
  }
  async read(
    provider: ProviderId,
    nativeId: string,
    cwd: string,
    section: InspectionSection,
    request: Request,
  ): Promise<ProviderInspection> {
    const result: ProviderInspection = {
      section,
      provider,
      nativeId,
      fields: [],
      entries: [],
      unavailable: [],
    };
    const field = (label: string, value: unknown) => {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      )
        result.fields.push({ label, value: String(value) });
    };
    if (section === "status") {
      field("Native session", nativeId);
      field("Working directory", cwd);
    }
    if (provider !== "codex") {
      if (section === "status") {
        if (this.usage) {
          field("Context tokens", number(this.usage.used));
          field("Model context window", number(this.usage.size));
        } else
          result.unavailable.push(
            "Context usage unavailable until Kimi reports usage in this connection.",
          );
        result.unavailable.push(
          "Kimi ACP does not expose account rate limits.",
        );
        return result;
      }
      result.unavailable.push(
        "Kimi ACP does not expose this inspector capability in Cod. Model and thinking controls remain available in the composer.",
      );
      return result;
    }
    try {
      if (section === "skills") {
        const data = object(
          await request("skills/list", { cwds: [cwd], forceReload: true }),
        );
        if (!Array.isArray(data.data)) throw new Error();
        for (const entry of rows(data.data)) {
          if (rows(entry.errors).length)
            result.unavailable.push(
              "Some skills could not be loaded by Codex.",
            );
          for (const skill of rows(entry.skills)) {
            const name = string(skill.name),
              path = string(skill.path);
            if (name && path)
              result.entries.push({
                id: path,
                label: name,
                detail: `${skill.enabled === false ? "Disabled. " : ""}${string(skill.description) ?? ""}`,
                ...(skill.enabled !== false ? { skill: { name, path } } : {}),
              });
          }
        }
      } else if (section === "plugins") {
        const data = object(await request("plugin/installed", { cwds: [cwd] }));
        if (!Array.isArray(data.marketplaces)) throw new Error();
        for (const market of rows(data.marketplaces))
          for (const plugin of rows(market.plugins))
            if (plugin.installed === true)
              result.entries.push({
                id: String(plugin.id),
                label: String(plugin.name),
                detail: `${plugin.enabled ? "Enabled" : "Disabled"}${string(plugin.version) ? ` - ${plugin.version}` : ""}`,
              });
        if (rows(data.marketplaceLoadErrors).length)
          result.unavailable.push(
            "Some plugin marketplaces could not be loaded.",
          );
        result.unavailable.push(
          "Install, remove and configure plugins through the native Codex client.",
        );
      } else if (section === "config") {
        const data = object(
          await request("config/read", { cwd, includeLayers: false }),
        );
        const config = object(data.config);
        // Only documented nonsensitive scalar settings cross the renderer boundary.
        for (const key of [
          "model",
          "model_provider",
          "model_reasoning_effort",
          "approval_policy",
          "sandbox_mode",
          "web_search",
          "personality",
        ])
          field(key, config[key]);
        result.unavailable.push(
          "Selected effective settings only. Use the native Codex client to edit configuration; credentials and environment values are never shown here.",
        );
      } else if (section === "agents") {
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const data = object(
            await request("thread/list", {
              sourceKinds: ["subAgent"],
              limit: 100,
              ...(cursor ? { cursor } : {}),
            }),
          );
          if (!Array.isArray(data.data)) throw new Error();
          for (const child of rows(data.data))
            if (child.parentThreadId === nativeId)
              result.entries.push({
                id: String(child.id),
                label:
                  string(child.agentNickname) ??
                  string(child.name) ??
                  String(child.id),
                detail: `${string(object(child.status).type) ?? "Status unavailable"} - ${String(child.id)}`,
              });
          cursor = string(data.nextCursor);
          if (cursor && (cursors.has(cursor) || cursors.size >= 100))
            throw new Error();
          if (cursor) cursors.add(cursor);
        } while (cursor);
        result.unavailable.push(
          "Child sessions are read-only here. Ask the parent agent to coordinate or interact with them in the native client.",
        );
      } else {
        if (this.usage) {
          field(
            "Last input tokens",
            number(object(this.usage.last).inputTokens),
          );
          field(
            "Last total tokens",
            number(object(this.usage.last).totalTokens),
          );
          field(
            "Session total tokens",
            number(object(this.usage.total).totalTokens),
          );
          field("Model context window", number(this.usage.modelContextWindow));
        } else
          result.unavailable.push(
            "Context usage unavailable until Codex reports token usage in this connection.",
          );
        try {
          const data = object(await request("account/rateLimits/read", {}));
          const buckets = Object.values(object(data.rateLimitsByLimitId));
          if (!buckets.length && data.rateLimits) buckets.push(data.rateLimits);
          for (const raw of buckets) {
            const bucket = object(raw),
              label =
                string(bucket.limitName) ?? string(bucket.limitId) ?? "Codex";
            for (const key of ["primary", "secondary"]) {
              const window = object(bucket[key]),
                used = number(window.usedPercent),
                duration = number(window.windowDurationMins),
                reset = number(window.resetsAt);
              if (used !== undefined)
                field(
                  `${label} ${duration === 10080 ? "weekly" : duration ? `${duration} min` : key}`,
                  `${used}% used${reset !== undefined ? `; resets ${new Date(reset * 1000).toISOString()}` : ""}`,
                );
            }
          }
          if (!result.fields.some((f) => f.value.includes("% used")))
            result.unavailable.push(
              "Account limits were not supplied by Codex.",
            );
        } catch {
          result.unavailable.push("Account limits unavailable from Codex.");
        }
      }
    } catch {
      result.unavailable.push(
        `Codex ${section} inspection unavailable. This installed provider may not support the request.`,
      );
    }
    return result;
  }
}
