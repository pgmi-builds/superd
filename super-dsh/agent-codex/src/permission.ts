/**
 * Dash permission preset ↔ Codex launch approval mapping.
 *
 * Codex has no runtime approval control either: the approval policy is a
 * LAUNCH-only fact (`--approval-mode` → ThreadOptions.approvalPolicy; the SDK
 * exposes no RPC to change it mid-session), so Dash's 3-way permission preset
 * is resolved once, when the Codex client is constructed, and mapped
 * explicitly (plan Task 7 3:3 mapping):
 *
 *   danger-full-access → sandbox danger-full-access + approvalPolicy never
 *   workspace-write    → sandbox workspace-write    + approvalPolicy on-request
 *   read-only          → sandbox read-only          + approvalPolicy never
 *   no explicit preset → never (the profile pins danger-full-access; the
 *                        sandbox itself remains the constraint — codex has no
 *                        precise counterpart to omp's always-ask)
 *
 * `CODEX_APPROVAL_MODE` (a valid codex approval policy) overrides the mapping
 * — headless test runs pin the flag without composing a preset default. An
 * invalid value is IGNORED (the preset mapping applies).
 *
 * The preset is a Dash-side session fact Codex never records. It lives in the
 * session log (the `permission/preset` / `sandbox/mode` / `approval/policy`
 * events {@link permissionEventsFor} stamps); unlike the omp bridge there is
 * no centralized index and no webui.json legacy — the rollout stays Codex's
 * transcript of record and is never written.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

/** The approval policies Codex actually implements (unknown values are ignored). */
const APPROVAL_POLICIES = ["never", "on-request", "on-failure", "untrusted"] as const;

/** The Dash preset table (mirrors the base bundle's permission plugin config). */
const PRESETS = {
  "danger-full-access": { sandbox: "danger-full-access", approval: "never", codexPolicy: "never" },
  "workspace-write": { sandbox: "workspace-write", approval: "ask", codexPolicy: "on-request" },
  "read-only": { sandbox: "read-only", approval: "ask", codexPolicy: "never" },
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
 * `CODEX_APPROVAL_MODE` when it names an approval policy Codex implements,
 * else undefined. An invalid value is IGNORED (the preset mapping applies).
 */
export function envApprovalMode(): string | undefined {
  const raw = process.env.CODEX_APPROVAL_MODE;
  return raw !== undefined && (APPROVAL_POLICIES as readonly string[]).includes(raw) ? raw : undefined;
}

/**
 * Map a preset onto Codex's `--approval-mode` value; no preset → never.
 * A value that is ALREADY a codex approval policy (the env override rides
 * through the same folded call) passes through untouched; unknown preset
 * names degrade to never.
 */
export function codexApprovalMode(preset: string | undefined): string {
  if (preset !== undefined && (APPROVAL_POLICIES as readonly string[]).includes(preset)) return preset;
  return isPresetName(preset) ? PRESETS[preset].codexPolicy : "never";
}

/** The slice of `ctx.permissionPresets` the provider reads. */
interface PermissionPresetsSlice {
  defaultPreset: string;
}

/**
 * The default preset for FUTURE sessions, as the permission service
 * resolves it (settings-backed; the profile patch pins the base default).
 * Undefined when the service is absent or its getter fails — callers fall
 * back to the codex default policy.
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
