# TUI 终端入口（Terminal Surface）研究 — 2026-09-12

> 定位：Super D 的一个**子方向 / App feature**——我们希望 Super D 始终保留一个终端（TUI）入口，
> 与 Web 面并存。本文先落调研：① 社区现有 TUI 插件的上游实现方式与成熟度对比；② 上游 dsh
> 本身有没有留 TUI 入口（含"正常安装下不触发"的隐性入口）。
> 状态：**研究阶段，未立项**；后续裁决进蓝图 §9 / ADR。

---

## 1. 上游 dsh 本身的 TUI 入口调查（先回答更重要的问题）

**结论：上游 dsh（`dsh-v0.1.3-alpha.2` checkout，`upstream/deepseek-harness`）没有自带 TUI 表面，
但为第三方 TUI 预留了完整的挂载机制。**

### 1.1 已发布的表面（surfaces）清单

上游 bundle 组（`packages/bundle/`）只提供五种应用面，全部基于 `dsh-base`：

| bundle | 表面 | ctx key |
|---|---|---|
| `base` | 共享核心（patch-only） | — |
| `web-app` | 浏览器 GUI | Web rows |
| `headless` | 一次性命令行任务 | `headless-runner` |
| `acp-app` | **automation-only ACP stdio** | ACP bridge |
| `sdk-app` / `sdk-minimal` | JSON-RPC stdio | SDK server |

没有任何一个 bundle 渲染终端交互 UI；`packages/terminal/` 只有 `tool-terminal`（bash 工具的
PTY 执行器，非 UI）。全仓 word-match "tui" 仅命中：

- `apps/cli/src/args.ts`、`packages/boot/cmdline/README.md`：**纯示例文案**——
  `dsh --profile tui --resume <id>` 被用来解释"launcher 只解析自己的 flag，其余参数透传给 profile 内 app"；
- `packages/boot/app-boot/tests/profile.spec.ts`：`resolveProfileDir('tui', …)` 测试夹具；
- `packages/client/ui-user-questions/src/index.ts`：注释提到 "the TUI composition, which has no
  presets"——**上游在文档里预期存在第三方 TUI composition**，但没有随包发布它。

即：正常安装 `@deepseek-ai/dsh` 后，没有任何 TUI 代码会被触发或安装——`tui` 只是一个
用户自建 profile 的惯用名字。

### 1.2 上游留出的隐性入口（社区 TUI 全部踩在这些点上）

1. **Profile 机制**：`dsh plugin --profile <name> add <pkg>` 在 `$DSH_HOME/profiles/<name>` 建
   独立 pnpm 树；bundle 清单 `dsh.profile.bundles` 按序叠 patch。out-of-tree 包只要在
   `package.json` 声明 `dsh.bundle.patch`（指向 `cordis.patch.yml`）即可像自带 `web-app` 一样入栈。
2. **cmdline 参数透传快照**（`dsh-cmdline`）：launcher 之后的参数以不可变快照
   （`ctx.cmdlineArgs`）交给 app 内插件解析——`--resume`、`--agent-preset` 等 TUI 专属 flag
   靠它进入。
3. **durable session log 不变量**（"model-visible ⟺ logged"）：会话事件流可完整重放，
   TUI 可以只做**纯展示层**（启动 `snapshotEvents()` 重放 + 订阅 `session/event`），不碰 agent 状态。
4. **ask_user_question / approval 面抽象**（`ui-user-questions` 等）：提问流被设计为可被
   多种 composition 消费——TUI、Web 各自实现回答面。
5. **ACP profile**：`dsh --profile acp` 暴露标准 ACP v1 stdio，任何 ACP 客户端（包括
   独立 TUI 产品）都可以驱动它——这是**不进 profile 树也能接入的一条路**（Martty 走的）。

### 1.3 对 Super D 的含义

- TUI 入口**不可能靠升级 upstream 获得**，必须自建插件/客户端，或桥接社区 TUI。
- 上游基线注意：superd pin 是 `0.1.3-alpha.2`，而**社区最活跃的 TUI 已只支持 rc/stable 线**
  （见 §2 dsh-tui-pi 的 `>= 0.1.5-rc.2` 下限与启动守卫）。TUI 方向落地前需先过
  对齐轮（AGENTS.md §二程序）确认基线兼容性。

---

## 2. 社区 TUI 插件对比（2026-09-12 调研）

七个仓库，按两种接入形态分两类：**profile 插件 bundle**（进 dsh profile 树，共享会话/工具/权限）
与 **独立客户端**（经 ACP/外部进程驱动 harness）。

