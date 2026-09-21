# AW 子路径挂载可行性 — 取证结论（2026-09-16）

> 目的：把「ctx0 单一入口下按子路径挂载 world UI」彻底查清，逐条给出上游 file:line 证据；判明「零上游改动能做到什么程度、必须改上游的到底是几处」。
> 基准：`upstream/deepseek-harness` @ `dsh-v0.1.5-rc.2`（物理 checkout）。以下所有引用均指该 checkout 内路径。

---

## F1 — 不存在任何中心化 base / sub-path 旋钮（穷举定案）

逐个相关包的 Config schema 全文取证：

| 包 | Config 字段 | 证据 |
|---|---|---|
| `host/webserver` | `host`, `port`, `compression`, `compressionLevel`, `compressionThresholdBytes` | `packages/host/webserver/src/index.ts:125-131`〔2026-09-17 评审核正：初版误记 `:121-128`；此为 static Config 的 zod 行，interface 同形在其上〕 |
| `host/frontend-static` | `distIndex`（仅此一个） | `packages/host/frontend-static/src/index.ts:30-36` |
| `client/connection`（node 半） | `trustedHosts`, `cookieMaxAgeDays`, `maxRequestBodyBytes`, `recovery` | `packages/client/connection/src/index.ts:105-112` |
| `api/gateway` | `websocketHeartbeatIntervalMs` | `packages/api/gateway/src/index.ts:119-126` |

全仓 grep `basePath|baseUrl|apiBase|urlPrefix|mountPath|subPath|prefix:` 在 node 侧 config 中**零命中**（命中项全是文件 URL 的局部变量）。

路径本身是**源码常量**：

- `API_PATH = '/api'` — `packages/client/connection/src/api-path.ts:7`
- `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'` — `packages/api/gateway/src/stream-protocol.ts:6`

客户端 base 只有 `location.origin`，无 `document.baseURI` 分支：

- `packages/client/connection/src/client/rpc.ts:44`（URL 拼接）与 `:108-110`（`resolveBase()`）
- `packages/api/gateway/src/client/stream-client.ts:143`（`new WebSocket(remoteStreamUrl())`）与 `:304-308`（`remoteStreamUrl()`）

⇒ **结论**：任何「一个 origin 挂多个世界」的方案，上游没有现成开关；`<base href>` 也**无法**改变 API/mux 请求（路径是根绝对，`new URL('/api/x', 任意 base)` 恒为 `origin/api/x`）。

---

## F2 — 路由层已具备挂载能力（零上游改动即可拥有 `/omp`）

`packages/host/webserver/src/index.ts`：

- `register({kind, path, handler})`：`exact`/`prefix` 两张表；**重复 (kind, path) 直接 throw**（`:156-175`，注释：route patterns are a composition-level contract）
- `match(pathname)`：exact 优先；prefix 中 **最长前缀胜**（`:318-327`）
- `registerUpgrade({path, handler})`：**exact path** 独立表，重复 throw（`:180-187`）
- `registerFallback(handler)`：**单一 owner**（SPA dist 席位，第二次注册 throw）（`:189-201`）
- `tapIndex(transform)`：原始 html→html 变换，注册顺序执行，**在结构化注入行之后**（`:211-217`）
- `webserver/index-inject` 事件：每行 index 渲染都 emit 一次，订阅者 push 自己的行（`:22-35, 341-350`）

⇒ 我们的插件可安全拥有：prefix `/omp`（`/omp` 与 `/omp/<anything>`）、upgrade `/omp/api/remote.mux`；与上游 `/api`（connection）、`/plugins`（client-modules）、fallback（frontend-static）**互不冲突**。

---

## F3 — 注入机制可在 app boot 前安装 `__DSH_TRANSPORT__`（「怎么落」的正规路径）

`packages/host/webserver/src/injections.ts`：

- 行变体：`{kind:'global', name, value}`（JSON 值，排在其后所有 script 行之前）、`{kind:'script', placement, text}`（内联 classic）、`{kind:'script-src', placement, src}`（外链 classic，**parser-blocking**）、`{kind:'script-preload'}`、`{kind:'style'}`、`{kind:'html', placement, html}`（`:14-31`〔2026-09-17 核正：html 变体在 `:31`，初版区间止于 `:28`〕）
- placement 只有 `head|body`；渲染时 head 行被 splice 到 `<head>` 开标签**之后**，注释原文：*prepending keeps the rows ahead of every document script*（`:96-118`）

被服务页的 boot 脚本在 dist 里是**静态 head 标签**（`apps/web/dist/index.html`），因此注入的 head 行**必然先于** app 入口模块执行。

