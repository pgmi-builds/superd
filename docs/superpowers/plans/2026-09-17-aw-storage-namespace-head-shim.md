# AW Storage Namespace Head Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** world 页的 localStorage 键按 mount label 加前缀（`omp:<key>`、`codex:<key>`），终结单 origin 三 world 共桶互相覆盖（「native 刷新总回原会话、world 总落新会话页」症状）。

**Architecture:** 在既有 client mount shim（`renderClientShim(labelPath)`，head 注入、parser-blocking、先于一切 client modules）尾部追加 Storage.prototype 命名空间区块——只包 `getItem`/`setItem`/`removeItem` 三个方法，绝不抛错，幂等（`__DSH_STORAGE_NS__` 标记）。root `/` 不注入该 shim，native 保持裸键与既有数据兼容。

**Tech Stack:** TypeScript（`tsc -p .` → `dist/`，测试 import dist）、node:test、真实 headless chromium + 原生 CDP（`.scratch/` 探针族，chromium 二进制 `~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`）。

**Spec:** `docs/superpowers/plans/2026-09-16-aw-storage-namespace-findings.md`（F1-F4 取证、裁决、P1-P3 补丁清单）。前置：`docs/superpowers/plans/2026-09-16-aw-subpath-mount-findings.md`（挂载机制本体，已由 AW-B 落地）。

## Global Constraints

- 上游源码零修改：改动仅限 `apps/agent-worlds/` 自有代码（AGENTS.md 红线 5）。
- Home 隔离：跑 hub 套件一律 `DSH_HOME=<repo>/.superd-test`；绝不触碰 `~/.dsh` 与 `~/.superd`。**`world-mount` 测试在 home 未隔离时必失败**（world 的 connection 会以 `EROFS: read-only file system, open '/home/u1/.dsh/.credentials.yaml.lock'` 拒绝——2026-09-17 实测复现）。
- Shim 硬性要求（spec P1，逐条不可让步）：绝不抛错（`attachPersistence` 对异常静默降级 = 持久化悄悄失效）；只包 `getItem`/`setItem`/`removeItem`；不包 `clear()`、不做 `length`/`key()` 枚举语义（生产零调用）；幂等；root `/` 不注入。
- 不做迁移回退（spec「明确不做」）：不读裸键兜底——那正是本 bug。
- 验收 = 运行时行为（真实浏览器），不是进程活性/单测绿（AGENTS.md 红线 2）；起了 Web 服务器**保持运行交 user 亲手验收**，不得自行 kill（验收模式 2026-09-09 裁决）。
- commit 在嵌套仓 `apps/agent-worlds`（user ruling 2026-09-15）；报告与计划文档 commit 在 superd 根仓。**未经 user 单次明确同意不得 `npm publish`**。
- 4999 端口纪律：启动前 `ss -tln | grep :4999` 查占用；同口冲突即停（AGENTS.md §三）。

---

### Task 1: Storage 命名空间区块（P1）+ 单元测试（P2）

**Files:**
- Modify: `apps/agent-worlds/agent-hub/src/client-shim.ts`（shim 模板尾部、`__DSH_FILE_UPLOAD__` 行之后追加区块；同步文件头职责清单加一行）
- Test: `apps/agent-worlds/agent-hub/test/client-shim.test.mjs`（`fakeGlobal` 加 labelPath 参数；文件头注释同步；追加 6 个测试（含验收后追加的组合边界回归））

**Interfaces:**
- Consumes: `renderClientShim(labelPath: string): string`（签名不变）；测试经 `new Function('globalThis', script)(fakeGlobal)` 执行——因此 shim 内一切引用必须走 `globalThis.*`（裸 `localStorage` 标识符会解析到 Node 真实 global，测试钩不住）。
- Produces（Task 2 依赖）: world 页全局 `__DSH_STORAGE_NS__: string`（`'/omp'` → `'omp:'`）；world 页 `Storage.prototype` 三方法被前缀包裹（localStorage 与 sessionStorage 共 prototype，均生效）；**物理键格式 = `<label>:<key>`**（DevTools / `localStorage.key(i)` 可见）；`clear`/`length`/`key()` 引用不变；root 页无任何变化（root 不渲染 world index，永不注入本 shim）。

- [ ] **Step 1: 写失败测试**

先改 `fakeGlobal` 签名（向后兼容，既有调用不受影响）：

```js
function fakeGlobal(extra = {}, labelPath = '/omp') {
  // …原有构造体不动，仅最后一行改为…
  new Function('globalThis', renderClientShim(labelPath))(g)
  return g
}
```

在文件尾部追加（含共享 fixture）：

