# DSH Web UI ↔ 后端数据段全量清单(wire 层)

> 记录:2026-09-03 · 采集对象:4999 测试实例(upstream tag `dsh-v0.1.2-alpha.5`,真实 DEEPSEEK key,真实浏览器)
> **采集方法(双源交叉,非纯手读代码)**:
> ① **静态全量**:tsc 类型检查器脚本(`.scratch/extract-remotes.mjs`)递归展开全部 17 个 RPC 命名空间 × 77 个方法、
> 51 种会话事件的请求/响应**类型树**(含运行时抓不到的可选字段,JSDoc 随行);
> ② **运行时实抓**:playwright 驱动真实 Chromium(`.scratch/capture-webui.mjs`),5 个阶段把 UI 从 boot 到
> 发消息/开 trajectory/搜索/feedback/fork/export 全部走一遍,录下**每一笔 HTTP 请求响应体 + 每一帧 WebSocket**
> (28 个端点 live 实测、WS mux 全帧型)。
> 机器可读工件:`webui-wire-data/`(remote-inventory.json / session-events.json / observed-endpoints.json /
> ws-frame-examples.json / capture-live-turn.json / served-index-sample.html)。
> 附录:`dsh-webui-wire-appendix.md`(其余 16 命名空间全字段树 + 51 事件全字段树)。

本文回答一个问题:**浏览器里的 Web UI 到底从后端读什么、往回写什么——每个字段是什么。**
(不谈代码组织;全部以 wire 上实际传输的 segment 为准。)

---

## 0. 总览:6 条数据通道

| # | 通道 | 协议 | 谁产生 | UI 消费点 |
|---|---|---|---|---|
| ① | 静态资产 | GET `/assets/*`(shell: index+vendor JS/CSS、shiki 语言包)、GET `/plugins/??<id1>/client.js,<id2>/client.js&rev=<hash>`(51 个插件 bundle 合并拉取) | 后端文件服务 | 页面引导,一次性 |
| ② | index 注入 | HTML 内联:`<base>`、queue script(`window.__ModuleLoader__` 门面)、combo preload、**boot graph** `globalThis.__DSH_BOOT__`、主题脚本、`__DSH_BOOT_READY__` resolver | 后端渲染 index 时注入 | 引导:告诉浏览器装哪些插件、从哪拉、依赖什么服务 |
| ③ | unary RPC | POST `/api/<endpoint>`(endpoint = `<namespace>/<method>` 或点号形式如 `session.export`),JSON envelope,见 §2 | typert gateway 分发到各服务 | **UI 的几乎全部数据读取与动作提交** |
| ④ | 裸 fetch 路由 | `/api/` 前缀下的普通 HTTP 路由(插件可注册;实测:`GET /api/session.export` 流式 zip) | Connection fetch 载体 | 会话日志导出下载 |
| ⑤ | 流复用 | WS `/api/remote.mux`,帧见 §3(session/follow、session/control、workspace/follow、`$events` 转发事件) | gateway WS mux | 活跃回合实时流、推送事件、投影 |
| ⑥ | 附属通道 | `/plugins/events`(HMR,dev-only)、**插件自有 HTTP/WS 面**(实测:`/sidebar/api/*`、`/sidebar/ws/agent-terminals` 等) | 插件直接注册 | 开发热更;插件自有面板 |

**认证**:`?token=<一次性>` → 303 → HMAC 签名 cookie `dsh-auth-<authority>`(按访问域签发,24h);此后所有 ③④⑤ 带 cookie。
(对对接方的意义:会话级令牌换 cookie,或换成你自己的鉴权——UI 侧只要求"请求被放行"。)

---

## 1. boot graph 数据段(通道②)

`__DSH_BOOT__` = `{"rev":"<内容hash>","entries":[…51 行…]}`,每行字段:

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | string | 浏览器模块 id = npm 包名(如 `@deepseek-ai/dsh-client-ui-trajectory`) |
| `url` | string | bundle 拉取地址 `/plugins/??<pkg>/client.js&rev=<row-specific rev>` |
| `rev` | string | 内容 hash(immutable cache 键) |
| `inject` | string[] | 该插件等待的**浏览器侧 cordis 服务名**(依赖边;缺失则插件 pending) |
| `immediately` | boolean? | 引导阶段预取标记 |

