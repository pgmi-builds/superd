/**
 * models — the shared pi ModelRuntime seam and the memoized model catalog.
 *
 * ONE ModelRuntime per process (the SDK's app-level model/auth service: it
 * reads the native `~/.pi/agent` tree — auth.json, models-store.json,
 * models.json — so user-configured providers work identically; the
 * 2026-09-17 native-home ruling means we do NOT redirect any of it). The
 * runtime is injectable (`setPiModelRuntimeFactory`) so tests never load the
 * real SDK.
 *
 * The catalog memo fills on `warmPiCatalog()` (provider boot calls it once,
 * fire-and-forget); `readPiModelCatalog()` is a synchronous memo read for
 * the call sites codex served from a sync disk read (route pinning, default
 * model push). Cold → empty models + `defaultSelection: undefined`, with
 * codex's placeholder-omit semantics at the call sites (nothing is invented
 * and no placeholder value ever leaves this module).
 *
 * Model identity (omp parity, 2026-09-17 parity fixes): every entry carries
 * its REAL pi provider slug (`deepseek`, `zai`, …) plus the BARE model id,
 * and the picker groups by the distinct slug routes this adapter registers
 * after the warm (`piProviderIds` → registration `handle.replace`). Model
 * ids therefore never collide across providers and no umbrella re-branding
 * collapses them into one "Pi" group. `PI_PROVIDER_ID` survives only as the
 * boot placeholder route (`registerAdapter` must not be empty) and in the
 * legacy split path: selections stored before the split arrive as
 * `<provider>/<modelId>` composites under the umbrella route, which
 * `splitCatalogId` (FIRST slash) still resolves.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The BOOT placeholder route: `registerAdapter` must not be empty, so the
 * provider registers this single route at boot and atomically swaps it for
 * the real per-provider slugs once the catalog is warm. No selection can be
 * made under it (the cold catalog lists nothing).
 */
export const PI_PROVIDER_ID = "pi";

/** Structural slice of the SDK ModelRuntime this adapter consumes. */
export interface PiModelRuntimeLike {
  /** Models with valid authentication configured. */
  getAvailable(): Promise<unknown[]>;
  /** Find any registered model by provider/id (including custom models). */
  getModel(provider: string, modelId: string): unknown | undefined;
}

export type PiModelRuntimeFactory = () => Promise<PiModelRuntimeLike>;

/** Default factory: the real SDK's ModelRuntime (dynamic import, cached). */
let runtimeFactory: PiModelRuntimeFactory = async () => {
  const sdk = (await import("@earendil-works/pi-coding-agent")) as unknown as {
    ModelRuntime: { create(options?: unknown): Promise<PiModelRuntimeLike> };
  };
  return sdk.ModelRuntime.create();
};

/** Replace the runtime factory (tests inject a fake). */
export function setPiModelRuntimeFactory(factory: PiModelRuntimeFactory): void {
  runtimeFactory = factory;
  runtimePromise = undefined;
}

let runtimePromise: Promise<PiModelRuntimeLike> | undefined;

/** The shared ModelRuntime (memoized; one per process). */
export function getPiModelRuntime(): Promise<PiModelRuntimeLike> {
  runtimePromise ??= runtimeFactory();
  return runtimePromise;
}

// ---------------------------------------------------------------------------
// Catalog memo
// ---------------------------------------------------------------------------

export interface PiCatalogModel {
  /** BARE model id, unique within `provider` (the composite is `<provider>/<id>`). */
  id: string;
  label: string;
  /** The model's REAL pi provider slug — one picker route per distinct value. */
  provider: string;
  contextWindow?: number;
}

/** One resolved selection: the route pair the runtime and the adapter serve. */
export interface PiSelection {
  provider: string;
  /** Bare model id under `provider`. */
  model: string;
}

export interface PiModelCatalog {
  /** The boot placeholder route (registration identity before the warm swap). */
  provider: "pi";
  providerName: string;
  models: PiCatalogModel[];
  /**
   * pi's settings.json default, when the warmed catalog actually serves it —
   * `undefined` otherwise (call sites OMIT the model so pi's own default
   * applies; codex placeholder semantics without a placeholder value).
   */
  defaultSelection: PiSelection | undefined;
}

let memo: PiCatalogModel[] | undefined;
let warmPromise: Promise<void> | undefined;

/** Split a composite `<provider>/<modelId>` on the FIRST slash; `undefined` when there is none.
 *
 * Legacy path only: pre-split stored selections arrive as composites under
 * the umbrella `pi` route. Real-slug selections pass the bare id (which may
 * itself contain slashes) and must NOT be split here. */
export function splitCatalogId(composite: string): { provider: string; modelId: string } | undefined {
  const slash = composite.indexOf("/");
  if (slash <= 0 || slash === composite.length - 1) return undefined;
  return { provider: composite.slice(0, slash), modelId: composite.slice(slash + 1) };
}

