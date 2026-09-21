# Agent-Claude Adapter（Claude Code via 官方 Agent SDK）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把本机安装的 Claude Code（经官方 Agent SDK 作桥）接成一个自洽的 dsh standalone web app —— `dsh + @pgmi-builds/agent-adapter-claude` ≈ omp-web。

**Architecture:** 一个 dsh adapter 包 = bundle patch（挂 provider、禁原生 loop/llm 行、pin browse 目录选择器）+ 一个 `AgentFactory`（`createAgent`/`resume` 持 DSH 会话日志写通道，走上游 `sessionPersistence`）。SDK 是**桥**：`query()` 以 streaming input 模式长活，`pathToClaudeCodeExecutable` 指宿主 `claude`；每会话懒物化、idle TTL 拆除、resume 只重挂不驱动轮次。Claude 的用户交互原语映射到 DSH 原生面（`ctx.approval` / `ctx.userQuestions`），映射表见 spec §6.5。

**Tech Stack:** TypeScript（host half，`tsc → dist/`）、Node 22 ESM、`@deepseek-ai/cordis@4.0.2`、`@anthropic-ai/claude-agent-sdk@0.3.263`（exact-pin）、`node:test`（`test/*.test.mjs` 跑 `dist/`）、`@deepseek-ai/dsh-{agent,session,session-persistence,llm,user-approval,user-questions,commands}`。

**Spec:** `docs/superpowers/plans/2026-09-16-agent-claude-adapter-study.md`（裁决 R1–R14 + §6.5 映射表 + §10 T0 取证项）。执行者必须同时读 spec 与本计划。

## Global Constraints

- **上游源码零修改**；依赖 **exact-pin**（无 `^`）；一切改动只在 `apps/agent-worlds/agent-claude/*` 与 profile patch 层。
- **绝不触碰** `~/.dsh`、`~/.superd`（prod home 红线）；dev/test 一律 `DSH_HOME=<repo>/.superd-test`。
- **单实例纪律**：任何 install 后跑 `node scripts/heal-modules.mjs`；`find node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l` 只应剩本仓自有物理包。
- **拉起/关停**只用 `systemd-run --user` / `systemctl --user stop`；不从 agent 沙箱直拉 daemon。
- **端口**：standalone app 取 **4989**（预检占用即拒）；prod 3080/3081 不动。
- **命名**：包 `@pgmi-builds/agent-adapter-claude`；plugin id `aw.agent-adapter-claude-world`；roster key `claude`、label `Claude`；**LLM route id 必须是 `claude`**（上游 `@deepseek-ai/dsh-subagent-claude-code` 已占 subagent providerName `claude-code`，不得撞名）。
- **Home**：app home `$DSH_HOME/agents/claude`；profile `$DSH_HOME/profiles/claude`。**session cwd = 用户 workspace，绝不指 app home。**
- **执行体**：`pathToClaudeCodeExecutable` 指宿主 `/home/u1/.local/bin/claude`；readiness 同时报告宿主与 SDK 载荷两个版本（诊断用）。
- **dialogKind**：V1 **不提供** `onUserDialog`，**不声明** `supportedDialogKinds`（spec §6.5：声明是承诺，declared-but-unwired 是 fail-open 悬挂）。
- **禁用真私有 `#` 方法**（Cordis tracing-proxy 会抛 `Receiver must be an instance of class X`）——一律 TS-`private`。
- **占位/降级值禁止外流**：fail-soft 占位模型不得写进 settings、不得传给真实 runtime；降级必须显式 skip 并留痕。
- **验收是运行时行为**：起真实例 + 真 runtime turn；单测绿只是构建卫生。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `agent-claude/package.json` | 包身份、`dsh.bundle.patch`、`./world` export、exact-pin 依赖 |
| `agent-claude/tsconfig.json` | `tsc → dist/`，`paths` 指向 `types/` 手写声明 |
| `agent-claude/cordis.patch.yml` | bundle 层：挂 provider、禁原生 loop/llm/presets、pin browse picker |
| `agent-claude/src/claude-home.ts` | app home 解析 + prod-home 守卫 + 原生配置单向阀播种（纯逻辑可单测） |
| `agent-claude/src/session-id.ts` | DSH session id ↔ Claude session id 锚定（路线 A，纯逻辑） |
| `agent-claude/src/input-queue.ts` | streaming input 的 push 式 AsyncIterable（纯逻辑可单测） |
| `agent-claude/src/claude-client.ts` | SDK 桥的生命周期：懒物化、refcount 单例、prompt/followUp/steer/interrupt/setModel/setPermissionMode/close |
| `agent-claude/src/claude-events.ts` | SDK 消息 → 中性 wire 事件投影（投影表，纯逻辑） |
| `agent-claude/src/models.ts` | 模型目录快照（来自 `system/init` / `supportedModels()`） |
| `agent-claude/src/adapter.ts` | `ClaudeLlmAdapter`（route `claude`；`stream()` 抛错） |
| `agent-claude/src/permission.ts` | Claude 权限档 ↔ DSH 3 档 preset 映射表 |
| `agent-claude/src/interaction.ts` | `canUseTool`→`ctx.approval`；`AskUserQuestion`/`ExitPlanMode`→`ctx.userQuestions` |
| `agent-claude/src/commands.ts` | Claude slash 命令 ↔ DSH `ctx.commands` |
| `agent-claude/src/index.ts` | `ClaudeProvider extends Service implements AgentFactory`（create/resume、DSH 持久化、发布） |
| `agent-claude/src/world-plugin.ts` | `./world` 入口（供上层打包接 hub；本计划**不**做 hub 侧接线） |
| `agent-claude/scripts/setup-claude-home.mjs` | 单向阀播种 CLI（幂等 + prod-home 守卫） |
| `agent-claude/test/*.test.mjs` | 各模块单测（跑 `dist/`） |
| `agent-claude/test/verify-claude-app.mjs` | 形态 A 端到端验收（HTTP wire create→prompt→readback） |
| `apps/agent-worlds/test/start-claude-app.sh` | 起 standalone app（4989 + LAN relay） |

---

### Task 1: 包骨架 + app home 与单向阀

**Files:**
- Create: `apps/agent-worlds/agent-claude/package.json`
- Create: `apps/agent-worlds/agent-claude/tsconfig.json`
- Create: `apps/agent-worlds/agent-claude/src/claude-home.ts`
- Create: `apps/agent-worlds/agent-claude/scripts/setup-claude-home.mjs`
- Test: `apps/agent-worlds/agent-claude/test/claude-home.test.mjs`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `resolveClaudeHome(home?: string): string` —— `<home>/agents/claude`
  - `assertNotProdHome(path: string, label: string): void` —— 命中 `~/.dsh` / `~/.superd` 前缀即抛
  - `seedClaudeHome(opts: { source: string; dest: string; files: readonly string[] }): string[]` —— 幂等拷贝，返回本轮新拷入的文件名

- [ ] **Step 1: 写失败测试**

```js
// agent-claude/test/claude-home.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveClaudeHome, assertNotProdHome, seedClaudeHome } = await import("../dist/claude-home.js");

test("resolveClaudeHome nests the agent app home under the DSH home", () => {
  assert.equal(resolveClaudeHome("/tmp/h"), "/tmp/h/agents/claude");
});

test("assertNotProdHome refuses the prod homes", () => {
  assert.throws(() => assertNotProdHome("/home/u1/.dsh/agents/claude", "home"), /refusing prod home/);
  assert.throws(() => assertNotProdHome("/home/u1/.superd/x", "home"), /refusing prod home/);
  assert.doesNotThrow(() => assertNotProdHome("/tmp/superd/.superd-test/agents/claude", "home"));
});

test("seedClaudeHome copies once and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-home-"));
  const source = join(root, "native");
  const dest = join(root, "app", "agents", "claude");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "settings.json"), '{"env":{"X":"1"}}');
  const first = seedClaudeHome({ source, dest, files: ["settings.json"] });
  assert.deepEqual(first, ["settings.json"]);
  writeFileSync(join(dest, "settings.json"), '{"env":{"X":"2"}}');
  const second = seedClaudeHome({ source, dest, files: ["settings.json"] });
  assert.deepEqual(second, [], "existing file must not be overwritten");
  assert.equal(JSON.parse(readFileSync(join(dest, "settings.json"), "utf8")).env.X, "2");
  assert.ok(existsSync(dest));
});

test("seedClaudeHome throws on a missing requested source and still short-circuits an existing dest", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-home-miss-"));
  const source = join(root, "native");
  const dest = join(root, "app", "agents", "claude");
  mkdirSync(source, { recursive: true });
  // nothing written at the source: a requested file is missing -> fatal, named
  assert.throws(
    () => seedClaudeHome({ source, dest, files: ["settings.json"] }),
    /source file is missing: .*settings\.json/,
  );
  // an existing dest short-circuits before the source check -> no throw
  writeFileSync(join(dest, "settings.json"), "{}");
  assert.deepEqual(seedClaudeHome({ source, dest, files: ["settings.json"] }), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/claude-home.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/claude-home.js'`（`dist/` 空）

- [ ] **Step 3: 写 package.json / tsconfig.json / claude-home.ts**

`package.json`（exact-pin；`dsh.bundle.patch` 指向 patch 层）：

```json
{
  "name": "@pgmi-builds/agent-adapter-claude",
  "version": "0.0.1-aw",
  "description": "Claude Code provider for DeepSeek Harness (dsh) — an AgentFactory that bridges the host Claude Code CLI through the official @anthropic-ai/claude-agent-sdk into the Dash Agent/Session contracts (Agent Worlds, standalone form).",
  "type": "module",
  "main": "dist/index.js",
  "exports": { ".": "./dist/index.js", "./world": "./dist/world-plugin.js" },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "node --test test/*.test.mjs" },
  "dependencies": { "@anthropic-ai/claude-agent-sdk": "0.3.263" },
  "devDependencies": { "@types/node": "^26.2.0", "typescript": "^5.6.0" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-agent": "0.1.5-rc.2",
    "@deepseek-ai/dsh-commands": "0.1.5-rc.2",
    "@deepseek-ai/dsh-llm": "0.1.5-rc.2",
    "@deepseek-ai/dsh-session": "0.1.5-rc.2",
    "@deepseek-ai/dsh-session-persistence": "0.1.5-rc.2",
    "@deepseek-ai/dsh-user-approval": "0.1.5-rc.2",
    "@deepseek-ai/dsh-user-questions": "0.1.5-rc.2"
  },
  "files": ["dist", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "private": true,
  "license": "MIT",
  "engines": { "node": ">=22.18" }
}
```