```js
// ---- Storage namespace (2026-09-16 storage findings P1) ----
function storageFixture() {
  const backing = new Map()
  class StorageLike {
    getItem(k) { return backing.has(String(k)) ? backing.get(String(k)) : null }
    setItem(k, v) { backing.set(String(k), String(v)) }
    removeItem(k) { backing.delete(String(k)) }
    clear() { backing.clear() }
    key(i) { return [...backing.keys()][i] ?? null }
    get length() { return backing.size }
  }
  return { backing, StorageLike }
}

test('storage keys are namespaced per world and invisible across namespaces', () => {
  const { backing, StorageLike } = storageFixture()
  const g = fakeGlobal({ localStorage: new StorageLike(), Storage: StorageLike })
  const ls = g.localStorage
  ls.setItem('dsh.sessions.current', 'session-omp-1')
  assert.equal(backing.get('omp:dsh.sessions.current'), 'session-omp-1', 'physical key is prefixed')
  assert.equal(backing.has('dsh.sessions.current'), false, 'bare key never written')
  assert.equal(ls.getItem('dsh.sessions.current'), 'session-omp-1', 'wrapped read finds the prefixed key')
  ls.removeItem('dsh.sessions.current')
  assert.equal(backing.has('omp:dsh.sessions.current'), false, 'remove deletes the prefixed key only')
  assert.equal(g.__DSH_STORAGE_NS__, 'omp:')
})

test('the storage namespace derives from the mount root', () => {
  const { backing, StorageLike } = storageFixture()
  const g = fakeGlobal({ localStorage: new StorageLike(), Storage: StorageLike }, '/codex')
  g.localStorage.setItem('k', 'v')
  assert.equal(backing.get('codex:k'), 'v')
  assert.equal(g.__DSH_STORAGE_NS__, 'codex:')
})

test('the storage block stays inert and never throws without localStorage', () => {
  const g = fakeGlobal() // no localStorage / Storage on the fake global
  assert.equal(g.__DSH_STORAGE_NS__, undefined)
  assert.equal(typeof g.__DSH_TRANSPORT__.fetch, 'function', 'rest of the shim still installed')
})

test('re-running the shim does not double-wrap storage', () => {
  const { backing, StorageLike } = storageFixture()
  const g = fakeGlobal({ localStorage: new StorageLike(), Storage: StorageLike })
  new Function('globalThis', renderClientShim('/omp'))(g) // second execution, same global
  g.localStorage.setItem('k', 'v')
  assert.equal(backing.get('omp:k'), 'v')
  assert.equal(backing.has('omp:omp:k'), false)
})

test('clear, length and key() stay untouched', () => {
  const { StorageLike } = storageFixture()
  // Capture the pristine methods BEFORE the shim mutates the shared prototype
  // in place (post-shim, StorageLike.prototype.getItem IS the wrapper).
  const pristineGetItem = StorageLike.prototype.getItem
  const g = fakeGlobal({ localStorage: new StorageLike(), Storage: StorageLike })
  assert.equal(g.localStorage.clear, StorageLike.prototype.clear)
  assert.equal(g.localStorage.key, StorageLike.prototype.key)
  assert.notEqual(g.localStorage.getItem, pristineGetItem, 'the three carries ARE wrapped')
})

test('the storage NS survives the mount HTML pass (composition regression, live-found 2026-09-17)', async () => {
  // Real composition order: WorldWebServer.renderIndex injects the shim, THEN
  // rewriteIndexHtml rewrites quoted root-absolute strings — doubling the
  // shim's LABEL="/omp" literal (the pass excludes only "/omp/"-prefixed
  // strings). NS must come out single-prefixed and the transport rewrite must
  // still target the real mount root. If index-pass's real contract needs a
  // different html wrapper, adapt the wrapper — never the assertions.
  const { rewriteIndexHtml } = await import('../dist/index-pass.js')
  const page = rewriteIndexHtml(`<head><script>${renderClientShim('/omp')}</script></head>`, '/omp')
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1]
  assert.ok(script !== undefined, 'shim script still present after the mount pass')
  const { backing, StorageLike } = storageFixture()
  const g = { location: { origin: 'http://host:4999' }, fetch: async () => ({ ok: true }), localStorage: new StorageLike(), Storage: StorageLike }
  new Function('globalThis', script)(g)
  g.localStorage.setItem('k', 'v')
  assert.equal(g.__DSH_STORAGE_NS__, 'omp:', 'NS single-prefixed after the pass')
  assert.equal(backing.get('omp:k'), 'v')
  assert.equal(g.__DSH_TRANSPORT__.rewrite('/api/x'), '/omp/api/x', 'transport still re-roots to the real mount')
})
```

