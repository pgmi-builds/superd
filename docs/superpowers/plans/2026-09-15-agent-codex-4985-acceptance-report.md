# AW-E agent-codex 验收报告（Task 9）与拷回清单

- **日期**: 2026-09-15
- **实例**: `aw-codex-4985-test.service`（systemd-run --user，SUPERD_KEEP=1，**保持运行待 user 亲测**）
- **入口（LAN）**: `http://192.168.31.130:4985/?token=zpo2uUtiqy8FxWSgHsdmOPd8evpiBW1vWRM6epKTKpU`
- **入口（loopback）**: `http://127.0.0.1:4985/?token=zpo2uUtiqy8FxWSgHsdmOPd8evpiBW1vWRM6epKTKpU`
- **端口变更说明**: 计划默认 4987 被另一线占用（`react-codemod-to-lit` 的 vite preview，pid 127421，非本线不动）→ 按仓端口纪律改 **4985**（`AW_PORT` 已接入 start 脚本与 unit Environment）。LAN 中继（可选）：`/usr/bin/socat TCP-LISTEN:4985,fork,reuseaddr,bind=192.168.31.130 TCP:127.0.0.1:4985` + unit 加 `Environment=SUPERD_LAN_HOST=192.168.31.130` 后重启。

## 前置验证（agent 侧已完成）

- 全套测试 **62/62 绿**（60 移植集 + e2e 2）；tsc strict 0；单实例检查 0。
- curl 冒烟：token 303→200；`GET /api/agent-runtime` → `{"runtime":"native","available":["native","codex"]}`（selector RPC 面正常，Codex 在册）。
- smoke 日志：`roster=[{"key":"codex","label":"Codex","ready":true}] codexWorld=true`；world 临时回环 listener 出现（port 0 姿态，46621 仅本机回环）。

## 验收点（user 亲测清单）

1. 打开 token URL → CTX0 原生世界照常（native 会话、模型选择器无异常）。
2. RuntimeSeat/Runtime 切换到 **Codex** → 世界切换零刷新（S1/S6）。
3. 新会话 → 模型选择器应见 **codex 路由**（zhipu_glm_en / GLM-5.2，来自嵌套 home 的 config.toml + cc-switch catalog）。
4. Prompt 一条 → 真 glm-5.2 turn（cc-switch 网关）→ 流式回复、tool 调用可见。
5. Abort → 流中断、状态回 idle。
6. 重启实例（`systemctl --user restart aw-codex-4985-test`）→ resume → 历史复原、续聊正常。
7. 切回 native → 原生世界全程无感；`~/.codex` **零写入**（全部落在 `.superd-test/aw/agents/codex/`）。

## 接线重做（2026-09-15 user 三指令后落地）

1. **app-wide 默认模型 = adapter 自持**（SDK 无此概念）：CodexProvider 启动 + reconcile tick 将嵌套 home `config.toml` 的默认模型经 `agentDefaultModel.saveSelection` 推入世界（单向粘性——config 对 adapter 只读，S7 单向阀；echo 守卫防重放）。e2e 已改为**不手动 selectModel** 直接 create+prompt 全链通过。
2. **`$DSH_HOME` 为输入 → app-home = `$DSH_HOME/agents/codex`**：provider 从世界自身的 `dshHomePath`（boot 提供，插件内不读环境变量）解析 home 并 `setCodexHomeResolver` 钉住；client + catalog 读取全部走该解析。`CODEX_HOME` env 降为文档化的 adapter 级 override。
3. `CodexLlmAdapter` 构造注入 home（catalog 读取不依赖 ambient env）。

## 真实链路取证（2026-09-15，非 fake）

此前 e2e 注入 fake codex 工厂（零 token），只证明管道；以下为**真实链路**实测：

1. **in-process 真 turn**（`test/e2e-live.test.mjs`，`AW_CODEX_LIVE=1` 门控）：真 `@openai/codex-sdk` → SDK spawn 真 codex 二进制 → cc-switch → glm-5.2。回复 `live-ok` 落进 Dash log（含 thinking + text 两条 assistant/message、step/end、turn/end）。
   - 首跑失败暴露真缺陷：provider 把 catalog 占位符 `codex-default` 当真模型推给线程 → 真 codex 卡在 turn/start。**修复**：占位符双侧守卫（push 跳过、create 省略 model 让 config.toml 默认生效）+ 工厂 create 时确定性注入 catalog 真实模型。
