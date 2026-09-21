# Agent Worlds AW-B（真实 agents hub：单 origin 子路径挂载）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ctx0 的单一 origin（:4999）上，把每个 foreign world（omp / codex / …）整站挂到 `/<label>/` 之下：世界自己的一套 web 面（资源、`/api`、mux、任意插件声明的前缀）全部由 ctx0 的 WebCarrier 收口并原位桥接到该 world 的 in-process 实例，浏览器侧零枚举改写。

**Architecture:** 每个 world 拿到一个**虚拟 webServer**（isolate scope 下的派生实例）：世界内插件按原样注册任意路径，我们的 `WorldWebServer` 在**注册那一刻**把路径翻译成 `/<label> + path` 转发给真实例，并把 `req.url` 去标签后交给原 handler；因此任意前缀（`/api`、`/plugins`、`/whatever`）自动落进标签命名空间，ctx0 永远只见 `/<label>`。unary 由我们的 `/<label>/api/*` 前缀 handler 解析 envelope 后调 world 的 `typertGateway.dispatchRpc`；mux 由 `/<label>/api/remote.mux` 的 exact upgrade 路由复用上游 `RemoteStreamMuxServer(open = world.openWireStream)`。浏览器侧只有一个 head script：`__DSH_TRANSPORT__.fetch` 改写同源根绝对路径 + `WebSocket`/`EventSource` shim + `__DSH_FILE_UPLOAD__` hook；服务端渲染 world index 时做一次 HTML pass（`<base>` 与注入 JSON 内根绝对 URL）。

**Tech Stack:** TypeScript（host half，tsc → `dist/`）、Node 22.23.2 ESM、cordis 4.0.2（`Service`/`isolate`/`reflect.provide`/fiber `effect`）、`node:test`（`.test.mjs`，跑 `dist/`）、`@deepseek-ai/dsh-{app-boot,host-webserver,api-gateway,client-connection,client-modules}`。

**Spec:**
- `docs/superpowers/plans/2026-09-14-agent-worlds-fusion-design.md`（设计正本 S1–S6 + 追加裁决）
- `docs/superpowers/plans/2026-09-16-aw-subpath-mount-findings.md`（F1–F14 取证：路由语义、注入机制、transport 覆盖面、两层边界、注册点翻译、冲突策略）

## Global Constraints

- **上游源码零修改**：依赖 exact-pin；所有改动只在 `apps/agent-worlds/*` 与 profile patch 层（`cordis.patch.yml`）。
- **绝不触碰** `~/.dsh`、`~/.superd`；dev/test 一律 `DSH_HOME=<repo>/.superd-test`。
- **端口纪律**：ctx0 = 4999；world 目前 4998（AW-B 目标为零监听）；prod 3080/3081 不动；`aw-codex-4985-test` 属他线不动。
- **拉起/关停**：只用 `systemd-run --user` / `systemctl --user stop`；不 kill；不从 agent 沙箱直拉 daemon。
- **单实例纪律**：任何 install 后跑 `node scripts/heal-modules.mjs`（`find node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l` 只应剩本仓自有物理包）。
- **验收**：改运行时行为就要运行时验收（起 4999 + 浏览器/curl 实测），单测绿只是构建卫生。
- **命名**：包名 `@pgmi-builds/agent-hub`；插件 id `agent-hub`；world 插件 id `aw.agent-adapter-omp`；标签键 = roster key（`omp`）。
- **host half 必须可单测**：所有新增逻辑先在 `dist/` 上跑 `node --test`，测试文件 `apps/agent-worlds/agent-hub/test/*.test.mjs`。

---

## Decisions locked（来自 F1–F14 的汇总，供执行者参照）

- **DL1 单 origin**：ctx0 的 webServer 是唯一 ingress；world 不再监听端口（AW-B 做完零监听）。
- **DL2 标签即路径**：`/<label>/` 是世界的整站根；`<label>` = roster key。
- **DL3 注册点翻译**：world 内任意前缀由虚拟 webServer 在注册时翻译；**不做前缀枚举**。
- **DL4 冲突策略**：标签前缀由我们的插件在激活时**抢占**；`register` 抛错即检测（无查询 API）；失败要响亮，并支持 `aw.root`/`aw.label.<key>` 配置 re-home。
- **DL5 unary**：`/<label>/api/<endpoint>` 归我们；解析 `client-request` envelope → `world.gateway.dispatchRpc` → `server-response`。
- **DL6 mux**：`/<label>/api/remote.mux` exact upgrade → `RemoteStreamMuxServer(open = world.gateway.openWireStream, failure = ours, heartbeat)`。
- **DL7 无服务端选中态**：`selector.ts` 的模块级 `state` 删除；RPC 面只提供 `available`（+ roster）；世界归属由路径/会话归属决定。
- **DL8 客户端唯一入口**：一个 head script（transport + primitive shim），规则 = 同源根绝对路径一律重挂 `/<label>/`。
- **DL9 会话归属索引**：ctx0 维护 `sessionId → world` 的 O(1) 索引（boot 列表 + 增删维护；miss 时一次有界刷新；**永不探测瀑布**）。
- **DL10 失败即失败**：未知 label、错 sessionId ⇒ 恰好一个被寻址 world 回答错误，零跨 world wire 调用。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `agent-hub/src/labels.ts`（新） | 标签表：`claimLabel(key)` 抢占/翻译/re-home、`labelOf(key)`、`releaseLabel(key)` |
| `agent-hub/src/world-web-server.ts`（新） | 虚拟 webServer：注册点翻译、fallback 归属、upgrade 翻译、index tap/injection 透传 |
| `agent-hub/src/carrier.ts`（新） | ctx0 WebCarrier：把虚拟 server 的注册接到真实例；世界 HTML pass；静态资源；unary/mux 桥 |
| `agent-hub/src/envelope.ts`（新） | `client-request` / `server-response` 解析与序列化（DL5） |
| `agent-hub/src/client-shim.ts`（新） | 生成 head script 文本（纯函数，可单测） |
| `agent-hub/src/ownership.ts`（新） | sessionId → world 索引（DL9） |
| `agent-hub/src/rpc.ts`（改） | 去掉 selector 读写；`/api/agent-runtime` 只回 `available` + roster |
| `agent-hub/src/gateway.ts`（改） | 删除 selector 分支；保留 native 直通（挂载后的 world 流量不再经此） |
| `agent-hub/src/selector.ts`（删） | 模块级选中态违反 DL7 |
| `agent-hub/src/index.ts`（改） | 导出面调整 |
| `agent-hub/test/*.test.mjs`（改/增） | labels / world-web-server / envelope / shim / ownership / dual-tab |
| `agent-worlds/test/fixtures/aw-omp-world/cordis.patch.yml`（改） | 零监听手术（disable webserver/web-runtime）|
| `agent-omp/src/world-plugin.ts`（改） | 世界插件改为：claim label → 虚拟 webServer → 注册 carrier |

