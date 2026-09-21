/**
 * Claude Code's observed slash commands, registered onto `ctx.commands`.
 *
 * Claude owns a command surface (`session_init.slash_commands`): `/mcp`,
 * `/clear`, `/review`, plugin-namespaced commands, and so on. DSH exposes its
 * own registry to the composer, so the adapter mirrors each observed Claude
 * command there and lets the user pick it from the same menu.
 *
 * Two deliberate rules:
 *
 * - **Every registered id is `claude-<name>`.** Prefixing is total — the id is
 *   the only thing this module writes to the shared registry, so it must be
 *   collision-free with DSH's own `/compact`, `/plan`, `/permission`, … AND
 *   self-explanatory about its owner. A name that already carries the prefix is
 *   still prefixed once more (`claude-mcp` -> `claude-claude-mcp`): de-prefixing
 *   would alias two genuinely distinct observed names onto one id.
 * - **The handler forwards, it never renders.** `submit` receives
 *   `/mcp` plus the raw tail exactly as the user typed it (the registry hands
 *   the tail through unnormalized), so Claude's own command parser sees its
 *   original line. The panel/output for the command flows back through the
 *   ordinary transcript projection.
 *
 * The invocation's id is sanitized for DSH's command-id grammar
 * (`^[a-z][a-z0-9_-]*$`) — lowercase, invalid runs become `-` — but the
 * FORWARDED line keeps the observed spelling, so sanitizing is invisible to
 * Claude.
 */
// No Cordis import: the runtime surface this module needs is described
// structurally below, which keeps the module loadable (and testable) without a
// Cordis host, and keeps the adapter's runtime dependency set unchanged.

/** One Claude slash command as observed from the runtime's `session_init`. */
export interface SlashCommandLike {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
}

/** The slice of the runtime's `CommandInvocation` this handler reads. */
export interface CommandInvocationLike {
  /** Exact agent whose UI received the command. */
  readonly agent: unknown;
  /** Exact text following the registered command name, including separator whitespace. */
  readonly rawInput: string;
}

/**
 * The handler's outcome.
 *
 * `{ kind: 'success' }` with no `text` and no `sourceEventSeq`, deliberately.
 * Upstream's `CommandResult` union is `{ kind: 'success'; text?; sourceEventSeq? }
 * | { kind: 'error'; text }` and `normalizeResult` throws on any other kind, so
 * the original brief's `{ kind: 'handled' }` would have thrown on the first live
 * dispatch; the plan is corrected to `success` (2026-09-16).
 *
 * No `text`: `submit` has already queued the raw Claude line as an ordinary user
 * turn, which is where the real output appears — an acknowledgment string here
 * would render a second narrative beside that turn. No `sourceEventSeq`: the
 * forwarded user message's sequence does not exist yet when the handler returns,
 * so any value would be fabricated.
 */
export interface ClaudeCommandResult {
  readonly kind: "success";
}
/** One registration handed to the runtime. */
export interface ClaudeCommandDefinition {
  /** `claude-` prefixed, grammar-valid command id. */
  readonly name: string;
  /** Always non-empty (the registry rejects an empty summary). */
  readonly description: string;
  /** Omitted entirely when Claude advertised no argument hint. */
  readonly input?: { readonly hint: string };
  readonly handler: (invocation: CommandInvocationLike) => ClaudeCommandResult;
}

/** Minimal structural view of `@deepseek-ai/dsh-commands`' `CommandRuntime`. */
export interface CommandRuntimeLike {
  register(definition: ClaudeCommandDefinition): () => void;
}

/** Everything this module needs from the provider that owns it. */
export interface ClaudeCommandDeps {
  /** The Claude commands currently observed for the session. */
  listSlashCommands(): readonly SlashCommandLike[];
  /** Hand one exact Claude slash line to the runtime (no rendering here). */
  submit(agent: unknown, line: string): void;
}

/** DSH's command-id grammar (`@deepseek-ai/dsh-commands`' `COMMAND_NAME`). */
const COMMAND_ID_BODY = /[^a-z0-9_-]+/gu;

/**
 * Sanitize one observed Claude name into a `claude-` prefixed DSH command id.
 *
 * The prefix guarantees the grammar's leading-lowercase-letter requirement, so
 * the only work left is mapping the body to `[a-z0-9_-]`. The mapping is total
 * and deterministic: uppercase folds, every invalid run becomes one `-`.
 *
 * @returns the command id, or `undefined` when nothing usable is left.
 */
