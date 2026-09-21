/**
 * Dash permission preset ↔ Claude Code permission-mode mapping (plan Task 7).
 *
 * Unlike Codex — whose approval policy is a launch-only fact — Claude Code's
 * `PermissionMode` is switchable **at runtime** through
 * `Query.setPermissionMode()`. So this module is not the only resolution point:
 * it publishes the effective Claude mode (the {@link claudeMode} field stamped
 * onto the `permission/preset` event) so the UI and the live
 * `setPermissionMode` call read the same value from one place.
 *
 * Two layers, deliberately distinct:
 *
 * - The DSH **3-preset skeleton** (read-only / workspace-write /
 *   danger-full-access), each a sandbox + approval combination, is what the
 *   host composition configures and what {@link PRESET_TO_CLAUDE} maps onto
 *   three Claude modes.
 * - {@link EXTRA_TIERS} (`plan` / `auto` / `dontAsk`) are **additive** tiers on
 *   top of that skeleton — Claude-only modes with no DSH preset of their own.
 *   They are never folded into `PRESET_TO_CLAUDE` (so `isPresetName` keeps
 *   rejecting them) and they ride the session log only as the `claudeMode`
 *   field; see {@link presetFromEvents}.
 *
 * Module is pure: no Claude SDK import, and the only import is a type-only
 * cordis reference erased at compile time. The preset is a DSH-side session
 * fact, so it lives in the session log via the events
 * {@link permissionEventsFor} stamps.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

/** The DSH 3-way permission skeleton's preset names. */
export type PresetName = "read-only" | "workspace-write" | "danger-full-access";

/**
 * Claude Code's full permission-mode union, exactly as the SDK declares it.
 * The first three are the skeleton's images under {@link PRESET_TO_CLAUDE};
 * the last three are the additive {@link EXTRA_TIERS}.
 */
export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

/**
 * The 3-preset skeleton → Claude mode table. Typed as an exhaustive record, so
 * adding a {@link PresetName} without a mapping is a compile error.
 */
export const PRESET_TO_CLAUDE: Readonly<Record<PresetName, ClaudePermissionMode>> = Object.freeze({
  "read-only": "default",
  "workspace-write": "acceptEdits",
  "danger-full-access": "bypassPermissions",
});

/**
 * Claude-only tiers that sit ON TOP of the skeleton. Ordered as the UI lists
 * them. None of these is a DSH preset name — `Object.values(PRESET_TO_CLAUDE)`
 * must never contain one.
 */
export const EXTRA_TIERS: readonly ["plan", "auto", "dontAsk"] = Object.freeze(["plan", "auto", "dontAsk"] as const);

/**
 * The Dash sandbox + approval each skeleton preset composes (the profile pins
 * the same table in its `permission` row). Claude's own mode rides alongside;
 * these two events are the DSH-side facts the UI folds.
 */
const DSH_SKELETON = {
  "read-only": { sandbox: "read-only", approval: "ask" },
  "workspace-write": { sandbox: "workspace-write", approval: "ask" },
  "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
} as const;

/**
 * The two permission event keys this module reads/synthesizes that the
 * locally-resolved dsh-session build does not know (upstream declares them in
 * dsh-permission-presets / dsh-sandbox-policy, whose types this project does
 * not reference). Mirrored from `agent-codex/src/permission.ts` verbatim so
 * `SessionEvent` narrows; `approval/policy` comes from dsh-user-approval's own
 * augmentation and is reached through the trailing cast.
 */
declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "permission/preset": { preset: string; claudeMode?: ClaudePermissionMode };
    "sandbox/mode": { mode: "read-only" | "workspace-write" | "danger-full-access"; source?: "delegation" };
  }
}

/** Narrow an untrusted value to a known DSH preset name. */
export function isPresetName(raw: unknown): raw is PresetName {
  return typeof raw === "string" && Object.hasOwn(PRESET_TO_CLAUDE, raw);
}