`__DSH_TRANSPORT__` 是官方 seam（`ClientTransportHooks`，`packages/client/connection/src/client/index.ts:80-90`）：

```
fetch: RpcFetch            // unary（typert gateway）
openStream?: RpcStreamOpen // 流载体；缺省 = 页面用 Gateway 自带 WebSocket
loadBundle? / ownsHost?
```
读取点：`client/connection/src/client/index.ts:186-188`（`createWebConnectionRpc(transport?.fetch, transport?.openStream)`）；`open()` 确实走注入的 `openStream`（`client/rpc.ts:62-68`）。

**上游自用先例（同一个仓里）**：

1. `apps/desktop-host/src/index.ts:186-205` — 桌面宿主**自己**读 dist `index.html`、`ctx.emit('webserver/index-inject', rows)` 收集该 ctx 的行、`renderIndexInjections(...)` 渲染，并把 `DESKTOP_TRANSPORT_SCRIPT`（`:99-115`，内含自定义 `openStream`，走它自己的 `/.dsh/remote-stream`）作为 **head script 行**注入；`/plugins/` 直接交给 `ctx.clientModules.fetchBundle(request)`。
2. `packages/experimental/webworker-runtime/src/client/index.ts:152` — 客户端插件自装 transport。

⇒ 在自己拥有的页面上、用 head 注入行安装 `__DSH_TRANSPORT__`，是上游自用做法，**不是 hack**；且能保证抢在 connection client 激活之前。

---

## F4 — mount 需要改写的绝对 URL 清单（穷举）

**客户端代码产出 `/api`（5 处 / 4 文件）**

- `packages/api/gateway/src/client/index.ts:227`（`connection.rpc.open?.('/api', …)`）、`:443`（`connection.rpc.call('/api', …)`）
- `packages/api/gateway/src/client/remote-events.ts:215`（`'/api'`）
- `packages/client/connection/src/client/rpc.ts:44`（`new URL(\`${channel}/${endpoint}\`, origin)`）+ guard `:64`（`channel !== '/api'` throw）
- `packages/api/gateway/src/client/stream-client.ts:143`（mux WebSocket，URL 由 `:304-308` 拼）

**插件客户端半自己拼 URL（第三个来源，不可穷举）**

- `packages/session-query/session-log-export/src/client/controller.ts:48-51`（`hostBase()` = `location.origin`）与 `:115`（`new URL('/api/session.export', hostBase())`），走其构造注入的 `this.fetcher`

**服务端生成的绝对 `/plugins/...`（在 boot graph JSON 里）**

- `comboUrl()` = `/plugins/??<id>/client.js&rev=<rev>` — `packages/client/modules/src/index.ts:237-242`
- 每行 graph row：`{ id, url: comboUrl([id], rev), rev, … }` — `:402-411`；单包形式 `/plugins/<id>/client.js` — `:293`
- 由 `bootInjections(graph)` 作为 index 行注入 — `:474-…, 578-580`

**相对（无需改，靠 `<base>` 决定解析）**

- `apps/web/dist/index.html`：`./assets/index-*.js`、`./assets/vendor-*.js`、`./assets/*.css`、`./manifest.webmanifest`、`./favicon.svg`（注释亦见 `packages/host/frontend-static/src/index.ts:114-117`：dist 用相对 base 构建）

**其它 `/plugins` 名下通道**

- HMR `EventSource`：`packages/client/hmr/src/client/index.ts:166`

⇒ 子路径 mount 的改写面 = `<base>`（资源）+ boot graph 的 `/plugins` URL + `/api`（unary）+ `/api/remote.mux`（流）；且**第三方插件客户端半可直接拼绝对 URL**，改写面无法靠「transport 一处」收敛。
> 〔2026-09-17 评注〕本清单穷举的是 **pin 死的上游代码**（可验证面），不是对运行时注册的枚举——机制层以 F13 的构造性规则为准（四 primitive 重挂 + HTML pass），本清单仅作回归对照用。
---

## F5 — `/plugins` 的命名空间本身就是包名（回答「`/plugins/omp` 行不行」）

- 路由只有一条 `{kind:'prefix', path:'/plugins'}` — `packages/client/modules/src/index.ts:572`
- 路径第二段是 **entry id = 包名**：`clientPath(id)` 文档原文 *entry id (package name)*（`:596-598`）；scoped 包会自然带斜杠（`/plugins/@scope/name/client.js`）
- 组合 URL 形如 `/plugins/??<pkg>/client.js,<pkg2>/client.js&rev=<rev>`（`:237-242`）

