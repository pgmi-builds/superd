/**
 * Hermes model catalog for the Dash model selector (AW-H Task 5).
 *
 * Source of truth is the gateway `model.options` RPC (247ms-3.3s live — it
 * probes providers), field-name authority = the Task 1 LIVE capture in
 * `test/fixtures/gateway-rpc-samples.json`:
 *
 * - top level `{ providers: [<row>...], model: "<current default id>",
 *   provider: "<current provider slug>" }` — the default lives in the top-level
 *   strings, NOT inside the provider rows;
 * - provider row `{ slug, name, is_current, is_user_defined,
 *   models: [<plain id string>...], total_models, source, authenticated,
 *   capabilities: {"<model-id>": {fast, reasoning, can_disable_reasoning}},
 *   featured_models, aliases? }` — model entries are plain id strings, and the
 *   current provider's row carries `is_current: true`.
 *
 * `id` is the verbatim selection string — directly consumable by
 * `session.create {model}` and `command.dispatch "/model <id>"`. Capabilities
 * carry no context-window hints (Task 1 §3⑦), so `contextWindow` is left unset
 * rather than invented (Task 7's route metadata treats it as optional).
 *
 * Fail-soft everywhere: a missing client, a failing RPC, or a garbage response
 * degrade to the empty catalog `{ provider: "Hermes", models: [],
 * defaultModel: undefined }` — never a throw. `defaultModel: undefined` is the
 * explicit skip signal so Task 7 never pushes a placeholder default outward
 * (dev-rules: 占位值禁止外流).
 *
 * Trim rules (2026-09-17 parity ruling, recorded per dev-rules §12), applied
 * at mapping time so every downstream consumer (per-slug routes, route
 * pinning, the default-model push) sees the same trimmed projection:
 *
 * 1. `source: "virtual"` rows are dropped (the `moa` Mixture-of-Agents
 *    synthesizer is not a selectable endpoint).
 * 2. Mirrored endpoints whose model-id SETS are identical collapse onto one
 *    row (e.g. `copilot` vs `copilot-acp`, `zai-plan` vs `zhipu`) — the first
 *    row in gateway order wins, except a later mirrored row flagged
 *    `is_current` displaces a non-current earlier one (the r4 dedupe
 *    preference applied to whole rows). The id, not the endpoint, is the
 *    selection contract, so a mirror is just a second name for the same ids.
 * 3. Endpoints listing more than 50 models are reordered: `featured_models`
 *    first (gateway order), then the remainder alphabetically. Small rows
 *    keep the gateway's own order untouched.
 *
 * The `authenticated !== true` filter predates this ruling and is unchanged.
 *
 * Row `name`s survive in `HermesCatalog.providerNames` so the synchronous
 * `providerInfo(slug)` surface can serve the gateway's human label; a
 * module-level last-known cache (written on every successful fetch) keeps
 * those names available before and between fetches, with a capitalized-slug
 * fallback (`hermesProviderDisplayName`).
 *
 * Cache: the catalog is an async/expensive source, so reads go through a
 * module-level in-process cache with a TTL (single-world posture — keyed on
 * nothing, deliberately not on the client instance). Task 7's probe strategy
 * (spawn a dedicated probe client → `model.options` → close it) therefore
 * works: the first fetch populates the cache and later client-less calls are
 * served from it until the TTL expires. Only non-empty successful catalogs are
 * cached — failures and garbage are retried on the next call. Concurrent
 * callers share one in-flight fetch (single-flight).
 */

/** One Dash-facing model entry. */
export interface HermesCatalogEntry {
  /** The verbatim model selection string (`"/model <id>"`, `session.create {model}`). */
  readonly id: string;
  /** Display label: the id, plus trivially-available capability hints. */
  readonly label: string;
  /** The provider row's `slug` this model was listed under. */
  readonly provider: string;
  /** Context window in tokens. Never set today — the gateway advertises none. */
  readonly contextWindow?: number;
}

/** The resolved catalog projection. Immutable by convention — treat as read-only. */
export interface HermesCatalog {
  /** Current provider slug (top-level `provider`), or `"Hermes"` when unknown. */
  readonly provider: string;
  /** All servable models across included provider rows, in response order. */
  readonly models: readonly HermesCatalogEntry[];
  /**
   * The gateway's current model (top-level `model`), verbatim. `undefined`
   * when unavailable — the placeholder-skip signal (never a fabricated id).
   */
  readonly defaultModel: string | undefined;
  /**
   * Human row names by slug for the rows that survived the trims (`row.name`).
   * Slugs without a usable gateway name string are absent — the reader falls
   * back to the capitalized slug.
   */
  readonly providerNames: { readonly [slug: string]: string };
}

