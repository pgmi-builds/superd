/**
 * Claude model catalog for the Dash model selector.
 *
 * Claude owns the truth about which models exist. Sources, in authority
 * order:
 * - the boot probe (`probeClaudeModels`, claude-client.ts): one ephemeral SDK
 *   query at provider boot asks the CLI's `supportedModels()` and publishes
 *   the full alias roster (sonnet/opus/haiku/fable/...) via
 *   {@link setModelCatalog};
 * - the live session's `supportedModels()` (agent.ts), which overwrites the
 *   same catalog once a session is running;
 * - until the first probe answer, the degraded single-entry catalog derived
 *   from the runtime's own `session_init.model` (`catalogFromInit`).
 *
 * This module is only the in-memory projection those observations are
 * published into — the browser model selector reads it through
 * `ClaudeLlmAdapter` under the `claude` route.
 *
 * Observed-only (the invariant this file exists to hold):
 * - Nothing here ever synthesises a placeholder model id (`claude-default`,
 *   a `deepseek-flash` fallback, ...), because a fabricated id would leak
 *   into the picker and onto the wire.
 * - `CLAUDE_DEFAULT_MODEL` is a REAL CLI alias kept ONLY as the boot/fallback
 *   default (and the probe-failure catalog): every other entry must come from
 *   a runtime observation. A degraded value stays in memory — it is never
 *   written to settings, and only the alias the CLI itself resolves ever
 *   reaches the runtime as a selection.
 *
 * The catalog is process-global module state, not a per-adapter instance
 * field: exactly one Claude app per world observes it, and the settings-UI
 * round trip constructs its own adapter instance.
 */

/** One Dash-facing model entry, exactly as Claude reported it. */
export interface ClaudeModelEntry {
  /** Claude model id (the SDK `model` value — the CLI's own alias). */
  readonly id: string;
  /** Display label. */
  readonly label: string;
  /** Optional user-facing distinction from otherwise similar models. */
  readonly description?: string;
  /** Context window in tokens, when the runtime advertises one. */
  readonly contextWindow?: number;
  /** Canonical wire id this alias resolves to, when the CLI reported one. */
  readonly resolvedModel?: string;
  /** Reasoning-effort level ids the CLI advertises for this model. */
  readonly reasoningEfforts?: readonly string[];
}
/** The resolved catalog projection. */
export interface ClaudeModelCatalog {
  /** Observed models, in report order. Empty when nothing has been observed. */
  readonly models: readonly ClaudeModelEntry[];
  /** The runtime's default model, when it named one. Never synthesised. */
  readonly defaultModel?: string;
}

/** The empty catalog after a legitimate empty observation (`setModelCatalog([])`). */
const EMPTY_CATALOG: ClaudeModelCatalog = Object.freeze({ models: Object.freeze([]) });

/**
 * The ONE real model this adapter is configured to use at boot: the Claude
 * Code model alias `sonnet` (a genuine CLI-resolvable id, never a fabricated
 * placeholder). It names the BOOT catalog row and the fallback default used
 * when neither the boot probe nor a live session has answered — a probe
 * failure must never grow fabricated rows, only keep this one real alias.
 */
export const CLAUDE_DEFAULT_MODEL = "sonnet";

/** The boot catalog: the declared default, served before any observation. */
const BOOT_CATALOG: ClaudeModelCatalog = Object.freeze({
  models: Object.freeze([Object.freeze({ id: CLAUDE_DEFAULT_MODEL, label: CLAUDE_DEFAULT_MODEL })]),
  defaultModel: CLAUDE_DEFAULT_MODEL,
});

let catalog: ClaudeModelCatalog = BOOT_CATALOG;

/** Detach one entry so neither side of a read/write can mutate the other. */
function cloneEntry(entry: ClaudeModelEntry): ClaudeModelEntry {
  return {
    id: entry.id,
    label: entry.label,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
    ...(entry.resolvedModel === undefined ? {} : { resolvedModel: entry.resolvedModel }),
    ...(entry.reasoningEfforts === undefined ? {} : { reasoningEfforts: Object.freeze([...entry.reasoningEfforts]) }),
  };
}

/** A detached entry that neither side of a read/write can mutate. */
function frozenEntry(entry: ClaudeModelEntry): ClaudeModelEntry {
  return Object.freeze(cloneEntry(entry));
}