同步两处文件头注释：`client-shim.ts` 顶部职责清单加 `*   - Storage.prototype get/set/remove → per-world key namespace`；测试文件头注释加 `and the per-world storage namespace`。

- [ ] **Step 2: 构建并跑 shim 测试，确认新测试失败**

```bash
cd apps/agent-worlds/agent-hub
npm run build
DSH_HOME=/home/u1/workspaces/superd/.superd-test node --test --test-force-exit test/client-shim.test.mjs
```

Expected: **6 个新测试 FAIL**（5 个 storage 行为 + 1 个组合回归：NS 前缀翻倍），既有 8 个 PASS。

- [ ] **Step 3: 实现 shim 区块**

在 `client-shim.ts` 模板串内、`globalThis.__DSH_FILE_UPLOAD__ = { fetch: shimFetch }` 行之后（即 `})()` 结尾前）追加：

```js
  // Storage namespace (2026-09-16 storage findings P1): all worlds share one
  // origin, so bare localStorage keys would overwrite each other across
  // mounts. Prefix every key with the label; root '/' never injects this
  // shim and keeps bare keys. Never throws: attachPersistence only
  // console-errors on failure, so a throwing shim would silently disable
  // persistence.
  const StorageProto = globalThis.Storage && globalThis.Storage.prototype
  if (globalThis.localStorage !== undefined && StorageProto !== undefined
    && !globalThis.__DSH_STORAGE_NS__
    && typeof StorageProto.getItem === 'function'
    && typeof StorageProto.setItem === 'function'
    && typeof StorageProto.removeItem === 'function') {
    // NS derives from PREFIX, never LABEL: the mount HTML pass (index-pass)
    // rewrites every quoted root-absolute string EXCEPT "<label>/"-prefixed
    // ones, so the shim's LABEL="/omp" literal doubles to "/omp/omp" while
    // PREFIX="/omp/" is immune (live-found 2026-09-17, acceptance A2/A5).
    const NS = PREFIX.slice(1, -1) + ':'
    globalThis.__DSH_STORAGE_NS__ = NS
    const nativeGetItem = StorageProto.getItem
    const nativeSetItem = StorageProto.setItem
    const nativeRemoveItem = StorageProto.removeItem
    StorageProto.getItem = function (name) { return nativeGetItem.call(this, NS + name) }
    StorageProto.setItem = function (name, value) { return nativeSetItem.call(this, NS + name, value) }
    StorageProto.removeItem = function (name) { return nativeRemoveItem.call(this, NS + name) }
  }
```

- [ ] **Step 4: 构建并跑 shim 测试，确认全部通过**

```bash
cd apps/agent-worlds/agent-hub
npm run build
DSH_HOME=/home/u1/workspaces/superd/.superd-test node --test --test-force-exit test/client-shim.test.mjs
```

Expected: 14 pass / 0 fail（8 既有 + 6 新）。

- [ ] **Step 5: 全套件回归**

```bash
cd apps/agent-worlds/agent-hub
DSH_HOME=/home/u1/workspaces/superd/.superd-test npm test
```

Expected: **66 pass / 0 fail**（基线 60 全绿 + 6 新）。若 `world-mount` 报 `EROFS ~/.dsh/.credentials.yaml.lock`，是 `DSH_HOME` 未隔离（见 Global Constraints），不是代码回归。

- [ ] **Step 6: Commit**

```bash
git -C apps/agent-worlds add agent-hub/src/client-shim.ts agent-hub/test/client-shim.test.mjs
git -C apps/agent-worlds commit -m "feat(agent-hub): per-world storage namespace in the mount shim (AW storage P1/P2)"
```

---

### Task 2: P3 实测验收（4999 运行时行为）+ 验收报告

**Files:**
- Create: `.scratch/awb-storage.mjs`（CDP 存储探针；`.scratch/` 不入库，属工具）
- Create: `docs/superpowers/plans/2026-09-17-aw-storage-namespace-acceptance-report.md`（验收报告）

**Interfaces:**
- Consumes: Task 1 产出的 dist（4999 实例经 profile link 加载 hub `dist/`，故必须先 `npm run build`）；`apps/agent-worlds/test/start-4999.sh`（systemd unit `aw-4999-test`，`DSH_HOME=$REPO/.superd-test/aw`，token 提取，SUPERD_KEEP）；`.scratch/awb-cdp.mjs` 的 Page/CDP 模式（chromium 以 `--remote-debugging-port=9333` 独立拉起）；`ws` 包经 `createRequire(agent-hub/package.json)` 解析。
- Produces: 验收报告 + **保持运行的 4999 实例**（token URL 交 user 亲手复验）。

