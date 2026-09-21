/**
 * The hub's own agent roster row (AW-B, URL scheme).
 *
 * The selector is pure navigation: every runtime owns a mount path, so the UI
 * needs exactly one fact — which paths exist — and nothing else. The hub bakes
 * that fact into every page it can reach (ctx0's index and every mounted
 * world's index), so no world implements any selector code and no server-side
 * selection value exists anywhere.
 *
 *   /          → native DSH
 *   /omp/      → the OMP world's mount
 *   /codex/    → the Codex world's mount
 */
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { listAgents } from './roster.js'
import { takeHostMount } from './world-host.js'

/** One selectable runtime: its key, its label, and the path that addresses it. */
export interface AgentLink {
  /** `native` for ctx0, otherwise the adapter's runtime key. */
  key: string
  /** Chip/menu label (`DSH`, `OMP`, `Codex`, …). */
  label: string
  /** Mount root, always trailing-slashed except the native `/`. */
  path: string
}

/** The native runtime's synthetic entry (no adapter plugin backs it). */
const NATIVE: AgentLink = { key: 'native', label: 'DSH', path: '/' }

/** The global this module publishes the roster under. */
export const AGENT_ROSTER_GLOBAL = '__DSH_AGENT_ROSTER__'

/**
 * Every runtime that currently owns a mount, native first.
 *
 * A registered agent without a host mount has no addressable path yet (its
 * world is still spawning) and is therefore not selectable.
 */
export function agentLinks(): AgentLink[] {
  const links: AgentLink[] = [NATIVE]
  for (const agent of listAgents()) {
    const mount = takeHostMount(agent.key)
    if (mount === undefined) continue
    const path = mount.labelPath.endsWith('/') ? mount.labelPath : `${mount.labelPath}/`
    links.push({ key: agent.key, label: agent.label, path })
  }
  return links
}

/** The structured index row that publishes {@link agentLinks} to the page. */
export function agentRosterRow(): IndexInjection {
  return { kind: 'global', name: AGENT_ROSTER_GLOBAL, value: { agents: agentLinks() } }
}
