# super-dsh — Agent Worlds for the DeepSeek Harness

One [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin that joins local
foreign-agent runtimes into the DSH Web UI: a runtime selector in the sidebar,
a live roster, and one zero-port world per runtime mounted under `/<label>` —
same browser shell, same auth domain, per-world session separation.

**Owns no runtimes and stores no conversations.** Every adapter keeps its
native home and session format (`~/.omp`, `~/.codex`, `~/.claude`, `~/.pi`,
Hermes native, Antigravity SDK); the DSH session log inside each world's nested
home is an explicit duplicate (producer/bridge architecture), never a fork of
the foreign store.

## Install

```bash
dsh plugin --profile <name> add super-dsh@0.1.0
```

That single package composes the whole line (`@pgmi-builds/agent-hub` plus the
six `@pgmi-builds/agent-adapter-*` packages). Restart the profile and the
sidebar gains the runtime selector; each world provisions its own nested DSH
home under `<DSH_HOME>/agents/<label>/` on first boot.

## Runtimes

| Label | Runtime | Integration |
|---|---|---|
| OMP | OMP (`~/.omp`) | in-process SDK sidecar, lazy per session |
| Codex | Codex CLI (`~/.codex`) | adapter world plugin |
| Claude | Claude Code (`~/.claude`) | standalone adapter, joined by the hub |
| Pi | pi coding agent (`~/.pi`) | in-process SDK |
| Hermes | Hermes (`~/.hermes`) | gateway child |
| Antigravity | agy SDK | Python bridge (`bridge/agy_bridge.py`) |

## Design

- **S1** selector handoff is one hop; the dispatcher never addresses sessions.
- **S2** activation is roster membership; worlds spawn as sibling roots
  (`boot()` on the CTX0 tree), never through `runProfile()`.
- **S3/S7** `<DSH_HOME>/agents/<runtime>/` is that runtime's whole world; native
  app data stays in the native home; one-way valve — never read back.
- **S4** worlds own no port; delegation is in-process (zero-byte proxying).
- **S6** the router is dumb: consumer switching + new-session generator only.

Full topology: the `superd` monorepo (`github.com/pgmi-builds/superd`),
`super-dsh/AGENTS.md` + `docs/00-blueprint.md` (v0.4a) + ADR 0001–0007.
