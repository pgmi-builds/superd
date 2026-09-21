# AW 浏览器存储按 world 分键 — 取证与补丁方案（2026-09-16）

> 目的：查清 agent-worlds 三条 world（`/` native、`/omp/`、`/codex/`，单 origin 4999）的浏览器侧存储到底「有没有、怎么分键、怎么分区」，解释「native 刷新总回原会话、omp/codex 总落新会话页」的不对称症状，并给出**不拆 UI、不换 origin** 的最小补丁方案。
> 基准：`upstream/deepseek-harness` @ `dsh-v0.1.5-rc.2`（物理 checkout）；live 取证对象 = 运行中的 4999 实例（headless Chrome 实测，非纯读码）。
> 前置文档：`2026-09-16-aw-subpath-mount-findings.md`（子路径挂载本身）。

---

## F1 — DSH 客户端的浏览器存储面（全清点）

客户端只有 **`localStorage` 一条持久化路**：`packages/client/store/src/index.ts` 的 `attachPersistence`（`:142-174`）——键名就是声明里的 name 原样字符串；读写在插件实例化时发生；**读写失败静默降级**（只 `console.error`，持久化悄悄失效，`else` 分支注释明写 "only disable persistence, never break the store"）。会话级 store 由 `defineStore` 加 `.${scopeKey}` 后缀（`:224-227`）。

生产键清单：

| 键 | 归属 | 作用域 | 证据 |
|---|---|---|---|
| `dsh.sessions.current` | `api/session-controller`（会话选择） | **全 origin** | `packages/api/session-controller/src/client/sessions/service.ts:227` |
| `dsh.workspace.view.v5` | `client/ui-workspace` | 全 origin | `packages/client/ui-workspace/src/client/stores.ts:61` |
| `dsh.conversation.<sessionId>` | `client/ui-conversation`（草稿/View 偏好） | 按 session id | `packages/client/ui-conversation/src/client/stores.ts:6,44` |
| `dsh.trajectory.duration` | `client/ui-trajectory` | 全 origin | `packages/client/ui-trajectory/src/client/duration-store.ts:11` |
| `dsh.open-in-app.choice` | `client/ui-open-in-app` | 全 origin | `packages/client/ui-open-in-app/src/client/controller.ts:27` |

**没有** `sessionStorage`、**没有** IndexedDB / CacheStorage（`packages/client` 全 grep 仅一条注释命中）。
**没有** `localStorage.clear()` / `.key()` / `.length` 的生产调用（`packages/*/src` + session-controller src 全 grep 零命中）；唯二使用者是 `packages/test-support/client-runtime/src/index.ts:440`（浏览器 e2e 台架，跑 dsh 测试页、不带 world shim）与各 `*.spec.ts`。store 引擎的清理路径是 `clearPersisted()` → `removeItem(persistKey)`（`store/src/index.ts:239-241`）。

## F2 — 分区语义：只按 origin，与路径无关；hub 零命名空间

- `localStorage` 按 **origin（scheme://host:port）** 分区，路径不参与。`/`、`/omp/`、`/codex/` 在 `127.0.0.1:4999` 上是**同一个桶**。
- hub 侧对存储 **零处理**：`apps/agent-worlds` 全树 grep `localStorage|sessionStorage|indexedDB|clearPersisted|sessions.current` **0 命中**。world 页注入的 head shim（见 F4）只改写 `fetch` / `WebSocket` / `EventSource` / `XMLHttpRequest`。
- 三个 world 是**同一个客户端 shell**：boot entries 均为 54 个插件、id 集合完全一致（root/omp/codex 仅 rev 不同）。分别抓取三个 world 的 `dsh-api-session-controller/client.js`，**均含字面量 `dsh.sessions.current`**（rev：root `08124f64928e8848` / omp `9a63e253279b61ed` / codex `85a23070da6ac670`）。
- ⇒ **结论：三个 world 共用一个桶、共用同一批裸键，互相覆盖。**「foreign agent 有没有自己的浏览器存储」的答案是：有，但不是自己的——是和 native 抢同一份。

另一条分区轴（运维侧）：`127.0.0.1:4999`、`192.168.31.130:4999`（socat 中继）、`https://test.pc.randomhash.app`（Caddy）是**三个不同 origin → 三个独立桶**；token 登录重定向不改变 origin。「上次停在哪」也取决于从哪个 URL 进入。

## F3 — live 复现（headless Chrome，全新 profile，127.0.0.1:4999）

| 步骤 | 结果 |
|---|---|
| 全新加载 `/` | 键被写入 native 会话 `session-c0092a68…`；列表 = `[New Session(选中), hihi 1h]` |
| 切到 `/omp/` | **同一键被覆盖**为 omp 会话 `session-4638f65b…`；`dsh.workspace.view.v5` 同样被覆盖（`sessionOrderByAccount` 混入两 world 的 id） |
| 用 native id 污染键 → 加载 `/omp/` | 空白「Into the Unknown Preview」hero；键被改写为 omp 列表里的空白行 `session-4638f65b…` |
| 在 `/omp/` 选真实会话 "what is your cwd"（`session-d8c8b513…`）→ 原地刷新 | **正常恢复**，transcript 渲染，键保持该 id |
| 污染键 → 加载 `/codex/`（前后对比） | 行数不变（2 行），仍选中同一个空白行 `session-477901e7…` ⇒ **污染启动不创建新会话**，只是回选到列表顶部的空白行 |
| 用 omp id 污染键 → 加载 `/` | native 也落空白 hero，键改写回 `session-c0092a68…` ⇒ **native 无结构性豁免** |