2. **真 WebUI wire**（`test/wire-proof.mjs`，HTTP，无进程内捷径）：`POST /api/agent-runtime`（selector 翻转，UI RuntimeSeat 等价）→ `POST /api/session/create`（agentPreset=**codex**）→ `POST /api/session/prompt`（accepted）→ `POST /api/session/page` 读回完整一轮 → assistant text `["wire-ok"]`。
   - wire 形状：unary RPC = `POST /api/<ns>/<method>`，envelope `{type:"client-request",rpcId,method,payload}`，payload 即 gateway 的 `{args:{request}}`；响应 `{type:"server-response",rpcId,result:{ok,value|error}}`。`/api/remote.mux` 是 **WebSocket** 路由（实时流），不是 unary 通道。

### 发现（待裁决 / 观察）

- **[真问题] 共享 settings 串味**：codex world 的 app-wide 默认模型推送写进**共享 settings**；此后在 ctx0 新建的 native 会话会继承 `codex/glm-5.2`，prompt 报 `session/model-unavailable: no adapter serves provider "codex"`（实测一次）。候选修复 = world fixture 加 `settings.path` 隔离（settings-under-profile，omp 线同款思路），属设计裁决。
- **[观察] turn 活动期 HTTP 轮询 `session/page` 会阻塞**（turn 结束后立即恢复；早前 cursor=10 用例 200 正常）。WebUI 实时面走 `/api/remote.mux` WS 推送，不受影响；纯 HTTP 轮询读回需等 turn 收敛。

## SDK 能力边界（实证，`@openai/codex-sdk@0.154.0` 类型声明全文）

```ts
class Codex  { constructor(options?); startThread(options?); resumeThread(id, options?) }
class Thread { get id(); runStreamed(input, turnOptions?); run(input, turnOptions?) }
```
**零 app-wide 设施**：无默认模型、无模型列表、无 workspace 列表、无 session 列表、无 fork、无查询。唯一“世界知识”是 `resumeThread` 文档里那句 *"Threads are persisted in ~/.codex/sessions"*（即 rollout 扫描是 session list 的唯一权威）。故 model list / session list / workspace / default model 四项必须 adapter 自持（已建：`models.ts` / rollout 扫描 / `dsh-workspace` reconcile / `agentDefaultModel` 推送）。

## 客户端 surface 交付层（2026-09-15 关键发现）

**client surface 的清单由「服务 HTML 的那个 composition」静态产出**（`window.__DSH_BOOT__.entries`），不是按 selector 动态取。世界的 web face 是 loopback 临时端口（S4），其 client 行**到不了浏览器**——实测：把 `directory-picker-browse` 两面放进 adapter bundle patch 后，世界行表正确（`picker-auto` disabled + 两面 inserted，`--dump-config` 验证），但 ctx0 的 boot 载荷仍只有 `directory-picker-native`。

**修复 = 同一组行挂到 ctx0 侧 patch**（`test/smoke-codex.mjs` 的 aw-ctx0 provisioner + 部署 profile）：mount browse 两面 + `- id: directory-picker / disabled: true`（auto 行在本机解析为 `native` 桌面对话框，洞空 → WorkspacePicker 隐藏 add workspace 入口）。验证：重启后 `__DSH_BOOT__.entries` 出现 `dsh-client-ui-directory-picker-browse`（native 面消失），客户端 bundle `/plugins/??@deepseek-ai/dsh-client-ui-directory-picker-browse/client.js` HTTP 200/49KB 真实模块，日志零错误。

**架构含义**：adapter 的 UI 面（omp 线先例 = `@pgmi-builds/agent-adapter-omp/client` + package.json `dsh.client` 块）属于「浏览器侧 composition」；世界 bundle patch 只承载数据面行。AW 后续若要让运行时切换同时切换 UI 面，需要 hub 侧的 per-runtime surface 交付（世界的 ephemeral face 不可达，S4 禁 HTTP 代理）——当前 V1 取值：UI 面挂 ctx0。

