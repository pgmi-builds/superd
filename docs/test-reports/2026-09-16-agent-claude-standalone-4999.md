# agent-claude standalone acceptance — port 4999 (2026-09-16)

**Verdict: PASS** — real Claude Code turn through the host binary, on the shared test port.

## Environment
- Branch `aw-claude-adapter`; adapter under test `apps/agent-worlds/agent-claude` (`@pgmi-builds/agent-adapter-claude`), head `c3dda91`.
- Instance: `systemd-run --user` unit **`aw-claude-app-4999-test`** + LAN relay `aw-claude-app-4999-relay`; launcher = repo build `upstream/deepseek-harness/apps/cli/lib/bin.js --profile claude --no-open --trusted-host 192.168.31.130`; `DSH_HOME=<repo>/.superd-test` (prod `~/.dsh` untouched; seeded copy at `.superd-test/agents/claude`).
- Port **4999** per user instruction (was 4989 in the plan) — reusing the shared Caddy test port.

## Results (verifier exit 0)
| Check | Result |
|---|---|
| unauth probe | `401` ✅ |
| `llm/listProviders` | `[{"id":"claude","name":"Claude"}]` ✅ |
| `session/create` | `session-d8797257-1f58-4a9c-bf6d-bd31a7f4a3e2` ✅ |
| real turn | reply **`claude-standalone-ok`** ✅ |
| event stream | `permission/preset, sandbox/mode, approval/policy, agent-preset/selected, turn/start, user/message, session/title, step/start, assistant/message, step/end, turn/end` ✅ |
| R12 slash commands | **41 `claude-*` mirrored** via `commands/list` ✅ |
| model catalog | `["default","opus","sonnet","haiku"]` ✅ (Task 9 catalog population, live) |
| `agentPresets/list` | 404 — expected: the patch disables `agent-presets` ✅ |

## Host-binary signature (R5)
```
/home/u1/.local/bin/claude --output-format stream-json --verbose --input-format stream-json
  --permission-prompt-tool stdio --permission-mode default
  --allow-dangerously-skip-permissions --session-id=d8797257-1f58-4a9c-bf6d-bd31a7f4a3e2
```
Host binary, **not** the `claude-agent-sdk-linux-x64` payload. Also proves live: streaming-input bridge (T3/T5), `canUseTool` permission wiring (T8/T9), route-A session-id anchoring (T2 — the `--session-id` is the DSH session's UUID tail).

## Defect found by this acceptance (and fixed)
First run (on 4989) failed: `ERR session/model-unavailable: no adapter serves provider "deepseek"` — the provider never published a default model into `agentDefaultModel`, so the world's default fell to the `llm-deepseek` row our own patch disables. Codex avoids this because its catalog is readable from disk before any session; claude's is observation-only. Fixed in `c3dda91` (mirror codex's `#registerDefaultModel` + `setModel`-on-create, with a declared boot default `sonnet`). This is why the plan mandates runtime acceptance over green unit tests: the defect passed 114/114.

## Pending
- User manual test (this instance stays running).
- End-of-branch triage round (accumulated deferred Minors, incl. the ruled steer-severity fix) + final whole-branch review.
