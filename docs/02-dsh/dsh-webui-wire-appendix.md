# 附录:DSH Web UI wire 数据段全字段树(静态全量)

> 由 `.scratch/extract-remotes.mjs`(tsc 类型检查器)自动生成;`◉ live 实测` 标记 = playwright 实抓触发过。
> 超长共享 manifest(动态 Cordis inspect、agentTeams、presets 全 config)在 6KB 处截断,完整树见
> `webui-wire-data/remote-inventory.json`。字段名旁 `⌾XxxId` = 品牌化字符串(线上就是普通 string)。

## 一、RPC 命名空间(除 session 外的 16 个,61 方法;session 见主文档 §6)

### `skills/*` — 会话技能目录(输入 @ 触发)

#### `skills/list` · unary · ◉ **live 实测**

List the user-invocable skills visible to one Session composition.

**Request 字段:**
- **SkillListRequest**
  - `sessionId`: string ⌾SessionId

**Response 字段:**
- **SkillListValue**
  - `skills`: object[]
    - *(元素)*:
      - `name`: string — Kebab-case identifier referenced as `/name`.
      - `description`: string — Short routing description.
      - `whenToUse?`: string — Optional extra routing guidance.
      - `modelInvocable`: boolean — Whether the same skill is also advertised to the model.

### `fileReferences/*` — 会话文件引用

#### `fileReferences/list` · unary · ○ 静态可用(本轮未触发)

List file and directory candidates for one Agent's working directory.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - `plugin`: string
            - `form?`: ne
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


### `workspace/*` — 工作区:侧栏树、排序、归档 + 流

#### `workspace/create` · unary · ○ 静态可用(本轮未触发)

Create or idempotently resolve one Workspace over an existing directory.

**Request 字段:**
- **WorkspaceCreateRequest**
  - `path`: string

**Response 字段:**
- **WorkspaceCreateValue**
  - `workspace`: object
    - `workspaceId`: string
    - `path`: string — Canonical host directory path.
    - `title`: string — User-visible title.
    - `sessionIds`: string ⌾SessionId[] — Sessions accounted to this Workspace in manual order.
    - `createdAt`: string — ISO-8601 creation instant.
    - `updatedAt`: string — ISO-8601 last-mutation instant.
  - `created`: boolean

#### `workspace/rename` · unary · ○ 静态可用(本轮未触发)

Rename one Workspace to a unique non-blank title.

**Request 字段:**
- **WorkspaceRenameRequest**
  - `workspaceId`: string
  - `title`: string

**Response 字段:**
- **WorkspaceValue**
  - `workspace`: object
    - `workspaceId`: string
    - `path`: string — Canonical host directory path.
    - `title`: string — User-visible title.
    - `sessionIds`: string ⌾SessionId[] — Sessions accounted to this Workspace in manual order.
    - `createdAt`: string — ISO-8601 creation instant.
    - `updatedAt`: string — ISO-8601 last-mutation instant.

#### `workspace/delete` · unary · ○ 静态可用(本轮未触发)

Remove one Workspace registration while retaining files and Sessions.

**Request 字段:**
- **WorkspaceDeleteRequest**
  - `workspaceId`: string

**Response 字段:**
- **WorkspaceDeleteValue**
  - `deleted`: boolean

#### `workspace/insertBefore` · unary · ○ 静态可用(本轮未触发)

Move one Workspace within the registry display order.

**Request 字段:**
- **WorkspaceInsertBeforeRequest**
  - `workspaceId`: string
  - `beforeWorkspaceId?`: string

**Response 字段:**
- **WorkspaceOrderValue**
  - `workspaceIds`: string[]

#### `workspace/insertSessionBefore` · unary · ○ 静态可用(本轮未触发)

Move one accounted Session within a Workspace.

**Request 字段:**
- **WorkspaceInsertSessionBeforeRequest**
  - `workspaceId`: string
  - `sessionId`: string ⌾SessionId
  - `beforeSessionId?`: string ⌾SessionId

**Response 字段:**
- **WorkspaceValue**
  - `workspace`: object
    - `workspaceId`: string
    - `path`: string — Canonical host directory path.
    - `title`: string — User-visible title.
    - `sessionIds`: string ⌾SessionId[] — Sessions accounted to this Workspace in manual order.
    - `createdAt`: string — ISO-8601 creation instant.
    - `updatedAt`: string — ISO-8601 last-mutation instant.

#### `workspace/archiveSession` · unary · ○ 静态可用(本轮未触发)

Hide one known Session from Workspace grouping surfaces.

**Request 字段:**
- **WorkspaceArchiveSessionRequest**
  - `sessionId`: string ⌾SessionId

**Response 字段:**
- **WorkspaceArchiveValue**
  - `archivedSessionIds`: string ⌾SessionId[]

#### `workspace/follow` · stream · ○ 静态可用(本轮未触发)

Stream a complete Workspace baseline followed by ordered increments.

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
- object|object|object|object|object
  - 变体 `{ readonly type: "baseline"; readonly value: WorkspaceBaseline; }`:
    - `type`: string
    - `value`: object
      - `items`: object[]
        - *(元素)*:
          - `workspaceId`: string
          - `path`: string — Canonical host directory path.
          - `title`: string — User-visible title.
          - `sessionIds`: string ⌾SessionId[] — Sessions accounted to this Workspace in manual order.
          - `createdAt`: string — ISO-8601 creation instant.
          - `updatedAt`: string — ISO-8601 last-mutation instant.
      - `archivedSessionIds`: string ⌾SessionId[]
  - 变体 `{ readonly type: "upsert"; readonly workspace: WorkspaceView; }`:
    - `type`: string
    - `workspace`: object
      - `workspaceId`: string
      - `path`: string — Canonical host directory path.
      - `title`: string — User-visible title.
      - `sessionIds`: string ⌾SessionId[] — Sessions accounted to this Workspace in manual order.
      - `createdAt`: string — ISO-8601 creation instant.
      - `updatedAt`: string — ISO-8601 last-mutation instant.
  - 变体 `{ readonly type: "remove"; readonly workspaceId: WorkspaceId; }`:
    - `type`: string
    - `workspaceId`: string
  - 变体 `{ readonly type: "order"; readonly workspaceIds: readonly WorkspaceId[]; }`:
    - `type`: string
    - `workspaceIds`: string[]
  - 变体 `{ readonly type: "archived"; readonly archivedSessionIds: readonly SessionId[]; }`:
    - `type`: string
    - `archivedSessionIds`: string ⌾SessionId[]

### `directoryPicker/*` — 目录选择器(创建会话选 cwd)

#### `directoryPicker/pick` · unary · ○ 静态可用(本轮未触发)

Open the host's OS chooser for a Remote caller.

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
- string

#### `directoryPicker/list` · unary · ○ 静态可用(本轮未触发)

List one directory level for a Remote caller's in-app browser.

**Request 字段:**
- `req`: string

**Response 字段:**
- **DirectoryListing**
  - `path`: string — Absolute path of the listed directory.
  - `home`: string — The host account's home directory (breadcrumb "Home" rooting).
  - `crumbs`: object[] — Ancestor chain from the filesystem root to the listed directory inclusive; every crumb is a jump target (crumb `hidden` is always false).
    - *(元素)*:
      - `name`: string — Base name shown in a browser row (a root crumb carries its full path).
      - `path`: string — Absolute host path — clients never join path segments themselves.
      - `hidden`: boolean — Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it.
  - `entries`: object[] — Direct child directories, name-sorted; symlinks to directories included.
    - *(元素)*:
      - `name`: string — Base name shown in a browser row (a root crumb carries its full path).
      - `path`: string — Absolute host path — clients never join path segments themselves.
      - `hidden`: boolean — Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it.
  - `truncated`: boolean — True when the backend cut `entries` at its complete-result bound: the level has more child directories than reported, and the missing rows are the name-sorted …

#### `directoryPicker/createDirectory` · unary · ○ 静态可用(本轮未触发)

Create one child directory for a Remote caller's in-app browser.

**Request 字段:**
- `req`: string

**Response 字段:**
- string

### `settings/*` — 设置读写(describe/get/set;非 loopback 页有已知缺口)

#### `settings/describe` · unary · ◉ **live 实测**

Describe every registered namespace for a configuration page: redacted layered values plus the serialized schema the page renders its form from.

**Request 字段:**
- *(无参数)*

**Response 字段:**
- **SettingsDescribeValue**
  - `writable`: boolean — Whether the provider accepts writes; `false` disables every write control.
  - `hasDocument`: boolean — Whether a file-backed provider owns a local document, without exposing its Host path.
  - `namespaces`: object[] — One view per registered namespace.
    - *(元素)*:
      - `ns`: string — Namespace key (`llm-deepseek`, `llm-pi-ai`, …).
      - `schema`: json (any JSON value) — Serialized schemastery schema envelope (`schema.toJSON()`); rehydrate with `new Schema(json)`.
      - `value`: json (any JSON value) — Redacted resolved value (schema defaults → composition base → user layer).
      - `base?`: json (any JSON value) — Redacted composition base layer, when the registrant declared one.
      - `user?`: json (any JSON value) — Redacted raw user section, when one exists; a field's presence here marks it user-overridden.
      - `applies`: string|string — When the owner applies changes.
      - `secrets`: object[] — Every schema-declared secret slot with its configured state.
        - *(元素)*:
          - `path`: string[] — Path from the section root to the removed field.
          - `set`: boolean — Whether the slot currently holds a value; the value itself never rides.
      - `revision`: number — Monotonic revision of the raw user section this view was read at. Send it back as `expectedRevision` on a write so a stale editor is refused rather than silent…

#### `settings/canOpenAgentPresetDirectory` · unary · ○ 静态可用(本轮未触发)

Report whether this deployment can open an authored Agent preset directory natively.

**Request 字段:**
- *(无参数)*

**Response 字段:**
- boolean

#### `settings/update` · unary · ○ 静态可用(本轮未触发)

Merge a patch into one namespace's stored user section.

**Request 字段:**
- `req`: string

**Response 字段:**
- **SettingsNamespaceView**
  - `ns`: string — Namespace key (`llm-deepseek`, `llm-pi-ai`, …).
  - `schema`: json (any JSON value) — Serialized schemastery schema envelope (`schema.toJSON()`); rehydrate with `new Schema(json)`.
  - `value`: json (any JSON value) — Redacted resolved value (schema defaults → composition base → user layer).
  - `base?`: json (any JSON value) — Redacted composition base layer, when the registrant declared one.
  - `user?`: json (any JSON value) — Redacted raw user section, when one exists; a field's presence here marks it user-overridden.
  - `applies`: string|string — When the owner applies changes.
  - `secrets`: object[] — Every schema-declared secret slot with its configured state.
    - *(元素)*:
      - `path`: string[] — Path from the section root to the removed field.
      - `set`: boolean — Whether the slot currently holds a value; the value itself never rides.
  - `revision`: number — Monotonic revision of the raw user section this view was read at. Send it back as `expectedRevision` on a write so a stale editor is refused rather than silent…

#### `settings/replace` · unary · ○ 静态可用(本轮未触发)

Replace one namespace's stored user section wholesale.

**Request 字段:**
- `req`: string

**Response 字段:**
- **SettingsNamespaceView**
  - `ns`: string — Namespace key (`llm-deepseek`, `llm-pi-ai`, …).
  - `schema`: json (any JSON value) — Serialized schemastery schema envelope (`schema.toJSON()`); rehydrate with `new Schema(json)`.
  - `value`: json (any JSON value) — Redacted resolved value (schema defaults → composition base → user layer).
  - `base?`: json (any JSON value) — Redacted composition base layer, when the registrant declared one.
  - `user?`: json (any JSON value) — Redacted raw user section, when one exists; a field's presence here marks it user-overridden.
  - `applies`: string|string — When the owner applies changes.
  - `secrets`: object[] — Every schema-declared secret slot with its configured state.
    - *(元素)*:
      - `path`: string[] — Path from the section root to the removed field.
      - `set`: boolean — Whether the slot currently holds a value; the value itself never rides.
  - `revision`: number — Monotonic revision of the raw user section this view was read at. Send it back as `expectedRevision` on a write so a stale editor is refused rather than silent…

#### `settings/mutate` · unary · ○ 静态可用(本轮未触发)

Apply path-addressed edits to one namespace's user section, resolved against the section as stored rather than against whatever the caller last read, then answ…

**Request 字段:**
- `req`: string

**Response 字段:**
- **SettingsNamespaceView**
  - `ns`: string — Namespace key (`llm-deepseek`, `llm-pi-ai`, …).
  - `schema`: json (any JSON value) — Serialized schemastery schema envelope (`schema.toJSON()`); rehydrate with `new Schema(json)`.
  - `value`: json (any JSON value) — Redacted resolved value (schema defaults → composition base → user layer).
  - `base?`: json (any JSON value) — Redacted composition base layer, when the registrant declared one.
  - `user?`: json (any JSON value) — Redacted raw user section, when one exists; a field's presence here marks it user-overridden.
  - `applies`: string|string — When the owner applies changes.
  - `secrets`: object[] — Every schema-declared secret slot with its configured state.
    - *(元素)*:
      - `path`: string[] — Path from the section root to the removed field.
      - `set`: boolean — Whether the slot currently holds a value; the value itself never rides.
  - `revision`: number — Monotonic revision of the raw user section this view was read at. Send it back as `expectedRevision` on a write so a stale editor is refused rather than silent…

#### `settings/openSettingsDocument` · unary · ○ 静态可用(本轮未触发)