## 两层分离的取证（2026-09-15 澄清）

- **服务端（in-pid world）= 好**：4985 的进程同时持有两个监听 —— `127.0.0.1:4985`（ctx0 用户面）与一个 OS 分配的临时口（本次启动 `37791`，上次 `36635`），**同一个 pid** ⇒ codex world 确实在 ctx0 进程内 spawn。发现方式：日志两条 `dsh web: http://127.0.0.1:<port>` + `ss -tlnp | grep pid=<MainPID>`；端口每次重启重选（`webserver.port: 0`）。
- **浏览器侧（client surfaces）**：`window.__DSH_BOOT__.entries` **只**描述客户端插件面，与服务端行表无关；`@pgmi-builds/*` 缺席 ≠ 世界没起来。缺的是 hub 的 client 产物：`agent-hub/lib/client/index.js` 从未构建 ⇒ RuntimeSeat（agent selector UI）不在清单里。修复：`npm run build-client`（externals 对齐 omp 先例补 `react/jsx-runtime`），并把它写进 `test/smoke-codex.mjs` 的 provision 步骤（产物存在是进清单的前提）。验证：清单出现 `"id":"@pgmi-builds/agent-hub"`，`/plugins/??@pgmi-builds/agent-hub/client.js` HTTP 200 / 7.2KB 真实模块。

## 独立 app 形态（2026-09-15 落地，绕开 ctx0 selector）

`apps/agent-worlds/test/start-codex-app.sh`（`AW_APP_PORT`，默认 4988）把 codex world **直接当主 app 起**：一个 dsh 进程，composition = adapter bundle（`aw-codex-app` profile：base + web-app + `@pgmi-builds/agent-adapter-codex`），无 hub、无 spawn、无 selector。LAN 走 socat relay（只绑 LAN IP）。

实测（端口 4989）：`llm/listProviders` → `[{"id":"codex","name":"Codex"}]`；`agentPresets/list` → 单一 `codex` preset（isDefault）；`session/create` → `agentPreset=codex`；`session/prompt` → 真 glm 回复 `standalone-ok`，事件链完整（turn/start → user/message → assistant/message → step/end → turn/end）。boot 清单含 `dsh-client-ui-directory-picker-browse`（本 app 自己服务 HTML，故 add workspace 在此形态下生效）。

## 独立 home 化 + 两处真缺陷（2026-09-15 深夜）

`start-codex-app.sh` 现在默认 **专属 home** `AW_APP_HOME`（默认 `<WT>/.superd-test/codex-app`）：adapter 包在被单独测试时拥有全部 DSH 级状态（workspace 注册表 / settings / session log），不再被共享 `.superd-test/aw` 里别条线的残留污染。

**缺陷 1（真，已修）**：catalog 读取把 **DSH home** 传给了期望 **codex home** 的 `readCodexModelCatalog` ⇒ 找 `<dshHome>/config.toml` 失败 ⇒ 返回占位符 `codex-default`。后果：默认模型推送写占位值、模型选择器 provider 名回退 "Codex"。此缺陷只在 settings 已存在（早期误写）时被掩盖；专属 home（无 settings）立刻暴露为 `session/model-unavailable: no adapter serves provider "deepseek-official"`。修复：所有读取点改传 `resolveCodexHome(this.home)`（`<home>/agents/codex`），adapter 构造同样。修复后：推送 `deepseek-official/deepseek-flash → codex/glm-5.3-flash`，`settings.yaml` 落真值。

**缺陷 2（真，已修）**：新增的会话路由覆盖方法先用真私有 `#` 命名 ⇒ Cordis tracing-proxy `TypeError: Receiver must be an instance of class CodexProvider`（与早前 `#followThreadId` 同款陷阱）⇒ 改 TS-`private`。