`tsconfig.json`：**照抄** `agent-codex/tsconfig.json` 的 `compilerOptions`（`target ES2023`、`module/moduleResolution NodeNext`、`strict`、`outDir dist`、`rootDir src`、`skipLibCheck`），`paths` 保留其全部条目并补 `@deepseek-ai/dsh-user-questions` → `./types/@deepseek-ai/dsh-user-questions/index.d.ts`（`types/` 目录从 `agent-codex/types/` 复制，再补 `dsh-user-questions`）。

`src/claude-home.ts`：

```ts
/**
 * Claude Code app-home resolution and the native-config one-way valve.
 *
 * S7 nested home: the app home is a plain subpath of the resolved DSH home
 * (`<dshHome>/agents/claude`), never an env-derived ambient path. The native
 * `~/.claude` is READ-ONLY: settings are copied in once and never written back.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PROD_HOMES = [join(homedir(), ".dsh"), join(homedir(), ".superd")];

/** Refuse any path that resolves into a production DSH home (repo red line). */
export function assertNotProdHome(path: string, label: string): void {
  const p = resolve(path);
  if (PROD_HOMES.includes(p) || PROD_HOMES.some((prod) => p.startsWith(`${prod}/`))) {
    throw new Error(`agent-claude: refusing prod home "${p}" for ${label} — set DSH_HOME to the test home`);
  }
}

/** The Claude app home: `<dshHome>/agents/claude`. */
export function resolveClaudeHome(home?: string): string {
  const base = resolve(home ?? join(process.cwd(), ".superd-test"));
  return join(base, "agents", "claude");
}

/** Idempotent one-way copy of the native config set; existing files are kept. */
export function seedClaudeHome(opts: { source: string; dest: string; files: readonly string[] }): string[] {
  const source = resolve(opts.source);
  const dest = resolve(opts.dest);
  assertNotProdHome(dest, "dest");
  mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const file of opts.files) {
    const dst = join(dest, file);
    if (existsSync(dst)) continue;
    const src = join(source, file);
    // A requested source that is absent is FATAL, not a skip: `continue` here
    // would conflate "dest already exists" (legitimate idempotency) with
    // "source missing" (a degradation) and leave the caller no trace.
    if (!existsSync(src)) {
      throw new Error(
        `agent-claude: source file is missing: ${src} (requested "${file}") — refusing to skip silently`,
      );
    }
    copyFileSync(src, dst);
    copied.push(file);
  }
  return copied;
}
```

`scripts/setup-claude-home.mjs`：照抄 `agent-codex/scripts/setup-codex-home.mjs` 的结构，改三点——(a) 目标 home 用 `resolveClaudeHome(process.env.DSH_HOME)`；(b) 源 `SOURCE_CLAUDE_HOME ?? ~/.claude`；(c) 拷贝集 `['settings.json']`（本机认证在该文件的 `env` 块里；`skills/`、`commands/`、`agents/` 目录的播种是可选项，V1 不拷）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/claude-home.test.mjs`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
cd apps/agent-worlds && git add agent-claude && git commit -m "feat(agent-claude): package skeleton + nested app home with one-way native config valve"
```

---

### Task 2: Session id 锚定（路线 A）

**Files:**
- Create: `apps/agent-worlds/agent-claude/src/session-id.ts`
- Test: `apps/agent-worlds/agent-claude/test/session-id.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `CLAUDE_SESSION_ID_RE: RegExp` —— `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
  - `isClaudeSessionId(value: unknown): value is string`
  - `claudeSessionIdFromDsh(dshSessionId: string): string | undefined` —— 去 `session-` 前缀后校验；不合法返回 `undefined`（调用方退路线 B 并留痕）

- [ ] **Step 1: 写失败测试**

```js
// agent-claude/test/session-id.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { isClaudeSessionId, claudeSessionIdFromDsh, CLAUDE_SESSION_ID_RE } = await import("../dist/session-id.js");

test("the predicate is version-agnostic and case-insensitive", () => {
  assert.match("01a04826-6d1d-701f-adc3-b834dffc82c5", CLAUDE_SESSION_ID_RE); // v7
  assert.match("f47ac10b-58cc-4372-a567-0e02b2c3d479", CLAUDE_SESSION_ID_RE); // v4
  assert.match("F47AC10B-58CC-4372-A567-0E02B2C3D479", CLAUDE_SESSION_ID_RE);
  assert.equal(isClaudeSessionId("{f47ac10b-58cc-4372-a567-0e02b2c3d479}"), false);
  assert.equal(isClaudeSessionId("urn:uuid:f47ac10b-58cc-4372-a567-0e02b2c3d479"), false);
});

test("claudeSessionIdFromDsh strips the session- prefix and accepts a UUIDv7 tail", () => {
  assert.equal(
    claudeSessionIdFromDsh("session-01a04826-6d1d-701f-adc3-b834dffc82c5"),
    "01a04826-6d1d-701f-adc3-b834dffc82c5",
  );
});

test("claudeSessionIdFromDsh returns undefined for a non-UUID DSH id (route B fallback)", () => {
  assert.equal(claudeSessionIdFromDsh("session-1"), undefined);
  const forced = "session-f47ac10b-58cc-4372-a567-0e02b2c3d479";
  assert.equal(claudeSessionIdFromDsh(forced), "f47ac10b-58cc-4372-a567-0e02b2c3d479");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/session-id.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/session-id.js'`

- [ ] **Step 3: 写实现**

```ts
/**
 * DSH session id <-> Claude session id anchoring (spec ruling R8, route A).
 *
 * The DSH id is `<prefix>-<uuid>` (minted by the session store). Claude accepts
 * any UUID version (its predicate is the version-agnostic regex below, verified
 * byte-identical in the SDK and the CLI). So we preset Claude's sessionId from
 * the DSH id's UUID tail: no mapping file, and the id survives restarts.
 *
 * Route B (SDK-minted id + a persisted map) is the fallback ONLY for a DSH id
 * that is not a UUID; the caller must trace it, never fall back silently.
 */
export const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === "string" && CLAUDE_SESSION_ID_RE.test(value);
}

/** UUID tail of a DSH session id, or `undefined` when it is not a UUID. */
export function claudeSessionIdFromDsh(dshSessionId: string): string | undefined {
  const tail = dshSessionId.replace(/^session-/, "");
  return isClaudeSessionId(tail) ? tail.toLowerCase() : undefined;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/session-id.test.mjs`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
cd apps/agent-worlds && git add agent-claude && git commit -m "feat(agent-claude): mapping-free DSH->Claude session id anchoring (route A)"
```

---

### Task 3: streaming input 队列

**Files:**
- Create: `apps/agent-worlds/agent-claude/src/input-queue.ts`
- Test: `apps/agent-worlds/agent-claude/test/input-queue.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `class InputQueue implements AsyncIterable<SDKUserMessage>`，方法 `push(message): void`、`close(): void`、`get closed(): boolean`

- [ ] **Step 1: 写失败测试**

```js
// agent-claude/test/input-queue.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { InputQueue } = await import("../dist/input-queue.js");

test("InputQueue yields pushed items then closes", async () => {
  const q = new InputQueue();
  q.push({ type: "user", message: { role: "user", content: "a" }, parent_tool_use_id: null });
  q.push({ type: "user", message: { role: "user", content: "b" }, parent_tool_use_id: null });
  q.close();
  const seen = [];
  for await (const item of q) seen.push(item.message.content);
  assert.deepEqual(seen, ["a", "b"]);
});

test("InputQueue delivers an item pushed while the consumer is already waiting", async () => {
  const q = new InputQueue();
  const it = q[Symbol.asyncIterator]();
  const pending = it.next();
  q.push({ type: "user", message: { role: "user", content: "late" }, parent_tool_use_id: null });
  const first = await pending;
  assert.equal(first.done, false);
  assert.equal(first.value.message.content, "late");
  q.close();
  assert.equal((await it.next()).done, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/input-queue.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/input-queue.js'`

- [ ] **Step 3: 写实现**

```ts
/**
 * Push-based AsyncIterable backing the SDK's streaming-input mode.
 *
 * `Query` control methods (interrupt / setModel / setPermissionMode /
 * supportedModels) are only available in streaming input mode, so the client
 * always hands `query()` one of these and keeps pushing into it.
 */
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = [];
  private waiter: (() => void) | undefined;
  private done = false;

  get closed(): boolean {
    return this.done;
  }

  push(message: SDKUserMessage): void {
    if (this.done) throw new Error("agent-claude: input queue is closed");
    this.pending.push(message);
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  close(): void {
    this.done = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = this.pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolvePromise) => {
        this.waiter = resolvePromise;
      });
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/input-queue.test.mjs`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
cd apps/agent-worlds && git add agent-claude && git commit -m "feat(agent-claude): push-based streaming input queue"
```

---

### Task 4: 事件投影

**Files:**
- Create: `apps/agent-worlds/agent-claude/src/claude-events.ts`
- Test: `apps/agent-worlds/agent-claude/test/claude-events.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces（后续任务与 `agent.ts` 依赖的中性 wire 词表）：
  - `interface WireEvent { type: string; [k: string]: unknown }`
  - `projectClaudeEvent(message: unknown): WireEvent | WireEvent[] | null`
  - `resetProjectionState(): void`
  - 输出的 `type` 取值：`assistant_text` / `assistant_reasoning` / `assistant_message` / `tool_start` / `tool_end` / `turn_end` / `session_init` / `compaction` / `permission_denied` / `refusal_fallback` / `usage`