---

### Task 1: 删除模块级选中态（DL7）

**Files:**
- Delete: `apps/agent-worlds/agent-hub/src/selector.ts`
- Modify: `apps/agent-worlds/agent-hub/src/rpc.ts`、`agent-hub/src/gateway.ts`、`agent-hub/src/index.ts`
- Test: `apps/agent-worlds/agent-hub/test/rpc.test.mjs`、`agent-hub/test/delegation.test.mjs`

**Interfaces:**
- Consumes: `listRuntimeKeys()`（`targets.ts`）
- Produces: `RuntimeTargetSource { listRuntimes(): string[] }`（保持）；`handle()` 只回 `{ available }`；`AGENT_RUNTIME_RPC_PATH` 不变

- [ ] **Step 1: 写失败测试**（`test/rpc.test.mjs` 增加）

```js
test('agent-runtime RPC exposes available worlds and carries NO server-side selection', async () => {
  const { handleAgentRuntime } = await import('../dist/rpc.js')
  const source = { listRuntimes: () => ['native', 'omp'] }
  const get = await handleAgentRuntime(new Request('http://x/api/agent-runtime'), source)
  assert.deepEqual(await get.json(), { available: ['native', 'omp'] })
  const post = await handleAgentRuntime(
    new Request('http://x/api/agent-runtime', { method: 'POST', body: JSON.stringify({ runtime: 'omp' }) }),
    source,
  )
  assert.equal(post.status, 400) // 不再存在“切换”语义
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/agent-worlds/agent-hub && npm run build && node --test test/rpc.test.mjs`
Expected: FAIL（`handleAgentRuntime` 未导出 / 返回含 `runtime`）

