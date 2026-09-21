/**
 * Dash permission preset ↔ pi launch-only toolset mapping.
 *
 * pi has no runtime approval control and no per-action approval channel: its
 * bash/edit/write tools execute directly (project trust gates project
 * resources natively, via the user's own `~/.pi/agent/trust.json`). So the
 * Dash 3-way preset is realized ONCE, at session creation, as a pi toolset
 * (ruling 7, 2026-09-17):
 *
 *   danger-full-access → pi default tools (read, bash, edit, write)
 *   workspace-write    → pi default tools (the outer dsh sandbox is the
 *                        constraint; pi has no sandbox layer of its own)
 *   read-only          → read, grep, find, ls (no mutation tools)
 *   no preset          → pi default tools
 *
 * `PI_APPROVAL_MODE` (a valid preset NAME) overrides the mapping — headless
 * test runs pin it without composing a preset default. An invalid value is
 * IGNORED (the preset mapping applies).
 *
 * The preset is a Dash-side session fact pi never records. It lives in the
 * session log (the `permission/preset` / `sandbox/mode` / `approval/policy`
 * events {@link permissionEventsFor} stamps); pi's native transcript is never
 * written.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

/** The Dash preset table (mirrors the base bundle's permission plugin config). */
const PRESETS = {
  "danger-full-access": { sandbox: "danger-full-access", approval: "never", toolset: undefined },
  "workspace-write": { sandbox: "workspace-write", approval: "ask", toolset: undefined },
  "read-only": { sandbox: "read-only", approval: "ask", toolset: ["read", "grep", "find", "ls"] as string[] },
} as const;

/**
 * The two permission event keys this module reads/synthesizes that the
 * locally-resolved dsh-session build does not know (upstream declares them
 * in dsh-permission-presets / dsh-sandbox-policy, whose types this project
 * does not reference). Mirrored verbatim so `SessionEvent` narrows.
 */
declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "permission/preset": { preset: string };
    "sandbox/mode": { mode: "read-only" | "workspace-write" | "danger-full-access"; source?: "delegation" };
  }
}

type PresetName = keyof typeof PRESETS;

/** Narrow an untrusted value to a known preset name. */
export function isPresetName(raw: unknown): raw is PresetName {
  return typeof raw === "string" && Object.hasOwn(PRESETS, raw);
}

/**
 * `PI_APPROVAL_MODE` when it names a preset this adapter implements, else
 * undefined. An invalid value is IGNORED (the preset mapping applies).
 */
export function envApprovalMode(): string | undefined {
  const raw = process.env.PI_APPROVAL_MODE;
  return isPresetName(raw) ? raw : undefined;
}

/**
 * Map a preset onto the launch-only pi toolset. `undefined` = pi's own
 * default tool set (read, bash, edit, write). Unknown names degrade to the
 * default.
 */
export function piToolset(preset: string | undefined): string[] | undefined {
  return isPresetName(preset) ? PRESETS[preset].toolset : undefined;
}

/** The slice of `ctx.permissionPresets` the provider reads. */
interface PermissionPresetsSlice {
  defaultPreset: string;
}

/**
 * The default preset for FUTURE sessions, as the permission service
 * resolves it (settings-backed; the profile patch pins the base default).
 * Undefined when the service is absent or its getter fails — callers fall
 * back to the pi default toolset.
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
 * The three Dash events `pinInitialPermission` stamps for a fresh session,
 * in its append order (preset, sandbox, approval). Cold replay prepends
 * them so the UI shows the session's permission after wrapper restarts.
 */
export function permissionEventsFor(preset: PresetName, time: number): SessionEvent[] {
  const spec = PRESETS[preset];
  return [
    { type: "permission/preset", time, data: { preset } },
    { type: "sandbox/mode", time, data: { mode: spec.sandbox } },
    { type: "approval/policy", time, data: { policy: spec.approval } },
  ] as unknown as SessionEvent[];
}