- [ ] **Step 1: 写失败测试**

```js
// agent-claude/test/claude-events.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { projectClaudeEvent, resetProjectionState } = await import("../dist/claude-events.js");

test("system/init becomes one session_init wire event carrying the runtime metadata", () => {
  resetProjectionState();
  const out = projectClaudeEvent({
    type: "system", subtype: "init", session_id: "s-1", cwd: "/w", model: "opus",
    permissionMode: "default", tools: ["Bash"], slash_commands: ["/mcp"], skills: [], plugins: [],
    mcp_servers: [], claude_code_version: "2.1.261", apiKeySource: "none", output_style: "default",
  });
  assert.equal(out.type, "session_init");
  assert.equal(out.sessionId, "s-1");
  assert.equal(out.model, "opus");
  assert.deepEqual(out.slashCommands, ["/mcp"]);
});

test("an assistant message yields reasoning + text + tool_start, never a thinking block", () => {
  resetProjectionState();
  const out = projectClaudeEvent({
    type: "assistant", session_id: "s-1", parent_tool_use_id: null, uuid: "u1",
    message: { role: "assistant", content: [
      { type: "reasoning", text: "why" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } },
    ] },
  });
  const types = out.map((e) => e.type);
  assert.deepEqual(types, ["assistant_reasoning", "assistant_text", "tool_start"]);
  assert.equal(out[0].text, "why");
  assert.equal(out[2].callId, "c1");
  assert.equal(out[2].name, "Bash");
  assert.deepEqual(out[2].arguments, { command: "ls" });
});

test("a user message carrying tool_use_result becomes tool_end, nested via parent_tool_use_id", () => {
  resetProjectionState();
  const out = projectClaudeEvent({
    type: "user", session_id: "s-1", parent_tool_use_id: "agent-7", uuid: "u2",
    tool_use_result: { content: [{ type: "text", text: "ok" }], is_error: false },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
  });
  assert.equal(out.type, "tool_end");
  assert.equal(out.callId, "c1");
  assert.equal(out.isError, false);
  assert.equal(out.parentToolUseId, "agent-7");
});

test("result becomes turn_end with usage; refusal/compaction/permission_denied map to their own types", () => {
  resetProjectionState();
  assert.equal(projectClaudeEvent({
    type: "result", subtype: "success", session_id: "s-1", is_error: false, num_turns: 1,
    duration_ms: 5, duration_api_ms: 4, total_cost_usd: 0.01,
    usage: { input_tokens: 3, output_tokens: 4 }, modelUsage: {}, permission_denials: [], result: "done",
  }).type, "turn_end");

  assert.equal(projectClaudeEvent({
    type: "system", subtype: "compact_boundary", session_id: "s-1", uuid: "u3",
    compact_metadata: { trigger: "auto", pre_tokens: 10, post_tokens: 3 },
  }).type, "compaction");

  assert.equal(projectClaudeEvent({
    type: "system", subtype: "permission_denied", session_id: "s-1", tool_name: "Bash", tool_use_id: "c2",
  }).type, "permission_denied");

  assert.equal(projectClaudeEvent({
    type: "system", subtype: "model_refusal_fallback", session_id: "s-1", uuid: "u4",
    trigger: "refusal", direction: "retry", original_model: "a", fallback_model: "b",
    retracted_message_uuids: ["u1"], refused_user_message_uuid: "u0", content: "fell back",
  }).type, "refusal_fallback");

  assert.equal(projectClaudeEvent({ type: "stream_event", session_id: "s-1", uuid: "u5", event: { type: "x" } }), null);
  assert.equal(projectClaudeEvent({ type: "unknown_future_type" }), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/claude-events.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/claude-events.js'`

- [ ] **Step 3: 写实现**

```ts
/**
 * Claude Agent SDK message -> neutral wire event projection.
 *
 * Only the message shapes the adapter consumes are translated; every other
 * SDKMessage variant returns null (ignored, not an error). Tool results pair by
 * `tool_use_id`; `parent_tool_use_id` marks subagent-nested traffic.
 *
 * NOTE (spec §6.5): refusal fallback is wired from these two system messages,
 * NOT from a dialog — the adapter declares no dialog kinds in V1.
 */
export interface WireEvent { type: string; [k: string]: unknown }

let toolNames = new Map<string, string>();

export function resetProjectionState(): void {
  toolNames = new Map();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textOf(content: unknown): { text: string; reasoning: string; tool: Record<string, unknown>[] } {
  const result = { text: "", reasoning: "", tool: [] as Record<string, unknown>[] };
  if (!Array.isArray(content)) return result;
  for (const raw of content) {
    const block = asRecord(raw);
    if (block === null) continue;
    if (block.type === "text" && typeof block.text === "string") result.text += block.text;
    if (block.type === "reasoning" && typeof block.text === "string") result.reasoning += block.text;
    if (block.type === "tool_use") result.tool.push(block);
  }
  return result;
}

export function projectClaudeEvent(message: unknown): WireEvent | WireEvent[] | null {
  const msg = asRecord(message);
  if (msg === null || typeof msg.type !== "string") return null;

  if (msg.type === "system") {
    switch (msg.subtype) {
      case "init":
        return {
          type: "session_init",
          sessionId: msg.session_id,
          cwd: msg.cwd,
          model: msg.model,
          permissionMode: msg.permissionMode,
          tools: msg.tools,
          slashCommands: msg.slash_commands,
          skills: msg.skills,
          plugins: msg.plugins,
          mcpServers: msg.mcp_servers,
          cliVersion: msg.claude_code_version,
          apiKeySource: msg.apiKeySource,
        };
      case "compact_boundary":
        return { type: "compaction", metadata: msg.compact_metadata };
      case "permission_denied":
        return {
          type: "permission_denied",
          toolName: msg.tool_name,
          callId: msg.tool_use_id,
          reasonType: msg.decision_reason_type,
        };
      case "model_refusal_fallback":
        return {
          type: "refusal_fallback",
          direction: msg.direction,
          scope: msg.scope ?? "session",
          originalModel: msg.original_model,
          fallbackModel: msg.fallback_model,
          category: msg.api_refusal_category ?? null,
          explanation: msg.api_refusal_explanation ?? null,
          retractedMessageUuids: msg.retracted_message_uuids ?? [],
          refusedUserMessageUuid: msg.refused_user_message_uuid ?? null,
          content: msg.content,
        };
      case "model_refusal_no_fallback":
        return {
          type: "refusal_no_fallback",
          originalModel: msg.original_model,
          category: msg.api_refusal_category ?? null,
          explanation: msg.api_refusal_explanation ?? null,
          refusedUserMessageUuid: msg.refused_user_message_uuid ?? null,
          content: msg.content,
        };
      case "local_command_output":
        return { type: "local_command_output", content: msg.content };
      default:
        return null;
    }
  }

  if (msg.type === "assistant") {
    const body = asRecord(msg.message);
    const parsed = textOf(body?.content);
    const out: WireEvent[] = [];
    if (parsed.reasoning !== "") out.push({ type: "assistant_reasoning", text: parsed.reasoning, parentToolUseId: msg.parent_tool_use_id ?? null });
    if (parsed.text !== "") out.push({ type: "assistant_text", text: parsed.text, parentToolUseId: msg.parent_tool_use_id ?? null });
    for (const block of parsed.tool) {
      const id = String(block.id ?? "");
      if (id !== "") toolNames.set(id, String(block.name ?? "tool"));
      out.push({
        type: "tool_start",
        callId: id,
        name: String(block.name ?? "tool"),
        arguments: block.input ?? {},
        parentToolUseId: msg.parent_tool_use_id ?? null,
      });
    }
    if (out.length === 0) out.push({ type: "assistant_message", raw: body ?? null });
    return out;
  }

  if (msg.type === "user") {
    const body = asRecord(msg.message);
    const content = Array.isArray(body?.content) ? body.content : [];
    const out: WireEvent[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (block?.type !== "tool_result") continue;
      const callId = String(block.tool_use_id ?? "");
      const text = typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((part) => String(asRecord(part)?.text ?? "")).join("")
          : "";
      out.push({
        type: "tool_end",
        callId,
        name: toolNames.get(callId) ?? "tool",
        content: text,
        isError: block.is_error === true,
        parentToolUseId: msg.parent_tool_use_id ?? null,
      });
    }
    // A single tool result is emitted as a bare object; several as an array.
    // (The brief's original single-line form contradicted its own test 3, which
    // asserts `.type` on a bare object. `null` still means "ignore this message".)
    return out.length === 0 ? null : out.length === 1 ? out[0] : out;
  }

  if (msg.type === "result") {
    return {
      type: "turn_end",
      subtype: msg.subtype,
      isError: msg.is_error === true,
      numTurns: msg.num_turns,
      durationMs: msg.duration_ms,
      durationApiMs: msg.duration_api_ms,
      costUsd: msg.total_cost_usd,
      usage: msg.usage,
      modelUsage: msg.modelUsage,
      permissionDenials: msg.permission_denials,
      result: msg.result,
      errors: msg.errors,
      stopReason: msg.stop_reason ?? null,
    };
  }

  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/claude-events.test.mjs`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
