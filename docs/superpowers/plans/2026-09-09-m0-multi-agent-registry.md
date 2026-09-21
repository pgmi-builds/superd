
> **【状态：随方向搁置（SHELVED）2026-09-10】** M0 registry 占位 已按计划完成并通过验收，但上层方向（multi-agent registry 路线）经 2026-09-09/10 实测判定服务面无法隔离而搁置；本计划及其产物转入维护模式，不再演进。见 `docs/02-dsh/multi-agent-registry.md` 顶部状态。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 验证 `MultiAgentRegistry extends AgentRegistry` 继承占位链条：patch 行 name 重指后 DSH 完整启动、原生 agent loop 全功能、`appendFactory` 多槽代码路径存在但无人注册——零 ForeignAgent 运行时、零 UI selector、零切换逻辑。

**Architecture:** 单个 npm 包 `@pgmi-builds/dsh-multi-agent-registry`，default export 继承上游 `AgentRegistry`（cordis Service 基类构造函数 `reflect.provide('agents', this)` 完成占位），override `setFactory`（兼容腿 ≡ append native）/`appendFactory`/`create`/`resume`。随发 `cordis.patch.yml` 把 base bundle `id: agent` 行 name 重指。测试 profile（`DSH_HOME=.superd-test`）以 `link:` 依赖装载，4999 端口验证。

**Tech Stack:** TypeScript + tsc（无 bundler）；`@deepseek-ai/*` 全部 optional peerDependencies（运行期 host 自供，omp-web 同构形态）；node:test 单测。

**Spec:** `docs/02-dsh/multi-agent-registry.md`（registry 继承方案实施文档——本计划实现其 §七 M0）

## Global Constraints

- 上游源码零修改（AGENTS.md 红线 5）：`upstream/deepseek-harness` 只读参照，exact-pin `0.1.3-alpha.2`。
- 测试隔离：`DSH_HOME` 一律 `.superd-test`（仓内，gitignored）；**绝不触碰 `~/.dsh` 与 `~/.superd`**。
- 端口：dev/test 一律 4999，**用完即停**。
- npm publish 需 user 单次明确授权（本计划不含 publish）。
- 验收 = 第一人称运行时实测（起 4999 + 真实会话），进程不崩/tsc 0/单测绿只是构建卫生（AGENTS.md 红线 1a/2）。
- 每任务独立 commit；测试报告落 `docs/test-reports/`。

---

## File Structure

```
packages/dsh-multi-agent-registry/          # 新包（与 superD CLI 无依赖关系的独立包）
├─ package.json                # name/@pgmi-builds/dsh-multi-agent-registry；optional peers；files
├─ tsconfig.json               # types paths → upstream checkout
├─ cordis.patch.yml            # 一行：id: agent 行 name 重指（+ name 守卫）
├─ src/
│  └─ index.ts                 # MultiAgentRegistry（M0 全部逻辑，~120 行）
├─ types/
│  └─ @deepseek-ai/            # 最小类型面（dsh-agent/dsh-session/cordis 的 .d.ts，Task 2 定来源）
└─ test/
   └─ registry.test.mjs        # node:test：兼容腿/append/路由解析（不起 dsh）
.superd-test/                              # 测试 home（gitignored，Task 4 生成）
└─ profiles/m0/
   ├─ package.json             # deps: link:…/dsh-multi-agent-registry；bundles 声明
   └─ cordis.patch.yml         # webserver.port=4999
docs/test-reports/2026-09-09-m0-multi-agent-registry.md    # 实测报告（Task 7）
```

单文件 `src/index.ts` 理由：M0 逻辑总量 ~120 行，拆路由/注册表为时过早（YAGNI）；M1 引入真实路由键时再拆 `routing.ts`。

---

## Task 1：包骨架 + 透传版 MultiAgentRegistry

**Files:** `packages/dsh-multi-agent-registry/{package.json,tsconfig.json,src/index.ts,cordis.patch.yml}`

