# apps/omp-web — AGENTS.md

本文件是 `apps/omp-web`（`@pgmi-builds/omp-web` 插件）的 AGENTS.md。上层为仓库根 `AGENTS.md`；其规则对本目录仍有效，冲突时以本文件为准。

**本文件只记「坑」**——踩过一次、复发过、或反直觉的契约。改这里任何代码**之前先读本文件**；踩到新坑**当场回写**（就地 inline comment + 本文件；计划层写进 `openspec/changes/<change>/`）。

---

## 〇、一句话架构（dsh-shape-session-log 之后）

OMP 进程内 SDK（sidecar）是 live runtime；**dsh 原生 session log 是 of record**；插件只做两件事：**当 producer**（把 SDK 事件翻译成 SessionEvent 并经宿主 `ctx.sessionPersistence` 落盘）与**当 bridge**（把 OMP 侧的 identity/模型面接进 dsh 契约）。读侧（list/page/replay/workspace）全部由 dsh 原生组件读 `<DSH_HOME>/sessions`；OMP 自己的 runtime 数据在 **插件的 OMP home**（`OMP_HOME = dshHomePath("agents","omp",".omp")` → `<DSH_HOME>/agents/omp/.omp`，OMP 格式），两者 1:1 但互不读。

---

## 一、生命周期：**永远 lazy creation**（复习坑，复发过两次）

**铁律：用户没有发出第一条真正的 user prompt 之前，后端不得存在任何 OMP session/子进程/落盘。**

- UI 的 new-chat 是**浏览器本地**的：workspace / agent preset / model 都还没 frozen，用户可能切来切去再回来（浏览器端自己缓存 draft）。**这段期间 OMP 侧必须零动作。**
- 实现入口 = `LazyOmpRpc`（`src/lazy-rpc.ts`）：构造时不 spawn，第一次 `prompt`/`followUp`/`steer` 才 spawn；`adoptSpawnedChild` 在那一刻写映射。
- **三个路径都必须 lazy（2026-09-16 扩展）**：`createAgent`（create）、`resume` 的「无 OMP 映射」分支，以及 `resume` 的「有 OMP 映射」分支（`--resume <ompFile>` 同样走 `LazyOmpRpc`）。2026-09-15 曾在 resume 分支误用 `OmpSdkClient.spawn(...)`（eager），当场造出一个空 OMP session —— **这是已知复发点，回归测试必查**（`test/sidecar-decouple.test.mjs` 源级断言：`index.ts` 内不得出现 `OmpSdkClient.spawn`）。宿主对 cold session 的 follow-promote（打开即 resume）意味着：WebUI 只浏览/回放也绝不能拉起子进程。
- 为什么不 eager：dsh 原生 session 的 cwd/preset 由 UI 在 prompt 时才定稿；先建 OMP session 会把错误的 workspace 冻进 OMP 侧，与 dsh 的持久化产生分歧。

### 为什么 resume 会被叫到（反直觉）

宿主 `session-controller.createOrAdopt`：`session/create` **带了 `sessionId`** → `checkPersistedIdentity=true` → 只要该 id 在 dsh log 里已存在就**走 resume**。UI 的 new-chat 会先落一个空白会话，所以「点新聊天」也可能命中 resume。

**因此 resume 必须容忍空白会话**：无 OMP 映射 + log 无对话内容（无 `turn/start`/`user/message`/`assistant/message`）→ 视作全新会话，**lazy** 等首 prompt；有内容才 fail-loud（**绝不把 dsh transcript 喂回 OMP**）。

---

## 二、写路径：dsh 原生 session log（producer 角色）

- 取写句柄：`ctx.sessionPersistence.create(header)` / `open(id,'write')`（与 agent-loop 同通道）。**handle 由插件自己持有与关闭**（`setupAndPublish` 的 dispose）。
- live `session.append` → `session/event` → 原生 jsonl backend 按 session id 路由进 handle。**插件不要手搓 append 循环**。
- **`appendUnstoredSuffix` 必须补**：publish **之前** append 的事件（constructor seed、resume 的 `session/end-seed`）**不 emit `session/event`**，必须用 `handle.append(session.snapshotEvents(offset))` 手动冲进 handle —— 否则 writer 看到序号断档（`expected N, got N+1`）→ `drainPaused=true` → **之后所有批次永久卡在 buffer**（症状：文件只有 header + 前几条）。
  - `opts.stored.written` 记录已写偏移；resume 分支要把 `written` 初始化成 `coldRead.events.length`。