cd apps/agent-worlds && git add agent-claude && git commit -m "feat(agent-claude): SDK message -> wire event projection (incl. refusal fallback messages)"
```

---

### Task 5: SDK 桥客户端（懒物化 + 宿主二进制）

**Files:**
- Create: `apps/agent-worlds/agent-claude/src/claude-client.ts`
- Test: `apps/agent-worlds/agent-claude/test/claude-client.test.mjs`

**Interfaces:**
- Consumes: `InputQueue`（Task 3）、`claudeSessionIdFromDsh`（Task 2）、`resolveClaudeHome`（Task 1）
- Produces:
  - `interface ClaudeQueryLike { interrupt(): Promise<unknown>; setModel(model?: string): Promise<void>; setPermissionMode(mode: string): Promise<void>; close(): void; [Symbol.asyncIterator](): AsyncIterator<unknown> }`
  - `type ClaudeFactory = (options: ClaudeQueryOptions) => ClaudeQueryLike`
  - `interface ClaudeQueryOptions { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }`
  - `setClaudeFactory(factory)`, `setClaudeHomeResolver(resolver)`, `setClaudeExecutableResolver(resolver)`, `claudeClientRefCount()`
  - `class ClaudeSdkClient`：`ensureStarted(): Promise<void>`、`spawned: boolean`、`threadId: string | null`、`prompt(text): Promise<void>`、`followUp(text)`、`steer(text)`、`setModel(model)`、`setPermissionMode(mode)`、`interrupt()`、`on(listener)`、`close()`

- [ ] **Step 1: 写失败测试**

```js
// agent-claude/test/claude-client.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../dist/claude-client.js");
const { ClaudeSdkClient, setClaudeFactory, setClaudeHomeResolver, claudeClientRefCount } = mod;

function fakeQuery(record) {
  return {
    interrupt: async () => { record.push(["interrupt"]); },
    setModel: async (m) => { record.push(["setModel", m]); },
    setPermissionMode: async (m) => { record.push(["setPermissionMode", m]); },
    close: () => { record.push(["close"]); },
    async *[Symbol.asyncIterator]() {
      yield { type: "system", subtype: "init", session_id: "sdk-1", cwd: "/w", model: "opus", tools: [], slash_commands: [], skills: [], plugins: [], mcp_servers: [], claude_code_version: "2.1.261", apiKeySource: "none", output_style: "default" };
      await new Promise(() => {}); // stay open: streaming input keeps the CLI alive
    },
  };
}

test("construction is zero-IO: no query is created until the first prompt", async () => {
  const calls = [];
  setClaudeHomeResolver(() => "/tmp/cc-home");
  setClaudeFactory((o) => { calls.push(o); return fakeQuery([]); });
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(client.spawned, false);
  assert.equal(calls.length, 0, "the factory must not run at construction");
  await client.prompt("hi");
  assert.equal(client.spawned, true);
  assert.equal(calls.length, 1);
  await client.prompt("again");
  assert.equal(calls.length, 1, "the same query is reused across turns");
  client.close();
});

test("the query options pin the host binary, the app home, the session id and declare NO dialogs", async () => {
  const calls = [];
  setClaudeHomeResolver(() => "/tmp/cc-home");
  setClaudeFactory((o) => { calls.push(o); return fakeQuery([]); });
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "22222222-2222-4222-8222-222222222222" });
  await client.prompt("hi");
  const options = calls[0].options;
  assert.equal(options.cwd, "/w");
  assert.equal(options.sessionId, "22222222-2222-4222-8222-222222222222");
  assert.equal(options.pathToClaudeCodeExecutable, "/home/u1/.local/bin/claude");
  assert.equal(options.env.CLAUDE_CONFIG_DIR, "/tmp/cc-home");
  assert.equal(options.persistSession, true);
  assert.equal("supportedDialogKinds" in options, false, "V1 declares no dialog kinds");
  assert.equal("onUserDialog" in options, false, "V1 wires no user dialog");
  assert.ok(calls[0].prompt[Symbol.asyncIterator], "prompt must be an async iterable (streaming input mode)");
  client.close();
});

test("resume passes resume instead of sessionId", async () => {
  const calls = [];
  setClaudeFactory((o) => { calls.push(o); return fakeQuery([]); });
  const client = new ClaudeSdkClient({ cwd: "/w", resumeSessionId: "33333333-3333-4333-8333-333333333333" });
  await client.prompt("hi");
  assert.equal(calls[0].options.resume, "33333333-3333-4333-8333-333333333333");
  assert.equal("sessionId" in calls[0].options, false);
  client.close();
});

