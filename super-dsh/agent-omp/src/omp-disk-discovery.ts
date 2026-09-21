/**
 * Host-side disk readers for OMP slash commands and skills.
 *
 * Replaces the sidecar round-trips (`slashCommands.list` / `skills.list`) that
 * used to spawn the whole bun/OMP core just to walk a few directories. The
 * upstream discovery (pi-coding-agent src/discovery/*) is a 10+ provider
 * capability web we deliberately do NOT port; v1 scans the practical roots:
 *
 *   commands: <OMP_NATIVE_HOME>/agent/commands/*.md      (native user)
 *             <cwd>/.omp/commands/*.md                   (native project)
 *             ~/.claude/commands/*.md                    (claude user)
 *             <cwd>/.claude/commands/*.md                (claude project)
 *   skills:   the same four roots' `skills/` sibling, each entry either
 *             `<root>/<name>/SKILL.md` (Agent Skills standard) or a lenient
 *             flat `<root>/*.md`.
 *
 * Known divergences from the SDK path (accepted, see plan §3): no embedded
 * bundled commands, no codex/opencode/cursor/gemini providers, no capability
 * semantics (at-imports, managed skills, extensionRoots reload). Dedupe order
 * is scan order with FIRST occurrence winning: omp user → claude user →
 * omp project → claude project. All readers are fail-soft: missing roots or
 * unreadable files are skipped, never thrown.
 *
 * @module omp-web/omp-disk-discovery
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOmpNativeHome } from "./knobs.js";

/** One file-based slash command, shape-compatible with the old sidecar frame. */
export interface OmpDiskSlashCommand {
  name: string;
  description: string;
  content: string;
  source: string;
  filePath: string;
}

/** One discovered skill, shape-compatible with the old sidecar frame. */
export interface OmpDiskSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
}

/** Minimal frontmatter + body split of a markdown command/skill file. */
interface ParsedMarkdown {
  description: string;
  content: string;
}

/** Root descriptors in dedupe order (first occurrence of a name wins). */
interface DiscoveryRoot {
  base: string;
  subdir: string;
  label: string;
}

function discoveryRoots(cwd: string | undefined, kind: "commands" | "skills"): DiscoveryRoot[] {
  const home = homedir();
  const roots: DiscoveryRoot[] = [
    { base: resolveOmpNativeHome(), subdir: join("agent", kind), label: `omp:user` },
    { base: home, subdir: join(".claude", kind), label: `claude:user` },
  ];
  if (cwd !== undefined && cwd !== "") {
    roots.push(
      { base: cwd, subdir: join(".omp", kind), label: `omp:project` },
      { base: cwd, subdir: join(".claude", kind), label: `claude:project` },
    );
  }
  return roots;
}

/**
 * Split an optional YAML-ish frontmatter from a markdown body and derive the
 * display description the way the SDK's parseCommandTemplate does: the
 * frontmatter `description` when present, else the first non-empty body line
 * trimmed to 60 chars. Unknown keys are ignored; a malformed block degrades to
 * "whole file is body".
 */
function parseMarkdownTemplate(raw: string): ParsedMarkdown {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    return { description: fallbackDescription(text), content: text };
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    return { description: fallbackDescription(text), content: text };
  }
  const frontmatter = text.slice(4, end);
  const bodyStart = text.indexOf("\n", end + 1);
  const body = bodyStart === -1 ? "" : text.slice(bodyStart + 1).replace(/^\n+/, "");
  let description: string | undefined;
  for (const line of frontmatter.split("\n")) {
    const match = /^(description|argument-hint):\s*(.*)$/.exec(line);
    if (match !== null && match[2] !== "") {
      description = match[2].trim().replace(/^["']|["']$/g, "");
      break;
    }
  }
  return { description: description ?? fallbackDescription(body), content: body };
}

function fallbackDescription(body: string): string {
  const line = body.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.trim().slice(0, 60);
}

function listMarkdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function readFileSoft(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Read every file-based slash command from the discovery roots.
 * Deterministic output: deduped by name (scan order, first wins), then sorted.
 */
export function readSlashCommands(cwd?: string): OmpDiskSlashCommand[] {
  const byName = new Map<string, OmpDiskSlashCommand>();
  for (const root of discoveryRoots(cwd, "commands")) {
    const dir = join(root.base, root.subdir);
    for (const file of listMarkdownFiles(dir)) {
      const name = file.replace(/\.md$/i, "");
      if (name === "" || byName.has(name)) continue;
      const raw = readFileSoft(join(dir, file));
      if (raw === undefined) continue;
      const parsed = parseMarkdownTemplate(raw);
      byName.set(name, {
        name,
        description: parsed.description,
        content: parsed.content,
        source: root.label,
        filePath: join(dir, file),
      });
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function readSkillFile(path: string, label: string): OmpDiskSkill | undefined {
  const raw = readFileSoft(path);
  if (raw === undefined) return undefined;
  const parsed = parseMarkdownTemplate(raw);
  // Frontmatter `name:` may rename the skill; default to the directory/file name.
  let name = "";
  const frontmatterName = /^---\n[\s\S]*?^name:\s*(\S+)/m.exec(raw);
  if (frontmatterName !== null) name = frontmatterName[1];
  if (name === "") {
    const base = path.split("/").pop() ?? "";
    name = base.toLowerCase() === "skill.md" ? (path.split("/").at(-2) ?? base) : base.replace(/\.md$/i, "");
  }
  return {
    name,
    description: parsed.description,
    filePath: path,
    baseDir: path.slice(0, path.lastIndexOf("/")) || path,
    source: label,
  };
}

/**
 * Read every discovered skill from the discovery roots: the Agent Skills
 * standard `<root>/<name>/SKILL.md` layout, plus a lenient flat `<root>/*.md`.
 * Deterministic output: deduped by name (scan order, first wins), then sorted.
 */
export function readSkills(cwd?: string): OmpDiskSkill[] {
  const byName = new Map<string, OmpDiskSkill>();
  for (const root of discoveryRoots(cwd, "skills")) {
    const dir = join(root.base, root.subdir);
    if (!existsSync(dir)) continue;
    let entries: { name: string; isDirectory: boolean }[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = entry.isDirectory
        ? join(dir, entry.name, "SKILL.md")
        : join(dir, entry.name);
      if (!entry.isDirectory && !entry.name.toLowerCase().endsWith(".md")) continue;
      if (entry.isDirectory && byName.has(entry.name)) continue;
      const skill = readSkillFile(path, root.label);
      if (skill === undefined || byName.has(skill.name)) continue;
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}