/**
 * Publish the observed catalog. This is an **overwrite**, never a merge:
 * calling it twice leaves only the second list, so the catalog can shrink
 * (including back to empty) when Claude reports fewer models.
 *
 * Entries are copied in, so a caller mutating its own array afterwards cannot
 * reach back into module state.
 *
 * @param entries - exactly the models Claude reported; `[]` is a legitimate
 *   observation and must never be replaced by a placeholder.
 * @param defaultModel - the model Claude named as default. It is stored only
 *   when it is non-empty **and** names one of `entries`: a dangling default
 *   would render as a selection the picker cannot show and `resolveModel`
 *   cannot resolve, which is the same fabricated reference onto the wire that
 *   a placeholder model id would be.
 */
export function setModelCatalog(entries: readonly ClaudeModelEntry[], defaultModel?: string): void {
  catalog = Object.freeze({
    models: Object.freeze(entries.map(frozenEntry)),
    ...(defaultModel !== undefined && defaultModel !== "" && entries.some((entry) => entry.id === defaultModel)
      ? { defaultModel }
      : {}),
  });
}

/**
 * Read the current catalog as a detached, frozen snapshot: a caller cannot
 * mutate module state through it, nor observe a later write through it.
 */
export function readModelCatalog(): ClaudeModelCatalog {
  if (catalog.models.length === 0 && catalog.defaultModel === undefined) return EMPTY_CATALOG;
  return Object.freeze({
    models: Object.freeze(catalog.models.map(frozenEntry)),
    ...(catalog.defaultModel === undefined ? {} : { defaultModel: catalog.defaultModel }),
  });
}

/**
 * Derive the **degraded** single-entry catalog from a projected `session_init`
 * (Task 4) while `supportedModels()` has not answered yet.
 *
 * The runtime's own reported model is real, so it may stand in for the catalog
 * until the authoritative list arrives. It is a read of memory only: callers
 * must not persist it into settings, and must not pass it back to the runtime
 * as a selection.
 *
 * @param init - the projected `session_init` shape; anything unusable —
 *   non-string, empty, or whitespace-only — yields `[]` (still empty — no
 *   placeholder).
 * @returns zero or one observed entry.
 */
export function catalogFromInit(init: { model?: unknown; slashCommands?: unknown }): ClaudeModelEntry[] {
  const model = init?.model;
  if (typeof model !== "string" || model.trim() === "") return [];
  return [{ id: model, label: model }];
}

/**
 * Map one SDK `ModelInfo` row onto a Dash {@link ClaudeModelEntry} (skip
 * unusable rows). Lives here so both the boot probe (index.ts) and the live
 * session observation (agent.ts) project rows through ONE mapping.
 */
export function modelEntryFromSdk(raw: unknown): ClaudeModelEntry[] {
  if (raw === null || typeof raw !== "object") return [];
  const m = raw as Record<string, unknown>;
  const id = typeof m.value === "string" && m.value !== "" ? m.value : undefined;
  if (id === undefined) return [];
  const label = typeof m.displayName === "string" && m.displayName !== "" ? m.displayName : id;
  // The alias's canonical wire id is appended to the description, never the
  // id itself: the picker selects by the CLI alias (the wire contract).
  const resolved = typeof m.resolvedModel === "string" && m.resolvedModel !== "" && m.resolvedModel !== id
    ? m.resolvedModel
    : undefined;
  const base = typeof m.description === "string" && m.description !== "" ? m.description : undefined;
  const description = resolved === undefined
    ? base
    : base === undefined
      ? `resolves to ${resolved}`
      : `${base} (resolves to ${resolved})`;
  // `supportedEffortLevels` → adapter reasoning efforts (omp thinking.efforts
  // parity); the CLI names no per-model default, so none is invented.
  const levels = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : [];
  const efforts: string[] = [];
  for (const level of levels) {
    if (typeof level === "string" && level !== "" && !efforts.includes(level)) efforts.push(level);
  }
  return [{
    id,
    label,
    ...(description === undefined ? {} : { description }),
    ...(efforts.length === 0 ? {} : { reasoningEfforts: Object.freeze(efforts) }),
  }];
}