function claudeCommandId(observed: string): string | undefined {
  const body = observed.toLowerCase().replace(COMMAND_ID_BODY, "-");
  return body === "" ? undefined : `claude-${body}`;
}

/**
 * Build the discovery summary. The registry rejects an empty description, so a
 * missing/blank observed one falls back to a constant; a real one is prefixed
 * so every entry in the menu declares its owner.
 */
function claudeDescription(observed: unknown): string {
  const text = typeof observed === "string" ? observed.trim() : "";
  return text === "" ? "Claude Code slash command" : `Claude Code: ${text}`;
}

/** The observed name, trimmed; blank/non-string input yields `""` (skip). */
function observedName(command: SlashCommandLike): string {
  const raw: unknown = command?.name;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Normalize ONE reported entry — a bare name string (`session_init.slash_commands`
 * is `string[]`) or an SDK `SlashCommand` object (`supportedCommands()` carries
 * the description and argument hint) — into the shape this module registers.
 *
 * @returns the entry, or `undefined` when the report carries no usable name.
 */
function reportedEntry(raw: unknown): SlashCommandLike | undefined {
  const record: Record<string, unknown> | undefined = typeof raw === "string"
    ? { name: raw }
    : typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : undefined;
  if (record === undefined) return undefined;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name === "") return undefined;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const argumentHint = typeof record.argumentHint === "string" ? record.argumentHint.trim() : "";
  return {
    name,
    ...description === "" ? {} : { description },
    ...argumentHint === "" ? {} : { argumentHint },
  };
}

/**
 * Normalize everything Claude reported about its command surface into the
 * registration list, de-duplicated by name (first report wins — the SDK's
 * `aliases` are alternate spellings of the same command, deliberately NOT
 * separate menu entries).
 *
 * Accepts the `session_init` name list and the richer `supportedCommands()`
 * objects through the same door, so the two observation sources cannot drift
 * in their filtering rules.
 *
 * @param raw - the reported array, in either shape; anything else yields `[]`.
 * @returns the usable entries in report order.
 */
export function slashCommandsFromReported(raw: unknown): SlashCommandLike[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const entries: SlashCommandLike[] = [];
  for (const item of raw) {
    const entry = reportedEntry(item);
    if (entry === undefined || seen.has(entry.name)) continue;
    seen.add(entry.name);
    entries.push(entry);
  }
  return entries;
}
/**
 * Mirror every observed Claude slash command onto `ctx.commands`.
 *
 * Skips (never throws on) an observed entry whose name is absent, non-string,
 * or blank; de-duplicates by resulting command id so a repeated observation
 * cannot double-register; and rolls back (releases) every registration already
 * made when a later `register` throws, so a partial mirror never leaks.
 *
 * @param ctx - a context whose `commands` registry is reachable.
 * @param deps - the observed command list plus the exact-line submit sink.
 * @returns a disposer that releases EVERY registration this call made (once).
 */
export function registerClaudeCommands(
  ctx: { commands: CommandRuntimeLike },
  deps: ClaudeCommandDeps,
): () => void {
  const disposers: Array<() => void> = [];
  const registered = new Set<string>();
  let disposed = false;

  /** Release every registration made so far; the returned disposer, guarded. */
  const disposeAll = (): void => {
    if (disposed) return;
    disposed = true;
    let firstError: unknown;
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (error) {
        // One bad disposer must not strand the others: collect and re-raise.
        if (firstError === undefined) firstError = error;
      }
    }
    if (firstError !== undefined) throw firstError;
  };

  try {
    for (const command of deps.listSlashCommands() ?? []) {
      const observed = observedName(command);
      if (observed === "") continue;
      const name = claudeCommandId(observed);
      if (name === undefined || registered.has(name)) continue;
      registered.add(name);

      const hint: unknown = command?.argumentHint;
      const trimmedHint = typeof hint === "string" ? hint.trim() : "";
      const dispose = ctx.commands.register({
        name,
        description: claudeDescription(command?.description),
        ...trimmedHint === "" ? {} : { input: { hint: trimmedHint } },
        handler: (invocation) => {
          deps.submit(invocation.agent, `/${observed}${invocation.rawInput}`);
          return { kind: "success" };
        },
      });
      if (typeof dispose === "function") disposers.push(dispose);
    }
  } catch (error) {
    // A partial registration must not leak: release what landed, then report
    // the original failure (a disposer's own throw must not mask it).
    try {
      disposeAll();
    } catch {
      /* the registration failure below stays the reported one */
    }
    throw error;
  }

  return disposeAll;
}