⇒ **多个世界的客户端 UI 若都以 client plugin 包（id = 包名）组合进同一 ctx，天然不冲突**，`/plugins` 一条路由全服务。真正**没有**被命名空间化的只有两样：**RPC channel / endpoint 名** 与 **`/` 上那个 app shell（dist/index.html）**。

⇒ 用 `/plugins/omp` 当世界前缀技术上可行（id 可以是 `omp`），但那是在**借用给包名的命名空间**；更贴合上游设计的是让世界 UI 以 `@pgmi-builds/agent-ui-<runtime>` 这类包 id 进入 graph。

---

## F6 — 若要做「中心化旋钮」，上游最小改动点及其边界

1. `packages/host/frontend-static/src/index.ts:122` — `<base href="/">` 硬编码 → 配置化（唯一「一行」的地方）
2. `packages/client/connection/src/client/rpc.ts:108-110` — `resolveBase()` 认 `document.baseURI` / boot 字段
3. `packages/api/gateway/src/client/stream-client.ts:304-308` — 同一 base
4. `API_PATH` / `REMOTE_STREAM_MUX_PATH` 常量 + connection 的路由注册/guard（`:190, :293`）→ 接受前缀

**边界**：即使 1-4 全改完，**插件客户端半自己拼的绝对 URL（如 `session.export` 的 `hostBase()`）仍需上游逐个改**——「只改一处」在子路径方案里**不成立**。

---

## 结论

| 方案 | 上游改动 | 本线工作量 | 改写面 |
|---|---|---|---|
| **A. 世界 UI 以 client plugin 包进入同一 ctx**（贴上游设计；multi-agent-ctx 老路） | **0** | roster 组合/卸载行 | 无子路径 → 无 |
| **B. 每个世界整站挂 `/<label>/`**（mount，desktop-host 模式） | **0** | prefix 路由 + upgrade 路由 + dist 静态服务 + index 渲染（base/ graph 前缀/ transport 注入）+ 世界 clientModules/api/mux 桥接 | F4 全部项；新增插件客户端半可能再漏 |
| **C. 上游加中心化 base 旋钮** | 1 处（frontend-static）+ 客户端 2 处 + 常量/路由 4 处，且**无法收敛到一处** | 小 | 上游全包 |

**关键事实**：B 是可行的、且**不需要改上游**——`apps/desktop-host` 已在本仓演示了全部构件（自读 dist、自渲染注入、head 行装 transport、`/plugins` 走 `clientModules.fetchBundle`、自定义流路径）。B 的代价不在上游，而在**改写面的完整性与后续插件客户端半的漏出风险**。

> 〔2026-09-17 评注〕本表为 F6 时点结论；F7（A-isolate）与 F13（注册点翻译）之后，B 的落地形态 = 每世界一个**虚拟 webServer**（`apps/agent-worlds/agent-hub/src/world-web-server.ts`），详见文末「落地对照」。

---

## F7 — 能否「extends and delegates」webServer 服务（Cordis 机制取证）

**Cordis 原生支持两层机制，且上游导出面允许子类化**（`@deepseek-ai/dsh-host-webserver`，`export class WebServer extends Service` + `export default WebServer`；`:124`；exports `.` → `lib/index.js`，另有 `./src/*`）：

1. **同 scope 重复 provide 直接抛**：`reflect.provide` 文档原文 *Throws if the name is already provided in this scope*（`vendor/cordis/src/reflect.ts:32-46`；本仓实测同款报错见 `dshHomePath`）。
2. **合法遮蔽 = `ctx.isolate('webServer')`**（`vendor/cordis/src/context.ts:121-124`）：子 ctx 中该名解析到新 label，文档原文 *a different implementation can be provided without affecting the parent scope*；传同一 label 可合并 scope。可见性由 `Service[symbols.filter]` 决定（`vendor/cordis/src/service.ts:59-61`）——**反向含义：父 scope 的既有插件仍解析到原实例，遮蔽不会让它们改道**。
2. **合法遮蔽 = `ctx.isolate('webServer')`**（`vendor/cordis/src/context.ts:121-124`）：子 ctx 中该名解析到新 label，文档原文 *a different implementation can be provided without affecting the parent scope*；传同一 label 可合并 scope。可见性由 `Service[symbols.filter]` 决定（`vendor/cordis/src/service.ts:61-63`〔2026-09-17 核正：初版误记 `:59-61`〕）——**反向含义：父 scope 的既有插件仍解析到原实例，遮蔽不会让它们改道**。
3. **实例级「继承即委托」= `instance[Service.extend](props)`**（`vendor/cordis/src/service.ts:65-73`，`self = Object.create(this)` 在 `:70`；*helper deriving an extended service instance* 引文在 `:20`〔2026-09-17 核正：初版误记 `:72-81`〕）：`Object.create(this)` + `Object.assign`，原型链直接挂在**活实例**上；覆写目标方法、其余状态读穿原实例。**实现陷阱（2026-09-17 评审）**：`Object.create(this)` 继承的是**引用**——派生实例若不先以 own property 影子化自有表，直接调继承的 `register()` 会 mutate 父实例的路由 Map。