实样见 `webui-wire-data/served-index-sample.html`(4999 实抓,24,954 bytes)。

## 2. unary RPC envelope(通道③)

```jsonc
// 请求体(POST /api/session/list)
{"type":"client-request","rpcId":"<uuid>","method":"session/list","payload":{"args":[{/* 请求对象 */}]}}
// 响应体
{"type":"server-response","rpcId":"<同上>","result":
  {"ok":true,"value":{/* 业务值 */}}            // 成功
  // 或 {"ok":false,"error":{"code":"session/not-found","message":"…","details":{…}}}  // 失败
}
```

- envelope 自描述、与传输解耦;错误码全表见附录各命名空间(每域 `RemoteErrorDetailsMap` 合并声明)。
- 实测幂等调用(GET 语义)与写调用(prompt/put/fork/rename)走同 envelope。

## 3. WS 流帧格式(通道⑤ `/api/remote.mux`)

```jsonc
// 客户端 → 服务端:开流
{"type":"open","streamId":"<uuid>","endpoint":"session/follow","payload":{"args":{"request":{…}}}}
// 服务端 → 客户端:逐值推送(同一 socket 多路复用,按 streamId 关联)
{"type":"item","streamId":"<同上>","value":{"type":"snapshot"|"event"|"projection"|"queue"|"baseline"|"ready"|"emit", …}}
```

实测四条流与帧型:

| 流(endpoint) | 帧型 `value.type` | 载荷 |
|---|---|---|
| `session/follow` | `snapshot` | `header`(见 §4)+`cursor`+`records[]`(事件/chunk run)+`hasMore`+`projections`(投影基线) |
| | `event` | 单个会话事件(§附录事件全表;实抓 12 种:`turn/start→end`、`step/start→end`、`user/message`、`assistant/chunk`、`assistant/message`、`request/header`、`request/context`、`session/title`、`session/title-llm-request`、`agent/inbox/spliced`、`permission/preset`) |
| | `projection` | `{sessionId,key,value,seq}` — 投影推送;实测 key:`turnOutline`/`sessionStats`/`contextPressure`/`contextBreakdown`/`tokenUsage`/`title`/`modelSelection`/`plan`/`subagentTiming`/`sessionListMetadata` |
| | `queue` | 排队消息镜像 `{sessionId,items[]{id,placement,rpcId,message}}` |
| `session/control` | `baseline` | 活跃控制基线:queues(每会话排队)/jobs(后台作业)/subagents 等 |
| `workspace/follow` | `baseline`(+变化) | 工作区树:items[]{workspaceId,path,title,sessionIds[]} |
| `$events` | `ready` | `{clientId,host:{home}}` |
| | `emit` | 转发宿主事件 `{event,args[]}`;实测:`api-session/status`、`api-session/activity`;静态 allowlist 18 项(附录) |

## 4. 会话 header(每个会话的元数据段,snapshot 第一字段)

实抓:{"version":0,"id":"session-…","createdAt":<epoch ms>,"cwd":"…","delegationDepth":0,"agentPreset":"standard"}
静态全字段:`version`、`id`、`createdAt`、`cwd?`、`parentSessionId?`(fork 血统)、`isSeeded`、`origin?`(subagent)、`delegationDepth`、`agentPreset?` 等——完整树见附录 session/follow。

---

## 5. UI 表面 → 数据段消费矩阵(live 实测)

| UI 操作/表面 | 触发的数据段 |
|---|---|
| 打开页面(boot) | ①② + `settings/describe`、`credentials/describe`、`dynamicCordisRunner/inventory`+`syncInspectManifest`、`agentPresets/list`、`session/modelCatalog`、`session/list`、`commands/list`、`skills/list`、`subagents/list`、`llm/listProviders`+`listConfigurableProviders` + ⑤ 三流(control/workspace/$events) |
| 侧栏点开会话 | `session/follow` 流(snapshot 全量事件 + projections 基线) |
| 发一条消息 | `session/prompt` → 实时 `agent/inbox/spliced`、queue、turn/step、user/message、request/header、assistant/chunk(打字机)、assistant/message(含 usage)、session/title、projection×N |
| Trajectory 标签页 | (零新 RPC)消费同一 follow 流里的 `request/header.system/tools/config`、`request/context`、每 turn/step 结构 |
| 搜索会话 | `session/search`(snippet 上限 240 码点,结果上限 20) |
| 👍/👎 | `messageFeedback/list` + `messageFeedback/put` |
| Branch 新分支 | `session/fork` + `session/create` + `session/rename`(自动命名) |
| Session log 导出 | 裸路由 `GET /api/session.export`(zip 流) |
| Settings 页 | `settings/describe`(读写经 settings/get/set,本轮未触发写) |
| 模型选择器 | `llm/listProviders`、`session/modelCatalog` |
| (better-sidebar 插件面板) | 插件自有面 `/sidebar/api/shell.get`、`fs.tree`、`settings.get` + `/sidebar/ws/agent-terminals` |

