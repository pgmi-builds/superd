# Agent Worlds 融合路线：Foreign Agent 深度集成与数据分离（第三路线）

- **日期**: 2026-09-14
- **定位**: 架构设计文档（第三路线：Multi-Context 拓扑 × M0-Fork 数据面哲学的融合线；foreign agent deep integration and detachment）
- **路径**: `docs/superpowers/plans/2026-09-14-agent-worlds-fusion-design.md`
- **核心命题**: **每个 foreign agent 一个完整 DSH 世界（ctx-world），物理 detach 于原生 foreign 环境**。拓扑继承 multi-context（CTX0 完整体 + ctx-omp/codex/claude… 平级 root + 导流门单跳）；数据面**起步 = omp-web 同构**（native store 为真相、adapter 发数据、app-home 重定向即 detach），**目的地 = M0-fork 数据面契约**（DSH SessionEvent log = source of truth、foreign runtime = 可替换计算引擎、写路径转译；per-adapter 采纳，AW-C1）；M0-fork 的**机制层**（L1 ambient RuntimeKey / L2 `internal/get` 拦截 / L3 三级键 / isolate realm / 多槽白名单）**整层不采用**——per-context 拓扑下「按 runtime 分片根单例」这个问题物理消失，其最贵的未知数（拦截再入/热路径开销、`ctx.get` 直查盲区、native 零变化回归横跨整个服务矩阵）随之不存在。
- **血缘**: 继承 `2026-09-10-multi-context-design.md`（拓扑、V5 导流门、进程模型 ADR 0008）+ `2026-09-12-m0-fork-global-runtime-selector.md`（数据面契约、转译词汇、自愈原则、resume 语义）；对两线各有一处修订/否决（§〇、§九）。
- **代码落位**: `apps/agent-worlds/`（新线，自包含 `package.json`/`node_modules`；两条旧线冻结不动，见 §十）。产品双包沿用仓命名约定：`@pgmi-builds/agent-adapter-*`（数据面）+ `@pgmi-builds/agent-ui-*`（呈现面）。线名 agent-worlds 为暂定名。

---

## 〇、继承与否决表

| 维度 | 从 multi-context 继承 | 从 M0-fork 继承 | 明确否决（本线不采用） |
|---|---|---|---|
| 拓扑 | CTX0 完整体 + ctxN 平级 root；native 多 context 同进程 `boot()` 派生、foreign runtime core 子进程（ADR 0008 原案） | — | 单 Context + isolate realm 分片（定制天花板 = 白名单；拦截机制三类风险整体消失） |
| 导流 | V5 typertGateway **实例委托**（`dispatchRpc`/`openWireStream` 两方法，进程内、零 HTTP、零字节代理） | — | wire 字节中继（V2-V4 歧途，multi-agent-ctx 已删档）；逐 context 探测路由（S1 否决） |
| 数据面 | **起步 = omp-web 形态**：native store 为真相、adapter 发数据、app-home 重定向即 detach（§七） | **目的地**：DSH log = source of truth + 写路径转译 + resume = 以 DSH 历史为前缀重灌（AW-C1，per-adapter 采纳） | reconciliation（与原生 foreign 数据持续同步的整类负担清零）；import-once 机制（暂缓，测试期以 config 拷贝代替） |
| spawn 机制 | 直调 `boot()`（绝不经 `runProfile()`，ADR 0008 约束 1） | — | **profile 目录依赖**：产品机制 = 插件自带 composition；`scripts/profiles/*` 降级为 dev/test 脚手架（S2） |
| selector | 导流门指针翻转、零 HMR/零 Drain | — | M1 期 `localStorage.clear() + location.reload` 切换 hack（旧线 hack 不回改，本线不做，§八） |
| UI 自愈 | dumb carrier 本体（non-throwing `RemoteResult` / 空数据段降级 / `ignorable` 未知事件） | client 半软重启机制（`dsh-client-hmr` reload，§八复用） | — |

**不变量分治**：本线对 multi-context §五「UI 数据面纯净性/禁 union listing」的修订**只在本线生效**（§九）；两条旧线的不变量表互不引用、互不豁免（M0-fork §5.3 格式）。

---

## 一、拓扑总览

