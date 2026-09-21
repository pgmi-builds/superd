# Super D (superd)

Super D is an independent bridge-layer app (minimal cordis host): it maps existing local
and remote **agent runtimes** (DSH, OMP, Claude Code, Codex, Hermes, Pi, Antigravity) into
a unified session/event surface consumable by the [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) Web UI and messaging channels.

- Owns **no runtimes**, stores **no conversations** (the only persistent state is a pairing table).
- Composition/patch layer rides on [cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) and the DSH bundle/boot conventions (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`).
- Working line: [`super-dsh/`](./super-dsh) — the **agent worlds** fusion line: `agent-hub` (selector + spawn gateway + roster) plus per-runtime adapters `agent-{claude,codex,omp,pi,hermes,agy}`.
- Archived experiment lines: [`archive/`](./archive).

> **Status:** `0.1.0` is a placeholder / name-claim release — the npm package ships the
> manifest and glossary only. The real development happens in the monorepo (this repository),
> main line under `super-dsh/`.

## Repository layout

| Path | Role |
|---|---|
| `super-dsh/` | Main line: agent worlds (hub + adapters), test start scripts |
| `archive/` | Shelved/frozen earlier lines (kept for reference) |
| `docs/` | Design documents, plans, test reports |
| `.tests/` | Dev/test DSH home (git-ignored, never published) |
| `upstream/` | Pinned upstream checkout used as the dev/test base (git-ignored) |

## Glossary

See [CONTEXT.md](./CONTEXT.md) for the domain vocabulary (RuntimeProvider, Adapter,
Machine, Session Pairing, Consumer, Messaging Channel, …).

## License

MIT
