/**
 * Antigravity-backed `LlmAdapter` registered on `ctx.llm` by the Agy provider.
 * Catalog is STATIC (models.ts): the SDK has no model-list API and the CLI
 * catalog path is auth-gated (dev-rules §16a), so every surface is synchronous.
 * `stream` is never dispatched — the Antigravity agent owns generation through
 * its bridge child (`AgyAgent`); it throws rather than fabricating a wire route.
 */
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { AGY_MODEL_CATALOG } from "./models.js";

export const AGY_PROVIDER_ID = "agy";

export class AgyLlmAdapter extends LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider === AGY_PROVIDER_ID ? "Google" : provider };
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return AGY_MODEL_CATALOG.map((model) => ({
      provider,
      id: model.slug,
      name: model.label,
    }));
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const found = AGY_MODEL_CATALOG.find((candidate) => candidate.slug === model);
    if (found === undefined) {
      throw new LlmError(`Agy provider "${provider}" does not serve model "${model}"`, "MODEL_NOT_FOUND");
    }
    return {
      provider,
      id: found.slug,
      name: found.label,
      ...(found.efforts === undefined ? {} : {
        reasoning: {
          efforts: found.efforts.map((level) => ({ id: ReasoningEffortId(level), name: level })),
          ...(found.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(found.defaultEffort) }),
        },
      }),
    };
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError("the Agy adapter does not stream: Antigravity owns generation through its bridge agent", "UNSUPPORTED_STREAM");
  }
}