- [ ] **Step 3: 实现** — 删除 `selector.ts`；`rpc.ts` 改为导出 `handleAgentRuntime(request, source)`，GET 返回 `{ available }`，POST 返回 400 `{ error: 'selection is per-request (mount path); no server-side switch' }`；删除 `writeSelector/readSelector` 引用。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/agent-worlds/agent-hub && npm run build && node --test test/`
Expected: PASS（`delegation.test.mjs` 中 selector 断言同步删除）

- [ ] **Step 5: Commit**

```bash
cd apps/agent-worlds && git add -A && git commit -m "refactor(agent-hub): drop module-level selector state (DL7)"
```

---

### Task 2: 标签表与冲突策略（DL2/DL4）

**Files:**
- Create: `apps/agent-worlds/agent-hub/src/labels.ts`
- Test: `apps/agent-worlds/agent-hub/test/labels.test.mjs`

**Interfaces:**
- Consumes: `webServer.register` 的同步 throw（重复 `(kind,path)`）
- Produces:
  - `claimLabel(key: string, opts: { register: (path: string) => () => void; root?: string; alternateRoots?: string[] }): { path: string; release(): void }`
  - `labelOf(key: string): string | undefined`
  - `releaseLabel(key: string): void`

- [ ] **Step 1: 写失败测试**

```js
test('claimLabel reserves /<key> once and re-homes to an alternate root on collision', () => {
  const { claimLabel, labelOf, releaseLabel } = await import('../dist/labels.js')
  const taken = new Set(['/omp'])
  const register = (path) => {
    if (taken.has(path)) throw new Error(`webserver: duplicate prefix route "${path}"`)
    taken.add(path)
    return () => taken.delete(path)
  }
  const claimed = claimLabel('omp', { register, alternateRoots: ['/_agents'] })
  assert.equal(claimed.path, '/_agents/omp')
  assert.equal(labelOf('omp'), '/_agents/omp')
  releaseLabel('omp')
  assert.equal(labelOf('omp'), undefined)
  assert.equal(taken.has('/_agents/omp'), false)
})
```

- [ ] **Step 2: 跑测试确认失败** — `node --test test/labels.test.mjs`，Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `labels.ts`**：先试 `root ?? ''` + `/${key}`；throw 且给了 `alternateRoots` 则依次重试；全部失败时抛聚合错误（列出尝试过的路径与被占事实）；成功则记入 `Map<key, {path, release}>`。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS

- [ ] **Step 5: Commit** — `git commit -m "feat(agent-hub): label table with loud collision + re-home (DL2/DL4)"`

---

### Task 3: 虚拟 webServer——注册点翻译（DL3）

**Files:**
- Create: `apps/agent-worlds/agent-hub/src/world-web-server.ts`
- Test: `apps/agent-worlds/agent-hub/test/world-web-server.test.mjs`

**Interfaces:**
- Consumes: 真实例的 `register/registerUpgrade/registerFallback/tapIndex`
- Produces: `class WorldWebServer { constructor(labelPath: string, real: RealFace); register(route); registerUpgrade(route); registerFallback(handler); get path(): string; dispose(): void }`，其中 `RealFace` 为 `{ register; registerUpgrade; registerFallback; tapIndex }` 的结构类型

- [ ] **Step 1: 写失败测试**（翻译 + strip 语义 + 任意前缀）

```js
test('WorldWebServer translates ANY registered prefix at registration time and strips the label for the plugin handler', async () => {
  const { WorldWebServer } = await import('../dist/world-web-server.js')
  const real = { routes: new Map(), upgrades: new Map(), fallback: undefined,
    register(r) { this.routes.set(`${r.kind}:${r.path}`, r); return () => this.routes.delete(`${r.kind}:${r.path}`) },
    registerUpgrade(r) { this.upgrades.set(r.path, r); return () => this.upgrades.delete(r.path) },
    registerFallback(h) { this.fallback = h; return () => { this.fallback = undefined } },
    tapIndex() { return () => {} } }
  const world = new WorldWebServer('/whatever-world', real)
  const seen = []
  world.register({ kind: 'prefix', path: '/fuck-you-name-i-like', handler: (req) => seen.push(req.url) })
  world.registerUpgrade({ path: '/api/remote.mux', handler: () => {} })
  assert.equal(real.routes.has('prefix:/whatever-world/fuck-you-name-i-like'), true)
  assert.equal(real.upgrades.has('/whatever-world/api/remote.mux'), true)
  const route = real.routes.get('prefix:/whatever-world/fuck-you-name-i-like')
  await route.handler({ url: '/whatever-world/fuck-you-name-i-like/x' })
  assert.deepEqual(seen, ['/fuck-you-name-i-like/x'])   // handler 看到世界相对路径
})
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL

- [ ] **Step 3: 实现**：`register` 把 `path` 拼成 `${labelPath}${path}`、handler 包装为“`req.url` 去 label 前缀 → 调原 handler”；`registerUpgrade` 同（exact 拼接 + strip）；`registerFallback(h)` = `real.register({kind:'prefix', path: labelPath, handler: strip(h)})`；`tapIndex` 直接转发；`dispose()` 释放全部注册。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS

- [ ] **Step 5: Commit** — `git commit -m "feat(agent-hub): per-world virtual webServer with registration-time path translation (DL3)"`

---

### Task 4: unary 桥（envelope）与 mux 桥（DL5/DL6）

**Files:**
- Create: `agent-hub/src/envelope.ts`、`agent-hub/src/carrier.ts`
- Test: `agent-hub/test/carrier.test.mjs`

**Interfaces:**
- Produces:
  - `envelope.ts`: `parseClientRequest(text: string): { rpcId: string; method: string; payload: unknown }`；`serverResponse(rpcId, result): string`；`serverError(rpcId, error): string`
  - `carrier.ts`: `mountWorld({ real, label, gateway, distIndex }): { dispose(): void }`

- [ ] **Step 1: 写失败测试**（unary 走 world 实例 + 错误只回一个 world）