- **v3 坐标必须为正**：surface 事件（`system/message` 等）的 `turn`/`step` **不得为 0**（`session-format-v2-to-v3` 校验 `turn must be positive`）。native fresh 会话实测用 `{turn:1, step:1}`。写成 0 会**整批被 writer 拒绝**，症状同样是 drain 卡死。

> 排查这类问题的最快路径：临时在插件里 `ctx.on('session/event')` 打点 + dump jsonl writer 的 `buffered/cursor/drainPaused` + 在 `turn/end` 调一次 `handle.drainLive().catch(log)` —— **错误消息即根因**（我们就是这样拿到 `turn must be positive` 与 `append seq mismatch`）。

---

## 三、bridge index（`bridge-store.sqlite`）：**只存 dsh↔omp 映射**

- 表的唯一职责 = `dsh_session_id ↔ omp_session_id ↔ session_file`，首次 spawn 时由 `upsertCreated` 写入；`resolveEntryById` 用它把 dsh id 翻成 app-home 的 OMP 文件（resume 要 `--resume` 它）。
- **禁止再做 OMP 原生目录扫描 + `prune`**（union 时代遗产）：扫描目标是 `~/.omp/agent/sessions`，而 app-home 产出的映射不在其中 → **每次 reconcile 都把映射删掉** → resume 报 `no OMP session is recorded for this Dash session id`。2026-09-15 已退役（`prepareIndex` 只保 ungrouped workspace）。
- workspace 归组靠 `#attachScannedSessions` 读这张映射表，不再是 OMP 扫描。

---

## 四、patch 层（`cordis.patch.yml`）——**YAML 也是源码**

- **`name` 覆盖被拒**：同一 id 改 `name` 不会重新 import，boot 直接 `patch: name mismatch for "<id>" (expected "<旧>", got "<新>"), skipping`（`--dump-config` 可见）。**整插件替换只能 `disabled: true` 旧行 + `insert` 新行（新 id）。**
- **`directory-picker-auto` 不是普通别名**（踩过：删了它 → UI 的「add workspace」按钮消失）：
  - 该行 boot 时**解析一次**（loopback bind + 非 SSH + linux + 有 `DISPLAY`/`WAYLAND_DISPLAY` + PATH 有 zenity/kdialog ⇒ **native**，否则 browse），然后经 loader **同时挂两面**：host backend 包 + **对应 client surface 包**（`dsh-client-ui-directory-picker-<kind>`）。
  - client surface 占住 workspace picker 的 **directory-flow hole**；`ui-workspace/WorkspacePicker` 是 `flowAvailable ? [ADD_WORKSPACE] : []` —— **hole 空 ⇒ 「add workspace」入口整体消失**（侧栏与 new-chat 两处同时）。
  - 要钉 browse：`insert` **两个**包（backend 在前，surface 在后，顺序即依赖）+ `disabled: true` auto。**只挂 backend 会毁掉按钮。**
- **标题归 OMP，而且是 OMP 真的会生成的**（2026-09-15 修正：此前记录「OMP 侧 title 恒为空」是错的——不是没能力，是我们从没触发它）：
  - OMP session 文件首行是 `{"type":"title","v":1,"title":…,"source":"auto"|"user","updatedAt":…,"pad":…}`：创建时**写空**，之后**原地重写**（`pad` 是预留宽度的填充）。
  - 原生输入路径调用 **`AgentSession.maybeStartTitleGeneration(firstMessage)`**（SDK 公开方法）：它自会跳过 slash 命令 / 已有名字 / 噪声消息（`KPe`），并受 `PI_NO_TITLE` 门控——**OMP CLI 在 `--mode rpc|rpc-ui|acp` 时主动 `PI_NO_TITLE=1`**，所以「机器模式没有标题」是上游的刻意设计。
  - 我们的接线（`sidecar/main.ts`）：首条 prompt 显式调 `maybeStartTitleGeneration(text)`（走 OMP 自己的 prompt/model/逻辑），并订阅 `sessionManager.onSessionNameChanged` + 每个事件后复查 `session.sessionName`（生成是**异步模型调用**，可能晚于本轮结束才落地）→ 发 `session:title` 帧 → `sdk-client.onTitle` → `agent.#applyOmpTitle` 写 `session/title`（`source:{kind:"provider",provider:"omp"}`）。
  - **不要**启用 dsh 的 `session-title-llm`（那条会走 dsh 侧 LLM，属于擅自加功能），它现在保持 disabled。
  - 已知副作用：base `session-title` 的 **fallback**（首条 user message 文本、无 LLM）仍会先发一条 `session/title`，随后被 OMP 标题覆盖 —— UI 上可能有一瞬先 fallback 后 OMP 标题。是否停用 fallback 待裁决。
