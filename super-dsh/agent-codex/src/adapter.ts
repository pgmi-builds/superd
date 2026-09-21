/**
 * Codex-backed `LlmAdapter` registered on `ctx.llm` by the Codex provider.
 *
 * The browser model selector never touches the Codex agent directly: it is an
 * RPC round-trip through the apiproxy, which reads `ctx.llm.listProviders /
 * listModels / resolveModel` to build the catalog. This adapter answers those
 * queries from the Codex home's real catalog (`models.ts`: config.toml +
 * model_catalog_json) under the single provider route `codex` — never the
 * native deepseek-official / pi-ai routes, which the profile disables.
 *
 * `stream` is never dispatched: Codex owns generation through its SDK thread
 * (`CodexAgent`), so the adapter only serves catalog/metadata queries. It
 * throws rather than fabricating a wire route the harness would misuse.
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
import { readCodexModelCatalog } from "./models.js";
import { useCodexHome } from "./codex-store.js";

/** The one provider route every Codex model is served under. */
export const CODEX_PROVIDER_ID = "codex";

export class CodexLlmAdapter extends LlmAdapter {
  /**
   * `home` = the codex app home — the CLI's native `~/.codex` (2026-09-17
   * home ruling), resolved by the provider via resolveCodexHome() so catalog
   * reads never depend on construction-time context.
   */
  constructor(private readonly home?: string) {
    super();
  }

  providerInfo(_provider: string): LlmProviderInfo {
    return { id: CODEX_PROVIDER_ID, name: readCodexModelCatalog(this.home).provider ?? "Codex" };
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return readCodexModelCatalog(this.home).models.map((model) => ({
      provider: CODEX_PROVIDER_ID,
      id: model.id,
      name: model.label,
    }));
  }

  async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const found = readCodexModelCatalog(this.home).models.find((candidate) => candidate.id === model);
    if (found === undefined) {
      throw new LlmError(`Codex provider "${CODEX_PROVIDER_ID}" does not serve model "${model}"`, "MODEL_NOT_FOUND");
    }
    return {
      provider: CODEX_PROVIDER_ID,
      id: found.id,
      name: found.label,
      ...(found.contextWindow !== undefined && found.contextWindow > 0 ? { context: { contextWindow: found.contextWindow } } : {}),
    };
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError("the Codex adapter does not stream: Codex owns generation through its SDK agent", "UNSUPPORTED_STREAM");
  }
}
