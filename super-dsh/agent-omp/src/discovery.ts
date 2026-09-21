/**
 * OMP skills + slash-command discovery, bridged into the host's capability
 * seams (`ctx.skills` + `ctx.commands`). Both services stay mounted by
 * dsh-base/dsh-web-app; the bridge only supplies data/registrations — the
 * UI (SkillRow, the composer `/` menu) already reads them.
 *
 * Sidecar-free since the sidecar-decoupling change (plan
 * 2026-09-16-omp-adapter-sidecar-decoupling): both catalogs are read straight
 * from disk (omp + claude user/project roots, see omp-disk-discovery). Slash
 * commands mount once at boot and re-mount on the hourly discovery refresh —
 * never a sidecar spawn.
 *
 * @module omp-web/discovery
 */
import type { Context } from "@deepseek-ai/cordis";
import { readFile } from "node:fs/promises";
import { OMP_DISCOVERY_REFRESH_INTERVAL_MS } from "./knobs.js";
import {
  readSkills,
  readSlashCommands,
  type OmpDiskSlashCommand,
} from "./omp-disk-discovery.js";

// Local slices of the host services (the full types live in dsh-skill /
// dsh-commands, which this package does not vendor).
interface SkillRegistrySlice {
  registerProvider(create: (control: unknown) => unknown): () => void;
}
interface CommandRuntimeSlice {
  register(definition: {
    name: string;
    description: string;
    input?: { hint?: string; attachments?: boolean };
    handler(): { kind: "success"; text?: string } | { kind: "error"; text: string };
  }): () => void;
}

/** Strip a slash-command name to the host's `/^[a-z][a-z0-9_-]*$/` shape. */
function sanitizeCommandName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").slice(0, 64);
  return cleaned === "" ? "omp-command" : cleaned;
}

/**
 * Register one set of disk-scanned OMP slash commands on the host runtime.
 * The handler echoes the command body as the result text — a first-pass
 * surface; a deeper integration would route execution through the bridged
 * Agent. Returns a disposer for the whole set.
 */
export function mountSlashCommands(commands: CommandRuntimeSlice, found: OmpDiskSlashCommand[]): () => void {
  const disposers = found.map((command) =>
    commands.register({
      name: sanitizeCommandName(command.name),
      description: command.description,
      handler: () => ({ kind: "success", text: command.content }),
    }),
  );
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // A host-side double-dispose must not break the refresh cycle.
      }
    }
  };
}

/**
 * A refreshable slash-command mount: registers the boot scan immediately,
 * then `refresh()` swaps the live set for a fresh disk scan (dispose-then-
 * register, so a removed command file disappears from the `/` menu).
 */
export function createSlashCommandMount(commands: CommandRuntimeSlice, cwd?: string): {
  refresh: () => void;
  disposeAll: () => void;
} {
  let dispose: () => void = () => { };
  const refresh = (): void => {
    dispose();
    dispose = mountSlashCommands(commands, readSlashCommands(cwd));
  };
  refresh();
  return {
    refresh,
    disposeAll: () => dispose(),
  };
}

/**
 * Mount OMP discovery on the host seams. Fail-open: a missing `skills` or
 * `commands` service leaves the feature dormant, never blocks host boot.
 *
 * @param ctx - host plugin context.
 */
export function installOmpDiscovery(ctx: Context): void {
  // Skills: a discovery provider whose `list(cwd)` scans OMP's disk roots for
  // the caller's workspace; the body is read lazily from SKILL.md in `get`.
  ctx.inject(["skills"], (scoped) => {
    const skills = scoped.get("skills") as SkillRegistrySlice | undefined;
    if (skills === undefined) return;
    skills.registerProvider(() => ({
      name: "omp",
      list: async (options: { cwd?: string }) => {
        const found = readSkills(options.cwd);
        return found.map((skill, rank) => ({
          name: skill.name,
          description: skill.description,
          rank,
          locator: skill.filePath,
          path: skill.filePath,
          invocation: { modelInvocable: true, userInvocable: true },
          source: "custom",
          provider: "omp",
        }));
      },
      get: async (candidate: { name: string; description: string; locator: unknown }) => {
        const content = await readFile(String(candidate.locator), "utf8").catch(() => "");
        return {
          name: candidate.name,
          description: candidate.description,
          content,
          invocation: { modelInvocable: true, userInvocable: true },
          source: "custom",
          provider: "omp",
        };
      },
    }));
  });

  // Slash commands: mount the boot scan, then re-scan on the hourly discovery
  // cadence (pure disk reads; `0` disables). The interval + live registrations
  // are fiber-owned: torn down with the plugin context.
  ctx.inject(["commands"], (scoped) => {
    const commands = scoped.get("commands") as CommandRuntimeSlice | undefined;
    if (commands === undefined) return;
    const mount = createSlashCommandMount(commands);
    let timer: NodeJS.Timeout | undefined;
    if (OMP_DISCOVERY_REFRESH_INTERVAL_MS > 0) {
      timer = setInterval(() => {
        try {
          mount.refresh();
        } catch {
          // A bad refresh must never kill the interval or the host.
        }
      }, OMP_DISCOVERY_REFRESH_INTERVAL_MS);
      timer.unref?.();
    }
    ctx.effect(
      () => () => {
        if (timer !== undefined) clearInterval(timer);
        mount.disposeAll();
      },
      "ompDiscovery.slashCommands",
    );
  });
}