**webServer 的可拦截面（逐项取证）**：

| 目标 | 可覆写 | 证据 |
|---|---|---|
| `register` / `registerUpgrade` | ✅ 公有方法 | `:156-187` |
| HTTP 匹配 | ✅ `handle` 闭包内是 `this.match(rawPath)` **动态分派**（`private` 仅 TS 层） | `:225`（调用点）、`:318`（定义）〔2026-09-17 核正：初版误记 `:226`〕 |
| index 渲染 | ✅ `applyIndexTaps` / `collectIndexInjections` / `renderIndex` 均公有 | `:335-357` |
| 端口/压缩/监听/关闭 | ✅ 继承 `[Service.init]` | `:220-...` |
| **WS upgrade 匹配** | ❌ **不走方法**：`this.upgrades.get(pathname)` 直读私有 Map | `:271` |
| **WS upgrade 匹配** | ❌ **不走方法**：`this.upgrades.get(pathname)` 直读私有 Map | `:270`〔2026-09-17 核正：初版误记 `:271`〕 |

**结论（三种形态，对应 mount 目标）**：

- **C-additive（不需 extends）**：在现有实例上直接 `register({kind:'prefix', path:'/omp'})` + `registerUpgrade({path:'/omp/api/remote.mux'})`（F2 已证）。够用于「world 独立进程/端口，ctx0 只做前缀转发」。
- **B-row 替换 + 子类**：disable 上游 webserver 行、insert 我们的 `class MountWebServer extends WebServer`；同一 provider，无需 isolate；可全局拦 register/match。**代价**：upgrade 表须自行接管（否则 WS 匹配仍走父类私有表）。
- **A-isolate + 派生实例**：为每个世界提供**虚拟 webServer**（自己的路由表 / fallback / injection 表），世界插件注册进虚拟表，socket 与端口仍归 ctx0；ctx0 在真实例上挂 `/<label>` 转发进虚拟实例。虚拟实例需自带 match+fallback+upgrade 查找（父类私有，约 30 行）。这是「同 pid、同 origin、一世界一 app」的正解，也是 isolate 的真正用途。

---

## F8 — transport 注入的真实覆盖面（消费点计数）与两层路由边界

`ClientTransportHooks` 成员的全部消费点（全仓，非 test）：

- `fetch` + `openStream`：**仅** `packages/client/connection/src/client/index.ts:188`（`createWebConnectionRpc(transport?.fetch, transport?.openStream)`）→ 客户端只有 `api/gateway` 在用（`client/index.ts:227,443`、`remote-events.ts:214`，共 3 处）。
- `loadBundle`：**仅** `packages/client/web/src/boot.ts:71` → 模块加载器 `packages/client/modules/src/client/system.ts:85,130`（按 graph 行 `initialUrl`/`reloadUrl` 拉取；2026-09-17 评审核正：初版误置于 `client/web` 包，该包无 `system.ts`）⇒ 它**能接住 `/plugins/...` 的 graph 拉取**。
- `ownsHost`：`client/connection/src/client/index.ts:227`（仅一个标志位）。

⇒ **只有 2 个原生组件消费这套 hooks**（connection / web-boot）。

**不被覆盖的客户端通道**（transport 注入够不到）：HMR `EventSource`（`client/hmr/src/client/index.ts:166`）、file-upload Worker（`client/file-upload/src/client/runtime.ts:255`）、pdf Worker（`ui-sidebar-documentpreview/src/client/pdf/runtime.ts:76`）、插件客户端半自拼绝对 URL（`session-log-export/src/client/controller.ts:48-51,115` 的 `hostBase()`）、以及独立的 `__DSH_FILE_UPLOAD__` global。
**不被覆盖的客户端通道**（transport 注入够不到）：HMR `EventSource`（`client/hmr/src/client/index.ts:166`）、file-upload Worker（`client/file-upload/src/client/runtime.ts:255`）、pdf Worker（`client/ui-sidebar-documentpreview/src/client/pdf/runtime.ts:76`；2026-09-17 核正：初版路径漏 `client/` 包段）、插件客户端半自拼绝对 URL（`session-log-export/src/client/controller.ts:48-51,115` 的 `hostBase()`）、以及独立的 `__DSH_FILE_UPLOAD__` global。
**两层路由边界**：

