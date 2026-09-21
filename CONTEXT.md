# Super D

Super D（代码标识 superd）是多 Agent 运行时的统一入口：一个不拥有任何运行时的桥接层 App，把本机与远端机器上已存在的各类 Agent 运行时，以统一的会话/事件面呈现给 Web UI 与 messaging channel 两类消费者。

## Language

### 核心概念

**Super D**:
本 App 的品牌名与口头称呼。代码、CLI、包名一律写 `superd` 或 `superD`（无空格无连字符）。
_Avoid_: SuperDash, Super-D, Super D App

**桥接层（Bridge Layer）**:
Super D 的本体角色：统一入口 + 字段/事件翻译，不提供运行时、不持有对话数据。
_Avoid_: 网关（gateway 易与上游 gateway 组件混淆）、代理（proxy 只是实现手段）

**Agent Runtime**:
真正执行 agent 任务的软件（DSH、OMP、Pi、Claude Code、Codex、Hermes）。用户自带，Super D 不依赖、不全量安装、甚至不要求在场。
_Avoid_: engine, backend, provider（provider 另有含义，见下）

### 接入面

**RuntimeProvider**:
Super D 对全部 runtime 的唯一标准接口：一套字段与事件契约，UI 按在场字段渲染、缺失即降级隐藏。不区分转发/翻译两种实现形态。
_Avoid_: passthrough adapter, translate adapter（作为类型名已废弃）

**Adapter**:
RuntimeProvider 的一个具体实现，负责把某个上游 runtime 的能力映射到标准契约。每个 adapter 是独立注册的插件。
_Avoid_: connector, integration

**两半注册（Two-Half Registration）**:
能力协商方式：adapter 声明上游有什么数据字段，UI 侧注册可提供的 observable 字段；双方对齐的字段才呈现。
_Avoid_: capability flags, feature negotiation

### 机器与位置

**Machine**:
一台运行 superD 服务器的机器，分 Local（本机）与 Remote（远端，以机器命名如 DEV3）。remote 条目只指向远端的 superD，从不直连裸 runtime。
_Avoid_: host, node, server（server 指进程）

**本地发现（Local Discovery）**:
对本机已安装 runtime 的自动扫描（PATH 探测 + 已知端口握手 + 进程树解析）。Remote 永不自动扫描，只能手动登记。
_Avoid_: autodiscovery, network scan

### 会话

**superD Session ID**:
SuperD 对 UI/Consumer 暴露的会话标识，格式自定，与任何上游不兼容、不可直传。
_Avoid_: session handle

**Upstream Session ID**:
上游 runtime 自己的会话标识，由 adapter 知晓与寻址。
_Avoid_: native session

**Session Pairing**:
superD Session ID 与 `{machine, runtime, upstreamId}` 的配对关系，是 Super D 唯一持久化的会话性数据；原始对话内容永不落 superD。
_Avoid_: session mirror, session store

### 消费通道

**Consumer**:
会话的一条消费通道。Web UI 是第一条；Telegram 等 messaging channel 是与其同级的后续成员，不与任何 runtime 强绑定。
_Avoid_: frontend, client, channel（channel 指具体通道实例，见下）

**Messaging Channel**:
Consumer 的一种具体通道类型（Telegram、Slack、WhatsApp），以 binding 的形式接入。
_Avoid_: bot, integration

**Binding**:
用户的一次配置行为：把某个 messaging channel（含其凭据）接入平台，或把某个 channel 的沟通能力配给某个 runtime。
_Avoid_: pairing（那是会话层的词）, link

**会话 TTL**:
Consumer 侧的会话轮换策略：新消息距会话最后修改超过阈值即开新会话。属于消费通道的使用习惯，不是会话本体的属性；Web UI 永不自动轮换。
_Avoid_: session expiry, timeout

### 供给（预留）

**Provisioning**:
Super D 后续为用户安装/供给 runtime 的两条路径：辅助安装（从 registry 拉取）与实例隔离安装（独立版本，与用户现场实例完全隔离）。当前仅预留方法位，无实现。
_Avoid_: runtime management, installer