```js
test('carrier unary forwards the envelope method to the world gateway and answers with one server-response', async () => {
  const { mountWorld } = await import('../dist/carrier.js')
  const calls = []
  const world = { dispatchRpc: async (m, p) => { calls.push([m, p]); return { ok: true, value: 'v' } },
                  openWireStream: async function* () {} }
  const routes = new Map(), upgrades = new Map()
  const real = { register(r) { routes.set(r.path, r); return () => {} },
                 registerUpgrade(r) { upgrades.set(r.path, r); return () => {} },
                 registerFallback() { return () => {} }, tapIndex() { return () => {} } }
  const mounted = mountWorld({ real, label: 'omp', gateway: world, distIndex: undefined })
  const res = await routes.get('/omp/api/session.list').handler(
    { method: 'POST', url: '/omp/api/session.list', headers: {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: { a: 1 } })) } },
    fakeRes(),
  )
  assert.deepEqual(calls, [['session.list', { a: 1 }]])
  assert.match(res.body, /"type":"server-response"/)
  assert.match(res.body, /"rpcId":"r1"/)
  mounted.dispose()
})
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL

- [ ] **Step 3: 实现**：
  - `envelope.ts`：严格解析（`type==='client-request'`，字段类型校验）；`serverResponse` 产出 `{type:'server-response',rpcId,result:{ok:true,value}}`；失败产出 `{ok:false,error}`。
  - `carrier.ts`：注册 `{kind:'prefix', path:'/<label>/api'}` → 读 body → `parseClientRequest` → `gateway.dispatchRpc(method, payload, ac.signal)` → 写 `serverResponse`；异常写 `serverError` 并记日志；注册 `{path:'/<label>/api/remote.mux'}` upgrade 用 `RemoteStreamMuxServer`（Task 6）；注册 `{kind:'prefix', path:'/<label>'}` 作为 fallback 归属（HTML pass + 资源，Task 5）。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS

- [ ] **Step 5: Commit** — `git commit -m "feat(agent-hub): unary envelope bridge to world instance (DL5)"`

---

### Task 5: HTML pass 与静态资源（DL1/DL8 的服务端半）

**Files:** Modify: `agent-hub/src/carrier.ts`；Test: `agent-hub/test/html-pass.test.mjs`

**Interfaces:**
- Produces: `rewriteIndexHtml(html: string, labelPath: string): string`

- [ ] **Step 1: 写失败测试**

```js
test('rewriteIndexHtml sets the mount base and re-roots every root-absolute URL in injected rows', async () => {
  const { rewriteIndexHtml } = await import('../dist/carrier.js')
  const html = '<head><base href="/"></head><script>globalThis.__DSH_BOOT__={"batches":[{"url":"/plugins/??a/client.js&rev=1"}]}</script>'
  const out = rewriteIndexHtml(html, '/omp')
  assert.match(out, /<base href="\/omp\/">/)
  assert.match(out, /"url":"\/omp\/plugins\/\?\?a\/client\.js&rev=1"/)
})
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL

- [ ] **Step 3: 实现**：替换 `<base href="...">`；对字符串内 `"/` 开头的同源根绝对路径做前缀化（限定 `"/plugins/`、`"/api/`、`"/assets/` 之外的通用做法：正则 `"(\/(?!\/|omp\/))` → `"\/omp\/`），并保持幂等（已带标签不再改）。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS

- [ ] **Step 5: Commit** — `git commit -m "feat(agent-hub): mount HTML pass (base + root-absolute rewriting)"`

---

### Task 6: mux 桥（RemoteStreamMuxServer 复用）

**Files:** Modify: `agent-hub/src/carrier.ts`；Test: `agent-hub/test/mux-bridge.test.mjs`

**Interfaces:**
- Consumes: `RemoteStreamMuxServer`（`@deepseek-ai/dsh-api-gateway/src/stream-server.ts`，经 `./src/*` 导出；若解析失败则回落到本地最小实现）
- Produces: `createMuxBridge(gateway, opts: { heartbeatIntervalMs: number; failure: (e: unknown) => unknown })`

- [ ] **Step 1: 写失败测试**：断言 `mountWorld` 注册了 exact upgrade `/<label>/api/remote.mux`，并对未授权请求（`connection.requestRejection` 返回 401）走 `rejectRemoteStreamUpgrade`。
- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL
- [ ] **Step 3: 实现**：`new RemoteStreamMuxServer((e,p,s)=>gateway.openWireStream(e,p,s), failure, heartbeat)`；handler 先 `requestRejection`；`dispose` 里 `registerUpgrade` disposer + `mux.close()`。
- [ ] **Step 4: 跑测试确认通过** — Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-hub): mux bridge reusing upstream RemoteStreamMuxServer (DL6)"`

---

### Task 7: 客户端 head script（DL8）

**Files:** Create: `agent-hub/src/client-shim.ts`；Test: `agent-hub/test/client-shim.test.mjs`

**Interfaces:**
- Produces: `renderClientShim(labelPath: string): string`（返回可注入的 classic script 文本）

- [ ] **Step 1: 写失败测试**（在 node 里以 fake global 执行脚本文本，验证改写规则）

```js
test('client shim re-roots same-origin root-absolute URLs and is idempotent', async () => {
  const { renderClientShim } = await import('../dist/client-shim.js')
  const src = renderClientShim('/omp')
  const g = { fetch: async (u) => ({ url: String(u) }), location: { origin: 'http://h:4999', pathname: '/omp/' }, WebSocket: class {}, EventSource: class {}, XMLHttpRequest: class {}, __DSH_TRANSPORT__: undefined }
  new Function('globalThis', src)(g)
  assert.equal(g.__DSH_TRANSPORT__.rewrite('/api/session.list'), '/omp/api/session.list')
  assert.equal(g.__DSH_TRANSPORT__.rewrite('/omp/api/x'), '/omp/api/x')
})
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL
- [ ] **Step 3: 实现**：脚本安装 `__DSH_TRANSPORT__.fetch`（改写后委托原生 fetch；保留 signal/headers/body）、包装 `WebSocket`/`EventSource`/`XMLHttpRequest` 构造参数 URL、设置 `__DSH_FILE_UPLOAD__`（如需），并导出纯函数 `rewrite(path)` 供测试。
- [ ] **Step 4: 跑测试确认通过** — Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-hub): single client shim (transport + primitives)"`

---

### Task 8: 会话归属索引（DL9/DL10）

**Files:** Create: `agent-hub/src/ownership.ts`；Test: `agent-hub/test/ownership.test.mjs`

