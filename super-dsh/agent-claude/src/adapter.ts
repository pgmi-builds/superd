/**
 * Claude-backed `LlmAdapter` registered on `ctx.llm` by the Claude provider.
 *
 * The browser model selector never touches the Claude agent directly: it is an
 * RPC round-trip through the apiproxy, which reads `ctx.llm.listProviders /
 * listModels / resolveModel` to build the catalog. This adapter answers those
 * queries from the models Claude actually reported (`models.ts`) under the
 * single provider route `claude`.
 *
 * The route id must be `claude`, NOT `claude-code`: the upstream package
 * `@deepseek-ai/dsh-subagent-claude-code` already occupies the subagent
 * provider name `claude-code`, and a world mounting both must not collide.
 *
 * `stream` is never dispatched: Claude owns generation through its own SDK
 * thread, so the adapter only serves catalog/metadata queries. It throws
 * rather than fabricating a wire route the harness would misuse.
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
import { readModelCatalog } from "./models.js";

/** The one provider route every observed Claude model is served under. */
export const CLAUDE_PROVIDER_ID = "claude";

/** Human-readable provider name for selectors and diagnostics. */
const CLAUDE_PROVIDER_NAME = "Claude";

export class ClaudeLlmAdapter extends LlmAdapter {
  providerInfo(_provider: string): LlmProviderInfo {
    return { id: CLAUDE_PROVIDER_ID, name: CLAUDE_PROVIDER_NAME };
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return readModelCatalog().models.map((model) => ({
      provider: CLAUDE_PROVIDER_ID,
      id: model.id,
      name: model.label,
      ...(model.description === undefined ? {} : { description: model.description }),
    }));
  }

  async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const found = readModelCatalog().models.find((candidate) => candidate.id === model);
    if (found === undefined) {
      throw new LlmError(`Claude provider "${CLAUDE_PROVIDER_ID}" does not serve model "${model}"`, "MODEL_NOT_FOUND");
    }
    return {
      provider: CLAUDE_PROVIDER_ID,
      id: found.id,
      name: found.label,
      ...(found.description === undefined ? {} : { description: found.description }),
      // Only a positive window is real metadata: an absent or zero window must
      // never become `context: { contextWindow: 0 }`.
      ...(found.contextWindow !== undefined && found.contextWindow > 0
        ? { context: { contextWindow: found.contextWindow } }
        : {}),
      // The CLI's advertised effort levels become adapter-owned reasoning
      // efforts (omp thinking.efforts parity); the CLI names no default, so
      // none is invented.
      ...(found.reasoningEfforts !== undefined && found.reasoningEfforts.length > 0
        ? { reasoning: { efforts: found.reasoningEfforts.map((effort) => ({ id: ReasoningEffortId(effort), name: effort })) } }
        : {}),
    };
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      "the Claude adapter does not stream: Claude owns generation through its SDK thread",
      "UNSUPPORTED_STREAM",
    );
  }
}