- 另可复用：`AgentSession.generateTitle(firstMessage, customSystemPrompt?)`（同步返回标题串）、`setSessionName(name,"auto"|"user",trigger?)`。
- `agent-loop` / `agent-presets` / `llm-deepseek` / `llm-pi-ai` disabled；`session-persistence-jsonl` **保持挂载**（唯一的 `sessionPersistence`）。
  - 副作用已知：`agent-presets` disabled ⇒ `pluginInventory/list` 报 `presets.compositionInventory is not a function`（插件清单页不可用），与运行无关。

---

## 五、两个 OMP home（**别混**）

| 名字 | 是什么 | 定义（`src/knobs.ts`） | 默认 |
|---|---|---|---|
| **`OMP_HOME`** | **插件自己的** OMP home = SDK runtime app home（`agentDir`）；`agent.db`/`models.db`/`sessions/` + config 副本落这里 | `process.env.OMP_HOME ?? dshHomePath("agents", "omp", ".omp")` | `<DSH_HOME>/agents/omp/.omp`（未设 `DSH_HOME` 时 `~/.dsh/agents/omp/.omp`）——与 codex 的 `<world>/.codex` 对称；2026-09-16 前 app 文件散落在 world 根，与 dsh 的 `sessions/`/`storages/`/`settings.yaml` 混放 |
| **`OMP_NATIVE_HOME`** | **操作员的原生 OMP** 安装（TUI/CLI）：`agent/config.yml`、`agent/models.yml`、原生 session store | `process.env.OMP_NATIVE_HOME ?? join(homedir(), ".omp")` | `~/.omp` |

- **推导必须用 harness 的解析器，不能读 `process.env.DSH_HOME`**（2026-09-15 实测修）：harness 从不导出 `DSH_HOME`——launcher 不设它时，harness 内部按 `$DSH_HOME ?? ~/.dsh` 解析（`@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()`），而裸读 `process.env.DSH_HOME` 得到 `undefined` → 插件回退到自己的 `~/.omp/omp-web` 兜底 → **app home 落到与 session log 完全不同的树**（实测：`~/.omp/omp-web/agents/omp`，而 dsh 在用 `~/.dsh`）。修法即上表的 `dshHomePath("agents","omp",".omp")`（同款 peer 依赖 + vendored type）。**冒烟必须覆盖「零 env 启动」这条**，本轮正是它暴露的。
- **`OMP_HOME` 里那份「原生」的引用已全部改为 `OMP_NATIVE_HOME`**：config 副本的**来源**（`app-home.ts`）、模型目录的磁盘回落（`models.ts` 的 `OMP_AGENT_DIR`）、`modelRoles` 桥读写的 `agent/config.yml`（`omp-store.ts`）、`OMP_SESSIONS_ROOT`、以及 workspace 排除表（`index.ts`）。
- **绝不要把 `OMP_NATIVE_HOME` 指到 app home / 测试 home**：它是 config/models.yml 的**读取来源**，指到空目录 → 模型磁盘回落读空 → 适配器零 provider → `session/prompt` 报 `model-unavailable`（看着像代码 bug，其实是 env 配错；2026-09-15 真踩过）。反过来，`OMP_HOME` 是**写入目标**，别让它等于 `~/.omp`。
- `sidecar/main.ts` 的 `agentDir` 现在读 `OMP_HOME`（由 `sdk-client.ts` 显式注入，不再叫 `OMP_APP_HOME`）；`sidecar-client.ts` 里那个从未被调用、且会把 `OMP_HOME` 注进 sidecar env 的 `ompHome` 选项已删（与新语义直接冲突）。
- SDK 指认 home 用的是 **`agentDir`**（`createAgentSession({agentDir})` / `discoverAuthStorage(agentDir)` / `Settings.*({agentDir})`），**不是 `OMP_HOME`**（SDK 完全不读 `OMP_HOME`，dist 内 0 处）。配置由 `src/app-home.ts` 一次性从 `~/.omp/agent/` 复制（不覆盖已存在、fail-soft）。
- config 桥（`modelRoles` 双向同步）**仍读写 `~/.omp/agent/config.yml`**（as-is 裁决）；两份 config 的漂移是已知债，留给 config 迁移 change。

