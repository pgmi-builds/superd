/**
 * Pi-backed `LlmAdapter` registered on `ctx.llm` by the pi provider.
 *
 * The browser model selector never touches the pi agent directly: it is an
 * RPC round-trip through the apiproxy, which reads `ctx.llm.listProviders /
 * listModels / resolveModel` to build the catalog. This adapter answers those
 * queries from the warmed catalog memo (`models.ts`: the shared ModelRuntime's
 * available models). Like omp, it serves REAL per-provider routes: boot
 * registers the single placeholder route `pi` and the provider swaps in the
 * distinct catalog slugs (`piProviderIds` → `handle.replace`) once warm, so
 * the picker groups models under DeepSeek/ZAI/… instead of one flat "Pi"
 * group — never the native deepseek-official / pi-ai routes, which the
 * profile disables.
 *
 * Model ids are the BARE provider-scoped id per route (omp parity: the
 * composite `<provider>/<modelId>` prefix is dropped at the picker boundary;
 * legacy composite selections are split upstream before they reach the
 * runtime). `stream` is never dispatched: pi owns generation through its SDK
 * session (`PiAgent`), so the adapter only serves catalog/metadata queries.
 * It throws rather than fabricating a wire route the harness would misuse.
 */
import {
  LlmAdapter,
  LlmError,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
} from "@deepseek-ai/dsh-llm";
import { PI_PROVIDER_ID, providerDisplayName, readPiModelCatalog } from "./models.js";

export { PI_PROVIDER_ID };

export class PiLlmAdapter extends LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: providerDisplayName(provider) };
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return readPiModelCatalog()
      .models.filter((model) => model.provider === provider)
      .map((model) => ({
        provider,
        id: model.id,
        name: model.label,
      }));
  }

  stream(_options: never): AsyncIterable<never> {
    throw new LlmError("the Pi adapter does not stream: pi owns generation through its SDK agent", "UNSUPPORTED_STREAM");
  }


  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const found = readPiModelCatalog().models.find((candidate) => candidate.provider === provider && candidate.id === model);
    if (found === undefined) {
      throw new LlmError(`Pi provider "${provider}" does not serve model "${model}"`, "MODEL_NOT_FOUND");
    }
    return {
      provider,
      id: found.id,
      name: found.label,
      ...(found.contextWindow !== undefined && found.contextWindow > 0 ? { context: { contextWindow: found.contextWindow } } : {}),
    };
  }
}
