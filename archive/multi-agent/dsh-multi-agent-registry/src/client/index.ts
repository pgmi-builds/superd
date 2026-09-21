/**
 * Client half entry (M1b): the agent-runtime selector. Registers one
 * `sidebar.footer.action` entry — the footer action stack just above the
 * Settings row — that shows the current session's runtime and POSTs a switch
 * to the registry's `/api/agent-runtime` RPC face (same-origin cookie rides
 * the standard auth fence).
 *
 * The plugin shape mirrors the cordis client-plugin contract: an `inject`
 * declaration of required services plus an `apply(ctx)`.
 *
 * @module dsh-multi-agent-registry/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { RuntimeSeat } from './RuntimeSeat.tsx'

/** Required services (cordis fiber inject): slot registry + session list. */
export const inject = ['slots', 'sessions']

interface SessionsService {
  list: {
    getSnapshot(): { current?: string; byId?: Record<string, unknown> }
    subscribe(cb: () => void): () => void
  }
}

type SlotsScope = ClientContext & {
  slots: {
    inject(slot: string, factory: () => () => void): () => void
    register(def: { name: string; id?: string; inject?: () => object }, component: unknown): () => void
  }
  sessions: SessionsService
  effect(fn: () => () => void, label?: string): () => void
}

/**
 * Mount the selector. Degrades silently when the slot or the sessions
 * service is absent (a composition without the sidebar simply renders
 * nothing — a footer action is an optional occupant by contract).
 *
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.inject(['slots', 'sessions'], (raw) => {
    const scope = raw as SlotsScope
    scope.effect(() => scope.slots.inject('sidebar.footer.action', () => scope.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'agent-runtime',
        // The hooks compartment's function-valued members are bound by the
        // slot renderer into component hooks: `sessionsList` surfaces as
        // `useSessionsList` inside RuntimeSeat.
        inject: () => ({ hooks: { sessionsList: scope.sessions.list } }),
      },
      RuntimeSeat,
    )), 'multi-agent-registry: runtime footer action')
  })
}
