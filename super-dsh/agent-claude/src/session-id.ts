/**
 * DSH session id <-> Claude session id anchoring (spec ruling R8, route A).
 *
 * The DSH id is `<prefix>-<uuid>` (minted by the session store). Claude accepts
 * any UUID version (its predicate is the version-agnostic regex below, verified
 * byte-identical in the SDK and the CLI). So we preset Claude's sessionId from
 * the DSH id's UUID tail: no mapping file, and the id survives restarts.
 *
 * Route B (SDK-minted id + a persisted map) is the fallback ONLY for a DSH id
 * that is not a UUID; the caller must trace it, never fall back silently.
 */
export const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === "string" && CLAUDE_SESSION_ID_RE.test(value);
}

/** UUID tail of a DSH session id, or `undefined` when it is not a UUID. */
export function claudeSessionIdFromDsh(dshSessionId: string): string | undefined {
  const tail = dshSessionId.replace(/^session-/, "");
  return isClaudeSessionId(tail) ? tail.toLowerCase() : undefined;
}
