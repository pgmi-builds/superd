# P1 · 最小 cordis 宿主 + repo 骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建起 superd 源码仓：双包骨架（`superD` CLI + `@pgmi-builds/superd-web-bundle`）+ 最小 cordis 宿主，dev 实例（4999 + `.superd-test` home）能 boot 并经 token URL 访问**中性底座空壳 UI**。

**Architecture:** 完全复用上游 `@deepseek-ai/dsh-app-boot` 的 boot/profile/bundle 机制（独立 App 形态，非 dsh 插件）：superd CLI 解析 flags → 引导 `~/.superd/profiles/web/` profile（bundles = 自有 bundle 包）→ `boot()` 挂 cordis 树。自有 bundle 包 = `cordis.patch.yml`（载体 + 中性 UI roster，行形状对齐上游 `dsh-web-app` bundle patch）+ 两个胶水插件（startup：cmdlineArgs→webStartup；runtime：webRuntime + frontend dist 服务 + URL 行）。**不含** dsh-base/dsh-web-app（无 agent 运行时、无会话数据面）——空壳即特性。

**Tech Stack:** Node ≥22.18 · TypeScript（tsx 直跑，无构建步）· vitest · npm workspaces · 上游 exact-pin `0.1.3-alpha.2` 系列

**Spec:** `docs/00-blueprint.md` v0.4a（§2 架构/骨架形态、§5 依赖策略、§10 M1）；`docs/01-component-boundaries.md` v0.3（§2 Host 边界、§4① 中性底座 roster）；ADR 0001（最小 cordis 宿主）、ADR 0005（exact-pin 不 vendor 源码）。

**本地参照（一手源码，勿改）:** `/home/u1/workspaces/superd/upstream/deepseek-harness`（浅克隆，**HEAD = `dsh-v0.1.3-alpha.2`**，与 pin 同版；`dsh-v0.1.2-alpha.5` / `dsh-v0.1.2-rc.1` 两 tag 已 fetch 在本地可 diff——alpha.5 是研究语料基线，rc.1 相对 alpha.5 为纯版本号 bump、252 处全是 package.json 版本行）。关键文件锚点见各任务。

## Global Constraints

- exact-pin，无 `^`：dsh 系列全部 `0.1.3-alpha.2`；`@deepseek-ai/cordis@4.0.2`、`cordis-plugin-loader@1.0.3`、`cordis-plugin-include@1.0.7`、`@deepseek-ai/schemastery@3.18.2`。
  **版本裁决（2026-09-08 user 裁决）**：dev 基线 = **0.1.3-alpha.2**（npm `alpha` tag）——0.1.2→0.1.3 的主要变更已落在 alpha.2，后续 alpha.3+ 破坏性预期递减，且 superd 要贴近 upstream 跟跑。切换前已对 P1 依赖面逐项核验：`boot()`/`initProfile`/`loadProfile`/`composeEntries`/`healProfilesModuleFallback`/`provideCmdline` 签名全部未变；`cmdlineArgs` 服务为 getter 形态（`{ get(): readonly string[] }`，Task 4 已按此实现）；web-app patch yml 的变更全部落在 superd 不挂的行（open-in-app / file-upload / system-prompt 等）。**对齐纪律**：上游每发一版（alpha.3 / beta / rc…）跑一次显式对齐轮——diff 关键文件清单（app-boot index/profile、web-app patch yml + src、cmdline、connection browser-auth/rpc-host、frontend-static、webserver、home-paths、profile-boot）→ 更新 pin → `npm test` 复验；exact-pin 使升级 = 每包一行 bump。
- 不修改任何上游包源码；组合只走 patch 层与自有插件。
- Home：`SUPERD_HOME`（默认 `~/.superd`，dev/test 用仓内 `.superd-test/`）。**`DSH_HOME` 由 bin 显式覆盖，绝不继承用户的 dsh home**。
- 端口：默认 **3090**；dev/test 一律 **4999**（机器共用惯例，用完即停）。
- 品牌纪律：URL 行前缀 `superd:`；上游 UI 内的 DSH 字样原样保留（蓝图 §1）。
- npm 为包管理器（2026-09-08 裁决：bun 非关键路径，npm 交付可行）。
- 每任务以 commit 结束；测试一律 vitest（`npm test`）。
- repo 本地 node_modules 是唯一依赖来源；禁止 NODE_PATH / 全局树解析。
- sandbox 坑：`npm install` 默认缓存 `~/.npm` 在受限沙箱下 EROFS —— 一律加 `--cache .npm-cache`（仓内缓存，已 gitignore）。

---

### Task 1: Repo 骨架 + exact-pin 安装

**Files:**
- Create: `package.json`（根，`superD`）
- Create: `packages/superd-web-bundle/package.json`（骨架，本任务只建包不写代码）
- Create: `packages/superd-web-bundle/cordis.patch.yml`（先 `[]`，Task 3 填充）
- Create: `tsconfig.json`、`vitest.config.ts`
- Modify: `.gitignore`（追加 `.npm-cache/`、`.superd-test/` 已有）

**Interfaces:**
- Produces: 可安装的 workspace（根 + bundle 包）；后续所有任务的依赖树。

- [ ] **Step 1: 写根 package.json**