- gateway wrapper 包的是 **typertGateway 实例**（`dispatchRpc` / `openWireStream`；本仓 `apps/agent-worlds/agent-hub/src/gateway.ts` 头部注释 + `ctx.inject(['typertGateway'], …)`），位置在 HTTP 路由匹配**下游**——只见 RPC endpoint 与 wire stream。
- `/<label>` 是**页面/资源**路径，走 `webServer.match()`（prefix/exact → handler，否则 fallback），**从不进入 RPC 分发**。

⇒ `/api/*` 与 mux 可由 gateway 拦；`/omp`、`/codex` 必须由**路由表所有者**处理。

---

## F9 — `/plugins` 之下能否再抢更长前缀（`/plugins/hub/*`）

可以，且零上游改动：`match()` 是**最长前缀胜**（`webserver/src/index.ts:318-327`），注册 `{kind:'prefix', path:'/plugins/hub'}` 即整段优先于 `/plugins`；`register` 仅在 `(kind, path)` **完全相同**时 throw（`:156-175`）。上游 `/plugins` 处理器按预计算响应表的 `pathname+search` 查找，未命中一律 404（`client/modules/src/index.ts:1008-1025`），不会来抢 `/plugins/hub/*`。

**注册方式与上游同款（additive，无需 extends/isolate）** — 上游原文（`client/modules/src/index.ts:570-576`）：

```ts
const registerWebCarrier = (webCtx: Context): void => {
  webCtx.effect(
    () => webCtx.webServer.register({ kind: 'prefix', path: '/plugins', handler: this.serveBundle }),
    'client-modules: bundle route',
  )
}
if (ctx.get('webServer') === undefined) ctx.inject(['webServer'], registerWebCarrier)
else registerWebCarrier(ctx)
```

本线同形写法：`ctx.inject(['webServer'], webCtx => webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: '/hub', handler }), 'agent-hub: hub route'))`。

---

## F10 — 客户端断点的公共变量问题（`location.origin` 可否被覆盖）

**没有共享变量**：同一内联写法有**三份独立拷贝**，都在调用点现取全局——

- `packages/client/connection/src/client/rpc.ts:108-110`（`resolveBase()`）
- `packages/api/gateway/src/client/stream-client.ts:305-306`（`remoteStreamUrl()`）
- `packages/session-query/session-log-export/src/client/controller.ts:48-51`（`hostBase()`）

**`location` 是浏览器 API 且不可覆盖**：`Window.location` 在 WebIDL 里是 `[LegacyUnforgeable]`，`Object.defineProperty(globalThis,'location',…)` 抛错、`globalThis.location = x` 被忽略；三处调用点又都是**晚绑定**（全仓无 `fetch`/`WebSocket` 的提前捕获）⇒ 没有模块内局部变量可改。

**结构事实**：iframe 也救不了——同 origin，`location.origin` 不变；只有**换端口/主机**才改 origin（这正是当前「一世界一端口」零改动就能跑的原因）。

**唯一的客户端单点 = 提前注入的 primitive shim（head script）**：

| shim | 覆盖 |
|---|---|
| `globalThis.fetch` | unary RPC + 一切走 plain fetch 的插件客户端半 |
| `globalThis.WebSocket` | mux（`stream-client.ts:143`） |
| `globalThis.EventSource` | HMR（`client/hmr/src/client/index.ts:166`） |
| `globalThis.Worker` | 两个 worker 的**构造 URL**（worker 内部 fetch 需在 worker 作用域再 shim） |
| `XMLHttpRequest` | 防御性覆盖（**非必须**；2026-09-17 评注）：仓内唯一 XHR 用户 file-upload 已由 `__DSH_FILE_UPLOAD__` 官方 seam 兜底（见下），XHR shim 只为第三方 XHR 代码兜底。file-upload 走 XHR（`client/file-upload/src/client/runtime.ts:80` `createXhr: () => new XMLHttpRequest()`），目标 `FILE_UPLOAD_PATH = '/api/session/uploadFileBinary'`（`client/file-upload/src/protocol.ts:2`） |

**第二个正规可注入 global**：`__DSH_FILE_UPLOAD__`（`runtime.ts:167-171` 在服务构造时读；有 `hook.fetch` 则 `customTransport(hook.fetch)`，否则 worker+XHR）⇒ 上传面无需 shim。

⇒ 客户端断点总计 = **2 个正规 seam**（`__DSH_TRANSPORT__`、`__DSH_FILE_UPLOAD__`）+ **1 个 primitive shim**（fetch/WebSocket/EventSource/Worker/XHR），全部可在同一个 head script 里装完。

