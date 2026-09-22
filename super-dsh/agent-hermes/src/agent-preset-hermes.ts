/**
 * SingleHermesPresetRoster — the profile's `agentPresets` service.
 *
 * Hermes is single-mode: the Hermes agent drives its own tools through the
 * gateway-managed child, so no Dash-side preset composition exists to choose
 * from. But the web surfaces (new-session mode dropdown, Settings → Agent
 * Preset) render from the roster RPC, and an absent roster renders "empty"
 * rather than "one mode". This service publishes exactly one non-authorable
 * preset, `Hermes`, whose composition is deliberately empty — mounting it
 * composes nothing, exactly the rosterless behavior the provider runs on.
 *
 * REGISTRATION LESSON (ported verbatim from the omp bridge): this service
 * must be constructed on the PROVIDER's own top-level fiber, never under
 * `ctx.plugin(...)` — a child fiber hides its @Remote routes from the
 * API gateway's root-level remote enumeration and every agentPresets/* call
 * 404s. The Service constructor ties teardown to that fiber via
 * reflect.provide.
 */
import { type Context } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { type Agent } from "@deepseek-ai/dsh-agent";
import {
  type AgentPreset,
  type AgentPresetDocument,
  type AgentPresetRoster,
} from "@deepseek-ai/dsh-agent-presets";
import type { ScopeKey } from "@deepseek-ai/dsh-scope";

const HERMES_PRESET: AgentPreset = Object.freeze({
  id: "hermes",
  trust: "system",
  path: "",
  name: "Hermes",
  description: "Hermes agent via the agent-hermes adapter",
});

const COMPOSITION_TEXT = [
  "# Hermes (fixed roster)",
  "",
  "This deployment runs exactly one agent mode: the Hermes provider bridges Dash",
  "sessions to a native Hermes agent over the TUI gateway JSON-RPC. There is no",
  "per-session plugin composition to configure, so this preset mounts nothing.",
  "",
  "rows: []",
  "",
].join("\n");

/** The standing scope key every `hermes` session reads presenters through. */
const STANDING_KEY: ScopeKey = {};

export class SingleHermesPresetRoster extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, "agentPresets");
  }

  get defaultId(): string {
    return HERMES_PRESET.id;
  }

  get roots(): readonly never[] {
    return [];
  }

  get authorable(): boolean {
    return false;
  }

  async list(): Promise<AgentPreset[]> {
    return [HERMES_PRESET];
  }

  async resolve(id?: string): Promise<AgentPreset> {
    if (id === undefined || id === HERMES_PRESET.id) return HERMES_PRESET;
    throw new RemoteError("agent-preset/not-found", `agent-presets: preset "${id}" not found (available: hermes)`, { agentPreset: id, available: [HERMES_PRESET.id] });
  }

  async mount(_agentCtx: Context, id?: string): Promise<AgentPreset> {
    return this.resolve(id);
  }

  async recompose(_agentCtx: Context, id: string): Promise<AgentPreset> {
    return this.resolve(id);
  }

  async read(id: string): Promise<string> {
    await this.resolve(id);
    return COMPOSITION_TEXT;
  }

  // ── Remote RPC surface (alpha: agentPresets routes come from @Remote) ────
  // The stock dsh-host-apiproxy mapped cordis methods to routes; alpha serves
  // them from @Remote decorators on a TypertRemoteService. A plain Service
  // registers no routes, which is why Settings → Agent Preset 404'd.

  @Remote("list")
  async remoteList(): Promise<AgentPresetRoster> {
    if (process.env.HERMES_TRACE === "1") process.stderr.write("[hermes-roster] remoteList INVOKED\n");
    return {
      presets: [
        {
          id: HERMES_PRESET.id,
          trust: HERMES_PRESET.trust,
          isDefault: true,
          name: HERMES_PRESET.name,
          description: HERMES_PRESET.description,
        },
      ],
      authorable: this.authorable,
      // 0.1.6 AgentPresetRoster: the new-chat mode selector is hidden without this.
      modeSelectionEnabled: true,
    };
  }

  @Remote("read")
  async remoteRead(agentPreset: string): Promise<AgentPresetDocument> {
    const preset = await this.resolve(agentPreset);
    return {
      agentPreset: preset.id,
      trust: preset.trust,
      content: await this.read(preset.id),
      name: preset.name,
      description: preset.description,
    };
  }

  @Remote("copy")
  async remoteCopy(from: string, id: string, name?: string): Promise<void> {
    await this.copy(from, id, name);
  }

  @Remote("deletePreset")
  async remoteDelete(id: string): Promise<void> {
    await this.remove(id);
  }

  /** Fixed roster: one preset, so selecting it is a no-op ack; anything else is unknown. */
  @Remote("select")
  async remoteSelect(agent: Agent, agentPreset: string): Promise<string> {
    const preset = await this.resolve(agentPreset);
    return preset.id;
  }

  async copy(_from: string, id: string, _name?: string): Promise<void> {
    throw new RemoteError(
      "agent-preset/read-only",
      `agent-presets: preset "${id}" cannot be written: the Hermes roster is fixed and ships exactly one preset`,
      { agentPreset: id, reason: "the Hermes roster is fixed and ships exactly one preset" },
    );
  }

  async remove(id: string): Promise<void> {
    throw new RemoteError(
      "agent-preset/read-only",
      `agent-presets: preset "${id}" cannot be written: the Hermes roster is fixed and ships exactly one preset`,
      { agentPreset: id, reason: "the Hermes roster is fixed and ships exactly one preset" },
    );
  }

  serviceFor(_agent: { ctx: Context }, _name: string): undefined {
    return undefined;
  }

  composeFrom(_agentCtx: Context, _parentCtx: Context): undefined {
    return undefined;
  }

  composedPreset(_agentCtx: Context): string | undefined {
    return HERMES_PRESET.id;
  }

  async standingKeyFor(id?: string): Promise<ScopeKey> {
    await this.resolve(id);
    return STANDING_KEY;
  }
}
