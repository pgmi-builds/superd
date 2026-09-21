# DSH Web UI 剥离边界研究:对接任意 Agent Runtime 的可行性评估

> 记录:2026-09-03 · 一手核验:`~/workspaces/dashr/upstream/deepseek-harness`(tag `dsh-v0.1.2-alpha.5`)
> 源码逐包阅读 + 4999 实例实际服务 HTML 抓取(`.scratch/dsh-index.html`,24,954 bytes)+ prod npm
> 工件核验。前置研究:`dsh-web-profile-package-map.md`(220 包测绘)、`dsh-web-ui-slot-system-research.md`
> (slot 机制)、`web-frontend-composability-research.md`(Web 生态对照)。
>
> **研究问题**:把 DSH 的 Web 前端剥离成通用 Web UI,对接其他任何 Agent 运行时——剥离到哪一层
> 最干净?方案一(源码级)vs 方案二(浏览器资产物理层)哪个更落地?

---

## 0. 一句话结论

**"源码级 vs 物理层"是个伪分叉——两条路交付的是同一套浏览器工件(shell dist + 51 个插件
client bundle + boot graph),真正的工作量(≈70%)在两者都不触碰的部分:服务端 wire 面
(HTTP unary RPC + WebSocket 流复用 + 认证 + boot graph 注入)。因此正确的剥离边界不是
"源码 or 资产",而是:**

```
┌─ 浏览器侧(原样保留,零改动)─────────────────────────────────────┐
│  apps/web shell dist + 40 个 ui-* 插件 + client 基建 + boot kernel │
├─ 4 条 wire 契约(需要被"别的 runtime"实现或代理)────────────────┤
│  ① 静态资产(纯文件) ② boot graph 注入 ③ /api unary ④ WS 流复用  │
├─ 服务端适配层(唯一的新代码)───────────────────────────────────┤
│  ~13 个 TypertRemoteService 命名空间的适配实现(可裁剪到 ~4 个)   │
└──────────────────────────────────────────────────────────────────┘
```

**推荐:方案一的收敛形态"1b —— npm 工件组合(UI-BFF)"**。上游 MIT 许可、每个 npm 包自带
预构建 `lib/client.js`、boot graph 由我方服务端生成(资产组合权在手里)、插件 roster 就是字段
披露旋钮。方案二(物理层)的正确形态会**退化为 1b 的采集通道**(从 npm 拿工件比从 CDP 抓更干净);
CDP 的正确角色是**契约侦察与版本 diff 的验证工具**,不是交付路径。

---

## 1. 现状测绘:DSH Web UI 到底由什么组成

### 1.1 交付链(源码实证,非推测)

```
apps/web (vite 壳, @deepseek-ai/dsh-web-frontend)
  └─ index.html + src/main.ts (11 行): new AppWebEntry(#root).run()
      └─ @deepseek-ai/dsh-client-web "Web boot kernel" (packages/client/web, 371 行)
          ├─ seed.ts: 静态模块表 = 仅 8 个平台词
          │   react / react/jsx-runtime / react-dom / react-dom/client /
          │   @deepseek-ai/cordis / dsh-client-store / dsh-client-ui-slots / dsh-client-ui-primitives
          ├─ boot.ts: 等 __DSH_BOOT_READY__ → 读 window.__ModuleLoader__ /
          │   __DSH_BOOT__ / __DSH_TRANSPORT__ → 建模块系统 → 起浏览器侧 cordis
          │   → cordis-plugin-loader 逐个装载 manifest.plugins → ctx.inject(['uiRenderer']) mount
          └─ boot-page.ts: 框架无关 boot 进度页(插件失败可见)
```

每个 UI 插件是**双半包**:host 半空 `apply()`(可加载体),browser 半真逻辑(`lib/client.js`,
closure-factory 形,经 `/plugins/<pkg>/client.js&rev=<hash>` 按需物化)。浏览器里
`dsh-cordis-client-runner` 再起一套完整 cordis,40 个 `ui-*` 经 SlotRegistry 组合成整棵 React 树
(整树唯一入口 `renderSlot('root')`)。**React 只是"当前安装的渲染器",插槽/状态层框架中立。**