/**
 * Map a DSH preset name **or** an {@link EXTRA_TIERS} tier onto the Claude
 * permission mode it selects. An extra tier is already Claude vocabulary and
 * passes through; anything unknown — including `undefined` — degrades to
 * `"default"`, the most restrictive skeleton mode.
 */
export function claudePermissionMode(preset: string | undefined): ClaudePermissionMode {
  if (preset === "plan" || preset === "auto" || preset === "dontAsk") return preset;
  return isPresetName(preset) ? PRESET_TO_CLAUDE[preset] : "default";
}

/**
 * Inverse of {@link PRESET_TO_CLAUDE}: the DSH skeleton preset whose Claude
 * mode this is, or undefined for the {@link EXTRA_TIERS} (`plan` / `auto` /
 * `dontAsk`) — they are mode-only runtime state with no DSH preset of their
 * own, so a live mode change to one of them must NOT rewrite the recorded
 * preset. Used by `onModeChange` to upsert `{claudeMode, preset}` TOGETHER.
 */
export function presetFromClaudeMode(mode: string): PresetName | undefined {
  for (const [preset, mapped] of Object.entries(PRESET_TO_CLAUDE)) {
    if (mapped === mode) return preset as PresetName;
  }
  return undefined;
}

/**
 * The session-record patch a live mode change persists (RC-5): the mode
 * always rides along, and the preset TOGETHER with it whenever the mode is a
 * skeleton image — an extra tier (`plan` / `auto` / `dontAsk`) changes the
 * mode only, leaving the recorded preset untouched. `onModeChange` feeds
 * this straight into `upsertSession`.
 */
export function modeChangePatch(mode: ClaudePermissionMode): { claudeMode: ClaudePermissionMode; preset?: PresetName } {
  const preset = presetFromClaudeMode(mode);
  return { claudeMode: mode, ...(preset === undefined ? {} : { preset }) };
}

/** The slice of `ctx.permissionPresets` the provider reads. */
interface PermissionPresetsSlice {
  defaultPreset: string;
}

/**
 * The default preset for FUTURE sessions, as the permission service resolves
 * it (settings-backed; the profile patch pins the base default). Undefined when
 * the service is absent or its getter fails — callers fall back to the most
 * restrictive Claude mode.
 */
export function defaultPermissionPreset(ctx: Context): PresetName | undefined {
  const service = ctx.get("permissionPresets") as PermissionPresetsSlice | undefined;
  if (service === undefined) return undefined;
  try {
    const preset = service.defaultPreset;
    return isPresetName(preset) ? preset : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session's effective DSH preset: the last revivable `permission/preset`
 * event.
 *
 * Only the 3-preset skeleton round-trips here: an {@link EXTRA_TIERS} tier is
 * not a preset name, so an event carrying `preset: "plan"` is skipped. Extra
 * tiers are Claude-side runtime state (switchable via `setPermissionMode`), not
 * DSH presets — they are read back through {@link claudePermissionMode} and the
 * event's `claudeMode` field, never promoted to a second event type.
 */
export function presetFromEvents(events: readonly SessionEvent[]): PresetName | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "permission/preset" && isPresetName(event.data?.preset)) return event.data.preset;
  }
  return undefined;
}

/**
 * The DSH permission events stamped for a session's preset, in append order
 * (preset, sandbox, approval) — the same shape `agent-codex/src/permission.ts`
 * emits. The first event additionally carries `claudeMode`: the effective
 * Claude permission mode the live `setPermissionMode` call and the UI both
 * read from one place.
 *
 * The parameter is a {@link PresetName} on purpose. `plan` / `auto` / `dontAsk`
 * are not DSH presets and have no sandbox/approval skeleton to stamp; they
 * change only the Claude-side mode at runtime.
 */
export function permissionEventsFor(preset: PresetName, time: number): SessionEvent[] {
  const spec = DSH_SKELETON[preset];
  return [
    { type: "permission/preset", time, data: { preset, claudeMode: claudePermissionMode(preset) } },
    { type: "sandbox/mode", time, data: { mode: spec.sandbox } },
    { type: "approval/policy", time, data: { policy: spec.approval } },
  ] as unknown as SessionEvent[];
}