/** The minimal probe-client surface this module consumes (structural). */
export interface HermesModelOptionsClient {
  modelOptions(): Promise<unknown>;
}

/** Read options. */
export interface ReadHermesModelCatalogOptions {
  /**
   * Cache TTL override in ms. Default 5 minutes; a non-positive value
   * bypasses the cache entirely for that call (no read, no write).
   */
  readonly ttlMs?: number;
}

/** Default cache TTL: 5 minutes. */
export const HERMES_MODEL_CATALOG_DEFAULT_TTL_MS = 5 * 60_000;

/** The fail-soft brand shown when the real provider slug is unavailable. */
const FALLBACK_PROVIDER = "Hermes";

/** A fresh empty catalog. Never shared — callers get their own object. */
function emptyCatalog(): HermesCatalog {
  return { provider: FALLBACK_PROVIDER, models: [], defaultModel: undefined, providerNames: {} };
}

/** True when the capability record says the model is fast. */
function capFast(cap: unknown): boolean {
  return cap !== null && typeof cap === "object" && !Array.isArray(cap) && (cap as Record<string, unknown>)["fast"] === true;
}

/** True when the capability record says the model reasons. */
function capReasoning(cap: unknown): boolean {
  return (
    cap !== null &&
    typeof cap === "object" &&
    !Array.isArray(cap) &&
    (cap as Record<string, unknown>)["reasoning"] === true
  );
}

/** Label = the id plus capability hints when they are trivially available. */
function labelFor(id: string, cap: unknown): string {
  const hints: string[] = [];
  if (capFast(cap)) hints.push("fast");
  if (capReasoning(cap)) hints.push("reasoning");
  return hints.length === 0 ? id : `${id} (${hints.join(", ")})`;
}

/** Dedupe bookkeeping: an id's emitted index and whether its source row was current. */
interface SeenEntry {
  readonly index: number;
  readonly isCurrent: boolean;
}

/** Endpoints with more models than this are reordered featured-first (trim 3). */
export const HERMES_FEATURED_REORDER_MIN_MODELS = 50;

/** One provider row that passed every trim/filter, ready to append. */
interface PreparedRow {
  readonly slug: string;
  /** The row's human `name`, when the gateway supplied a usable string. */
  readonly name: string | undefined;
  readonly isCurrent: boolean;
  /** The row's `capabilities` map (model id → hints), when well-formed. */
  readonly caps: Record<string, unknown> | undefined;
  /** Sanitized model ids, trim-ordered (featured-first for large rows). */
  readonly ids: string[];
  /** Mirror-group key: the row's id SET (sorted, joined). */
  readonly mirrorKey: string;
}

/** The row's model ids, strings only, gateway order preserved. */
function sanitizeIds(models: readonly unknown[]): string[] {
  return models.filter((id): id is string => typeof id === "string" && id !== "");
}

/**
 * Trim 3: for large endpoints (> {@link HERMES_FEATURED_REORDER_MIN_MODELS}
 * models) put the gateway's `featured_models` first (their own order), then
 * the remaining ids alphabetically. Smaller rows keep gateway order.
 */
function orderFeaturedFirst(ids: string[], featured: unknown): string[] {
  if (ids.length <= HERMES_FEATURED_REORDER_MIN_MODELS || !Array.isArray(featured)) return ids;
  const featuredIds = featured.filter(
    (id): id is string => typeof id === "string" && id !== "" && ids.includes(id),
  );
  const seen = new Set(featuredIds);
  const rest = ids.filter((id) => !seen.has(id)).sort((a, b) => a.localeCompare(b));
  return [...featuredIds, ...rest];
}

/**
 * Validate one provider row against the servability filter and the trims.
 * Returns `undefined` when the row is dropped: malformed, unauthenticated,
 * `source: "virtual"` (trim 1). Mirror collapse (trim 2) happens AFTER this
 * per-row preparation — it needs each candidate's id set, and the winner is
 * chosen at the group level in mapHermesModelOptions.
 */
