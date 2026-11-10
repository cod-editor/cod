import { ProviderOptionError } from "./option-error.ts";
import { object } from "./transport.ts";
import type {
  ProviderId,
  ProviderOptions,
  ProviderSelection,
  NativeChoice,
} from "./types.ts";
const identifier = (v: unknown): string => {
  if (typeof v !== "string" || !v.trim() || v.length > 512)
    throw new Error("Invalid native option metadata");
  return v;
};
function choices(value: unknown): NativeChoice[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new Error("Invalid native option catalog");
  const seen = new Set();
  return value.map((v) => {
    const row = object(v),
      id = identifier(row.value);
    if (seen.has(id)) throw new Error("Duplicate native option");
    seen.add(id);
    return { value: id, label: identifier(row.name) };
  });
}
export class NativeSelection {
  private current: ProviderOptions["current"] = {};
  private pending: NonNullable<ProviderOptions["pending"]> = {};
  private kimi: unknown;
  private provider: ProviderId;
  constructor(provider: ProviderId) {
    this.provider = provider;
  }
  bind(data: Record<string, unknown>) {
    if (this.provider === "codex") {
      this.current = {
        ...(typeof data.model === "string" ? { model: data.model } : {}),
        ...(typeof data.reasoningEffort === "string"
          ? { reasoning: data.reasoningEffort }
          : {}),
      };
    } else this.kimi = data.configOptions;
  }
  update(value: unknown) {
    this.kimi = value;
  }
  overrides() {
    return {
      ...(this.pending.model ? { model: this.pending.model } : {}),
      ...(this.pending.reasoning ? { effort: this.pending.reasoning } : {}),
    };
  }
  private kimiOptions(): ProviderOptions {
    if (!Array.isArray(this.kimi))
      throw new Error("Native option state unavailable; reconnect required");
    const seen = new Set();
    const records = this.kimi.map((v) => {
      const o = object(v),
        id = identifier(o.id);
      if (seen.has(id)) throw new Error("Duplicate native option category");
      seen.add(id);
      return o;
    });
    const parse = (id: string) => {
      const o = records.find((o) => o.id === id);
      if (!o) return undefined;
      if (o.type !== "select")
        throw new Error("Unsupported native option kind");
      const rows = choices(o.options),
        current = identifier(o.currentValue);
      if (!rows.some((r) => r.value === current))
        throw new Error("Native current option is missing from catalog");
      return { rows, current };
    };
    const model = parse("model"),
      reasoning = parse("thinking");
    if (!model) throw new Error("Native model options unavailable");
    return {
      models: model.rows,
      reasoning: reasoning?.rows ?? [],
      current: {
        model: model.current,
        ...(reasoning ? { reasoning: reasoning.current } : {}),
      },
      selectionEffect: "immediate",
    };
  }
  async read(
    request: (method: string, params: unknown) => Promise<unknown>,
  ): Promise<ProviderOptions> {
    if (this.provider === "kimi") return structuredClone(this.kimiOptions());
    const rows: Array<{ choice: NativeChoice; efforts: NativeChoice[] }> = [],
      cursors = new Set<string>(),
      values = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const data = object(
        await request("model/list", {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (!Array.isArray(data.data))
        throw new Error("Invalid native model catalog");
      for (const value of data.data) {
        const m = object(value),
          id = identifier(m.model);
        if (values.has(id) || rows.length >= 10000)
          throw new Error("Repeated or excessive native model catalog");
        values.add(id);
        if (!Array.isArray(m.supportedReasoningEfforts))
          throw new Error("Invalid native reasoning catalog");
        const efforts = choices(
          m.supportedReasoningEfforts.map((e) => {
            const o = object(e);
            return { value: o.reasoningEffort, name: o.description };
          }),
        );
        rows.push({
          choice: { value: id, label: identifier(m.displayName) },
          efforts,
        });
      }
      if (data.nextCursor === null || data.nextCursor === undefined) {
        const selected = this.pending.model ?? this.current.model;
        return {
          models: rows.map((r) => r.choice),
          reasoning:
            rows.find((r) => r.choice.value === selected)?.efforts ?? [],
          current: { ...this.current },
          ...(Object.keys(this.pending).length
            ? { pending: { ...this.pending } }
            : {}),
          selectionEffect: "next-turn",
        };
      }
      cursor = identifier(data.nextCursor);
      if (cursors.has(cursor)) throw new Error("Repeated native model cursor");
      cursors.add(cursor);
    }
    throw new Error("Native model pagination exceeded limit");
  }
  async set(
    selection: ProviderSelection,
    id: string,
    request: (method: string, params: unknown) => Promise<unknown>,
  ): Promise<ProviderOptions> {
    if (
      !selection ||
      typeof selection !== "object" ||
      Object.keys(selection).some((k) => !["option", "value"].includes(k)) ||
      !["model", "reasoning"].includes(selection.option)
    )
      throw new ProviderOptionError(
        "invalid-selection",
        "Invalid provider selection",
      );
    identifier(selection.value);
    const before = await this.read(request);
    const allowed =
      selection.option === "model" ? before.models : before.reasoning;
    if (!allowed.some((c) => c.value === selection.value))
      throw new ProviderOptionError(
        "invalid-selection",
        "Selection is not in the native catalog",
      );
    if (this.provider === "codex") {
      const previous = { ...this.pending };
      this.pending[selection.option] = selection.value;
      try {
        const next = await this.read(request);
        if (
          this.pending.reasoning &&
          !next.reasoning.some((r) => r.value === this.pending.reasoning)
        )
          delete this.pending.reasoning;
        return {
          ...next,
          ...(Object.keys(this.pending).length
            ? { pending: { ...this.pending } }
            : {}),
        };
      } catch (e) {
        this.pending = previous;
        throw e;
      }
    }
    try {
      const result = object(
        await request("session/set_config_option", {
          sessionId: id,
          configId: selection.option === "reasoning" ? "thinking" : "model",
          value: selection.value,
        }),
      );
      this.kimi = result.configOptions;
      const next = this.kimiOptions();
      if (next.current[selection.option] !== selection.value)
        throw new Error("Native selection was not acknowledged");
      return structuredClone(next);
    } catch {
      this.kimi = undefined;
      throw new Error(
        "Native selection was not confirmed; reconnect to refresh options",
      );
    }
  }
}