**未触发但静态可用**(对接时按需):`session/page` 冷分页(follow 已覆盖同数据)、`session/cancel`、`session/updateQueue`(排队编辑/移除/steer)、`session/attachment`、`session/selectModel`、`session/openWorkspacePath`、`session/attachment`、`workspace/*` 写方法、`settings/get|set`、`credentials/*`、`goals/*`、`subagents/follow`、`fileReferences/*`、`dynamicCordisRunner/*` 其余 10 方法、`sessionReferenceResolver/candidates`。

---

## 6. `session/*` 命名空间全字段(核心,16 方法,类型树全展开)

### `session/*` — 会话核心(16 方法)

#### `session/list` · unary · ◉ **live 实测**

Read all visible Session rows without resuming an Agent.

**Request 字段:**
- **SessionListRequest**
  - `cursor?`: string

**Response 字段:**
- **SessionListValue**
  - `items`: object[]
    - *(元素)*:
      - `sessionId`: string ⌾SessionId
      - `updatedAt`: number
      - `running`: boolean
      - `blank`: boolean
      - `parentSessionId?`: string ⌾SessionId
      - `origin?`: string
      - `cwd?`: string
      - `projections?`: object
        - `asOfSeq`: number
        - `values`: object — Provider-validated values present in the cache; omitted keys remain unknown.
          - `title?`: string — The session's current normalized title — the latest `session/title` event's text (last-wins), or `null` before the first title lands. A plain string: the shape…
          - `agentPreset?`: string — Preset the Session runs, or null when the deployment composes none.
          - `sessionListMetadata?`: object — Persisted facts used to summarize a Session without activating it.
            - `blank`: boolean — Whether the folded prefix contains no turn.
            - `lastPromptAt`: number — Latest human-authored prompt time in the folded prefix.
          - `imageLimits?`: object — Image-intake limits enforced by the Session prompt endpoint.
            - `maxImageBytes`: number
            - `maxImagesPerMessage`: number
            - `maxMessageImageBytes`: number
            - `maxImagePixels`: number
            - `maxImageDimension`: number — Maximum intrinsic width and maximum intrinsic height in pixels for one image.
            - `mediaTypes`: string|string|string|string[]
          - `modelSelection?`: object — Durable model selection already used and selected for the next request.
            - `lastUsed`: object — Selection consumed by the latest recorded model request.
              - `provider`: string
              - `model`: string
              - `reasoningEffort?`: string
            - `next`: object — Selection the next request should use, falling back to {@link lastUsed}.
              - `provider`: string
              - `model`: string
              - `reasoningEffort?`: string
          - `subagentTiming?`: object — Active-turn duration for a descriptor-backed subagent session.
            - `settledMs`: number — Milliseconds accumulated across completed turns after the child's own descriptor.
            - `active?`: object — Same-cut bounds of the currently open turn, when one has not reached `turn/end`.
              - `since`: number — Start of the open turn.
              - `through`: number — Latest event time folded into this projection cut.
          - `subagent?`: object|object — Identity of a descriptor-backed subagent session. `null` ⟺ no valid descriptor (missing, malformed, or unrecognized-version — deliberately undistinguished). Th…
            - 变体 `{ mode: "one-shot"; label?: string; seq: SessionSeq; }`:
              - `mode`: string — A terminal one-shot child.
              - `label?`: string — Optional durable creation label from the child's descriptor.
              - `seq`: number — Seq of the `subagent/descriptor` event this identity was folded from. `session.isOwnSeq(seq)` proves the identity comes from the child's OWN log suffix — where…
            - 变体 `{ mode: "continuable"; label: string; seq: SessionSeq; }`:
              - `mode`: string — A resumable conversation.
              - `label`: string — Durable creation label from the child's descriptor.
              - `seq`: number — Seq of the folded descriptor event; see the one-shot arm for the own-suffix proof.

