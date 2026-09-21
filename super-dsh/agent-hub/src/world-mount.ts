/**
 * World composition patches for the mount (AW-B DL1/DL3).
 *
 * A mounted world runs with NO listener and provides the virtual webServer
 * from `<pkg>/world`. Three patches make that composition work:
 *
 *   1. `webserver` disabled      — the world owns no socket; ctx0's listener is
 *                                  the only ingress.
 *   2. `modules` inject webServer — client-modules probes
 *      `ctx.get('webServer')` WITHOUT declaring the dependency
 *      (`client/modules/src/index.ts:576`), so without this patch its row
 *      activates before the provider exists and boot fails. Patching the row's
 *      `inject` makes cordis WAIT for the provider, order-independent.
 *   3. insert the world mount row — provides the virtual webServer inside the
 *      world root and translates every route its plugins declare.
 *
 * Patch layers are plain data: the patch engine applies arbitrary entry
 * overrides (`vendor/include/src/index.ts:77-121`).
 */

/** Id of the inserted world-mount row. */
export const WORLD_MOUNT_ROW_ID = 'aw-world-mount'

/** Plugin name providing the world's virtual webServer. */
export const WORLD_MOUNT_PLUGIN = '@pgmi-builds/agent-hub/world'

/** Id of the inserted hub row (the same plugin ctx0 itself composes). */
export const WORLD_HUB_ROW_ID = 'aw-agent-hub'

/** Plugin name of the hub itself — one UI, one roster, every runtime. */
export const WORLD_HUB_PLUGIN = '@pgmi-builds/agent-hub'

/** One patch layer understood by the loader (structural; no app-boot import). */
export type WorldPatchLayer =
  | { id: string; disabled?: boolean; inject?: readonly string[] }
  | { insert: ReadonlyArray<{ id: string; name: string; config?: Record<string, unknown> }> }

/**
 * The layers that turn a listener-owning world into a mounted one:
 *
 *   1. `webserver` off — the world owns no socket (the hub serves its face);
 *   2. `modules` waits for the virtual `webServer` the entry row provides;
 *   3. the entry row itself (the world's mount identity);
 *   4. the HUB ROW — the same `@pgmi-builds/agent-hub` native ctx0 composes, so
 *      the foreign agent gets the *identical* selector UI, and the roster it
 *      renders is read from the hub over the world's own `/api` channel.
 * @param key - runtime key (`omp`, `codex`, …) — the mount label.
 * @returns patch layers to append to the world's composition.
 */
export function worldMountPatches(key: string): readonly WorldPatchLayer[] {
  if (typeof key !== 'string' || key === '' || key.includes('/')) {
    throw new Error(`world-mount: invalid key ${JSON.stringify(key)}`)
  }
  return [
    { id: 'webserver', disabled: true },
    { id: 'modules', inject: ['webServer'] },
    { insert: [
      { id: WORLD_MOUNT_ROW_ID, name: WORLD_MOUNT_PLUGIN, config: { key } },
      { id: WORLD_HUB_ROW_ID, name: WORLD_HUB_PLUGIN },
    ] },
  ]
}
