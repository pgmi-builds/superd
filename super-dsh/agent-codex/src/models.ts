/**
 * Codex model catalog for the Dash model selector (AW-E Task 5).
 *
 * Reads the adapter's nested codex home the native way (spec S7: the native
 * app self-populates its config; we read, never write):
 * - `config.toml` top-level keys `model`, `model_reasoning_effort`,
 *   `model_provider`, `model_catalog_json` (minimal line parser — the full
 *   TOML grammar is deliberately not implemented; unknown lines are skipped);
 * - `model_catalog_json` (relative to the codex home) → per-model identity
 *   fields (slug / display_name / default_reasoning_level / context_window).
 *
 * The frozen multi-agent-ctx models.ts used the app-server `model/list` —
 * that surface does not exist on the SDK line, so the TOML+catalog pair is
 * the only catalog source. Fail-soft everywhere: any missing/unparsable piece
 * degrades toward a single `codex-default` placeholder, never a throw.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCodexHome, useCodexHome } from "./codex-store.js";

/** One Dash-facing model entry. */
export interface CodexModelEntry {
  /** Codex model slug (the ThreadOption `model` value). */
  readonly id: string;
  /** Display label. */
  readonly label: string;
  /** Default reasoning level, when the catalog advertises one. */
  readonly reasoningEffort?: string;
  /** Context window in tokens, when known. */
  readonly contextWindow?: number;
}

/** The resolved catalog projection. */
export interface CodexModelCatalog {
  /** The model Codex runs unless overridden (config `model`). */
  readonly defaultModel: string;
  /** Provider display name (config `[model_providers.<id>].name`). */
  readonly provider?: string;
  readonly models: readonly CodexModelEntry[];
}

/** Minimal top-level TOML scan: `key = value` pairs + `[section]` headers. */
function parseTopLevelToml(text: string): { values: Record<string, string>; sections: Map<string, Record<string, string>> } {
  const values: Record<string, string> = {};
  const sections = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  let currentName = "";
  for (const rawLine of text.split("\n")) {
    const lineText = rawLine.trim();
    if (lineText === "" || lineText.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(lineText);
    if (header !== null) {
      currentName = header[1].trim();
      current = {};
      sections.set(currentName, current);
      continue;
    }
    const eq = lineText.indexOf("=");
    if (eq <= 0) continue; // broken line — tolerated
    const key = lineText.slice(0, eq).trim();
    let value = lineText.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // strip trailing comment on bare values; keep numbers/bools as strings
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (current !== null && currentName !== "") current[key] = value;
    else values[key] = value;
  }
  return { values, sections };
}

/** The fail-soft placeholder model id (never sent to the real codex binary). */
export const CODEX_DEFAULT_MODEL_PLACEHOLDER = "codex-default";

/** The fail-soft placeholder: one entry, no claims about the runtime. */
function placeholder(defaultModel = CODEX_DEFAULT_MODEL_PLACEHOLDER): CodexModelCatalog {
  return { defaultModel, models: [{ id: defaultModel, label: "Codex default" }] };
}

/** Read the model catalog out of the codex home (fail-soft, never throws). */
export function readCodexModelCatalog(codexHome?: string): CodexModelCatalog {
  let home: string;
  try {
    home = codexHome !== undefined ? useCodexHome(codexHome) : resolveCodexHome();
  } catch {
    return placeholder();
  }
  let configValues: Record<string, string> = {};
  let providerName: string | undefined;
  const configPath = join(home, "config.toml");
  if (existsSync(configPath)) {
    try {
      const parsed = parseTopLevelToml(readFileSync(configPath, "utf8"));
      configValues = parsed.values;
      const providerId = configValues["model_provider"];
      if (providerId !== undefined) {
        const section = parsed.sections.get(`model_providers.${providerId}`);
        if (section !== undefined && typeof section["name"] === "string" && section["name"] !== "") {
          providerName = section["name"];
        }
      }
    } catch {
      return placeholder();
    }
  }
  const configModel = configValues["model"];
  const catalogRel = configValues["model_catalog_json"];
  const entries: CodexModelEntry[] = [];
  if (catalogRel !== undefined && catalogRel !== "") {
    const catalogPath = join(home, catalogRel);
    if (existsSync(catalogPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
        const models = (parsed as { models?: unknown })?.models;
        if (Array.isArray(models)) {
          for (const raw of models) {
            if (raw === null || typeof raw !== "object") continue;
            const m = raw as Record<string, unknown>;
            const slug = m["slug"];
            if (typeof slug !== "string" || slug === "") continue;
            const label = typeof m["display_name"] === "string" && m["display_name"] !== "" ? m["display_name"] : slug;
            const entry: CodexModelEntry = {
              id: slug,
              label,
              ...(typeof m["default_reasoning_level"] === "string" && m["default_reasoning_level"] !== ""
                ? { reasoningEffort: m["default_reasoning_level"] }
                : {}),
              ...(typeof m["context_window"] === "number" && Number.isSafeInteger(m["context_window"])
                ? { contextWindow: m["context_window"] }
                : {}),
            };
            entries.push(entry);
          }
        }
      } catch {
        // unparsable catalog — fall through to the config-model entry
      }
    }
  }
  if (entries.length === 0) {
    if (configModel === undefined || configModel === "") return placeholder();
    return {
      defaultModel: configModel,
      ...(providerName === undefined ? {} : { provider: providerName }),
      models: [{ id: configModel, label: configModel }],
    };
  }
  // The configured model is what sessions actually run, so it must be
  // selectable even when the provider's own catalog file does not list it
  // (cc-switch ships a fixed list; `config.toml` may name a newer entry).
  const models = configModel !== undefined && configModel !== "" && !entries.some((entry) => entry.id === configModel)
    ? [{ id: configModel, label: configModel }, ...entries]
    : entries;
  return {
    defaultModel: configModel !== undefined && configModel !== "" ? configModel : entries[0].id,
    ...(providerName === undefined ? {} : { provider: providerName }),
    models,
  };
}
