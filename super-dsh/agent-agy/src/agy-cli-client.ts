/**
 * agy-cli-client.ts — primary live path: the agy CLI headless stream-json
 * session (`agy --print --input-format stream-json --output-format stream-json`).
 *
 * Auth: GEMINI_API_KEY env (adapter stores the key; never written to native
 * home) + `modelProvider: "gemini"` merged into the CLI's own settings file
 * (~/.gemini/antigravity-cli/settings.json — single-key merge, user-sanctioned
 * 2026-09-18). Geofenced deployments pass HTTPS_PROXY via AGY_PROXY.
 *
 * Event mapping (superset of the SDK bridge — CLI is richer):
 *   init            → tools list + permission mode (trace)
 *   step_update     → system_message | agent_response (text deltas) |
 *                     tool (ACTIVE→tool_call, DONE→tool_result w/ output)
 *   result          → done (conversation_id for resume via --conversation)
 *
 * Same surface as AgyBridgeClient so AgyAgent needs no changes.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AgyCliOptions {
  /** Key or a resolver (onboarding-saved keys become visible at first spawn). */
  apiKey: string | (() => string | undefined);
  model?: string;
  /** CLI --effort (low|medium|high) — required by 3.x flash models. */
  effort?: string;
  cwd: string;
  /** Resume an existing conversation id (second+ spawn of the same session). */
  conversationId?: string;
  /** Forward proxy for the geo-fenced Gemini API (dev3 gost et al). */
  proxy?: string;
  /**
   * danger-full-access preset → append --dangerously-skip-permissions
   * (headless has no interactive approval; workspace-write/read-only keep
   * the CLI default request-review, whose headless soft-deny is honest).
   */
  skipPermissions?: boolean;
  /** agy binary override (tests point at a mock). */
  agyBin?: string;
  /** Native CLI settings dir override (tests; prod: ~/.gemini). */
  nativeCliHome?: string;
  /**
   * HOME override for the spawned agy. The account-OAuth/gcp token in the
   * real home triggers the region-eligibility gate; an isolated home with
   * only settings.json + GEMINI_API_KEY runs the pure API-key path.
   */
  home?: string;
  spawnAttempts?: number;
  trace?: (...parts: unknown[]) => void;
}

export type CliEvent =
  | { event: "ready"; tools: number; permissionMode?: string }
  | { event: "system_message"; text: string }
  | { event: "chunk"; text: string }
  | { event: "tool_call"; id: string; name: string; args: string }
  | { event: "tool_result"; id: string; name: string; is_error: boolean; result: string }
  | { event: "usage"; input_tokens: number; output_tokens: number; thinking_tokens: number; total_tokens: number }
  | { event: "done"; conversation_id: string; turn_ms: number }
  | { event: "error"; error: string; recoverable: boolean };

/** Merge `modelProvider: "gemini"` into the CLI's own settings (single key). */
export function ensureCliKeyMode(nativeCliHome: string): void {
  const dir = join(nativeCliHome, "antigravity-cli");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(p)) {
    try {
      settings = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  if (settings.modelProvider === "gemini") return;
  settings.modelProvider = "gemini";
  writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
}

interface StepUpdate {
  step_index?: number;
  state?: string;
  step_type?: string;
  text_delta?: string;
  tool_name?: string;
  tool_info?: { name?: string; parameters?: Record<string, unknown>; output?: string };
  usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; total_tokens?: number };
}

