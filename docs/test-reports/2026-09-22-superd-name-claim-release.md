# @pgmi-builds/superd@0.1.0 — name-claim release report (2026-09-22)

## What shipped

- npm package **`@pgmi-builds/superd@0.1.0`** (scoped, public access, tag `latest`).
- Contents: `README.md`, `CONTEXT.md`, `package.json` only (~3.5 kB tarball) — a
  placeholder / name-claim release; no runtime code ships yet. The working line
  lives in the monorepo under `super-dsh/`.

## Naming note (user ruling 2026-09-22)

Unscoped `superd` is blocked by npm's typosquat rule (name-similarity with the
existing dormant `super-d`, 2022): npm treats `-` as insignificant, so the spelling
is permanently reserved — no self-serve override. User ruled **no claim attempt**;
the scoped `@pgmi-builds/superd` is the shipped name.

## Gate check (AGENTS.md §〇)

- **(a) 实测**: the repo's live acceptance instance (`aw-4999-test`, port 4999) was
  relaunched post-merge and verified: listener up, ctx0 token URL curl-verified 200,
  roster all-ready (claude/omp/codex/pi/hermes/agy). Nothing in this release changes
  runtime behavior — the shipped artifact is documentation-only.
- **(b) 报告**: this file.
- **(c) user 放行**: explicit — user requested the publish and confirmed version
  `v0.1.0` (single-action authorization).

## Hygiene done before publishing

- Hardcoded `DEEPSEEK_API_KEY` scrubbed from `super-dsh/test/start-4999.sh`
  (now `${DEEPSEEK_API_KEY:-}` env passthrough) before the tree went public.
- GitHub repo `mark1kwok/superd` created public; `master` pushed (fresh-start history,
  one clean initial commit + this release commit; pre-GitHub history kept locally in
  `legacy/pre-github` — not pushed).