### 1.2 实际服务的物理页(4999 实例抓取)

24,954 bytes,结构惊人地薄:

| 分段 | 内容 | 大小 |
|---|---|---|
| `<base href="/">` + queue script | `window.__ModuleLoader__` 引导门面(inline) | ~1.5 KB |
| combo preload | `/plugins/??<47 个插件>/client.js&rev=…`(一次合并拉取) | URL ~4 KB |
| bootstrap script | `/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=…` | 单条 |
| **boot graph** | `globalThis.__DSH_BOOT__ = {rev, entries:[{id,url,rev,inject,immediately}×51]}` | ~15 KB |
| 原生 dist 头 | meta/title/`assets/index-*.js`(413KB)/`vendor-*.js`(723KB)/2 个 css | 原样 |
| body inline | 主题初始化脚本 + `__DSH_BOOT_READY__` resolver + `#root` | ~0.5 KB |

**51 个 client bundle 合计 3.94 MB(未压缩)**,最大头:ui-conversation 606KB、ui-trajectory
382KB、ui-chat 351KB、api-remotes 296KB、cordis-client-runner 228KB。npm 包全部自带预构建
`lib/client.js`(prod vendored 树实证:ui-trajectory 391,199 bytes,与源码树构建产物同量级)。

### 1.3 wire 面:浏览器 ↔ 服务端的全部契约(4 条)

| # | 面 | 协议 | 细节(源码锚点) |
|---|---|---|---|
| ① | 静态资产 | HTTP GET | `/plugins/??a/client.js,b/client.js&rev=…` 合并拉取;rev=内容 hash,immutable cache;非 index 资产**公开**(frontend-static: "Non-index assets stay public") |
| ② | boot graph + 注入 | index 渲染时 inline | `webserver/index-inject` 事件收集结构化行(kind: global/script/script-src/style/html),renderIndexInjections 渲进 index.html;`__DSH_BOOT__` 就是一行 `{kind:'global'}` |
| ③ | unary RPC | HTTP POST `/api/<ns>/<method>` | envelope `{type:'client-request', rpcId, method, payload:{args:[…]}}` → `{type:'server-response', rpcId, result:{ok:true,value}\|{ok:false,error:{code,message,details}}}`(client/connection/src/client/rpc.ts);body 上限 300MB |
| ④ | 流复用 | WebSocket `/api/remote.mux` | gateway 持有 WS mux(REMOTE_STREAM_MUX_PATH,stream-protocol.ts,心跳可配);`session/follow`、`session/control`、workspace 流、转发事件都走它;另有 worker-local 载体可替代 |
| + | 认证 | `?token=` 一次 → HMAC cookie | `dsh-auth-<authority>` 签名 cookie,按 authority 绑定 audience,24h(browser-auth.ts);trustedHosts 栅栏 alpha.5 起服务端配置化 |

**关键事实:没有任何 REST 资源面,也没有隐式 DOM 数据通道。** UI 的全部数据与动作都走 ③④
两条 RPC 面——这就是"另一个 runtime"要实现的全部。

### 1.4 数据模型:SessionEvent 日志(UI 的粮食,也是诊断价值的来源)

append-only、无损 JSON、seq 连续递增(`packages/core/session/src/types.ts`),插件可扩展:

| 事件 | 载荷 | UI 呈现 |
|---|---|---|
| `turn/start` `turn/end` | turn + 结束原因(error/max-tokens/interrupted 结构化) | 回合边界、失败标记 |
| `step/start` `step/end` | turn+step | 每步 = 一次模型调用 + 其工具执行 |
| `user/message` | UserMessage(source 区分人类输入/注入上下文/goal 续轮) | 用户气泡 |
| `assistant/chunk` | 原始 StreamChunk | **token 级回放保真**(打字机效果、chunk runs 打包分页) |
| `assistant/message` | 组装后 AssistantMessage + usage(TokenUsage)+ interrupted 标记 | 助手消息、用量统计 |
| `tool/call` | callId + name + **模型原始 arguments 字符串(未解析)** | 工具卡 |
| `tool/result` | ToolResultMessage + 可选 error{name,code} + 可选 meta(JSON) | 工具结果卡(含 fs diff 等) |
| `request/header` | **EpochHeader = {config, adapterDefaults?, system?, tools?}** | Trajectory 的 **System Prompt 标签页** + 工具清单 + 请求配置;缺失时有显式兜底文案(`record.systemPromptMissing: '本次请求没有系统提示词'`) |
| `request/context` | provider/model/contextWindow | 模型路由元数据 |
| `session/end-seed` | 空 | fork/resume 种子分界 |

