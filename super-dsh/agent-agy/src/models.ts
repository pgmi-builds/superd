/**
 * Static model catalog for the Gemini consumer surface. The google-antigravity
 * SDK has no model-list API and the CLI catalog path is auth-gated, so the
 * catalog is static AND endpoint-verified (2026-09-18 probes on both auth
 * planes; non-listed slugs 404 / are retired).
 *
 * Model ids are PLAIN slugs — thinking effort is a per-route option surfaced
 * through the adapter's reasoning metadata (WebUI Effort selector →
 * AgentOptions.reasoningEffort), NOT extra catalog entries (user ruling
 * 2026-09-18).
 */

export interface AgyCatalogModel {
  slug: string;
  label: string;
  /** Effort levels the CLI/SDK accept for this slug (absent = no effort param). */
  efforts?: readonly string[];
  defaultEffort?: string;
}

export const AGY_MODEL_CATALOG: readonly AgyCatalogModel[] = [
  { slug: "gemini-3.7-flash", label: "Gemini 3.7 Flash", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { slug: "gemini-3.6-flash", label: "Gemini 3.6 Flash", efforts: ["low", "medium", "high"], defaultEffort: "low" },
  { slug: "gemini-3.5-flash", label: "Gemini 3.5 Flash", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { slug: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { slug: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
];

/** Selectable model ids (plain slugs). */
export function modelIds(): string[] {
  return AGY_MODEL_CATALOG.map((m) => m.slug);
}

export function catalogSlugs(): string[] {
  return modelIds();
}

/** Parse a selectable model id: plain slug, or legacy `slug@level`. */
export function parseModelId(id: string | undefined): { slug: string; thinkingLevel?: string } | undefined {
  if (id === undefined) return undefined;
  const at = id.indexOf("@");
  const slug = at < 0 ? id : id.slice(0, at);
  if (!catalogSlugs().includes(slug)) return undefined;
  if (at < 0) return { slug };
  const level = id.slice(at + 1);
  const entry = AGY_MODEL_CATALOG.find((m) => m.slug === slug);
  if (entry?.efforts && entry.efforts.includes(level)) return { slug, thinkingLevel: level };
  return { slug };
}

/** Efforts for a slug (undefined = the slug takes no effort parameter). */
export function effortsFor(slug: string): readonly string[] | undefined {
  return AGY_MODEL_CATALOG.find((m) => m.slug === slug)?.efforts;
}

export function defaultEffortFor(slug: string): string | undefined {
  return AGY_MODEL_CATALOG.find((m) => m.slug === slug)?.defaultEffort;
}

/** Cheapest live pair on the CLI key path (probed 2026-09-18). CLI default. */
export const CLI_DEFAULT_MODEL: { slug: string; thinkingLevel: string } = {
  slug: "gemini-3.6-flash",
  thinkingLevel: "low",
};

/**
 * Normalize a model reference to an SDK-facing slug. The native TUI settings
 * store display names ("Gemini 3.7 Flash (Medium)"); slugs pass through;
 * unknown display names → undefined (caller uses the catalog head).
 */
export function toModelSlug(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const v = model.trim();
  if (!v) return undefined;
  if (/^[a-z0-9.-]+$/.test(v) && !v.includes(" ")) return v;
  const base = v.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
  const slug = base.replace(/\s+/g, "-");
  if (catalogSlugs().includes(slug)) return slug;
  if (/^gemini-[0-9]/.test(slug)) return slug;
  return undefined;
}