```json
{
  "name": "superD",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Super D — unified entry for multi-agent runtimes (bridge layer, no runtime of its own)",
  "engines": { "node": ">=22.18" },
  "workspaces": ["packages/*"],
  "scripts": {
    "superd": "tsx src/bin.ts",
    "test": "vitest --run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@pgmi-builds/superd-web-bundle": "0.1.0",
    "@deepseek-ai/cordis": "4.0.2",
    "@deepseek-ai/cordis-plugin-loader": "1.0.3",
    "@deepseek-ai/cordis-plugin-include": "1.0.7",
    "@deepseek-ai/schemastery": "3.18.2",
    "@deepseek-ai/dsh-app-boot": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-cmdline": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-host-webserver": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-host-frontend-static": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-web-frontend": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-client-modules": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-client-connection": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-client-hmr": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-client-locale": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-api-gateway": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-api-remotes": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-cordis-client-runner": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-cordis-host-runner": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-typert-protocol": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-typert-registry": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-typert-loader": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-client-ui-slots": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-client-ui-renderer": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-client-ui-layout": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-client-ui-sidebar": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-client-ui-theme": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-client-ui-settings": "0.1.3-alpha.2",
    "commander": "15.0.0"
  },
  "devDependencies": {
    "@types/node": "22.10.5",
    "tsx": "4.22.4",
    "typescript": "5.9.3",
    "vitest": "4.1.10"
  }
}
```

- [ ] **Step 2: 写 bundle 包骨架 package.json + 空 patch**

`packages/superd-web-bundle/package.json`：

```json
{
  "name": "@pgmi-builds/superd-web-bundle",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "superD web-surface bundle: carrier + neutral-base UI roster patch plus the superd glue plugins (startup provider, web runtime)",
  "exports": {
    ".": "./src/index.ts",
    "./startup": "./src/startup.ts",
    "./web-command": "./src/web-command.ts",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "4.0.2",
    "@deepseek-ai/schemastery": "3.18.2",
    "@deepseek-ai/dsh-host-webserver": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-host-frontend-static": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-client-connection": "0.1.3-alpha.2",
    "@deepseek-ai/dsh-cmdline": "0.1.3-alpha.2",
    "commander": "15.0.0"
  }
}
```

`packages/superd-web-bundle/cordis.patch.yml`（占位，Task 3 填充）：

```yaml
[]
```

- [ ] **Step 3: 写 tsconfig.json / vitest.config.ts / .gitignore 追加**

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "packages/*/src", "test"]
}
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
```

`.gitignore` 追加一行 `.npm-cache/`。

- [ ] **Step 4: 安装并验证依赖名全部存在**

```bash
cd /home/u1/workspaces/superd && npm install --cache .npm-cache
```

Expected: 正常完成，无 ERESOLVE/404。若某个包名 404：对照
`upstream/deepseek-harness`（`ls packages/*/ -d` 与各 package.json 的 `name` 字段）修正拼写后重跑。

再验证 exact-pin 生效（抽查两个）：

```bash
node -e "console.log(require('@deepseek-ai/cordis/package.json').version)"   # 4.0.2
node -e "console.log(require('@deepseek-ai/dsh-app-boot/package.json').version)"  # 0.1.3-alpha.2
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore packages/
git commit -m "chore(P1): repo scaffold — superD root + superd-web-bundle workspace, exact-pin 0.1.3-alpha.2"
```

---

### Task 2: Home 解析模块（SUPERD_HOME → DSH_HOME 接管）

**Files:**
- Create: `src/home.ts`
- Test: `test/home.spec.ts`

**Interfaces:**
- Produces: `resolveSuperdHome(explicit?: string): string`；`applySuperdHomeEnv(explicit?: string): string`（设置 `SUPERD_HOME` + **覆盖** `DSH_HOME` 后返回 home）。Task 6 的 bin 依赖两者。

- [ ] **Step 1: 写失败测试** `test/home.spec.ts`

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { applySuperdHomeEnv, resolveSuperdHome } from '../src/home.ts'

describe('superd home', () => {
  afterEach(() => {
    delete process.env.SUPERD_HOME
    delete process.env.DSH_HOME
  })

  it('defaults to ~/.superd', () => {
    const home = resolveSuperdHome()
    expect(home.endsWith('/.superd')).toBe(true)
  })

  it('explicit flag wins over env', () => {
    process.env.SUPERD_HOME = '/from-env'
    expect(resolveSuperdHome('/from-flag')).toBe('/from-flag')
    expect(resolveSuperdHome()).toBe('/from-env')
  })

  it('applySuperdHomeEnv ALWAYS overrides DSH_HOME (never inherits a user dsh home)', () => {
    process.env.DSH_HOME = '/users-real-dsh-home'
    const home = applySuperdHomeEnv('/tmp/superd-x')
    expect(home).toBe('/tmp/superd-x')
    expect(process.env.SUPERD_HOME).toBe('/tmp/superd-x')
    expect(process.env.DSH_HOME).toBe('/tmp/superd-x')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest --run test/home.spec.ts`
Expected: FAIL（`Cannot find module '../src/home.ts'`）

- [ ] **Step 3: 实现** `src/home.ts`

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SUPERD_HOME_ENV = 'SUPERD_HOME'
export const SUPERD_HOME_DIR_NAME = '.superd'
export const DSH_HOME_ENV = 'DSH_HOME'

/** superd home 解析：显式 flag > SUPERD_HOME env > ~/.superd。 */
export function resolveSuperdHome(explicit?: string): string {
  return explicit ?? process.env[SUPERD_HOME_ENV] ?? join(homedir(), SUPERD_HOME_DIR_NAME)
}

/**
 * 在任何上游模块 import 前，把 superd home 写入环境。
 * DSH_HOME 一律覆盖：上游所有 home-paths 消费者（credentials store、
 * profiles 目录）随之落到 superd home；用户的 ~/.dsh 全程不被触碰、
 * 也不被继承。
 */
