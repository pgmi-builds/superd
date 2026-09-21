/**
 * Hermes-backed `LlmAdapter` registered on `ctx.llm` by the Hermes provider.
 *
 * The browser model selector never touches the Hermes agent directly: it is an
 * RPC round-trip through the apiproxy, which reads `ctx.llm.listProviders /
 * listModels / resolveModel` to build the catalog. This adapter answers those
 * queries from the gateway's live model catalog (`models.ts`: `model.options`
 * RPC, TTL-cached), one route per REAL gateway provider slug (2026-09-17
 * parity ruling) — never the native deepseek-official / pi-ai routes, which
 * the profile disables. The provider boots with the single placeholder route
 * `hermes` and atomically swaps to the distinct slugs once the first catalog
 * probe resolves (`AdapterRegistrationHandle.replace`), so the selector shows
 * real groups (DeepSeek / OpenRouter / …) instead of one ~579-model bucket.
 *
 * The catalog is ASYNC (a gateway RPC), so the adapter is constructed with a
 * `() => Promise<HermesCatalog>` supplier (the provider's memoized
 * probe-client-then-close promise) instead of a home path. `providerInfo` is
 * a synchronous surface, so it serves the last-known gateway row name via
 * the models.ts module cache (capitalized-slug fallback before the first
 * fetch); the async `listModels` / `resolveModel` await the supplier and
 * filter by the entry's own `provider` slug.
 *
 * Model ids stay the VERBATIM gateway selection strings (`session.create
 * {model}` / `/model <id>` consume them as-is); because the r4 dedupe keeps
 * one canonical entry per id, `resolveModel` matches on the (provider, id)
 * pair — a route only ever lists ids that resolve under it.
 *
 * `stream` is never dispatched: Hermes owns generation through its gateway
 * child (`HermesAgent`), so the adapter only serves catalog/metadata queries.
 * It throws rather than fabricating a wire route the harness would misuse.
 */
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { hermesProviderDisplayName, type HermesCatalog } from "./models.js";

/**
 * The boot placeholder route every Hermes model is served under until the
 * first catalog probe resolves and the registration swaps to the real slugs.
 */
export const HERMES_PROVIDER_ID = "hermes";

/** Supplies the memoized (async) Hermes model catalog. */
export type HermesCatalogSupplier = () => Promise<HermesCatalog>;

export class HermesLlmAdapter extends LlmAdapter {
  /**
   * `catalog` = the async catalog supplier — the provider's memoized
   * probe-client-then-close promise, so catalog reads never depend on
   * construction-time context.
   */
  constructor(private readonly catalog: HermesCatalogSupplier) {
    super();
  }

  providerInfo(provider: string): LlmProviderInfo {
    // Synchronous surface: serves the last-known gateway row name (models.ts
    // module cache, written on every successful fetch); capitalized-slug
    // fallback before the first fetch — the placeholder `hermes` route then
    // renders as "Hermes".
    return { id: provider, name: hermesProviderDisplayName(provider) };
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const catalog = await this.catalog();
    return catalog.models
      .filter((model) => model.provider === provider)
      .map((model) => ({
        provider,
        id: model.id,
        name: model.label,
      }));
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const catalog = await this.catalog();
    const found = catalog.models.find((candidate) => candidate.id === model && candidate.provider === provider);
    if (found === undefined) {
      throw new LlmError(`Hermes provider "${provider}" does not serve model "${model}"`, "MODEL_NOT_FOUND");
    }
    return {
      provider,
      id: found.id,
      name: found.label,
      ...(found.contextWindow !== undefined && found.contextWindow > 0 ? { context: { contextWindow: found.contextWindow } } : {}),
    };
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError("the Hermes adapter does not stream: Hermes owns generation through its gateway agent", "UNSUPPORTED_STREAM");
  }
}