/** One warm pass: `getAvailable()` into the memo. Idempotent in-flight. */
export function warmPiCatalog(): Promise<void> {
  warmPromise ??= (async () => {
    const runtime = await getPiModelRuntime();
    const available = (await runtime.getAvailable()) as Array<Record<string, unknown>>;
    const models: PiCatalogModel[] = [];
    for (const raw of available) {
      const provider = typeof raw["provider"] === "string" ? raw["provider"] : "";
      const id = typeof raw["id"] === "string" ? raw["id"] : "";
      if (provider === "" || id === "") continue;
      models.push({
        id,
        label: typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : id,
        provider,
        ...(typeof raw["contextWindow"] === "number" && (raw["contextWindow"] as number) > 0
          ? { contextWindow: raw["contextWindow"] as number }
          : {}),
      });
    }
    memo = models;
  })();
  return warmPromise;
}

/**
 * The pi CLI's default-model facts: `settings.json` in the agent dir
 * (`defaultProvider` + `defaultModel`). The agent dir resolution mirrors the
 * SDK (`PI_CODING_AGENT_DIR` → `~/.pi/agent`) without importing the SDK on
 * this synchronous path. Fail-soft: unreadable settings contribute nothing.
 */
function settingsDefault(): { provider: string; modelId: string } | undefined {
  const env = process.env.PI_CODING_AGENT_DIR;
  const agentDir = env !== undefined && env.trim() !== "" ? env : join(homedir(), ".pi", "agent");
  const path = join(agentDir, "settings.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const provider = typeof parsed["defaultProvider"] === "string" ? parsed["defaultProvider"] : "";
    const modelId = typeof parsed["defaultModel"] === "string" ? parsed["defaultModel"] : "";
    if (provider === "" || modelId === "") return undefined;
    return { provider, modelId };
  } catch {
    return undefined;
  }
}

/**
 * Synchronous catalog read. `defaultSelection` is the settings default only
 * when it is actually served by the warmed catalog; otherwise `undefined`
 * (call sites OMIT the model so pi's own default applies).
 */
export function readPiModelCatalog(): PiModelCatalog {
  const models = memo ?? [];
  const wanted = settingsDefault();
  const served =
    wanted !== undefined && models.some((model) => model.provider === wanted.provider && model.id === wanted.modelId);
  return {
    provider: PI_PROVIDER_ID,
    providerName: "Pi",
    models,
    defaultSelection: served && wanted !== undefined ? { provider: wanted.provider, model: wanted.modelId } : undefined,
  };
}

/**
 * The distinct provider slugs across the catalog — the picker routes this
 * adapter registers. omp's ordering pattern: the operator-wired provider
 * leads (for pi that is settings.json `defaultProvider`, the pi CLI's own
 * default-model role), everything else follows alphabetically.
 */
export function piProviderIds(models: PiCatalogModel[] = readPiModelCatalog().models): string[] {
  const seen = new Set<string>();
  for (const model of models) seen.add(model.provider);
  const ordered: string[] = [];
  const preferred = settingsDefault()?.provider ?? "";
  if (preferred !== "" && seen.has(preferred)) ordered.push(preferred);
  for (const provider of [...seen].sort((a, b) => a.localeCompare(b))) {
    if (!ordered.includes(provider)) ordered.push(provider);
  }
  return ordered;
}

/** Human-readable provider name for `LlmProviderInfo.name` (omp pattern). */
const PROVIDER_TITLES: Record<string, string> = {
  zai: "Z.AI",
  xai: "xAI",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  moonshot: "Moonshot AI",
};

export function providerDisplayName(provider: string): string {
  return PROVIDER_TITLES[provider] ?? (provider.charAt(0).toUpperCase() + provider.slice(1));
}

/**
 * Resolve a stored/observed model selection into the real route pair.
 * Handles both shapes: a real-slug pair (`provider` = a catalog slug,
 * `model` = the bare id, which may itself contain slashes) passes through
 * untouched; a LEGACY composite rides the umbrella `pi` route with
 * `<provider>/<modelId>` as the model and is split once. A warm catalog is
 * the truth source: an unserved pair degrades to `undefined` so call sites
 * omit the model (pi's own default applies) instead of forwarding a value
 * the runtime would silently refuse.
 */
export function resolvePiSelection(provider: string | undefined, model: string | undefined): PiSelection | undefined {
  if (typeof model !== "string" || model === "") return undefined;
  let resolved: PiSelection;
  if (provider === undefined || provider === "" || provider === PI_PROVIDER_ID) {
    const split = splitCatalogId(model);
    resolved = split !== undefined ? { provider: split.provider, model: split.modelId } : { provider: provider ?? "", model };
  } else {
    resolved = { provider, model };
  }
  if (resolved.provider === "" || resolved.model === "") return undefined;
  const memoed = memo;
  if (memoed !== undefined && memoed.length > 0 && !memoed.some((m) => m.provider === resolved.provider && m.id === resolved.model)) {
    return undefined;
  }
  return resolved;
}

/** Test hygiene: drop the memo and the runtime singleton. */
export function clearPiCatalogForTests(): void {
  memo = undefined;
  warmPromise = undefined;
  runtimePromise = undefined;
}
