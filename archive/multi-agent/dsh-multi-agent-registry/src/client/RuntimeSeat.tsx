import * as React from 'react'

/**
 * The agent-runtime selector seat (`sidebar.footer.action`, just above the
 * Settings row). Shows the runtime that serves the CURRENT session and lets
 * the user switch it: a POST to the registry's `/api/agent-runtime` RPC face
 * writes the in-memory routing key; the swap takes effect at the next
 * delivery boundary (new session, no live agent, or post-restart).
 *
 * Props: the sidebar's owner share ({@link wide} column state) plus the
 * injected business face — the `sessionsList` SnapshotStore surfaces as the
 * `useSessionsList` hook (function-valued members of a registration's hooks
 * compartment are bound by the slot renderer).
 */

interface SessionsListSnapshot {
  current?: string
  byId?: Record<string, unknown>
}

interface RuntimeSeatProps {
  /** Sidebar column state: expanded (true) or collapsed rail (false). */
  wide: boolean
  /** Bound hook over the session list store (injected hooks compartment). */
  useSessionsList?: <T>(select: (state: SessionsListSnapshot) => T) => T
}

interface AgentRuntimeState {
  sessionId?: string
  runtime: string
  available: string[]
}

const RUNTIME_LABELS: Record<string, string> = {
  native: 'Native (DSH)',
  omp: 'OMP (SDK)',
}

function label(key: string): string {
  return RUNTIME_LABELS[key] ?? key
}

export function RuntimeSeat({ wide, useSessionsList }: RuntimeSeatProps): React.JSX.Element | null {
  const sessionId = useSessionsList?.((state) => state.current) ?? undefined
  const [state, setState] = React.useState<AgentRuntimeState>({ runtime: 'native', available: ['native'] })
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const rootRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (sessionId === undefined) return
    let cancelled = false
    fetch(`/api/agent-runtime?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { runtime?: unknown; available?: unknown }) => {
        if (cancelled) return
        if (typeof j?.runtime === 'string') {
          setState({
            sessionId,
            runtime: j.runtime,
            available: Array.isArray(j.available) ? j.available.filter((k): k is string => typeof k === 'string') : ['native'],
          })
        }
      })
      .catch(() => { /* keep last known; footer must never throw the shell */ })
    return () => { cancelled = true }
  }, [sessionId])

  React.useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const pick = (key: string): void => {
    if (key === state.runtime || busy) return
    if (sessionId === undefined) return
    setBusy(true)
    setOpen(false)
    setError(undefined)
    fetch('/api/agent-runtime', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, runtime: key }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { runtime?: unknown }) => {
        if (typeof j?.runtime === 'string') {
          setState((prev) => ({ ...prev, runtime: j.runtime as string }))
          // Runtime switch accepted: rebuild the whole client. A React
          // re-render alone would repaint stale elements with stale data
          // (catalog / session list / composer all belong to the previous
          // world); a full root-container re-mount is the honest v1 — the
          // reload re-fetches every surface fresh (world-aware RPC comes
          // with M2 isolation; until then this is the visible boundary).
          setTimeout(() => { window.location.reload() }, 150)
        }
      })
      .catch((e: unknown) => { setError(String(e)) })
      .finally(() => { setBusy(false) })
  }

  const styleBase: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: wide ? '7px 10px' : '7px 0',
    justifyContent: wide ? 'flex-start' : 'center',
    border: 'none',
    borderRadius: 8,
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 13,
    cursor: busy ? 'wait' : 'pointer',
    opacity: busy ? 0.6 : 1,
    position: 'relative',
  }
  const styleBadge: React.CSSProperties = {
    fontSize: 10,
    lineHeight: 1.4,
    padding: '1px 6px',
    borderRadius: 999,
    background: 'color-mix(in srgb, currentColor 12%, transparent)',
    whiteSpace: 'nowrap',
  }
  const styleMenu: React.CSSProperties = {
    position: 'absolute',
    bottom: 'calc(100% + 6px)',
    left: 6,
    right: 6,
    zIndex: 40,
    background: 'var(--dsh-surface, #26262b)',
    border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
    borderRadius: 10,
    boxShadow: '0 8px 24px rgba(0,0,0,.35)',
    overflow: 'hidden',
  }
  const styleItem = (active: boolean): React.CSSProperties => ({
    display: 'block',
    width: '100%',
    padding: '8px 12px',
    border: 'none',
    background: active ? 'color-mix(in srgb, currentColor 10%, transparent)' : 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 13,
    textAlign: 'left',
    cursor: 'pointer',
  })

  return (
    <div ref={rootRef} style={{ position: 'relative', width: '100%' }}>
      <button
        type="button"
        style={styleBase}
        title={sessionId === undefined
          ? 'agent runtime (no active session — select applies to the next one you open)'
          : `agent runtime for session ${sessionId} — switch takes effect at the next delivery boundary`}
        onClick={() => { setOpen((v) => !v) }}
      >
        {wide
          ? (<>
              <span aria-hidden>⌘</span>
              <span style={{ flex: 1, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                Agent · {state.runtime}
              </span>
              <span style={styleBadge}>switch</span>
            </>)
          : (<span aria-hidden title={`Agent · ${state.runtime}`}>⌘{state.runtime.slice(0, 1).toUpperCase()}</span>)}
      </button>
      {error !== undefined && wide
        ? (<div style={{ fontSize: 11, padding: '0 10px', opacity: 0.7 }}>{error}</div>)
        : null}
      {open
        ? (<div style={styleMenu} role="menu">
            {state.available.map((key) => (
              <button key={key} type="button" role="menuitem" style={styleItem(key === state.runtime)} onClick={() => { pick(key) }}>
                {label(key)}{key === state.runtime ? ' ✓' : ''}
              </button>
            ))}
            {sessionId === undefined && wide
              ? (<div style={{ fontSize: 11, padding: '4px 12px 8px', opacity: 0.7 }}>no active session — applies to the next one</div>)
              : null}
          </div>)
        : null}
    </div>
  )
}
