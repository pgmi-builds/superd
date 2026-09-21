/**
 * agy-store.ts — adapter-owned state + native-home read-only access.
 *
 * Home discipline (agent-adapter-dev-rules §5/§13/§16a):
 * - Adapter state (Gemini API key, cached default model) lives in the WORLD
 *   DSH home: `<worldHome>/agy-adapter.json`. Never written into `~/.gemini`.
 * - The native home (`~/.gemini`) is READ-ONLY for us: default model comes
 *   from `~/.gemini/antigravity-cli/settings.json` (`model` field). Paths are
 *   injectable so tests use fixtures instead of env knobs (prod path has no
 *   redirection).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AgyAdapterState {
  /** Gemini API key the user pasted through the onboarding session. */
  apiKey?: string;
  /** Cached default model slug (from native settings or catalog head). */
  defaultModel?: string;
}

export function adapterStatePath(worldHome: string): string {
  return join(worldHome, "agy-adapter.json");
}

export function readAdapterState(worldHome: string): AgyAdapterState {
  const p = adapterStatePath(worldHome);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as AgyAdapterState;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function writeAdapterState(worldHome: string, state: AgyAdapterState): void {
  writeFileSync(adapterStatePath(worldHome), JSON.stringify(state, null, 2) + "\n");
}

/**
 * ADC evidence probe: the SDK picks up Application Default Credentials on its
 * own, so their mere existence satisfies auth (§16a transparency). Checks the
 * two standard sources — the env-pointed service-account key and the gcloud
 * user ADC file. Read-only; paths injectable for tests.
 */
export function hasAdcEvidence(env: NodeJS.ProcessEnv, home: string): boolean {
  const fromEnv = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (typeof fromEnv === "string" && fromEnv !== "" && existsSync(fromEnv)) return true;
  return existsSync(join(home, ".config", "gcloud", "application_default_credentials.json"));
}

/**
 * Read the gcloud CLI default project (ADC companion): the SDK's Vertex
 * endpoint needs an explicit project when no api_key is given. Parses
 * `~/.config/gcloud/configurations/config_default` (read-only, fixture-friendly).
 */
export function readGcloudProject(home: string): string | undefined {
  const p = join(home, ".config", "gcloud", "configurations", "config_default");
  if (!existsSync(p)) return undefined;
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*project\s*=\s*(\S+)\s*$/.exec(line);
      if (m) return m[1];
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/**
 * Default model as the agy TUI would report it. Read-only probe of the
 * native home; missing file / missing field → undefined (caller falls back
 * to the static catalog head).
 */
export function readNativeDefaultModel(nativeHome: string): string | undefined {
  const p = join(nativeHome, "antigravity-cli", "settings.json");
  if (!existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { model?: unknown };
    return typeof parsed.model === "string" && parsed.model.length > 0
      ? parsed.model
      : undefined;
  } catch {
    return undefined;
  }
}