**降级是设计内行为**(三条证据):① 未知事件带 `ignorable: true` 语义为"读者可安全跳过";
② `request/header` 缺失 → trajectory 显式渲染"本次请求没有系统提示词"占位;③ 插件缺席 → 槽位
渲染为空(patch 注释原文:"Absent a roster it renders nothing"、"Remove this entry to turn the
surface off; the tail hole renders empty")。**这正是用户看中的"字段缺失不崩溃"容错性的机制层根
据:事件子集可以任意裁剪,UI 按在场字段渲染。**

### 1.5 服务端 RPC 面:~13 个 TypertRemoteService 命名空间

endpoint 命名 = `<namespace>/<method>`,浏览器侧由 `api-remotes` 装配成 `ctx.remote.*`。全仓
`extends TypertRemoteService` 盘点(排除实验性):

| 命名空间 | 方法面(核心) | 服务端 inject 依赖(适配缝) | 必要性 |
|---|---|---|---|
| `session` | list/search/create/rename/fork/**prompt**/attachment/updateQueue/**cancel**/**page**/**follow**(流)/**control**(流)/selectModel/modelCatalog/openWorkspacePath + file-references/skill-catalog 子面 | sessions, sessionProjections, sessionQuery, agents, llm, attachments, workspaceRegistry, agentDefaultModel | **核心:聊天+历史+trajectory 的全部** |
| `workspace` | create/rename/delete/insertBefore/insertSessionBefore/archiveSession + 流 | workspaceRegistry | 侧栏工作区(可 stub) |
| `settings` + `credentials` | describe/get/set 等 7 方法 | settings-domains | 设置页(可 memory-stub;注意 describe mirror 在非 loopback 页 terminally unavailable 的既有缺口) |
| `llm` | listProviders/listConfigurableProviders/discoverModels | llm | 模型选择器(可最小 stub) |
| `presets` | roster | agent-presets | 无 roster → 不渲染 |
| `pluginInventory` | 目录只读投影 | loader entries | 插件页(可缺) |
| `goals` / `feedback` / `commands` / `subagents` / `dynamicCordis`(host-runner) | 各自小面 | 各服务 | 全部可缺(对应 UI 区块静默退化) |

**注意**:适配器不必实现这些 controller 类本身——controller 只是命名空间的"一种实现"。对接
其他 runtime 时直接以任意代码实现 endpoint 语义即可;schemastery 校验发生在 gateway 侧,但
envelope 是自描述 JSON。

### 1.6 组合面:roster = 披露旋钮

浏览器加载哪些插件完全由 boot graph 决定,boot graph 由 host 侧 loader 条目扫描
`dsh.client` 声明而来,而 loader 条目由 `cordis.patch.yml` 层序决定(bundles 列序 → profile →
home → `--patch`)。**因此"减少字段披露"有两级旋钮:**

1. **UI 级**:patch 行 `disabled: true`(如上游自带 `ui-schedule` 就是 disabled 出厂的)——
   去掉 `ui-trajectory` 行 = 整个 trajectory 面消失;去掉 `ui-settings-*` = 设置页消失。
2. **数据级**:适配器不写 `request/header`/`assistant/chunk` 等事件 = 对应标签页/字段静默缺失。

甚至**在物理模式下 UI 扩展性仍然存活**:boot graph 由我方服务端生成,追加自有插件行(自己的
client.js + 槽位注册,lower priority 遮蔽官方组件)即可覆盖任意 UI 细节——dashr/better-sidebar
正是这样随插件发布 UI 的,机制对第三方开放。

---

## 2. 方案一(源码级剥离)评估

### 2.1 原样保留的部分(两条子路径共享)

- `apps/web` 壳 + `packages/client/web`(boot kernel)+ `packages/client/*` 全部 ui-*/基建 +
  `packages/api/remotes`(浏览器半)+ `packages/typert/*` + `cordis-client-runner`。
- 这些包**已经高度自洽**:浏览器侧唯一的外部世界就是 1.3 的 4 条 wire 面。

### 2.2 需要替换/新写的部分

1. **wire 面载体**(若脱离 dsh 宿主):webserver(通用 node:http,无 harness 概念)、
   frontend-static(通用 dist 服务)、auth、client-modules 的 host 半(boot graph 组合器 + /plugins
   文件服务)。**注意 client-modules host 半与 cordis-plugin-loader 条目耦合**——若对接方宿主不跑
   cordis,不装它,自己写一个静态 graph 组合器(本质是"读一份插件清单 JSON + 算 hash + 拼
   entries",≈200 行;4999 实例的 graph 就是实证样板)。
2. **适配层**:1.5 表中裁剪后的命名空间实现(最小集 = `session` 的 8 个方法 + 2 个流 +
   `llm.listProviders` stub + `workspace` 三方法)。

### 2.3 分寸:1a(全源 fork)vs 1b(npm 工件组合)

| 维度 | 1a:源码 fork | 1b:npm 工件组合(UI-BFF) |
|---|---|---|
| 获取 | clone monorepo,跑 pnpm+tsdown+tsdown.client 全工具链 | `npm i @deepseek-ai/dsh-client-ui-*`(每个包自带 lib/client.js)+ `@deepseek-ai/dsh-web-frontend` dist |
| 构建负担 | 269 projects,本机还需 2 个必须 patch(见 AGENTS.md) | **零构建**(shell dist 与 client bundle 都是发布产物) |
| 修改能力 | 任意改 UI 源码 | 不改上游 UI;靠 roster 裁剪 + 自有插件行遮蔽(§1.6) |
| 版本跟踪 | 每次 upstream 变更手动合并 | 改 package.json 版本号重装 |
| cordis 依赖 | 浏览器半自带 cordis(模块表平台词);host 半可全弃 | 同左;宿主侧只需自己选型的 BFF 服务 |
| 法律 | MIT(保留版权声明即可) | MIT 同 |

**判定:1b 是方案一的最优收敛形态。** 1a 只在"必须改上游 UI 组件内部"时才值得,而 slot 遮蔽
机制让绝大多数"改"都能以自有插件行完成。1b 的实质:**把 dsh 剥成一个纯 UI-BFF**——agent
runtime 在外面,BFF 只做 4 条 wire 面 + 适配器。

### 2.4 1b 的一个激进变体(可选,低优先):最小 cordis 宿主

不弃 host 半 cordis,而是跑一个**只挂载体插件的 cordis 宿主**(webserver + frontend-static +
client-modules + connection + gateway 原样复用,SessionController 等以自定义 cordis 插件替换
provider)。好处:wire 面 100% 原样、免复刻 WS mux;代价:引入 cordis loader 心智 + 上游这层
无稳定性承诺。**适合作为 PoC 对照,不建议作长期承诺层。**

---

## 3. 方案二(浏览器资产物理层剥离)评估

### 3.1 用户设想:CDP/DOM 分析 → 抓 HTML/JS/CSS 静态资产

**可行的部分**:资产确实干净可抓——index.html(含 boot graph)+ `/plugins/*` bundle +
`/assets/*`,全部静态文件,combo URL 就是清单。不含 source map 需求(client.js.map 随包发布,
npm 工件里就有)。

**不成立的部分**:抓到资产 ≠ 剥离完成。页面不是静态站,是"从服务端注入的 graph 引导的运行
时":没有 ③④ 两条 RPC 面,壳渲染到 boot 失败页(`web boot: … did not activate` /
auth 拒绝)。**物理层绕不开的工作量与方案一完全相同(服务端 wire 面 + 适配器)——而那才是
70% 的工作。** 换言之,方案二节省的只有"获取/构建资产"这一步,而这一步在 1b 里本来就已经
是零成本(npm 拉包)。

### 3.2 修正后的定位

| 用途 | 评价 |
|---|---|
| **交付路径**(物理剥离 UI 给别的 runtime) | ❌ 不推荐:与 1b 工作量相同但更糟——从实例抓的资产无版本锚(rev hash 换版即漂)、无 license 文件伴随、无 source map 归档、组合关系靠逆向 |
| **采集通道**(拿资产本身) | ✅ 但正确姿势是从 **npm 工件**采集(=1b),不是从 CDP;CDP 抓取仅在"验证某实例实际服务的组合"时有用 |
| **契约侦察**(经验性摸 wire 面) | ✅ 有价值:Network 面板可直接观察 envelope/流帧/认证流,是源码分析的交叉验证;本轮源码结论与之吻合 |
| **版本 diff**(upstream 升级影响面) | ✅ 有价值:两版实例各抓一份 boot graph,entries/inject 差分即 UI 组合变更面 |

**判定:方案二不是独立方案,是方案一(1b)的一个采集/验证通道。** 用户设想的"如果源码太复杂
就绕开源码"——实际源码复杂度 concentrated 在我们**本来就要丢掉的部分**(agent/session 核心),
浏览器侧源反而极薄(boot kernel 371 行 + 每插件独立小包),"必须绕开源码"的前提不成立。

---

## 4. 对接任意 runtime:具体路径与工作量

### 4.1 适配器要实现的 endpoint(最小可用集,建议 PoC 范围)

```
session/list     → 会话列表(标题、mtime、cwd、origin 等 SessionSummary 字段,可稀疏)
session/create   → 新会话(cwd 或 workspaceId)
session/prompt   → 提交用户输入(附件引用可选)
session/cancel   → 取消当前回合
session/page     → 冷读历史(header + 事件 + chunk runs + projection baseline)
session/follow   → 流:开场快照 + 无缝事件帧(活跃回合适时;冷会话 page 足够)
session/control  → 流:活跃会话控制基线 + 替换帧(busy 状态、队列;无则可给最小帧)
llm/listProviders / listConfigurableProviders → 模型目录(可静态单条)
workspace/*      → 侧栏工作区(可先固定单工作区)
```

### 4.2 数据映射(其他 runtime → SessionEvent)

| 其他 runtime 常见概念 | 映射到 | 缺失后果 |
|---|---|---|
| 用户消息 | `user/message` | —(必需) |
| 助手回复(整段) | `assistant/message`(无 chunk) | 无打字机效果,消息整段出现 |
| 流式 token | `assistant/chunk`(可选增强) | 缺 = 无 token 级回放 |
| 工具调用/结果 | `tool/call`(原始 arguments 字符串)+ `tool/result`(含 error 结构) | 缺 = 无工具卡 |
| system prompt / 工具清单 | `request/header.system` / `.tools` | 缺 = trajectory 无 System Prompt 标签(有显式占位文案) |
| 模型/上下文窗 | `request/context` | 缺 = 路由元数据不显示 |
| 回合失败/中断 | `turn/end.reason`(结构化 LlmFailure \| max-tokens \| interrupted) | 缺 = 回合无失败标记 |
| token 用量 | `assistant/message.usage` | 缺 = 无统计条 |

事件发射的时序契约:seq 单调连续、turn/step 包裹、surface 事件带 surfaceOp(append/replace)。
对接方不需要理解 cordis——**只需产出一个符合 discriminated-union 的 JSON 事件日志**。

### 4.3 工作量估算(粗)

| 块 | 规模 | 备注 |
|---|---|---|
| BFF 骨架(静态服务 + boot graph 组合器 + auth + /api 路由) | ~500–800 行 | 全部是薄胶水;WS mux 若不想复刻可先只做 unary + 轮询降级?——**不可**:`follow`/`control` 是流,follow 可用 page 轮询近似,control 建议复刻简化 mux 或借用 gateway 包 |
| session 适配器(含事件日志转换) | 视 runtime 复杂度,~300–1000 行 | 核心成本在事件模型映射 |
| 组合配置(roster patch) | ~100 行 YAML | 披露旋钮即在此 |
| 验证 | 壳冒烟(S7 式:boot graph → bundle URL 200 → 会话收发) | 已有成熟验证法 |

### 4.4 风险与开放问题

1. **版本不稳定(最大风险)**:`0.1.2-alpha.x`、`SESSION_FORMAT_VERSION=0`(源码注释明示
   "no compatibility is implied, incompatible logs are rejected")。wire 面与事件词汇随版本可变。
   缓解:锁精确版本;升级前跑 §3.2 的 boot-graph diff;适配器事件面尽量只发核心词汇。
2. **WS 流复用协议**未在本轮逐帧逆向(`stream-protocol.ts`);若走 1b+自写 BFF 需一次
   帧格式侦察(源码在,量小)。或直接复用 `@deepseek-ai/dsh-api-gateway` 包(变体 2.4)。
3. **settings describe mirror 的非 loopback 缺口**:上游已知问题(skill web-ui.md §6),
   Settings/Models 页在 remote 页面 terminally unavailable——对接方实例若非 loopback 托管,
   设置面要么修(自有插件行补偿)要么 roster 裁掉。
4. **品牌/文案**:ui-brand-official、DSH 字样、manifest——对外复用需 roster 替换品牌槽或
   接受原样(MIT 允许,但商标礼貌上应替换;`brand.mark`/`brand.name` 就是为此设计的槽)。
5. **HMR/preview 等附属面**(`/plugins/events`、worker preview)可整体不实现,不影响主链。

---

## 5. 裁决

1. **剥离边界**:浏览器半 + 4 条 wire 契约是"保留层";TypertRemoteService 实现是"替换层"。
   方案一/二的真正分叉只在保留层的**获取与修改方式**。
2. **方案一(源码级)胜出,且应收敛为其 1b 形态**(npm 工件组合 + 自写 BFF + roster 组合)。
   理由:零构建、版本可锚、MIT 干净、披露两级旋钮、UI 扩展不经 fork。
3. **方案二(物理层)不作为独立路线**:其收益(绕开源码)被事实否证——浏览器侧源码薄且
   npm 工件本就预构建;其不可绕开的部分(服务端 wire 面)与方案一相同。CDP 保留两个辅助
   角色:wire 契约的经验性验证、跨版本 boot-graph diff。
4. **PoC 建议(半天级)**:写死一份 boot graph(从 4999 抄)+ file server 服务 npm 拉的 51 个
   bundle + 实现 `session/list|create|prompt|page` 四个 unary(无 WS,先只读+假发送)→ 浏览器
   打开能看到会话列表与历史渲染,即证明边界正确。第二步补 `follow` 流与真 prompt。

## 来源

- 源码(alpha.5 checkout):`packages/client/web/{boot,seed,platform}.ts`、`packages/client/modules/src/index.ts`
  (boot graph 组合 + /plugins 服务)、`packages/host/webserver/src/{index,injections}.ts`、
  `packages/host/frontend-static/src/index.ts`、`packages/client/connection/src/{http-bridge,browser-auth}.ts`
  + `src/client/rpc.ts`(unary envelope)、`packages/api/gateway/src/index.ts` + `stream-protocol.ts`
  (WS mux `/api/remote.mux`)、`packages/api/session-controller/src/index.ts`(@Remote 全量)、
  `packages/api/remotes/src/client/index.ts`(浏览器装配)、`packages/core/session/src/types.ts`
  (SessionEventMap 全量)、`packages/bundle/web-app/cordis.patch.yml`(roster 原文)
- 实例取证:4999 鉴权抓取 `.scratch/dsh-index.html`(boot graph 51 条、combo URL、注入行);
  `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-trajectory/lib/client.js`(npm 工件含
  预构建 bundle);51 bundle 体量盘点(3.94MB)
- 前置研究:本目录三篇(见文首);`../05-dashr-dev/plugin-development.md` §3(web-ui 分量,2026-09-06 自 skill 蒸馏)
