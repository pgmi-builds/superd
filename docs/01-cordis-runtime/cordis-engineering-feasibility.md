# Cordis 工程化可行性研究（剥离文档）

> 记录：2026-08-21 首记于 `cordis-research.md` · 2026-09-06 剥离为独立文档。
> 剥离原因：这些内容（换 Bun 构建、异构语言桥、Rust 重写、Recursive Cordis）是围绕
> Cordis 的**工程化旁支可行性研究**，不是 Cordis 核心机制本身；留在主研究文档里分散注意力。
> 核心研究（7 名词、Fiber、Effect/epoch、时空可组合性）见 `cordis-research.md`。

---

## 1. 打包编译引擎：能否换成 Bun

> 深入专题（单独成文，46KB）：同目录 `bun-compile-cordis-runtime-bootstrap-research.md`。

**结论：Cordis 核心（零 native 依赖）可 trivial 编译成 Bun 单文件可执行；dsh 全量表面
"可行但有工程成本"，不是"被卡死"。Claude Code 就是现成先例。**

| 项 | Bun 支持 | 说明 |
|---|---|---|
| `bun build --compile` 单文件可执行 | ✅ | 内嵌 Bun 运行时，客户端无需装 Node；`--target=bun-linux-x64` 交叉编译 |
| `node:child_process`（spawn/PTY） | ✅ | 全支持 |
| `node:worker_threads` | ✅（小缺口） | postMessage/SharedArrayBuffer 支持；resourceLimits/execArgv 部分 |
| `node-pty`（native addon） | ❌ | 历史性坏（oven-sh/bun#7362）；Bun 官方替代 = **Bun.Terminal**（v1.3.5 起） |
| `node-addon-landlock-run`（N-API） | ⚠️ | N-API 可加载，但 `.node` 须**静态 require + 逐 target 预编译**才能嵌入 `--compile` |
| tsdown（Rolldown+Oxc） | ⚠️ | 是 Rolldown+Oxc（非 esbuild）；Bun 下运行是 experimental，跑 bundler 需 Node 22+ |

**Claude Code 先例（前提确认为真）**：Anthropic 自 ~v2.1.113 起把 Claude Code 以
**Bun 编译的 standalone 原生二进制**发布（`curl`/brew/winget 装的就是它；npm 包只是下载并
链接同一二进制的 wrapper，运行时不碰 Node）。**Anthropic 2025-12 收购了 Bun**，部分原因就是
Claude Code 以这种方式 ship。所以"用 Bun 预编译 + 直接 ship binary"不是假设，是存在证明。

**推荐落地路径**（与 Claude Code 一致）：**195 个 npm 包继续用 tsdown 在 Node CI 构建
（不动），只在最终 app 装配 + 编译阶段用 `bun build --compile`**。硬阻塞只有两个：
`node-pty` → 换 `Bun.Terminal`；`node-addon-landlock-run` → 逐 OS/arch 预编译并静态 require。

---

## 2. 异构代码衔接层（Hetero-Language Bridge）

### 结论：官方**已经实现**了"异构语言成为插件模块"，形式 = 进程边界 + IPC 桥

你对"其实是不是 subprocess 倒无所谓，只要逻辑层自洽、实现无感"的判断是对的——Cordis 的
"everything is plugin" 抽象**确实自洽**：从 Cordis 视角看，`PythonCodeRuntime` 就是一个
普通 Service provider；它内部 spawn 一个 Python 子进程、用 fd3 桥接，是藏在 `ctx.codeRuntime`
缝隙背后的实现细节，消费者无感。

### 官方实现（`dsh-code-runtime-python` 的 fd3 帧协议）

仓库里**真实实现**（非 stub）：`packages/code-runtime/code-runtime-python/`（`src/index.ts`
+ `py/protocol.py` + e2e tests）。机制：

- 每个 model program 跑在**全新 `python3 -I` 子进程**里；`stdio: [pipe, pipe, pipe, pipe]`
  的第 4 项 = **fd 3**，作为 framed-JSON 通道；stdout/stderr 留给程序自己的输出。
- **帧 = fd 3 上的 JSON-lines**（每行一个 JSON 对象）。子→宿主：`boot-ack`/`call`/`log`/
  `done`；宿主→子：`boot`（首帧）/`run`（`boot-ack` 后）/每 `call` 一个 `reply`。