export class AgyCliClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly waiters: Array<(ev: CliEvent) => void> = [];
  private readonly pending: CliEvent[] = [];
  private readonly opts: AgyCliOptions;
  private dead = false;
  private conversationIdValue = "";
  private toolsSeen = 0;

  onThinkingDelta?: (text: string) => void;
  onToolEvent?: (ev: { event: "tool_call"; id: string; name: string; args: string } | { event: "tool_result"; id: string; name: string; is_error: boolean; result: string }) => void;
  setApprovalHandler(_handler: (req: { id: string; tool: string; args: string }) => Promise<boolean>): void {
    // CLI ask-mode approval is not wired in this iteration (approval_mode
    // stays request-review; tools soft-deny in headless).
  }
  setSystemMessageHandler(handler: (text: string) => void): void {
    this.onSystemMessage = handler;
  }
  private onSystemMessage?: (text: string) => void;

  constructor(opts: AgyCliOptions) {
    this.opts = opts;
  }

  get conversationId(): string {
    return this.conversationIdValue;
  }

  get lastUsage(): { input_tokens: number; output_tokens: number; thinking_tokens: number; total_tokens: number } | undefined {
    return this.lastUsageValue;
  }
  private lastUsageValue: { input_tokens: number; output_tokens: number; thinking_tokens: number; total_tokens: number } | undefined;

  private nativeCliHome(): string {
    return this.opts.nativeCliHome ?? join(process.env.HOME ?? "", ".gemini");
  }

  private spawnCli(): void {
    if (this.child || this.dead) return;
    ensureCliKeyMode(this.nativeCliHome());
    const attempts = this.opts.spawnAttempts ?? 3;
    const agyBin = this.opts.agyBin ?? "agy";
    // Order matters: --print swallows the next token as a prompt value
    // (flag-collision, A2A skill) — keep it LAST, after all value flags.
    // = form everywhere: bare value flags swallow the next token (collision).
    const args = [
      "--input-format=stream-json", "--output-format=stream-json",
      "--disable-slash-commands",
    ];
    if (this.opts.conversationId) args.push(`--conversation=${this.opts.conversationId}`);
    if (this.opts.model) args.push(`--model=${this.opts.model}`);
    if (this.opts.effort) args.push(`--effort=${this.opts.effort}`);
    if (this.opts.skipPermissions) args.push("--dangerously-skip-permissions");
    // NOTE: no --print — stream-json input mode reads prompts from stdin
    // (verified); --print would demand a prompt argument and exit code 2.
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const key = typeof this.opts.apiKey === "function" ? this.opts.apiKey() : this.opts.apiKey;
        if (!key) throw new Error("agy cli: no GEMINI_API_KEY resolved");
        const env: NodeJS.ProcessEnv = { ...process.env, GEMINI_API_KEY: key, NO_PROXY: "127.0.0.1,localhost" };
        if (this.opts.home) env.HOME = this.opts.home;
        if (this.opts.proxy) { env.HTTPS_PROXY = this.opts.proxy; env.HTTPS_PROXY = this.opts.proxy; }
        this.child = spawn(agyBin, args, { cwd: this.opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        break;
      } catch (err) {
        lastError = err;
        this.opts.trace?.(`spawn attempt ${attempt} failed:`, err);
      }
    }
    if (!this.child) throw lastError ?? new Error("agy spawn failed");
    const child = this.child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => this.consume(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => this.opts.trace?.("[agy stderr]", d.trimEnd()));
    child.on("exit", (code) => {
      this.child = undefined;
      this.dispatch({ event: "error", error: `agy exited code=${code}`, recoverable: !this.dead });
    });
  }

  private consume(data: string): void {
    this.buffer += data;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        this.opts.trace?.("bad agy json:", line.slice(0, 120), err);
        continue;
      }
      if (parsed.event === "init") {
        const init = parsed.init as { tools?: string[]; permission_mode?: string } | undefined;
        this.toolsSeen = Array.isArray(init?.tools) ? init.tools.length : 0;
        this.dispatch({ event: "ready", tools: this.toolsSeen, permissionMode: init?.permission_mode });
      } else if (parsed.event === "step_update") {
        this.consumeStep(parsed.step_update as StepUpdate);
      } else if (parsed.event === "result") {
        const r = parsed.result as { conversation_id?: string; status?: string; error?: string } | undefined;
        if (r?.conversation_id) this.conversationIdValue = r.conversation_id;
        if (r?.status !== "SUCCESS") {
          this.dispatch({ event: "error", error: r?.error ?? `agy result status=${r?.status}`, recoverable: false });
        } else {
          this.dispatch({ event: "done", conversation_id: this.conversationIdValue, turn_ms: 0 });
        }
      }
    }
  }

  private consumeStep(su: StepUpdate): void {
    const st = su.step_type;
    if (st === "system_message") {
      this.onSystemMessage?.(su.text_delta ?? "");
      return;
    }
    if (st === "agent_response") {
      // Short turns carry their delta on the DONE frame — dispatch any delta.
      if (su.text_delta) {
        this.dispatch({ event: "chunk", text: su.text_delta });
      }
      if (su.usage) {
        this.lastUsageValue = {
          input_tokens: su.usage.input_tokens ?? 0,
          output_tokens: su.usage.output_tokens ?? 0,
          thinking_tokens: su.usage.thinking_tokens ?? 0,
          total_tokens: su.usage.total_tokens ?? 0,
        };
        this.dispatch({
          event: "usage",
          input_tokens: this.lastUsageValue.input_tokens,
          output_tokens: this.lastUsageValue.output_tokens,
          thinking_tokens: this.lastUsageValue.thinking_tokens,
          total_tokens: this.lastUsageValue.total_tokens,
        });
      }
      return;
    }
    if (st === "tool") {
      const name = su.tool_name ?? su.tool_info?.name ?? "unknown";
      const id = `${this.conversationIdValue}:${su.step_index ?? 0}`;
      if (su.state === "ACTIVE") {
        this.dispatch({
          event: "tool_call", id, name,
          args: JSON.stringify(su.tool_info?.parameters ?? {}),
        });
        this.onToolEvent?.({ event: "tool_call", id, name, args: JSON.stringify(su.tool_info?.parameters ?? {}) });
      } else if (su.state === "DONE" || su.state === "ERROR") {
        const output = su.tool_info?.output ?? "";
        const isError = su.state === "ERROR";
        this.dispatch({
          event: "tool_result", id, name, is_error: isError,
          result: output || (isError ? "tool failed" : "[agy CLI reported no output summary]"),
        });
        this.onToolEvent?.({
          event: "tool_result", id, name, is_error: isError,
          result: output || (isError ? "tool failed" : "[agy CLI reported no output summary]"),
        });
      }
    }
  }

  private dispatch(ev: CliEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(ev);
    else this.pending.push(ev);
  }

  private nextEvent(): Promise<CliEvent> {
    const pending = this.pending.shift();
    if (pending) return Promise.resolve(pending);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.child) throw new Error("agy not running");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** One turn. First call spawns the CLI (lazy per §14-i) and keeps it resident. */
  async *turn(text: string): AsyncGenerator<string, string, void> {
    this.spawnCli();
    await this.expectReady();
    this.send({ event: "user", message: { content: text } });
    let full = "";
    for (;;) {
      const ev = await this.nextEvent();
      if (ev.event === "chunk") {
        full += ev.text;
        yield ev.text;
      } else if (ev.event === "system_message") {
        this.onSystemMessage?.(ev.text);
      } else if (ev.event === "tool_call" || ev.event === "tool_result") {
        this.onToolEvent?.(ev);
      } else if (ev.event === "usage") {
        this.lastUsageValue = {
          input_tokens: ev.input_tokens, output_tokens: ev.output_tokens,
          thinking_tokens: ev.thinking_tokens, total_tokens: ev.total_tokens,
        };
      } else if (ev.event === "done") {
        return full;
      } else if (ev.event === "error") {
        throw new Error(`agy cli: ${ev.error}`);
      }
    }
  }

  private readyReceived = false;

  private async expectReady(): Promise<void> {
    if (this.readyReceived) return;
    for (;;) {
      const ev = await this.nextEvent();
      if (ev.event === "ready") {
        this.readyReceived = true;
        return;
      }
      if (ev.event === "error") throw new Error(`agy cli: ${ev.error}`);
    }
  }

  async ping(): Promise<void> {
    this.spawnCli();
    await this.expectReady();
  }

  async close(): Promise<void> {
    if (!this.child) return;
    this.dead = true;
    const child = this.child;
    try { child.stdin.end(); } catch { /* already gone */ }
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 2000).unref();
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    this.child = undefined;
  }
}

