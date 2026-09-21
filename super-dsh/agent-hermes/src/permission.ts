/**
 * Hermes permission / approval mapping.
 *
 * Hermes approval is RUNTIME (gateway `approval.request` events → Dash
 * `ctx.approval.request()` → `approval.respond`), so there is NO launch-only
 * approval flag to map — the codex 3-preset → `--approval-mode` table is
 * deliberately gone. What survives:
 *
 * - the Dash preset NAME vocabulary (`isPresetName`) — the session's
 *   permission preset is a Dash-side fact recorded in the identity map
 *   (`dsh-sessions.json`) for display/resume purposes, never a launch flag;
 * - `defaultPermissionPreset` / `presetFromEvents` — unchanged readers over
 *   the permission service and the session log (record-only);
 * - `envApprovalMode` — reads `HERMES_APPROVAL_MODE` (headless runs pin the
 *   record without composing a preset default), accepting only a known preset
 *   name; an invalid value is IGNORED;
 * - `approvalChoiceFromOutcome` — the NEW pure mapping from a Dash approval
 *   outcome to the gateway's `approval.respond` choice. `allowed-once` grants
 *   one run; `allowed-always` grants persistently ONLY when the gateway's
 *   pending approval offered an "always" choice; everything else (rejected /
 *   cancelled / unavailable / unknown) fails closed to `deny`.
 *
 * The preset is a Dash-side session fact Hermes never records itself; it rides
 * the session log (`permission/preset` / `sandbox/mode` events this module
 * narrows) and the identity map, never the Hermes runtime tree.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { GatewayApprovalChoice } from "./hermes-client.js";

/** The Dash preset table (mirrors the base bundle's permission plugin config). */
const PRESETS = {
  "danger-full-access": true,
  "workspace-write": true,
  "read-only": true,
} as const;

/**
 * The one permission event key this module reads that the locally-resolved
 * dsh-session build does not know (upstream declares it in dsh-permission-presets,
 * whose types this project does not reference). Mirrored verbatim so
 * `SessionEvent` narrows for `presetFromEvents`.
 */
declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "permission/preset": { preset: string };
  }
}

type PresetName = keyof typeof PRESETS;

/** Narrow an untrusted value to a known preset name. */
export function isPresetName(raw: unknown): raw is PresetName {
  return typeof raw === "string" && Object.hasOwn(PRESETS, raw);
}

/**
 * `HERMES_APPROVAL_MODE` when it names a Dash permission preset, else
 * undefined. Record-only (no launch flag exists on the runtime-approval line);
 * an invalid value is IGNORED.
 */
export function envApprovalMode(): string | undefined {
  const raw = process.env.HERMES_APPROVAL_MODE;
  return raw !== undefined && isPresetName(raw) ? raw : undefined;
}

/** The slice of `ctx.permissionPresets` the provider reads. */
interface PermissionPresetsSlice {
  defaultPreset: string;
}

/**
 * The default preset for FUTURE sessions, as the permission service
 * resolves it (settings-backed; the profile patch pins the base default).
 * Undefined when the service is absent or its getter fails.
 */
export function defaultPermissionPreset(ctx: Context): string | undefined {
  const service = ctx.get("permissionPresets") as PermissionPresetsSlice | undefined;
  if (service === undefined) return undefined;
  try {
    const preset = service.defaultPreset;
    return isPresetName(preset) ? preset : undefined;
  } catch {
    return undefined;
  }
}

/** The session's effective preset: the last `permission/preset` event. */
export function presetFromEvents(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "permission/preset" && isPresetName(event.data?.preset)) return event.data.preset;
  }
  return undefined;
}

/**
 * Map a Dash approval outcome onto the gateway's `approval.respond` choice.
 * Pure: no service, no I/O. `allowed-once` grants exactly one run; an
 * `allowed-always` grant maps to `"always"` ONLY when the pending approval
 * offered that choice (`options` = the gateway's `choices` array); any other
 * outcome — rejected / cancelled / unavailable / an unknown value — fails
 * closed to `"deny"`.
 */
export function approvalChoiceFromOutcome(outcome: unknown, options?: readonly string[]): GatewayApprovalChoice {
  if (outcome === "allowed-once") return "once";
  if (outcome === "allowed-always" && options !== undefined && options.includes("always")) return "always";
  return "deny";
}
