/**
 * @pgmi-builds/agent-hub — plugin entry (host half).
 *
 * DL7 (2026-09-16): there is NO server-side selected state. The module-level
 * selector and the instance-delegation wrapper that consumed it were removed;
 * world ownership is per-request and travels on the mount path:
 *
 *   /<label>/...              → that world's web surface (carrier.ts, AW-B)
 *   /api/...                  → ctx0/native, untouched (upstream route owner)
 *
 * This file therefore only mounts the CTX0-owned control plane today. The
 * per-world mount registers through `carrier.ts` (AW-B tasks 2-9), which calls
 * the addressed world's own `typertGateway` instance directly — again without
 * any shared selection value.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { registerSelectorRpc, registryTargets } from './rpc.js'
import { agentRosterRow } from './agent-roster.js'

/** Stable Cordis plugin name. */
export const name = 'agent-hub'

/**
 * The plugin form (row contract): applied when the row mounts.
 *
 * Two CTX0-owned contributions, neither carrying any selection value:
 *   - the world inventory control plane (read-only);
 *   - the agent roster row baked into ctx0's own index, so the selector lists
 *     every mount path the hub currently serves.
 */
export function apply(ctx: Context): void {
  registerSelectorRpc(ctx, registryTargets)
  const on = (ctx as unknown as { on?: (event: string, listener: (table: IndexInjection[]) => void) => void }).on
  on?.call(ctx, 'webserver/index-inject', (table) => { table.push(agentRosterRow()) })
}
export default apply
