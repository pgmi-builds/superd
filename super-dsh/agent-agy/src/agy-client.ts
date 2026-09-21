/**
 * agy-client.ts — drives the Python SDK bridge (bridge/agy_bridge.py) over
 * JSONL stdio.
 *
 * Discipline (agent-adapter-dev-rules §14-i / §16a):
 * - LAZY: no python child until the first real prompt. `start` config is
 *   buffered and flushed with the first `prompt` (one round trip).
 * - Transient spawn failures retry in-place up to AGY_SPAWN_ATTEMPTS (3);
 *   prompt-level errors are surfaced, never auto-retried.
 * - The agy CLI is never invoked; auth is transparent (api_key param or ADC
 *   environment picked up by the SDK itself).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE_RELATIVE = join("bridge", "agy_bridge.py");

export interface AgyClientOptions {
  /** Gemini API key; omit to let the SDK fall back to ADC. */
  apiKey?: string;
  model?: string;
  /** Thinking level for the start frame (undefined = endpoint default). */
  thinkingLevel?: string;
  /** Tool-approval posture: "allow" (default) auto-approves; "ask" defers to
   *  the onApprovalRequest handler (fail closed). */
  approvalMode?: "allow" | "ask";
  project?: string;
  location?: string;
  workspaces?: string[];
  saveDir?: string;
  /** Python interpreter (test knob; prod resolves via PATH). */
  pythonBin?: string;
  /** Bridge script override (tests point this at a mock). */
  bridgePath?: string;
  spawnAttempts?: number;
  trace?: (...parts: unknown[]) => void;
  /**
   * Host-side approval handler for approval_mode "ask": resolves true=allow.
   * NEVER consulted in "allow" mode. Fail-closed lives with the handler.
   */
  onApprovalRequest?: (req: { id: string; tool: string; args: string }) => Promise<boolean>;
}

export interface AgyTurnUsage {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  total_tokens: number;
}

export type BridgeEvent =
  | { event: "pong" }
  | { event: "started" }
  | { event: "chunk"; text: string }
  | { event: "thinking"; text: string }
  | { event: "tool"; name: string }
  | { event: "tool_call"; id: string; name: string; args: string }
  | { event: "tool_result"; id: string; name: string; is_error: boolean; result: string }
  | { event: "usage"; input_tokens: number; output_tokens: number; thinking_tokens: number; total_tokens: number }
  | { event: "approval_request"; id: string; tool: string; args: string }
  | { event: "done"; conversation_id: string; turn_ms: number }
  | { event: "closed" }
  | { event: "error"; error: string; recoverable: boolean };

