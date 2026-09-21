/**
 * `./world` entry point for a future hub-side packaging step.
 *
 * Ruling R2 (2026-09-16): this adapter ships and is verified STANDALONE only.
 * Joining the agent-worlds hub is the hub side's job — it packages this entry
 * with its own spawn/roster wiring. Nothing here starts a process or reads the
 * hub; it only exposes the canonical provider row name.
 */
export const name = 'aw.agent-adapter-claude-world';
export const providerRow = '@pgmi-builds/agent-adapter-claude';
export function apply(): void {
  // Intentionally inert: the standalone bundle patch (cordis.patch.yml) is the
  // sole mounting path in V1. The hub packages its own insert row via `providerRow`.
}