```
superd App（apps/agent-worlds 线；单 Node 进程）
 └─ CTX0（native 完整体 = dsh-base + dsh-web-app + superd 核心插件）
      ├─ webserver（唯一用户入口，端口纪律见 §十）+ Auth fence
      ├─ roster service（foreign agent 花名册，S2）
      ├─ 导流门（V5 gateway 实例委托，S4）
      ├─ selector service（持久化配置字段 + changed 事件，S1/S6）
      │
      ├─ agent-adapter-omp 插件已载 ──► roster += omp ──► 激活时 spawn：
      │    └─ ctx-omp（平级 root：dsh-base + dsh-web-app 裁切体）
      │         ├─ 全 RPC 面（typert-gateway + session-controller…），零 HTTP listener（S4）
      │         ├─ nested home = <dshHomePath>/agents/omp/（S3；= OMP app-home 重定向，原生自填充 §七）
      │         ├─ 数据面：起步 = OMP store（adapter 发数据，omp-web 同构）→ 目的地 = jsonl DSH 格式 + 写路径转译（S5/AW-C1）
      │         └─ OMP runtime core 子进程（broker 托管，首次路由才 spawn）
      │
      ├─ agent-adapter-codex 插件已载 ──► roster += codex ──► ctx-codex（同构）
      └─ 未装/未启用的 adapter ──► 不在 roster、不 spawn、零成本
```

进程模型要点（ADR 0008 原案全数继承）：foreign runtime core = 子进程是现实不是取舍（`omp --mode rpc` / `claude -p` / `codex exec` 无第二条路）；adapter 壳与 ctxN 树同进程；子进程崩溃不拖垮 host，进程边界即故障域边界。

---

## 二、裁决 S1：selector 单跳与会话控制（无探测）

- **请求路径 = selector 一跳 handoff**。selector 决定整个 RPC 面归谁（当前世界的 gateway 实例应答）；dispatcher **从不在请求路径上寻址 sessionId**，不存在「查 native → 查 omp → 查 codex」的探测瀑布。
- **错误 sessionId**：由**且仅由**当前所在世界的 sessionController 应答——上游原生 `session/not-found` 语义，与 native 行为逐位一致。fail where you asked，永不跨 context fallback。
  - TDD 用例（硬性）：omp 世界内 prompt 一个不存在的 sessionId → 恰好一次委托、零跨 context fan-out、错误形态与 native 完全一致。
- **归属标签（runtime 徽标）**：session create 时由所属 context 盖一次章（adapter 自有信息事件或 header 扩展位），**仅供呈现层 union 徽标与运维工具读取**（§九），永不参与控制面路由。不做 union 视图则标签可缺省。
- 本线因此几乎没有「persistence router」这个部件：导流门 = selector map 一跳；每个世界的 persistence 是它自己的。M0-fork §2.4 RouterPersistence 归属索引为「单 context realm 分片」而发明，跨 context 拓扑下不需要。

## 三、裁决 S2：插件在场即成员（plugin-presence = roster）

- **roster 不是配置出来的，是 adapter 插件加载态的投影**：runtime 装了/启用了哪个 `@pgmi-builds/agent-adapter-*`，foreign agent roster 里就有谁。CTX0 上一个 roster service，插件激活时自注册（name、label、ready 态）；RuntimeSeat chip 消费它。无 roster 配置文件。
- **spawn 是插件自己的动作**：adapter 插件激活时在 CTX0 树上调 `boot()` 派生平级 root ctxN。composition 由**插件包自带**——引用上游 bundle 名 + 自己的 `cordis.patch.yml` 差异（上游发版自动跟随，禁止手抄行表）。
- **装第二个 agent = 纯包管理**：`npm i agent-adapter-claude` → 重启后 roster 多一项、`agents/claude/` 首次使用时出现——不碰 profile、不碰 selector 配置、不碰脚本。
- `scripts/profiles/*.mjs` 降级为纯 dev/test 脚手架，产品路径零依赖 profile 目录。
- **摆位默认值**：ctxN **树**在插件激活时 eager spawn（roster 如实反映「已载且 ready」，切换零启动延迟）；foreign runtime **子进程** lazy（首次会话路由才起，broker 托管纪律不变）。树 spawn 的内存账单实测后（§十一.4）可退化 lazy tree。