**测试卫生**：专属 home 下 `world-plugin/e2e-world` 曾因我的启动脚本把 `@pgmi-builds/agent-adapter-codex` 链到不存在的目录名（真实目录是 `agent-codex`）而 EEXIST 失败；修正映射后 **62/62 在该 home 也全绿**。

## 数据面归属（2026-09-15 取证）

- **workspace 清单 = 上游 `dsh-workspace` 注册表**：`<home>/storages/workspace.json`（unit `workspace` v2, global.workspaceIds + tables.workspaces[].path）。共享 home 里那 17 条来自别条线（dashr/dsh-omp/orchestra/tgg/sidecarx/base/temp…），**不是 codex adapter 建的**；专属 home 下从 0 开始。adapter 只补上游做不到的两件：rollout 扫描出会话清单、把扫描到的会话 attach 进注册表（上游只在首次 boot 自动分组）。
- **adapter 自有 app 数据 = `<home>/agents/codex/`**：`config.toml`/`auth.json`/`cc-switch-model-catalog.json`（由 setup 脚本从 `~/.codex` 单向拷入）+ codex 自己的运行时状态（`sessions/2026/…/rollout-*.jsonl` 22 个、`state_*/logs_*/memories_*/goals_*/queue_*.sqlite`、`skills/`、`.tmp/plugins`、`installation_id`）。该目录内无任何 Dash 物化数据。
- **session stream → DSH session log：是**。adapter 把 codex 线程事件投影成 Dash 会话事件写入 session log（`permission/preset…turn/end` 整链，UI/session replay 读的就是它）。adapter composition 里 `session-persistence-jsonl` 为 `disabled: true`（`--dump-config` 验证），故 codex 会话活在 adapter 的 union persistence（进程内）+ codex rollout（原生记录）；共享 home 里的 `<home>/sessions/**` jsonl 目录来自 **其它 composition**（ctx0/native 与测试 boot，那些 jsonl 行是启用的）。

## 已知边界（V1，SDK 线）

- steer = 队列 followUp 近似；setModel = 下一 turn 生效；审批 = launch-only preset；usage 在 assistant/message 上有一 turn 滞后显示。

---

## 拷回主 checkout 收尾清单（finishing-a-development-branch）

worktree：`.scratch/aw-codex`（branch `aw-codex-adapter`；docs 已按任务 commit 至该分支）。`apps/agent-worlds/` 在 `.git/info/exclude`（全 worktree 共享）——**线代码不入 git，以下为文件拷贝清单**（worktree → 主 checkout 同路径覆盖）：

| # | 路径（相对仓根） | 说明 |
|---|---|---|
| 1 | `apps/agent-worlds/agent-codex/` **整目录**（除 node_modules/dist/.gitignore 声明的产物） | 新包 `@pgmi-builds/agent-adapter-codex`（src/test/types/scripts/cordis.patch.yml/package.json/tsconfig） |
| 2 | `apps/agent-worlds/agent-hub/test/zero-port.audit.test.mjs` | 小修：spawnWorld 补 `bareModuleBaseUrl: process.env.AW_BARE_BASE`（主 checkout hub 测试同款环境韧性） |
| 3 | `apps/agent-worlds/test/smoke-codex.mjs` + `test/start-4985.sh`（原 start-4987.sh 改名） | 线集成 bootstrap + 验收实例脚本（AW_PORT/lan 可调） |
| 4 | `docs/superpowers/plans/2026-09-15-agent-worlds-agent-codex-adapter-plan.md` + 本报告 | 分支 `aw-codex-adapter` 上已有 commit（088557d/99ec747/48147d2 等一串）——docs 侧可整分支 merge 或 cherry-pick |
| 5 | 主 checkout 拷回后动作 | `apps/agent-worlds` 目录内对应文件以 worktree 版本覆盖；`apps/agent-worlds/agent-codex/node_modules` 主侧重新 `npm install --cache .npm-cache`；单实例检查；主 checkout 的 `.superd-test/aw/profiles/node_modules/@pgmi-builds/` 增补 `agent-adapter-codex` symlink；`aw-codex-world` fixture 如需在主线亦可拷入 `agent-hub/test/fixtures/` |