- [ ] **Step 1: 停旧实例（若在跑）并重建**

```bash
ss -tln | grep ':4999 ' && systemctl --user stop aw-4999-test   # 重启以加载新构建；这是 unit 自身生命周期，非 kill 用户验收实例
cd /home/u1/workspaces/superd/apps/agent-worlds/agent-hub && npm run build
```

- [ ] **Step 2: 起 4999 并取 token URL**

```bash
bash /home/u1/workspaces/superd/apps/agent-worlds/test/start-4999.sh
```

Expected: 打印 `http://127.0.0.1:4999/?token=<t>` 与 WAN `https://test.pc.randomhash.app/?token=<t>`。记下 `<t>`。

- [ ] **Step 3: 拉起 CDP chromium（后台）**

```bash
mkdir -p /home/u1/workspaces/superd/.scratch/awb-storage-profile
/home/u1/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
  --headless=new --remote-debugging-port=9333 --no-first-run \
  --user-data-dir=/home/u1/workspaces/superd/.scratch/awb-storage-profile \
  about:blank >/dev/null 2>&1 &
```

- [ ] **Step 4: 写探针脚本 `.scratch/awb-storage.mjs` 并运行**

```js
// .scratch/awb-storage.mjs — storage namespace acceptance probe (AW storage P3).
// Same raw-CDP pattern as .scratch/awb-cdp.mjs: one tab per visit, evaluate in
// the page realm. PHYSICAL keys are enumerated via localStorage.length/key(i)
// — channels the shim deliberately leaves untouched.
import { createRequire } from 'node:module'
const require = createRequire('/home/u1/workspaces/superd/apps/agent-worlds/agent-hub/package.json')
const WebSocket = require('ws')

const CDP = process.env.CDP ?? 'http://127.0.0.1:9333'
const BASE = process.env.BASE ?? 'http://127.0.0.1:4999'
const TOKEN = process.argv[2]
if (!TOKEN) { console.error('usage: node .scratch/awb-storage.mjs <token>'); process.exit(1) }

class Page {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.targetId = '' }
  static async open(url) {
    const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    const target = await res.json()
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const page = new Page(ws)
    page.targetId = target.id
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.id === undefined) return
      const entry = page.pending.get(msg.id)
      if (entry) { page.pending.delete(msg.id); entry(msg) }
    })
    return page
  }
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async evaluate(expression) {
    const reply = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (reply.error) return `EVAL_ERROR ${JSON.stringify(reply.error)}`
    if (reply.result?.exceptionDetails) return `EVAL_THREW ${String(reply.result.exceptionDetails.exception?.description).slice(0, 300)}`
    return reply.result?.result?.value
  }
  async close() { try { await fetch(`${CDP}/json/close/${this.targetId}`) } catch { /* ignore */ } this.ws.close() }
}

const PHYSICAL_KEYS = 'JSON.stringify(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort())'

async function visit(url, label, waitMs) {
  const page = await Page.open('about:blank')
  for (const d of ['Runtime', 'Page']) await page.send(`${d}.enable`)
  await page.send('Page.navigate', { url })
  await new Promise((r) => setTimeout(r, waitMs))
  const ns = await page.evaluate('JSON.stringify(globalThis.__DSH_STORAGE_NS__ ?? null)')
  const keys = JSON.parse(await page.evaluate(PHYSICAL_KEYS))
  console.log(`\n===== ${label} =====\nns=${ns}\nphysicalKeys=${JSON.stringify(keys, null, 1)}`)
  return page
}

// 1. Native first: the token exchange sets the auth cookie for the whole origin.
const native = await visit(`${BASE}/?token=${TOKEN}`, 'native', 8000)
await native.evaluate("localStorage.setItem('probe.native', 'nat-1')")

// 2. OMP world (rides the same-origin cookie).
const omp = await visit(`${BASE}/omp/`, 'omp', 12000)
await omp.evaluate("localStorage.setItem('probe.glass', 'omp-1')")
const ompRead = await omp.evaluate("localStorage.getItem('probe.glass')")
const ompForeign = await omp.evaluate("localStorage.getItem('probe.native')")
const ompKeys = JSON.parse(await omp.evaluate(PHYSICAL_KEYS))

// 3. Codex world.
const codex = await visit(`${BASE}/codex/`, 'codex', 12000)
await codex.evaluate("localStorage.setItem('probe.glass', 'codex-1')")
const codexKeys = JSON.parse(await codex.evaluate(PHYSICAL_KEYS))

// 4. Native again: world visits must not have clobbered the bare keys.
const native2 = await visit(`${BASE}/`, 'native-again', 8000)
const nativeBareAfter = await native2.evaluate("localStorage.getItem('probe.native')")

console.log('\n===== VERDICT =====')
const results = []
const check = (name, ok) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`) }
check('A2 omp physical keys prefixed', ompKeys.includes('omp:probe.glass') && ompKeys.includes('omp:dsh.sessions.current'))
check('A2 codex physical keys prefixed', codexKeys.includes('codex:probe.glass') && codexKeys.includes('codex:dsh.sessions.current'))
check('A3 omp cannot read native bare keys', ompForeign === null)
check('A4 omp wrapped read round-trips', ompRead === 'omp-1')
check('A1 native bare key survives world visits', nativeBareAfter === 'nat-1')