Materialize the provider-owned settings document and open it in a native text editor.

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
- **SettingsDocumentOpenValue**
  - `opened`: boolean

#### `settings/openAgentPresetDirectory` · unary · ○ 静态可用(本轮未触发)

Open one user-authored Agent preset directory or return its path when no native opener exists.

**Request 字段:**
- `req`: string

**Response 字段:**
- object|object
  - 变体 `{ readonly opened: true; }`:
    - `opened`: boolean
  - 变体 `{ readonly opened: false; readonly path: string; }`:
    - `opened`: boolean
    - `path`: string

### `credentials/*` — 凭据读写

#### `credentials/describe` · unary · ◉ **live 实测**

Describe several references for one configuration surface. Batched because a settings page describes every reference its rows name at once, and one round trip …

**Request 字段:**
- `req`: string[]

**Response 字段:**
- record<string, …>
  - *(值)*:
    - `configured`: boolean — Whether resolving the reference would currently return a value.
    - `source?`: string — Source layer currently supplying the value; absent while unconfigured.
    - `writable`: boolean — Whether the active provider can write this reference.

#### `credentials/set` · unary · ○ 静态可用(本轮未触发)

Store one value from a configuration surface. The value crosses the wire in this direction only: no read path returns it.

**Request 字段:**
- `req`: string

**Response 字段:**
- void

#### `credentials/unset` · unary · ○ 静态可用(本轮未触发)

Remove one reference from a configuration surface.

**Request 字段:**
- `req`: string

**Response 字段:**
- void

### `llm/*` — LLM 提供方目录(模型选择器)

#### `llm/listProviders` · unary · ◉ **live 实测**

Describe provider routes with a registered adapter.

**Request 字段:**
- *(无参数)*

**Response 字段:**
- object[]
  - *(元素)*:
    - `id`: string — Provider route key used by {@link GenerateOptions.provider}.
    - `name`: string — Human-readable provider name for selectors and diagnostics.

#### `llm/listConfigurableProviders` · unary · ◉ **live 实测**

List every declared configurable provider, registered or dormant.

**Request 字段:**
- *(无参数)*

**Response 字段:**
- object[]
  - *(元素)*:
    - `provider`: string — Provider route key this entry activates when configured.
    - `displayName`: string — Human-readable provider name for configuration surfaces.
    - `settingsNs`: string — User-settings namespace whose section configures this provider.
    - `settingsPath`: string[] — Path from that namespace's section root to this provider's profile object; empty when the whole section is the profile.
    - `declared?`: boolean — Whether the owning adapter knows this route only because configuration declared it — a gateway or self-hosted server it ships nothing about. Absent means the a…

#### `llm/discoverModels` · unary · ○ 静态可用(本轮未触发)

Remote adapter for one draft provider interrogation.

**Request 字段:**
- `req`: string

**Response 字段:**
- object[]
  - *(元素)*:
    - `id`: string — Model id the endpoint accepts.
    - `name?`: string — Human-readable name when the endpoint supplies one.
    - `contextWindow?`: number — Maximum combined request and response context, when disclosed.
    - `maxTokens?`: number — Maximum output tokens, when disclosed.

### `agentPresets/*` — Agent 预设 roster(composer 的 Standard mode 等)

#### `agentPresets/list` · unary · ◉ **live 实测**

The roster off the Host: {@link list} projected to path-free rows, with the default marked and this deployment's authoring capability beside it. Whether a clie…

**Request 字段:**
- *(无参数)*

**Response 字段:**
- **AgentPresetRoster**
  - `presets`: object[] — Every preset the configured roots supply, first-root-wins per id.
    - *(元素)*:
      - `id`: string — Stable identifier; also the label's fallback.
      - `trust`: string|string — Trust of the root this preset was discovered under.
      - `isDefault`: boolean — Whether a session naming no preset composes this one.
      - `name?`: string — Display name the preset published.
      - `description?`: string — One sentence on what this preset is for.
      - `broken?`: string — Why this preset cannot compose a session; absent when it can.
  - `authorable`: boolean — Whether this deployment has a root locally authored presets go to.

#### `agentPresets/read` · unary · ○ 静态可用(本轮未触发)

One preset's composition text with the roster row it belongs to.

**Request 字段:**
- `req`: string

**Response 字段:**
- **AgentPresetDocument**
  - `agentPreset`: string — The preset the composition belongs to.
  - `trust`: string|string — Trust of the root this preset was discovered under.
  - `content`: string — The composition exactly as stored.
  - `name?`: string — Display name the preset published.
  - `description?`: string — One sentence on what this preset is for.

#### `agentPresets/copy` · unary · ○ 静态可用(本轮未触发)

Copy one preset through the Remote API.

**Request 字段:**
- `req`: string

**Response 字段:**
- void

#### `agentPresets/deletePreset` · unary · ○ 静态可用(本轮未触发)

Delete one preset through the Remote API.

**Request 字段:**
- `req`: string

**Response 字段:**
- void

#### `agentPresets/select` · unary · ○ 静态可用(本轮未触发)

Compose a blank session's agent from a different preset and record it.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - `plugin`: string
            - `form?`: n
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


### `commands/*` — 斜杠命令目录(输入 / 触发)

#### `commands/list` · unary · ◉ **live 实测**

List the effective immutable command descriptors for one agent.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - `plugin`: string
            - `form?`: never
        
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `commands/execute` · unary · ○ 静态可用(本轮未触发)

Parse and execute a known command without sending it to the model. A resolved command's lifecycle is logged: `command/run` is appended before the handler is in…

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


### `goals/*` — 目标(GoalBar)

#### `goals/edit` · unary · ○ 静态可用(本轮未触发)

Edit objective and/or round cap without changing phase.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - `plugin`: string
            - `form?`: never
          - 
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `goals/pause` · unary · ○ 静态可用(本轮未触发)

Pause an active goal and disarm automatic continuation.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - `plugin`: string
            - `form?`: never
          -
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `goals/resume` · unary · ○ 静态可用(本轮未触发)

Resume and arm a stopped goal, or rearm an active goal after a session-start edge, while its round budget still has capacity.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string

  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `goals/complete` · unary · ○ 静态可用(本轮未触发)

Mark a current non-complete goal complete and disarm it.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - `plugin`: string
            - `form?`: never
       
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `goals/clear` · unary · ○ 静态可用(本轮未触发)

Clear the current goal while retaining a durable tombstone and history.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - `plugin`: string
            - `form?`: n
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `goals/create` · unary · ○ 静态可用(本轮未触发)

