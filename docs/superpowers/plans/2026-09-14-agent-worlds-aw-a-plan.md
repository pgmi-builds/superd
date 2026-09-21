# Agent Worlds AW-A（线骨架与机制三件套）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `apps/agent-worlds/` 线骨架与线级基建三件套——aw-routing（switch+gateway，拷自 multi-agent-routing V5）、roster service、`spawnWorld`（插件激活派生平级 root ctx）——并把 agent-adapter-omp 作为第一个 per-agent adapter 接线跑通（roster 反映在场、零端口 ctx-omp、`agents/omp/` 嵌套 home 出现）。

**Architecture:** agent-worlds 线自身只建设 switch 与 gateway（职责分界 2026-09-14：patches/存储适配/adapter runtime 全归 per-agent 包）。ctx 派生走 `loadProfile` + `boot()`（ADR 0008：绝不 `runProfile()`）；零端口 = world profile 组合 dsh-base + dsh-web-app 并行级 disable webserver/frontend-static（不喂 bind 参数）；嵌套 home 起步由 adapter 侧 mkdir + 后续 app-home 重定向承担（§七），ctxN 的 `dshHomePath` 覆盖留给 AW-C1。

**Tech Stack:** TypeScript（tsc）、`node --test`、`@deepseek-ai/dsh-app-boot`（loadProfile/boot）、cordis 4.0.2、上游 exact-pin。

**Spec:** `docs/superpowers/plans/2026-09-14-agent-worlds-fusion-design.md`（S1–S6 裁决、§五零端口、§十二 AW-A；计划与 spec 同读）

## Global Constraints

- 上游源码零修改；改动全走自有包与 patch 层；`@deepseek-ai/*` 依赖不写死版本（peerDependenciesMeta optional）。
- **`scripts/` 目录当前不存在于 worktree**（git index 有未完成重命名 `RD scripts/m0-profile.mjs -> scripts/profiles/m0.mjs`；根 `package.json` 的 `heal` script 暂时悬空）——本计划不依赖它；任何 `npm install` 之后必须手动跑单实例检查：
  `find node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l`（仓根；只应剩 `dsh-client-ui-slots`）。出现物理副本 = 先修复再继续。
- 缓存安装：`npm install --cache <repo>/.npm-cache`（默认 `~/.npm` 在沙箱下 EROFS）；exact-pin，无 `^`（devDeps 例外沿用被拷包现状）。
- 测试 home：`DSH_HOME=<repo>/.superd-test/aw`（gitignored）。**绝不触碰 `~/.dsh`、`~/.superd`、`~/.omp`**。
- 端口：默认 4998；避开 3080/3081（prod）与 4999（ctx0 线现役）；拉起前 `ss -tln | grep -E ':(4998)'` 预检；仅 loopback。
- daemon 一律 `systemd-run --user`（勿从 agent 沙箱直拉）；关停 `systemctl --user stop <unit>`（勿 kill）。
- 验收模式（2026-09-09 user 裁决）：起了 Web 服务器就停在验收——给出 token URL、保持运行，交用户亲测。
- 每任务独立 commit；测试约定 `node --test test/*.test.mjs`；测试导入 `../dist/index.js`，先 build 后 test。

---

### Task 1: aw-routing 包——拷贝 V5 gateway 改名跑绿

**Files:**
- Create: `apps/agent-worlds/aw-routing/**`（拷自 `apps/multi-agent-ctx/multi-agent-routing/`）
- Modify: `apps/agent-worlds/aw-routing/package.json`（包名）
- Test: 随拷贝带入的 `test/delegation.test.mjs`、`test/rpc.test.mjs`

**Interfaces:**
- Produces: `@pgmi-builds/aw-routing` 导出 `readSelector()/writeSelector()`、`GatewayFace`、`ForeignTarget`、targets 注册函数（`src/targets.ts` 的 Map 伴随函数；若原文件只导出类型，则补 `registerTarget(t: ForeignTarget): void` 与 `getTarget(key: string): ForeignTarget | undefined`，Map 逻辑原样）。后续任务依赖这些精确名字。

- [ ] **Step 1: 拷贝并改名**