for (const p of [native, omp, codex, native2]) await p.close()
process.exit(results.every(Boolean) ? 0 : 1)
```

Run: `node /home/u1/workspaces/superd/.scratch/awb-storage.mjs <token>`

Expected: 5 行全 PASS；三个 world 的 `ns` 输出分别为 `null`、`"omp:"`、`"codex:"`（ns 核对项 A5）。

- [ ] **Step 5: 症状翻转核对（真实 app 行为，非探针注入）**

在 Step 4 输出的 `physicalKeys` 里核对：`/omp/` 与 `/codex/` 各自持有自己的 `dsh.sessions.current` 前缀键，且裸 `dsh.sessions.current` 只含 native 的值（native-again 页正文非空白 hero——`bodyText` 有会话列表即恢复成功）。若某 world 无历史会话，登录该 world 建 1 条会话后重跑 Step 4。

- [ ] **Step 6: 既有 shim 职责回归（改 shim 后必测，不只测存储）**

```bash
node /home/u1/workspaces/superd/.scratch/awb-cdp.mjs <token>
```

Expected: `/omp/` 页 `wsShim.OPEN === 1`、`transport`/`shim` 为 `object`、无 `[http 4xx]`/`[ws-frame-error]` 风暴、WS 到 `/omp/api/remote.mux` 得 101（`ws-response 101` 事件）。

- [ ] **Step 7: 写验收报告 `docs/superpowers/plans/2026-09-17-aw-storage-namespace-acceptance-report.md`**

结构：结论表（Step 4 的 5 项 VERDICT + A5 ns 值 + Step 5 症状翻转 + Step 6 回归）、实例信息（unit/端口/token 水位）、遗留（如有）。模式参照 `2026-09-15-agent-codex-4985-acceptance-report.md`。

- [ ] **Step 8: Commit 报告（根仓）并保持实例运行交 user**

```bash
git -C /home/u1/workspaces/superd add docs/superpowers/plans/2026-09-17-aw-storage-namespace-acceptance-report.md docs/superpowers/plans/2026-09-17-aw-storage-namespace-head-shim.md
git -C /home/u1/workspaces/superd commit -m "docs(aw): storage namespace acceptance report + plan"
```

**不得停 4999**（`systemctl --user stop` 只在 user 验收完毕后由 user 决定）。向 user 报告 local/LAN/WAN token URL。

---

## Self-Review（writing-plans 检查单，已执行）

1. **Spec coverage**: P1 → Task 1 Step 3（逐行含硬性要求：不抛错/三方法/幂等/root 不注入）；P2 四条 bullet → Task 1 Step 1 的 4 个测试一一对应（prefix+跨 world 隔离 / NS 派生 / 无 localStorage 跳过 / 幂等）+ 额外 `clear/length/key` 不动测试；P3 四步 → Task 2 Steps 2-6（起 4999 / 互切刷新各回原会话=Step 5 / DevTools 物理键=Step 4 / 既有职责回归=Step 6）。「明确不做」三条均未违反（无迁移回退、root 无 shim、不动 RuntimeSeat/上游）。
2. **Placeholder scan**: 无 TBD/TODO；全部代码块完整可粘贴（探针脚本含完整 Page 类）。
3. **Type consistency**: `fakeGlobal(extra, labelPath)` 双参在 Step 1 定义并被 `/codex` 测试使用；6 个新测试 = 5 个行为 + 1 个组合边界回归（2026-09-17 修订追加）；`__DSH_STORAGE_NS__`、`<label>:<key>` 物理键格式在 Task 1 Interfaces 定义、Task 2 Step 4 消费；测试计数 60（基线）+6=66 与 Step 5 一致（组合回归测试为验收后修订追加）。