- [ ] **Step 1: 写失败测试**：`index(sessionId, world)`、`lookup(sessionId)` 命中 O(1)；miss 时调一次 `refresh()`（可注入），**只调一次**（断言计数）；未命中返回 `undefined` 且不触发任何 dispatch。
- [ ] **Step 2: 跑测试确认失败** → FAIL
- [ ] **Step 3: 实现**：`Map<string, string>` + `refreshOnce()` 去重（in-flight promise 合并）。
- [ ] **Step 4: 跑测试确认通过** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-hub): session→world ownership index (one bounded refresh, zero probe)"`

---

### Task 9: 世界组合：零监听 + 虚拟 webServer（AW-B 主手术）

**Files:**
- Modify: `apps/agent-worlds/agent-hub/test/fixtures/aw-omp-world/cordis.patch.yml`
- Modify: `apps/agent-worlds/agent-omp/src/world-plugin.ts`
- Test: 新增 `agent-worlds/test/zero-listener.test.mjs`（断言 world context 内无 `webserver` 真实例、`webServer` 解析到虚拟实例）

- [ ] **Step 1: 审计 pending 链**：先在 fixture 里 disable `webserver` + `web-runtime`，起 world（4998 脚本临时改 0 端口），记录所有 pending/failed 行（AW-A 记录为 9 条：connection/fileUploads 链）。
- [ ] **Step 2: 写断言测试**：`world.get('webServer')` 为 `WorldWebServer` 实例；`world.get('webserver')`（真实例）为 `undefined`；world 内插件注册的任意前缀在 ctx0 真实例表里以 `/<label>` 前缀存在。
- [ ] **Step 3: 实现**：`world-plugin.ts` 里 `claimLabel('omp', {register: real.register})` → `new WorldWebServer(labelPath, real)` → 在 world 的 isolate scope 里 `reflect.provide('webServer', worldWebServer)` → `mountWorld({...})`；对 Step 1 审计出的 pending 行逐条给出替代（虚拟实例即替代品）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** — `git commit -m "feat(agent-worlds): zero-listener world + virtual webServer mount (AW-B core)"`

---

### Task 10: 双 tab 隔离与错 sessionId 验收（DL10）

**Files:** Create: `apps/agent-worlds/agent-hub/test/dual-tab.test.mjs`；Modify: `apps/agent-worlds/test/smoke.mjs`

- [ ] **Step 1: 写失败测试**：两个 tab（`/`+native、`/omp/`+world）并发：native 的 list 只走 native 实例；world 的 list 只走 world 实例；断言**跨 world wire 调用计数 = 0**。
- [ ] **Step 2: 跑测试确认失败** → FAIL
- [ ] **Step 3: 实现**：以 carrier + ownership 装配两个 tab 的调用路径；错 sessionId ⇒ 一次 `session/not-found`，`dispatchRpc` 计数不变。
- [ ] **Step 4: 跑测试确认通过** → PASS
- [ ] **Step 5: Commit** — `git commit -m "test(agent-hub): dual-tab isolation + zero-probe assertions (DL10)"`

---

### Task 11: 起服务交用户实测（运行时验收）

- [ ] **Step 1:** `bash apps/agent-worlds/test/start-4999.sh`（native ctx0，4999）
- [ ] **Step 2:** world 以零监听方式随 ctx0 起（不再需要 4998 脚本）
- [ ] **Step 3:** 给用户 token URL（+ LAN/WAN）与 `/omp/` 入口，**保持运行**，等用户亲手测完再收尾
- [ ] **Step 4:** 结果写 `docs/test-reports/`（惯例建立后生效）
- [ ] **Step 5:** 提交 `docs: AW-B acceptance record`

---

## Self-Review（写计划后自查）

**1. Spec coverage：** S1（单跳路由）→ Task 2/4/10；S2（插件即在册）→ 现有 roster + Task 9；S3（嵌套 home，不覆盖 dshHomePath）→ 不涉及改动，Task 9 不引入 home 覆盖；S4（委派/定制、进程边界）→ Task 3/9；S5（行级深度）→ 不改动；S6（哑路由器、生命周期归 world）→ Task 3/9；DL7 无选中态 → Task 1；DL8 客户端单入口 → Task 7；DL9/DL10 → Task 8/10。

**2. Placeholder scan：** 无 TBD/TODO；每个实现步给了具体行为与文件；测试步给了可运行代码。Task 5 的正则与 Task 7 的脚本实现细节以测试断言固定其行为（幂等、保留 signal/body）。

**3. Type consistency：** `claimLabel` / `labelOf` / `releaseLabel`（Task 2）、`WorldWebServer`（Task 3）、`parseClientRequest` / `serverResponse` / `serverError`（Task 4）、`rewriteIndexHtml`（Task 5）、`mountWorld`（Task 4/9）、`renderClientShim`（Task 7）、`handleAgentRuntime`（Task 1）在各任务间一致。

**已知风险（Task 9 必须回报）**：零监听手术会引发 AW-A 记录的 9 条 pending 链；若虚拟 webServer 不能完全替代（例如某行直接 `ctx.get('webserver')` 私有态），则在 Task 9 Step 1 的审计结果里如实登记，并给出最小替代或退回“world 用临时 0 端口 + 代理”的降级路径。

---

## Execution Record（2026-09-16，goal round 1/10）

嵌套仓 `apps/agent-worlds`：