---

## 五·五、Sidecar 解耦（2026-09-16 裁决）：**tick 永不 spawn；sidecar 只活在会话窗口**

- **不变量**：`STORAGE_RECONCILE_INTERVAL_MS` 的 tick（workspace attach + default-model sync）绝不触碰 sidecar。周期性目录读取唯一入口 = `callSharedIfLive`（`sdk-client.ts`）：sidecar 不在 → 直接 `undefined`，**零进程**。`callShared`（允许 spawn）只许出现在「真实需要」路径：modelRoles get/set（DSH 侧默认变了才触发）与 `LazyOmpRpc` 首次派发。源级+运行时回归：`test/sidecar-decouple.test.mjs`（含 ps+environ 作用域化进程断言——全套并行跑时全局 `ps` 会看到别的测试文件的 sidecar，必须按 OMP_HOME 过滤）。
- **boot 目录优先**：模型目录 boot 读 `models.db`∪`models.yml`（`loadOmpModels` 磁盘回落）；`ompAvailableModelsSync`/`ompModelRolesSync` 是 **memo-only**（warm 函数已删）；provider 排序的 modelRoles 读 `config.yml` 磁盘（`readOmpModelRolesFromConfig`，mini-YAML 扫描，零 YAML 依赖）。sidecar 活着时 tick 的 `refreshOmpModelsCli` 才搭便车换 memo。
- **skills + slash commands 全磁盘**：`discovery.ts` 不再 import sdk-client；`readSlashCommands`/`readSkills`（`omp-disk-discovery.ts`）扫 omp+claude 的 user/project 根。v1 保真度边界（已裁决接受）：无 embedded 内置命令、无 codex/opencode/cursor 等外来 provider、无 capability 语义（at-imports/managed skills）。命令 boot 挂一次 + `OMP_DISCOVERY_REFRESH_INTERVAL_MS`（knobs，默认 1h，0 禁用）重挂（dispose-then-register，先卸旧集再挂新集）。
- **已知环境坑**：`test/sdk-client.test.mjs` / `test/sidecar-smoke.test.mjs` 真 spawn sidecar 写 DB，沙箱下报 `attempt to write a readonly database`；且 sidecar-smoke 还在用已删除的 `ompHome` 选项（陈旧测试）。stash 验证 HEAD 同挂——环境性失败，待清理。

---

## 六、测试/冒烟锚点

见根 `AGENTS.md` §二。要点：`DSH_HOME=<repo>/.omp-web-test`、profile `omp-web-test`（`link:` 指向本目录）、4999 端口、`systemd-run --user` 拉起（沙箱内直拉 daemon 会 `SANDBOX_UNAVAILABLE`）、token 每次轮换从 `.scratch/*.log` 取水位之后那条。

冒烟必查：① fresh create → 原生 log 全事件落盘；② 重启后 resume（含 blank draft）；③ `session/list` 原生读回；④ `directoryPicker/list` 走 browse；⑤ resume（含**有映射**分支）**没有 eager spawn**；⑥ 浏览/回放旧会话 → 零 `sidecar/main.ts` 进程（`ps -ef | grep sidecar/main.ts`）；⑦ 首 prompt 恰好一次 spawn，idle-exit（10min 默认）后进程消失；⑧ 跨一个 tick（30s）周期零 spawn；⑨ `/` 菜单与技能清单来自磁盘扫描，1h 后自动刷新。