| # | 仓库 / npm 包 | 形态 | 目标 dsh 线 | 成熟度 | 上游实现要点 |
|---|---|---|---|---|---|
| 1 | [tomowang/dsh-tui](https://github.com/tomowang/dsh-tui) `@tomowang/dsh-tui` | profile bundle（自比肩 `dsh-web-app`/`dsh-headless` 的 "mode bundle"） | Node ^22.19/≥24 | **架构最干净、文档最好** | 纯展示层：启动重放 `agent.session.snapshotEvents()`，live 跟 `session/event`；`followup()`/`steer()` 进 inbox；`tui-startup` 经 `dsh-cmdline` 解析自有 flag 发布为 Cordis service；双 TTY fail-loud（管道退回 headless）。alt-screen 全屏、状态栏/TTFT/缓存命中率、`/model` provider 管理、plan/goal/subagent 切换器、OSC 9 桌面通知 |
| 2 | [fan56/dsh-tui-pi](https://github.com/fan56/dsh-tui-pi) `@aiwayds/dsh-tui-pi` | profile bundle + **九件伴生插件套件** + Feishu 手机端 | **仅 rc/stable（≥ 0.1.5-rc.2）**，alpha 线启动守卫直接退出（`DSH_TUI_SKIP_HOST_CHECK` 可跳） | **功能最重、工程最重** | pi 风格：think/tool 面板、subagent 实时转向、DCP 零 LLM 压缩、model profiles、`/history` 双栏回看、GitHub 主题；**patch 层替换 stock `session-projection-cache` row 为 wrapper** 做 record 迁移（启动早于 stock 插件开域）；依赖 host kernel write lease 保单写者；ask-router 把 `ask_user_question` 扇出到 TUI/Feishu 多表面 |
| 3 | [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) `@deepseek-harness-tui/dsh-tui` | profile bundle，零核心改动 | npm 一键装 | **人气最高**：官方公众号收录、dshfind 目录、Trending 日榜 #7、CI + VS Code Marketplace 插件 | Claude Code 风：像素鲸鱼顶栏（移植 dsh-ui-whale）、流式思考、双击 Esc 时间回溯、TPS/缓存仪表；**终端图像管线最深**——Kitty graphics/Sixel 自适应、Sixel 256 色量化 Worker 缓存、大图预览/缩放/翻页，`DSH_TUI_IMAGE_PROTOCOL` 覆盖；`/agentview` 后台会话一站式管理 |
| 4 | [lk251066/dsh-tui-pro](https://github.com/lk251066/dsh-tui-pro) `@lk251066/dsh-tui` | profile bundle（单包同时含插件 + profile layer） | developer-preview 线 | 中上；每发版从源码→packed npm→干净 profile→真 Linux PTY 全链验证 | **多会话工作台**：一个 durable "Assistant" 会话横跨项目常驻 + 侧栏按 workspace 分组活动会话；插件本地长期 memory；固定底栏而非弹窗；taskbar 进度/低频 spinner 进终端标题 |
| 5 | [huiliyi37/dsh-tianshu-tui](https://github.com/huiliyi37/dsh-tianshu-tui) `@huiliyi37/dsh-tianshu-tui` | profile bundle（`@deepseek-ai/*` 生态） | 0.1.2-rc.1 peer 对齐 | 中上；文档矩阵全（ADAPTER.md 定义 TUI↔harness 边界契约） | 自研极简 ANSI 渲染引擎（轻量流畅）；UI 纯展示层，状态全来自会话事件流；16+ 主题、LSP 诊断、图像/视觉桥接、跨会话 memory；有**生态边界警告**：勿混装进同作者的 oh-my-tianshu（`@huiliyi37` 生态，独立 `$DSH_HOME`） |
| 6 | [xiaoshihou514/dsh-tui](https://github.com/xiaoshihou514/dsh-tui) | profile bundle | — | **最小**：极简 TUI，仅 github: 安装，README 一屏 | 作为"最小可行挂载"参照有价值：`dsh plugin --profile tui add github:…` 即起 |
| 7 | [openma-ai/Martty](https://github.com/openma-ai/Martty/tree/main/npm) `martty`（原 `@openma/deepseek-harness-tui`） | **独立终端产品 + 可选 dsh profile 双形态** | ACP v1 | **形态最特殊、scope 最大**：Rust painter 原生二进制（mac/linux/win 全平台），Node Client 独立进程 | 不进 profile 树：经 **ACP** 连 dsh（默认内置 `@openma/deepseek-harness-acp`），`DSH_TUI_AGENT`/`--agent` 可换任意 ACP agent；`martty harness find/add/use` 从官方 ACP Registry 浏览安装别的 agent；Host 挂 ACP 插件 + **TUI Client 独立进程**（stdin/stdout ACP，渲染走 Rust compositor 本地通道）；有正式 **TUI 插件 API**（theme / `chrome.right` 节点 / slash 命令 / overlay / Host-Client RPC，语义数据、不给 TTY） |

### 2.1 共性结论

- **零核心补丁是社区公约**：全部走 `dsh.bundle.patch` / ACP，卸载即净。与 superd「上游源码零修改」红线完全同构。
- **两种可复用接入面**：① profile bundle（共享 dsh 的会话/工具/权限/压缩，改动最小）；② ACP 客户端（跨 agent 通用，但受 ACP 方法面限制，如 acp-app 无 session title 表面）。
- **渲染普遍 = durable log 重放 + live 事件订阅**（tomowang 说法最直白）；上游的"model-visible ⟺ logged"不变量是所有 TUI 免费拿到的地基。
- **多表面问答扇出**（fan56 的 ask-router）与 superd「web 面已有的 ask/approval」面对的是同一问题：同一会话多个 UI 表面抢答 → first-answer-wins 路由。Super D 做 TUI 入口时**必然**要裁决这条（Web 与 TUI 谁可答、如何互斥）。
- **兼容线分裂**：alpha 线（superd 当前 pin）已开始被头部插件弃保（dsh-tui-pi 明确 exit）；rc/stable 是社区事实标准线。这直接影响 superd 想桥接哪个现成 TUI。

### 2.2 成熟度排序（就"拿来即用 / 作为蓝本"而言）

1. **tomowang/dsh-tui** — 架构蓝本首选：纯展示层、与上游 bundle 同构、fail-loud、文档把边界讲得最清楚。
2. **fan56/dsh-tui-pi** — 功能上限与多表面路由（ask-router）参照，但绑定 rc 线 + 套件重。
3. **ccch1mneyyy/dsh-TUI** — 终端图像/交互细节最丰富，人气佐证生态位真实存在。
4. Martty — 若 Super D 想要"通用 agent 终端"形态，ACP 路线与插件 API 值得对照；但对 dsh 专有表面（goal/plan 模式）覆盖弱于 ①②。
5. tianshu-tui / tui-pro / xiaoshihou — 特性参照（ANSI 引擎、多会话工作台、最小骨架）。

---

## 3. Super D 视角：TUI 入口的三个候选路线（待裁决，不预设结论）

| 路线 | 形态 | 优点 | 代价/风险 |
|---|---|---|---|
| A. 桥接现成社区 TUI | 把某社区 TUI 装进 superd 侧 profile，经 selector 接入 adapter 数据面 | 零自研渲染；生态成熟 | 受制于该插件的 dsh 版本线（rc vs superd pin alpha.2）；上游发版节奏不受控 |
| B. 自研 superd TUI bundle | 学 tomowang：out-of-tree bundle，纯展示层重放 session log + live 事件 | 完全贴 superd 数据面契约；零核心改动同构 | 渲染/交互全自研，工程量大 |
| C. ACP 客户端入口 | 学 Martty：TUI 作为 ACP client 驱动 `--profile acp` 或 superd adapter | 形态上可超出 dsh（多 agent） | 受 ACP 方法面限制；与 superd「桥接数据面」架构多一层翻译 |

与现有架构的接口点（后续计划里细化）：

- TUI 入口应作为 superd 的**第三个 surface bundle**（与 web bundle 并列；呼应 dashr Profile 层
  可行性文档 2026-08-16 把 TUI 列为第三 surface bundle 的记录——当时裁决为暂缓决策、保留 CLI/headless 入口）。
- 多表面问答互斥（web 与 TUI 同时开着同一会话时 `ask_user_question`/approval 归谁答）——fan56 ask-router 是现成先例。
- profile/版本基线：TUI 路线落地前先跑对齐轮，确认目标插件的 dsh 版本线与 superd pin 的兼容矩阵。

## 4. 下一步

1. 把基线兼容矩阵补进本文（各插件 npm peer / 启动守卫 vs superd pin `0.1.3-alpha.2`，含 alpha→rc 迁移观察）。
2. 深读 tomowang/dsh-tui 的 `cordis.patch.yml` 与启动插件源码，产出「最小 TUI bundle 需要哪些 row」清单（路线 B 预研）。
3. 试用安装：在 `.superd-test` home 起一个 `tui` profile 实测 1–2 个候选（遵守 AGENTS.md §三红线：不碰 `~/.dsh`）。
4. 裁决路线 A/B/C → 蓝图 §9 决策表 + ADR。