## 四、裁决 S3：嵌套 home 派生（detach 的存储形态）

- **布局**：`<dshHomePath>/agents/<runtime>/` 为该 ctx 的嵌套 home 根。起步它首先是 **foreign app 的 app-home**（由 adapter 设置，§七）：native app 以**原生方式**在其中自填充（config/凭据/store 全按各 runtime 原生布局长出）；deep-integration 采纳后（AW-C1）ctxN 的 DSH 格式数据与之共存于同一根下。native 的 `$DSH_HOME/sessions/` 原地不动。
- **解析源 = 宿主树的 `dshHomePath` 服务**（插件 inject 获取），拼 `agents/<runtime>`；**插件永不读 `process.env`**——env 共享解析器的坑（改 env 连累 ctx0）结构上不存在。
- **传入方式**：`boot()` 第 4 参 prepare 槽位（ADR 0008 签名中的 `undefined`），在 `mountRootInclude` 之前 provide 覆盖——同 scope 重复 provide 会 throw，**时序是红线**（ADR 0008 约束 2）。
- **验收**：把原生 foreign home（如 `~/.omp`）改名/断权后全程跑通、分毫不碰；`agents/omp/` 由 native app 原生自填充生成（测试期 = 拷入现有 `.omp` configs）、重启 resume 归属不变。

## 五、裁决 S4：零 HTTP 委托与零端口 ctxN

- **委托点 = `ctxN.get('typertGateway')` 的实例方法**（`dispatchRpc` 全部 unary RPC；`openWireStream` 全部 live 流含 `$events`）。实例自有状态 `remoteEvents`（同树 api-remotes 经 `registerRemoteEvents` 注册）随实例走——ctx 寻址与 JS 实例状态一次全对。零 envelope 重建、零字节代理（V2-V4 歧途不复活）。
- **认证**：全程**单一认证域**——浏览器只持 ctx0 的 cookie；进程内委托不经过 ctxN 的 webserver auth fence，「同一 cookie 通吃所有 runtime」是结构必然而非巧合。ADR 0007 cookie-jar 转发只在**跨进程目标**（独立进程 foreign / 远端 machine 走 GatewayFace wire 适配）时进场。
- **零端口**：ctxN 组合不喂 `webStartup`/`cmdlineArgs` → no binds（multi-context §五.5 已验证）；或行级 disable `webserver`/`frontend-static`。`sessionController` 挂在 dsh-web-app（其 patch L105），与 listener 的行级独立性 → POC `--dump-config` 行级审计（§十一.1）。ctxN = 「全 RPC 面、零端口」纯数据世界。
- 确需 debug 端口时：仅 loopback，且按仓端口纪律补 socat/Caddy 路，绝不 `host: 0.0.0.0`。

## 六、裁决 S5：行表深度 agent-specific（omp-web 形态起步，不 suppress ctx.llm）

- **suppress 与否是 agent-specific 问题**——取决于怎么适配、适配到什么深度，与其他服务的去留一并留作后续考量、逐 agent 定案。**起点 = 现有 omp-web 形态：不 suppress `ctx.llm`**——native 行照常组合，但 web UI 的数据路径永远到不了它（omp-web adapter 发数据）。**数据路径归 adapter 所有**，这比行级裁撤更贴 omp-web 的真实机制，也是本线起步的路线级要求。
- **路线级不变量只有三条**：
  1. **UI 消费的数据面由 adapter 提供**——UI 的会话/模型/清单数据来自 adapter，不落到 native 数据源（数据路径所有权，非行裁撤）；
  2. **会话 log 单一主笔**——一个 ctx 内谁写 log 谁就是 turn 引擎；这是**采纳写路径转译（AW-C1）时**的准入判据，不是起步要求；
  3. **每个 adapter 的具体行表裁留在其包内定案并随包走**——`@pgmi-builds/agent-adapter-*` 自带的 `cordis.patch.yml` 即行表裁决的物理载体（S2）。

**上游事实存档（2026-09-14 源码核实，供各 adapter 裁决参照）**：

