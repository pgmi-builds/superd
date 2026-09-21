/**
 * The `agentPreset` session projection, owned by the adapter.
 *
 * Upstream registers this fold from the `dsh-agent-presets` package, which
 * the bundle patch disables (the claude provider replaces preset composition
 * wholesale). But the Web UI depends on the projection regardless: the
 * preset hero chip renders only when `session.projectionValues.agentPreset`
 * resolves, and the session-header label reads it too. Without a registrant
 * the projection is absent for every adapter session and both surfaces stay
 * blank — roster or no roster (the omp line's "no mode" bug, re-observed as
 * the claude "degraded preset" finding).
 *
 * Same fold as upstream; adapter-claude is single-preset: default every
 * session to "claude" so the header chip resolves for sessions whose log
 * carries no `agent-preset/selected` event yet. Registered under the
 * provider's own fiber via `ctx.inject(['sessionProjections'])`.
 */
import { z } from "zod";
// Type-only: pulls the SessionProjectionStateMap/SessionProjectionMap
// `agentPreset` key augmentations into this program's view.
import type { } from "@deepseek-ai/dsh-agent-presets/types";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";

const agentPresetSchema = z.union([z.string(), z.null()]);

/** Current Session preset, initialized from its header and advanced by selection events. */
export const claudeAgentPresetProjection = {
  key: "agentPreset",
  stateSchema: agentPresetSchema,
  init: (header) => (header as { agentPreset?: string }).agentPreset ?? "claude",
  apply: (state, event) =>
    event.type === "agent-preset/selected"
      ? (event.data as { agentPreset: string }).agentPreset
      : state,
  wire: { viewSchema: agentPresetSchema, view: (state) => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<"agentPreset", string | null>;