#### `session/search` · unary · ◉ **live 实测**

Search visible Session content without resuming an Agent.

**Request 字段:**
- **SessionSearchRequest**
  - `query`: string

**Response 字段:**
- **SessionSearchValue**
  - `items`: object[]
    - *(元素)*:
      - `sessionId`: string ⌾SessionId
      - `snippet`: string
  - `hasMore`: boolean

#### `session/create` · unary · ◉ **live 实测**

Create or idempotently adopt one ordinary Session.

**Request 字段:**
- **SessionCreateRequest**
  - `workspaceId?`: string
  - `cwd?`: string
  - `sessionId?`: string ⌾SessionId
  - `agentPreset?`: string

**Response 字段:**
- **SessionCreateValue**
  - `sessionId`: string ⌾SessionId
  - `agentPreset?`: string

#### `session/selectModel` · unary · ○ 静态可用(本轮未触发)

Select one Session-local model after explicitly resuming the Session.

**Request 字段:**
- **SessionSelectModelRequest**
  - `sessionId`: string ⌾SessionId
  - `provider`: string
  - `model`: string
  - `reasoningEffort?`: string

**Response 字段:**
- **SessionSelectModelValue**
  - `selected`: object
    - `provider`: string
    - `model`: string
    - `reasoningEffort?`: string

#### `session/modelCatalog` · unary · ◉ **live 实测**

Describe every currently routable model for Host-generation selectors.

**Request 字段:**
- *(无参数)*

**Response 字段:**
- **ModelCatalog**
  - `default`: object
    - `provider`: string
    - `model`: string
    - `reasoningEffort?`: string
  - `routableProviders`: string[] — Provider routes currently able to serve a request, including empty catalogs.
  - `groups`: object[]
    - *(元素)*:
      - `id`: string
      - `name`: string
      - `models`: object[]
        - *(元素)*:
          - `id`: string
          - `name`: string
          - `description?`: string
          - `reasoning?`: object
            - `efforts`: object[]
              - *(元素)*:
                - `id`: string
                - `name`: string
                - `description?`: string
            - `defaultEffort?`: string
  - `failures`: object[]
    - *(元素)*:
      - `id`: string
      - `name`: string
      - `message`: string

#### `session/canOpenWorkspacePath` · unary · ○ 静态可用(本轮未触发)

Report whether this deployment can hand a Session workspace path to a native desktop.

**Request 字段:**
- *(无参数)*

**Response 字段:**
- boolean

#### `session/openWorkspacePath` · unary · ○ 静态可用(本轮未触发)

Open one path prepared by a Session-aware caller on the Host desktop.

**Request 字段:**
- **SessionOpenWorkspacePathRequest**
  - `path`: string — Path after best-effort Session workspace resolution, in Host filesystem syntax.

**Response 字段:**
- **SessionOpenWorkspacePathValue**
  - `opened`: boolean

#### `session/rename` · unary · ◉ **live 实测**

Rename one Session after explicitly resuming it.

**Request 字段:**
- **SessionRenameRequest**
  - `sessionId`: string ⌾SessionId
  - `title`: string

**Response 字段:**
- **SessionRenameValue**
  - `title`: string
  - `seq`: number

#### `session/fork` · unary · ◉ **live 实测**

Fork one cold-readable completed-turn prefix into a new Session.

**Request 字段:**
- **SessionForkRequest**
  - `sessionId`: string ⌾SessionId
  - `atSeq?`: number

**Response 字段:**
- **SessionForkValue**
  - `sessionId`: string ⌾SessionId

#### `session/prompt` · unary · ◉ **live 实测**

Admit one prompt after explicitly resuming its Session.

**Request 字段:**
- **SessionPromptRequest**
  - `requestId`: string — Client-minted identity persisted on the exact accepted user message.
  - `sessionId`: string ⌾SessionId
  - `mode`: string|string
  - `content`: object|object[]
  - `clientTimeZone?`: string

**Response 字段:**
- **SessionPromptValue**
  - `accepted`: boolean

#### `session/attachment` · unary · ○ 静态可用(本轮未触发)

Read one image proven reachable from the addressed Session log.

**Request 字段:**
- **SessionAttachmentRequest**
  - `sessionId`: string ⌾SessionId
  - `attachmentId`: string