```bash
cd ~/workspaces/superd/apps
mkdir -p agent-worlds
cp -r multi-agent-ctx/multi-agent-routing agent-worlds/aw-routing
cd agent-worlds/aw-routing
sed -i 's/@pgmi-builds\/multi-agent-routing/@pgmi-builds\/aw-routing/' package.json
sed -i 's/multi-agent-routing/aw-routing/g' cordis.patch.yml README.md 2>/dev/null || true
```

- [ ] **Step 2: 安装 devDeps + 单实例检查**

```bash
npm install --cache ~/workspaces/superd/.npm-cache
cd ~/workspaces/superd && find node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l
# 期望输出仅：node_modules/@deepseek-ai/dsh-client-ui-slots
```

- [ ] **Step 3: targets.ts 若缺注册函数则补齐**（保持 Map 原样，只加薄封装）

```ts
/** Register (or replace) a foreign target behind the selector. */
export function registerTarget(target: ForeignTarget): void {
  targets.set(target.key, target)
}
export function getTarget(key: string): ForeignTarget | undefined {
  return targets.get(key)
}
```

并在 `src/index.ts` 导出：`export * from './targets.js'`、`export * from './roster.js'`（Task 2 建后）。

- [ ] **Step 4: build + 测试跑绿**

```bash
cd ~/workspaces/superd/apps/agent-worlds/aw-routing
npm run build && npm test
```
Expected: tsc 0 errors；`node --test` 全绿（delegation/rpc 随拷贝用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/agent-worlds/aw-routing
git commit -m "aw: copy V5 routing gateway as line-owned aw-routing (@pgmi-builds/aw-routing)"
```

---

### Task 2: roster service（线级基建）

**Files:**
- Create: `apps/agent-worlds/aw-routing/src/roster.ts`
- Modify: `apps/agent-worlds/aw-routing/src/index.ts`（导出）
- Test: `apps/agent-worlds/aw-routing/test/roster.test.mjs`

**Interfaces:**
- Produces（Task 6 依赖，精确签名）:
  - `registerAgent(entry: RosterEntry): void` — duplicate key 抛 `Error`
  - `unregisterAgent(key: string): void`
  - `setReady(key: string, ready: boolean): void` — unknown key 抛 `Error`
  - `listAgents(): RosterEntry[]`（快照拷贝）
  - `onRosterChanged(fn: (entries: RosterEntry[]) => void): () => void`（返回退订函数）
  - `interface RosterEntry { key: string; label: string; ready: boolean }`

- [ ] **Step 1: 写失败测试**

```js
// test/roster.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerAgent, unregisterAgent, setReady, listAgents, onRosterChanged,
} from '../dist/index.js'

test('roster: register / list / duplicate throws', () => {
  registerAgent({ key: 'omp', label: 'OMP', ready: false })
  assert.deepEqual(listAgents(), [{ key: 'omp', label: 'OMP', ready: false }])
  assert.throws(() => registerAgent({ key: 'omp', label: 'x', ready: true }), /duplicate/)
})

test('roster: setReady notifies subscribers; unregister removes', () => {
  const seen = []
  const off = onRosterChanged((entries) => seen.push(entries.map((e) => e.key + ':' + e.ready)))
  setReady('omp', true)
  assert.deepEqual(listAgents(), [{ key: 'omp', label: 'OMP', ready: true }])
  assert.ok(seen.at(-1).includes('omp:true'))
  off()
  unregisterAgent('omp')
  assert.deepEqual(listAgents(), [])
  assert.throws(() => setReady('omp', false), /unknown agent/)
})
```

- [ ] **Step 2: 跑红**

```bash
cd ~/workspaces/superd/apps/agent-worlds/aw-routing && npm test
```
Expected: FAIL（`roster.js` 不存在 / 导出缺失）

- [ ] **Step 3: 最小实现**

```ts
// src/roster.ts
export interface RosterEntry { key: string; label: string; ready: boolean }

const entries = new Map<string, RosterEntry>()
const listeners = new Set<(entries: RosterEntry[]) => void>()

function emit(): void {
  const snap = listAgents()
  for (const fn of listeners) fn(snap)
}