- 写 session log 的主笔是 agent-loop（`agent-loop:429` `ctx.get('sessionPersistence')`、`:444-445` inject resumeWith、`:731`、`:844`）；tool/call、thinking、assistant/message 由 agent-loop 从 LLM 流块 + 工具执行中产出后落盘。`ctx.llm` 本体是管道，不碰 persistence。
- llm 横切面有两根侧写笔：`llm-retry` 把 retry 事件经 `ctx.sessions` 写进 log；`token-meter` 读 log 做用量投影；另有 `session-checkpoint-policy`（`inject = ['llm','sessionPersistence','sessions','tools']`）等 llm×log 交叉行，均假设 native loop 事件语义。
- 转译采纳时的准入判据：只读 DSH log 的行可留；写 log 或假设 native 事件词汇的行需逐个审。

**对 `agent-omp` 既有 exclusive 形态（禁 agent-loop / llm-deepseek / llm-pi-ai / presets / jsonl）的处置**：起步维持其 OMP-store-only persistence（omp-web 同构，适配改造量趋近零）；「jsonl 唯一存储 + 写路径转译」是 deep-integration 目的地（AW-C1），按 adapter 逐个采纳，不是本线起步门槛。
## 七、detach 数据面：一次性 import + 写路径转译
## 七、detach 数据面：起步 = app-home 重定向 + 原生自填充（import-once 暂缓）

- **起步姿态（detach by redirection）**：adapter 把 foreign app 的 **app-home path** 设到 `<dshHomePath>/agents/<runtime>/`；native app 以**自己的原生方式** populate 一切（native way, not DSH way）——配置、凭据、store 全按各 runtime 原生布局在该目录内自长出。app-home 的设置机制（env / spawn 参数 / 配置项）是 adapter 自己的管道（S2 归属）。
- **测试期做法**：直接把现有原生 configs（如 `.omp`）拷到 `.dsh/agents/omp/`；**「首次 import」机制 skip、不做**。
- **detach 效果**：改名/断权原生 foreign home（`~/.omp` 等）全程不碰（验收成立）；用户数据物理收进 DSH home 子树；与原生环境的 reconciliation 负担清零。
- **deep-integration 目的地（AW-C1 起，per-adapter）**：写路径转译落 ctxN 自己的 DSH 格式存储；**native app 的原生 session log 照旧留在 `agents/<runtime>/` 原生格式**——DSH log 与原生 log 并存为 duplicate，**duplicate 显式接受（for now）**；resume = 以 DSH log 为前缀重灌 foreign turn（与 Claude Code `-p --resume` 同形态），语义上 DSH 是主时间线；单向阀收窄为**不回读**（原生 store 由 native app 自写自管，DSH 侧永不读它）。
## 八、裁决 S6：切换语义 + 前端面

**切换语义（router 是哑的）**：

- 零 HMR / 零 Drain 不变量原样继承：切换 = 导流门指针翻转，在飞 turn 属于 owner context（fiber 或子进程），router 永不触碰。
- router 只管两件事：**consumer 切换**（UI 这个世界看哪）+ **新会话 data generator 指向**（下一个 create 落哪个世界）。存量 generator 的 ttl/idle/dispose 归 owner context 的 agent 管理（native 走 agent-loop idle 语义，foreign 走 sidecar SessionManager）——router 哑到不认识「生命周期」这个词。
- 切换瞬间 UI 的 `$events` 流重绑新世界；后台世界进度**只落盘、不渲染**。后台世界 toast 通知属未来 union 通知面，out of scope。
- POC 硬用例：OMP turn 中途切回 native → turn 跑完、事件落 `agents/omp/`、切回看到完整结果。

**前端（两级递进，替代 `clear()+reload` hack）**：

1. **数据面切换零刷新**：V5 指针翻转后同一页面 session/list、prompt、`$events` 无缝换世界（e2e 已证大半，本线补齐「不 reload 的 UI 状态迁移」）。
2. **client 包热换血**：`@deepseek-ai/dsh-client-hmr` client 半 `reload(id, rev)`（findEntry → dispose fiber → 重挂）；首选触发路 = host 半翻 per-runtime client 行的 disabled 位 → 既有 HMR 管道自动重载，零新机制。per-runtime client 包 = `@pgmi-builds/agent-ui-*`（自有 slots/modules/theme，组合期就位可 disabled）。验收：切换全程无 `location.reload`、无白屏、在飞 UI 状态不炸。