**Response 字段:**
- **SessionAttachmentValue**
  - `attachment`: object
    - `attachmentId`: string — Opaque storage identifier; never a filesystem path or bearer URL.
    - `mediaType`: string|string|string|string — Media type verified from the stored bytes.
    - `bytes`: number — Exact encoded byte length.
    - `width`: number — Intrinsic encoded width in pixels.
    - `height`: number — Intrinsic encoded height in pixels.
    - `name?`: string — Optional display name stripped of local path information.
    - `originalDimensions?`: object — Input dimensions after applying EXIF orientation and before normalization scaling. Present only when normalization reduced the image.
      - `width`: number
      - `height`: number
  - `data`: string

#### `session/updateQueue` · unary · ○ 静态可用(本轮未触发)

Mutate one still-pending queue occurrence on a live Agent.

**Request 字段:**
- **SessionUpdateQueueRequest**
  - `sessionId`: string ⌾SessionId
  - `itemId`: string ⌾MessageId
  - `action`: object|object|object
    - 变体 `{ readonly kind: "edit"; readonly content: readonly ContentBlock[]; }`:
      - `kind`: string
      - `content`: object|object|object|object|object[]
    - 变体 `{ readonly kind: "remove"; }`:
      - `kind`: string
    - 变体 `{ readonly kind: "steer"; }`:
      - `kind`: string

**Response 字段:**
- **SessionUpdateQueueValue**
  - `accepted`: boolean

#### `session/cancel` · unary · ○ 静态可用(本轮未触发)

Cancel one active Agent turn without dropping its pending inbox.

**Request 字段:**
- **SessionCancelRequest**
  - `sessionId`: string ⌾SessionId

**Response 字段:**
- **SessionCancelValue**
  - `accepted`: boolean

#### `session/page` · unary · ○ 静态可用(本轮未触发)

Read one cold-safe, message-aligned Session history page.

**Request 字段:**
- **SessionPageRequest**
  - `address`: object|object
    - 变体 `{ readonly kind: "session"; readonly sessionId: SessionId; }`:
      - `kind`: string
      - `sessionId`: string ⌾SessionId
    - 变体 `{ readonly kind: "subagent"; readonly parentSessionId: SessionId; readonly childSessionId: SessionId; readonly mode: "one-shot" | "continuable"; }`:
      - `kind`: string
      - `parentSessionId`: string ⌾SessionId
      - `childSessionId`: string ⌾SessionId
      - `mode`: string|string
  - `throughSeq`: number — Inclusive log cut obtained from the corresponding follow opening frame.
  - `beforeSeq?`: number
  - `maxMessages?`: number

**Response 字段:**
- **SessionPage**
  - `records`: object|object[]
  - `hasMore`: boolean

#### `session/follow` · stream · ◉ **live 实测**

Follow one Session log from its opening or resume cursor.

**Request 字段:**
- **SessionFollowRequest**
  - `address`: object|object
    - 变体 `{ readonly kind: "session"; readonly sessionId: SessionId; }`:
      - `kind`: string
      - `sessionId`: string ⌾SessionId
    - 变体 `{ readonly kind: "subagent"; readonly parentSessionId: SessionId; readonly childSessionId: SessionId; readonly mode: "one-shot" | "continuable"; }`:
      - `kind`: string
      - `parentSessionId`: string ⌾SessionId
      - `childSessionId`: string ⌾SessionId
      - `mode`: string|string
  - `maxMessages?`: number

