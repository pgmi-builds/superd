/**
 * Claude Code app-home resolution (native home, user ruling 2026-09-17).
 *
 * The installed Claude CLI keeps its own native home (`~/.claude`; an ambient
 * `CLAUDE_CONFIG_DIR` overrides in tests). The adapter never redirects it at
 * spawn and never copies config into it — this supersedes the S7 nested-home
 * layout (`<dshHome>/agents/claude`) and its one-way config valve, matching
 * the agent-pi precedent.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";


/** Refuse any path that resolves into a production DSH home (repo red line). */
/**
 * The Claude app home: the NATIVE `~/.claude`, prod-home guarded. An ambient
 * `CLAUDE_CONFIG_DIR` wins (tests pin an isolated home that way); the adapter
 * itself never sets the variable when spawning the CLI.
 */
export function resolveClaudeHome(): string {
  const claudeHome = resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
  return claudeHome;
}