**症状解释**：不对称不是能力差异，是**写入顺序**——谁最后写键，下一个 world 进来吃到外来 id。native「总能恢复」只是它常是那个没有被中间切换污染的 world。

## F4 — 根因机制（上游 file:line）

1. **恢复只认本 world 的列表**：列表投影 `current = selected` 仅当 `selected` 出现在本 world `session/list` 结果里，否则 `current === undefined`（`packages/api/session-controller/src/client/sessions/manager.ts:943-947`）。
2. **`current === undefined` → 抹掉持久化选择**：`if (current === undefined) { if (persisted !== undefined) this.selection.set({}) }`（`service.ts:630-644`）。
3. **无 current = 空态**：layout 渲染无会话空态（`service.ts:310-316` 注释：new-session affordance）——即用户看到的「new session 页」。
4. 外来 id ⇒ 第 1 步判否 ⇒ 第 2 步清键 ⇒ 第 3 步空态；随后的回选把本 world 列表顶部的空白会话写回键里 ⇒ 下次加载仍落空白（「no matter where it was left」的粘滞感）。

## 裁决 — 单 app 保持，存储命名空间落在 head shim

前提（user 裁决 2026-09-16）：**不拆分 UI、不换 origin/端口**；world 仍以 `/omp`、`/codex` 子路径呈现在同一个 app 里。既有的 roster/selector 客户端 patch（`agent-hub/src/client/RuntimeSeat.tsx`）不动。

落点选择：`renderClientShim(labelPath)`（`apps/agent-worlds/agent-hub/src/client-shim.ts`，经 `world-web-server.ts:264` 以 `{kind:'script', placement:'head'}` 注入，注释明写 "it must run before the app entry module"，parser-blocking）。该脚本先于 `__DSH_BOOT__` 与全部 client modules ⇒ 必然早于任何 store 的 `attachPersistence` 读取。**不能**放在 `agent-hub/src/client/` 的 cordis 客户端插件里（ModuleLoader 之后才挂载，太晚）。归属：这是**挂载（AW-B）问题**而非 per-agent 问题，hub shim 层正确。

## 补丁清单

### P1（唯一功能改动）`apps/agent-worlds/agent-hub/src/client-shim.ts`

在 `renderClientShim` 生成的脚本尾部追加 Storage 命名空间区块（约 25 行）：

```js
// NS 由 labelPath 派生：'/omp' → 'omp:'；root '/' 不注入本 shim（保持裸键）
if (typeof localStorage !== 'undefined' && !globalThis.__DSH_STORAGE_NS__) {
  const NS = LABEL.slice(1) + ':'
  globalThis.__DSH_STORAGE_NS__ = NS          // 幂等标记 + 调试面
  const P = Storage.prototype
  const g = P.getItem, s = P.setItem, r = P.removeItem
  P.getItem    = function (n) { return g.call(this, NS + n) }
  P.setItem    = function (n, v) { return s.call(this, NS + n, v) }
  P.removeItem = function (n) { return r.call(this, NS + n) }
}
```

硬性要求：
- **绝不抛错**（`typeof localStorage === 'undefined'` 整块跳过）——`attachPersistence` 对异常静默降级，shim 抛错 = 持久化悄悄失效。
- **不包 `clear()`**（F1：生产零调用）；**不做 `length`/`key()` 枚举语义**（生产不枚举）。
- 只包 `getItem`/`setItem`/`removeItem` 三个；不改 `Storage` 构造器、不碰 prototype 以外的东西（instanceof / 双实例教训同 WebSocket Proxy 注释，`client-shim.ts:104-107`）。
- 调用点零改动（`world-web-server.ts:264` 已把整个 shim 放 head 最先）。

### P2 测试 `apps/agent-worlds/agent-hub/test/client-shim.test.mjs`（已存在，扩展）

- set → 物理键带前缀；get → 对裸键不可见（跨 world 隔离）；remove → 只删本前缀键。
- NS 派生：`/omp` → `omp:`、`/codex` → `codex:`。
- 无 localStorage 环境（node）整块跳过、不抛。
- 重复渲染/执行不二次包裹（幂等标记生效）。

### P3 实测验收（红线：改「运行时行为」就用「运行时行为」验收）

1. 起 4999（既有 `apps/agent-worlds/test/start-4999.sh`）。
2. `/omp/` 与 `/codex/` 各自选中一个真实会话 → 互切 world → **各自刷新仍回原会话**（本次取证中的反例场景全部翻转）。
3. DevTools 核对：物理键为 `omp:dsh.sessions.current` / `codex:…`；root `/` 的裸键存在且未被 world 污染；world 页也读不到 native 的裸键。
4. 原有 shim 职责回归：`/api`、`/api/remote.mux`、上传、WS 流全部照常（改 shim 后必须回归，不只测存储）。

### 明确不做

- **不做迁移回退**：对 `dsh.sessions.current` 做「前缀缺失 → 读裸键」等于把 native 的选择再漏进来（就是本 bug 本身）。各 world 首次加载多一次「按自己列表重选」，之后各自持久化。
- **root `/` 不注入 shim**：native 保持裸键，兼容现有数据；world 从此不再碰裸键。
- 不动 `RuntimeSeat.tsx` / roster / selector；不动上游（零修改红线）；sessionStorage / worker 无工作量的证据见 F1。

## 开放点

- 未来若要求 native 也进命名空间（对称三前缀），需给 root 页也注入空前缀 shim——当前为兼容既有数据不做。
- `dsh.workspace.view.v5` 分键后各 world 的分组/排序视图相互独立，属预期行为变化（此前互相覆盖本是缺陷）。