**Response 字段:**
- object|object
  - 变体 `SessionEventEntry`:
    - `type`: string
    - `event`: object
      - `type`: string
      - `seq`: number
      - `time`: number
      - `data`: json (any JSON value)
      - `ignorable?`: boolean
      - `sourceEventSeqs?`: number[]
      - `surfaceOp?`: string|object
        - 变体 `{ readonly op: "replace"; readonly start: number; readonly end: number; }`:
          - `op`: string
          - `start`: number
          - `end`: number
  - 变体 `{ readonly type: "snapshot"; readonly header: SessionWireHeader; readonly cursor: number; readonly records: readonly SessionHistoryRecord[]; readonly hasMore: boolean; readonly projections: SessionProjectionBaseline; }`:
    - `type`: string
    - `header`: object
      - `version`: number
      - `id`: string ⌾SessionId
      - `createdAt`: number
      - `cwd?`: string
      - `parentSession?`: string ⌾SessionId
      - `seedLength?`: number — Exact inherited prefix length; absent for an unseeded Session.
      - `origin?`: string
      - `delegationDepth?`: number
      - `agentPreset?`: string
    - `cursor`: number
    - `records`: object|object[]
    - `hasMore`: boolean
    - `projections`: object
      - `asOfSeq`: number
      - `values`: object — Provider-validated values; omitted keys are absent capabilities at this cut.
        - `title?`: string — The session's current normalized title — the latest `session/title` event's text (last-wins), or `null` before the first title lands. A plain string: the shape…
        - `agentPreset?`: string — Preset the Session runs, or null when the deployment composes none.
        - `sessionListMetadata?`: object — Persisted facts used to summarize a Session without activating it.
          - `blank`: boolean — Whether the folded prefix contains no turn.
          - `lastPromptAt`: number — Latest human-authored prompt time in the folded prefix.
        - `imageLimits?`: object — Image-intake limits enforced by the Session prompt endpoint.
          - `maxImageBytes`: number
          - `maxImagesPerMessage`: number
          - `maxMessageImageBytes`: number
          - `maxImagePixels`: number
          - `maxImageDimension`: number — Maximum intrinsic width and maximum intrinsic height in pixels for one image.
          - `mediaTypes`: string|string|string|string[]
        - `modelSelection?`: object — Durable model selection already used and selected for the next request.
          - `lastUsed`: object — Selection consumed by the latest recorded model request.
            - `provider`: string
            - `model`: string
            - `reasoningEffort?`: string
          - `next`: object — Selection the next request should use, falling back to {@link lastUsed}.
            - `provider`: string
            - `model`: string
            - `reasoningEffort?`: string
        - `subagentTiming?`: object — Active-turn duration for a descriptor-backed subagent session.
          - `settledMs`: number — Milliseconds accumulated across completed turns after the child's own descriptor.
          - `active?`: object — Same-cut bounds of the currently open turn, when one has not reached `turn/end`.
            - `since`: number — Start of the open turn.
            - `through`: number — Latest event time folded into this projection cut.
        - `subagent?`: object|object — Identity of a descriptor-backed subagent session. `null` ⟺ no valid descriptor (missing, malformed, or unrecognized-version — deliberately undistinguished). Th…
          - 变体 `{ mode: "one-shot"; label?: string; seq: SessionSeq; }`:
            - `mode`: string — A terminal one-shot child.
            - `label?`: string — Optional durable creation label from the child's descriptor.
            - `seq`: number — Seq of the `subagent/descriptor` event this identity was folded from. `session.isOwnSeq(seq)` proves the identity comes from the child's OWN log suffix — where…
          - 变体 `{ mode: "continuable"; label: string; seq: SessionSeq; }`:
            - `mode`: string — A resumable conversation.
            - `label`: string — Durable creation label from the child's descriptor.
            - `seq`: number — Seq of the folded descriptor event; see the one-shot arm for the own-suffix proof.

#### `session/control` · stream · ◉ **live 实测**

Stream a complete live-control baseline followed by replacement frames.