---

## F11 — 单 WebServer 实例的硬约束（对「additive 拿前缀」方案的边界）

- **`/api` 前缀路由只能有一条**（`register` 对相同 `(kind, path)` 直接 throw，`webserver/src/index.ts:156-175`）⇒ 进程内世界**不能**拥有自己的 `/api`，必须挂在 label 下由我们的 handler 服务（自实现 envelope 或代理到世界端口）。**〔2026-09-17：本条约束已被 F13 虚拟实例的注册点翻译化解——世界的 `/api` 注册落为 `/<label>/api`，两世界各持 `/api` 不再冲突〕**
- **upgrade 路由是 exact path**（`:180-187`）⇒ mux 只能逐世界注册（`/<label>/api/remote.mux`），没有前缀 upgrade。
- **代理不改 HTML**（服务端单独一件事，与客户端 shim 分开）：世界自己的 frontend-static 会注入 `<base href="/">`（`frontend-static/src/index.ts:122`），其相对资源将解析到 ctx0 根而非挂载点 ⇒ handler 必须在 HTML 上做一次替换（base + graph 的 `/plugins` URL）。

---

## F12 — 桥接的可行性（mux 与 unary 各自的真实成本）

**mux：几乎是免费的**——上游的服务端 mux 类本身就是**可注入 dispatch** 的：

```ts
// packages/api/gateway/src/index.ts:206-215
const mux = new RemoteStreamMuxServer(
  (endpoint, payload, signal) => this.openWireStream(endpoint, payload, signal),
  this.wireStream.failure,
  resolved.websocketHeartbeatIntervalMs,
)
// 路由 handler 内：
const rejection = webCtx.connection.requestRejection(req)
if (rejection !== undefined) { rejectRemoteStreamUpgrade(socket, rejection); return }
mux.handleUpgrade(req, socket, head)
```

构造函数签名（`stream-server.ts:34-38`）：`(open: RemoteStreamOpener, failure: RemoteStreamFailureMapper, heartbeatIntervalMs)`；`RemoteStreamOpener = (endpoint,payload,signal) => Promise<AsyncIterable<unknown>>`（`:11-16`）。

⇒ 我们只需把 `open` 指向 **ctx1 的 gateway 实例**（我们已持有的 `GatewayFace.openWireStream`，见 `apps/agent-worlds/agent-hub/src/targets.ts` / `gateway.ts`），其余（WebSocket 接受、逻辑流表、心跳 ping/pong、取消）全部复用。

**两个机械代价（必须知道）**：

1. `RemoteStreamMuxServer` / `rejectRemoteStreamUpgrade` 只在 `index.ts:37-38` 被**私有 import**，包根**没有重导出**（`lib/types/index.d.ts` 无导出；`files` 只发 `lib/`）⇒ 三条取用途径：(a) 走 `./src/*` 导出 `@deepseek-ai/dsh-api-gateway/src/stream-server.ts`——**仅 tsx/vitest 下可用**：`./src/*` 解析到 `.ts` 源文件，运行时 node 无法 import（AW-B 落地 `world-mux.ts` 时实证，故实际选了 (c)；2026-09-17 评注补正初版「dev checkout 可用」的误导）；(b) 上游加一行重导出；(c) 我们自写 mux（wire-compatible，约 100 行，协议形状已知）。
2. `failure` 参数是 `RemoteStreamFailureMapper`（`error → RemoteStreamFailure`），上游用的是内部 `wireStream.failure` ⇒ 我们自己提供映射。

**unary：两条路，成本差一个数量级**——

- **自实现 envelope（约 50 行）**：解析 `{type:'client-request', rpcId, method, payload}` → `worldGateway.dispatchRpc(method, payload, signal)` → 回 `{type:'server-response', rpcId, result:{ok,value}|{ok:false,error}}`（形状见 `client/connection/src/rpc-host.ts:47,282`；zod schema 在 `client/connection/src/rpc-schema.ts:36,44`，均未导出）。
- **自实现 envelope（约 50 行）**：解析 `{type:'client-request', rpcId, method, payload}` → `worldGateway.dispatchRpc(method, payload, signal)` → 回 `{type:'server-response', rpcId, result:{ok,value}|{ok:false,error}}`（形状见 `client/connection/src/rpc-host.ts:47,282`；zod schema `clientRequestSchema`/`serverResponseSchema` 定义于 `client/connection/src/rpc-schema.ts:36,44`，**且经包根重导出**——`client/connection/src/index.ts:36-43`，`.` 入口可直接 import〔2026-09-17 评审核正：初版误记「均未导出」；此修正使 envelope 解析可复用上游 schema，无需手抄形状〕）。
- **零新代码**：让客户端把 label 写进 **endpoint 串**（`/api/<label>/<endpoint>`）——ctx0 的 `/api` prefix 本来就匹配，label 随 endpoint 进入我们的 gateway wrapper，按 label 路由即可。代价仅是 URL 形态（label 在 `/api` 之后）。〔2026-09-17 评注：未采用——已被 F13 的统一重挂规则（`/api` → `/<label>/api` + 注册点翻译）取代，避免两套客户端 URL 策略并存。〕
**ctx1 的 web 面两条形态**：(i) ctx1 保留真实 webserver + 端口（我们的 prefix handler 可代理，或直接按 (a) 桥接）；(ii) ctx1 用**虚拟 webserver**（F7 的 A-isolate + 派生实例）把路由注册进我们拥有的表 ⇒ 零端口，我们的 carrier 直接从表里服务。

