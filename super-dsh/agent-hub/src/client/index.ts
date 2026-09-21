/**
 * Client half entry: the app-level agent-runtime selector. Registers one
 * `sidebar.footer.action` entry — the footer action stack just above the
 * Settings row — that shows the active runtime and POSTs a switch to the
 * routing host's `/api/agent-runtime` RPC face (same-origin cookie rides
 * the standard auth fence).
 *
 * Adapted from the shelved route (2026-09-10 purity ruling): no sessionId —
 * ONE selector for the whole app. Switching it swaps the entire data plane,
 * so the client reloads the world (full root re-mount = the honest v1 of
 * "pure projection of the newly selected runtime").
 *
 * The plugin shape mirrors the cordis client-plugin contract: an `inject`
 * declaration of required services plus an `apply(ctx)`.
 *
 * @module agent-hub/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { RuntimeSeat } from './RuntimeSeat.tsx'

/** Required services (cordis fiber inject): the slot registry. */
export const inject = ['slots']

type SlotsScope = ClientContext & {
  slots: {
    inject(slot: string, factory: () => () => void): () => void
    register(def: { name: string; id?: string }, component: unknown): () => void
  }
  effect(fn: () => () => void, label?: string): () => void
}

/**
 * Mount the selector. Degrades silently when the slot service is absent (a
 * composition without the sidebar renders nothing — a footer action is an
 * optional occupant by contract).
 *
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.inject(['slots'], (raw) => {
    const scope = raw as SlotsScope
    scope.effect(() => scope.slots.inject('sidebar.footer.action', () => scope.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'agent-runtime',
      },
      RuntimeSeat,
    )), 'agent-hub: runtime footer action')
  })
}