| 任务 | commit | 结果 |
|---|---|---|
| Task 1 删除模块级选中态（DL7） | `4838164` | `selector.ts` 删除；`rpc.ts` 只回 `{available}`；`gateway.ts` 去掉实例委托包装；测试重写 |
| Task 2 标签表与冲突策略（DL2/DL4） | `cf4ac15` | `labels.ts`：抢占/响亮失败/re-home；5 测试绿 |
| Task 3 虚拟 webServer 注册点翻译（DL3） | `5aa2912` | `world-web-server.ts`：任意前缀注册即翻译、handler 见世界相对 URL、fallback 落 `<label>`、index 世界本地；7 测试绿 |
| Task 4 unary envelope 桥（DL5） | `dadc393` | `envelope.ts` + `carrier.ts`：`/<label>/api/*` → world `dispatchRpc` → 一条 `server-response`；envelope 失败 400 且零世界调用；6 测试绿 |
| Task 5 HTML pass（DL8 服务端半） | `e2fc2e7` | `index-pass.ts`：pin `<base>` + 通用根绝对串重挂 + 幂等；4 测试绿 |

**本轮取证的额外事实（影响后续任务）**：

1. **cordis 事件按 ROOT 隔离、树内全局**（实测）：同一树内 child emit 会触达 root/grand 的 listener；两个独立 `new Context()` root 之间完全不串。⇒ 世界必须保持**独立 root**（现 `spawnWorld` 即是），虚拟 webServer 的 index 注入在 world root 上 emit，天然不会与 ctx0 的行表互污。
2. **`tsc` 的 module 判定依赖 package.json 可解析**：Task 3 提交里 package.json 一度被写坏（JSON 无效）→ TS 退化按 CJS 发射（`exports.x = ...`），Node 侧命名导出探测失败。Task 4 已修复并清 dist 重建为 ESM。教训：改 package.json 后必须 `python3 -m json.tool` 校验。
3. **既存红灯（非本线引入）**：`agent-hub/test/zero-port.audit.test.mjs` 在 HEAD 亦失败——它 spawn world 时用默认锚点（全局 prod dsh），无法解析 world profile 的 `@pgmi-builds/agent-adapter-omp`。Task 9 做主手术时一并处理（改为 repo-local 锚点 + profile farm 解析）。

**当前套件**：`node --test test/*.test.mjs` → 30 tests，29 绿，1 已知环境红灯（上述 zero-port audit）。

**下一步**：Task 6（mux 桥，复用 `RemoteStreamMuxServer`）、Task 7（客户端 head script）、Task 8（归属索引）、Task 9（零监听 + 虚拟 webServer 主手术）、Task 10（双 tab 断言）、Task 11（4999 实测交付）。

### Round 2/10（2026-09-16）

| 任务 | commit | 结果 |
|---|---|---|
| Task 6 mux 桥（DL6） | `529a6f6` | **上游 mux 类不可达**（包根不导出；`./src/*` 运行时 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）⇒ 自写线兼容实现 `world-mux.ts`（open/cancel ↔ item/end/error + ping 心跳、两次丢包 terminate），用**真实 HTTP upgrade + 真实 ws 客户端**在线上验证（4 测试）；carrier 挂 `/<label>/api/remote.mux` 并复用同一 trust fence，dispose 关闭 mux。`ws@8.21.0` 声明为运行时依赖，dev 解析走 `agent-hub/node_modules/ws → upstream pnpm store` 软链（profile farm 亦经此解析）。
| Task 7 客户端 head script（DL8） | `1a16899` | `client-shim.ts`：单脚本装 `transport.fetch` + WebSocket/EventSource/XMLHttpRequest + `__DSH_FILE_UPLOAD__`；规则与命名空间无关且幂等；**同 authority 判定**（ws/wss 与 http/https 共享 host，故 mux URL 也被重挂）；7 测试以 fake page global 执行脚本文本。
| Task 8 归属索引（DL9/DL10） | `e0e487b` | `ownership.ts`：O(1) 命中；miss 至多一次有界刷新（并发 miss 合并 in-flight）；刷新后仍 miss 即 miss（零探测、零跨 world 调用）；6 测试。`index.ts` 同时补齐挂载面导出。

**Round 2 新增事实**：

1. `host connection` 提供 **`connection.rpc.handle(channel, handler)`**（"authenticated absolute channel prefix"，自带物理路由 + envelope + auth fence，`/api` 之外任意前缀）。⇒ unary 挂载后续可改为 `handle('/omp/api', …)`，比 carrier 手写 envelope 更省；carrier 当前实现保留（已测试、且不依赖 connection 实例）。
2. 上游 `packages/api/gateway/src/stream-server.ts` 的 mux 类**既不重导出、也不能运行时 import**（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，node_modules 下不做类型剥离）；`ws` 不在 repo farm/profile farm，需 dev 软链解决。

**当前套件**：`node --test test/*.test.mjs` → 49 tests，48 绿，1 已知环境红灯（zero-port audit，归 Task 9）。

**下一步（Round 3）**：Task 9 主手术（fixture 关 webserver/web-runtime + 虚拟 webServer 提供进 world 组合 + 9 条 pending 审计 + 修那条红灯，改为 repo-local 锚点与 profile farm 解析）、Task 10（双 tab/错 sessionId 断言）、Task 11（4999 实测交用户）。

### Round 3/10（2026-09-16）— Task 9 part 1