- **宿主把每帧都当敌对输入**（`validateChildFrame` 逐字段校验 + 重建）：model 代码对 fd 3
  有完全访问权、可伪造任意帧，所以进站的 forged 字段被丢弃、非有限 call id 不会回显。
- **无损 JSON codec**（无 `JSON.stringify` 深度限制；迭代遍历；超安全整数走 `BigInt`；
  字节计量），保证 `CodeJsonValue` 深度无界也能过线。
- `py/protocol.py` 是 TS `src/protocol.ts` 的镜像：`TypedDict` 形状 + `PROTOCOL_FD = 3` +
  `log_truncation_marker`（**字节级一致**）；`protocol-mirror.e2e.ts` 起真实 `python3` 断言
  两侧字段名/必填性不漂移（曾因 round-12 三次字段漂移而加此守卫）。

TS 侧 `src/index.ts` 把 `PythonCodeRuntime` 注册为 `ctx.codeRuntime` 的 provider——**这就是
"Python 成为 Cordis 插件"的官方答案：TS 宿主侧插件 + 外语子进程 + fd3 JSON-lines IPC**。

### 全部异构缝隙（进程边界是唯一的跨语言方式）

| 缝隙 | 协议 | 边界 | 可达语言 |
|---|---|---|---|
| `ctx.subprocess`（subprocess-local） | stdio + 进程组 | `node:child_process`+node-pty | 任意可执行 |
| `ctx.shell`（bash/pwsh-local） | `bash -c`/pwsh | 出进程 | 任意命令 |
| `dsh-mcp-client` | MCP = JSON-RPC 2.0（stdio / Streamable HTTP） | 出进程/远程 | 语言无关（Python MCP SDK 成熟） |
| `ctx.codeRuntime`（code-runtime-python） | fd3 framed-JSON-lines | Python 子进程 | Python |
| `dsh-sandbox`/`fs-sandbox`/`bash-sandbox` | 策略包装 subprocess/fs | 出进程 | 底层缝隙可达的任意语言 |
| `dsh-typert-*` | Typert RPC 装饰器 + endpoint registry | 进程内 TS 反射 | 仅 TS |

> 注意：默认 `web` profile 只 bundle `dsh-code-runtime-worker-thread`（TS 后端）；Python 后端
> 在仓库里但不随默认 profile 发布，需显式安装。

---

## 3. Rust 重写

### 结论：核心重写**已有人做完**；但"Rust Cordis 兼容纯 TS 插件"不是进程内可行的，"万能"的
真相是"TS 插件变成又一种异构语言桥"

- **Cordis 源码量**：核心实测 **2693 行** TS（9 文件）；上游仓库总 2590 KB（含 docs/tests）。
- **`cordis-rs` 已经存在**（`docs.rs/cordis-rs`）：`@deepseek-ai/cordis` 4.x 的 Rust 移植，
  证明**原生核心（作用域 DI / 生命周期拥有的效应 / Fiber 状态机 / 事件总线 / registry /
  reflect / logger）能干净地移植到 Rust**。Rust 插件走 `plugin_sync`/`plugin_async`，无 JS 引擎。
- **异构语言插件**：当前最佳实践 = **WASM Component Model（wasmtime + WIT/bindgen）**；
  **Extism** 作为便捷多语言 PDK 层（Rust/Python/Go/JS/TS/C#/Zig/C/C++）。
- **"兼容纯 TS Cordis 插件"的真相**：**进程内不现实**。现有 Cordis/dsh 插件是 Node 程序
  （`node:child_process`/`worker_threads`/`node-pty` native addon/ESM import `cordis`/ctx proxy/
  inject epoch/热重载）。**没有任何嵌入式 JS 引擎**能提供这套 Node 面——`deno_core`(V8) 默认
  无 Node built-ins；QuickJS/Boa 无 Node API；Extism JS PDK（QuickJS-ng in WASM）明确无
  事件循环/`child_process`/Worker/fs/net、sync-per-export。因此纯 TS 插件必须**在真实
  Node/Bun 运行时里出进程跑，走 RPC 桥**——即第 2 节的同一种异构桥，恰好是"又多一种插件类型"。