**进程内桥接的额外好处**：不经过 HTTP ⇒ **不需要搬运世界自己的 cookie**（ADR 0007 的 cookie-jar 问题只存在于跨进程代理形态）；auth 仍在我们的路由上用 `connection.requestRejection(req)` 做（ctx0 的 cookie）。

---

## F13 — 修正：命名空间清单是错的，正确机制是「注册点翻译」

**两处已证伪的先前错误**：

1. **枚举 `/api`、`/plugins` 是错的**：任何插件都能注册任意前缀（我们的 WebCarrier 就是例证）。固定清单必然漏掉第三方插件的自定义前缀。
2. **假设 ctx1 会跑 DSH 原生 client-modules/`/plugins` 没有根据**：ctx1 的组合就是**我们的源码**——`apps/agent-worlds/agent-omp/cordis.patch.yml`（OMP bundle patch：mount omp-provider、禁 native agent-loop/llm/presets/title、directory-picker、permission）+ world profile patch。ctx1 里有没有 client-modules 由我们决定。

**正确机制 = 每个世界一个虚拟 webServer，在「注册那一刻」做路径翻译**（不是匹配时枚举）：

- ctx1 插件照常注册任意路径（`/api`、`/plugins`、`/whatever`）。
- `WorldWebServer.register({kind, path, handler})` → 真实例 `register({kind, path: label + path, handler: stripLabel(req) → handler(req, res)})`。
- `registerUpgrade({path, handler})` → 真实例 exact `label + path`（handler 前同样 strip；upgrade 无前缀语义，逐条翻译）。
- `registerFallback(h)` → 真实例 prefix `/<label>`，handler 先 `req.url` 去 label 再调 `h`（fallback 处理器按世界相对路径查 dist，必须 strip）。

**由此得到的性质（这是「通用性」的答案）**：

- 任意前缀自动落在 `/<label>/…` 之下，ctx0 永远只见 `/<label>` 一个命名空间；
- 两个世界可各自拥有 `/api`（翻译后为 `/<labelA>/api` 与 `/<labelB>/api`）——**F11 中「`/api` 前缀路由只能有一条」的约束被虚拟实例化解**；
- 新插件声明任何自定义前缀都无需改我们任何代码。

**前置条件（本仓早已记录为 AW-B 欠账）**：ctx1 不能同时存在真实 webserver（两个 provider / 两个 listener）⇒ 即零监听手术。原文见 `apps/agent-worlds/agent-hub/test/fixtures/aw-omp-world/cordis.patch.yml:4-6`：*"True zero-listener surgery (disable webserver/web-runtime + webRuntime shim) is a recorded AW-B follow-up: audit finding 2026-09-15 — disabling them cascades 9 pending entries (connection/fileUploads chains)."* ⇒ 虚拟 webServer 方案 = 做掉 AW-B 并补齐那 9 条 pending 依赖。

**客户端同样去枚举化**：规则改为「同源**根绝对**路径一律重挂到 `/<label>/`」，作用于 fetch / WebSocket / EventSource / XMLHttpRequest 四个 primitive + HTML pass（`<base>` 与注入 JSON 内根绝对 URL 通用重写）。覆盖边界是**构造性**的：只要插件经由 webServer 提供 HTTP（本组合唯一入口）且在客户端使用这四个 primitive，就必被覆盖。

---

## F14 — ctx0 内的前缀冲突（别的插件也声明 `/hub`、`/omp`）怎么办

**事实取证**：