function prepareRow(row: unknown): PreparedRow | undefined {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
  const raw = row as Record<string, unknown>;
  const slug = raw["slug"];
  if (typeof slug !== "string" || slug === "") return undefined;
  if (raw["source"] === "virtual") return undefined; // trim 1: virtual synthesizers are not selectable
  const authenticated = raw["authenticated"];
  const isCurrent = raw["is_current"] === true;
  if (authenticated !== true && !(isCurrent && authenticated === undefined)) return;
  const models = raw["models"];
  if (!Array.isArray(models)) return undefined;
  const ids = orderFeaturedFirst(sanitizeIds(models), raw["featured_models"]);
  if (ids.length === 0) return undefined;
  const name = raw["name"];
  const capabilities = raw["capabilities"];
  return {
    slug,
    name: typeof name === "string" && name !== "" ? name : undefined,
    isCurrent,
    caps:
      capabilities !== null && typeof capabilities === "object" && !Array.isArray(capabilities)
        ? (capabilities as Record<string, unknown>)
        : undefined,
    ids,
    mirrorKey: [...ids].sort().join("\u0000"),
  };
}

/**
 * Append one prepared row's entries onto `out`.
 *
 * Dedupe (r4, unchanged): the id is the VERBATIM gateway selection string
 * (`session.create {model}` / `/model <id>` consume it as-is) — never
 * provider-prefixed — so the same id listed under several slugs collapses
 * onto ONE canonical entry, preferring the `is_current` row, else the first
 * surviving row in the gateway's own order. The `seen` map records each id's
 * emitted index + whether its source was current, so a current-row duplicate
 * REPLACES an earlier non-current entry in place (order preserved).
 */
function appendPrepared(prepared: PreparedRow, out: HermesCatalogEntry[], seen: Map<string, SeenEntry>): void {
  for (const id of prepared.ids) {
    const entry: HermesCatalogEntry = {
      id,
      label: labelFor(id, prepared.caps === undefined ? undefined : prepared.caps[id]),
      provider: prepared.slug,
      // contextWindow intentionally never set: the gateway's capability hints
      // carry no context windows (Task 1 §3⑦) — values would be invented.
    };
    const existing = seen.get(id);
    if (existing === undefined) {
      seen.set(id, { index: out.length, isCurrent: prepared.isCurrent });
      out.push(entry);
    } else if (prepared.isCurrent && !existing.isCurrent) {
      // current-provider row wins the duplicate — replace in place (order preserved)
      out[existing.index] = entry;
      seen.set(id, { index: existing.index, isCurrent: true });
    }
    // else: later duplicate from a non-current (or already-current) row → dropped.
  }
}

/**
 * Pure mapping from a `model.options` response to the catalog. Total and
 * fail-soft: any shape degrades toward the empty catalog, never throws.
 * Exported so tests (and Task 7, if it ever holds a raw response) can map
 * without touching the cache.
 */
export function mapHermesModelOptions(response: unknown): HermesCatalog {
  if (response === null || typeof response !== "object" || Array.isArray(response)) return emptyCatalog();
  const raw = response as Record<string, unknown>;
  const entries: HermesCatalogEntry[] = [];
  const seen = new Map<string, SeenEntry>();
  const providerNames: Record<string, string> = {};
  const providers = raw["providers"];
  if (Array.isArray(providers)) {
    // Trim 2 (mirror collapse): group prepared rows by their id SET; the
    // first row of each group survives in gateway order, unless a later
    // mirrored row is `is_current` and displaces a non-current winner.
    const byMirrorKey = new Map<string, PreparedRow>();
    const ordered: PreparedRow[] = [];
    for (const candidate of providers) {
      const prepared = prepareRow(candidate);
      if (prepared === undefined) continue;
      const existing = byMirrorKey.get(prepared.mirrorKey);
      if (existing === undefined) {
        byMirrorKey.set(prepared.mirrorKey, prepared);
        ordered.push(prepared);
      } else if (prepared.isCurrent && !existing.isCurrent) {
        ordered.splice(ordered.indexOf(existing), 1, prepared);
        byMirrorKey.set(prepared.mirrorKey, prepared);
      }
    }
    for (const prepared of ordered) {
      appendPrepared(prepared, entries, seen);
      if (prepared.name !== undefined) providerNames[prepared.slug] = prepared.name;
    }
  }
  const model = raw["model"];
  const provider = raw["provider"];
  return {
    provider: typeof provider === "string" && provider !== "" ? provider : FALLBACK_PROVIDER,
    models: entries,
    defaultModel: typeof model === "string" && model !== "" ? model : undefined,
    providerNames,
  };
}