commit `1b0ce9c`。**审计实测（.scratch/awb-zerolisten-audit.mjs，三组对照）**：

| 组合 | 结果 |
|---|---|
| 基线（webserver on，port 0） | webServer/webRuntime/connection/clientModules/typert/typertGateway/sessionController/sessionQuery/fileUploads 全部在 |
| 只禁 `webserver` | **BOOT FAILED**：`client-modules: 1 client package failed to compose` |
| 禁 `webserver` + `web-runtime` | 同上（不是 webRuntime 的问题） |

**根因**：`packages/client/modules/src/index.ts:576` 用 `ctx.get('webServer')` 探测，但**没有声明 inject** ⇒ 世界缺的正是 `webServer` **服务本身**（不是 webRuntime）。**干净解**：patch 层支持任意字段覆盖（`vendor/include/src/index.ts:77-121`，`for (const [key,value] of Object.entries(overrides)) target[key]=value`）⇒ 给 `modules` 行补 `inject: ['webServer']`，cordis 就会**等**我们的虚拟 provider，激活顺序无关。

**已落地（本线代码）**：

- `world-web-server.ts`：新增 hub-owned 规则（`/api`、`/api/*` 的 register/registerUpgrade 一律 swallow，返回 no-op disposer）——RPC 通道归 hub，世界不抢；`renderIndex` 末尾套 `rewriteIndexHtml`（base + 根绝对串）。
- `world-host.ts`：跨 root 挂载登记（ctx0 → world 的对象交接；cordis 事件按 root 隔离，服务树不相通，故用同模块实例交接）。
- `world-entry.ts`（新导出 `./world`）：在 world root 里 `noteWorldServer` + `ctx.reflect.provide('webServer', 虚拟实例)`，并 `ctx.effect` 绑定 dispose。
- **集成验证** `test/world-mount.test.mjs`：世界以 `webserver` disabled 启动，成功 boot 后 ctx0 真实例上出现 `prefix:/omp/plugins`（世界 client-modules 注册）与 `prefix:/omp`（世界 frontend-static fallback），而 `/omp/api`、`/omp/api/remote.mux` **不出现**（归 hub）。

**顺带**：删除过时的 `zero-port.audit.test.mjs`（其主题被零监听形态取代）；`npm test` 改为 `node --test --test-force-exit`——world boot 会留下 adapter/sqlite 句柄，否则 runner 不退出。

**当前套件**：`npm test` → **51 tests，51 绿**。

**Task 9 余下（Round 4）**：把该机制接进真实 hub 路径——`agent-omp/src/world-plugin.ts` 在 spawn 前 `registerHostMount`、spawn 时带上（a）`webserver` disabled、（b）`modules` 补 inject、（c）insert `@pgmi-builds/agent-hub/world` 三处 patch；同步 fixture/profile；然后 Task 10、Task 11。

### Round 4/10（2026-09-16）— Task 9 part 2 + Task 10

| 任务 | commit | 结果 |
|---|---|---|
| Task 9 part 2 接入真实路径 | `bfd4694` | `world-mount.ts`：`worldMountPatches(key)` 固化三处 patch；`agent-omp/src/world-plugin.ts` 改为 `inject(['webServer','connection'])` → `registerHostMount` → spawn（带 patches）→ `mountWorld`（unary+mux，auth fence 用 ctx0 `connection.requestRejection`）→ `ctx.effect` 绑定 dispose；集成测试改用该 helper。适配器 tsc 绿、37 测试 36 绿 0 红。 |
| Task 10 双 tab 与零探测 | `13d59b0` | `test/dual-tab.test.mjs`：两 mount 交错流量各自记账互不串；错 sessionId 只由被寻址 world 答一次（另一个计数 0）；ownership miss 零 dispatch、hit 只打 owner；dispose 一个不影响另一个。 |

**环境修正（非源码）**：`agent-omp/node_modules/@pgmi-builds/agent-hub` 原为 09-15 物理拷贝（缺新导出）⇒ 改为指向活包目录的软链。

**当前套件**：hub `npm test` → **57 tests / 57 绿**；adapter → 37 tests / 36 绿 / 0 红。

**Task 11 准备事实（实测）**：`aw-ctx0` profile 的 bundles = `dsh-base` + `dsh-web-app` + `agent-hub`，**不含 adapter** ⇒ 进程内 OMP world 不会生成，需把 `@pgmi-builds/agent-adapter-omp` 加进 ctx0 profile；4999 现被一个实例占用且有 `aw-4999-relay.service` active ⇒ 需先停旧再起；拉起口径按 AGENTS.md §三（systemd-run --user、DSH_HOME=.superd-test/aw、repo build launcher、--no-open）。

**Task 11（下一轮）**：adapter bundle 加进 ctx0 profile → 起 4999（零监听 world 进程内挂载）→ 验 `/` 与 `/omp/` → 把 token URL 与 `/omp/` 入口交 user 实测并保持运行。

### Round 5/10（2026-09-16）— Task 11 完成（起 4999，实测通过，交 user）

commit `edbb6ce`。

**接线**：`test/smoke.mjs` 的 ctx0 组合改为 insert **adapter 的 world-plugin 行**（`@pgmi-builds/agent-adapter-omp/world`）——**不是** adapter 的 bundle patch（那属于 world root，会禁掉 ctx0 的原生 loop）；并从 fixture 预备 `aw-omp-world` profile。