- [x] 写 `package.json`：`name: "@pgmi-builds/dsh-multi-agent-registry"`、`type: module`、`exports: { ".": "./dist/index.js" }`、`files: [dist, cordis.patch.yml]`、`dsh: { bundle: { patch: "./cordis.patch.yml" } }`；optional peerDependencies：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-session`（全部 `*`，运行期 host 供）；devDependencies：`typescript`（仓内已有版本，勿新装）。`.npmrc` 加 `auto-install-peers=false`（omp-web 实证：嵌套 peer 副本破坏 `scopeOf` 身份）。
- [x] 写 `src/index.ts`（M0 形态，透传为主）：
  ```ts
  import AgentRegistry from '@deepseek-ai/dsh-agent'
  import { getTraceable } from '@deepseek-ai/cordis'

  export default class MultiAgentRegistry extends AgentRegistry {
    #factories = new Map<string, AgentFactory>()

    setFactory(factory: AgentFactory): () => void { return this.#append('native', factory) }
    appendFactory(key: string, factory: AgentFactory): () => void { return this.#append(key, factory) }

    #append(key: string, factory: AgentFactory): () => void {
      if (this.#factories.has(key)) throw new Error(`an agent factory is already registered for "${key}"`)
      this.#factories.set(key, factory)
      return this.ctx.effect(() => {
        if (this.#factories.get(key) !== factory) return
        this.#factories.delete(key)
      }, `agents.append(${key})`)
    }

    #resolve(sessionId: SessionId): AgentFactory {
      // M0：无路由键来源，恒 native。M1 在此接入 header config.runtime / RPC 旁路。
      const factory = this.#factories.get('native')
      if (factory === undefined) throw new Error('no agent factory registered (load an agent-loop plugin)')
      return factory
    }

    async create(options: CreateAgentOptions) {
      const target = this.#resolve(options.sessionId)
      const receiver = getTraceable(this.ctx, target)
      return Reflect.apply(target.createAgent, receiver, [this.ctx, options])
    }
    async resume(options: ResumeAgentOptions) {
      const target = this.#resolve(options.resumeSessionId)
      const receiver = getTraceable(this.ctx, target)
      return Reflect.apply(target.resume, receiver, [this.ctx, options])
    }
  }
  ```
  注意：类型 `AgentFactory/CreateAgentOptions/ResumeAgentOptions/SessionId` 从 `@deepseek-ai/dsh-agent` re-import（type-only）。若 `this.ctx` 因上游 TS private/protected 报错，用 `(this as any).ctx` 或在子类声明 `declare protected ctx: Context`——**不改行为，只过类型**。
- [x] 写 `cordis.patch.yml`：
  ```yaml
  - id: agent
    name: '@pgmi-builds/dsh-multi-agent-registry'
  ```
  （name 重指即占位；加 `name` 守卫的完整形态 = 覆盖行写两个键，M0 先不加守卫，Task 6 实测后按 warn 行为决定。）
- [x] `git add packages/dsh-multi-agent-registry && git commit`（message: `m0: multi-agent-registry package skeleton (transparent passthrough)`）

## Task 2：类型接线

**Files:** `packages/dsh-multi-agent-registry/tsconfig.json`、`types/`

- [x] 首选方案：`tsconfig.json` `paths` 把 `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session` / `@deepseek-ai/cordis` 指到 `upstream/deepseek-harness` 的源码（`packages/core/agent/src/index.ts` 等，tag 与 pin 同版）。验证 `npx tsc -p . --noEmit` 能解析（upstream 源码含 `export default AgentRegistry` 与全部导出类型）。`.d.ts` 生成走 `tsc` 声明或直接 `declaration: true` 出 `dist/`。
- [x] 若 upstream 源码路径解析失败（相对导入扩展名 `.ts` 等问题），退路：从 upstream checkout 复制所需 `.d.ts` 进 `types/@deepseek-ai/*`（omp-web vendored-types 先例），paths 指本地。**退路只复制类型，不复制实现。**
- [x] `tsc` 出 `dist/index.js`，`node -e "import('…/dist/index.js').then(m => console.log(typeof m.default))"` 打印 `function`（class 即函数，冒烟 import 无副作用——注意此时不在 cordis 环境，只验证模块可加载）。
- [x] commit。

## Task 3：单测（不起 dsh）

**Files:** `packages/dsh-multi-agent-registry/test/registry.test.mjs`

- [x] 测试环境：从 upstream checkout 解析 `@deepseek-ai/cordis`（node ESM `imports` 字段或 NODE_OPTIONS；参照 dsh-omp `upstream/dsh` 的 source-run 经验——若 cordis 无法独立实例化，降级为纯逻辑测试：直接 `new MultiAgentRegistry(fakeCtx)`，fakeCtx 提供 `effect/on/inject/accessor/reflect.provide` 最小面——上游 `AgentRegistry` constructor 只用到这些）。
- [x] 用例：① `setFactory` 后再 `setFactory` → throw（同 key fail-loud）；② `appendFactory('omp', f)` 与 `setFactory(n)` 共存不 throw；③ disposer 调用后 key 摘除；④ `create` 委托到 native factory 且透传 options（fake factory 记录入参）；⑤ native 缺失时 `create` → no-factory 错误。
- [x] `node --test test/*.test.mjs` 全绿（注意本机 Node 22 需 glob 形态，dsh-omp 实证）。
- [x] commit。

## Task 4：测试 profile 搭建

**Files:** `.superd-test/profiles/m0/{package.json,cordis.patch.yml}`（gitignored，但把**搭建脚本**入库：`scripts/m0-profile.mjs` 或 Makefile 目标，含 mkdir/deps 写入/pnpm install 命令）

- [x] profile `package.json`：`dsh.profile.bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@pgmi-builds/dsh-multi-agent-registry"]`；deps：`"@pgmi-builds/dsh-multi-agent-registry": "link:../../packages/dsh-multi-agent-registry"`（`@deepseek-ai/*` 两个 bundle 由全局 dsh vendored 树解析，omp-web 两层解析先例）。
- [x] profile 级 `cordis.patch.yml`：`webserver.port: 4999`。
- [x] `DSH_HOME=$PWD/.superd-test dsh --profile m0 --dump-config`（只 dump 不起服）核对行表：`id: agent` 行的 name = 我们的包，`agent-loop` 行原样。**这一步就是占位的第一人称证据。**
- [x] dump 不对时排查方向：层序（我们的包必须在 bundles 列表且随发 patch 被合并）、`dsh.bundle.patch` 字段拼写、link 解析。
- [x] commit（脚本入库，`.superd-test/` 忽略）。

## Task 5：4999 实例启动验证

- [x] `ss -tlnp | grep 4999` 查占用（机器共用惯例）。
- [x] `DSH_HOME=$PWD/.superd-test dsh --profile m0 --no-open --port 4999`（后台/journalctl 取 token URL）。
- [x] 认证探针：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4999/` → 401 + `dsh web authentication required`。
- [x] `curl -c jar -L '<token-url>'` 303 落地 → shell 页 200，boot graph 正常（原生 client 面不受影响）。
- [x] 观察 stdout/journal 无 `agents` 服务相关报错、无 duplicate provide——**构造函数链（typert/accessor/effect）跑通的证据**。
- [x] commit（如有修 fix，如 name 守卫）。

## Task 6：原生会话功能验证（M0 验收核心）

- [x] 浏览器开 4999（token URL），新建会话，发一条真实消息，原生 agent loop 完整走一轮（流式输出 + 会话持久化 + 刷新后 resume）。
- [x] LLM 凭据：`.superd-test` 的 provider 配置需可用的 API key（与 user 确认来源；没有则本任务暂停上报，不得降级为"进程活着就算过"——AGENTS.md 红线 2）。
- [x] 重启实例后再开同一会话 → resume 走 `MultiAgentRegistry.resume` 透传成功（compat 腿的 resume 证据）。
- [x] 用完即停 4999。
- [x] commit。

## Task 7：测试报告 + 收尾

- [x] 写 `docs/test-reports/2026-09-09-m0-multi-agent-registry.md`：占位证据（dump 行表摘录）、401 探针、真实会话截图/日志摘录、已知限制（`#resolve` 恒 native、无路由键）。
- [x] 在 `docs/02-dsh/multi-agent-registry.md` §七 M0 条目后加 as-built 注记（一行：已完成 + 报告路径）。
- [x] commit。

---

## Verification (plan-level)

全部任务完成后，M0 的判定标准：**一个装着我们 registry 的 DSH，用户视角与原生不可区分**（启动、会话、轮次、resume 全正常），同时 `--dump-config` 证明坐槽者已是我们。任何"进程没崩就算过"的降级都不接受。

## Out of Scope（明确不做）

- 路由键（header `config.runtime` / RPC 旁路）——M1
- UI selector chip——M1
- 任何 ForeignAgent 运行时（OMP/PI/echo）——M2+；`appendFactory` 只保证编译期存在 + 单测覆盖
- npm publish / GitHub push