**不拷回**：worktree 根 `node_modules/`（farm + @pgmi-builds 链，主 checkout 自有）；`.superd-test/`；`.scratch/aw-codex-4985.log`。

**收尾后主 checkout 验证**：`apps/agent-worlds/agent-codex && npm run build && (env 同款) node --test test/*.test.mjs`（除 spike/live）→ 62/62；hub 15/15；`find node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l` → 仅 `dsh-client-ui-slots`。

## DSH-native session 管理 + 事件映射补全（2026-09-16 落地并实测）

**session 管理（改自 OMP 的「自带持久化 + 自解析 replay」为 DSH-native）**
- 启用上游 `session-persistence-jsonl`（adapter bundle patch 里那条 disable 已移除）；工厂按上游 agent-loop 的方式持有写通道：create `persistence.create(header,…)`，resume `open(id,'write')` → `read(0,…)` → `interruptedTurnClosers` → `prepare({seed, meta: handle.header, inheritedEventCount, eventState})`；`setupAndPublish` 在发布点刷未存后缀、dispose 时 `handle.close()` 排空并上抛持久化错误。
- 删除 `src/session-persistence-codex.ts`（联合持久化 + rollout 扫描 list）、`src/replay.ts`（自解析 replay）、`src/knobs.ts`；`codex-store.ts` 精简为 home 解析 + rollout **首行**元数据读取（仅供系统提示）。
- 身份 = 一张极小的映射 `<codexHome>/dsh-sessions.json`：`dshSessionId → {threadId, cwd, createdAt, preset}`；`threadId` 在 Codex 物化后回填；resume 查不到（或 thread 从未启动）**fail-closed**。

**实测（4989 独立 app，专属 home；非 fake）**
- 真 turn：`turn/start → request/context{provider:codex, model:glm-5.2, contextWindow:1000000} → user/message → session/title → step/start(1,1) → system/message(1,1) → assistant/message → step/end → turn/end`，回复 `dsh-native-ok`。
- 落盘 DSH 日志：`<home>/sessions/<cwd-slug>/<sessionId>/session.v3.jsonl.zstd`（zstd 解出上述 13 行 + header `agentPreset=codex`）。
- **重启后**：list 由 DSH 持久化提供（19 条，id 全是真实 DSH id，无 `session-codex-*` 合成 id）；replay 直接来自 DSH 日志；对冷会话 prompt 成功 → 日志出现 `session/end-seed`（seed 恢复路径）→ 新 turn 完成，回复 `resumed-ok-ok`。
- 事件映射（真 turn 实测）：`system/message` 携带真 Codex 系统提示（21,335 字符）；reasoning 块为 `{type:'reasoning', text}`；`tool/call.arguments` 为原始 JSON 串（`{"command":"/bin/bash -lc 'echo tool-ok'"}`）+ `tool/result` 经 `createToolResultMessage` 形状、`source.callId` 配对。
- 测试：`node --test test/*.test.mjs` → **72 tests / 70 pass / 0 fail / 2 skipped**（live 门控）；tsc strict 0。

**本轮发现的两个真缺陷（由实测抓出，均已修）**
1. **step 生命周期押在 `message_start` 上**：Codex SDK 对纯文本回复只发 `item.completed`（无 `item.started`），于是整轮没有 `step/start`、step 恒为 0 —— 违反上游「step-scoped 事件必须落在已开 step 内」，并连带使 `system/message` 被跳过（它要求 step ≥ 1）。修复：step 改为**按需开启**（turn_start 即开 + 每个 step-scoped 事件前兜底），`step/end` 仅在确实有开 step 时追加。
2. **`payload.base_instructions` 是对象**（`{text}`）而非字符串（2026-09-16 的 vendored 二进制行为），原读取器只认字符串 ⇒ 系统提示永远空。修复：两种形态都接受。

**未接（明确记录）**：`compaction/*`、`todo/write`、`subagent/*`、`model/selection`（app-wide 默认模型另走 settings 推送）、`request/header`；approval 仍为 launch-only 预设降级（Codex SDK 无运行时审批；app-server 线才有 `*/requestApproval`）。


## 拷回主 checkout 执行结果（2026-09-16）