export function registerAgent(entry: RosterEntry): void {
  if (entries.has(entry.key)) throw new Error(`roster: duplicate agent key ${entry.key}`)
  entries.set(entry.key, { ...entry })
  emit()
}

export function unregisterAgent(key: string): void {
  entries.delete(key)
  emit()
}

export function setReady(key: string, ready: boolean): void {
  const e = entries.get(key)
  if (!e) throw new Error(`roster: unknown agent ${key}`)
  e.ready = ready
  emit()
}

export function listAgents(): RosterEntry[] {
  return [...entries.values()].map((e) => ({ ...e }))
}

export function onRosterChanged(fn: (entries: RosterEntry[]) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
```

- [ ] **Step 4: build + 跑绿**

```bash
npm run build && npm test
```
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/agent-worlds/aw-routing
git commit -m "aw: roster service — plugin presence is the foreign agent roster (S2)"
```

---

### Task 3: spawnWorld（共享 home）+ boot/prepare ordering 探针（风险 2 钉板）

**Files:**
- Create: `apps/agent-worlds/aw-routing/src/spawn-world.ts`
- Create: `apps/agent-worlds/aw-routing/test/spawn-world.test.mjs`
- Create: `apps/agent-worlds/aw-routing/test/boot-prepare-ordering.test.mjs`

**Interfaces:**
- Consumes: `@deepseek-ai/dsh-app-boot` 的 `loadProfile(name, profileName, installAnchor, home)` 与 `boot(appName, cordisYmlPath, patches, prepare, bareModuleBaseUrl)`（ADR 0008 签名；第 4 参 = prepare 槽位）。
- Produces: `spawnWorld(opts: SpawnWorldOptions): Promise<Context>`
  - `interface SpawnWorldOptions { appName: string; profileName: string; installAnchor: string; home: string; extraPatches?: unknown[] }`
  - 行为：写空 include 根 → patches = profile layers + profile patches + extraPatches → `boot()`；**AW-A 不覆盖 `dshHomePath`**（共享 home，ADR 0008 约束 2 的 fallback 形态；覆盖 = AW-C1 + S3 prepare 槽位）。
- Produces（探针，写入文档注释）: boot() 的 provide 与 prepare 的先后顺序事实——决定 AW-C1 覆盖 `dshHomePath` 的可行机制。

- [ ] **Step 1: 写 ordering 探针测试（先钉事实）**

```js
// test/boot-prepare-ordering.test.mjs
import { test } from 'node:test'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ANCHOR = process.env.SUPERD_DSH_ANCHOR
  ?? '/home/u1/.local/lib/node_modules/@deepseek-ai/dsh/package.json'

test('probe: is dshHomePath already provided when prepare runs?', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-probe-'))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const report = {}
  const ctx = await boot('aw-probe', join(dir, 'cordis.yml'), [], (c) => {
    report.alreadyProvided = c.get('dshHomePath') !== undefined
    try { c.provide('dshHomePath', () => '/aw-override') ; report.reprovide = 'ok' }
    catch (e) { report.reprovide = 'threw: ' + e.message }
  })
  console.log('BOOT-PREPARE-ORDERING:', JSON.stringify(report))
  await ctx.fiber.dispose()
  // 钉板：把 report 原样写进本文件头注释与本任务 commit message；
  // `reprovide: 'ok'` ⇒ AW-C1 走 prepare 直接覆盖；`threw` ⇒ AW-C1 另择机制（记录进 spec §十一.2）。
})
```

- [ ] **Step 2: 跑探针并记录**（`SUPERD_DSH_ANCHOR` 未设时用默认全局 install；dev base 可指 `upstream/deepseek-harness/package.json`）

```bash
cd ~/workspaces/superd/apps/agent-worlds/aw-routing && npm run build && node --test test/boot-prepare-ordering.test.mjs
```
Expected: PASS，stdout 打出 `BOOT-PREPARE-ORDERING: {...}`；把结果抄进本任务 commit message 与 spec §十一.2。

- [ ] **Step 3: 写 spawnWorld 失败测试**

```js
// test/spawn-world.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnWorld } from '../dist/index.js'

const ANCHOR = process.env.SUPERD_DSH_ANCHOR
  ?? '/home/u1/.local/lib/node_modules/@deepseek-ai/dsh/package.json'
const HOME = process.env.AW_TEST_HOME ?? '/tmp/aw-spawn-test-home'

test('spawnWorld: dsh-base sibling root, full service face, no web surface', async () => {
  const [ctx0, ctxW] = await Promise.all([
    import('@deepseek-ai/dsh-app-boot').then((m) => m.boot('aw-test-ctx0',
      new URL('./fixtures/empty-root.yml', import.meta.url).pathname, [])),
    spawnWorld({ appName: 'aw-test-world', profileName: 'ctx1-min', installAnchor: ANCHOR, home: HOME }),
  ])
  assert.notEqual(ctx0, ctxW)
  for (const name of ['llm', 'sessions', 'agents', 'sessionQuery', 'typert']) {
    assert.notEqual(ctxW.get(name), undefined, name + ' present')
  }
  for (const name of ['webServer', 'sessionController', 'frontendStatic']) {
    assert.equal(ctxW.get(name), undefined, name + ' absent (dsh-base has none)')
  }
  await ctxW.fiber.dispose(); await ctx0.fiber.dispose()
})
```
并 Create 空 fixture：`test/fixtures/empty-root.yml` 内容 `[]`（单行）。

- [ ] **Step 4: 跑红** → `npm test` Expected: FAIL（spawnWorld 未导出）

- [ ] **Step 5: 最小实现**（spawner2.mjs 形态收编为库函数）

```ts
// src/spawn-world.ts
import { loadProfile, boot } from '@deepseek-ai/dsh-app-boot'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface SpawnWorldOptions {
  appName: string
  profileName: string
  installAnchor: string
  home: string
  extraPatches?: unknown[]
}

const EMPTY_ROOT = '[]\n'

export async function spawnWorld(opts: SpawnWorldOptions) {
  const profile = loadProfile(opts.appName, opts.profileName, opts.installAnchor, opts.home)
  writeFileSync(join(profile.dir, 'cordis.yml'), EMPTY_ROOT)
  const patches = [
    ...profile.layers.flatMap((l) => l.patches),
    ...profile.patches,
    ...(opts.extraPatches ?? []),
  ]
  const bareModuleBaseUrl = pathToFileURL(
    join(opts.installAnchor, '..', 'node_modules', '/'),
  ).href
  return boot(opts.appName, join(profile.dir, 'cordis.yml'), patches, undefined, bareModuleBaseUrl)
}
```

`src/index.ts` 补 `export * from './spawn-world.js'`。

- [ ] **Step 6: build + 跑绿**

```bash
npm run build && AW_TEST_HOME=$HOME/workspaces/superd/.superd-test/aw npm test
```
Expected: 全绿（含 Task 1/2 用例）

- [ ] **Step 7: Commit**（含探针结论）

```bash
git add apps/agent-worlds/aw-routing
git commit -m "aw: spawnWorld lib + boot/prepare ordering probe (shared home for AW-A; result: <report>)"
```

---

### Task 4: 零端口 world profile 审计（风险 1）

**Files:**
- Create: `apps/agent-worlds/aw-routing/test/fixtures/aw-omp-world/package.json`、`.../cordis.patch.yml`、`.../pnpm-workspace.yaml`
- Test: `apps/agent-worlds/aw-routing/test/zero-port.audit.test.mjs`

**Interfaces:**
- Consumes: Task 3 `spawnWorld`（`extraPatches` 传 world 自己的 patch）。
- Produces: 审计结论（spec §十一.1 收口）——dsh-base + dsh-web-app − webserver/frontend-static 行 ⇒ `sessionController` + `typert` 在位、零 listener。

- [ ] **Step 1: 核对行 id**（写 fixture 前先看真实行表）

```bash
DSH_HOME=~/workspaces/superd/.superd-test/aw node ~/workspaces/superd/upstream/deepseek-harness/apps/cli/lib/bin.js --profile ctx1-min --dump-config | grep -inE 'webserver|frontend'
# 若 repo build 不存在，回落 /home/u1/.local/bin/dsh。记下 webserver 与 frontend-static 行的准确 id。
```

- [ ] **Step 2: 写 world profile fixture**

```json
// test/fixtures/aw-omp-world/package.json
{
  "name": "aw-omp-world-profile",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
```

```yaml
# test/fixtures/aw-omp-world/cordis.patch.yml
# 零端口 world：web 面行级裁撤，RPC 面保留（spec §五）。
# <id> 用 Step 1 核对到的准确行 id；两行逐一 disable。
- id: <webserver-row-id>
  disabled: true
- id: <frontend-static-row-id>
  disabled: true
```

```yaml
# test/fixtures/aw-omp-world/pnpm-workspace.yaml
nodeLinker: hoisted
autoInstallPeers: false
```

- [ ] **Step 3: 写审计测试**（行为断言，不依赖 id）

```js
// test/zero-port.audit.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnWorld } from '../dist/index.js'
import { readFileSync } from 'node:fs'

const ANCHOR = process.env.SUPERD_DSH_ANCHOR
  ?? '/home/u1/.local/lib/node_modules/@deepseek-ai/dsh/package.json'
const HOME = process.env.AW_TEST_HOME ?? '/tmp/aw-spawn-test-home'
const FIXTURE = new URL('./fixtures/aw-omp-world/', import.meta.url).pathname

// 手动把 fixture 注册成 profile（照 scripts 惯例写 package.json 已含 dsh.profile.bundles；
// loadProfile 按名字在 $DSH_HOME/profiles/<name> 找 —— 测试里直接把 fixture 拷过去）
import { cpSync, mkdirSync } from 'node:fs'
mkdirSync(join(HOME, 'profiles'), { recursive: true })
cpSync(FIXTURE, join(HOME, 'profiles', 'aw-omp-world'), { recursive: true })
import { join } from 'node:path'

test('zero-port world: RPC face present, web face absent', async () => {
  const patch = readFileSync(join(FIXTURE, 'cordis.patch.yml'), 'utf8')
  const ctxW = await spawnWorld({
    appName: 'aw-omp-world', profileName: 'aw-omp-world',
    installAnchor: ANCHOR, home: HOME,
  })
  // 上面 extraPatches 不传：profile 自带 cordis.patch.yml 已走 profile.patches 通道
  assert.notEqual(ctxW.get('sessionController'), undefined, 'sessionController present')
  assert.notEqual(ctxW.get('typert'), undefined, 'typert present')
  assert.equal(ctxW.get('webServer'), undefined, 'webServer absent — no listener')
  assert.equal(ctxW.get('frontendStatic'), undefined, 'frontendStatic absent')
  assert.ok(patch.includes('disabled: true'), 'fixture actually disables rows')
  await ctxW.fiber.dispose()
})
```

- [ ] **Step 4: 跑绿 + 记录审计结论** → `AW_TEST_HOME=... npm test` Expected: PASS。若 `webServer` 仍 present：行 id 不对，回 Step 1 重新核对（这是本审计要抓的漂移）。

- [ ] **Step 5: Commit**

```bash
git add apps/agent-worlds/aw-routing
git commit -m "aw: zero-port world audit — dsh-base+dsh-web-app minus web rows keeps full RPC face (risk 1 closed)"
```

---

### Task 5: agent-adapter-omp 拷贝（per-agent 包）

**Files:**
- Create: `apps/agent-worlds/agent-omp/**`（拷自 `apps/multi-agent-ctx/agent-omp/`，剔除其 `dist/`、`node_modules/`）
- Modify: `apps/agent-worlds/agent-omp/package.json`（包名 → `@pgmi-builds/agent-adapter-omp`）

**Interfaces:**
- Produces: `@pgmi-builds/agent-adapter-omp`——omp-web 同构 exclusive 形态原样（禁 agent-loop/llm-deepseek/llm-pi-ai/agent-presets/jsonl，OMP-store-only persistence），sidecar + cordis.patch.yml 随包。Task 6 在其上加 world-plugin 接线。

- [ ] **Step 1: 拷贝改名**

```bash
cd ~/workspaces/superd/apps
cp -r multi-agent-ctx/agent-omp agent-worlds/agent-omp
rm -rf agent-worlds/agent-omp/dist agent-worlds/agent-omp/node_modules
cd agent-worlds/agent-omp
sed -i 's/"name": "@pgmi-builds\/agent-omp"/"name": "@pgmi-builds\/agent-adapter-omp"/' package.json
```

- [ ] **Step 2: 安装依赖 + 单实例检查（这次是真依赖安装：@oh-my-pi/pi-coding-agent、bun）**

```bash
npm install --cache ~/workspaces/superd/.npm-cache
cd ~/workspaces/superd && find node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l
```
Expected: 仅 `dsh-client-ui-slots`。若出现物理副本：按 AGENTS.md §三红链接修复（`rm -rf` 副本 + `ln -s` 指向 installation）后再继续。

- [ ] **Step 3: build + 测试跑绿**

```bash
cd ~/workspaces/superd/apps/agent-worlds/agent-omp && npm run build && npm test
```
Expected: tsc 0；随拷贝用例全绿。

- [ ] **Step 4: Commit**

```bash
git add apps/agent-worlds/agent-omp
git commit -m "aw: copy agent-omp as per-agent @pgmi-builds/agent-adapter-omp (omp-web isomorphic exclusive form)"
```

---

### Task 6: adapter world-plugin 接线（roster × spawn × 嵌套 home）

**Files:**
- Create: `apps/agent-worlds/agent-omp/src/world-plugin.ts`
- Test: `apps/agent-worlds/agent-omp/test/world-plugin.test.mjs`

**Interfaces:**
- Consumes: `@pgmi-builds/aw-routing` 的 `spawnWorld/registerAgent/setReady/listAgents/registerTarget`；`@deepseek-ai/cordis` 插件形态（`export const name` + `export function apply(ctx)`）。
- Produces: cordis 插件 `aw.agent-adapter-omp`——激活即：`mkdir agents/omp` → `registerAgent({key:'omp',...})` → `spawnWorld`（Task 4 profile）→ `registerTarget({key:'omp', gateway: ctxW.get('typertGateway')})` → `setReady('omp', true)` → `ctx.provide('aw.world.omp', worldPromise)`。

- [ ] **Step 1: 写失败测试**（真树用例；无 install anchor 时 skip）

```js
// test/world-plugin.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ANCHOR = process.env.SUPERD_DSH_ANCHOR
const HOME = process.env.AW_TEST_HOME ?? mkdtempSync(join(tmpdir(), 'aw-plugin-'))

test('aw.agent-adapter-omp: activation registers roster + spawns zero-port world + agents/omp exists', { skip: !ANCHOR && 'SUPERD_DSH_ANCHOR not set' }, async (t) => {
  const { name, apply } = await import('../dist/world-plugin.js')
  const { boot } = await import('@deepseek-ai/dsh-app-boot')
  assert.equal(name, 'aw.agent-adapter-omp')
  const holder = { provide(k, v) { holder[k] = v } }
  // 用最小 holder 模拟 ctx0 插件挂载（真 e2e 在 Task 7 的完整 boot 里验）
  await apply(holder)
  const roster = (await import('@pgmi-builds/aw-routing/dist/index.js')).listAgents()
  assert.deepEqual(roster, [{ key: 'omp', label: 'OMP', ready: true }])
  assert.ok(existsSync(join(HOME, 'agents', 'omp')), 'nested home dir created')
  const ctxW = await holder['aw.world.omp']
  assert.notEqual(ctxW.get('sessionController'), undefined)
  assert.equal(ctxW.get('webServer'), undefined)
  await ctxW.fiber.dispose()
})
```

- [ ] **Step 2: 跑红** → `SUPERD_DSH_ANCHOR=... npm test` Expected: FAIL（world-plugin 未导出）

- [ ] **Step 3: 最小实现**

```ts
// src/world-plugin.ts
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  spawnWorld, registerAgent, setReady, registerTarget,
} from '@pgmi-builds/aw-routing'

export const name = 'aw.agent-adapter-omp'

const ANCHOR = process.env.SUPERD_DSH_ANCHOR
  ?? '/home/u1/.local/lib/node_modules/@deepseek-ai/dsh/package.json'

export function apply(ctx: any): void {
  registerAgent({ key: 'omp', label: 'OMP', ready: false })
  const home = process.env.DSH_HOME ?? join(process.cwd(), '.superd-test', 'aw')
  // 嵌套 home：起步 = adapter 自建目录；OMP app-home 重定向（§七）在 sidecar 管道接，AW-C0 收口
  mkdirSync(join(home, 'agents', 'omp'), { recursive: true })
  const world = (async () => {
    const ctxW = await spawnWorld({
      appName: 'aw-omp', profileName: 'aw-omp-world',
      installAnchor: ANCHOR, home,
    })
    registerTarget({ key: 'omp', gateway: ctxW.get('typertGateway') })
    setReady('omp', true)
    return ctxW
  })()
  ctx.provide('aw.world.omp', world)
}
```

`tsconfig`/构建把 world-plugin 一并编出；`package.json` 的 `dsh.bundle.patch`（cordis.patch.yml）追加：

```yaml
- insert:
    - id: aw-agent-adapter-omp
      name: '@pgmi-builds/agent-adapter-omp'
```

- [ ] **Step 4: build + 跑绿**

```bash
SUPERD_DSH_ANCHOR=$ANCHOR AW_TEST_HOME=$HOME/workspaces/superd/.superd-test/aw npm test
```
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/agent-worlds/agent-omp
git commit -m "aw: wire agent-adapter-omp as world plugin — roster register + zero-port ctx spawn + nested home dir"
```

---

### Task 7: start 脚本 + 首次冒烟（验收停机交用户）

**Files:**
- Create: `apps/agent-worlds/test/start-4998.sh`（改自 `apps/multi-agent-ctx/test/start-4999.sh` 模板）
- Create: `apps/agent-worlds/test/smoke.mjs`（ctx0 = dsh-base + dsh-web-app + aw-routing 行 + agent-adapter-omp 行；webserver 绑 4998；末尾打印 token URL 后 `SUPERD_KEEP` 常驻）

**Interfaces:**
- Consumes: Task 2/3/6 全部产出；模板脚本的 systemd-run/ss 预检/token 水位提取惯例。

- [ ] **Step 1: 写 smoke 驱动**（组合行表：ctx0 的 cordis.patch.yml = upstream web 面行 + `- insert: aw-routing` + `- insert: aw-agent-adapter-omp`；端口 4998 写 ctx0 patch；world profile 走 Task 4 fixture；启动末尾 `console.log('SUPERD_KEEP=1 — servers stay up')` + token URL）
- [ ] **Step 2: 写 start 脚本**：PORT=4998、UNIT=`aw-4998-test`、`DSH_HOME=$REPO/.superd-test/aw`、日志 `.scratch/aw-4998.log`；ss 预检 + `reset-failed` + 轮询等听 + 水位后取 token URL（模板逐段照搬，仅改以上常量）
- [ ] **Step 3: 拉起**

```bash
bash apps/agent-worlds/test/start-4998.sh
```
Expected: 打印 local token URL；`ss -tln | grep 4998` 单口监听；日志含 `SUPERD_KEEP=1`。
- [ ] **Step 4: 冒烟断言（脚本内 curl，不 kill）**：无 token GET `/` → 401；带 token → 200；`/api` 面 session/list 走 selector=native 正常应答。
- [ ] **Step 5: Commit + 停机交用户**

```bash
git add apps/agent-worlds/test
git commit -m "aw: start-4998 smoke — ctx0 + adapter plugin + zero-port omp world, SUPERD_KEEP acceptance"
```

**保持实例运行**，把 token URL（local；如需 LAN/WAN 按 §十端口纪律补 socat/Caddy，另批）交给用户实测。用户确认后 `systemctl --user stop aw-4998-test` 收尾。

---

## Self-Review（写计划后自查记录）

- **Spec 覆盖**：AW-A 验收四点 ↔ Task 6（roster 反映插件在场）、Task 4（零 listener + RPC 面在位）、Task 6（`agents/omp/` 目录）、Task 3（风险 2 探针钉板）+ Task 4（风险 1 收口）。§五零端口、S2 roster、ADR 0008 约束 1（全走 boot()）均落任务。
- **已知开放点（非占位，是 POC 交付物本身）**：① Task 3 探针结论决定 AW-C1 的 `dshHomePath` 覆盖机制（本计划不需要它）；② Task 4 的 webserver/frontend-static 行 id 以 Step 1 dump-config 实测为准（审计测试断言的是行为不是 id）。
- **类型一致性**：`RosterEntry/registerAgent/setReady/listAgents/onRosterChanged`（Task 2 产出 = Task 6 消费）；`spawnWorld(SpawnWorldOptions)`（Task 3 产出 = Task 4/6 消费）；`registerTarget/getTarget/GatewayFace`（Task 1 产出 = Task 6 消费）——名字逐一核对一致。

---

## Execution Record（2026-09-15，AW-A 六任务全绿）

- Task 1–7 全部完成并逐任务 commit（c658148…798afc6）。验收实例常驻：`aw-4998-test`（ctx0 127.0.0.1:4998 + 插件自 spawned ctx-omp）。
- **Task 5 来源变更（user 裁决）**：拷贝源改为 `~/workspaces/dsh-omp/apps/omp-web`（v0.2.2-b，omp-web 原始底座），整包原样、client 面保留；包名 `@pgmi-builds/agent-adapter-omp`。
- **风险 2 钉板 + user 裁决**：探针实证 boot 在 prepare 前已 provide `dshHomePath`、重提供必 throw → **定案：`dshHomePath` 服务永不覆盖**；嵌套 home = 共享 home 下普通子路径 `.dsh/agents/omp`，per-agent 存储适配在子路径组合（adapter 职责）。
- **风险 1 审计结论（AW-A 形态）**：disable webserver/web-runtime 级联 9 项 pending（webRuntime→connection→fileUploads 链）；AW-A = 全行集 + `provideCmdline`（上游公开 embedding API）+ webserver 绑 `127.0.0.1:0` 临时回环。真零 listener（webRuntime shim）= AW-B 跟进。
- **红线实战**：测试进程漏设 `DSH_HOME` 时 world 尝试写 `~/.dsh`，被沙箱 EROFS 拦截——prod-home 红线有实弹保护。
- **遗漏项（AW-B/C0 承接）**：真零 listener；OMP sidecar home 重定向接线（`OMP_HOME`→SDK `PI_CONFIG_DIR` 链条，2 个 sidecar 运行时测试已 env-gated）；RuntimeSeat chip 接 roster；`scripts/` 目录缺失（AGENTS.md 漂移，heal script 悬空——本线以手动 symlink 纪律代偿）。

### 追加裁决（2026-09-15，验收轮）

1. **LAN 访问**：smoke args 加 `--trusted-host 192.168.31.130[:4998]`；`aw-4998-relay`（socat）绑 `192.168.31.130:4998 → 127.0.0.1:4998`（LAN URL = `http://192.168.31.130:4998/?token=<本 boot token>`，见 `.scratch/aw-4998.log`）。
2. **嵌套仓**：`apps/agent-worlds` 拆为独立 git 仓（root 仓 exclude，Task 1-7 历史 root log 可溯；仓内首提交 1136b59）；adapter 并行开发用 worktree——已建 `~/workspaces/aw-worktrees/omp`（branch `adapters/omp`）。
3. **OMP home = adapter 级自由**：默认 prod `~/.omp` 原样可用；撤销两测试的 env-gated skip → adapter 套件 60/60 全绿（1 skip 为 omp-web 上游自带）。

### 追加（2026-09-15 验收轮 II）：aw-routing → agent-hub 更名 + client 修复

- user 裁决更名 `aw-routing` → `agent-hub`（ast_edit 设备执行接线改名）。client 失败根因 = 拷贝的 `lib/client` 烙旧包 id + LAN fence 未配；重建 client（build-client 以新 ID）+ trusted-host/socat 后 bundle 200/11MB、agent-hub 工厂与 ui-slots 闭包在位。
