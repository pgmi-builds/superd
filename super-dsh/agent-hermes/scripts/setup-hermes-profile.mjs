#!/usr/bin/env node
/**
 * setup-hermes-profile.mjs — idempotent bootstrap of the STANDALONE hermes
 * app profile (`$DSH_HOME/profiles/hermes-standalone/`): the adapter bundle
 * IS the app composition (no ctx0 selector, no hub — mirrors the codex/pi
 * standalone profiles). Rerun rebuilds the three config files and re-verifies
 * the `@pgmi-builds` links; it never touches other lines' profiles.
 *
 * Files (re)written every run — the exact codex standalone profile file set:
 *   package.json         dsh.profile.bundles = dsh-base + dsh-web-app +
 *                        @pgmi-builds/agent-adapter-hermes, plus a `link:`
 *                        dependency pointing at the adapter package dir.
 *   cordis.patch.yml     profile user layer: webserver 127.0.0.1:4985 (the
 *                        provider rows live in the adapter bundle's own patch).
 *   pnpm-workspace.yaml  nodeLinker: hoisted / autoInstallPeers: false.
 *
 * Links ensured (created when missing, relinked only when stale or a physical
 * copy, kept untouched when already correct):
 *   $DSH_HOME/profiles/node_modules/@pgmi-builds/agent-adapter-hermes → this package
 *   $DSH_HOME/profiles/node_modules/@pgmi-builds/agent-hub            → ../agent-hub
 *                        (hub is not in this profile's bundles — mirroring the
 *                        codex standalone profile — but the shared dir serves
 *                        the world lines, so the link is verified, not owned)
 *   <pkg>/node_modules/@pgmi-builds/agent-hub → ../../../agent-hub
 *                        (npm `file:` deps materialize physical copies → hub
 *                        double instance → world webServer all pending; the
 *                        symlink is the sanctioned fix, agent-worlds AGENTS.md)
 *
 * After any linking the @deepseek-ai single-instance check runs (repo AGENTS.md
 * 三): `find <repo>/node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l`
 * — informational, fail-soft; the farm must hold only symlinks plus the repo's
 * own physical packages.
 *
 * Env:
 *   DSH_HOME  — test home root (default <repo>/.tests; explicit env wins).
 *               REFUSES to resolve into the prod homes (~/.dsh, ~/.superd).
 */
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // …/agent-worlds/agent-hermes
const LINE_DIR = dirname(PKG_DIR); // …/agent-worlds
const REPO = dirname(dirname(LINE_DIR)); // repo root (agent-worlds → apps → repo)
const LABEL = "hermes-standalone";
const PORT = 4985;
// The repo's own physical packages under node_modules/@deepseek-ai — expected
// to be the ONLY non-symlink entries in the farm (repo AGENTS.md 三).
const REPO_OWNED_PHYSICAL = new Set(["dsh-client-ui-slots"]);

const home = resolve(process.env.DSH_HOME ?? join(REPO, ".tests"));
// Red line guard (repo AGENTS.md): never resolve into the prod homes. An
// ambient DSH_HOME from the interactive environment must never win by accident.
const PROD_HOMES = [join(homedir(), ".dsh"), join(homedir(), ".superd")];
if (PROD_HOMES.includes(home) || PROD_HOMES.some((p) => home.startsWith(`${p}/`))) {
  console.error(`setup-hermes-profile: refusing prod home "${home}" — set DSH_HOME to the test home explicitly`);
  process.exit(1);
}

const prof = join(home, "profiles", LABEL);
mkdirSync(prof, { recursive: true });

// ---- config files: idempotent by regeneration (byte-identical on rerun) ----
writeFileSync(
  join(prof, "package.json"),
  `${JSON.stringify(
    {
      name: "aw-hermes-app-profile",
      private: true,
      dsh: {
        profile: {
          bundles: [
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-web-app",
            "@pgmi-builds/agent-adapter-hermes",
          ],
        },
      },
      dependencies: {
        "@pgmi-builds/agent-adapter-hermes": `link:${PKG_DIR}`,
      },
    },
    null,
    2,
  )}\n`,
);

writeFileSync(
  join(prof, "cordis.patch.yml"),
  `# Standalone hermes app: a REAL user-facing listener (loopback only — no LAN
# relay on this line). The provider rows (hermes-provider + native-row disables
# + permission table + the pinned browse directory picker) are the adapter
# bundle's own patch — this file carries only the profile-specific posture.
- id: webserver
  config:
    host: 127.0.0.1
    port: ${PORT}
`,
);

writeFileSync(join(prof, "pnpm-workspace.yaml"), "nodeLinker: hoisted\nautoInstallPeers: false\n");

// ---- links: create when missing, heal when stale/physical, keep when correct ----
/** @returns {"created" | "kept" | "relinked"} */
function ensureLink(linkPath, target) {
  let st = null;
  try {
    st = lstatSync(linkPath);
  } catch {
    // absent → fall through to create
  }
  if (st?.isSymbolicLink() && readlinkSync(linkPath) === target) return "kept";
  if (st) rmSync(linkPath, { recursive: true, force: true });
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, "dir");
  return st ? "relinked (was stale/physical)" : "created";
}

const PGMB = join(home, "profiles", "node_modules", "@pgmi-builds");
const r1 = ensureLink(join(PGMB, "agent-adapter-hermes"), PKG_DIR);
const r2 = ensureLink(join(PGMB, "agent-hub"), join(LINE_DIR, "agent-hub"));
const r3 = ensureLink(
  join(PKG_DIR, "node_modules", "@pgmi-builds", "agent-hub"),
  "../../../agent-hub",
);

// ---- @deepseek-ai single-instance check (informational, fail-soft) ----
const scope = join(REPO, "node_modules", "@deepseek-ai");
const found = spawnSync("find", [scope, "-maxdepth", "1", "-mindepth", "1", "!", "-type", "l"], {
  encoding: "utf8",
});
const physical = (found.stdout ?? "").trim();
const unexpected = physical
  .split("\n")
  .filter(Boolean)
  .filter((line) => !REPO_OWNED_PHYSICAL.has(line.split("/").pop() ?? ""));
if (found.status !== 0) {
  console.warn(`setup-hermes-profile: single-instance check failed to run (find exit ${found.status})`);
} else {
  console.log(`setup-hermes-profile: single-instance check (${scope}, non-symlink entries):`);
  console.log(physical ? physical.split("\n").map((l) => `  ${l}`).join("\n") : "  (none)");
  if (unexpected.length > 0) {
    console.warn(
      `setup-hermes-profile: WARN unexpected physical @deepseek-ai entries (double-instance risk):\n${unexpected.map((l) => `  ${l}`).join("\n")}`,
    );
  }
}

console.log(
  `setup-hermes-profile: profile rebuilt at ${prof} (3 files), links: adapter=${r1}, hub(profile)=${r2}, hub(pkg-local)=${r3}, home=${home}`,
);