- webServer **没有任何查询 API**（公有面只有 `register` / `registerUpgrade` / `registerFallback` / `tapIndex` / `applyIndexTaps` / `collectIndexInjections` / `renderIndex` / `port` / `host`；路由表全 private，`webserver/src/index.ts:133-141, 165-217`）⇒ **无法预问「某路径是否被占」**，唯一信号是重复注册时的同步 throw：`webserver: duplicate ${kind} route "${path}"`（`:168`）、`duplicate upgrade route`（`:182`）。
- 冲突判定是 **`(kind, path)` 完全相同**（`:165-175`），而匹配是**最长前缀胜**（`:318-327`）⇒ 第三方占 `/hub` 与我们的 `/hub/omp` **不冲突**（更长的前缀在其子树内胜出）；冲突只发生在**同一个字符串**上。
- 上游自己的立场（`webserver/src/index.ts:120-124` 注释）：*route patterns are a composition-level contract, so a collision is a misconfiguration*。

**策略（把 N 个标签收敛成 1 个保留根）**：

1. **保留一个根**：世界一律挂在单一保留前缀之下（如 `/_agents/<label>/…`），由我们的插件**在组合层声明并抢占一次**（ctx0 的 patch 也是我们的源码：`.superd-test/aw/profiles/aw-ctx0/cordis.patch.yml`）。第三方插件照旧可以自由声明 `/whatever`——与我们无关。
2. **冲突必须响**：注册前 `try { register(reservedRoot) } catch { 失败并给出可执行的错误信息 }`（或按配置列表 re-home 到备选根）。因为注册是同步 throw，检测可靠。
3. **可选零崩溃变体**：改抢 **fallback 席位**（框架保证单 owner，第二次 `registerFallback` throw，`:196-201`），世界标签在 fallback 内动态解析；但**仍要额外注册一条保留根的 prefix「claim」**，否则第三方声明同名前缀会**静默遮蔽**我们（claim 让冲突回到「响亮失败」）。
4. **要彻底免疫**，只有上游加一个小 API：`has(path)` / `reserve(prefix)`（1-2 行）——这是干净的上游请求；但在那之前，策略 1+2 已把问题从 N 收敛到 1。

**结论**：路径命名空间冲突是任何「同 origin 多应用复用」方案的固有问题（nginx `location`、Express mount、socket.io namespace 同理），不能被任何设计消除；能做的是**收敛成一个保留根 + 组合期响亮失败 + 可配置 re-home**。
---

## F15 — 同源 auth cookie 席位（虚拟 webServer 形态的旁路面；2026-09-17 评审补充）

- cookie 名 = `dsh-auth-<authority>`（`COOKIE_PREFIX` 与 `cookieName(authority)`，`packages/client/connection/src/browser-auth.ts:16,69,106`），authority 由请求主机派生 ⇒ **同 origin 下 ctx0 与世界的 connection 半指向同一个 cookie 席位**；若两半都可达浏览器，会互相覆盖。
- 化解（AW-B 已落地）：世界的 `/api`、`/api/*` 注册被 `WorldWebServer.hubOwned()` 吞掉（no-op disposer），`/<label>/api/*` 由 hub carrier 以 **ctx0 的 auth 域**应答（`apps/agent-worlds/agent-hub/src/world-web-server.ts` 的 `gate()`/`authorize` 与 `world-mount.ts`）；世界的 browser-auth 永远见不到浏览器。**红线**：后续任何改动不得让世界的 connection 半直接面向浏览器。

---

## 落地对照（2026-09-17 评注）

| Finding | 落地 |
|---|---|
| F2/F9 路由原语 | `agent-hub/src/world-web-server.ts`（注册点翻译 + strip） |
| F3/F10/F13 客户端 shim | `agent-hub/src/client-shim.ts`（fetch/WebSocket/EventSource/XHR + `__DSH_FILE_UPLOAD__`；构造器一律 Proxy 包装保静态常量——AW-B Round 6 教训） |
| F4 HTML pass | `agent-hub/src/index-pass.ts` + `world-web-server.ts` 的 `htmlRewrite`（base 重钉 + roster 后注） |
| F12 mux/unary 桥 | 自写 wire-compatible `world-mux.ts`（选 (c)，原因见 F12 修正）+ `envelope.ts` |
| F13 虚拟 webServer + 零监听 | `world-mount.ts`（`webserver` disabled + `modules` inject webServer + mount row provide） |
| F14 标签表 | `labels.ts`（claim + 响亮冲突 + alternateRoots re-home；保留根 `root` 选项在位，当前配置为顶级 `/<label>`） |
| F15 cookie 席位 | `hubOwned()` 吞注册 + carrier 以 ctx0 auth 域应答（见上） |
| 存储分键（同线程后续） | 见 `2026-09-16-aw-storage-namespace-findings.md`（P1-P3，待执行 → `2026-09-17-aw-storage-namespace-head-shim.md`） |