**分区存储**：单 origin（ctx0 端口）+ 导流门下，所有 client 持久键加世界前缀（`superd:<world>:…`）。POC 第一步盘点 client bundle 实际触碰 localStorage 的点：走可 patch 服务面 → client 插件 provide namespaced storage；直调 `window.localStorage` → 早期 shim 或 patch 调用点。认证走 cookie 不在 localStorage（旧线 `clear()` 本就不清认证，但本线不 clear、不 reload）。验收：切走再切回草稿还在、native 缓存原样。

## 九、呈现层 union（本线新裁决，修订 multi-context §五）

- **前提**：各世界全说 DSH 方言后，multi-context §五否决 union 的原始理由（外来数据异构、真相各异）松动——呈现层聚合变得便宜且安全。
- **形态**：聚合列表 = 并发调各 ctx `sessionQuery.list` 并打归属徽标；只读；世界过滤可选。数据源集合 = roster（S2）。
- **边界**：per-item 归属**仅呈现层元数据，永不进入控制面路由**（路由由 S1 selector 独占，杜绝「第二选择权威」复发）。点击外来 item = 显式切世界（selector 变更），不做跨世界透明跳转。
- 优先级最低（AW-F 可选），不阻塞任何前置里程碑。

## 十、与旧线的关系、冻结纪律与仓红线

- **职责分界（2026-09-14 定案）**：cordis/dsh patches（UI 或后端）、存储适配、adapter runtime **一律 per agent**——物理载体是各 `@pgmi-builds/agent-adapter-*` / `agent-ui-*` 包；**agent-worlds 线自身只建设 switch 与 gateway**（roster / selector / 导流门 / 切换基建）——mostly, at least now，线级面随生长再议，adapter 专属物永不上提到线。

- **冻结纪律**：现役线**有且只有一条**。`apps/multi-agent/`（2026-09-10 搁置）、`apps/multi-agent-ctx/`、`scripts/profiles/m0.mjs`（搁置线）全部冻结保留、可退；「保持原样」的严格含义 = 冻结，不是并行开发。
- **共享资产拷贝不耦合**：V5 gateway、agent-omp 转译词汇、start 脚本族、`heal-modules.mjs`——新线**拷贝或引用，永不反向依赖**；旧线永不因新线被迫改动。
- **对齐轮经济学**：上游每发版按 AGENTS.md §二逐线 diff；冻结线只做「build 是否还绿」轻量核对。这是「一次只养一条现役线」的成本依据。
- **仓红线全数适用**：`DSH_HOME=<仓根>/.superd-test`（新线建议独立子目录，如 `.superd-test/aw/`，避免跨线 profile 干扰）；端口族 4996-4999/309x 避开 3080/3081（prod）与 4999（ctx0 线现役），拉起前 `ss` 预检；daemon 一律 `systemd-run --user`；任何 install 后 `node scripts/heal-modules.mjs`；上游源码零修改，改动全走 patch/自有包。

## 十一、风险与 POC 必答清单

1. **零端口 ctxN 的行级审计**：dsh-base + dsh-web-app（−webserver/frontend-static）能否携带完整 RPC 面（sessionController + typert-gateway）且 no binds——`--dump-config` 逐行核。
2. **prepare 槽位时序**：boot 第 4 参 provide `dshHomePath` 覆盖必须在 `mountRootInclude` 前（重复 provide throw 红线）；boot/prepare 签名列入上游对齐 diff 清单。
3. **失败域实测**：kill ctxN（含 foreign 子进程 crash）→ ctx0 UI 活、切回 native 正常、ctxN 可重激活自愈。
4. **内存账单**：N=2/3 完整栈 RSS 实测 → 定 eager tree vs lazy tree。
5. **写路径转译完备性**：OMP 事件词汇 → DSH SessionEvent 缺口表（tool/call 参数形态、thinking/partials、错误轮次）；未映射事件 `ignorable` 策略。
6. **在飞流收尾**：`$events` 切换重绑 + 旧世界在飞流「归属旧绑定、跑完即弃」语义验证。
7. **localStorage 触点清单**：client bundle 全量盘点 + namespaced shim 方案定型。
8. **app-home 设置管道**：各 foreign runtime 的 home 重定向机制盘点（env / spawn 参数 / 配置项）；import-once 机制暂缓，测试期以 config 拷贝代替。
9. **行表漂移**：dsh-web-app patch 行号、dsh-base 行表随上游发版漂移——对齐轮盯防。