| 机制 | 跨语言 | 能跑现有 JS 插件？ | 先例 |
|---|---|---|---|
| 原生 Rust 核心（cordis-rs） | 仅 Rust | ❌ | cordis-rs（已 ship） |
| WASM Component Model（wasmtime） | ✅（WIT 多语言） | ❌ | wasmtime 生态 |
| Extism PDK | ✅（Rust/Py/Go/JS/C#...） | ❌（JS PDK 无 Node 面） | Extism |
| 嵌入式 V8（deno_core）/QuickJS/Boa | 仅 JS 子集 | ⚠️ 须重实现 `cordis` + ctx proxy + inject epoch | 无先例 |
| **出进程 Node/Bun + RPC 桥** | ✅（任意语言） | ✅（真实 Node/Bun 跑 TS 插件） | 第 2 节 fd3 / MCP |

**诚实成本**：原生核心 8–15k LOC / 4–8 周达到对等；**JS 互操作是真正耗时数月的硬层**
（要么在嵌入式引擎里重实现 Node API 面——无先例，`napi-rs` 是反方向；要么让响应式
inject-epoch 语义跨进程边界保持一致）。所以正确的心智模型不是"Rust 版 Cordis 万能兼容 TS"，
而是 **原生 Rust 核心 + TS 插件作为又一种异构语言类型（出进程 Node/Bun + 桥）**。

---

## 4. 进程内框架与 Recursive Cordis

### 4.1 进程内框架的含义（承接你未完成的 1.5）

Cordis 是**单进程内**的框架：`Context` 是一个进程内的 proxy，服务解析、事件派发、效应撤销
全部在内存中。这意味着**一切跨进程/跨机器的组合都必须显式引入 IPC**——Cordis 自己不提供
"远程 context 镜像"（把一个远程进程的服务透明地当作本地 `inject` 到的服务）。

### 4.2 Recursive Cordis：include 子树 vs alien-binary + IPC 融合

你说的两种方案，可行性截然不同：

**(a) include 子树（直接加载 Dash 插件）——原生、零 IPC、已实现。**
Cordis Multica 作为唯一基底启动 `new Context()`，用 `cordis:include` 把 Dash 的 agent 运行时
插件直接挂到同一根 context 下（`dsh-app-boot` 的 `mountRootInclude` + dsh 自己 per-session
preset 机制就是同一机制）。Dash 自己的 Cordis 基座**不启动**，Dash 插件直接挂在 Multica 下。
**这就是你说的"直接加载 Dash plugin 就行"——正确，这是默认该走的路。**

**(b) alien-binary-plugin（启动一个完整 Dash）+ IPC 融合——可行但"融合"是净新增工作。**
"写一个 plugin 去 spawn 一个完整 Dash binary"本身**trivial**：一个 inject `ctx.subprocess` 的
插件即可。但难点在**"IPC 间的 Cordis 融合"**——把两个 Cordis context 的服务/事件在进程边界
上桥接起来。**Cordis 没有现成的跨进程 context 桥**：dsh 的跨进程原语（`dsh-sdk-jsonrpc-server`
/sdk-client、`dsh-acp`、`dsh-api-remotes`/api-gateway）暴露的是**一个面**（如 agent 面），不是
**context 本身**（任意服务/事件）。所以：

- "大家都是 Cordis，IPC 更容易"在**语义层**成立（共享事件/服务词汇，设计桥时有共同语言）；
- 在**机制层**不成立：桥本身是净新增，官方未 ship。

**判定**：两条路不矛盾。默认走 (a)（零 IPC、原生、已实现）；(b) 只在"必须让一个完整 Dash
独立成进程/独立沙箱/独立升级"时才有意义，且要自建 context-bridge 协议（可复用 sdk/acp/
typert 原语）。当前阶段 (b) 是研究级工作，不是免费午餐。

---

## 来源（本剥离文档相关）

- Bun 官方 docs（`bun build --compile` / Node-API / Bun.Terminal）、`anthropic.com/news/
  anthropic-acquires-bun`、Claude Code quickstart
- `docs.rs/cordis-rs`、`arroyo.dev/blog/rust-plugin-systems`、`extism.org`、`wasmtime`、
  `deno_core` / `rquickjs` / `Boa`、`tartanllama.xyz/posts/wasm-plugins`
- dsh 仓库 `.agents/notes/.../2026-07-31-code-runtime-python-fd3-protocol.md` + `py/protocol.py`（fd3）