export class AgyBridgeClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly waiters: Array<(ev: BridgeEvent) => void> = [];
  private readonly pending: BridgeEvent[] = [];
  private readonly opts: AgyClientOptions;
  private spawnFailures = 0;
  /** Thinking-delta sink (agent buffers these into a reasoning block). */
  onThinkingDelta?: (text: string) => void;
  /** Tool lifecycle sink: tool_call / tool_result (agent writes DSH events). */
  onToolEvent?: (ev: { event: "tool_call"; id: string; name: string; args: string } | { event: "tool_result"; id: string; name: string; is_error: boolean; result: string }) => void;
  /** Bridge-protocol parity for the agent test harness (fake clients). */
  setToolEventHandler?(handler: (ev: { event: "tool_call"; id: string; name: string; args: string } | { event: "tool_result"; id: string; name: string; is_error: boolean; result: string }) => void): void { /* real client uses the property above */ }

  private dead = false;
  private startedSent = false;
  private lastUsageValue: AgyTurnUsage | undefined = undefined;

  /** Per-turn token usage from the bridge (undefined when the bridge skipped it). */
  get lastUsage(): AgyTurnUsage | undefined {
    return this.lastUsageValue;
  }

  /** Register the ask-mode approval handler (agent wires its approval service). */
  setApprovalHandler(handler: NonNullable<AgyClientOptions["onApprovalRequest"]>): void {
    this.opts.onApprovalRequest = handler;
  }
  private conversationIdValue = "";

  constructor(opts: AgyClientOptions = {}) {
    this.opts = opts;
  }

  get conversationId(): string {
    return this.conversationIdValue;
  }

  private resolveBridgePath(): string {
    if (this.opts.bridgePath) return this.opts.bridgePath;
    // dist/agy-client.js → package root is dist/.. (works through the
    // world-profile symlink too: node reports the real path here).
    const here = dirname(fileURLToPath(import.meta.url));
    for (const base of [here, dirname(here)]) {
      const p = join(base, BRIDGE_RELATIVE);
      if (existsSync(p)) return p;
    }
    throw new Error(`agy bridge script not found (${BRIDGE_RELATIVE})`);
  }

  /** Durable venv created by scripts/setup-venv.sh (pkg-root/.venv). */
  private resolvePackagedVenvPython(): string | undefined {
    try {
      const pkgRoot = join(dirname(this.resolveBridgePath()), "..");
      const venv = join(pkgRoot, ".venv", "bin", "python");
      return existsSync(venv) ? venv : undefined;
    } catch {
      return undefined;
    }
  }

  private spawnBridge(): void {
    if (this.child || this.dead) return;
    const attempts = this.opts.spawnAttempts ?? 3;
    const pythonBin = this.opts.pythonBin
      ?? this.resolvePackagedVenvPython()
      ?? process.env.AGY_PYTHON
      ?? "python3";
    const bridgePath = this.resolveBridgePath();
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        this.child = spawn(pythonBin, [bridgePath], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        break;
      } catch (err) {
        this.opts.trace?.(`spawn attempt ${attempt} failed:`, err);
        if (attempt === attempts) throw err;
      }
    }
    const child = this.child!;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => this.consume(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => this.opts.trace?.("[bridge stderr]", d.trimEnd()));
    child.on("exit", (code) => {
      this.child = undefined;
      this.opts.trace?.(`bridge exited code=${code}`);
      this.dispatch({ event: "error", error: `bridge exited code=${code}`, recoverable: !this.dead });
    });
  }

  private consume(data: string): void {
    this.buffer += data;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as BridgeEvent;
        if (ev.event === "done" && ev.conversation_id) this.conversationIdValue = ev.conversation_id;
        this.dispatch(ev);
      } catch (err) {
        this.opts.trace?.("bad bridge json:", line, err);
      }
    }
  }

  private dispatch(ev: BridgeEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(ev);
    else this.pending.push(ev);
  }

  private nextEvent(): Promise<BridgeEvent> {
    const pending = this.pending.shift();
    if (pending) return Promise.resolve(pending);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.child) throw new Error("bridge not running");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Wait for a specific event kind, surfacing `error` events as throws. */
  private async expect(kind: BridgeEvent["event"]): Promise<BridgeEvent> {
    for (;;) {
      const ev = await this.nextEvent();
      if (ev.event === kind) return ev;
      if (ev.event === "error") throw new Error(`agy bridge: ${ev.error}`);
    }
  }

  /** Ping round trip (spawns the bridge if needed — use for liveness probes). */
  async ping(): Promise<void> {
    this.spawnBridge();
    this.send({ op: "ping" });
    await this.expect("pong");
  }

  /**
   * Run one turn. First call materializes the bridge child and sends the
   * buffered `start` config followed by `prompt` (lazy spawn per §14-i).
   * Yields streamed text chunks; resolves with the full turn text.
   */
  async *turn(text: string): AsyncGenerator<string, string, void> {
    this.spawnBridge();
    if (!this.startedSent) {
      this.send({
        op: "start",
        model: this.opts.model,
        ...(this.opts.thinkingLevel === undefined ? {} : { thinking_level: this.opts.thinkingLevel }),
        ...(this.opts.approvalMode === undefined ? {} : { approval_mode: this.opts.approvalMode }),
        api_key: this.opts.apiKey,
        project: this.opts.project,
        location: this.opts.location,
        workspaces: this.opts.workspaces,
        save_dir: this.opts.saveDir,
      });
      await this.expect("started");
      this.startedSent = true;
    }
    this.send({ op: "prompt", text, conversation_id: this.conversationIdValue || undefined });
    let full = "";
    this.lastUsageValue = undefined;
    for (;;) {
      const ev = await this.nextEvent();
      if (ev.event === "chunk") {
        full += ev.text;
        yield ev.text;
      } else if (ev.event === "thinking") {
        this.onThinkingDelta?.(ev.text);
      } else if (ev.event === "tool_call" || ev.event === "tool_result") {
        this.onToolEvent?.(ev);
      } else if (ev.event === "tool") {
        this.opts.trace?.("tool (legacy)", ev.name);
      } else if (ev.event === "usage") {
        this.lastUsageValue = ev;
      } else if (ev.event === "approval_request") {
        // ask mode only; fail closed when no handler / handler throws.
        let allow = false;
        try {
          allow = this.opts.onApprovalRequest
            ? await this.opts.onApprovalRequest({ id: ev.id, tool: ev.tool, args: ev.args })
            : false;
        } catch (err) {
          this.opts.trace?.("approval handler failed — deny:", err);
          allow = false;
        }
        this.send({ op: "approval", id: ev.id, allow });
      } else if (ev.event === "done") {
        return full;
      } else if (ev.event === "error") {
        throw new Error(`agy bridge: ${ev.error}`);
      }
    }
  }

  async close(): Promise<void> {
    if (!this.child) return;
    this.dead = true;
    try {
      this.send({ op: "close" });
    } catch {
      /* child already gone */
    }
    const child = this.child;
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 2000).unref();
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
    this.child = undefined;
  }
}

/** Convenience: read the venv python path recorded by scripts/setup-venv.sh. */
export function resolveVenvPython(worldHome: string): string | undefined {
  const p = join(worldHome, "agy-venv-python.txt");
  if (!existsSync(p)) return undefined;
  const v = readFileSync(p, "utf8").trim();
  return v || undefined;
}