test("steer/followUp/interrupt/setModel/setPermissionMode reach the query and the refcount tracks instances", async () => {
  const calls = [];
  setClaudeFactory(() => fakeQuery(calls));
  const client = new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "44444444-4444-4444-8444-444444444444" });
  assert.equal(claudeClientRefCount(), 1);
  await client.prompt("hi");
  await client.steer("more");
  await client.interrupt();
  await client.setModel("sonnet");
  await client.setPermissionMode("plan");
  client.close();
  assert.deepEqual(calls, [["interrupt"], ["setModel", "sonnet"], ["setPermissionMode", "plan"], ["close"]]);
  assert.equal(claudeClientRefCount(), 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/claude-client.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/claude-client.js'`

- [ ] **Step 3: 写实现**

`src/claude-client.ts` 要点（完整实现按下列契约写）：

```ts
import { InputQueue } from "./input-queue.js";
import { resolveClaudeHome } from "./claude-home.js";

/** Host Claude Code binary driven through the SDK's bridge (spec ruling R5). */
export const DEFAULT_CLAUDE_EXECUTABLE = "/home/u1/.local/bin/claude";

export interface ClaudeQueryLike {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}
export interface ClaudeQueryOptions { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }
export type ClaudeFactory = (options: ClaudeQueryOptions) => ClaudeQueryLike;

let factory: ClaudeFactory = (o) => officialQuery(o as never) as unknown as ClaudeQueryLike;
let homeResolver = () => resolveClaudeHome(process.env.DSH_HOME);
let executableResolver = () => process.env.CLAUDE_EXECUTABLE ?? DEFAULT_CLAUDE_EXECUTABLE;
export function setClaudeFactory(next: ClaudeFactory): void { factory = next }
export function setClaudeHomeResolver(next: () => string): void { homeResolver = next }
export function setClaudeExecutableResolver(next: () => string): void { executableResolver = next }
```

- 模块级 `refcount` + **每个 SDK client 一个 query**（与 codex 的共享实例不同：SDK 的 `Query` 持有自己的 CLI 子进程与 streaming input，不能跨会话复用）。构造即 `refcount += 1`，`close()` 即 `refcount -= 1`，并 `claudeClientRefCount()` 暴露。
- `ensureStarted()`：若 `query === undefined`，构造 `InputQueue`；`options = { cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: homeResolver() }, pathToClaudeCodeExecutable: executableResolver(), persistSession: true, **canUseTool: canUseToolDispatcher**（按工具名分派，见 T9 第 5 条——**缺席即整条绕过 DSH 审批**）, ...(claudeSessionId ? { sessionId: claudeSessionId } : {}), ...(resumeSessionId ? { resume: resumeSessionId } : {}) }`；`query = factory({ prompt: queue, options })`；启动一个 reader loop 消费 `query` 并把每条消息经 `projectClaudeEvent` 投给 listener。（**注**：原稿把 `abortController` 与 `systemPrompt` 列进 sketch 是笔误——T5 复核已判定**故意不传**：硬中止走 `close()`、轮次中止走 `interrupt()`，两条路径客户端都已暴露；`Options` 的 `env` 是 **REPLACE** 语义，必须自己铺 `process.env`。）
- `prompt(text)` / `followUp(text)`：`await ensureStarted()` 后 `queue.push({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id })`。
- `steer(text)`：同上但带 `priority: "now"`。
- `setModel` / `setPermissionMode` / `interrupt`：若 `query === undefined` 则只记 pending（在 `ensureStarted` 后重放），否则直接调用。
- `close()`：`queue.close()` → `query?.close()` → `refcount -= 1`。
- `threadId`：由 `session/init` 的 `session_id` 填充。
- **禁用真私有 `#` 字段**：用 TS `private`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/claude-client.test.mjs`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
cd apps/agent-worlds && git add agent-claude && git commit -m "feat(agent-claude): SDK bridge client (lazy spawn, host binary, streaming input, zero dialog kinds)"
```

---

### Task 6: 模型目录与 LLM adapter

**Files:**
- Create: `apps/agent-worlds/agent-claude/src/models.ts`
- Create: `apps/agent-worlds/agent-claude/src/adapter.ts`
- Test: `apps/agent-worlds/agent-claude/test/adapter.test.mjs`

**Interfaces:**
- Consumes: `projectClaudeEvent` 的 `session_init` 形状（Task 4）
- Produces:
  - `CLAUDE_PROVIDER_ID = "claude"`
  - `interface ClaudeModelEntry { id: string; label: string; description?: string; contextWindow?: number }`
  - `setModelCatalog(entries: readonly ClaudeModelEntry[], defaultModel?: string): void`、`readModelCatalog(): { models: readonly ClaudeModelEntry[]; defaultModel?: string }`
  - `class ClaudeLlmAdapter extends LlmAdapter`：`providerInfo` / `listModels` / `resolveModel`（`stream()` 抛 `LlmError("...", "UNSUPPORTED_STREAM")`）

- [ ] **Step 1: 写失败测试**

```js
// agent-claude/test/adapter.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { ClaudeLlmAdapter, CLAUDE_PROVIDER_ID } = await import("../dist/adapter.js");
const { setModelCatalog, readModelCatalog } = await import("../dist/models.js");

test("the adapter serves exactly the observed catalog under the claude route", async () => {
  setModelCatalog([
    { id: "opus", label: "Opus", description: "most capable", contextWindow: 200000 },
    { id: "sonnet", label: "Sonnet" },
  ], "sonnet");
  const adapter = new ClaudeLlmAdapter();
  assert.equal(CLAUDE_PROVIDER_ID, "claude");
  assert.equal(adapter.providerInfo(CLAUDE_PROVIDER_ID).id, "claude");
  assert.deepEqual((await adapter.listModels(CLAUDE_PROVIDER_ID)).map((m) => m.id), ["opus", "sonnet"]);
  const resolved = await adapter.resolveModel(CLAUDE_PROVIDER_ID, "opus");
  assert.equal(resolved.context?.contextWindow, 200000);
  await assert.rejects(() => adapter.resolveModel(CLAUDE_PROVIDER_ID, "gpt"), /does not serve model/);
});

test("an empty catalog stays empty: no placeholder model is ever invented", () => {
  setModelCatalog([]);
  assert.deepEqual(readModelCatalog().models, []);
  assert.equal(readModelCatalog().defaultModel, undefined);
});

test("stream() refuses loudly rather than fabricating a wire route", () => {
  const adapter = new ClaudeLlmAdapter();
  assert.throws(() => adapter.stream({}), /does not stream/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/adapter.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/adapter.js'`

- [ ] **Step 3: 写实现**

`src/models.ts`：模块级 `catalog: { models: ClaudeModelEntry[]; defaultModel?: string }`；`setModelCatalog` 覆盖写入（**不合成占位模型**——空就是空）；`readModelCatalog` 返回当前快照。另导出 `catalogFromInit(init: { model?: unknown; slashCommands?: unknown }): ClaudeModelEntry[]`：从 `session_init.model` 造**单条**真实条目（`{ id: String(init.model), label: String(init.model) }`），仅在 `supportedModels()` 尚未回来时用作**降级**，且降级值只留在内存、不写 settings。

`src/adapter.ts`：照抄 `agent-codex/src/adapter.ts` 的结构（`providerInfo` / `listModels` / `resolveModel` / `stream` 抛错），把 `readCodexModelCatalog` 换成 `readModelCatalog`，provider id 用 `CLAUDE_PROVIDER_ID = "claude"`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/adapter.test.mjs`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
cd apps/agent-worlds && git add agent-claude && git commit -m "feat(agent-claude): observed-only model catalog + claude LlmAdapter route"
```

---

### Task 7: 权限档映射

**Files:**
- Create: `apps/agent-worlds/agent-claude/src/permission.ts`
- Test: `apps/agent-worlds/agent-claude/test/permission.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type PresetName = "read-only" | "workspace-write" | "danger-full-access"`
  - `type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto"`
  - `PRESET_TO_CLAUDE: Readonly<Record<PresetName, ClaudePermissionMode>>` = `{ "read-only": "default", "workspace-write": "acceptEdits", "danger-full-access": "bypassPermissions" }`
  - `EXTRA_TIERS: readonly ["plan", "auto", "dontAsk"]`
  - `claudePermissionMode(preset: string | undefined): ClaudePermissionMode`
  - `isPresetName(raw: unknown): raw is PresetName`
  - `permissionEventsFor(preset: PresetName, time: number): SessionEvent[]`
  - `presetFromEvents(events: readonly SessionEvent[]): PresetName | undefined`

- [ ] **Step 1: 写失败测试**

```js
// agent-claude/test/permission.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { PRESET_TO_CLAUDE, EXTRA_TIERS, claudePermissionMode, isPresetName } = await import("../dist/permission.js");

test("the three DSH presets map onto three Claude modes", () => {
  assert.deepEqual(PRESET_TO_CLAUDE, {
    "read-only": "default",
    "workspace-write": "acceptEdits",
    "danger-full-access": "bypassPermissions",
  });
});

test("plan/auto/dontAsk are extra tiers, never folded into the 3-preset skeleton", () => {
  assert.deepEqual([...EXTRA_TIERS], ["plan", "auto", "dontAsk"]);
  for (const tier of EXTRA_TIERS) assert.equal(Object.values(PRESET_TO_CLAUDE).includes(tier), false);
});

test("an unknown preset falls back to the most restrictive skeleton mode", () => {
  assert.equal(claudePermissionMode("nonsense"), "default");
  assert.equal(claudePermissionMode(undefined), "default");
  assert.equal(isPresetName("plan"), false);
  assert.equal(isPresetName("read-only"), true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/permission.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/permission.js'`

- [ ] **Step 3: 写实现**

照抄 `agent-codex/src/permission.ts` 的骨架（`isPresetName` / `defaultPermissionPreset` / `presetFromEvents` / `permissionEventsFor`），把映射表换成上面的 `PRESET_TO_CLAUDE` + `EXTRA_TIERS`，并补：

```ts
export function claudePermissionMode(preset: string | undefined): ClaudePermissionMode {
  if (preset === "plan" || preset === "auto" || preset === "dontAsk") return preset;
  return isPresetName(preset) ? PRESET_TO_CLAUDE[preset] : "default";
}
```

`permissionEventsFor` 产出的 `permission/preset` 事件里额外带 `claudeMode`，供 UI 与 `setPermissionMode` 同步。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/permission.test.mjs`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
cd apps/agent-worlds && git add agent-claude && git commit -m "feat(agent-claude): 3-preset skeleton + plan/auto/dontAsk extra permission tiers"
```

---

### Task 8: 交互桥（审批 / 提问 / plan）

**Files:**
- Create: `apps/agent-worlds/agent-claude/src/interaction.ts`
- Test: `apps/agent-worlds/agent-claude/test/interaction.test.mjs`

**Interfaces:**
- Consumes: 无（DSH 侧最小结构类型）
- Produces:
  - `interface ApprovalLike { request(req: { agent: unknown; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }): Promise<"allowed-once" | "rejected" | "cancelled" | "unavailable"> }`
  - `interface UserQuestionsLike { ask(req: { questions: AskQuestion[]; agent?: unknown; signal?: AbortSignal }): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }> }`
  - `interface AskQuestion { id: string; question: string; detail?: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean; intent?: { kind: "plan-review"; approve: string } }`（**服务契约字段是 camelCase `multiSelect`**，见 study §6.5 更正）
  - `makeCanUseTool(deps: { approval: ApprovalLike; agent: unknown }): (toolName: string, input: Record<string, unknown>, options: { toolUseID: string; signal: AbortSignal; decisionReason?: string }) => Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }>`
  - `answerAskUserQuestion(deps: { questions: UserQuestionsLike; agent: unknown }, input: Record<string, unknown>, signal: AbortSignal): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }>`
  - `askPlanReview(deps: { questions: UserQuestionsLike; agent: unknown }, plan: string, signal: AbortSignal): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

```js
// agent-claude/test/interaction.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { makeCanUseTool, answerAskUserQuestion, askPlanReview } = await import("../dist/interaction.js");

test("a tool permission maps onto ctx.approval and its four outcomes", async () => {
  const seen = [];
  const approval = { request: async (req) => { seen.push(req); return "allowed-once"; } };
  const canUseTool = makeCanUseTool({ approval, agent: { id: "a1" } });
  const allowed = await canUseTool("Bash", { command: "ls" }, { toolUseID: "c1", signal: new AbortController().signal });
  assert.equal(allowed.behavior, "allow");
  assert.equal(seen[0].toolName, "Bash");
  assert.equal(seen[0].callId, "c1");
});

test("rejected/cancelled/unavailable all fail closed as deny", async () => {
  for (const outcome of ["rejected", "cancelled", "unavailable"]) {
    const approval = { request: async () => outcome };
    const canUseTool = makeCanUseTool({ approval, agent: { id: "a1" } });
    const res = await canUseTool("Bash", {}, { toolUseID: "c1", signal: new AbortController().signal });
    assert.equal(res.behavior, "deny", `${outcome} must deny`);
    assert.match(res.message, /denied/);
  }
});

test("AskUserQuestion answers travel back as updatedInput.answers", async () => {
  const asked = [];
  const questions = { ask: async (req) => { asked.push(req); return { answers: [{ id: "q0", selected: ["Yes"], custom: "note" }] }; } };
  const res = await answerAskUserQuestion({ questions, agent: { id: "a1" } }, {
    questions: [{ question: "Proceed?", header: "Confirm", multiSelect: false, options: [{ label: "Yes", description: "go" }, { label: "No" }] }],
  }, new AbortController().signal);
  assert.equal(res.behavior, "allow");
  assert.deepEqual(asked[0].questions[0].options.map((o) => o.label), ["Yes", "No"]);
  assert.equal(asked[0].questions[0].multiSelect, false);
  assert.deepEqual(res.updatedInput.answers, { "Proceed?": "Yes, note" });
});

test("plan review asks through the SAME seam with the plan-review intent", async () => {
  const asked = [];
  const questions = { ask: async (req) => { asked.push(req); return { answers: [{ id: "plan", selected: ["Approve"] }] }; } };
  const approved = await askPlanReview({ questions, agent: { id: "a1" } }, "# plan", new AbortController().signal);
  assert.equal(approved, true);
  assert.deepEqual(asked[0].questions[0].intent, { kind: "plan-review", approve: "Approve" });
  assert.equal(asked[0].questions[0].detail, "# plan");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/interaction.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/interaction.js'`

- [ ] **Step 3: 写实现**

要点：
- `makeCanUseTool`：`allowed-once` → `{ behavior: "allow" }`；`rejected` / `cancelled` / `unavailable` → `{ behavior: "deny", message: "Claude Code tool call denied (...)" }`。**fail-closed，绝不默认放行。**
- `answerAskUserQuestion`：把 Claude 的 `input.questions[{question, header, multiSelect, options[{label, description, preview?}]}]` 转成 DSH 的 `{ id, question, header?, options?, multiSelect? }`（**两侧都是 camelCase `multiSelect`**——DSH 服务契约从不用 snake_case `multi_select`，那是 DSH 自有工具 schema 的名字，见 study §6.5；`id` 用 `q${i}`）；答案回填 `updatedInput = { ...input, answers: { [questionText]: selected.join(", ") + (custom ? `, ${custom}` : "") } }`（Claude 的 `answers` 是 `{[k:string]: string}`，见 `AskUserQuestionInput.answers` 注释「User answers collected by the permission component」）。
- `askPlanReview`：`questions.ask({ questions: [{ id: "plan", question: "Approve this plan?", detail: plan, options: [{ label: "Approve" }, { label: "Keep planning" }], intent: { kind: "plan-review", approve: "Approve" } }], agent, signal })`；`answers[0].selected.includes("Approve")` 即批准。
- 异常一律转成 deny/`false` 并留痕。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/interaction.test.mjs`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
cd apps/agent-worlds && git add agent-claude && git commit -m "feat(agent-claude): map approval / AskUserQuestion / ExitPlanMode onto DSH native interaction seams"
```

---

### Task 9: Provider 与 AgentFactory（create / resume / 持久化）

**Files:**
- Create: `apps/agent-worlds/agent-claude/src/agent.ts`
- Create: `apps/agent-worlds/agent-claude/src/index.ts`
- Test: `apps/agent-worlds/agent-claude/test/provider.test.mjs`

**Interfaces:**
- Consumes: `ClaudeSdkClient`（Task 5）、`projectClaudeEvent`（Task 4）、`claudePermissionMode`（Task 7）、`makeCanUseTool` 等（Task 8）、`claudeSessionIdFromDsh`（Task 2）、`resolveClaudeHome`（Task 1）
- Produces:
  - `class ClaudeAgent implements Agent`：`readonly id: SessionId`、`status`、`prompt(message, options?)`、`followUp`、`steer`、`interrupt()`、`whenIdle()`、`dispose()`
  - `class ClaudeProvider extends Service implements AgentFactory`：`static inject = ["agents", "sessions", "llm"]`、`createAgent(ownerCtx, options)`、`resume(ownerCtx, options)`
  - `export default ClaudeProvider`

- [ ] **Step 1: 写失败测试**

```js
// agent-claude/test/provider.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { claudeSessionIdFromDsh } = await import("../dist/session-id.js");

test("create resolves the Claude session id from the DSH id before anything is spawned", () => {
  const dsh = "session-01a04826-6d1d-701f-adc3-b834dffc82c5";
  assert.equal(claudeSessionIdFromDsh(dsh), "01a04826-6d1d-701f-adc3-b834dffc82c5");
});

test("create fails closed when a DSH id carries no UUID and no mapping exists", () => {
  assert.equal(claudeSessionIdFromDsh("session-1"), undefined);
});

test("resume fails closed when the recorded Claude session is unknown", async () => {
  const { resumeGuard } = await import("../dist/index.js");
  assert.throws(() => resumeGuard({ dshSessionId: "session-1", claudeSessionId: undefined }),
    /no Claude session is recorded/);
  assert.doesNotThrow(() => resumeGuard({
    dshSessionId: "session-1", claudeSessionId: "55555555-5555-4555-8555-555555555555",
  }));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/provider.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/index.js'`

- [ ] **Step 3: 写实现**

`src/index.ts` 结构照抄 `agent-codex/src/index.ts`，改动点：

1. `ClaudeProvider` 的 `home` 来自世界自身 `dshHomePath`（`ctx.get('dshHomePath')`），缺省回落到 `process.env.DSH_HOME`；**不读 ambient**。
2. `createAgent`：
   - 拒 fork（Claude 有 `forkSession`，但 V1 不做——`meta.parentSession !== undefined` 时抛 `cannot fork session ... : fork is not wired in V1`）。
   - `const persistence = this.requirePersistence("create")`（照抄 codex）。
   - `const claudeSessionId = claudeSessionIdFromDsh(String(options.sessionId))`；为 `undefined` 时**留痕并退路线 B**（本条路线 B 的映射文件是 V1 之后的工作，此时必须**显式失败**，不得静默新建）。
   - `createStoredSession(...)` → `setupAndPublish(...)`（照抄 codex 的事务顺序：prepare → 持写通道 → setup → publish）。
3. `resume`：
   - `resumeGuard({ dshSessionId, claudeSessionId })` —— 找不到 Claude session 记录时 `throw new Error(\`cannot resume session "${id}": no Claude session is recorded for this Dash session id\`)`（导出该函数以便单测）。
   - 校验记录里的 cwd 仍是活目录（`validatedCwd`，照抄 codex）。
   - **不驱动轮次**：只 `persistence.open(id,'write')` + `handle.read()` + `interruptedTurnClosers(events)` 修补 + `sessions.prepare(...)` + 发布（照抄 codex `resume`）。
   - **权限档重挂（Task 7 复核的强制收口）**：extra tier（`plan` / `auto` / `dontAsk`）**不经** `presetFromEvents` 往返——`permissionEventsFor` 只可能盖 preset 推出的 `claudeMode`（`default`/`acceptEdits`/`bypassPermissions`），`presetFromEvents` 又会跳过 `preset:"plan"` 这类事件。所以有效 Claude 模式必须**与 Claude 会话记录同源落盘**（写进 DSH 会话记录里存 `claudeSessionId` 的那一处），resume 时读回并 `client.setPermissionMode(mode)` 重挂；**不得从事件日志反推**。记录缺失时回落 `claudePermissionMode(defaultPreset)` 并**留痕**，绝不静默换成别的档。
4. `agent.ts`：
   - `#startTurn` 冷启 = `await this.client.ensureStarted()` → 提交 session 身份事件（preset stamp）→ `turn/start` → `user/message` → `client.prompt(text)`。冷启失败**合成失败轮次**（`turn/end{reason:{kind:'error'}}`），照抄 codex。
   - **预设切换单源**：`permission/preset` 事件落盘（带 `claudeMode`）与 `client.setPermissionMode(...)` 必须同源——两者都用**同一个** `claudePermissionMode(preset)` 结果，不得各算一遍；同时把该 `claudeMode` 写进会话记录，供 resume 重挂。
   - 事件循环：`client.on((msg) => { const wire = projectClaudeEvent(msg); ... })`，把 wire 事件翻成 DSH session 事件：`assistant_reasoning`/`assistant_text` → `assistant/message`（`content` 里 reasoning/text block）；`tool_start` → `tool/call`；`tool_end` → `tool/result`；`turn_end` → `turn/end` + usage；`compaction` → `compaction/*`；`permission_denied` → log-only；`refusal_fallback` → 驱逐 `retractedMessageUuids` 并把 `content` 作为一条 notice 投影。
   - idle TTL：`CLAUDE_IDLE_EXIT_MS`（默认 `600_000`，`0` 关闭），`#markIdle` arm / 活动 cancel / `unref()`；fire 走 `#revalidateIdleExit()`，逐条 re-arm：`disposed || streaming`、**never-spawned draft（直接放弃，不 re-arm）**、未发送的排队投递、pending approval、`client` 自述仍在跑、子 agent 计数 > 0。
   - `interrupt()` → `agent.cancel({ kind: "user" }, { keepInbox: true })` 语义 + `client.interrupt()`。
5. **交互桥与模型目录的接线（Task 9 复核发现的 Critical 缺口，原计划漏派）**：Task 1–8 的产物里，`makeCanUseTool` / `answerAskUserQuestion` / `askPlanReview` 三个函数**必须真的被调用**，而不是导出后晾着。做法：`buildOptions` 增加 `canUseTool`，由 provider 注入一个**按工具名分派**的回调——
   - `toolName === "AskUserQuestion"` → `answerAskUserQuestion({ questions: ctx.userQuestions, agent }, input, signal)`。它的返回值 `{ behavior: 'allow', updatedInput: { ...input, answers } }` **正是** Claude 回填答案的通道（`AskUserQuestionInput.answers` 的注释就写着由 permission component 收集）。
   - `toolName === "ExitPlanMode"` → `askPlanReview(...)`；批准则放行，否则 deny。
   - 其余 → `makeCanUseTool({ approval: ctx.approval, agent })`。
   **为什么不接是 Critical**：`canUseTool` 缺席时 Claude Code 走它**自己的 `permissionMode`**，DSH 的审批瀑布被**整条绕过**——沙箱/审批姿态悄悄变成 CLI 的而不是 DSH 的，属于安全面缺口而非可选优化。**判据**：`grep -rn "makeCanUseTool\|answerAskUserQuestion\|askPlanReview" src/` 的结果里必须出现 `index.ts`/`agent.ts` 的**调用点**，不能只有 `interaction.ts` 自己的定义。
   同时 `createAgent` / `resume` 必须把观测到的模型目录喂进 `setModelCatalog(...)`（`supportedModels()`，或 `session_init.model` 经 `catalogFromInit` 的降级读），否则 `readModelCatalog()` 永远返回冻空的 `EMPTY_CATALOG`、模型选择器空转——`llm.registerAdapter` 已经接线而目录恒空，属于**半接**。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/provider.test.mjs`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
cd apps/agent-worlds && git add agent-claude && git commit -m "feat(agent-claude): ClaudeProvider AgentFactory (create/resume, DSH-native persistence, idle TTL)"
```

---

### Task 9.5: 内容块转码（图片/文本）

**Files:**
- Create: `apps/agent-worlds/agent-claude/src/content.ts`
- Modify: `apps/agent-worlds/agent-claude/src/agent.ts`（`prompt()` 路径改用它）
- Test: `apps/agent-worlds/agent-claude/test/content.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type ClaudeInputBlock = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }`
  - `type DshContentBlock = { type: "text"; text: string } | { type: "image" | "file"; mediaType?: string; data?: string; attachmentId?: string }`
  - `toClaudeContent(blocks: readonly DshContentBlock[], readAttachment: (id: string) => { mediaType: string; data: string } | undefined): { content: ClaudeInputBlock[]; skipped: string[] }`

- [ ] **Step 1: 写失败测试**

```js
// agent-claude/test/content.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { toClaudeContent } = await import("../dist/content.js");

test("text and inline images become Anthropic text/image blocks", () => {
  const { content, skipped } = toClaudeContent([
    { type: "text", text: "look at this" },
    { type: "image", mediaType: "image/png", data: "AAAB" },
  ], () => undefined);
  assert.deepEqual(content, [
    { type: "text", text: "look at this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } },
  ]);
  assert.deepEqual(skipped, []);
});

test("an attachment-backed image is resolved through the injected reader", () => {
  const { content } = toClaudeContent([
    { type: "image", attachmentId: "att-1" },
  ], (id) => (id === "att-1" ? { mediaType: "image/jpeg", data: "ZZZ" } : undefined));
  assert.deepEqual(content, [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZZZ" } },
  ]);
});

test("an unresolvable block is skipped and REPORTED, never silently dropped", () => {
  const { content, skipped } = toClaudeContent([
    { type: "text", text: "keep" },
    { type: "file", attachmentId: "missing" },
    { type: "image" },
  ], () => undefined);
  assert.deepEqual(content, [{ type: "text", text: "keep" }]);
  assert.equal(skipped.length, 2, "every dropped block must be reported for tracing");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/content.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/content.js'`

- [ ] **Step 3: 写实现**

```ts
/**
 * DSH content blocks -> Anthropic message content blocks.
 *
 * The paste UI is DSH's own; the adapter owns the transcoding into Claude's
 * wire shape (spec ruling R14). A block whose payload cannot be resolved is
 * SKIPPED AND REPORTED: an unattachable image must never silently vanish, and
 * an unusable placeholder must never be sent to the runtime.
 */
export type ClaudeInputBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type DshContentBlock =
  | { type: "text"; text: string }
  | { type: "image" | "file"; mediaType?: string; data?: string; attachmentId?: string };

export function toClaudeContent(
  blocks: readonly DshContentBlock[],
  readAttachment: (id: string) => { mediaType: string; data: string } | undefined,
): { content: ClaudeInputBlock[]; skipped: string[] } {
  const content: ClaudeInputBlock[] = [];
  const skipped: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text !== "") content.push({ type: "text", text: block.text });
      continue;
    }
    let mediaType = block.mediaType;
    let data = block.data;
    if (data === undefined && block.attachmentId !== undefined) {
      const resolved = readAttachment(block.attachmentId);
      if (resolved !== undefined) ({ mediaType, data } = resolved);
    }
    if (data === undefined || mediaType === undefined) {
      skipped.push(`${block.type}:${block.attachmentId ?? "inline"}`);
      continue;
    }
    content.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
  }
  return { content, skipped };
}
```

在 `agent.ts` 的 `prompt()` 路径改用：`const { content, skipped } = toClaudeContent(blocks, (id) => readAttachment(id))`；`skipped.length > 0` 时 `trace(...)` 并写一条 log-only session 事件（**不得静默**）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/content.test.mjs`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
cd apps/agent-worlds && git add agent-claude && git commit -m "feat(agent-claude): DSH content blocks -> Anthropic image/text blocks with loud skips"
```

---

### Task 9.6: 附件图片投递（async 预取 + 客户端块面）

**Files:**
- Modify: `apps/agent-worlds/agent-claude/src/agent.ts`（prompt 路径加 async 预取）
- Modify: `apps/agent-worlds/agent-claude/src/claude-client.ts`（`prompt`/`followUp`/`steer` 接受块数组）
- Modify: `apps/agent-worlds/agent-claude/src/input-queue.ts`（随客户端一起加宽）
- Test: `apps/agent-worlds/agent-claude/test/prompt-content.test.mjs`（改/加）

**Interfaces:**
- Consumes: `toClaudeContent`（Task 9.5，**纯函数与现有签名保持不变**）；DSH 真实附件面 `ctx.attachments.readImage(ref: ImageAttachmentRef, signal?) => Promise<StoredImageAttachment{ ref, data: Uint8Array }>`
- Produces: 客户端 `prompt(content: string | ClaudeInputBlock[])`（`followUp` / `steer` 同宽）；agent 侧 `#resolveAttachments(blocks) => Promise<Map<string, { mediaType, data }>>`

**背景（Task 9.5 复核结论，已源码核实）**：plan 原写的 **同步** `readAttachment(id) => {mediaType,data} | undefined` 在 DSH 里**不存在**——真实图片是**持久引用**（`ImageAttachmentRef` 无内联 `data`：`{attachmentId, mediaType, bytes, width, height, name?}`，见 `attachment/src/types.ts:8-27`），只能经 **async** `AttachmentStore.readImage`（`attachment/src/index.ts:166`）读回，且返回值 `data` 是 **`Uint8Array`**、不是 base64。服务挂在 `ctx.attachments`（`index.ts:46-51`）。因此 T9.5 只能「响亮地丢弃」图片——「图片不被静默丢掉」这个目标只完成了一半。本任务补上另一半。

要点：
1. **`toClaudeContent` 保持纯、签名不变**（不要改成 async）。改由**调用方**做 async 预取：只对 `type:'image'` 且带 `attachmentId` 的块逐个 `await ctx.attachments.readImage(ref)`，把 `Uint8Array` **base64 编码**进 `{ mediaType, data }` 汇成 `Map`，再把 `(id) => map.get(id)` 传进 `toClaudeContent`。同步读 map、异步读 store，两边都诚实。
2. **客户端加宽**：`ClaudeSdkClient.prompt` / `followUp` / `steer` 接受 `string | ClaudeInputBlock[]`，`InputQueue` 同步加宽。SDK 的 `SDKUserMessage.message.content` 本来就接受 `string | ContentBlock[]`——这是**把 T9.5 为绕开同步面而收窄的接口改回原样**，不是新造面。
3. **去掉 `promptText` 的 `"\n"` 重 join**（T9.5 复核点出的 Minor）：transcoder 保证「一个输入块一个输出块」，而 `promptText` 又用 `"\n"` 把多个 text 块拼回一个字符串，在字符串客户端边界上把块形状塌掉了。块路径应把数组**原样**交给客户端。
4. **失败仍然响亮**：`readImage` 抛错、ref 形状不符、base64 编码失败——一律进 `skipped`，沿用 T9.5 的 stderr + `CLAUDE_TRACE` 通道。**不要**改用 session event：T9.5 复核已源码证实 `Session.append` 无法设 `ignorable`，未知类型事件会让整个 session 日志在下次读取时不可读。
5. **测试判据（缺此即等于没做）**：T9.5 复核的原话是「No test covers an image actually reaching the model」。本任务必须注入一个假的 `ctx.attachments.readImage` 返回已知字节，断言最终 push 给客户端的 message content 里出现 `{ type:'image', source:{ type:'base64', media_type, data } }`，且 `data` 等于那串字节的 base64。

---

### Task 10: 命令面与 bundle patch

**Files:**
- Create: `apps/agent-worlds/agent-claude/src/commands.ts`
- Create: `apps/agent-worlds/agent-claude/cordis.patch.yml`
- Test: `apps/agent-worlds/agent-claude/test/commands.test.mjs`

**Interfaces:**
- Consumes: `ctx.commands`（`@deepseek-ai/dsh-commands`）
- Produces: `registerClaudeCommands(ctx: { commands: CommandRuntimeLike }, deps: { listSlashCommands(): readonly SlashCommandLike[]; submit(agent: unknown, line: string): void }): () => void`

- [ ] **Step 1: 写失败测试**

```js
// agent-claude/test/commands.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { registerClaudeCommands } = await import("../dist/commands.js");

test("every observed Claude slash command is registered under a claude- prefixed name", () => {
  const registered = [];
  const commands = { register: (def) => { registered.push(def); return () => {}; } };
  const dispose = registerClaudeCommands({ commands }, {
    listSlashCommands: () => [{ name: "mcp", description: "Manage MCP servers", argumentHint: "" }],
    submit: () => {},
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "claude-mcp");
  assert.match(registered[0].description, /Claude/);
  dispose();
});

test("executing a registered command submits the raw Claude line and reports the output", async () => {
  const submitted = [];
  const commands = { register: (def) => { commands.last = def; return () => {}; } };
  registerClaudeCommands({ commands }, {
    listSlashCommands: () => [{ name: "mcp", description: "d", argumentHint: "" }],
    submit: (_agent, line) => submitted.push(line),
  });
  const result = await commands.last.handler({ agent: { id: "a1" }, rawInput: "", attachments: [], signal: new AbortController().signal });
  assert.deepEqual(submitted, ["/mcp"]);
  assert.equal(result.kind, "success");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/commands.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/commands.js'`

- [ ] **Step 3: 写实现 `commands.ts` 与 `cordis.patch.yml`**

`commands.ts`：把每个 Claude slash 命令注册为 `claude-<name>`（前缀化避免与 DSH 同名命令冲突，且名称自解释归属）；`handler` 调 `deps.submit(agent, "/" + name + rawInput)`，返回 **`{ kind: "success" }`**。**不**自己渲染面板——`local_command_output` 走 Task 4 的投影进转录。dispose 时逐个调用 `register` 返回的 disposer。

⚠️ **原稿写的 `{ kind: "handled" }` 是错的**（Task 10 复核发现）：上游 `CommandResult` 是 **`{ kind: 'success'; text?; sourceEventSeq? } | { kind: 'error'; text }`**（`interaction/commands/src/types.ts:34-41`），`normalizeResult`（`index.ts:223-225`）对其他 kind 一律 `throw new TypeError`。所以原稿的返回值在真实派发时必炸；改为 `success`。

⚠️ **必须真的接线（同 T9 的 `canUseTool` 教训）**：`registerClaudeCommands` 不能只导出不用——provider 侧要有**调用点**，deps 绑定到活对象：`listSlashCommands` 取自客户端的 `supportedCommands()`（观测到的 Claude slash 命令），`submit(agent, line)` 把原始行送给**那个** agent（`invocation.agent`），从而 `claude-<name>` 真正能派发。判据：`grep -rn "registerClaudeCommands" src/` 的结果里必须出现 `index.ts`/`agent.ts` 的调用点，且 T11 的验收要**真的敲一条** `claude-` 命令（R12 否则不可达）。

`cordis.patch.yml`（照抄 `agent-codex/cordis.patch.yml` 的配方，替换行名与注释）：

```yaml
# @pgmi-builds/agent-adapter-claude bundle patch (standalone web app form).
- insert:
    - id: claude-provider
      name: '@pgmi-builds/agent-adapter-claude'

- id: agent-loop
  disabled: true
- id: llm-deepseek
  disabled: true
- id: llm-pi-ai
  disabled: true
- id: agent-presets
  disabled: true

# The upstream jsonl persistence row STAYS MOUNTED: the provider owns the DSH
# session log write channel, so list/read/replay are ordinary DSH services.

# Claude has real runtime approval (canUseTool), so the preset table is the
# 3-preset skeleton plus plan/auto/dontAsk extra tiers (src/permission.ts).
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: danger-full-access

# Directory picker: pin the in-app browser (both faces) and unmount the auto
# row — never `disabled: true` the row itself (that removes the entry point).
- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: directory-picker-browse-surface
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
- id: directory-picker
  disabled: true
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/agent-worlds/agent-claude && npm run build && node --test test/commands.test.mjs`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
cd apps/agent-worlds && git add agent-claude && git commit -m "feat(agent-claude): slash commands onto ctx.commands + bundle patch layer"
```

---

### Task 11: 形态 A 端到端运行时验收

**Files:**
- Create: `apps/agent-worlds/test/start-claude-app.sh`
- Create: `apps/agent-worlds/agent-claude/test/verify-claude-app.mjs`
- Create: `apps/agent-worlds/agent-claude/src/world-plugin.ts`（`./world` 入口，供上层打包；本计划不做 hub 侧接线）

**Interfaces:**
- Consumes: Task 1–10 的全部产出
- Produces: `verify-claude-app.mjs` 的退出码（0 = 全绿）；`start-claude-app.sh` 打印 loopback + LAN token URL

- [ ] **Step 1: 写 `world-plugin.ts`（最小入口，不做 hub 接线）**

```ts
/**
 * `./world` entry point for a future hub-side packaging step.
 *
 * Ruling R2 (2026-09-16): this adapter ships and is verified STANDALONE only.
 * Joining the agent-worlds hub is the hub side's job — it packages this entry
 * with its own spawn/roster wiring. Nothing here starts a process or reads the
 * hub; it only exposes the canonical provider row name.
 */
export const name = 'aw.agent-adapter-claude-world';
export const providerRow = '@pgmi-builds/agent-adapter-claude';
export function apply(): void {
  // Intentionally inert: the standalone bundle patch (cordis.patch.yml) is the
  // sole mounting path in V1. The hub packages its own insert row via `providerRow`.
}
```

- [ ] **Step 2: 写 `start-claude-app.sh`**

照抄 `apps/agent-worlds/test/start-codex-app.sh`，替换四处：`PORT="${AW_APP_PORT:-4989}"`、`UNIT="aw-claude-app-${PORT}-test"`、`LABEL="claude"`、工作目录与链接包名 `agent-claude` → `@pgmi-builds/agent-adapter-claude`；bundles 改为 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@pgmi-builds/agent-adapter-claude"]`；播种步骤改为 `node "$WT/apps/agent-worlds/agent-claude/scripts/setup-claude-home.mjs"`。

- [ ] **Step 3: 写 `verify-claude-app.mjs`**

照抄 `agent-codex/test/verify-codex-app.mjs`（cookie jar → RPC → create → prompt → 轮询 readback），把断言改为：

```js
console.log("providers:", JSON.stringify(await rpc("llm/listProviders", { args: {} })));   // 必须含 claude
console.log("presets:", JSON.stringify(await rpc("agentPresets/list", { args: {} })).slice(0, 160));
const created = await rpc("session/create", { args: { request: { cwd: "/home/u1/workspaces/superd/.scratch/aw-claude" } } });
const sessionId = created?.sessionId;
if (!sessionId) { console.error("no session"); process.exit(1); }
if (!/^session-[0-9a-f-]{36}$/i.test(sessionId)) { console.error(`unexpected session id shape: ${sessionId}`); process.exit(1); }
const prompted = await rpc("session/prompt", {
  args: { request: { requestId: "v-1", sessionId, mode: "queue", content: [{ type: "text", text: "Reply with exactly: claude-standalone-ok" }] } },
});
console.log("prompt:", JSON.stringify(prompted).slice(0, 120));
// 轮询 session/read 直到出现 assistant 文本 "claude-standalone-ok" 或超时（180s）
//
// 命令面验收（R12，Task 10 复核发现「模块未接线」后补入）：turn 落定后调 `commands/list`。
// 服务名是 `commands`（`super(ctx, 'commands')`），方法签名 `@Remote list(agent)`（`interaction/commands/src/index.ts:309`）。
// 断言：**每个** `session_init.slashCommands` 里的命令，列表里都有一个对应的 `claude-<name>`。
// `agent` 参数的线上形态（agent handle 还是 sessionId）由实现者按 Typert 网关的解析规则确定，并**在报告里写明**；
// 若该参数在 verifier 里无法表达，必须**明说并退回 adapter 自己的 trace/日志证据**，不得静默跳过这项检查。
// 若 Claude 本次报告 **0** 条 slash 命令，把这条观测事实记下来（接线本身另有 Task 10 的真 `CommandRuntime` 双 agent 单测覆盖）。
```

- [ ] **Step 4: 起实例并跑验收（运行时行为，不是单测）**

```bash
bash apps/agent-worlds/test/start-claude-app.sh
curl -s -c /tmp/aw-claude-app.jar -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:4989/"          # 期望 401
# 用脚本打印的 token URL 取 cookie
AW_JAR=/tmp/aw-claude-app.jar AW_BASE=http://127.0.0.1:4989 node apps/agent-worlds/agent-claude/test/verify-claude-app.mjs
```

Expected：`llm/listProviders` 含 `claude`；`session/create` 返回 `session-<uuid>`；真 turn 回读到 `claude-standalone-ok`；`$DSH_HOME/agents/claude/` 下出现 Claude 原生 transcript 与 settings 副本。

- [ ] **Step 5: 签名核对（宿主执行体确实被使用）**

```bash
pgrep -af "claude" | head
```

Expected：出现 `pathToClaudeCodeExecutable` 指向的宿主二进制路径（**不是** `claude-agent-sdk-linux-x64` 载荷路径）。若出现载荷路径，说明 R5 未被兑现，必须修 `executableResolver` 后再继续。

- [ ] **Step 6: 交 user 实测并保持运行**

给 user：loopback URL、LAN URL、`/` 入口与 token；**保持运行**等 user 亲手测完。把结果写到 `docs/test-reports/`（惯例建立后生效）。

- [ ] **Step 7: Commit**

```bash
cd apps/agent-worlds && git add agent-claude test/start-claude-app.sh && git commit -m "feat(agent-claude): standalone web app harness + runtime verification"
```

---

## Self-Review

**1. Spec coverage**

| Spec 项 | 落地任务 |
|---|---|
| R1 范围 B（能接的全接） | Task 4/8/9/10 覆盖投影、交互、命令 |
| R2 只做 standalone + 端口 4989 | Task 11（`world-plugin.ts` 仅留入口，无 hub 接线） |
| R3 认证 copy 原生 settings | Task 1（`seedClaudeHome` + `setup-claude-home.mjs`） |
| R4 独立 home 代价登记 | Task 1（`assertNotProdHome` + home 隔离） |
| R5 宿主二进制 + 双版本诊断 | Task 5（`DEFAULT_CLAUDE_EXECUTABLE`）、Task 11 Step 5（签名核对） |
| R6 生命周期（懒物化 / resume 不驱动轮 / TTL 600s + 复核） | Task 5、Task 9 |
| R7 命名 | Global Constraints + Task 1（package.json） |
| R8 session id 路线 A | Task 2、Task 9 |
| R9 审批 / 提问 / plan | Task 8 |
| R10 权限档 | Task 7 |
| R11 steer / 排队 / 停止 | Task 5（client 面）、Task 9（DSH 面） |
| R12 slash 命令 | Task 10（注册 + 接线到 `agent.ts`）；**Task 11 做活体验收**：assert 每条 `session_init.slashCommands` 都有对应的 `claude-<name>` |
| R13 dialogKind 不声明 | Task 5（测试断言 `supportedDialogKinds`/`onUserDialog` 不存在） |
| R14 图片转码与投递 | **Task 9.5**（`src/content.ts` 转码）+ **Task 9.6**（`ctx.attachments.readImage` async 预取 + 客户端块面 —— 图片**真正到达模型**） |
| §10 T0-1 sessionId 被接受 | Task 11 Step 4（真 turn 回读） |
| §10 T0-2 宿主二进制可起 | Task 11 Step 5 |
| §10 T0-3 refusal dialog payload | **有意不做**（R13：V1 不声明） |

**缺口回填记录**：初次自查时 R14（图片转码）无专属任务，已按 skill 要求**补为 Task 9.5**（`src/content.ts` 的 `toClaudeContent`，覆盖 text/image/attachment 解析/未知 block 响亮跳过），并在覆盖表中登记。当前无未回填缺口。

**2. Placeholder scan**：无 TBD/TODO；每个实现步给出具体行为、文件与可运行断言。Task 5/6/7/9 的实现步给出契约级要点而非逐行全文——因为它们是 codex 同构文件的**移植**，执行者按 spec §6.5 与既有文件对照即可；关键分歧点（`sessionId`/`resume` 互斥、零 dialog 声明、fail-closed 四态、TTL 复核门）已在测试断言中钉死。

**3. Type consistency**：`resolveClaudeHome` / `assertNotProdHome` / `seedClaudeHome`（T1）、`claudeSessionIdFromDsh` / `isClaudeSessionId` / `CLAUDE_SESSION_ID_RE`（T2）、`InputQueue`（T3）、`projectClaudeEvent` / `WireEvent`（T4）、`ClaudeSdkClient` / `setClaudeFactory` / `setClaudeHomeResolver` / `setClaudeExecutableResolver` / `claudeClientRefCount`（T5）、`CLAUDE_PROVIDER_ID` / `ClaudeLlmAdapter` / `setModelCatalog` / `readModelCatalog`（T6）、`PRESET_TO_CLAUDE` / `EXTRA_TIERS` / `claudePermissionMode` / `isPresetName`（T7）、`makeCanUseTool` / `answerAskUserQuestion` / `askPlanReview`（T8）、`ClaudeProvider` / `ClaudeAgent` / `resumeGuard`（T9）、`registerClaudeCommands`（T10）——跨任务引用名称一致。

---

## Execution Record

（执行时逐任务追加：任务 / commit / 结果）