**Request 字段:**
- **AbortSignal**
  - `aborted`: boolean — The **`aborted`** read-only property returns a value that indicates whether the asynchronous operations the signal is communicating with are aborted (true) or …
  - `onabort`: function — [MDN Reference](https://developer.mozilla.org/docs/Web/API/AbortSignal/abort_event)
  - `reason`: any — The **`reason`** read-only property returns a JavaScript value that indicates the abort reason. [MDN Reference](https://developer.mozilla.org/docs/Web/API/Abor…
  - `throwIfAborted`: function — The **`throwIfAborted()`** method throws the signal's abort reason if the signal has been aborted; otherwise it does nothing. [MDN Reference](https://developer…
  - `addEventListener`: function — The **`addEventListener()`** method of the EventTarget interface sets up a function that will be called whenever the specified event is delivered to the target…
  - `removeEventListener`: function — The **`removeEventListener()`** method of the EventTarget interface removes an event listener previously registered with EventTarget.addEventListener() from th…
  - `dispatchEvent`: function — The **`dispatchEvent()`** method of the EventTarget sends an Event to the object, (synchronously) invoking the affected event listeners in the appropriate orde…

**Response 字段:**
- object|object|object|object
  - 变体 `{ readonly type: "baseline"; readonly value: SessionControlBaseline; }`:
    - `type`: string
    - `value`: object
      - `queues`: record<SessionId, …>
      - `jobs`: record<SessionId, …>
      - `projections`: record<SessionId, …>
        - *(值)*:
          - `asOfSeq`: number
          - `values`: object — Provider-validated values; omitted keys are absent capabilities at this cut.
            - `title?`: string — The session's current normalized title — the latest `session/title` event's text (last-wins), or `null` before the first title lands. A plain string: the shape…
            - `agentPreset?`: string — Preset the Session runs, or null when the deployment composes none.
            - `sessionListMetadata?`: object — Persisted facts used to summarize a Session without activating it.
              - `blank`: boolean — Whether the folded prefix contains no turn.
              - `lastPromptAt`: number — Latest human-authored prompt time in the folded prefix.
            - `imageLimits?`: object — Image-intake limits enforced by the Session prompt endpoint.
              - `maxImageBytes`: number
              - `maxImagesPerMessage`: number
              - `maxMessageImageBytes`: number
              - `maxImagePixels`: number
              - `maxImageDimension`: number — Maximum intrinsic width and maximum intrinsic height in pixels for one image.
              - `mediaTypes`: string|string|string|string[]
            - `modelSelection?`: object — Durable model selection already used and selected for the next request.
              - `lastUsed`: object — Selection consumed by the latest recorded model request.
                - `provider`: string
                - `model`: string
                - `reasoningEffort?`: string
              - `next`: object — Selection the next request should use, falling back to {@link lastUsed}.
                - `provider`: string
                - `model`: string
                - `reasoningEffort?`: string
            - `subagentTiming?`: object — Active-turn duration for a descriptor-backed subagent session.
              - `settledMs`: number — Milliseconds accumulated across completed turns after the child's own descriptor.
              - `active?`: object — Same-cut bounds of the currently open turn, when one has not reached `turn/end`.
                - `since`: number — Start of the open turn.
                - `through`: number — Latest event time folded into this projection cut.
            - `subagent?`: object|object — Identity of a descriptor-backed subagent session. `null` ⟺ no valid descriptor (missing, malformed, or unrecognized-version — deliberately undistinguished). Th…
              - 变体 `{ mode: "one-shot"; label?: string; seq: SessionSeq; }`:
                - `mode`: string — A terminal one-shot child.
                - `label?`: string — Optional durable creation label from the child's descriptor.
                - `seq`: number — Seq of the `subagent/descriptor` event this identity was folded from. `session.isOwnSeq(seq)` proves the identity comes from the child's OWN log suffix — where…
              - 变体 `{ mode: "continuable"; label: string; seq: SessionSeq; }`:
                - `mode`: string — A resumable conversation.
                - `label`: string — Durable creation label from the child's descriptor.
                - `seq`: number — Seq of the folded descriptor event; see the one-shot arm for the own-suffix proof.
  - 变体 `{ readonly type: "queue"; readonly sessionId: SessionId; readonly items: readonly SessionQueuedItem[]; }`:
    - `type`: string
    - `sessionId`: string ⌾SessionId
    - `items`: object[]
      - *(元素)*:
        - `id`: string ⌾MessageId
        - `placement`: string|string|string
        - `rpcId?`: string — Prompt-RPC identity from the queued message's user source; clients retire the matching local submission echo on it.
        - `message`: object — JSON-safe message fields consumed by pending-queue presentation.
          - `id`: string ⌾MessageId
          - `content`: json (any JSON value)[]
  - 变体 `{ readonly type: "jobs"; readonly sessionId: SessionId; readonly jobs: readonly SessionJob[]; }`:
    - `type`: string
    - `sessionId`: string ⌾SessionId
    - `jobs`: object[]
      - *(元素)*:
        - `id`: string
        - `kind`: string
        - `label`: string
        - `status`: string|string|string|string|string
        - `detail?`: string
        - `startedAt`: number
        - `finishedAt?`: number
  - 变体 `{ readonly type: "projection"; } & SessionProjectionUpdate`:
    - `type`: string
    - `sessionId`: string ⌾SessionId
    - `key`: string
    - `value`: json (any JSON value)
    - `seq`: number

---

## 7. 对接其他 Agent Runtime 的字段映射清单

按"UI 要什么 → 其他 runtime 对应/缺失后果"排;缺失后果均经源码/实测证实为**静默降级**:

| 数据段 | 必需性 | 其他 runtime 来源建议 | 缺失后果(实测/源码证实) |
|---|---|---|---|
| `session/list` items(含 projections.title) | 高 | 会话存储列表 | 无侧栏列表 |
| `session/follow` snapshot.records(事件日志) | 高 | 会话转录转换(→ §附录事件表) | 无聊天渲染 |
| `user/message` / `assistant/message` | 高(最小可用核) | 用户消息/助手回复 | 无对话 |
| `turn/start|end`、`step/start|end` | 中 | 回合边界(可合成) | Trajectory 无 turn 结构、无"Jump to turn"、无失败标记 |
| `request/header.system` | 可选 | **很多闭源 runtime 不给**(Claude Code/Antigravity 类) | Trajectory 无 System Prompt 标签(有显式占位文案);聊天不受影响 |
| `request/header.tools` | 可选 | 工具清单 | 无工具 schema 展示 |
| `request/header.config` + `request/context` | 可选 | 模型/参数/上下文窗 | 无路由元数据;`modelSelection` 投影退化 |
| `assistant/chunk` | 可选(流式增强) | token 流 | 无打字机效果,消息整段出现 |
| `tool/call`+`tool/result`(arguments 原文、meta) | 中 | 工具调用转录 | 无工具卡 |
| `assistant/message.usage` | 可选 | token 计量 | 无用量条("Usage … to …"/"1% of context") |
| `session/title` 事件 / projections.title | 中 | 标题生成或截首句 | 列表无标题(fallback 首条消息) |
| projections(`sessionStats`/`contextPressure`/`tokenUsage`/`turnOutline`/…) | 可选 | 从日志统计合成或干脆不发 | 统计条/上下文压力表不显示 |
| `session/control` baseline(queues/jobs) | 可选 | 任务队列镜像 | 无排队 UI、无后台作业头 |
| `session/prompt`/`cancel`/`updateQueue` | 高(prompt)/可选 | 接 runtime 输入 API | 不能发消息/不能取消 |
| `session/create`/`fork`/`rename` | 中 | 会话管理 | 无新建/分支/改名 |
| `llm/*`+`session/modelCatalog` | 中 | 静态单模型目录即可 | 模型选择器空 |
| `workspace/follow` | 低 | 固定单工作区 | 侧栏无分组(会话平铺) |
| `settings/*` | 低 | memory-stub 或裁掉 roster | 设置页退化/移除 |
| `agentPresets/list` | 低 | 单 preset 或不发 | composer 模式选择器空(patch 注释:"Absent a roster it renders nothing") |
| `commands/list`、`skills/list` | 低 | 斜杠命令/技能目录 | `/`、`@` 触发器空 |
| `messageFeedback/*` | 低 | 不实现 | 无 👍/👎 |
| `goals/*` | 低 | 不实现 | 无 GoalBar |
| `dynamicCordisRunner/*`、`pluginInventory` | 低 | 不实现 | 无插件页/运行卡片 |
| `session.export` 裸路由 | 低 | 不实现 | 无下载 |
| `$events` emit 转发 | 低 | 不实现 | 状态徽章不实时(轮询兜底不在 UI,部分区域静止) |

**最小可用集**(PoC 建议):`session/list` + `session/follow`(snapshot,只需 user/message+assistant/message 两事件)+ `session/prompt` + `session/modelCatalog`(静态)+ `llm/listProviders`(静态)→ 即得完整聊天 UI;其余全部静默缺失。

---

## 8. 复现

```bash
# 静态提取(类型树)
cd ~/workspaces/dashr/upstream/deepseek-harness
node ~/workspaces/dashr/.scratch/extract-remotes.mjs   # → remote-inventory.json
node ~/workspaces/dashr/.scratch/extract-remotes.mjs x x events  # → session-events.json
# 运行时抓取(token 从 .scratch/dsh-4999.log 取)
node ~/workspaces/dashr/.scratch/capture-webui.mjs '<token-url>' out.json 8000
CAP_ACTIONS="$(cat act.txt)" node …capture-webui.mjs …  # 交互阶段
```

*生成脚本的一次性产物;升级 alpha 版本后重跑即可刷新清单。*
