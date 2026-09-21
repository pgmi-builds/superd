/**
 * Bridge session index — dsh↔omp identity mapping only.
 *
 * dsh-shape-session-log: the index is no longer a mirror of OMP's native
 * store. The dsh session log is of record, and this index holds ONLY the
 * `dsh_session_id ↔ omp_session_id ↔ session_file` mapping written at first
 * spawn (plus the workspace-attach source for the UI). The union-era OMP-store
 * scan, stat reconcile, prune, and the webui.json migration are all retired:
 * pruning by an OMP-store scan deleted these mappings and broke resume.
 */
import { statSync } from "node:fs";
import type { BridgeStore } from "./db.js";

/**
 * Boot the index before anything reads session state: ensure the ungrouped
 * fallback workspace exists. Idempotent.
 */
export function prepareIndex(store: BridgeStore): void {
  store.ensureUngroupedWorkspace();
}

/** Event-driven INSERT at first spawn: record the identity mapping + preset. */
export function upsertCreated(
  store: BridgeStore,
  input: { ompSessionId: string; sessionFile: string; dshSessionId: string; cwd?: string; preset?: string; createdAt?: number },
): void {
  let size = 0;
  let mtimeMs = Date.now();
  try {
    const stat = statSync(input.sessionFile);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    // File not yet flushable — the next boot pass fills stat lazily.
  }
  store.upsert({
    omp_session_id: input.ompSessionId,
    dsh_session_id: input.dshSessionId,
    session_file: input.sessionFile,
    cwd: input.cwd ?? null,
    title: null,
    // v2 header identity: the row's created_at MUST equal the live session
    // header's createdAt, or session-query's cross-observation header check
    // (assertSessionHeadersCompatible) throws SOURCE_CONFLICT for the id.
    created_at: input.createdAt ?? Date.now(),
    last_modified_at: mtimeMs,
    transcript_size: size,
    model_provider: null,
    model_id: null,
    agent_preset: "omp",
    permission_preset: input.preset ?? null,
    forked_from: null,
    archived: 0,
    last_visited_at: null,
  });
}