/** In-process cache state (single-world: one entry, keyed on nothing). */
interface CatalogCacheEntry {
  readonly value: HermesCatalog;
  readonly expiresAt: number;
}

let cached: CatalogCacheEntry | null = null;
let inflight: Promise<HermesCatalog> | null = null;

/** Test seam (the codex `setCodexFactory` pattern): drop the cached catalog and any in-flight fetch. */
export function resetHermesModelCatalogCache(): void {
  cached = null;
  inflight = null;
  resetHermesProviderInfoCache();
}

/**
 * Last-known provider display names (module-level, single-world posture):
 * every successful non-empty fetch rewrites this, so the SYNCHRONOUS
 * `providerInfo(slug)` surface can serve the gateway's human row names
 * before and between async fetches (the catalog itself is only reachable
 * through an await). `hermesProviderDisplayName` falls back to the
 * capitalized slug before the first fetch or for slugs the gateway never
 * named.
 */
let lastKnownProviderNames: { readonly [slug: string]: string } = {};

/**
 * Human display name for a provider slug: the last-known gateway row name
 * when one was fetched, else the capitalized slug (`openrouter` →
 * `Openrouter`). Synchronous by contract (`LlmAdapter.providerInfo`).
 */
export function hermesProviderDisplayName(slug: string): string {
  const known = lastKnownProviderNames[slug];
  if (typeof known === "string" && known !== "") return known;
  return slug === "" ? FALLBACK_PROVIDER : slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** Test seam: drop the last-known provider display names. */
export function resetHermesProviderInfoCache(): void {
  lastKnownProviderNames = {};
}

/** Learn the fetched catalog's row names (successful non-empty fetches only). */
function rememberProviderNames(catalog: HermesCatalog): void {
  if (Object.keys(catalog.providerNames).length > 0) lastKnownProviderNames = catalog.providerNames;
}

/**
 * The distinct provider slugs of a catalog, gateway row order preserved —
 * the `handle.replace` route set for the per-slug registration (2026-09-17
 * parity ruling). Order is the gateway's own, so the selector lists groups
 * the way the gateway ranks them.
 */
export function hermesProviderSlugs(catalog: HermesCatalog): string[] {
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const entry of catalog.models) {
    if (seen.has(entry.provider)) continue;
    seen.add(entry.provider);
    slugs.push(entry.provider);
  }
  return slugs;
}


/**
 * Read the Hermes model catalog (async — the source is a gateway RPC).
 *
 * - fresh cache → served, even when `client` is omitted (the Task 7
 *   probe-client-then-close pattern);
 * - otherwise `client.modelOptions()` is fetched (single-flight; concurrent
 *   callers share one RPC) and mapped; a non-empty success populates the
 *   cache for `ttlMs` (default 5 min);
 * - missing client / failing RPC / garbage response → the empty catalog
 * (`defaultModel: undefined` = the placeholder-skip signal). Never throws.
 */
export async function readHermesModelCatalog(
  client?: HermesModelOptionsClient,
  options?: ReadHermesModelCatalogOptions,
): Promise<HermesCatalog> {
  const ttlMs = options?.ttlMs ?? HERMES_MODEL_CATALOG_DEFAULT_TTL_MS;
  const useCache = ttlMs > 0;
  if (useCache && cached !== null && cached.expiresAt > Date.now()) return cached.value;
  if (client === undefined) return emptyCatalog();
  if (inflight !== null) return inflight;
  const fetch = (async (): Promise<HermesCatalog> => {
    try {
      const response = await client.modelOptions();
      const catalog = mapHermesModelOptions(response);
      if (catalog.models.length > 0) rememberProviderNames(catalog); // learn row names even when the TTL cache is bypassed
      if (useCache && catalog.models.length > 0) {
        cached = { value: catalog, expiresAt: Date.now() + ttlMs };
      }
      return catalog;
    } catch {
      return emptyCatalog(); // fail-soft; failures are never cached
    } finally {
      inflight = null;
    }
  })();
  inflight = fetch;
  return fetch;
}