export function applySuperdHomeEnv(explicit?: string): string {
  const home = resolveSuperdHome(explicit)
  process.env[SUPERD_HOME_ENV] = home
  process.env[DSH_HOME_ENV] = home
  return home
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest --run test/home.spec.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src/home.ts test/home.spec.ts
git commit -m "feat(P1): superd home resolution — SUPERD_HOME defaults, DSH_HOME always overridden"
```

---

### Task 3: Bundle patch —— 载体 + 中性底座 roster

**Files:**
- Modify: `packages/superd-web-bundle/cordis.patch.yml`
- Test: `test/patch-compose.spec.ts`

**Interfaces:**
- Produces: bundle patch 行集合（行 id 契约）：`superd-startup` / `webserver` / `superd-runtime` / `client-hmr` / `modules` / `connection` / `api-remotes` / `cordis-host-runner` / `cordis-client-runner` / `ui-theme` / `locale` / `ui-layout` / `ui-renderer` / `ui-cordis` / `ui-sidebar` / `ui-settings`。Task 4/5 实现其中两行指向的自有插件。
- 决策记录：`ui-workspace`、`ui-settings-general` **P1 不挂**（数据面属 superD BFF 聚合，蓝图边界文档 §4① 复核位）——P2 复核后加。`ui-cordis`（调试面板）挂上，便于 P1 排障。

**参照（行形状蓝本）:** `upstream/deepseek-harness/packages/bundle/web-app/cordis.patch.yml`。

- [ ] **Step 1: 写失败测试** `test/patch-compose.spec.ts`

```ts
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { composeEntries } from '@deepseek-ai/dsh-app-boot/src/profile.ts'

const require = createRequire(import.meta.url)
const bundleDir = dirname(require.resolve('@pgmi-builds/superd-web-bundle/package.json'))
const patchPath = join(bundleDir, 'cordis.patch.yml')

describe('superd-web-bundle patch', () => {
  const patches = loadOverlayPatches('superd-test', patchPath)
  const entries = composeEntries([patches])

  it('inserts the carrier + neutral-base roster', () => {
    const ids = entries.map(row => row.id)
    expect(ids).toEqual([
      'superd-startup', 'webserver', 'superd-runtime', 'client-hmr',
      'modules', 'connection', 'api-remotes', 'cordis-host-runner',
      'cordis-client-runner', 'ui-theme', 'locale', 'ui-layout',
      'ui-renderer', 'ui-cordis', 'ui-sidebar', 'ui-settings',
    ])
  })

  it('webserver row defers to webStartup and defaults port 3090', () => {
    const row = entries.find(row => row.id === 'webserver')
    expect(row?.name).toBe('@deepseek-ai/dsh-host-webserver')
    expect(row?.inject).toEqual(['webStartup'])
  })

  it('connection row waits on webRuntime', () => {
    const row = entries.find(row => row.id === 'connection')
    expect(row?.name).toBe('@deepseek-ai/dsh-client-connection')
    expect(row?.inject).toEqual(['webRuntime'])
  })

  it('no DSH session/agent-plane rows leak in', () => {
    const ids = entries.map(row => row.id)
    for (const banned of ['session-controller', 'settings-controller', 'workspace-controller',
      'ui-chat', 'ui-conversation', 'ui-session', 'ui-workspace', 'ui-settings-general']) {
      expect(ids).not.toContain(banned)
    }
  })

  it('upstream names all resolve inside the repo node_modules', () => {
    for (const row of entries) {
      if (typeof row.name === 'string' && row.name.startsWith('@deepseek-ai/')) {
        expect(() => require.resolve(`${row.name}/package.json`), row.name).not.toThrow()
      }
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest --run test/patch-compose.spec.ts`
Expected: FAIL（entries 为空数组 / ids 不匹配）

- [ ] **Step 3: 写 cordis.patch.yml**

```yaml
# @pgmi-builds/superd-web-bundle — superD web 面的 bundle patch。
# 只含载体（wire 四面）+ 中性底座 UI 壳；不含 DSH 会话面/agent 面
# （那些由 P3+ 的 composition 层接管）。行形状对齐上游 dsh-web-app
# bundle patch（锁版 0.1.3-alpha.2）。
#
# P1 决策：ui-workspace / ui-settings-general 暂不挂（数据面待 superD
# BFF 聚合，见 docs/01-component-boundaries.md §4① 复核位）。

- insert:
    # CLI flags → webStartup 服务（host 默认 127.0.0.1，port 默认 3090）
    - id: superd-startup
      name: '@pgmi-builds/superd-web-bundle/startup'

    # 路由载体：host/port 由 webStartup 注入
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      inject: [webStartup]
      config:
        host: !!js ctx.webStartup.host ?? '127.0.0.1'
        port: !!js ctx.webStartup.port ?? 3090
        compression: gzip
        compressionLevel: 1
        compressionThresholdBytes: 1024

    # superD 胶水：提供 webRuntime、挂 frontend-static（服务中性底座 dist）、打印 token URL
    - id: superd-runtime
      name: '@pgmi-builds/superd-web-bundle'
      inject: [webStartup]
      config:
        printUrl: true
        trustedHosts: !!js ctx.webStartup.trustedHosts

    # client 插件热更链：无 watcher 时闲置，dev 期可用
    - id: client-hmr
      name: '@deepseek-ai/dsh-client-hmr'

    # ── 浏览器 roster（node 半为 host 行）──

    # 双面：node 半扫树组装 window.__DSH_BOOT__ 并伺服 /plugins/<id>/client.js
    - id: modules
      name: '@deepseek-ai/dsh-client-modules'

    # wire 双端：node 半把 gateway 绑到 webserver /api；浏览器半是 fetch/SSE 客户端
    - id: connection
      name: '@deepseek-ai/dsh-client-connection'
      inject: [webRuntime]
      config:
        trustedHosts: !!js ctx.webRuntime.trustedHosts

    - id: api-remotes
      name: '@deepseek-ai/dsh-api-remotes'

    - id: cordis-host-runner
      name: '@deepseek-ai/dsh-cordis-host-runner'

    - id: cordis-client-runner
      name: '@deepseek-ai/dsh-cordis-client-runner'

    - id: ui-theme
      name: '@deepseek-ai/dsh-client-ui-theme'

    - id: locale
      name: '@deepseek-ai/dsh-client-locale'

    - id: ui-layout
      name: '@deepseek-ai/dsh-client-ui-layout'

    - id: ui-renderer
      name: '@deepseek-ai/dsh-client-ui-renderer'

    # Cordis 调试面板（组合态可视，P1 排障用）
    - id: ui-cordis
      name: '@deepseek-ai/dsh-client-ui-cordis'

    - id: ui-sidebar
      name: '@deepseek-ai/dsh-client-ui-sidebar'

    - id: ui-settings
      name: '@deepseek-ai/dsh-client-ui-settings'
```

注意：`ui-cordis` 需在 Task 1 依赖清单基础上补 `@deepseek-ai/dsh-client-ui-cordis@0.1.3-alpha.2`（root `package.json` dependencies 加一行，`npm install --cache .npm-cache`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest --run test/patch-compose.spec.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add packages/superd-web-bundle/cordis.patch.yml package.json package-lock.json test/patch-compose.spec.ts
git commit -m "feat(P1): superd-web-bundle patch — carrier + neutral-base roster, no DSH session/agent rows"
```

---

### Task 4: Startup 插件 + web flag 家族（cmdlineArgs → webStartup）

**Files:**
- Create: `packages/superd-web-bundle/src/web-command.ts`（commander 程序工厂，usage/测试/插件共用）
- Create: `packages/superd-web-bundle/src/startup.ts`
- Test: `test/web-command.spec.ts`

**Interfaces:**
- Consumes: `cmdlineArgs` 服务（**getter 形态** `{ get(): readonly string[] }`，见 `@deepseek-ai/dsh-cmdline` 的 `CmdlineArgs`）+ `appExit`——均由 bin 的 `provideCmdline(ctx, {args, exit})` 提供（Task 6）。
- Produces: `webStartup` 服务 `{host?: string, port?: number, openBrowser: false, trustedHosts: string[]}`（host/port 未指定时**省略**，默认值在 patch 行的 `!!js` 表达式里：127.0.0.1 / 3090）；`superdWebCommand(): Command` 工厂 + `WebOptions`。
- 形态对齐上游（0.1.3-alpha.2 `packages/bundle/web-app/src/startup.ts`）：commander 程序声明 flag 家族 → `program.action` 发布服务 → `parseCmdline(ctx, program)` 接管解析 / `--help` / 错误退出（经 `appExit` 优雅失败）。**bin 不做 fail-fast 预解析**（上游同款分工）。

- [ ] **Step 1: 写失败测试** `test/web-command.spec.ts`

```ts
import { describe, expect, it } from 'vitest'
import { superdWebCommand, type WebOptions } from '@pgmi-builds/superd-web-bundle/web-command'

function parse(args: string[]): WebOptions {
  const program = superdWebCommand()
  program.exitOverride() // 把 program.error/help 变 throw，测试可断言
  program.parse(args, { from: 'user' })
  return program.opts<WebOptions>()
}

describe('superd web command', () => {
  it('defaults: open true, no host/port, no trusted hosts', () => {
    const options = parse([])
    expect(options.open).toBe(true)
    expect(options.host).toBeUndefined()
    expect(options.port).toBeUndefined()
    expect(options.trustedHost).toBeUndefined()
  })

  it('parses host/port/trusted-host (repeatable) and --no-open', () => {
    const options = parse(['--host', '127.0.0.1', '--port', '4999', '--no-open',
      '--trusted-host', 'a.example', '--trusted-host', 'b.example'])
    expect(options.host).toBe('127.0.0.1')
    expect(options.port).toBe('4999')
    expect(options.open).toBe(false)
    expect(options.trustedHost).toEqual(['a.example', 'b.example'])
  })

  it('rejects non-numeric ports (fail loud in the tree, not the bin)', () => {
    expect(() => parse(['--port', 'nope'])).toThrow(/number/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest --run test/web-command.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/superd-web-bundle/src/web-command.ts`

```ts
/** superd web 子命令的 flag 家族（commander 程序工厂；usage 文本/测试/插件共用）。 */
import { Command } from 'commander'

/** commander 解析后的 web options（trustedHost 对应可重复的 --trusted-host）。 */
export interface WebOptions {
  host?: string
  port?: string
  open: boolean
  trustedHost?: string[]
}

/** flag 程序工厂：每次返回新鲜实例（一进程可多次解析，上游同款）。 */
export function superdWebCommand(): Command {
  return new Command()
    .name('superd web')
    .description('Serve the superD web surface.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host (default 127.0.0.1)')
    .option('--no-open', 'accepted for upstream parity; superd never auto-opens a browser')
    .option('--port <port>', 'listen port (default 3090)')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (repeatable)')
    .addHelpText('after', '\nExamples:\n  superd web --port 4999 --home .superd-test\n')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest --run test/web-command.spec.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 实现 startup 插件** `packages/superd-web-bundle/src/startup.ts`

```ts
/**
 * superd-web-startup — cmdlineArgs → webStartup 提供者（上游 web-startup 同款形态）：
 * commander 程序声明 flag 家族，action 发布服务，parseCmdline 接管解析、
 * --help 与错误退出（经 appExit）。host/port 未指定时省略——默认值在
 * bundle patch 行的 !!js 表达式里（127.0.0.1 / 3090）。
 * 参照 upstream/deepseek-harness/packages/bundle/web-app/src/startup.ts（0.1.3-alpha.2）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { superdWebCommand, type WebOptions } from './web-command.ts'

export const name = 'superd-web-startup'

export const inject = ['cmdlineArgs']

/** web 面启动值：webserver / superd-runtime 行的 !!js 表达式消费。 */
export interface WebStartup {
  host?: string
  port?: number
  openBrowser: boolean
  trustedHosts: string[]
}

export function apply(ctx: Context): void {
  const program = superdWebCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    ctx.provide('webStartup', {
      openBrowser: false, // superd 从不自动开浏览器（--no-open 仅为上游形位兼容）
      ...options.host !== undefined && { host: options.host },
      ...options.port !== undefined && { port: Number(options.port) },
      trustedHosts: options.trustedHost ?? [],
    } satisfies WebStartup)
  })
  parseCmdline(ctx, program)
}
```

- [ ] **Step 6: typecheck + 全量测试**

Run: `npm run typecheck && npm test`
Expected: typecheck 0 错误；全部 PASS

- [ ] **Step 7: Commit**

```bash
git add packages/superd-web-bundle/src/web-command.ts packages/superd-web-bundle/src/startup.ts test/web-command.spec.ts
git commit -m "feat(P1): web flag family (commander) + startup plugin (parseCmdline -> webStartup)"
```

---

### Task 5: Runtime 胶水插件（webRuntime + frontend dist + URL 行）

**Files:**
- Create: `packages/superd-web-bundle/src/index.ts`
- Test: `test/bundle-runtime.spec.ts`

**Interfaces:**
- Consumes: `webServer` 服务（inject）；`@deepseek-ai/dsh-host-frontend-static` 插件；`@deepseek-ai/dsh-web-frontend` 包（dist 资产）。
- Produces: `webRuntime` 服务 `{lanAddresses: string[], trustedHosts: string[]}`；stdout URL 行 `superd: http://127.0.0.1:<port>/?token=…`。

**参照（蓝本，瘦身不改语义）:** `upstream/deepseek-harness/packages/bundle/web-app/src/index.ts`（`resolveLanTrust` / `resolveDistIndex` / announce 流程；superd 砍掉 systemPrompt/shellEnv/SSH 探测/浏览器拉起——P1 只打印 URL）。

- [ ] **Step 1: 写失败测试** `test/bundle-runtime.spec.ts`

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDistIndex, resolveLanTrust } from '@pgmi-builds/superd-web-bundle'

describe('resolveLanTrust', () => {
  it('loopback bind carries no LAN addresses', () => {
    const trust = resolveLanTrust('127.0.0.1', ['extra.example'])
    expect(trust.lanAddresses).toEqual([])
    expect(trust.trustedHosts).toEqual(['extra.example'])
  })

  it('all-interfaces bind derives LAN IPv4 literals', () => {
    const trust = resolveLanTrust('0.0.0.0', [])
    expect(trust.lanAddresses.length).toBeGreaterThan(0)
    expect(trust.trustedHosts).toEqual(trust.lanAddresses)
  })
})

describe('resolveDistIndex', () => {
  it('resolves the pinned web-frontend dist index.html', () => {
    const distIndex = resolveDistIndex()
    expect(distIndex.endsWith('dist/index.html')).toBe(true)
    expect(distIndex).toContain('dsh-web-frontend')
  })

  it('DSH_WEB_FRONTEND_DIR override wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'superd-dist-'))
    writeFileSync(join(dir, 'index.html'), '<html></html>')
    process.env.DSH_WEB_FRONTEND_DIR = dir
    try {
      expect(resolveDistIndex()).toBe(join(dir, 'index.html'))
    } finally {
      delete process.env.DSH_WEB_FRONTEND_DIR
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest --run test/bundle-runtime.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/superd-web-bundle/src/index.ts`

```ts
/**
 * @pgmi-builds/superd-web-bundle — superD web 面 bundle 的运行时胶水插件
 * （bundle patch 由同包 cordis.patch.yml 声明）。职责：bind 后提供
 * webRuntime（LAN 信任快照）、以 frontend-static fallback owner 伺服中性
 * 底座 dist、Loader 收敛后打印带 token 的 URL 行。
 * 蓝本：upstream dsh-web-app 的 web-runtime 行（锁版 0.1.3-alpha.2），
 * 砍掉 DSH 特有面（systemPrompt/shellEnv/SSH 探测/浏览器拉起）。
 */
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'

export const name = 'superd-web-bundle'

export const inject = ['webServer']

export interface Config {
  /** Loader 收敛后打印 URL 行（supervisor 就绪信号）。 */
  printUrl: boolean
  /** 显式 --trusted-host 追加权威。 */
  trustedHosts: string[]
}

export const Config: z<Config> = z.object({
  printUrl: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
})

/** bind 依赖的 Web 运行值：connection 行的信任栅栏消费。 */
export interface WebRuntimeValues {
  lanAddresses: string[]
  trustedHosts: string[]
}

const ALL_INTERFACES_HOST = '0.0.0.0'
const LOOPBACK_HOST = '127.0.0.1'

/** 从实际 bind 推导一份 LAN 信任快照（IP 字面量免端口，防 DNS rebinding）。 */
export function resolveLanTrust(bindHost: string, extra: readonly string[]): WebRuntimeValues {
  const lanAddresses = bindHost === ALL_INTERFACES_HOST
    ? Object.values(networkInterfaces()).flat()
      .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
      .map(iface => iface.address)
    : []
  return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] }
}

/**
 * dist 定位是本 bundle 的装配事实而非用户配置：锚在 frontend 包 manifest 上。
 * 存在性是请求期问题（fallback owner 按请求读盘）。
 */
export function resolveDistIndex(): string {
  const override = process.env.DSH_WEB_FRONTEND_DIR
  if (override !== undefined && override !== '') return join(override, 'index.html')
  const require = createRequire(import.meta.url)
  try {
    return join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html')
  } catch {
    throw new Error('superd-web-bundle: @deepseek-ai/dsh-web-frontend is not resolvable from this composition')
  }
}

/** 测试钩子（生产不改）。 */
export const internals = { resolveDistIndex }

export function apply(ctx: Context, config: Config): void {
  const runtime = resolveLanTrust(ctx.webServer.host, config.trustedHosts)
  // bind 依赖值采样一次后放行 connection 行
  ctx.provide('webRuntime', runtime)
  ctx.plugin(FrontendStatic, { distIndex: internals.resolveDistIndex() })
  if (config.printUrl) {
    ctx.inject(['connection'], (connectionCtx) => {
      const announce = (): void => {
        const port = connectionCtx.webServer.port
        const authenticatedUrl = connectionCtx.connection.authenticatedUrl(`http://${LOOPBACK_HOST}:${String(port)}`)
        const lanCandidate = runtime.lanAddresses[0]
        const lanUrl = lanCandidate === undefined
          ? undefined
          : connectionCtx.connection.authenticatedUrl(`http://${lanCandidate}:${String(port)}`)
        console.log(`superd: ${authenticatedUrl}${lanUrl === undefined ? '' : ` (LAN: ${lanUrl})`}`)
      }
      // URL 行是就绪信号：必须等 Loader 全树收敛（上游同款纪律）
      const settled = connectionCtx.get('loader')?.await()
      if (settled === undefined) announce()
      else void settled.then(() => {
        if (connectionCtx.get('webServer') !== undefined && connectionCtx.get('connection') !== undefined) announce()
      }, () => {})
    })
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest --run test/bundle-runtime.spec.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add packages/superd-web-bundle/src/index.ts test/bundle-runtime.spec.ts
git commit -m "feat(P1): superd-web-bundle runtime glue — webRuntime, frontend dist serving, token URL line"
```

---

### Task 6: CLI bin —— profile 引导 + boot 接线 + dump-config

**Files:**
- Create: `src/bin.ts`（薄壳：先定 home 再动态 import）
- Create: `src/superd.ts`（CLI + 启动器）
- Test: `test/launcher.spec.ts`

**Interfaces:**
- Consumes: `applySuperdHomeEnv`（Task 2）；`@deepseek-ai/dsh-app-boot` 的 `boot` / `composeEntries` / `healProfilesModuleFallback` / `installFailLoud` / `loadProfile` / `PROFILE_PATCH_FILENAME`；`@deepseek-ai/dsh-app-boot/src/profile.ts` 的 `initProfile`（主入口不导出，走 `./src/*` exports 豁免）；`@deepseek-ai/dsh-cmdline` 的 `provideCmdline`（`{args, exit}`；`ready` 在 0.1.3-alpha.2 为可选，P1 不传）。坏 flag 不在 bin 预解析——树内 startup 插件经 `parseCmdline` + `appExit` 优雅失败（上游同款分工）。
- Produces: `superd web [--host H] [--port N] [--trusted-host H]… [--dump-config] [--home PATH]`；profile `web`（bundles = `['@pgmi-builds/superd-web-bundle']`，patchReload `startup`）。

**参照（启动器蓝本）:** `upstream/deepseek-harness/apps/cli/src/profile-boot.ts`（runProfile 流程；P1 简化：无 telemetry/launch-environment/patch live-watch——profile patchReload 定为 `startup`，改 patch 重启生效）。

- [ ] **Step 1: 写失败测试** `test/launcher.spec.ts`

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(import.meta.dirname, '..')

function runSuperd(args: string[]): string {
  return execFileSync(
    process.execPath,
    ['--import', 'tsx/esm', 'src/bin.ts', ...args],
    { cwd: repoRoot, encoding: 'utf8' },
  )
}

describe('superd CLI', () => {
  it('usage fails loud on unknown subcommand', () => {
    expect(() => runSuperd(['wat']))
      .toThrow(/unknown command|usage/si)
  })

  it('web --dump-config composes the bundle layer without booting', () => {
    const home = mkdtempSync(join(tmpdir(), 'superd-launcher-'))
    const out = runSuperd(['web', '--dump-config', '--home', home])
    const entries = JSON.parse(out) as Array<{ id?: string }>
    const ids = entries.map(row => row.id)
    expect(ids).toContain('webserver')
    expect(ids).toContain('superd-runtime')
    expect(ids).not.toContain('ui-chat')
    // profile 被初始化在 superd home 下
    const manifest = JSON.parse(readFileSync(join(home, 'profiles/web/package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toEqual(['@pgmi-builds/superd-web-bundle'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest --run test/launcher.spec.ts`
Expected: FAIL（`src/bin.ts` 不存在）

- [ ] **Step 3: 实现 bin 薄壳** `src/bin.ts`

```ts
#!/usr/bin/env node
/**
 * superd CLI 薄壳：在任何可能（传递地）读 harness home 的模块加载前，
 * 先把 superd home 写入环境。ESM 静态 import 先于 main 体执行——所以
 * home 模块只准 import node: 内建，其余全部走动态 import。
 */
import { applySuperdHomeEnv } from './home.ts'

const args = process.argv.slice(2)
const homeIdx = args.indexOf('--home')
applySuperdHomeEnv(homeIdx !== -1 ? args[homeIdx + 1] : undefined)

void import('./superd.ts')
```

- [ ] **Step 4: 实现 CLI + 启动器** `src/superd.ts`

```ts
/**
 * superd CLI：P1 只有 web 子命令。
 * 启动器 = 上游 profile-boot.ts 的 P1 简化：profile 组装 → heal module
 * fallback → boot(prepare 提供 cmdlineArgs)。patchReload 定 'startup'
 * （无 live watcher；改 patch 重启生效）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  boot, composeEntries, healProfilesModuleFallback, installFailLoud, loadProfile,
  PROFILE_PATCH_FILENAME,
} from '@deepseek-ai/dsh-app-boot'
import { initProfile } from '@deepseek-ai/dsh-app-boot/src/profile.ts'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'

const NAME = 'superd'
const PROFILE_NAME = 'web'
const PROFILE_ROOT_FILENAME = 'cordis.yml'
const DEFAULT_BUNDLES = ['@pgmi-builds/superd-web-bundle']
const PROFILE_ROOT_CONFIG = '# superd profile root — composition is patch layers.\n[]\n'

const require = createRequire(import.meta.url)
const INSTALL_ANCHOR = require.resolve('./package.json')

function ensureProfile(home: string): string {
  const dir = join(home, 'profiles', PROFILE_NAME)
  initProfile(dir, DEFAULT_BUNDLES, 'startup')
  // 根配置每跑必重写：整棵树是 patch 层（上游同款纪律，防 loader 写回烘焙行）
  writeFileSync(join(dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return dir
}

async function runWeb(): Promise<void> {
  const home = process.env.DSH_HOME!
  const profileDir = ensureProfile(home)
  const profile = loadProfile(NAME, PROFILE_NAME, INSTALL_ANCHOR, home)
  await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile, home })

  if (process.argv.includes('--dump-config')) {
    const layers = profile.layers.map(layer => layer.patches)
    console.log(JSON.stringify(composeEntries(structuredClone(layers)), undefined, 2))
    return
  }

  let app: Context | undefined
  installFailLoud(NAME, process, async () => {
    await app?.fiber.dispose()
  })
  const patches = structuredClone([
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
  ])
  app = await boot(NAME, join(profileDir, PROFILE_ROOT_FILENAME), patches, (hostCtx) => {
    provideCmdline(hostCtx, {
      args: process.argv.slice(2),
      exit: code => process.exit(code),
    })
  })
  const shutdown = (code: number): void => {
    void app?.fiber.dispose().finally(() => process.exit(code))
  }
  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(130))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (command === 'web') {
    await runWeb()
  } else if (command === undefined || command === '--help' || command === '-h') {
    console.log('usage: superd <command> [flags]\n\ncommands:\n  web    start the superD web surface\n\nflags:\n  --home <path>            superd home (default ~/.superd)\n  --host <addr>            bind host (default 127.0.0.1)\n  --port <n>               port (default 3090)\n  --trusted-host <name>    extra trust-fence authority (repeatable)\n  --dump-config            print the composed entry list and exit')
  } else {
    console.error(`superd: unknown command ${command}; try --help`)
    process.exitCode = 2
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest --run test/launcher.spec.ts`
Expected: PASS（2 tests）

- [ ] **Step 6: Commit**

```bash
git add src/bin.ts src/superd.ts test/launcher.spec.ts
git commit -m "feat(P1): superd CLI — web subcommand, profile bootstrap, boot wiring, dump-config"
```

---

### Task 7: 集成冒烟（P1 验收门）+ README

**Files:**
- Test: `test/smoke-web.spec.ts`
- Create: `README.md`（仓根）

**Interfaces:**
- Consumes: 全部前序任务产物。
- Produces: P1 验收证据：boot 成功、401 探针指纹、token→cookie→200 全链、boot graph 含中性 roster。

- [ ] **Step 1: 写集成冒烟测试** `test/smoke-web.spec.ts`

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const PORT = 4999
const BASE = `http://127.0.0.1:${PORT}`
const repoRoot = join(import.meta.dirname, '..')

describe('superd web smoke (P1 acceptance)', { timeout: 120_000, sequential: true }, () => {
  let child: ChildProcess | undefined
  let tokenUrl = ''

  it('boots on 4999 and prints the token URL line', async () => {
    const home = mkdtempSync(join(tmpdir(), 'superd-smoke-'))
    child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', 'src/bin.ts', 'web', '--port', String(PORT), '--home', home],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderr = ''
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => { stderr += chunk })
    tokenUrl = await new Promise<string>((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(
        () => reject(new Error(`no URL line within 60s\nstderr:\n${stderr}\nstdout:\n${buf}`)), 60_000)
      child!.stdout!.setEncoding('utf8')
      child!.stdout!.on('data', (chunk: string) => {
        buf += chunk
        const match = buf.match(/^superd: (https?:\/\/\S+)/m)
        if (match?.[1]) { clearTimeout(timer); resolve(match[1]) }
      })
      child!.on('exit', code => { clearTimeout(timer); reject(new Error(`exited early code=${code}\nstderr:\n${stderr}`)) })
    })
    expect(tokenUrl).toContain(`127.0.0.1:${PORT}/?token=`)
  })

  it('unauthenticated probe → 401 with the upstream dsh-auth fingerprint', async () => {
    const res = await fetch(`${BASE}/`)
    expect(res.status).toBe(401)
    expect(await res.text()).toContain('dsh web authentication required')
  })

  it('token URL mints a cookie; authenticated shell serves 200 with the neutral roster', async () => {
    const mint = await fetch(tokenUrl, { redirect: 'manual' })
    expect(mint.status).toBe(303)
    const setCookie = mint.headers.get('set-cookie')
    expect(setCookie).toMatch(/^dsh-auth-/)
    const cookie = setCookie!.split(';')[0]!

    const page = await fetch(`${BASE}/`, { headers: { cookie } })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('__DSH_BOOT__')
    for (const id of ['modules', 'connection', 'api-remotes', 'ui-layout', 'ui-renderer', 'ui-sidebar', 'ui-settings']) {
      expect(html).toContain(id)
    }
  })

  afterAll(() => { child?.kill('SIGTERM') })
})
```

- [ ] **Step 2: 跑冒烟（预期可能首次失败，逐项修到绿）**

Run: `npx vitest --run test/smoke-web.spec.ts`
Expected: PASS（3 tests）。修障提示：
- 行挂起（无 URL 行）→ 看 stderr：多为某行 inject 的服务名拼错（`webStartup`/`webRuntime`/`cmdlineArgs`），或 bundle 包在 profile 目录不可解析（确认 root `node_modules/@pgmi-builds/superd-web-bundle` symlink 在）。
- roster 断言失败 → `curl` 鉴权后页面检查 `__DSH_BOOT__` 实际 id 集合；若是 client 半未被 `modules` 扫到，确认 `ui-cordis` 等行的包已安装。
- 若 `ui-cordis` 或 `ui-settings` 在浏览器侧报运行时错 → 把该行 `disabled: true` 并在 commit message 记录（P2 复核）；sidebar/renderer/layout 不得禁。

- [ ] **Step 3: 全量测试 + 手工核验**

```bash
npm run typecheck && npm test
```

Expected: 全绿。再手工跑一遍 dev 实例并浏览器打开确认空壳可渲染（可选但推荐）：

```bash
mkdir -p .superd-test && npm run superd -- web --port 4999 --home .superd-test
# 浏览器打开打印的 token URL → 应见中性底座空壳（sidebar + 空 settings 页），
# 会话区为空（无 composition）——这是 P1 的正确形态
```

- [ ] **Step 4: 写 README.md（仓根）**

```markdown
# Super D (superd)

多 Agent 运行时的统一入口——桥接层 App。不提供运行时：把本机与远端已有的
Agent 运行时映射到 DSH Web UI 可消费的数据面。设计文档见 `docs/`（蓝图 v0.4a +
组件边界 v0.3 + ADR 0001–0007）。

## Dev（P1 骨架）

```bash
npm install --cache .npm-cache
npm run superd -- web --port 4999 --home .superd-test   # dev 实例：4999 + 仓内 home
```

- 默认端口 3090；dev 一律 4999（共用惯例，用完即停）。
- home 默认 `~/.superd`；`--home`/`SUPERD_HOME` 覆盖；用户 `DSH_HOME` 永不被继承。
- `superd web --dump-config` 打印组合后的插件行表。
- 上游参照 checkout：`upstream/deepseek-harness`（pristine `dsh-v0.1.3-alpha.2`，gitignored，勿改）。

## Test

```bash
npm test          # vitest 单测 + 4999 集成冒烟
npm run typecheck
```

## Layout

- `src/` — superd CLI（bin 薄壳 + web 启动器 + home 解析）
- `packages/superd-web-bundle/` — web 面 bundle：载体 + 中性底座 roster patch + 胶水插件
- `docs/` — 蓝图、组件边界、ADR、研究档、实现计划（`docs/superpowers/plans/`）
```

- [ ] **Step 5: Commit + tag**

```bash
git add test/smoke-web.spec.ts README.md
git commit -m "feat(P1): integration smoke (401 fingerprint / token mint / neutral roster) + README"
git tag p1-minimal-cordis-host
```

---

## Self-Review 记录

- **Spec 覆盖**：蓝图 §2 骨架形态（cordis 宿主 + 载体原样 + 自有插件）→ Task 3/4/5；§5 方案 B exact-pin → Task 1；蓝图 #3/#16（home/端口）→ Task 2/全局约束；M1 第一条「UI 完整可访问（中性底座）」→ Task 7（composition 部分 M1 内由 P3 补 agent-ui-dsh）。ui-workspace 复核位 → Task 3 决策记录。
- **占位符扫描**：无 TBD；所有代码块完整可落地。
- **类型一致性**：`WebOptions`/`WebStartup`/`WebRuntimeValues` 定义与消费点已互检；`cmdlineArgs` 按 0.1.3-alpha.2 实况走 getter（不经属性直读）；`initProfile` 走 `src/profile.ts` 导入（exports map `./src/*` 豁免，已核验 exports 实况）。
- **已知风险**：① 中性底座 UI 包是否有隐性 DSH 数据面依赖（冒烟 Step 2 修障路径已给）② ~~npm registry 版本可得性~~ → 已闭案：`@deepseek-ai/dsh-app-boot@0.1.3-alpha.2` lockstep 已核 registry（Task 1 Step 4 校验兜底保留）③ ~~provideCmdline 形态~~ → 已闭案：0.1.3-alpha.2 源码实证 `CmdlineArgs` 为 getter、`ready` 可选；Task 4 startup 已按上游同款 `parseCmdline + commander` 形态实现 ④ 上游 0.1.3 线仍在 alpha 段滚动——每次发版按 Global Constraints 裁决块的对齐轮清单复验。