## 十二、里程碑切片（每步独立可测交付）

- **AW-A（线骨架与机制三件套）**：`apps/agent-worlds/` 骨架（拷 V5 gateway + agent-omp exclusive 形态）+ roster service + 插件激活 spawn ctx-omp（嵌套 home 覆盖 + 零端口）+ 风险 1/2 审计。验收：roster 反映插件在场；ctx-omp 树全 RPC 面、零 listener、home 落 `agents/omp/`。
- **AW-B（零刷新切换）**：导流门注册 ctx-omp 目标；e2e 双世界 list/prompt/`$events`；mid-turn 切换硬用例；错误 sessionId 单跳 not-found 用例。验收：S1/S4/S6 全用例绿，全程无 reload。
- **AW-C0（detach 起步）**：app-home 重定向（现有 `.omp` configs 拷入 `agents/omp/`）+ omp-web 同构数据面跑通零端口世界。验收：`~/.omp` 改名全程不碰；会话/模型数据全由 adapter 发自 `agents/omp/`；native 无感。
- **AW-C1（deep integration，最重）**：jsonl 唯一存储 + 写路径转译 + resume 语义（S5 目的地形态，per-adapter 采纳）。验收：turn/resume/list/modelCatalog 全走 ctxN DSH 格式存储；foreign store 不读不碰。
- **AW-D（前端热切换与分区存储）**：client 包热换血（hmr 管道）+ 键前缀命名空间 + draft 保活。验收：localStorage 触点全命名空间化；切换无白屏无 reload。
- **AW-E（第二 runtime 泛化）**：codex adapter 走同一插件路径——「机制成套与否」的试金石。
- **AW-F（可选）**：呈现层 union 视图 + 归属徽标（§九）。

---

> **裁决与勘误存档**：
> - 2026-09-14 user 六项裁决定案：S1 selector 单跳无探测（归属索引撤出请求路径）；S2 插件在场即成员（spawn/roster/composition 由插件自带，profile 目录降级脚手架）；S3 嵌套 home `<dshHomePath>/agents/<runtime>`（宿主树服务解析、插件零 env）；S4 零 HTTP 实例委托 + 零端口 ctxN（单一认证域）；S5 行表列裁决（turn 引擎列整体裁、llm catalog 面保留、只读行准入）；S6 router 哑切换、生命周期归属 owner。
> - 2026-09-14 修订 multi-context §五纯净性裁决的适用范围：本线呈现层 union 准入（§九），控制面路由仍由 S1 独占；该裁决在 multi-context 线内继续有效。
> - 2026-09-14 M0-fork 机制层（L1 ambient / L2 internal-get 拦截 / L3 三级键 / isolate realm）在本线不采用；其数据面契约（DSH log 真相、写路径转译、resume 语义、自愈原则）全数继承。
> - 2026-09-14（二轮修订）user 两项修正：S5 行表深度 agent-specific——omp-web 形态起步、**不 suppress ctx.llm**，数据路径归 adapter 所有，行裁撤降为采纳转译（AW-C1）时的准入判据；detach 起步 = **app-home 重定向 + native 自填充**（`.omp` configs 拷入即测），import-once 机制暂缓，写路径转译收编为 AW-C1 per-adapter 目的地。上列首条 S5 存档表述（turn 引擎列整体裁）同日被本条取代。
> - 2026-09-14（三轮补充）user 两点定案：① native app 的原生 session log 留存于 `agents/<runtime>/` 原生格式，AW-C1 后 DSH log 与之 duplicate——显式接受，单向阀收窄为不回读；② 职责分界——patches（UI/后端）、存储适配、adapter runtime 归 per-agent 包，agent-worlds 线自身只建 switch + gateway（mostly, at least now）。
