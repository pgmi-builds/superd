/**
 * The `agentPreset` session projection, owned by the adapter.
 *
 * Upstream registers this fold from the `dsh-agent-presets` package, which our
 * patch disables (the Antigravity provider replaces preset composition
 * wholesale). But the Web UI depends on the projection regardless: the preset
 * hero chip renders only when `session.projectionValues.agentPreset` resolves
 * (presetOf in ui-agent-preset/seat-store.ts), and the session-header label
 * reads it too. Without a registrant the projection is absent for every
 * adapter session and both surfaces stay blank — roster or no roster.
 *
 * Same fold as upstream (packages/preset/agent-presets/src/session.ts):
 * initialized from the creation header, advanced by `agent-preset/selected`
 * events, which this adapter synthesizes (`"agy"`) on every session it
 * prepares. Registered under the provider's own fiber via
 * `ctx.inject(['sessionProjections'])`, so the key lives exactly as long as
 * the provider is mounted.
 */
import { z } from "zod";
// Type-only: pulls the SessionProjectionStateMap/SessionProjectionMap
// `agentPreset` key augmentations into this program's view.
import type { } from "@deepseek-ai/dsh-agent-presets/types";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";

const agentPresetSchema = z.union([z.string(), z.null()]);

/** Current Session preset, initialized from its header and advanced by selection events. */
export const agyAgentPresetProjection = {
  key: "agentPreset",
  stateSchema: agentPresetSchema,
  // adapter-agy is single-preset: default every session to "agy" so the
  // header chip resolves for scan-native (never-resumed) sessions too.
  init: (header) => (header as { agentPreset?: string }).agentPreset ?? "agy",
  apply: (state, event) =>
    event.type === "agent-preset/selected"
      ? (event.data as { agentPreset: string }).agentPreset
      : state,
  wire: { viewSchema: agentPresetSchema, view: (state) => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<"agentPreset", string | null>;