- **4989 实例已停**（`aw-codex-app-4989-test` + `aw-codex-app-4989-relay` → inactive，端口释放）。
- **已拷贝**（worktree → 主 checkout）：
  - `apps/agent-worlds/agent-codex/`（src / test / types / scripts / cordis.patch.yml / package.json / tsconfig.json；node_modules 与 dist 在主侧重新生成）
  - `apps/agent-worlds/test/{smoke-codex.mjs,start-4985.sh,start-codex-app.sh}`（`start-codex-app.sh` 的 `WT` 已由 worktree 路径改为主 checkout 根）
  - `apps/agent-worlds/agent-hub/test/zero-port.audit.test.mjs`
  - 主 checkout `.superd-test/aw/profiles/node_modules/@pgmi-builds/` 增补 `agent-adapter-codex` + `agent-hub` 链接
- **主侧验证**：`npm install --cache .npm-cache`（7 packages）→ `npm run build`（tsc strict 0）→ `node --test test/*.test.mjs` = **72 tests / 67 pass / 0 fail / 5 skipped**；仓根单实例检查（`find node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l`）为空。
- **测试可移植性修复**：测试原先用固定层数（`new URL('../../../../../..')`）推导仓根，只适用于 worktree 深度；改为**向上探测** `upstream/deepseek-harness/package.json` 定位仓根，并让 fixture 建链能替换悬空链接（EEXIST 韧性）。
- **AW-B 代差（主侧 hub 已升级，跟踪项）**：主 checkout 的 `agent-hub` 是 AW-B 线（single-origin carrier：`carrier.ts` / `envelope.ts` / `ownership.ts` / `world-web-server.ts` / `world-entry.ts`，**无服务端 selector**，世界按挂载路径寻址），而本包的 `world-plugin`/`e2e` 仍用旧 hub 的 `writeSelector` 模型。主侧 e2e 因此显式 skip（原因写在 skip 文案里），**world-plugin 移植到 AW-B mount carrier 是下一步工作**。
- worktree `.scratch/aw-codex`（branch `aw-codex-adapter`，docs 提交在此）暂留，待 docs merge/cherry-pick 后清理。


## Home 布局纠偏 + 每会话路由钉住（2026-09-16）

**布局（user 裁定）**：`$DSH_HOME` = 测试 home（`<repo>/.superd-test`）；agent app home = `$DSH_HOME/agents/<label>`；agent dsh profile packages = `$DSH_HOME/profiles/<label>`。
- 删除了我自造的 `<repo>/.superd-test/codex-app`（worktree 同名目录一并删除）；`start-codex-app.sh` 改为 `AW_APP_HOME` 默认 `.superd-test` + `LABEL=codex` → profile 落在 `profiles/codex`、codex home 落在 `agents/codex`。
- 测试默认 home 同步改为 `.superd-test`（`codex-client.live`/`spike`）。

**每会话路由钉住（真缺陷修复）**：共享 test home 的 `settings.yaml` 里带别的线默认值（`deepseek/deepseek-v4-flash`），而 adapter 的 app-wide 默认模型推送经 settings 服务**异步落盘**——首个会话因此在 `session/model-unavailable` 被拒（实测）。
- 修复：工厂在 create/resume 时同步钉住本会话路由——照上游 `session-controller` 的 `selectForNextRequest` 机制（其私有对象不可达），追加 log-only `model/selection` + `installModelSelection(agent.ctx, {current, assembled})`；provider 侧不再只依赖全局默认。
- 实测（标准 home、settings 默认属别线）：真 turn 回复 `dsh-native-ok`；`request/context {provider:codex, model:glm-5.3-flash}`；`system/message`（Codex 系统提示）在册；reasoning 块在册；日志 `session route pinned: codex/glm-5.3-flash`。
- 测试：`node --test test/*.test.mjs`（`DSH_HOME=.superd-test`）= **67 tests / 66 pass / 0 fail / 1 skipped**；tsc strict 0。

**同时**：world-plugin 与其世界形态测试/线脚本已从包中移除（见前节），包只保留"自身作为 web app 点亮"所需的最小面。