Create one Goal through the remote boundary.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - `plugin`: string
            - `form?`: never
          - 变体 `{ kin
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


### `messageFeedback/*` — 消息 👍/👎 + 备注

#### `messageFeedback/list` · unary · ◉ **live 实测**

Read feedback belonging to the current persisted Session lifecycle. A stale row from a reused Session id is invisible.

**Request 字段:**
- **MessageFeedbackListRequest**
  - `sessionId`: string ⌾SessionId — Persisted Session whose sidecar should be read.

**Response 字段:**
- object|object
  - 变体 `MessageFeedbackSuccess<MessageFeedbackListValue>`:
    - `ok`: boolean
    - `value`: object
      - `items`: object[] — Fresh immutable item snapshots.
        - *(元素)*:
          - `messageId`: string ⌾MessageId — Stable identity of the assistant message inside the owning Session.
          - `rating`: string|string — Overall positive or negative judgment.
          - `note?`: string — Optional explanation, preserved verbatim after validation.
          - `version`: string — Equality-only token replaced by every material create or update.
          - `createdAt`: number — Host-assigned creation time in Unix epoch milliseconds.
          - `updatedAt`: number — Host-assigned time of the most recent material update.
  - 变体 `MessageFeedbackRejected<MessageFeedbackSessionNotFound>`:
    - `ok`: boolean
    - `error`: object
      - `code`: string
      - `sessionId`: string ⌾SessionId

#### `messageFeedback/put` · unary · ◉ **live 实测**

Create or replace feedback for one derived append-origin assistant message. Every request must match the addressed item's current version; a matching no-op ret…

**Request 字段:**
- **MessageFeedbackPutRequest**
  - `sessionId`: string ⌾SessionId — Persisted Session that owns the target message.
  - `messageId`: string ⌾MessageId — Target assistant-message identity.
  - `rating`: string|string — Desired overall judgment.
  - `note?`: string — Optional non-blank explanation.
  - `ifVersion`: string — Observed item version, or `null` to require that no item exists.

**Response 字段:**
- object|object
  - 变体 `MessageFeedbackSuccess<MessageFeedbackItem>`:
    - `ok`: boolean
    - `value`: object
      - `messageId`: string ⌾MessageId — Stable identity of the assistant message inside the owning Session.
      - `rating`: string|string — Overall positive or negative judgment.
      - `note?`: string — Optional explanation, preserved verbatim after validation.
      - `version`: string — Equality-only token replaced by every material create or update.
      - `createdAt`: number — Host-assigned creation time in Unix epoch milliseconds.
      - `updatedAt`: number — Host-assigned time of the most recent material update.
  - 变体 `MessageFeedbackRejected<MessageFeedbackSessionNotFound | MessageFeedbackTargetNotFound | MessageFeedbackVersionConflict | MessageFeedbackNoteBlank | MessageFeedbackNoteTooLarge>`:
    - `ok`: boolean
    - `error`: object|object|object|object|object
      - 变体 `MessageFeedbackSessionNotFound`:
        - `code`: string
        - `sessionId`: string ⌾SessionId
      - 变体 `MessageFeedbackTargetNotFound`:
        - `code`: string
        - `sessionId`: string ⌾SessionId
        - `messageId`: string ⌾MessageId
      - 变体 `MessageFeedbackVersionConflict`:
        - `code`: string
        - `current`: object — Authoritative current item, or `null` when it does not exist.
          - `messageId`: string ⌾MessageId — Stable identity of the assistant message inside the owning Session.
          - `rating`: string|string — Overall positive or negative judgment.
          - `note?`: string — Optional explanation, preserved verbatim after validation.
          - `version`: string — Equality-only token replaced by every material create or update.
          - `createdAt`: number — Host-assigned creation time in Unix epoch milliseconds.
          - `updatedAt`: number — Host-assigned time of the most recent material update.
      - 变体 `MessageFeedbackNoteBlank`:
        - `code`: string
      - 变体 `MessageFeedbackNoteTooLarge`:
        - `code`: string
        - `maxBytes`: number
        - `actualBytes`: number

#### `messageFeedback/delete` · unary · ○ 静态可用(本轮未触发)

Delete one feedback item. Absence is successful regardless of the supplied version; an existing item requires an exact version match.

**Request 字段:**
- **MessageFeedbackDeleteRequest**
  - `sessionId`: string ⌾SessionId — Persisted Session that owns the sidecar.
  - `messageId`: string ⌾MessageId — Message whose feedback should be absent after this operation.
  - `ifVersion`: string — Observed item version; ignored when the item is already absent.

**Response 字段:**
- object|object
  - 变体 `MessageFeedbackSuccess<MessageFeedbackDeleteValue>`:
    - `ok`: boolean
    - `value`: object
      - `absent`: boolean — Stable postcondition shared by the first deletion and every retry.
  - 变体 `MessageFeedbackRejected<MessageFeedbackSessionNotFound | MessageFeedbackVersionConflict>`:
    - `ok`: boolean
    - `error`: object|object
      - 变体 `MessageFeedbackSessionNotFound`:
        - `code`: string
        - `sessionId`: string ⌾SessionId
      - 变体 `MessageFeedbackVersionConflict`:
        - `code`: string
        - `current`: object — Authoritative current item, or `null` when it does not exist.
          - `messageId`: string ⌾MessageId — Stable identity of the assistant message inside the owning Session.
          - `rating`: string|string — Overall positive or negative judgment.
          - `note?`: string — Optional explanation, preserved verbatim after validation.
          - `version`: string — Equality-only token replaced by every material create or update.
          - `createdAt`: number — Host-assigned creation time in Unix epoch milliseconds.
          - `updatedAt`: number — Host-assigned time of the most recent material update.

### `subagents/*` — 子代理目录与追踪

#### `subagents/list` · unary · ◉ **live 实测**

Remote face of {@link listChildren} for one browser: the durable listing plus live Agent activity and the delivery-time parent availability hint. Parent availa…

**Request 字段:**
- `req`: string ⌾SessionId

**Response 字段:**
- **SubagentCatalog**
  - `entries`: object|object|object[]
  - `parentAvailable`: boolean

#### `subagents/prompt` · unary · ○ 静态可用(本轮未触发)

Deliver one browser-authored message to a continuable child through the exact live direct parent, retaining the caller-minted request identity and validated br…

**Request 字段:**
- **SubagentPromptRequest**
  - `requestId`: string — Identity persisted on the accepted message, minted before the call.
  - `parentSessionId`: string ⌾SessionId
  - `childSessionId`: string ⌾SessionId
  - `mode`: string — Required discriminator retained from the browser control address.
  - `content`: object|object[] — Browser prompt parts delivered as the child's user message. The Host admits and persists image parts before delivery, so the wire never carries a durable attac…
  - `clientTimeZone?`: string — Optional browser zone sampled for this exact human prompt.

**Response 字段:**
- **SubagentPromptReceipt**
  - `messageId`: string ⌾MessageId

#### `subagents/interruptByParent` · unary · ○ 静态可用(本轮未触发)

Remote face of {@link interrupt} under one durable parent address. No catalog, history, persistence, or parent Agent lookup runs: the core primitive alone auth…

**Request 字段:**
- `req`: string ⌾SessionId

**Response 字段:**
- **SubagentInterruptReceipt**
  - `accepted`: boolean

### `pluginInventory/*` — 插件目录只读投影(Plugins 设置页)

#### `pluginInventory/list` · unary · ○ 静态可用(本轮未触发)

Read the Loader directly on every call. Cordis's internal plugin/status events already maintain Entry.fiber and Fiber.state, so a second cache would only add a…

**Request 字段:**
- *(无参数)*

**Response 字段:**
- **PluginInventorySnapshot**
  - `entries`: object[]
    - *(元素)*:
      - `entryId`: string
      - `moduleName`: string — Exact module specifier imported by the Loader entry.
      - `enabled`: boolean — Effective Loader enablement, including disabled ancestor groups.
      - `fiberPhase`: string|string|string|string|string
  - `agentPresets?`: object[] — Per-preset compositions, present only when an agent-preset roster is composed in this deployment.
    - *(元素)*:
      - `id`: string — Stable preset id.
      - `trust`: string|string — Whether the deployment ships the preset or the user owns it.
      - `name?`: string — Display name the preset published; a reader falls back to the id.
      - `isDefault`: boolean — Whether a session naming no preset composes this one.
      - `broken?`: string — Why this preset's composition cannot be read; absent when rows answer.
      - `rows`: object[] — Plugin rows in composition order; empty when the preset is broken.
        - *(元素)*:
          - `entryId`: string — Composition row id, or null when the row declares none.
          - `moduleName`: string — Module specifier the row names.
          - `enabled`: boolean|boolean|string — Effective enablement, including disabled ancestor groups. `'conditional'` marks a `!!js` disabled expression on a composition no session has mounted, which onl…
          - `condition?`: string — The row's own `!!js` disabled expression, when it carries one.
          - `fiberPhase`: string|string|string|string|string — Root-fiber phase when the composition is live; null otherwise.

### `dynamicCordisRunner/*` — 动态 Cordis 包(运行卡片/inspect)

#### `dynamicCordisRunner/undefineFromPanel` · unary · ○ 静态可用(本轮未触发)

Remove a Plugin from the user panel and queue the resulting state change for the model's next step.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
        
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `dynamicCordisRunner/runHostHalf` · unary · ○ 静态可用(本轮未触发)

Start Host code for an approved request or a direct panel gesture.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - `plugin`: string
            - `f
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `dynamicCordisRunner/getClientCode` · unary · ○ 静态可用(本轮未触发)

Fetch Client code for the exact active run.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - `plugin`: string
            - `form?`: never
        
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `dynamicCordisRunner/resolveRequestRun` · unary · ○ 静态可用(本轮未触发)

Resolve one model-driven Client activation request.

**Request 字段:**
- `req`: string

**Response 字段:**
- **DynamicCordisResolveAck**
  - `accepted`: boolean — False for late, unknown, or stale answers.

#### `dynamicCordisRunner/settleUserRun` · unary · ○ 静态可用(本轮未触发)

Settle a direct panel run after this page loaded or failed its Client half.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - `plugin`: string
     
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `dynamicCordisRunner/stopFromPanel` · unary · ○ 静态可用(本轮未触发)

Stop a Plugin from the user panel and queue the resulting state change for the model's next step.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - 
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `dynamicCordisRunner/syncInspectManifest` · unary · ◉ **live 实测**

Replace the Host mirror of the Client inspect provider directory.

**Request 字段:**
- `req`: object[]
  - *(元素)*:
    - `id`: string — Provider identity, unique within one platform.
    - `description`: string — Capability described by this provider.
    - `methods`: object[] — Explicit read-only queries.
      - *(元素)*:
        - `name`: string — Method name, unique within its provider.
        - `description`: string — What the query returns and when to use it.
        - `inputSchema`: json (any JSON value) — JSON Schema accepted by the query.
        - `outputSchema`: json (any JSON value) — JSON Schema produced by the query.

**Response 字段:**
- null

#### `dynamicCordisRunner/resolveInspectQuery` · unary · ○ 静态可用(本轮未触发)

Claim one pending Client inspect query with its live result.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - `plugin`: string
            - 
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `dynamicCordisRunner/inventory` · unary · ◉ **live 实测**

Frame-wide inventory, grouped as one row per stable Plugin.

**Request 字段:**
- *(无参数)*

**Response 字段:**
- object[]
  - *(元素)*:
    - `pluginId`: string — Stable plugin instance.
    - `agentId`: string ⌾SessionId — Session that owns this plugin.
    - `packages`: object[] — Immutable versions in define order.
      - *(元素)*:
        - `packageId`: string — Immutable package version.
        - `name`: string — Package label.
        - `purpose`: string — User-facing purpose.
        - `hasHostHalf`: boolean — Whether this version contains Host code.
        - `hasClientHalf`: boolean — Whether this version contains Client code.
    - `currentPackageId?`: string — Last package that completed activation successfully.
    - `nextPackageId?`: string — Package selected for a failed or in-progress transition.
    - `activeRun?`: object — Current activation, absent while stopped.
      - `pluginRunId`: string
      - `packageId`: string
    - `latestRun?`: object — Latest activation attempt, including pending approval and diagnostics.
      - `pluginRunId`: string — Exact attempt identity.
      - `packageId`: string — Target Package.
      - `mode`: string|string — Explicit run/update intent.
      - `status`: string|string|string|string|string|string|string|string|string — Current attempt state.
      - `approvalRequestId?`: string — Pending Client activation request; it represents approval only when `requiresApproval` is true.
      - `requiresApproval?`: boolean — Whether the pending Client activation requires a user decision.
      - `host`: object — Host-half state.
        - `status`: string|string|string|string|string|string — Lifecycle state of this half.
        - `waitingFor`: string[] — Services still needed by a successfully created Fiber.
        - `error?`: string — Failure text for this half.
      - `client`: object — Client-half state.
        - `status`: string|string|string|string|string|string — Lifecycle state of this half.
        - `waitingFor`: string[] — Services still needed by a successfully created Fiber.
        - `error?`: string — Failure text for this half.
      - `error?`: object — Most recent failure.
        - `phase`: string|string|string|string|string|string — Stage that failed.
        - `message`: string — Original failure text.
        - `stack?`: string — Original failure stack when available.
        - `pluginId`: string — Stable Plugin identity.
        - `packageId`: string — Immutable Package identity.
        - `pluginRunId`: string — Exact attempt identity.

#### `dynamicCordisRunner/reportRenderFailure` · unary · ○ 静态可用(本轮未触发)

Record a post-load render failure for the exact active run.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - `plugin`: string
            - `
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `dynamicCordisRunner/reportClientGuardFailure` · unary · ○ 静态可用(本轮未触发)

Report a Client guard rejection that happened after the Package completed activation.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
            - `kind`: string
            - `
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `dynamicCordisRunner/invoke` · unary · ○ 静态可用(本轮未触发)

Invoke an active Host method while rejecting stale Client runs.

**Request 字段:**
- `req`: string

**Response 字段:**
- object|object
  - 变体 `{ ok: true; value: JsonValue; }`:
    - `ok`: boolean
    - `value`: json (any JSON value)
  - 变体 `{ ok: false; code: "plugin-not-running" | "stale-run" | "method-not-found" | "handler-error"; } & CordisErrorDetails`:
    - `ok`: boolean
    - `code`: string|string|string|string
    - `message`: string — Original error message.
    - `stack?`: string — Original stack when the thrown value supplied one.

### `sessionReferenceResolver/*` — 会话引用解析(@session)

#### `sessionReferenceResolver/candidates` · unary · ○ 静态可用(本轮未触发)

Remote face of {@link listCandidates}: the configured candidate limit applies, and every candidate carries the canonical mention a host inserts into the prompt…

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: string; } & 
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


### `agentTeams/*` — 实验:多 agent 团队

#### `agentTeams/view` · unary · ○ 静态可用(本轮未触发)

Read the current roster and non-deleted task board through the generated Remote API.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
    - `subagentDepth?`: number — Delegation depth: zero for a top-level agent and parent depth + 1 for a child.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: 
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `agentTeams/createTask` · unary · ○ 静态可用(本轮未触发)

Create one shared task through the generated Remote API.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
    - `subagentDepth?`: number — Delegation depth: zero for a top-level agent and parent depth + 1 for a child.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plugin"; plugin: stri
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*


#### `agentTeams/updateTask` · unary · ○ 静态可用(本轮未触发)

Apply one task mutation and preserve Team rejections as business results.

**Request 字段:**
- **Agent**
  - `id`: string ⌾SessionId — Session-backed Agent identity.
  - `options`: object — The provider route and model this agent's requests use.
    - `provider?`: string — Provider route (must have a registered adapter at call time).
    - `model?`: string — Model id interpreted by the selected provider adapter.
    - `reasoningEffort?`: string — Adapter-owned reasoning effort for the selected provider/model route.
    - `maxTokens?`: number — Maximum output tokens for each conversation-model request.
    - `subagentDepth?`: number — Delegation depth: zero for a top-level agent and parent depth + 1 for a child.
  - `session`: object — The live session this agent drives; its log is the durable source of truth.
    - `log`: any
    - `surfaceManager`: any — Single incremental owner of surface acceptance and projection state.
    - `surface`: object — The ordered surface over this session's event log.
      - `nodes`: number[] — Current surface event sequences in model-visible order.
      - `replaceGeneration`: number — Monotonic count of committed positional replacements.
    - `header`: object — Detached, deep-frozen creation metadata (format version, cwd, lineage, and whether fork history exists). Supplied by the store via `ctx.sessions.create()`. Whe…
      - `version`: number — On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the session is created. A persistence backend rejects any other version on load (no mi…
      - `id`: string ⌾SessionId — The session's id (mirrors the {@link Session }'s id).
      - `createdAt`: number — Non-negative safe-integer Unix epoch milliseconds when the session was created.
      - `cwd?`: string — Absolute working directory the session was created in (if any).
      - `parentSession?`: string ⌾SessionId — The session this one was forked from (seed lineage), if any.
      - `isSeeded`: boolean — Whether this Session contains a fork-inherited event prefix. The exact prefix length is Session state rather than ordinary header metadata.
      - `origin?`: string — Coarse product classification for a session created as a subagent child. This is presentation metadata, not proof that the child is continuable.
      - `delegationDepth?`: number — Delegation depth: absent (zero) for a top-level session, parent depth + 1 for a subagent child. Persisted so a recursion budget survives restart and resume — a…
      - `agentPreset?`: string — Id of the agent preset this session's agent was composed from, when the deployment composes per session. Durable because the preset decides the session's tools…
    - `inheritedEventCount`: number — Number of leading events inherited from this Session's fork parent.
    - `id`: string ⌾SessionId — The session identity, derived from its durable header's single copy.
    - `firstLiveSeq`: number — The first seq appended IN THIS PROCESS: the length of the constructor seed (0 without one). Events with smaller seq values entered through construction — repla…
    - `eventsSnapshot`: any — Cached immutable full snapshot of the private append-only log.
    - `eventAt`: function — Return the immutable event stored at one exact sequence number.
    - `snapshotEvents`: function — Materialize an immutable snapshot of a half-open event sequence range. A full current snapshot is reused until the next append; every previously returned snaps…
    - `ownEvents`: function — Return this Session's events after its fork-inherited prefix.
    - `isOwnSeq`: function — Whether one existing event position is outside the fork-inherited prefix.
    - `seq`: number — The next event's sequence number — always the log length (the `seq = log.length` contiguity contract).
    - `append`: function — Append one typed event to the log and synchronously notify observers via the store-owned, module-private publication hooks. The hot path never blocks on I/O — …
    - `headerFold`: any — Cached fold of the request-header events — see {@link requestHeader}.
    - `headerFoldSeq`: any — Log position (events consumed) the header fold has reached.
    - `requestHeader`: function — The {@link EpochHeader} in force after the log's last header event — the header the NEXT request will be compared against — or undefined before the first `requ…
    - `contextFold`: any — Cached fold of `request/context` events.
    - `contextFoldSeq`: any
    - `requestContext`: function — Return the latest resolved route metadata, or `undefined` before the first `request/context` event. Each event is folded once.
    - `derived`: any — The derived-message cache: frozen projections, extended per unseen node.
    - `derivedNodes`: any — Surface position (nodes projected) the cache has reached.
    - `derivedGeneration`: any — {@link SurfaceManager.replaceGeneration } the cache was built under.
    - `deriveMessages`: function — Derive the LLM message history by walking the ordered sequences of message-producing events maintained by `surfaceOp` markers. The surface is the single source…
    - `deriveEventMessage`: function — Instance face of the pure per-node `deriveEventMessage` export from `surface.ts`.
  - `inbox`: object — The agent-owned projection of durable pending work.
    - `session`: any
    - `notifications`: any
    - `state`: any
    - `nextTurn`: object[] — Prompts awaiting individual turns.
      - *(元素)*:
        - `role`: string — Provider-neutral conversation role.
        - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
        - `content`: object|object|object|object|object[] — Exact model-facing blocks.
        - `source`: object|object|object|object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
          - 变体 `{ kind: "user"; }`:
            - `kind`: string
          - 变体 `{ kind: "plug
  - …*(深展开截断——该响应内嵌大型共享 manifest;完整字段树见 `webui-wire-data/remote-inventory.json`)*



## 二、会话事件类型全表(SessionEventMap 核心+插件合并,51 种;live 观测 12 种)

> 这是 `session/follow` 的 `event` 帧 `value.event.data` 的载荷字典,也是**对接方要产出的日志词汇表**。
> `ignorable: true` 语义:读者不认识可安全跳过;未标记的未知事件读者必须拒绝。

#### 事件 `agent-preset/selected`

The session's agent preset was chosen after creation, while the session was still blank. Log-only: it records the composition later turns ran under, so a resum…

**data 字段:**

- **{ agentPreset: string; }**
  - `agentPreset`: string

*来源: `packages/preset/agent-presets/src/session.ts`*

#### 事件 `agent/inbox/spliced`

One normalized mutation of an agent's durable pending-message lists. Live dispatch precedes projection mutation, so synchronous observers may read the pre-spli…

**data 字段:**

- **{ target: InboxTarget; start: number; removedCount?: number; inserted: UserMessage[]; outcome?: "canceled"; }**
  - `target`: string|string
  - `start`: number
  - `removedCount?`: number
  - `inserted`: object[]
    - *(元素)*:
      - `role`: string — Provider-neutral conversation role.
      - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
      - `content`: object|object|object|object|object[] — Exact model-facing blocks.
      - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
        - 变体 `{ kind: "user"; }`:
          - `kind`: string
        - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
          - `kind`: string
          - `plugin`: string
          - `form?`: never
        - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "instructions"; }`:
          - `kind`: string
          - `plugin`: string
          - `form`: string
        - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "catalog"; }`:
          - `kind`: string
          - `plugin`: string
          - `form`: string
        - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "snapshot"; readonly sections: readonly ContextSnapshotSection[]; }`:
          - `kind`: string
          - `plugin`: string
          - `form`: string
          - `sections`: object[] — The named contributions this snapshot assembled, in order.
            - *(元素)*:
              - `name`: string — The contributing subsystem's name.
              - `text`: string — That contribution's model-facing text, exactly as assembled.
        - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "notice"; readonly summary: string; }`:
          - `kind`: string
          - `plugin`: string
          - `form`: string
          - `summary`: string — One-line account of what happened, shown without expanding the row.
        - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "relay"; }`:
          - `kind`: string
          - `plugin`: string
          - `form`: string
        - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "recall"; }`:
          - `kind`: string
          - `plugin`: string
          - `form`: string
        - 变体 `ModelMessageSource`:
          - `kind`: string
          - `provider`: string — Provider route that produced the message.
          - `model`: string — Provider model id that produced the message.
          - `replayState?`: unknown — Lossless-JSON adapter state needed to replay the provider response. `LlmRuntime` exposes it to a target adapter only when that adapter instance currently owns …
        - 变体 `ToolMessageSource`:
          - `kind`: string
          - `callId`: string ⌾ToolCallId
  - `outcome?`: string

*来源: `packages/core/agent/src/types.ts`*

#### 事件 `approval/asked`

An approval question was put to the answerer chain — log-only audit (like `hook/*`; NOT a surface event, carries no `surfaceOp`). `id` pairs it with the `appro…

**data 字段:**

- **{ id: ApprovalRequestId; toolName: string; callId?: ToolCallId; reason?: string; }**
  - `id`: string
  - `toolName`: string
  - `callId?`: string ⌾ToolCallId
  - `reason?`: string

*来源: `packages/interaction/user-approval/src/types.ts`*

#### 事件 `approval/decided`

The outcome of a prior `approval/asked` (same `id`) — log-only audit. Exactly one per ask, appended when the outcome is known: a decision, a cancellation, or t…

**data 字段:**

- **{ id: ApprovalRequestId; outcome: ApprovalOutcome; }**
  - `id`: string
  - `outcome`: string|string|string|string

*来源: `packages/interaction/user-approval/src/types.ts`*

#### 事件 `approval/policy`

The session's approval policy was switched — log-only, durable, replayable, never in the model transcript (the model learns the policy from the runtime-context…

**data 字段:**

- **{ policy: ApprovalPolicy; source?: "delegation"; }**
  - `policy`: string|string
  - `source?`: string — Marks an override seeded into a child at delegation.

*来源: `packages/interaction/user-approval/src/index.ts`*

#### 事件 `assistant/chunk`

Raw stream chunk — token-level replay fidelity.

**data 字段:**

- **{ turn: number; step: number; chunk: StreamChunk; }**
  - `turn`: number
  - `step`: number
  - `chunk`: object|object|object|object|object|object|object
    - 变体 `{ type: "block-start"; index: number; blockType: keyof ContentBlockMap; }`:
      - `type`: string
      - `index`: number
      - `blockType`: string|string|string|string|string
    - 变体 `{ type: "text-delta"; index: number; text: string; }`:
      - `type`: string
      - `index`: number
      - `text`: string
    - 变体 `{ type: "reasoning-delta"; index: number; text: string; }`:
      - `type`: string
      - `index`: number
      - `text`: string
    - 变体 `{ type: "tool-call-delta"; index: number; id: ToolCallId; name?: string; argumentsDelta: string; }`:
      - `type`: string
      - `index`: number
      - `id`: string ⌾ToolCallId
      - `name?`: string
      - `argumentsDelta`: string
    - 变体 `{ type: "block-end"; index: number; block: ContentBlock; }`:
      - `type`: string
      - `index`: number
      - `block`: object|object|object|object|object
        - 变体 `TextBlock`:
          - `type`: string
          - `text`: string
        - 变体 `ReasoningBlock`:
          - `type`: string
          - `text`: string
        - 变体 `ImageBlock`:
          - `type`: string
          - `attachment`: object — Immutable bytes and intrinsic display metadata owned by the attachment service.
            - `attachmentId`: string — Opaque storage identifier; never a filesystem path or bearer URL.
            - `mediaType`: string|string|string|string — Media type verified from the stored bytes.
            - `bytes`: number — Exact encoded byte length.
            - `width`: number — Intrinsic encoded width in pixels.
            - `height`: number — Intrinsic encoded height in pixels.
            - `name?`: string — Optional display name stripped of local path information.
            - `originalDimensions?`: object — Input dimensions after applying EXIF orientation and before normalization scaling. Present only when normalization reduced the image.
              - `width`: number
              - `height`: number
        - 变体 `ToolCallBlock`:
          - `type`: string
          - `id`: string ⌾ToolCallId — Provider-issued call id; correlates with the matching tool result.
          - `name`: string
          - `arguments`: string — Raw JSON string as produced by the model.
        - 变体 `ToolResultBlock`:
          - `type`: string
          - `toolCallId`: string ⌾ToolCallId
          - `content`: object|object|object|object|recursive[]
          - `isError?`: boolean
    - 变体 `{ type: "usage"; usage: TokenUsage; }`:
      - `type`: string
      - `usage`: object
        - `inputTokens`: number
        - `outputTokens`: number
        - `totalTokens?`: number — Exact full-call total including aggregate prompt and output tokens. Adapters preserve a provider total or derive it from authoritative aggregate prompt/output …
        - `cacheReadTokens?`: number
        - `cacheWriteTokens?`: number
        - `reasoningTokens?`: number
    - 变体 `{ type: "finish"; reason: FinishReason; replayState?: ReplayEnvelope; }`:
      - `type`: string
      - `reason`: object|object|object|object|object
        - 变体 `{ kind: "aborted"; failure: LlmFailure; }`:
          - `kind`: string
          - `failure`: object
            - `message`: string — Human-readable provider or transport failure.
            - `code`: string — Stable provider-neutral machine-routing code.
            - `status?`: number — HTTP status returned by the provider, when available.
            - `providerRetryAfterMs?`: number — Provider-requested delay in milliseconds, when valid and available.
            - `requestId?`: string — Opaque provider-issued request identifier for diagnostics.
        - 变体 `{ kind: "error"; failure: LlmFailure; }`:
          - `kind`: string
          - `failure`: object
            - `message`: string — Human-readable provider or transport failure.
            - `code`: string — Stable provider-neutral machine-routing code.
            - `status?`: number — HTTP status returned by the provider, when available.
            - `providerRetryAfterMs?`: number — Provider-requested delay in milliseconds, when valid and available.
            - `requestId?`: string — Opaque provider-issued request identifier for diagnostics.
        - 变体 `{ kind: "max-tokens"; }`:
          - `kind`: string
        - 变体 `{ kind: "stop"; }`:
          - `kind`: string
        - 变体 `{ kind: "tool-calls"; }`:
          - `kind`: string
      - `replayState?`: object — Replay metadata for a successful response; see {@link ReplayEnvelope}.
        - `response`: unknown — Response-level adapter-private metadata (ids, native stop reason).
        - `blocks?`: unknown[] — Per-block adapter-private metadata, one entry per emitted block in first-seen stream order. When assembly drops a block it drops the entry at the same position…

*来源: `packages/core/session/src/types.ts`*

#### 事件 `assistant/message`

Assembled assistant message for one step (derived history uses this). Carries the step's `usage` when the adapter reported token accounting, so the model outpu…

**data 字段:**

- **{ turn: number; step: number; message: AssistantMessage; usage?: TokenUsage; interrupted?: true; }**
  - `turn`: number
  - `step`: number
  - `message`: object
    - `role`: string — Provider-neutral conversation role.
    - `source`: object — Required source fields supplied by the producer.
      - `kind`: string
      - `provider`: string — Provider route that produced the message.
      - `model`: string — Provider model id that produced the message.
      - `replayState?`: unknown — Lossless-JSON adapter state needed to replay the provider response. `LlmRuntime` exposes it to a target adapter only when that adapter instance currently owns …
    - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
    - `content`: object|object|object|object|object[] — Exact model-facing blocks.
  - `usage?`: object
    - `inputTokens`: number
    - `outputTokens`: number
    - `totalTokens?`: number — Exact full-call total including aggregate prompt and output tokens. Adapters preserve a provider total or derive it from authoritative aggregate prompt/output …
    - `cacheReadTokens?`: number
    - `cacheWriteTokens?`: number
    - `reasoningTokens?`: number
  - `interrupted?`: boolean

*来源: `packages/core/session/src/types.ts`*

#### 事件 `command/done`

The paired command settled. `kind`/`text` carry the handler's verbatim outcome (a thrown/aborted handler settles as `kind: 'error'` with the rendered failure).…

**data 字段:**

- **{ commandId: CommandId; kind: "success" | "error"; text?: string; sourceEventSeq?: SessionSeq; }**
  - `commandId`: string
  - `kind`: string|string
  - `text?`: string
  - `sourceEventSeq?`: number

*来源: `packages/interaction/commands/src/types.ts`*

#### 事件 `command/run`

A resolved slash command entered its handler. Log-only (never model surface); paired with `command/done` by `commandId`, mirroring the `tool/call`↔`tool/result…

**data 字段:**

- **{ commandId: CommandId; name: string; args?: string; source: { kind: "user"; }; }**
  - `commandId`: string
  - `name`: string
  - `args?`: string
  - `source`: object
    - `kind`: string

*来源: `packages/interaction/commands/src/types.ts`*

#### 事件 `compaction/end`

Marks the end of a compaction — log-only, releases the lock. Its owner matches `compaction/start`; `error` records an unsuccessful attempt.

**data 字段:**

- **{ compactionId: CompactionId; sourceCommandId?: CommandId; turn: number; error?: string; }**
  - `compactionId`: string
  - `sourceCommandId?`: string
  - `turn`: number
  - `error?`: string

*来源: `packages/compaction/compaction/src/types.ts`*

#### 事件 `compaction/prune`

Shadow price of one model-free prune replacement — log-only, no surfaceOp. The shared shadow-price protocol: a surface `replace` event is priced by the meterin…

**data 字段:**

- **{ shadowedRange: { start: SessionSeq; end: SessionSeq; }; shadowedSeqs: SessionSeq[]; shadowedTokenCount: number; }**
  - `shadowedRange`: object — The replaced range's first and last surface-node seqs (a surface-position span, like {@link CompactionResult.shadowedRange}).
    - `start`: number
    - `end`: number
  - `shadowedSeqs`: number[] — The seqs of all shadowed surface nodes, in surface order.
  - `shadowedTokenCount`: number — Heuristic price of the shadowed content under the token-meter's fixed estimator.

*来源: `packages/compaction/compaction/src/types.ts`*

#### 事件 `compaction/start`

Marks the start of a compaction — log-only, holds the lock until `compaction/end`. A numbered owner is strictly enclosed by that open turn; `null` identifies a…

**data 字段:**

- **{ compactionId: CompactionId; sourceCommandId?: CommandId; turn: number; }**
  - `compactionId`: string
  - `sourceCommandId?`: string
  - `turn`: number

*来源: `packages/compaction/compaction/src/types.ts`*

#### 事件 `compaction/summary`

Completed summary, its inputs, and its model call facts — log-only, no surfaceOp. The summary content is in `data.summary`; the actual surface replacement is p…

**data 字段:**

- object|object
  - 变体 `{ compactionId: CompactionId; sourceCommandId?: CommandId; summary: ContentBlock[]; shadowedRange: { start: SessionSeq; end: SessionSeq; }; ... 5 more ...; usage?: TokenUsage; } & { ...; }`:
    - `compactionId`: string
    - `sourceCommandId?`: string
    - `summary`: object|object|object|object|object[]
    - `shadowedRange`: object
      - `start`: number
      - `end`: number
    - `shadowedSeqs`: number[]
    - `shadowedTokenCount`: number
    - `provider`: string — The provider route that wrote the summary.
    - `model`: string — The model that wrote the summary — the summarize call's envelope, reported by the backend that made the call, logged so the one-shot request is reconstructable…
    - `maxTokens?`: number — The generation cap the summarize call sent, when one applied.
    - `usage?`: object — Provider-reported token usage for the summarization request, when emitted.
      - `inputTokens`: number
      - `outputTokens`: number
      - `totalTokens?`: number — Exact full-call total including aggregate prompt and output tokens. Adapters preserve a provider total or derive it from authoritative aggregate prompt/output …
      - `cacheReadTokens?`: number
      - `cacheWriteTokens?`: number
      - `reasoningTokens?`: number
    - `rawOutput`: object|object|object|object|object[] — Complete provider output before the backend's safe summary projection.
    - `llmStreamCall`: boolean — Identifies exactly one call through this context's `ctx.llm.stream()`.
  - 变体 `{ compactionId: CompactionId; sourceCommandId?: CommandId; summary: ContentBlock[]; shadowedRange: { start: SessionSeq; end: SessionSeq; }; ... 5 more ...; usage?: TokenUsage; } & { ...; }`:
    - `compactionId`: string
    - `sourceCommandId?`: string
    - `summary`: object|object|object|object|object[]
    - `shadowedRange`: object
      - `start`: number
      - `end`: number
    - `shadowedSeqs`: number[]
    - `shadowedTokenCount`: number
    - `provider`: string — The provider route that wrote the summary.
    - `model`: string — The model that wrote the summary — the summarize call's envelope, reported by the backend that made the call, logged so the one-shot request is reconstructable…
    - `maxTokens?`: number — The generation cap the summarize call sent, when one applied.
    - `usage?`: object — Provider-reported token usage for the summarization request, when emitted.
      - `inputTokens`: number
      - `outputTokens`: number
      - `totalTokens?`: number — Exact full-call total including aggregate prompt and output tokens. Adapters preserve a provider total or derive it from authoritative aggregate prompt/output …
      - `cacheReadTokens?`: number
      - `cacheWriteTokens?`: number
      - `reasoningTokens?`: number
    - `rawOutput?`: object|object|object|object|object[] — Optional complete output from an unmarked template, remote, or other summarizer.
    - `llmStreamCall?`: never — An unmarked summary does not identify a call through this context's LLM seam.

*来源: `packages/compaction/compaction/src/types.ts`*

#### 事件 `feedback/record`

One recorded human remark about this session. Log-only and independent of its trigger; it never enters model context or derived history.

**data 字段:**

- **{ text: string; }**
  - `text`: string

*来源: `packages/feedback/command-feedback/src/index.ts`*

#### 事件 `goal/change`

Complete post-mutation goal state or clear tombstone.

**data 字段:**

- object|object
  - 变体 `GoalSnapshotChangeMeta`:
    - `kind`: string
    - `version`: number
    - `operation`: string|string|string|string|string|string
    - `goal`: object
      - `objective`: string — Human-requested completion objective.
      - `phase`: string|string|string|string — Durable lifecycle phase.
      - `blockedReason?`: object — Present exactly while `phase` is `blocked`.
        - `code`: string — Stable lower-kebab-case classification chosen by the blocking policy.
        - `message`: string — Non-empty explanation shown to humans and models.
      - `maxGoalRounds`: number — Total admitted goal-round cap.
      - `id`: string — Stable goal identity.
      - `revision`: number — Positive revision; every durable mutation increments it.
    - `roundsStarted`: number
    - `createdAt`: number
    - `updatedAt`: number
  - 变体 `GoalClearChangeMeta`:
    - `kind`: string
    - `version`: number
    - `operation`: string
    - `cleared`: object
      - `id`: string — Stable goal identity.
      - `revision`: number — Positive revision; every durable mutation increments it.
    - `clearedAt`: number

*来源: `packages/goal/goal/src/domain.ts`*

#### 事件 `hook/invoked`

A hook command was invoked at a hook point — a log-only record (like `compaction/*`; NOT a {@link SurfaceEventType }, carries no `surfaceOp`). `dialect` is the…

**data 字段:**

- **{ turn: number; point: string; dialect: HookDialect; matcher?: string; handlerId: string; }**
  - `turn`: number
  - `point`: string
  - `dialect`: string|string
  - `matcher?`: string
  - `handlerId`: string

*来源: `packages/hooks/hook-protocol/src/types.ts`*

#### 事件 `hook/result`

Log-only outcome paired to `hook/invoked` by `handlerId`. Decision is the parsed permission result, `stop` for `continue:false`, or `pass`; exit code may be ab…

**data 字段:**

- **{ turn: number; point: string; handlerId: string; decision: string; exitCode?: number; stderrSummary?: string; durationMs: number; }**
  - `turn`: number
  - `point`: string
  - `handlerId`: string
  - `decision`: string
  - `exitCode?`: number
  - `stderrSummary?`: string
  - `durationMs`: number

*来源: `packages/hooks/hook-protocol/src/types.ts`*

#### 事件 `llm/retry`

Durable, non-surface record of one provider-routed retry scheduled after a failed request attempt.

**data 字段:**

- object|object
  - 变体 `{ retryId: RetryId; turn: number; step: number; provider: string; mode: "normal"; policyKey: string; retry: number; maxRetries: number; delayMs: number; failure: LlmFailure; }`:
    - `retryId`: string
    - `turn`: number
    - `step`: number
    - `provider`: string
    - `mode`: string
    - `policyKey`: string
    - `retry`: number
    - `maxRetries`: number
    - `delayMs`: number
    - `failure`: object
      - `message`: string — Human-readable provider or transport failure.
      - `code`: string — Stable provider-neutral machine-routing code.
      - `status?`: number — HTTP status returned by the provider, when available.
      - `providerRetryAfterMs?`: number — Provider-requested delay in milliseconds, when valid and available.
      - `requestId?`: string — Opaque provider-issued request identifier for diagnostics.
  - 变体 `{ retryId: RetryId; turn: number; step: number; provider: string; mode: "always"; policyKey: string; retry: number; delayMs: number; failure: LlmFailure; }`:
    - `retryId`: string
    - `turn`: number
    - `step`: number
    - `provider`: string
    - `mode`: string
    - `policyKey`: string
    - `retry`: number
    - `delayMs`: number
    - `failure`: object
      - `message`: string — Human-readable provider or transport failure.
      - `code`: string — Stable provider-neutral machine-routing code.
      - `status?`: number — HTTP status returned by the provider, when available.
      - `providerRetryAfterMs?`: number — Provider-requested delay in milliseconds, when valid and available.
      - `requestId?`: string — Opaque provider-issued request identifier for diagnostics.

*来源: `packages/llm/llm-retry/src/types.ts`*

#### 事件 `llm/retry-started`

Durable transition written after a retry wait succeeds and before the next request attempt starts.

**data 字段:**

- **LlmRetryStartedEventData**
  - `retryId`: string
  - `turn`: number
  - `step`: number
  - `retry`: number

*来源: `packages/llm/llm-retry/src/types.ts`*

#### 事件 `model/selection`

Complete validated model selection requested for subsequent prompt assembly. Log-only: it never enters derived model history.

**data 字段:**

- **ModelSelection**
  - `provider`: string
  - `model`: string
  - `reasoningEffort?`: string

*来源: `packages/api/session-controller/src/types.ts`*

#### 事件 `permission/preset`

Records the selected preset as durable, log-only user intent. The knob events follow in the same turn and control execution; this event stays out of the model …

**data 字段:**

- **{ preset: string; }**
  - `preset`: string

*来源: `packages/interaction/permission-presets/src/index.ts`*

#### 事件 `plan/mode`

Whether plan mode is in force from this point on: log-only, non-surface, whole-value replace. The last `plan/mode` wins; a log with none folds to inactive thro…

**data 字段:**

- **{ active: boolean; }**
  - `active`: boolean

*来源: `packages/plan/plan-mode/src/index.ts`*

#### 事件 `request/context`

Route metadata for the next request, logged only when the route or capacity changes. It does not participate in request reconstruction or header equality.

**data 字段:**

- **RequestContext**
  - `provider`: string — Registered provider route the metadata belongs to.
  - `model`: string — Provider-owned model id the metadata belongs to.
  - `contextWindow?`: number — Maximum combined request and response context in tokens, when advertised.

*来源: `packages/core/session/src/types.ts`*

#### 事件 `request/header`

Full header for the next request, appended inside its step before dispatch. It is log-only; the latest snapshot reconstructs the request header.

**data 字段:**

- **{ header: EpochHeader; reason: RequestHeaderReason; startsSeries?: true; }**
  - `header`: object
    - `config`: object — The conversation's call configuration (provider, model, reasoning effort, and sampling scalars).
      - `provider`: string
      - `model`: string
      - `reasoningEffort?`: string
      - `temperature?`: number
      - `maxTokens?`: number
      - `stop?`: string[]
    - `adapterDefaults?`: object — Effective config fields materialized from the exact adapter rather than proposed by a caller.
      - `reasoningEffort?`: boolean
      - `maxTokens?`: boolean
    - `system?`: string — Rendered system prompt text; absent for a system-less request.
    - `tools?`: object[] — Assembled tool schemas; absent for a tool-less request.
      - *(元素)*:
        - `name`: string
        - `description`: string
        - `parameters`: record<string, …> — JSON Schema object for the arguments.
  - `reason`: string|string|string|string
  - `startsSeries?`: boolean — A changed header also begins a distinct model-message series.

*来源: `packages/core/session/src/types.ts`*

#### 事件 `sandbox/mode`

The session's sandbox mode was switched — log-only (like `approval/*`; NOT a surface event, carries no `surfaceOp`): durable and replayable, never in the model…

**data 字段:**

- **{ mode: SandboxMode; source?: "delegation"; }**
  - `mode`: string|string|string
  - `source?`: string — Marks an override seeded into a child at delegation.

*来源: `packages/sandbox/sandbox-policy/src/session-mode.ts`*

#### 事件 `schedule/change`

Versioned Schedule mutation. The owning package validates the complete session-local transition stream before accepting a candidate event.

**data 字段:**

- object|object|object|object
  - 变体 `ScheduleCreateChange`:
    - `version`: number
    - `operation`: string
    - `schedule`: object|object|object
      - 变体 `AfterScheduleRecord`:
        - `id`: string — Session-local stable identity.
        - `kind`: string — Rule discriminator for a delayed one-shot reminder.
        - `prompt`: string — Trimmed reminder content supplied at creation.
        - `afterSeconds`: number — Positive safe-integer delay accepted at creation.
        - `scheduledAt`: string — Four-digit-year RFC 3339 UTC target.
      - 变体 `AtScheduleRecord`:
        - `id`: string — Session-local stable identity.
        - `kind`: string — Rule discriminator for an absolute one-shot reminder.
        - `prompt`: string — Trimmed reminder content supplied at creation.
        - `scheduledAt`: string — Four-digit-year RFC 3339 UTC target.
      - 变体 `EveryScheduleRecord`:
        - `id`: string — Session-local stable identity.
        - `kind`: string — Rule discriminator for a fixed-rate recurring reminder.
        - `prompt`: string — Trimmed reminder content supplied at creation.
        - `everySeconds`: number — Fixed safe-integer interval, never below five minutes.
        - `scheduledAt`: string — Earliest anchor-aligned occurrence not yet dispatched.
  - 变体 `ScheduleDeleteChange`:
    - `version`: number
    - `operation`: string
    - `id`: string
  - 变体 `OneShotScheduleDispatchChange`:
    - `version`: number
    - `operation`: string
    - `id`: string
  - 变体 `EveryScheduleDispatchChange`:
    - `version`: number
    - `operation`: string
    - `id`: string
    - `acceptedAt`: string — Wall-clock decision time used to select the latest due occurrence.

*来源: `packages/schedule/schedule/src/types.ts`*

#### 事件 `session-log-deepseek/delivery-accepted`

Records that the configured endpoint accepted one delivery through `throughSeq`.

**data 字段:**

- **{ sessionId: SessionId; throughSeq: SessionSeq; }**
  - `sessionId`: string ⌾SessionId — Session identity the accepted delivery carried; inherited fork markers retain the parent's id.
  - `throughSeq`: number — Last canonical event included in the accepted request.

*来源: `packages/session/session-log-deepseek/src/types.ts`*

#### 事件 `session/end-seed`

Marks the end of a constructor seed. Events before it have smaller seq values and came from the seed (resume, fork, or replay); this lifecycle produced none of…

**data 字段:**

- record<string, …>

*来源: `packages/core/session/src/types.ts`*

#### 事件 `session/title`

Latest-wins session title snapshot. Log-only: it never enters the model surface or derived history.

**data 字段:**

- **SessionTitleEventData**
  - `title`: string — Normalized non-empty title text.
  - `messageSeqs`: number[] — Exact human `user/message` seqs used to derive this title; empty for an explicit user rename.
  - `source`: object|object|object — Whether the built-in fallback, a registered provider, or the user supplied the title.
    - 变体 `{ readonly kind: "fallback"; }`:
      - `kind`: string
    - 变体 `{ readonly kind: "provider"; readonly provider: SessionTitleProviderId; readonly model?: SessionTitleModelProvenance; }`:
      - `kind`: string
      - `provider`: string
      - `model?`: object
        - `provider`: string — Registered LLM provider route.
        - `model`: string — Provider model id.
    - 变体 `{ readonly kind: "user"; }`:
      - `kind`: string — Explicit user rename: pins the title — automatic generation stops scheduling.

*来源: `packages/session/session-title/src/index.ts`*

#### 事件 `session/title-llm-request`

Log-only pre-dispatch record of one session-title model request.

**data 字段:**

- **SessionTitleLlmRequestEventData**
  - `titleProvider`: string — Registered title-provider identity responsible for the request.
  - `messageSeqs`: number[] — Exact human `user/message` seqs represented in `messages`.
  - `route`: object — Exact auxiliary LLM route.
    - `provider`: string — Registered LLM provider route.
    - `model`: string — Provider model id.
  - `system`: string — Exact auxiliary system prompt.
  - `messages`: object[] — Exact auxiliary message list.
    - *(元素)*:
      - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
      - `role`: string|string|string — Provider-neutral conversation role.
      - `content`: object|object|object|object|object[] — Exact model-facing blocks.
      - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
        - 变体 `{ kind: "user"; }`:
          - `kind`: string
        - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
          - `kind`: string
          - `plugin`: string
          - `form?`: never
        - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "instructions"; }`:
          - `kind`: string
          - `plugin`: string
          - `form`: string
        - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "catalog"; }`:
          - `kind`: string
          - `plugin`: string
          - `form`: string
        - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "snapshot"; readonly sections: readonly ContextSnapshotSection[]; }`:
          - `kind`: string
          - `plugin`: string
          - `form`: string
          - `sections`: object[] — The named contributions this snapshot assembled, in order.
            - *(元素)*:
              - `name`: string — The contributing subsystem's name.
              - `text`: string — That contribution's model-facing text, exactly as assembled.
        - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "notice"; readonly summary: string; }`:
          - `kind`: string
          - `plugin`: string
          - `form`: string
          - `summary`: string — One-line account of what happened, shown without expanding the row.
        - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "relay"; }`:
          - `kind`: string
          - `plugin`: string
          - `form`: string
        - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "recall"; }`:
          - `kind`: string
          - `plugin`: string
          - `form`: string
        - 变体 `ModelMessageSource`:
          - `kind`: string
          - `provider`: string — Provider route that produced the message.
          - `model`: string — Provider model id that produced the message.
          - `replayState?`: unknown — Lossless-JSON adapter state needed to replay the provider response. `LlmRuntime` exposes it to a target adapter only when that adapter instance currently owns …
        - 变体 `ToolMessageSource`:
          - `kind`: string
          - `callId`: string ⌾ToolCallId
  - `maxTokens`: number — Exact auxiliary output-token cap.

*来源: `packages/session/session-title-llm/src/index.ts`*

#### 事件 `step/end`

Closes step `step` of turn `turn`.

**data 字段:**

- **{ turn: number; step: number; }**
  - `turn`: number
  - `step`: number

*来源: `packages/core/session/src/types.ts`*

#### 事件 `step/start`

Opens step `step` of turn `turn` — one model call plus the tool executions it requested.

**data 字段:**

- **{ turn: number; step: number; }**
  - `turn`: number
  - `step`: number

*来源: `packages/core/session/src/types.ts`*

#### 事件 `subagent/descriptor`

Durable identity and lifecycle mode of a session-backed subagent child, appended once by the establishing provider inside the child's initial turn, before its …

**data 字段:**

- object|object
  - 变体 `OneShotSubagentDescriptorData`:
    - `mode`: string — Whether the child is a terminal one-shot run or a resumable conversation.
    - `label?`: string — The initial delegation's short `description`, kept as the child's durable creation label so enumeration can identify the conversation without replaying parent …
    - `version`: number — Descriptor format version ({@link SUBAGENT_DESCRIPTOR_VERSION}).
    - `provider`: string — The `ctx.subagents` provider name that established the child.
  - 变体 `ContinuableSubagentDescriptorData`:
    - `mode`: string — Whether the child is a terminal one-shot run or a resumable conversation.
    - `label`: string — The initial delegation's short `description`, used for durable enumeration.
    - `agentProvider?`: string — Resolved child `agentOptions.provider`, when one was declared.
    - `agentModel?`: string — Resolved child `agentOptions.model`, when one was declared.
    - `agentReasoningEffort?`: string — Resolved child `agentOptions.reasoningEffort`, when one was declared.
    - `persona?`: string — Per-child persona that shadows the deployment persona on resume.
    - `toolFilter?`: object — Child tool scoping reapplied on resume.
      - `allow?`: string[] — Global tool names that stay visible; everything else is removed.
      - `deny?`: string[] — Global tool names removed from visibility.
    - `version`: number — Descriptor format version ({@link SUBAGENT_DESCRIPTOR_VERSION}).
    - `provider`: string — The `ctx.subagents` provider name that established the child.

*来源: `packages/subagent/subagent/src/descriptor.ts`*

#### 事件 `subagent/model-selection-policy`

Records that this session's delegation tool exposes child provider, model, and reasoning-effort selection. Appended before the first model request; absence mea…

**data 字段:**

- **{ allowedModels: AllowedModelRoute[]; }**
  - `allowedModels`: object[] — Exact routes this Session may select explicitly for a child.
    - *(元素)*:
      - `provider`: string — Registered LLM provider id.
      - `model`: string — Provider-owned exact model id.

*来源: `packages/subagent/tool-subagent/src/model-selection-state.ts`*

#### 事件 `team/member`

Whole teammate lifecycle value, stored only in the Team Lead Session.

**data 字段:**

- **{ version: 1; teamId: TeamId; member: TeamMemberSnapshot; }**
  - `version`: number
  - `teamId`: string
  - `member`: object
    - `id`: string ⌾SessionId
    - `name`: string
    - `description`: string
    - `provider`: string
    - `context`: string|string
    - `phase`: string|string|string
    - `error?`: string

*来源: `packages/experimental/agent-team/src/types.ts`*

#### 事件 `team/message/delivered`

Durable acknowledgement that the target Session recorded the message.

**data 字段:**

- **{ version: 1; teamId: TeamId; messageId: TeamMessageId; targetId: SessionId; }**
  - `version`: number
  - `teamId`: string
  - `messageId`: string ⌾MessageId
  - `targetId`: string ⌾SessionId

*来源: `packages/experimental/agent-team/src/types.ts`*

#### 事件 `team/message/queued`

Durable mailbox enqueue, stored before delivery is attempted.

**data 字段:**

- **{ version: 1; teamId: TeamId; message: TeamMessageSnapshot; }**
  - `version`: number
  - `teamId`: string
  - `message`: object
    - `id`: string ⌾MessageId
    - `senderId`: string ⌾SessionId
    - `senderName`: string
    - `targetId`: string ⌾SessionId
    - `delivery`: string|string
    - `content`: object|object|object|object|object[]

*来源: `packages/experimental/agent-team/src/types.ts`*

#### 事件 `team/task`

Whole shared-task value, stored only in the Team Lead Session.

**data 字段:**

- **{ version: 1; teamId: TeamId; task: TeamTaskSnapshot; }**
  - `version`: number
  - `teamId`: string
  - `task`: object
    - `id`: string
    - `revision`: number
    - `subject`: string
    - `description`: string
    - `status`: string|string|string|string
    - `ownerId?`: string ⌾SessionId
    - `blockedBy`: string[]
    - `writeScopes`: string[]

*来源: `packages/experimental/agent-team/src/types.ts`*

#### 事件 `todo/write`

Whole-list snapshot; latest write wins on replay. Log-only UI state; never derived history.

**data 字段:**

- **{ todos: TodoItem[]; }**
  - `todos`: object[]
    - *(元素)*:
      - `content`: string — What this task is — a short imperative line shown in the UI.
      - `status`: string|string|string — Lifecycle state. `in_progress` marks a task being worked now; parallel work may mark several.

*来源: `packages/todo/tool-todo/src/types.ts`*

#### 事件 `tool-workflow/agent-end`

Records one member settlement.

**data 字段:**

- **ToolWorkflowAgentEndData**
  - `runId`: string
  - `seq`: number
  - `outcome`: string|string|string

*来源: `packages/workflow/tool-workflow/src/types.ts`*

#### 事件 `tool-workflow/agent-start`

Records one published workflow member.

**data 字段:**

- **ToolWorkflowAgentStartData**
  - `runId`: string
  - `seq`: number
  - `label`: string
  - `phase?`: string
  - `childId`: string ⌾SessionId

*来源: `packages/workflow/tool-workflow/src/types.ts`*

#### 事件 `tool-workflow/run-end`

Closes one workflow record after cleanup.

**data 字段:**

- **ToolWorkflowRunEndData**
  - `runId`: string
  - `stopReason`: string|string|string

*来源: `packages/workflow/tool-workflow/src/types.ts`*

#### 事件 `tool-workflow/run-start`

Opens one top-level workflow record.

**data 字段:**

- **ToolWorkflowRunStartData**
  - `runId`: string
  - `name`: string

*来源: `packages/workflow/tool-workflow/src/types.ts`*

#### 事件 `tool/call`

The model requested one tool invocation: `name` with the raw `arguments` JSON string exactly as the model produced it (unparsed). `callId` pairs the call with …

**data 字段:**

- **{ turn: number; step: number; callId: ToolCallId; name: string; arguments: string; }**
  - `turn`: number
  - `step`: number
  - `callId`: string ⌾ToolCallId
  - `name`: string
  - `arguments`: string

*来源: `packages/core/session/src/types.ts`*

#### 事件 `tool/code-dispatch`

One bridged sub-dispatch SETTLING: the pairing ids (matching the `tool/code-dispatch-start` with the same `subCallId`), the tool `name` with the same JSON-norm…

**data 字段:**

- **PtcDispatchEventData**
  - `isError`: boolean
  - `content`: object|object|object|object|object[]
  - `rootCallId`: string ⌾ToolCallId
  - `parentCallId`: string ⌾ToolCallId
  - `subCallId`: string ⌾ToolCallId
  - `name`: string
  - `arguments`: unknown

*来源: `packages/core/tools/src/types.ts`*

#### 事件 `tool/code-dispatch-start`

One sub-dispatch STARTING inside a `run_code` program: the parent `run_code` call id, the deterministic sub-call id (`<parent>:code:<n>`, numbered in submissio…

**data 字段:**

- **PtcDispatchStartEventData**
  - `rootCallId`: string ⌾ToolCallId
  - `parentCallId`: string ⌾ToolCallId
  - `subCallId`: string ⌾ToolCallId
  - `name`: string
  - `arguments`: unknown

*来源: `packages/core/tools/src/types.ts`*

#### 事件 `tool/result`

A completed tool call's model-facing result, optional internal failure identity, and optional tool-private `meta` presentation payload. `meta` is opaque to the…

**data 字段:**

- **{ turn: number; step: number; message: ToolResultMessage; error?: { name: string; code: string; }; meta?: JsonValue; }**
  - `turn`: number
  - `step`: number
  - `message`: object
    - `role`: string — Provider-neutral conversation role.
    - `content`: object — Exact model-facing blocks.
      - `0`: object
        - `type`: string
        - `toolCallId`: string ⌾ToolCallId
        - `content`: object|object|object|object|recursive[]
        - `isError?`: boolean
      - `length`: number
      - `toString`: function — Returns a string representation of an array.
      - `toLocaleString`: function — Returns a string representation of an array. The elements are converted to string using their toLocaleString methods.
      - `pop`: function — Removes the last element from an array and returns it. If the array is empty, undefined is returned and the array is not modified.
      - `push`: function — Appends new elements to the end of an array, and returns the new length of the array.
      - `concat`: function — Combines two or more arrays. This method returns a new array without modifying any existing arrays.
      - `join`: function — Adds all the elements of an array into a string, separated by the specified separator string.
      - `reverse`: function — Reverses the elements in an array in place. This method mutates the array and returns a reference to the same array.
      - `shift`: function — Removes the first element from an array and returns it. If the array is empty, undefined is returned and the array is not modified.
      - `slice`: function — Returns a copy of a section of an array. For both start and end, a negative index can be used to indicate an offset from the end of the array. For example, -2 …
      - `sort`: function — Sorts an array in place. This method mutates the array and returns a reference to the same array.
      - `splice`: function — Removes elements from an array and, if necessary, inserts new elements in their place, returning the deleted elements.
      - `unshift`: function — Inserts new elements at the start of an array, and returns the new length of the array.
      - `indexOf`: function — Returns the index of the first occurrence of a value in an array, or -1 if it is not present.
      - `lastIndexOf`: function — Returns the index of the last occurrence of a specified value in an array, or -1 if it is not present.
      - `every`: function — Determines whether all the members of an array satisfy the specified test.
      - `some`: function — Determines whether the specified callback function returns true for any element of an array.
      - `forEach`: function — Performs the specified action for each element in an array.
      - `map`: function — Calls a defined callback function on each element of an array, and returns an array that contains the results.
      - `filter`: function — Returns the elements of an array that meet the condition specified in a callback function.
      - `reduce`: function — Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as…
      - `reduceRight`: function — Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated resul…
      - `find`: function — Returns the value of the first element in the array where predicate is true, and undefined otherwise.
      - `findIndex`: function — Returns the index of the first element in the array where predicate is true, and -1 otherwise.
      - `fill`: function — Changes all array elements from `start` to `end` index to a static `value` and returns the modified array
      - `copyWithin`: function — Returns the this object after copying a section of the array identified by start and end to the same array starting at position target
      - `entries`: function — Returns an iterable of key, value pairs for every entry in the array
      - `keys`: function — Returns an iterable of keys in the array
      - `values`: function — Returns an iterable of values in the array
      - `includes`: function — Determines whether an array includes a certain element, returning true or false as appropriate.
      - `flatMap`: function — Calls a defined callback function on each element of an array. Then, flattens the result into a new array. This is identical to a map followed by flat with dep…
      - `flat`: function — Returns a new array with all sub-array elements concatenated into it recursively up to the specified depth.
      - `at`: function — Returns the item located at the specified index.
      - `findLast`: function — Returns the value of the last element in the array where predicate is true, and undefined otherwise.
      - `findLastIndex`: function — Returns the index of the last element in the array where predicate is true, and -1 otherwise.
      - `toReversed`: function — Returns a copy of an array with its elements reversed.
      - `toSorted`: function — Returns a copy of an array with its elements sorted.
      - `toSpliced`: function — Copies an array and removes elements and, if necessary, inserts new elements in their place. Returns the copied array. Copies an array and removes elements whi…
      - `with`: function — Copies an array, then overwrites the value at the provided index with the given value. If the index is negative, then it replaces from the end of the array.
      - `__@iterator@19612`: function — Iterator
      - `__@unscopables@19828`: object — Is an object whose properties have the value 'true' when they will be absent when used in a 'with' statement.
        - `length?`: boolean — Gets or sets the length of the array. This is a number one higher than the highest index in the array.
        - `toString?`: boolean — Returns a string representation of an array.
        - `toLocaleString?`: boolean — Returns a string representation of an array. The elements are converted to string using their toLocaleString methods.
        - `pop?`: boolean — Removes the last element from an array and returns it. If the array is empty, undefined is returned and the array is not modified.
        - `push?`: boolean — Appends new elements to the end of an array, and returns the new length of the array.
        - `concat?`: boolean — Combines two or more arrays. This method returns a new array without modifying any existing arrays.
        - `join?`: boolean — Adds all the elements of an array into a string, separated by the specified separator string.
        - `reverse?`: boolean — Reverses the elements in an array in place. This method mutates the array and returns a reference to the same array.
        - `shift?`: boolean — Removes the first element from an array and returns it. If the array is empty, undefined is returned and the array is not modified.
        - `slice?`: boolean — Returns a copy of a section of an array. For both start and end, a negative index can be used to indicate an offset from the end of the array. For example, -2 …
        - `sort?`: boolean — Sorts an array in place. This method mutates the array and returns a reference to the same array.
        - `splice?`: boolean — Removes elements from an array and, if necessary, inserts new elements in their place, returning the deleted elements.
        - `unshift?`: boolean — Inserts new elements at the start of an array, and returns the new length of the array.
        - `indexOf?`: boolean — Returns the index of the first occurrence of a value in an array, or -1 if it is not present.
        - `lastIndexOf?`: boolean — Returns the index of the last occurrence of a specified value in an array, or -1 if it is not present.
        - `every?`: boolean — Determines whether all the members of an array satisfy the specified test.
        - `some?`: boolean — Determines whether the specified callback function returns true for any element of an array.
        - `forEach?`: boolean — Performs the specified action for each element in an array.
        - `map?`: boolean — Calls a defined callback function on each element of an array, and returns an array that contains the results.
        - `filter?`: boolean — Returns the elements of an array that meet the condition specified in a callback function.
        - `reduce?`: boolean — Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as…
        - `reduceRight?`: boolean — Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated resul…
        - `find?`: boolean — Returns the value of the first element in the array where predicate is true, and undefined otherwise.
        - `findIndex?`: boolean — Returns the index of the first element in the array where predicate is true, and -1 otherwise.
        - `fill?`: boolean — Changes all array elements from `start` to `end` index to a static `value` and returns the modified array
        - `copyWithin?`: boolean — Returns the this object after copying a section of the array identified by start and end to the same array starting at position target
        - `entries?`: boolean — Returns an iterable of key, value pairs for every entry in the array
        - `keys?`: boolean — Returns an iterable of keys in the array
        - `values?`: boolean — Returns an iterable of values in the array
        - `includes?`: boolean — Determines whether an array includes a certain element, returning true or false as appropriate.
        - `flatMap?`: boolean — Calls a defined callback function on each element of an array. Then, flattens the result into a new array. This is identical to a map followed by flat with dep…
        - `flat?`: boolean — Returns a new array with all sub-array elements concatenated into it recursively up to the specified depth.
        - `at?`: boolean — Returns the item located at the specified index.
        - `findLast?`: boolean — Returns the value of the last element in the array where predicate is true, and undefined otherwise.
        - `findLastIndex?`: boolean — Returns the index of the last element in the array where predicate is true, and -1 otherwise.
        - `toReversed?`: boolean — Returns a copy of an array with its elements reversed.
        - `toSorted?`: boolean — Returns a copy of an array with its elements sorted.
        - `toSpliced?`: boolean — Copies an array and removes elements and, if necessary, inserts new elements in their place. Returns the copied array. Copies an array and removes elements whi…
        - `with?`: boolean — Copies an array, then overwrites the value at the provided index with the given value. If the index is negative, then it replaces from the end of the array.
        - `__@iterator@19612?`: boolean — Iterator
        - `__@unscopables@19828?`: boolean — Is an object whose properties have the value 'true' when they will be absent when used in a 'with' statement.
    - `source`: object — Required source fields supplied by the producer.
      - `kind`: string
      - `callId`: string ⌾ToolCallId
    - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
  - `error?`: object
    - `name`: string
    - `code`: string
  - `meta?`: json (any JSON value)

*来源: `packages/core/session/src/types.ts`*

#### 事件 `turn/end`

Closes turn `turn` with the {@link TurnEndReason} that ended it. A turn with no entered step has no `step/start` or `step/end`. The loop does not await a flush…

**data 字段:**

- **{ turn: number; reason: TurnEndReason; }**
  - `turn`: number
  - `reason`: object|object|object|object|object|object
    - 变体 `{ kind: "completed"; }`:
      - `kind`: string
    - 变体 `{ kind: "aborted"; reason: TurnEndCancelCause; }`:
      - `kind`: string
      - `reason`: object|object|object|object|object
        - 变体 `{ readonly kind: "user"; }`:
          - `kind`: string
        - 变体 `{ readonly kind: "parent"; }`:
          - `kind`: string
        - 变体 `{ readonly kind: "hook"; readonly reason: string; }`:
          - `kind`: string
          - `reason`: string
        - 变体 `{ readonly kind: "disposed"; }`:
          - `kind`: string
        - 变体 `{ readonly kind: "legacy"; }`:
          - `kind`: string
    - 变体 `{ kind: "blocked"; }`:
      - `kind`: string
    - 变体 `{ kind: "error"; error: LlmFailure; }`:
      - `kind`: string
      - `error`: object
        - `message`: string — Human-readable provider or transport failure.
        - `code`: string — Stable provider-neutral machine-routing code.
        - `status?`: number — HTTP status returned by the provider, when available.
        - `providerRetryAfterMs?`: number — Provider-requested delay in milliseconds, when valid and available.
        - `requestId?`: string — Opaque provider-issued request identifier for diagnostics.
    - 变体 `{ kind: "max-tokens"; }`:
      - `kind`: string
    - 变体 `{ kind: "interrupted"; }`:
      - `kind`: string

*来源: `packages/core/session/src/types.ts`*

#### 事件 `turn/start`

Opens turn `turn` before the loop claims queued input or runs pre-step. Rejection, empty input, cancellation, or failure may close it with no step; otherwise t…

**data 字段:**

- **{ turn: number; }**
  - `turn`: number

*来源: `packages/core/session/src/types.ts`*

#### 事件 `user/message`

A user-role message on the model-visible surface: a direct human prompt (the queued message claimed for this turn), a synthetic `agent.inject()` context (file-…

**data 字段:**

- **UserMessage**
  - `role`: string — Provider-neutral conversation role.
  - `id`: string ⌾MessageId — Stable identity preserved across every representation boundary.
  - `content`: object|object|object|object|object[] — Exact model-facing blocks.
  - `source`: object|object|object|object|object|object|object|object|object|object — Required source fields supplied by the producer.
    - 变体 `{ kind: "user"; }`:
      - `kind`: string
    - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form?: never; }`:
      - `kind`: string
      - `plugin`: string
      - `form?`: never
    - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "instructions"; }`:
      - `kind`: string
      - `plugin`: string
      - `form`: string
    - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "catalog"; }`:
      - `kind`: string
      - `plugin`: string
      - `form`: string
    - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "snapshot"; readonly sections: readonly ContextSnapshotSection[]; }`:
      - `kind`: string
      - `plugin`: string
      - `form`: string
      - `sections`: object[] — The named contributions this snapshot assembled, in order.
        - *(元素)*:
          - `name`: string — The contributing subsystem's name.
          - `text`: string — That contribution's model-facing text, exactly as assembled.
    - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "notice"; readonly summary: string; }`:
      - `kind`: string
      - `plugin`: string
      - `form`: string
      - `summary`: string — One-line account of what happened, shown without expanding the row.
    - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "relay"; }`:
      - `kind`: string
      - `plugin`: string
      - `form`: string
    - 变体 `{ kind: "plugin"; plugin: string; } & { readonly form: "recall"; }`:
      - `kind`: string
      - `plugin`: string
      - `form`: string
    - 变体 `ModelMessageSource`:
      - `kind`: string
      - `provider`: string — Provider route that produced the message.
      - `model`: string — Provider model id that produced the message.
      - `replayState?`: unknown — Lossless-JSON adapter state needed to replay the provider response. `LlmRuntime` exposes it to a target adapter only when that adapter instance currently owns …
    - 变体 `ToolMessageSource`:
      - `kind`: string
      - `callId`: string ⌾ToolCallId

*来源: `packages/core/session/src/types.ts`*

#### 事件 `web/deepseek-search-llm-request`

Secret-free auxiliary DeepSeek search request recorded before dispatch.

**data 字段:**

- **DeepSeekSearchLlmRequest**
  - `endpoint`: string — Fully resolved Messages endpoint.
  - `apiVersion`: string — `anthropic-version` header value.
  - `body`: object — Exact JSON body sent to the provider.
    - `model`: string
    - `max_tokens`: number
    - `messages`: object
      - `0`: object
        - `role`: string
        - `content`: object
          - `0`: object
            - `type`: string
            - `text`: string
          - `length`: number
          - `toString`: function — Returns a string representation of an array.
          - `toLocaleString`: function — Returns a string representation of an array. The elements are converted to string using their toLocaleString methods.
          - `concat`: function — Combines two or more arrays.
          - `join`: function — Adds all the elements of an array separated by the specified separator string.
          - `slice`: function — Returns a section of an array.
          - `indexOf`: function — Returns the index of the first occurrence of a value in an array.
          - `lastIndexOf`: function — Returns the index of the last occurrence of a specified value in an array.
          - `every`: function — Determines whether all the members of an array satisfy the specified test.
          - `some`: function — Determines whether the specified callback function returns true for any element of an array.
          - `forEach`: function — Performs the specified action for each element in an array.
          - `map`: function — Calls a defined callback function on each element of an array, and returns an array that contains the results.
          - `filter`: function — Returns the elements of an array that meet the condition specified in a callback function.
          - `reduce`: function — Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as…
          - `reduceRight`: function — Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated resul…
          - `find`: function — Returns the value of the first element in the array where predicate is true, and undefined otherwise.
          - `findIndex`: function — Returns the index of the first element in the array where predicate is true, and -1 otherwise.
          - `entries`: function — Returns an iterable of key, value pairs for every entry in the array
          - `keys`: function — Returns an iterable of keys in the array
          - `values`: function — Returns an iterable of values in the array
          - `includes`: function — Determines whether an array includes a certain element, returning true or false as appropriate.
          - `flatMap`: function — Calls a defined callback function on each element of an array. Then, flattens the result into a new array. This is identical to a map followed by flat with dep…
          - `flat`: function — Returns a new array with all sub-array elements concatenated into it recursively up to the specified depth.
          - `at`: function — Returns the item located at the specified index.
          - `findLast`: function — Returns the value of the last element in the array where predicate is true, and undefined otherwise.
          - `findLastIndex`: function — Returns the index of the last element in the array where predicate is true, and -1 otherwise.
          - `toReversed`: function — Copies the array and returns the copied array with all of its elements reversed.
          - `toSorted`: function — Copies and sorts the array.
          - `toSpliced`: function — Copies an array and removes elements while, if necessary, inserting new elements in their place, returning the remaining elements. Copies an array and removes …
          - `with`: function — Copies an array, then overwrites the value at the provided index with the given value. If the index is negative, then it replaces from the end of the array
          - `__@iterator@21317`: function — Iterator of values in the array.
          - `__@unscopables@21319`: object — Is an object whose properties have the value 'true' when they will be absent when used in a 'with' statement.
            - `length?`: boolean — Gets the length of the array. This is a number one higher than the highest element defined in an array.
            - `toString?`: boolean — Returns a string representation of an array.
            - `toLocaleString?`: boolean — Returns a string representation of an array. The elements are converted to string using their toLocaleString methods.
            - `concat?`: boolean — Combines two or more arrays.
            - `join?`: boolean — Adds all the elements of an array separated by the specified separator string.
            - `slice?`: boolean — Returns a section of an array.
            - `indexOf?`: boolean — Returns the index of the first occurrence of a value in an array.
            - `lastIndexOf?`: boolean — Returns the index of the last occurrence of a specified value in an array.
            - `every?`: boolean — Determines whether all the members of an array satisfy the specified test.
            - `some?`: boolean — Determines whether the specified callback function returns true for any element of an array.
            - `forEach?`: boolean — Performs the specified action for each element in an array.
            - `map?`: boolean — Calls a defined callback function on each element of an array, and returns an array that contains the results.
            - `filter?`: boolean — Returns the elements of an array that meet the condition specified in a callback function.
            - `reduce?`: boolean — Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as…
            - `reduceRight?`: boolean — Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated resul…
            - `find?`: boolean — Returns the value of the first element in the array where predicate is true, and undefined otherwise.
            - `findIndex?`: boolean — Returns the index of the first element in the array where predicate is true, and -1 otherwise.
            - `entries?`: boolean — Returns an iterable of key, value pairs for every entry in the array
            - `keys?`: boolean — Returns an iterable of keys in the array
            - `values?`: boolean — Returns an iterable of values in the array
            - `includes?`: boolean — Determines whether an array includes a certain element, returning true or false as appropriate.
            - `flatMap?`: boolean — Calls a defined callback function on each element of an array. Then, flattens the result into a new array. This is identical to a map followed by flat with dep…
            - `flat?`: boolean — Returns a new array with all sub-array elements concatenated into it recursively up to the specified depth.
            - `at?`: boolean — Returns the item located at the specified index.
            - `findLast?`: boolean — Returns the value of the last element in the array where predicate is true, and undefined otherwise.
            - `findLastIndex?`: boolean — Returns the index of the last element in the array where predicate is true, and -1 otherwise.
            - `toReversed?`: boolean — Copies the array and returns the copied array with all of its elements reversed.
            - `toSorted?`: boolean — Copies and sorts the array.
            - `toSpliced?`: boolean — Copies an array and removes elements while, if necessary, inserting new elements in their place, returning the remaining elements. Copies an array and removes …
            - `with?`: boolean — Copies an array, then overwrites the value at the provided index with the given value. If the index is negative, then it replaces from the end of the array
            - `__@iterator@21317?`: boolean — Iterator of values in the array.
            - `__@unscopables@21319?`: boolean — Is an object whose properties have the value 'true' when they will be absent when used in a 'with' statement.
      - `length`: number
      - `toString`: function — Returns a string representation of an array.
      - `toLocaleString`: function — Returns a string representation of an array. The elements are converted to string using their toLocaleString methods.
      - `concat`: function — Combines two or more arrays.
      - `join`: function — Adds all the elements of an array separated by the specified separator string.
      - `slice`: function — Returns a section of an array.
      - `indexOf`: function — Returns the index of the first occurrence of a value in an array.
      - `lastIndexOf`: function — Returns the index of the last occurrence of a specified value in an array.
      - `every`: function — Determines whether all the members of an array satisfy the specified test.
      - `some`: function — Determines whether the specified callback function returns true for any element of an array.
      - `forEach`: function — Performs the specified action for each element in an array.
      - `map`: function — Calls a defined callback function on each element of an array, and returns an array that contains the results.
      - `filter`: function — Returns the elements of an array that meet the condition specified in a callback function.
      - `reduce`: function — Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as…
      - `reduceRight`: function — Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated resul…
      - `find`: function — Returns the value of the first element in the array where predicate is true, and undefined otherwise.
      - `findIndex`: function — Returns the index of the first element in the array where predicate is true, and -1 otherwise.
      - `entries`: function — Returns an iterable of key, value pairs for every entry in the array
      - `keys`: function — Returns an iterable of keys in the array
      - `values`: function — Returns an iterable of values in the array
      - `includes`: function — Determines whether an array includes a certain element, returning true or false as appropriate.
      - `flatMap`: function — Calls a defined callback function on each element of an array. Then, flattens the result into a new array. This is identical to a map followed by flat with dep…
      - `flat`: function — Returns a new array with all sub-array elements concatenated into it recursively up to the specified depth.
      - `at`: function — Returns the item located at the specified index.
      - `findLast`: function — Returns the value of the last element in the array where predicate is true, and undefined otherwise.
      - `findLastIndex`: function — Returns the index of the last element in the array where predicate is true, and -1 otherwise.
      - `toReversed`: function — Copies the array and returns the copied array with all of its elements reversed.
      - `toSorted`: function — Copies and sorts the array.
      - `toSpliced`: function — Copies an array and removes elements while, if necessary, inserting new elements in their place, returning the remaining elements. Copies an array and removes …
      - `with`: function — Copies an array, then overwrites the value at the provided index with the given value. If the index is negative, then it replaces from the end of the array
      - `__@iterator@21317`: function — Iterator of values in the array.
      - `__@unscopables@21319`: object — Is an object whose properties have the value 'true' when they will be absent when used in a 'with' statement.
        - `length?`: boolean — Gets the length of the array. This is a number one higher than the highest element defined in an array.
        - `toString?`: boolean — Returns a string representation of an array.
        - `toLocaleString?`: boolean — Returns a string representation of an array. The elements are converted to string using their toLocaleString methods.
        - `concat?`: boolean — Combines two or more arrays.
        - `join?`: boolean — Adds all the elements of an array separated by the specified separator string.
        - `slice?`: boolean — Returns a section of an array.
        - `indexOf?`: boolean — Returns the index of the first occurrence of a value in an array.
        - `lastIndexOf?`: boolean — Returns the index of the last occurrence of a specified value in an array.
        - `every?`: boolean — Determines whether all the members of an array satisfy the specified test.
        - `some?`: boolean — Determines whether the specified callback function returns true for any element of an array.
        - `forEach?`: boolean — Performs the specified action for each element in an array.
        - `map?`: boolean — Calls a defined callback function on each element of an array, and returns an array that contains the results.
        - `filter?`: boolean — Returns the elements of an array that meet the condition specified in a callback function.
        - `reduce?`: boolean — Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as…
        - `reduceRight?`: boolean — Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated resul…
        - `find?`: boolean — Returns the value of the first element in the array where predicate is true, and undefined otherwise.
        - `findIndex?`: boolean — Returns the index of the first element in the array where predicate is true, and -1 otherwise.
        - `entries?`: boolean — Returns an iterable of key, value pairs for every entry in the array
        - `keys?`: boolean — Returns an iterable of keys in the array
        - `values?`: boolean — Returns an iterable of values in the array
        - `includes?`: boolean — Determines whether an array includes a certain element, returning true or false as appropriate.
        - `flatMap?`: boolean — Calls a defined callback function on each element of an array. Then, flattens the result into a new array. This is identical to a map followed by flat with dep…
        - `flat?`: boolean — Returns a new array with all sub-array elements concatenated into it recursively up to the specified depth.
        - `at?`: boolean — Returns the item located at the specified index.
        - `findLast?`: boolean — Returns the value of the last element in the array where predicate is true, and undefined otherwise.
        - `findLastIndex?`: boolean — Returns the index of the last element in the array where predicate is true, and -1 otherwise.
        - `toReversed?`: boolean — Copies the array and returns the copied array with all of its elements reversed.
        - `toSorted?`: boolean — Copies and sorts the array.
        - `toSpliced?`: boolean — Copies an array and removes elements while, if necessary, inserting new elements in their place, returning the remaining elements. Copies an array and removes …
        - `with?`: boolean — Copies an array, then overwrites the value at the provided index with the given value. If the index is negative, then it replaces from the end of the array
        - `__@iterator@21317?`: boolean — Iterator of values in the array.
        - `__@unscopables@21319?`: boolean — Is an object whose properties have the value 'true' when they will be absent when used in a 'with' statement.
    - `tools`: object
      - `0`: object
        - `type`: string
        - `name`: string
        - `max_uses`: number
      - `length`: number
      - `toString`: function — Returns a string representation of an array.
      - `toLocaleString`: function — Returns a string representation of an array. The elements are converted to string using their toLocaleString methods.
      - `concat`: function — Combines two or more arrays.
      - `join`: function — Adds all the elements of an array separated by the specified separator string.
      - `slice`: function — Returns a section of an array.
      - `indexOf`: function — Returns the index of the first occurrence of a value in an array.
      - `lastIndexOf`: function — Returns the index of the last occurrence of a specified value in an array.
      - `every`: function — Determines whether all the members of an array satisfy the specified test.
      - `some`: function — Determines whether the specified callback function returns true for any element of an array.
      - `forEach`: function — Performs the specified action for each element in an array.
      - `map`: function — Calls a defined callback function on each element of an array, and returns an array that contains the results.
      - `filter`: function — Returns the elements of an array that meet the condition specified in a callback function.
      - `reduce`: function — Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as…
      - `reduceRight`: function — Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated resul…
      - `find`: function — Returns the value of the first element in the array where predicate is true, and undefined otherwise.
      - `findIndex`: function — Returns the index of the first element in the array where predicate is true, and -1 otherwise.
      - `entries`: function — Returns an iterable of key, value pairs for every entry in the array
      - `keys`: function — Returns an iterable of keys in the array
      - `values`: function — Returns an iterable of values in the array
      - `includes`: function — Determines whether an array includes a certain element, returning true or false as appropriate.
      - `flatMap`: function — Calls a defined callback function on each element of an array. Then, flattens the result into a new array. This is identical to a map followed by flat with dep…
      - `flat`: function — Returns a new array with all sub-array elements concatenated into it recursively up to the specified depth.
      - `at`: function — Returns the item located at the specified index.
      - `findLast`: function — Returns the value of the last element in the array where predicate is true, and undefined otherwise.
      - `findLastIndex`: function — Returns the index of the last element in the array where predicate is true, and -1 otherwise.
      - `toReversed`: function — Copies the array and returns the copied array with all of its elements reversed.
      - `toSorted`: function — Copies and sorts the array.
      - `toSpliced`: function — Copies an array and removes elements while, if necessary, inserting new elements in their place, returning the remaining elements. Copies an array and removes …
      - `with`: function — Copies an array, then overwrites the value at the provided index with the given value. If the index is negative, then it replaces from the end of the array
      - `__@iterator@21317`: function — Iterator of values in the array.
      - `__@unscopables@21319`: object — Is an object whose properties have the value 'true' when they will be absent when used in a 'with' statement.
        - `length?`: boolean — Gets the length of the array. This is a number one higher than the highest element defined in an array.
        - `toString?`: boolean — Returns a string representation of an array.
        - `toLocaleString?`: boolean — Returns a string representation of an array. The elements are converted to string using their toLocaleString methods.
        - `concat?`: boolean — Combines two or more arrays.
        - `join?`: boolean — Adds all the elements of an array separated by the specified separator string.
        - `slice?`: boolean — Returns a section of an array.
        - `indexOf?`: boolean — Returns the index of the first occurrence of a value in an array.
        - `lastIndexOf?`: boolean — Returns the index of the last occurrence of a specified value in an array.
        - `every?`: boolean — Determines whether all the members of an array satisfy the specified test.
        - `some?`: boolean — Determines whether the specified callback function returns true for any element of an array.
        - `forEach?`: boolean — Performs the specified action for each element in an array.
        - `map?`: boolean — Calls a defined callback function on each element of an array, and returns an array that contains the results.
        - `filter?`: boolean — Returns the elements of an array that meet the condition specified in a callback function.
        - `reduce?`: boolean — Calls the specified callback function for all the elements in an array. The return value of the callback function is the accumulated result, and is provided as…
        - `reduceRight?`: boolean — Calls the specified callback function for all the elements in an array, in descending order. The return value of the callback function is the accumulated resul…
        - `find?`: boolean — Returns the value of the first element in the array where predicate is true, and undefined otherwise.
        - `findIndex?`: boolean — Returns the index of the first element in the array where predicate is true, and -1 otherwise.
        - `entries?`: boolean — Returns an iterable of key, value pairs for every entry in the array
        - `keys?`: boolean — Returns an iterable of keys in the array
        - `values?`: boolean — Returns an iterable of values in the array
        - `includes?`: boolean — Determines whether an array includes a certain element, returning true or false as appropriate.
        - `flatMap?`: boolean — Calls a defined callback function on each element of an array. Then, flattens the result into a new array. This is identical to a map followed by flat with dep…
        - `flat?`: boolean — Returns a new array with all sub-array elements concatenated into it recursively up to the specified depth.
        - `at?`: boolean — Returns the item located at the specified index.
        - `findLast?`: boolean — Returns the value of the last element in the array where predicate is true, and undefined otherwise.
        - `findLastIndex?`: boolean — Returns the index of the last element in the array where predicate is true, and -1 otherwise.
        - `toReversed?`: boolean — Copies the array and returns the copied array with all of its elements reversed.
        - `toSorted?`: boolean — Copies and sorts the array.
        - `toSpliced?`: boolean — Copies an array and removes elements while, if necessary, inserting new elements in their place, returning the remaining elements. Copies an array and removes …
        - `with?`: boolean — Copies an array, then overwrites the value at the provided index with the given value. If the index is negative, then it replaces from the end of the array
        - `__@iterator@21317?`: boolean — Iterator of values in the array.
        - `__@unscopables@21319?`: boolean — Is an object whose properties have the value 'true' when they will be absent when used in a 'with' statement.

*来源: `packages/web/web-search-deepseek/src/provider.ts`*


## 三、$events 转发事件 allowlist(18 项,`emit` 帧;waterfall = 可应答推送)

- `agent-preset/selected` (推送)
- `approval/request` (瀑布(可应答))
- `api-session/activity` (推送)
- `api-session/added` (推送)
- `api-session/error` (推送)
- `api-session/removed` (推送)
- `api-session/status` (推送)
- `commands/change` (推送)
- `credentials/reference-updated` (推送)
- `cordis/request-run` (推送)
- `cordis/request-run-resolved` (推送)
- `cordis/dynamic-package` (推送)
- `cordis/dynamic-retract` (推送)
- `cordis/inspect-query` (推送)
- `cordis/inspect-query-resolved` (推送)
- `llm/adapters-updated` (推送)
- `settings/document-updated` (推送)
- `user-questions/request` (瀑布(可应答))