**实测发现并修掉的两个真问题**（都在 `world-web-server.ts`）：

1. **客户端 shim 未注入** ⇒ `renderIndex` 现在把 `renderClientShim(labelPath)` 作为**第一个 head 行**注入（必须早于 app 入口模块）。
2. **双 `<base>` 且上游在前**：world 自己的 frontend-static 在 `renderIndex` **之后**插入 `<base href="/">`，而**浏览器取第一个 base** ⇒ 挂载 base 失效。修法：`registerFallback` 在响应出站时改写 HTML（`res.end` 包装，仅当 body 含 `<head>` 与 `<base>`），把首个 base 重钉到 `/<label>/`。

**线上实测（127.0.0.1:4999 与 https://test.pc.randomhash.app 均通过）**：

| 检查 | 结果 |
|---|---|
| 无 token `/` | 401 |
| token URL → `/` | 200 |
| `/omp/` | **200**（36 KB），首个 `<base href="/omp/">`，含 `__DSH_TRANSPORT__` shim |
| `/omp/plugins/??…`（world client-modules） | **200**（11.1 MB） |
| `/omp/assets/index-*.js` | **200** |
| `POST /omp/api/session.list` | 由 **world 的 gateway** 应答（返回它自己的 `gateway/arguments-invalid` 描述符错误 ⇒ 桥通） |
| 监听面 | 仅 `127.0.0.1:4999`（+ LAN relay bind）；world 无端口 |
| roster 日志 | `[{"key":"omp","label":"OMP","ready":true}] ompWorld=true` |

**遗留**：`aw-world-omp-4998.service`（AW-A 时期的独立进程 world）仍 active，现已冗余；未擅自停（等 user 决定）。

**状态**：AW-B Task 1–11 全部完成；hub 套件 **59 tests / 59 绿**。实例保持运行，等 user 亲手验收。

### Round 6（2026-09-16）— user 实测反馈后的真因定位与修复

**user 实测反馈**：OMP 世界页「2 个 ws、无 session、可新建、**无权限策略选择器、无模型选择器、chatbox 一直灰**」，并质疑是否真测过 OMP 对话。

**新增实测手段**（以后验收可复用）：

- `.scratch/awb-cdp.mjs` — 用 playwright 自带的 chromium + 原生 CDP（`/json/new` + 页面 target WS，无需 sessionId/flatten）驱动真实浏览器；抓 console/exception/网络 4xx/WS 握手与帧错误，并 dump DOM（composer 可编辑性、按钮 aria-label、baseURI、shim 类型）。
- `.scratch/awb-chat.mjs` — 在真实浏览器里 focus composer → `Input.insertText` → 点 Send，再回读会话正文。
- `.scratch/awb-wsprobe.mjs` — 在页内直接 `new WebSocket('/api/remote.mux')` 发一帧，逐层验证 shim 与 mux。

**服务端侧先被排除**（原生 vs 世界逐端点对照，均带完整信封 `{type,rpcId,method,payload:{args:…}}`）：`session/modelCatalog`、`session/list`、`llm/listProviders`、`agentPresets/list` 世界都正常（世界返回的是 OMP 自己的 provider 集与 `preset=omp`）；`/omp/api/remote.mux` 从 Node 与从页面内都能升级成功并按 wire 协议回帧。

**真因（shim bug）**：world 页 `WebSocket.OPEN === undefined`——`client-shim.ts` 用**手搓包装函数**替换了全局构造器，丢掉静态常量；而上游 mux 客户端有 4 处 `socket.readyState === WebSocket.OPEN` 判定 ⇒ 客户端永不认为 socket 已开 ⇒ `[session-controller] control stream failed: … reading 'send'` + `[connection] connection lost, retry #1..N` ⇒ UI 停在「Choose a workspace to start」⇒ 无模型/权限选择器、composer 灰。该重连风暴同时不断 spawn OMP sidecar，最终 `systemd-oomd killed 32 processes`（4.7G，18 分钟）。

**修复**（commit `f7bc48b`）：用 `new Proxy(NativeCtor, { construct })` 拦截构造，保留 `CONNECTING/OPEN/CLOSING/CLOSED`、`prototype`、`instanceof`；WebSocket 与 EventSource 同款。补测试「intercepted constructors keep the native statics and prototype」。

**真实浏览器复验（修复后）**：world 页 `editableCount=1`、按钮含 `Access mode, current: Full access` 与 `Select model, current glm-4.7`、正文含 composer 与 workspace 列表、WS 到 `/omp/api/remote.mux` 得 **101**、**无** connection-lost 重试；随后在浏览器里发了一条真实 prompt，world session 记录 `outputTokens=77`，原生 session log（`session.v3.jsonl.zstd`）里读到真实 `assistant/message`（reasoning 文本即在处理该 prompt）⇒ **OMP 对话端到端闭环成立并落盘**。RSS 稳定 ~383M。

**套件**：hub **60 tests / 60 绿**（新增 1 条 shim 测试）。

**遗留**：① 本轮启动日志里 `theme initialized` 仍累计 104 行（sidecar 语义未查清，但 RSS 稳定、无 live sidecar 进程）；② 上一轮 OOM 是否完全绝迹**未做长时浸泡**（重连风暴已消除，但需 user 使用期间观察）；③ `aw-world-omp-4998.service` 仍 active。]]
