# Teleport：远端环境虚拟化方案（agent runtime 的瞬移）

- **日期**: 2026-09-19
- **定位**: 新研究方向提案（research direction proposal；设计论证 + 协议面草案 + MVP 路线，非实现计划）。**主线 A = 环境虚拟化**（把远端环境桥接到本地）；**补充线 B = Harness Transport**（把 harness 本体 transport 到远端，WASM 载体候选），对照与收敛分析见 §八。二轮深化（§九，2026-09-19）确立**双轨**：**B+ Docker 载体 = 快速轨**（现成原语组合，MVP 先行），**A 沙箱环 = 研究主线**（产品深度最大）。三轮深化（§十）确立场景谱系（A 甜点 = 本机容器/内网；B+ 甜点 = WAN 长任务）与 bearer 传输适配层。八轮深化（§十一）补接入拓扑（Multica 式云端信任桥梁）与产品三原则（best effort / transparent / fail-close）。九轮（§十二）开启实测：包装深度阶梯 L0/L1 已验证；十轮裁决抽出 `remote` 工具线（§5.3 + 独立文档）。
- **路径**: `docs/superpowers/plans/2026-09-19-teleport-design.md`
- **核心命题**: **harness 永驻本地，环境随取随换**。Agent runtime（harness）的全部环境交互收敛在一个极小的原语面（bash/PTY、文件读写、搜索、env）；把远端机器的文件系统与进程空间按**这个原语面**（而非 POSIX/FUSE 层）桥接为本地虚拟资源，远端只需一个薄守卫进程（teleportd），**一整套 harness 在远端的复制部署被整体消灭**。对 runtime 而言 = 瞬移到了远端；对大模型而言 = 操作远端无摩擦，如本地。
- **血缘**: 对 `docs/00-blueprint.md` §Machine/Remote 模型（DEV3 部署 superD + 自有 runtime，bridge 委托）与 ADR 0002（remote 仅 superD↔superD）提出**并列第三条接入路径**（Local runtime × Remote environment），不推翻、并存竞争；与 agent-worlds 线（本机 foreign runtime 集成）正交。
- **代码落位（拟）**: `apps/teleport/`（新线，自包含）；远端守卫 `teleportd`，本地适配层 `EnvSurface`。

---

## 〇、一句话论证

> Agent runtime 之间真正共享的不是代码，而是**环境**。Super D / Augusta / Multica 的 multi-machine 方案都在搬运 runtime 本体；teleport 反过来——**runtime 一份不动，把环境做成可插拔资源**。

现状成本（blueprint §Machine 现模型的隐含账单）：

| 维度 | 现模型（每机一套 runtime + superD 桥） | teleport 模型（本地 runtime + 远端薄守卫） |
|---|---|---|
| 远端部署物 | 完整 harness（DSH checkout ≈1.8G 含 node_modules）+ superD + 依赖树 | `teleportd` 单二进制（目标 <20MB、常驻 <30MB、零 runtime 依赖） |
| 版本漂移 | N 台机器 = N 份 harness 版本，各自对齐上游 | 永远只有 PC 一份，漂移面 = 0 |
| 会话数据 | 落在远端（runtime 在哪数据在哪），跨机聚合靠 bridge 翻译 | 天然全在 PC 本地 |
| 新机器接入 | 装环境 → 装 runtime → 装 superD → 登记 | 拷一个二进制 + 一行 SSH 配置 |
| 并行 multi-machine | 每机各自开会话，状态割裂 | 一个 harness 挂 N 个虚拟环境，会话同源 |

---

## 一、核心洞察：harness = 环境原语的消费者

### 1.1 接口切面

以 DSH 为参照（结论对 Claude Code / OMP / Codex / Pi 同样成立），一个 harness 与「环境」的全部交互收敛在六个原语：

| 原语 | DSH 工具形态 | 语义要点 |
|---|---|---|
| shell 执行 | `bash`（PTY、后台作业、超时） | 命令字符串进、stdout/stderr/exit code 流出 |
| 文件读 | `read`（行号、offset/limit）、`read_image`（二进制） | 内容进上下文，**只有读结果进上下文，读本身无副作用** |
| 文件写 | `write`（全文替换） | 幂等、可整体重放 |
| 文件编辑 | `edit`（literal old→new、replace_all） | **天然是 compare-and-swap**：基于读到的内容做替换 |
| 文件发现 | `glob`、`grep`（ripgrep 语法） | 纯函数式查询 |
| 环境状态 | cwd、env、身份 | 会话作用域的可变状态 |

而 runtime 的另一半——LLM 推理、上下文组装、会话持久化、memory、skills、approval UX——**与环境零耦合**。于是得到本方案的根本切分：

```
Runtime State（不可移，永驻本地）          Environment State（可绑定到任意机器）
├─ LLM 连接与推理                          ├─ 文件系统（真相）
├─ 会话 log / 持久化                       ├─ 进程与 PTY
├─ memory / skills / 上下文                ├─ shell 环境（cwd / env / 身份）
├─ sandbox / approval 策略                 ├─ 网络出口位置（egress identity）
└─ harness 生命周期                        └─ 计算算力本身
```

**Teleport = Environment State 的热绑定（rebinding）**。harness 看到的只是「环境换了一套」，物理运行从未离开本地。

### 1.2 为什么虚拟化切面在 tool 层，而不是 FS 层

这是本方案最重要的技术裁决（**裁决 T-0**）：

1. **语义覆盖**：harness 从不做任意 syscall，它只发上表六种原语。在 tool 层桥接 = 100% 语义覆盖；在 FS 层（FUSE/NFS/9p）桥接要模拟 POSIX 全集——stat 风暴、mmap、fcntl、锁——且大部分模拟工作服务的是 agent 根本不会发起的调用。
2. **粒度匹配**：tool 调用粗粒度、有明确语义边界（edit 天然 CAS、grep 天然流式）、可批处理；FS 层细粒度、强顺序、语义密集，LAN 下尚可、WAN 下必死。
3. **安全/审批面同层**：harness 的 sandbox 与 approval 策略就定义在 tool 调用边界上（DSH file policy / approval policy）。虚拟化发生在同一层，策略**原样继承**，不需要跨层翻译。
4. **延迟容忍论证（teleport 可行性的物理基础）**：harness 的步进节拍由模型推理决定——每步秒级。工具 RTT 从 1ms（本地）涨到 200ms（WAN），在「每步数次 tool call」的真实分布下对总时长影响是个位数百分比。**人用 IDE 需要 <16ms 的 FS 延迟，agent 不需要**——agent 对环境延迟的容忍度比任何人类工具都高一个数量级，这正是 FS 层桥接几十年的延迟难题在 agent 场景下突然变得可解的原因。

### 1.3 实证缺口：裸 SSH 为什么不顺手——transport-native ≠ environment-native

机器上已有 dev3/dev4 登录密钥，agent 技术上可以 `ssh` 直达——但长期观察到的现象是：**远端执行心理摩擦大、不顺利**。原因不是 SSH 不能用，而是 **SSH 只原生承载六类环境原语中的一类（exec）**，其余五类全部降级为「bash 字符串编码练习」。

**摩擦解剖（机制级）**：

| # | 摩擦源 | 机制 | 后果 |
|---|---|---|---|
| 1 | 二阶 shell 转义 | 每条命令穿越本地+远端两个 parser，`$`/引号/glob 双重解释 | 失败率高，且**静默错误**（`ssh dev3 ls *.ts` 的 glob 在本地先展开） |
| 2 | 状态每步归零 | 每次 bash 调用 = 全新 SSH 会话，cwd/env 不延续 | 每步重打 `cd /path &&` 前缀 |
| 3 | 工具面坍缩 | read/edit/glob/grep/read_image 全不可用，一切退化为 cat/sed/scp | 行号/翻页/图片全丢；`sed -i` 转义地狱、heredoc 全文重写无 CAS、scp 往返有 stale-write 竞态 |
| 4 | 无流式无驻留 | 命令阻塞至超时；长任务靠 nohup/tmux 仪式 | build/serve 类任务不可用 |
| 5 | 截断无纪律 | 大输出整体灌进上下文或任意截断 | 上下文污染或关键信息丢失 |
| 6 | 政策盲区 | 沙箱/审批只见 `ssh ...` 一个字符串，看不见隧道另一端 | 远端动作无策略约束、无审计锚点、爆炸半径是一整台机器 |
| 7 | 双世界心智税 | 每步做「本地还是远端」路由决策 | 犹豫、错世界操作（改了本地陈旧副本以为是 DEV3） |
| 8 | 每会话重新发现 | 远端环境无内省 | 每次 rediscover 装了什么、路径在哪、服务怎么起 |

**逐项消解映射**：1→协议帧结构化 payload（单 shell 语义、零转义）；2→env 域会话作用域 + Manifest；3→全工具面透传（T-0 的本义）；4→proc 流式 + PTY 常驻（§4.3）；5→服务端 cap + 续读（DP-1）；6→审批/沙箱在 tool 层原样生效 + jail + 审计（T-0/§4.5）；7→单世界模型：绑定后只有一套路径（T-4），「我在哪个世界」问题被消解；8→hello 能力通告 + env.status（§4.9/§4.10）。

**一句话**：SSH 是 native **transport**，不是 native **tool surface**。模型的接口是结构化工具面而非 shell；teleport 的本质 = **把整个工具面（含语义、状态、政策、可观测性）搬过 transport，而不只是搬运 shell 字符串**。「心理摩擦」的成分由此可解释：对模型而言 SSH 是脱离铺装路的高方差动作——失败方式更多、验证更贵（每次确认都要再来一轮转义）、爆炸半径不可见——于是模型自我迟疑，这正是观察到的阻力。

---

## 二、模型与组件

### 2.1 拓扑（首发场景：PC ↔ DEV3）

```
PC（唯一 runtime 所在地）                          DEV3
┌────────────────────────────────┐          ┌──────────────────────────┐
│ DSH harness（本地，不改内核）      │   SSH    │  sshd（既有，零新增端口）    │
│  └─ EnvSurface（teleport 适配层） │◄═══mux═══►│  └─ teleportd            │
│      ├─ 虚 bash ──► proc RPC     │  单连接    │      ├─ fs 原语执行器      │
│      ├─ 虚 read/edit ──► fs RPC  │  多 channel│      ├─ proc 原语执行器    │
│      ├─ 虚 glob/grep ──► fs RPC  │          │      ├─ PTY 会话管理器      │
│      └─ shadow cache（可选层）    │          │      │   （daemon 侧存活）  │
│  └─ 会话 log / memory / 审批 UX  │          │      └─ jail（chroot/用户）│
└────────────────────────────────┘          └──────────────────────────┘
```

四个角色：

1. **teleportd（远端守卫）**：远端**唯一**部署物。单二进制，无语言 runtime 依赖。职责：执行环境原语、持有 PTY 与常驻服务（LSP/构建守护/watcher——detach 后进程不死，§4.8）、路径 jail、append-only 审计日志。定位是**基础设施 transformer**：把机器的物理环境 transform 成协议面。
2. **EnvSurface（本地虚拟环境）**：实现 harness 的环境工具接口，后端是 teleport 协议。对 harness 表现为一套普通工具——**透明替换，不是新增侧面工具**（agent 不知道自己在远端，这正是「无摩擦」的含义）。
3. **Teleport Manifest（瞬移清单）**：环境状态的序列化载体：`{cwd, envDiff, ptyHandles[], openEdits/journal, sourceMachine}`。瞬移 = `export(manifest)` → 换绑 EnvSurface → `apply(manifest)`。
4. **Conductor（编排面，可后置）**：目标机器发现、健康探测、manifest 迁移执行。在 Super D 语境下由 selector/pairing 表承载，v0 可以只是 CLI 参数。

### 2.2 传输与协议面

- **传输裁决（T-1）**：v0 = **SSH 之上的多路复用流**，不新增任何监听端口。连接建立 = `ssh dev3 exec teleportd --serve`（SFTP 同款模式：协议跑在 SSH channel 上），复用既有 host key / 凭证 / 安全边界，DEV3 侧零新增暴露面。后期 WAN 优化可选独立 daemon + QUIC（列为开放问题）。**三轮修订**：SSH 降格为 bearer 之一（TB-6，§10.2）——本机容器场景以 stdio bearer 首发于 T0。**九轮注记**：`remote` 工具（§5.3，明细见独立文档 dashr 仓 `docs/10_plans/dashr-remote-tool-design.md`）提供零部署变体——sshd / docker daemon 即 daemon，EnvSurface 语义实现于 runtime 侧。
- **帧格式**：`{id, domain, op, payload}`；msgpack + zstd；单连接内按 domain 多路复用（fs / proc / pty / ctrl），请求按 id 配对、**默认 pipeline**（不等应答即可发下一请求）。
- **协议先例**：SFTP（SSH subsystem 承载文件协议）证明这条路的生产成熟度；teleportd 相当于「SFTP 的 agent 原语超集」。

---

## 三、环境原语清单（v0 协议面）

| 域 | 原语 | 语义要点 |
|---|---|---|
| fs | `read(path, offset, limit) → {content, rev}` | 返回 **rev**（revision 标识），供 edit CAS 用 |
| fs | `write(path, content, baseRev?)` | 全文写；带 baseRev 即条件写 |
| fs | `edit(path, old, new, baseRev) → {ok, rev} \| {conflict, freshContent, rev}` | CAS 语义；冲突返回新内容与 rev，harness 重读即可，**工具对外语义不变** |
| fs | `stat / list / glob(pattern) / grep(rg语义, 流式)` | glob/grep **永远在远端执行**（真相在远端，见 T-2） |
| fs | `mkdir / rm / mv / chmod`；`readImage`（二进制分块） | |
| proc | `spawn(cmd, env, cwd, {pty}) → {pid, streamId}`；`signal`；`stdin`；exit/流 | stdout/stderr 原样字节流，不做行缓冲重组 |
| pty | `open(cols, rows) → {ptyId}`；`resize`；`detach` / `attach(scrollback窗口)`；`list` | PTY 由 teleportd 持有，断网进程不死（§4.3） |
| env | `getenv / setenv（会话作用域）/ cwd / whoami / uname` | |
| sock | `forward.open(target) → 本地虚拟端点`；`forward.close` | Unix socket / TCP 转发：X、D-Bus、CDP、pulseaudio 经此接入（§4.10） |
| ctrl | `hello（版本 / 压缩 / 能力通告协商）/ ping / manifest.apply / manifest.export / audit` | 能力通告块 = 环境能力面（§4.9） |

**Manifest 形态草案**：

```jsonc
{
  "version": 1,
  "source": "pc", "target": "dev3",
  "cwd": "/home/u1/workspaces/superd",
  "envDiff": { "NODE_ENV": "test" },
  "ptyHandles": ["pty-7f3a"],            // 仅当 target == source 时可重挂
  "residentServices": ["lsp-typescript", "dev-server:3000"],  // DP-2：瞬移时重挂而非重 spawn（§4.8）
  "journal": [ /* 未确认的写操作，幂等键重放 */ ],
  "identity": { "user": "u1" }
}
```

---

## 四、硬核技术细节与对策（方案重心）

### 4.1 延迟与往返放大

**测量模型**：agent 一步 ≈ 1–8 次 tool call，每次 1 RTT。LAN（同机 ≈0.3ms / 局域网 ≈1ms）无感；WAN（VPS ≈50–200ms）下一次交互 = 1–1.6s 纯 RTT，对照模型推理每步 2–20s，占比 5–20%——可感但不致命，且是优化空间最大的层。

分层对策（按优先序）：

1. **Pipeline + 批处理（协议层，必做）**：帧默认 pipeline；`batch([op...])` 原语把常见组合（glob→read×N、grep→read）压成 1 RTT。
2. **读路径 shadow cache（可选层，T3 里程碑）**：本地影子目录，copy-on-read；远端 fanotify/inotify 事件推送失效通知。**策略裁决（T-2）：glob/grep/一切写 = 永远远端执行**（真相在远端，正确性不依赖缓存新鲜度）；read = 缓存优先 + rev 校验兜底。缓存是纯加速层，**拔掉它系统仍然正确**——这是它敢叫「可选」的原因。
3. **明确反目标**：不做全量预同步（rsync/mutagen 路线）。理由：agent 实际触碰的文件是长尾分布的小集合，on-demand 足够；而 node_modules/build 产物级同步引入冲突调和的整类负担。冷路径（大产物）就留在远端，用 `read` 流式取。
4. **大文件初次读**：content-addressed 分块 + zstd，跨会话块缓存复用。

### 4.2 Edit 语义与一致性（read–edit 竞态）

harness 的 edit = 「基于上次 read 的内容做字面替换」。远端环境下，read 与 edit 之间文件可能被远端进程（另一个 agent、watcher、构建）改写。对策：

- 每个文件携带 **rev**（建议 = `size + mtime_ns + 前缀 hash` 复合，或 daemon 侧单调 etag）；
- `edit` 强制带 `baseRev`，CAS 失败返回 `{conflict, freshContent, rev}`——harness 的既有重读逻辑直接消化，**协议冲突不泄漏成工具语义变化**；
- daemon 侧落盘一律 temp-file + atomic rename，杜绝半写；
- shadow cache 失效：远端事件推送（推丢失效则 read 时的 rev 校验兜底——两级防护，事件通道是优化不是正确性依赖）。

### 4.3 PTY 保真与进程存活（瞬移语义的进程级支撑）

- PTY 流 = 原样字节（含 ANSI），`resize`/signal/job control 透传；不做终端模拟重组（那是 UI 层的事）。
- **detach/attach**：PTY 会话由 teleportd 持有（PTY 元数据落盘，daemon 崩溃可恢复）。网络断 → 进程不死；重连 → 回放 scrollback ring buffer 窗口。灵感源 tmux/mosh，但 **agent-facing、协议化**（attach 的消费者是 harness 的 bash 工具，不是人的终端）。
- **边界如实声明**：PTY **不可跨机器迁移**（那是 CRIU 级难题，列入远期非目标）。瞬移清单携带的 `ptyHandles` 仅在回迁原机时可重挂；跨机瞬移时 PTY 会话留在原机 detach 存活，manifest 里标记 `orphans`。v0 的「瞬移」语义 = **环境换绑 + 长任务在原机存活可回看**，不是进程迁移。

### 4.4 本地/远端二进制与平台分歧

- **铁律（T-3）：一切 bash/命令、glob/grep 在远端执行**。harness 本地不保留任何「快捷路径」——本地 ripgrep 处理远端路径是语义灾难（case sensitivity、路径分隔符、symlink 解析、权限模型全部错位）。
- **路径呈现裁决（T-4）：暴露远端真实绝对路径**。agent 上下文里 path 就是远端 path（`/home/u1/workspaces/...`），不做双重命名空间映射——映射表是认知负担 + bug 面双料来源；shadow cache 的本地镜像布局是实现细节，**永不进入 agent 视野**。
- 差异清单进入协议协商：行尾、locale、ulimit、用户身份（teleportd 以配置声明的身份执行，jail 限定根）。

### 4.5 安全模型（teleportd 本质是 RCE endpoint，按 RCE 级设防）

威胁模型一句话：**任何拿到 teleportd 通道的人 = 拿到远端机器的等价执行权**。

| 层 | 措施 |
|---|---|
| 传输 | SSH 承载（复用既有凭证与 host key 信任）；后期 mTLS/QUIC 需等价审计 |
| 授权 | jail root（限定 workspace 子树）+ 专用低权用户 + per-machine token |
| 命令过滤 | **v0 不做**。shell 元字符可绕过，属伪安全；如实记录为「不做」并靠 jail + 审计兜底 |
| 审批继承 | 危险操作走本地 harness 既有 approval UX——虚拟化在 tool 层（T-0）使 DSH sandbox/approval 策略**原样生效**；远端 jail 是第二道防线（defense in depth） |
| 审计 | 每个原语调用 append-only log（who/when/op/path/cmd），远端可取证 |

- **密钥红线（开放问题 O-4）**：远端 `.env` / SSH key 可能被 agent 合法地 read（这是 agent 工作的一部分），通道即成密钥回流路径。v0：审计记录 + 不拦截；中期可选：read 拦截规则（路径模式 → 脱敏/拒绝/需审批升级）。
- **零新增端口**是安全叙事的核心卖点：DEV3 不开任何新监听，攻击面增量 = 「一个经 SSH 认证的 exec 入口」。

### 4.6 失败语义

- 网络分区：写路径 journal + 每变更幂等键（idempotency key），重连重放去重；read 缓存降级可用但**必须标注 stale**（诚实降级）。
- 半写：CAS + atomic rename（§4.2）。
- daemon 崩溃：systemd unit 拉起 + PTY 元数据落盘恢复；协议层请求超时即显式失败，**永不本地猜测远端结果**（fail loud，环境真相只有一个）。

### 4.7 大文件与结果面纪律（四轮缺口分析，user 2026-09-19）

**缺口的真实边界**：网络成本 = RTT × 次数（§4.1 已处理）+ 字节 ÷ 带宽。字节问题在 A 里被 tool 层切面**结构性缩小**——工具通道是**结果通道，不是数据通道**（裁决 DP-1）：返回体积由「模型需要看什么」决定，与文件尺寸无关。

| 原语类 | 执行位置 | 传输内容 | 典型体积 |
|---|---|---|---|
| exec 型（bash） | 远端**替它执行**（T-3） | 有界输出流（harness 截断） | ~10–30KB |
| query 型（glob/grep） | 远端（T-2） | 命中列表（条数封顶） | ~KB–百KB |
| accessor 型（read/edit/write/stat） | 远端 | **range**（offset/limit 行窗）+ rev | ~10–100KB |
| media 型（read_image） | 远端 | 服务端预缩减后的图像 | ~100KB–1MB |

每步合计 ≈ 数十至数百 KB：WAN 20Mbps 下 ≈ 40–160ms 传输/步，落在 §4.1 的 5–20% 预算内。**GB 级的 log/数据集本身永不过网**——`read` 是行窗 seek 读、grep 在数据旁边跑，字节留在 DEV3。这正是「远端替它执行、执行完只把结果返回」——它已经是 A 的承重设计（T-2/T-3），本轮升格为显式纪律并补齐残余缺口（DP 纪律族）：

1. **服务端结果上限 + 续读令牌**：每个原语声明结果 cap（bytes/lines），超限服务端截断并返回 continuation（offset/令牌）；禁止任何原语隐式整文件传输。harness 的 limit 参数与输出截断与之原生吻合，server 侧再兜一层。
2. **服务端媒体缩减**：`read_image` 现状 = 全图过网后才在 harness 侧缩。teleportd 服务端解析图像头、按模型视觉需求预缩放/重压缩再传——把缩减搬到数据旁边，media 传输量降一个数量级。
3. **shadow cache 大文件豁免**：>N MB 文件 bypass 缓存（read-through + range 请求），缓存永不成为批量搬运通道（补入 T3 里程碑验收）。
4. **data-plane 旁路通道**：确需批量字节（罕见）走 rsync 独立通道，不占用工具通道（§9.1 mount 旁路原则的推广）。
5. **反模式明文**：禁止把大数据「读进上下文」——大 CSV/日志以路径引用 + 远端 bash 聚合（head/python 摘要），只回传摘要。与「结果通道」是同一纪律的两面。

**两条对照线的暴露面**：mount 变体（A-2.0）是字节问题真正咬人的地方——FS 层不知道语义、无法在源头缩减，只能 chunked 搬运（再证 T-0）；B+ 的 workspace 含大数据集时首瞬移 = GB 级传输（缓解见 §9.2 补条）。

### 4.8 常驻服务与全库消费者：LSP 案例（五轮缺口分析，user 2026-09-19）

**缺口**：LSP 天然要读全库建索引——agent 的工具调用是单文件粒度，LSP 的索引胃口是全库粒度。挂了 LSP 的 harness，其工具面背后藏着一个「全库消费者」，repo 级数据面在工具语义里不可见。

**裁决 DP-2（常驻服务就地 / resident-services locality）**：一切需要全库/大数据集的 stateful 服务——LSP、构建守护（gradle/turborepo cache）、test watcher、dev server、DB 连接——**属于环境，不属于 runtime**。它们随环境驻留远端（数据旁），永不过网迁移；通道只过语义结果。这不是新机制，是 T-3 的自然延伸：**LSP server 就是一个 spawn 在远端的长驻进程**。

**放置问题为何自动消解**：

1. LSP server 经 teleportd proc 原语 spawn 在 DEV3——全库索引 = 本地磁盘读，零网络；
2. **写入同步免费**：harness 的一切写都过环境（T-3 write-through），DEV3 磁盘即当前态，LSP 的 file watcher 直接看到 harness 的编辑——不存在 editor dirty buffer / didChange 回放问题（agent 场景没有「未保存缓冲」，远端磁盘是唯一真相）。个别 server 的 disk-watch 支持不齐，v0 隧道模式可由 client 侧补发 didChange 兜底；
3. 工具结果天然有界：go-to-definition = 1 个位置，references = 封顶列表 + 续读，diagnostics = per-file——DP-1 对 LSP 同样适用。

**落地形态（v0 → v1）**：

- **v0 = stdio 隧道**：teleportd spawn LSP server（proc 原语），harness 侧 LSP client 经通道隧道其 stdio——LSP 协议原样跑在一条「变长的管道」上，**LSP 不知道自己在远端**（与 teleportd 自身的 stdio bearer 同构）。DSH 系 harness 已有 LSP facility 形态（lsp manager/device），只需重指 endpoint。断线韧性复用 PTY 语义：隧道断、server 不死、重连重挂。
- **v1 = 语义吸收**：LSP 升格为 teleport 协议域 `lsp.*`（`definition/references/hover/diagnostics`），折叠 JSON-RPC 与通知开销，服务端语义缩减（结果 cap，DP-1）。
- **索引温启动**：索引就是远端磁盘上的文件（`.cache` 等）——跨会话持久，冷启动每环境只发生一次；Manifest 新增 `residentServices` 字段，瞬移时**重挂而非重 spawn**（§2.1 组件职责相应泛化）。
- **供给策略（七轮细化，user 提议的镜像机制）**：**route-at-bind + lazy-provision + sticky**——工具在绑定环境时即指向环境侧实例；常驻服务在首次调用时惰性供给（监测到真实需求才 spawn，未用服务零预付费），供给后粘住。**不做 mid-flight 双脑切换**：先让本地 server 答几问再切远端，本地/远端两份索引会给出不一致答案——比任何单一状态都糟。（A 线里本地 LSP 本就无 repo 可索引——数据在 DEV3——所以「监测本地调用再切换」修正为「绑定即路由、按需惰性供给」。）

**对照暴露面**：B+ 的 LSP 索引落在容器可写层——每次 commit/传输都变厚（缓解 = DEV3 侧 named volume 存索引或 image 预种）；A 的索引一次建成、永久驻留。**全库消费者场景是 A 相对 B+ 的又一个结构优势点**。

**泛化识别法则**：「工具背后藏着全库/大数据集消费者的，把消费者归类为环境资产」。清单：语言服务器、构建缓存守护、测试 watcher、dev server、数据库连接/种子、包管理器缓存——全部遵循 DP-2：就地驻留、结果过网。

### 4.9 能力阶梯与环境能力面（六轮：user 提议的禁用策略）

**提议采纳并升格为机制**：重消耗工具在远端**禁用 + 提示**是合法策略——但它是能力阶梯的最低档，不是终点。

**能力阶梯（每工具独立落档）**：

| 档 | 形态 | 成本 | 适用 |
|---|---|---|---|
| 0 禁用 + 提示 | 会话不装载该工具 / 调用返回结构化 unsupported | 零（首日即有） | 未实现的远置工具 + 根本不可远置的工具 |
| 1 stdio 隧道 | teleportd spawn 常驻 + stdio 隧道（DP-2 v0 形态） | 小（复用 T2 常驻机制） | LSP 等进程型服务 |
| 2 语义吸收 | `lsp.*` 协议域（DP-2 v1 形态） | 中 | 高频 / 高噪声协议 |

**环境能力面（capability surface）**：`hello` 握手（§三 ctrl 域）扩展能力通告块 `{tools, residentServices, mediaReduction, rttClass}`；harness 据此在**会话组装时**决定装载哪些工具（能力在绑定环境时已知，不存在会话中途突变）。降级对两类消费者分别呈现：**模型侧** = 工具缺席或结构化 unsupported 错误（模型自适应回退 grep/文本导航）；**用户侧** = UI 提示（「LSP 在 DEV3 不可用」）。这正是 Super D 既有「两半注册」哲学（CONTEXT.md）在环境维度的重放：**环境声明能力、harness 决定装载、对齐才呈现**。

**两类「不可用」必须区分（关键）**：

- **暂不可远置**——如 LSP：DP-2 明确它**可以**远端解析（远端恰是其最佳位置），只是尚未实现。禁用是临时档，阶梯爬升可消除；且值得爬——coding agent 在远端开发场景失去语义导航会退化成 grep 导航，质量损失恰好落在工作发生的地方。好消息是档 1 成本很小：T2 的常驻机制（PTY spawn/detach/attach）建好后，LSP stdio 隧道是顺路得到的。
- **根本不可远置**——触本地桌面/设备的工具：截图、剪贴板、GUI 自动化、本地音频。档 0 对它们是**永久正确形态**，不是过渡。**七轮修订**：Linux 上桌面栈本身 client-server，此类多数可深度远置（DP-3 改判，见 §4.10）；档 0 永久档缩小为物理本地硬件残余（PC 麦克风/摄像头/硬件安全键）。

识别法则 = §4.8 清单 + 本地设备依赖检查；产出物即每个环境的 capability 块。

### 4.10 深度原生化与劣势延迟化：GUI/browser 改判（七轮，user 推动）

**posture 裁决 DP-3（best-effort 深度 + 信息透明）**：方案 A 的成熟形态 = **把环境边界的残余劣势统一转化为网络延迟与即时错误反馈**，不在静态门控处提前截断；配合**信息透明化**（system prompt 的 environment 状态块 + `env.status` 查询工具：远端身份、延迟等级、能力面、常驻服务清单），让 agent 在运行时自行探测、适应、放弃。静态禁用缩到极小残余集：安全/审批面（policy 不随能力变化）+ 物理本地硬件 + 成本熔断。透明化与 best-effort 是互补而非矛盾：**摩擦的消失 ≠ 位置的无知**——像工程师知道自己在 SSH 里照样自然干活；透明化的价值 = 把能力图谱作为先验放进上下文，**降低 best-effort 的试错成本**（发现从主路径退为兜底）。

**GUI 改判**：round-6 把「截图/剪贴板/GUI 自动化」列为根本不可远置——**在 Linux 上是误判，予以撤回**。Linux 桌面栈本身是 client-server 架构，GUI 是最古老的网络协议之一：

| 能力 | 远端机制 | 成熟度 |
|---|---|---|
| 显示 | Xvfb/Xvnc 远端虚拟显示；X11 网络透明（`ssh -X` 原生）；waypipe（Wayland） | 数十年 |
| 浏览器自动化 | 远端 Chrome（headless 或跑在 Xvfb）+ CDP over WebSocket 隧道——browser-use/Playwright 天然网络化 | 生产级 |
| 截图 | 远端 display 截取 → DP-1 媒体预缩回传 | 简单 |
| 剪贴板 / 输入注入 | 远端 X 剪贴板 / X 事件注入（xdotool 类） | 简单 |
| 通用服务端点 | Unix socket / TCP 转发（`ssh -L/-R`、socat 同款语义） | 标准件 |

**协议落点：`sock` 域**（§三已补）：`forward.open(target) → 本地虚拟端点`——X、D-Bus、CDP、pulseaudio 全部经它接入。这是 TB-6 bearer 思想在环境侧的对称物：**bearer 搬运协议流，sock 域搬运环境内服务端点**。browser/CDP 隧道成本极低（纯端口转发，复用 proc/stdio 机制），可随 T2 早落；Xvfb 全栈排 T5 后（T6 候补）。

**语义澄清（本裁决最优美的部分）**：「屏幕属于环境」。agent 的显示器是**环境的 display**，不是操作者的 PC 屏——runtime/environment 切分让 GUI 工具的语义在远端反而**更正确**：browser-use 操作的「那台电脑」就是环境机。操作者观看远端画面 = 独立消费通道（noVNC / RustDesk / WebRTC 流进 Web UI——监督通道可整段复用开源远端桌面栈，TB-11），归 Super D 数据面，与 harness 无关。

**边界与代价（如实）**：① X11 交互延迟对人不可用、对 agent 自动化可用（截图—决策—注入节奏以秒计）；② 远端需装显示栈（Xvfb 轻量，headless Chrome 免显示）；③ 带宽 = 按需截图帧而非实时流，DP-1 覆盖；④ 优先**服务级远置**（CDP、per-display Xvfb）而非整桌面转发——暴露面更窄、带宽更省、故障域更小。

**档 0 残余集（最终）**：PC 物理硬件（麦克风/摄像头/硬件安全键）+ 安全审批面 + 成本熔断。其余一切工具：DP-3 统一处理——best-effort 远置，透明告知，错误即时反馈，agent 运行时自主取舍。

---

## 五、与 Super D 现有架构的关系

### 5.1 第三条接入路径

| 路径 | 形态 | 适合场景 |
|---|---|---|
| Local adapter | 本机 foreign runtime 集成（agent-worlds 线） | 多 runtime 同机 |
| Remote superD 委托（blueprint §Machine / ADR 0002） | 远端装 superD + 自有 runtime，bridge 翻译 | 远端有独立多会话负载、远端自有 runtime 生态（如 DEV3 上的 Hermes/A2A） |
| **Teleport（本线）** | 本地 runtime × 远端环境 | PC 主导开发流、远端只是环境/算力；要求零版本漂移、会话数据本地 |

- **对 ADR 0002 的关系**：不违反其字面（teleport 不直连任何裸 runtime——远端只有 teleportd，是**环境守卫**不是 runtime）；但引入了新的远端形态类目「Environment Provider」，建议后续以新 ADR（0010 候补）承认该类目，并与 0002 并列。
- **对 P5（DEV3 remote + 半构建验收）的影响**：不推翻。P5 验证委托路线，teleport 作为并列线验证，用同一台 DEV3 对照两种路线的真实体验——这本身就是本研究的核心实验。
- **UI 侧（远期）**：teleport 会话在 roster 的呈现 = Runtime 徽标（local-DSH）+ **Environment 徽标（DEV3）**，位置维度首次成为一等字段。开放问题 O-6。

### 5.2 DSH 对接点（MVP 可行性）

EnvSurface 落地形态 = **superd 自有 cordis 插件**（仓纪律：上游零修改，改动走 patch/自有插件层），以 profile（`teleport` profile）为装载单位，把环境工具实现替换/包装为远程后端。需 dsh-dev 验证的关键点：内建工具（bash/read/edit/…）能否被插件**按会话替换**（已知 DSH 支持动态 tools；「替换内建」与「新增工具」是两个能力，前者待证）。若不可替换，退化方案 = 同语义工具族（`rbash/rread/redit`…）+ prompt 注入引导，体验打折但仍成立。

### 5.3 `remote` 工具（Dash）：EnvSurface 的零部署载体（九轮，已抽出独立文档）

**归档**：本节内容已抽出为独立文档 dashr 仓 `docs/10_plans/dashr-remote-tool-design.md`——user 裁决：**`remote` 是一个工具**（同 harness 内的统一远端操作面），**teleport 是环境转移**，两者分层；SSH 只是 `remote` 的一个 backend。独立文档含：三案归二（SSH 含 LXD 的 sshd / Docker 走 Engine API）、统一寻址 `remote://<backend>/<target>/<path>`、工具面（执行工具 + 文件工具接受 URI）、连接物流（连接池 / 常驻 PTY 会话 / 重连 / 状态快照）、backend 契约、摩擦对账、安全审计、RM0–RM3 里程碑。

**裁决 DP-4（连接物流与语义分离）**：模型永远不管理连接（`web_fetch` 模式的推广）——keepalive / 多路复用 / 退避重试归 runtime。该裁决留在本文档（它是 teleport 的设计原则，明细见独立文档）。

**与本文档的关系**：`remote` = EnvSurface 原语契约的**零部署实现**（sshd / docker daemon 即远端 daemon，契约同源）；teleport 在其上加环境语义（Manifest、常驻服务、能力面、jail/审计）。EnvSurface 可骑在 `remote` 连接设施上；`remote` 单独用 = 轻量线（今天可用，代价是 jail/审计/断线驻留弱化）。

---

## 六、应用场景矩阵

| # | 场景 | 说明 | 时序 |
|---|---|---|---|
| S-1 | PC↔DEV3 开发流 | 首发场景：PC harness 直接在 DEV3 workspace 做 TDD 循环 | v0 |
| S-2 | Browser-hosted harness | harness 跑在浏览器（前端 runtime），env = 云端 VM（WebSocket→teleportd）。runtime host 与环境彻底解耦——**环境即插件** | 远期 |
| S-3 | 短命环境 | container/VM 即插即用：env 生命周期 = 资源，用完即焚；envbuilder 供给我 teleportd | 中期 |
| S-4 | 多机并行 agent | **一个 harness，N 个 EnvSurface 并挂**，并行子 agent 各自瞬移不同机器——multi-agent 的环境维度水平扩展，会话同源 | 中期 |
| S-5 | 反向瞬移 | 云端 runtime + 本地环境（对称成立，少见） | 远期 |

S-2/S-4 是这套架构真正的想象空间：**环境的可插拔性**先于「省磁盘」成为产品叙事。

---

## 七、相关工作（诚实对比）

| 工作 | 关系 | teleport 的差异点 |
|---|---|---|
| SSHFS / NFS / 9p | FS 层远端文件 | 切面不同（T-0）：无 tool 语义（CAS edit/PTY/批处理），stat 风暴延迟；我们不需要 POSIX 全集 |
| VS Code Remote | 同为「远端薄 server」直觉 | 它是 UI 前后端拆分（后端=完整 VS Code server 驻远端）；teleportd 是薄原语面，且消费者是 harness 不是人 |
| rsync / mutagen / unison | 同步型方案 | 我们**不同步**：真相永远在远端，冲突调和整类消失 |
| tmux / mosh | 会话存活原语 | teleportd PTY 管理的灵感源；agent-facing、协议化 |
| Codespaces / Gitpod | 逆方案：runtime 在云端 | teleport：runtime 在本地、环境在云端 |
| devcontainer / envbuilder | 环境供给面 | 互补：他们供给环境，teleport 绑定环境 |
| MCP | tool 资源桥接标准 | MCP 是 additive（新增侧面工具）；teleport 是 substitute（透明替换内建环境工具）。「agent 不知道自己在远端」是产品差异 |
| Plan 9 | 哲学先例（resources as files） | teleport = environment-as-protocol，原语面按 agent 语义裁剪 |

---

## 八、Alternative 路线：Harness Transport（把 harness 瞬移过去，WASM 载体候选）

**命题（user 2026-09-19 补充）**：与主线 A 反向——不是把远端环境桥接到本地，而是把 PC 上的 Agent Harness 整体 transport 到 DEV3 上运行：harness 直接与 DEV3 的文件系统/环境交互，同时与 PC 上的副本保持一致。自认难点：内存中运行的进程如何瞬移到另一台机器的内存运行时；候选中间技术 = **WASM**（统一接口抹平台分歧，内存镜像可序列化）。

### 8.1 两条严格程度完全不同的 B 路线

**B-full（通用进程迁移，CRIU 级）**：对运行中进程做内存到内存的透明迁移（FD、socket、PTY、线程、V8 堆全量）。评估：内核/架构/glibc 版本差异、半开 TCP 状态、PTY fd 不可迁移（与 §4.3 同源）、Node/V8 堆是海量 opaque 指针结构——CRIU 对这类进程的还原率与工程成本都极差。**裁决 TB-0：B-full 判定为非目标**。理由：对 harness 这个负载 ROI 为负——迁移省下的 per-tool RTT（§1.2 论证过 agent 对它容忍度最高）远小于工程成本。

**B-logic（逻辑态迁移，屏障点 handoff）**：harness 是步进机器（LLM call → tool burst → LLM call → …），**步边界天然是静止点（quiescent point）**。静止点处没有 in-flight 环境操作，「迁移」退化为纯数据问题：

```
迁移态 = session log（jsonl）+ config/preset + memory + skills + 环境锚（cwd/env）
动作   = PC 暂停于步边界 → 序列化 → DEV3 起新 harness 进程 → 以 log 为前缀 resume
```

这正是 agent-worlds 融合线已裁决的 resume 语义（AW-C1：DSH SessionEvent log = source of truth，resume = 以历史为前缀重灌；per-adapter 采纳中）——**B-logic 的状态面本仓已有语义正本，不缺发明**。真正需要「内存到内存」的只剩 in-flight tool call，约定在屏障处归零即可。

### 8.2 WASM 的真实收益与真实边界

**收益（都是真的）**：
1. **制品一致性**：WASM 模块 content-addressed——两端 hash 相同即「副本一致」，直接兑现「与 PC 副本保持一致」，版本漂移被内容寻址消灭；
2. **平台抹平**：x86_64/arm、glibc/kernel 免疫，DEV3 无需装 Node 依赖树；
3. **内存镜像可序列化**：WASM 线性内存是连续、自描述的字节空间，wizer（Bytecode Alliance）已示范 pre-init snapshot——它是所有候选载体里最接近「内存到内存迁移」可行形态的。

**边界（同样是真的）**：
1. **Node/V8 in WASM 不成立**：现有 harness 全是 JS/TS on Node，塞进 WASI 是研究项目级工程，等价于 wasm-first 重写 harness（成本爆炸）；
2. **WASI 恰好最弱在环境交互面**：PTY（termios/isatty）、进程 spawn、完整 network 语义都是 WASI 短板——**而 harness 唯一必须触到真机器的部分就是环境交互面**，沙箱内装不下 bash/PTY；
3. 推论：WASM 适合承载 harness 的「计算核」（上下文组装、LLM 编排、状态机），不适合承载「环境交互面」——后者仍需原生组件。

### 8.3 收敛结构（本节核心裁决 TB-1）：B 路线收敛于 A 路线的基础设施

把 B-logic 在 DEV3 上跑起来，逐项清点远端需要什么：

| DEV3 上需要 | 本质 | A 路线对应物 |
|---|---|---|
| 原生 PTY/exec 网关（WASI 给不了） | 环境原语守卫 | **teleportd 全家**（jail / 审计 / PTY 管理，§4.3/§4.5） |
| 状态传输通道与格式 | manifest | **Teleport Manifest**（session log = 最大的一个字段） |
| 审批/沙箱面 | RCE 级设防 | 同一套策略（§4.5） |

**两路线共用 teleportd 与 Manifest，分歧只在「谁带脑子」**：A = 脑子常驻本地、环境虚拟过去；B = 脑子搬过去、环境原生的。因此 B 没有独立地基——**先 A 后 B 是唯一经济路径**（T0–T5 资产对 B 全额复用）。

### 8.4 A vs B 对比（诚实版）

| 维度 | A 环境虚拟化（主线） | B-logic Harness Transport |
|---|---|---|
| per-tool RTT 税 | 有（pipeline/批处理缓解；§1.2 论证可容忍） | 零（工具原生速度） |
| build/test 重负载 | 远端 proc 原生跑，只有流回传有 RTT | 原生全速——**B 的最强论据**（但注意 A 的重负载本来就是一条 proc RPC，RTT 只在协调面不在计算面） |
| 会话/记忆数据位置 | PC 本地（隐私姿态最优） | 落到 DEV3——倒退回 blueprint 现模型的旧问题，除非回传复制 |
| LLM 密钥/egress | 留在 PC | 要么上 DEV3（密钥面扩大），要么隧道回 PC（工程回补） |
| 断网韧性 | PC 断网即停（fail loud，数据无损） | 若密钥/egress 在 DEV3：PC 离场仍可跑到下个屏障——上一行成本的另一面收益 |
| 远端部署物 | teleportd 单二进制 | teleportd **+** 可移植 harness 制品 + WASM 运行时（部署瘦身但没归零） |
| 双副本一致性 | 不存在（只有一份脑子） | 版本漂移复活，靠 content-addressed 纪律压制 |
| 工程成本 | 协议 + cordis 插件（仓栈内） | A 的全部 **+** wasm-first 计算核（重写级） |

**判决**：B 的独占增益空间被压缩到「远端高频工具交互的 RTT 累计」与「PC 离场韧性」——前者恰是 §1.2 论证过容忍度最高的部分，后者与密钥面扩大是同一枚硬币。B 真正值得记住的场景 = **egress 在远端**（需要 DEV3 网络身份的操作）与**重负载长跑**；两者 A 都有廉价部分解（远端 bash / proc RPC）。

### 8.5 B 线处置（裁决 TB-2）

- **B-full = 非目标**（TB-0）；
- **B-logic = 文档化 alternative + 廉价实验位 B0**：复用 A 的 Manifest（加 `sessionLog` 字段）+ DSH 既有 resume 语义，做成「会话跨机 resume」实验，排在 T5 对照实测之后——只有当 T5 数据证明 RTT 税构成真实痛点时才升格（O-8 门控）；
- **WASM 计算核 = 远期研究备忘**：S-2（browser-hosted harness）场景若成活，WASM 载体自然回归——browser 里本来就没有原生 Node，WASM 在那里是必选项而非选项。
- **二轮修订（2026-09-19）**：TB-2 的「B-logic 排在 T5 之后」被 **TB-4 修订**——Docker 载体（§9.2）让 B 轨以**瞬态克隆**形态提前为快速轨；B0 实验位保留给「无容器的裸 log-resume」对照形态。

### 8.6 相关工作补充（B 线）

CRIU（Linux 通用进程迁移，B-full 的天花板参照——对简单 C 进程成熟，对 V8/Node 最差）；Erlang/BEAM distribution（语言 VM 内建进程迁移的活化石，其 handoff 同样只在屏障点同步进行——B-logic 的哲学祖先）；wizer / wasmtime（WASM 内存快照先例）；Cloudflare Durable Objects（「状态随计算走」的平台化形态）。

## 九、二轮深化（2026-09-19）：沙箱环（A-2.0）与 Docker 载体（B+）

二轮补充两个深化：A 侧从 per-tool 包装升级为「整个 harness 连同环境包进 sandbox」；B 侧提出以 Docker 为传送门载体。本节给出架构采纳、延迟量化与**可行性记分**（直接回答「哪条更容易实现」）。

### 9.1 沙箱环（A-2.0）：sandbox 从策略栅栏升级为环境提供者边界

**对「穿帮」批评的修正与采纳**：

- **修正（部分不成立）**：A-1.0 里模型没有非 tool 通道触环境——bash 里的 base64 编码操作仍整体落在远端 shell 执行，`hostname`、`/proc/cpuinfo` 也如实返回远端值，经由 tool 的「逃逸」不成立。
- **真实的三条缝**：① harness 自身内部 FS（session store/memory——by design 是 runtime state，应留本地）；② 网络 egress 身份（v0 从 PC 出口，O-10）；③ **未来新增工具忘了包**——幻觉维护是 per-tool 永久税，这是批评成立的部分，也是最危险的一条。
- **采纳（裁决 TB-3）**：「系统性 bubble 比 per-tool 包装稳」的直觉在架构上成立。sandbox 从「策略栅栏」（workspace-write/approval）升级为**环境提供者边界（Environment Provider Boundary）**：环内有 FS / exec / net / env 四类 provider，各有可换绑后端（本地缺省，瞬移时换绑远端）。tool 实现只是 provider 的消费者之一，harness 内部访问也过同一环。**A-1.0 的 tool 层 RPC 由此降格为环内 FS/exec provider 的一种后端实现——是后端选择，不是架构分歧**。

| Provider | 本地后端 | 瞬移后端 | 评估 |
|---|---|---|---|
| FS | 本地磁盘 | **tool-RPC（T-2 原案）** / 远端 mount（NFS/9p/sshfs/SMB） | mount 只作重数据面旁路（rsync 通道），**不作主路径**（见下） |
| exec | 本地 spawn | 远端 proc RPC | bash 永远远端执行（T-3 铁律不变） |
| net | 本地 egress | 远端 egress（socks 回远端） | v0 留本地（O-10） |
| env | 本地 | Manifest 注入 | cwd/env/身份 |

**mount 变体的延迟放大（user 的 latency 担忧成立且致命的变体）**：mount 把一次 tool call 展开成 stat/open/read/close 多次 RTT；一次 node_modules 解析 = 数千次 stat；WAN 下 build 类负载不可用，LAN 下也劣于 RPC 批处理。**结论：FS provider 缺省 = tool-RPC；mount/同步通道只服务大产物搬运**。延迟「很要命」的判断对 mount 变体成立、对 RPC 变体是可管理的税（§1.2：每步 5–20% 开销）。

**cgroup/namespace 能给什么**：隔离与视图（yes）；**位置重定向（no）**——进程要么本地执行打远端数据（放大），要么远端执行（即 RPC 模型）。完全体 bubble = syscall 级拦截（gVisor 形态），工程量 google 级，与 B-full 同列非目标。

### 9.2 Docker 载体（B+）：借 OCI 标准接口做传送门

**命题**：PC 上 harness 装在 Docker 里，我们的服务在 OS 层操纵 Docker；触发瞬移 = 停容器 → 传 image（rsync 增量）→ 远端唤醒 → 结果同步回 → 删除远端克隆。**裁决 TB-4：B+ 采纳为 teleport 计划的快速轨（fast track）**——全部部件是现成原语的组合（docker commit/pull/run + rsync + ssh + jsonl log），零自研协议，MVP 周级。

**精化架构（一条关键拆分）**：

- **image = 环境，数据 = payload**。image 只装 harness + 工具链（少变，**一次 pre-seed 到 DEV3**，此后镜像传输≈0）；workspace + session log = 数据 payload，走 rsync 增量（MB 级常态）。**不要把 workspace/依赖烘进 image 层**——否则每次瞬移搬运 GB 级层，这是该方案最大的坑。
- **瞬移动作序列**：quiescent barrier（用户消息边界；退化用 SIGSTOP）→ flush session log → rsync workspace 增量 + log → DEV3 `docker run`（同 image hash）注入 log → resume → 回程反向 sync 结果 + 回收 log → `docker rm` 焚毁克隆。
- **「瞬态克隆 ≠ 常驻安装」——B 的多副本反对由此化解**。老路 = 每机常驻副本、独立版本漂移、会话状态分裂；B+ = **单一 source of truth**（PC 构建 image，content-addressed，hash 相同即同一 harness）、按需瞬态克隆、用后即焚、状态回家。版本漂移被内容寻址消灭；资源重复只存在于克隆存活期。

**B+ 的独占优势**：

- 零 per-tool RTT 税（harness 在数据旁执行）；重负载 build/test 原生全速。
- **PC 离场韧性**：容器在 DEV3 daemon 上独立存活（docker exec attach = PTY 等价物），fire-and-forget 模式天然成立；反而优于 A 在 WAN 断链下的表现。
- 环境异构抹平（OCI 语义）；**架构边界如实记**：同 arch（或 qemu/multi-arch）前提成立——PC 与 DEV3 同为 x86_64 Linux，现实部署无此问题，arm/macOS 目标才触发。
- Web UI 消费链路直接复用 superD 既有 remote-delegate 数据面（P5 形态）；**交互延迟与执行延迟解耦**（user 洞察，采纳）。

**B+ 的真实成本与边界**：

- 首次瞬移传输 = workspace + 依赖增量（冷启动 GB 级，常态 MB–百 MB）；**延迟账**：B+ 一次性 chunky 税 vs A 永久 RTT 税——长任务 B+ 赢，短交互 A 赢。
- DEV3 需装 docker daemon（一次性；比整套 harness 通用得多的依赖，可降级 containerd/podman）。
- LLM 密钥不烘 image，run 时经 SSH 注入 env。
- `docker checkpoint`（CRIU）存在但跨机恢复不成熟（同内核/路径假设），印证 barrier+log 路线而非内存迁移。
- 容器停 = 进程停：无 A 的 PTY detach 跨机故事；但容器自身可脱离 PC 存活，韧性账打平。
- workspace 含大数据集时首瞬移 = GB 级传输；缓解：Manifest **hot-path 声明**（只同步工作子集）+ 大数据集一次 pre-stage 常驻远端（§4.7 DP 纪律）。

### 9.3 可行性记分与推荐路线（回答「哪条更容易实现」）

| 路线 | 工程量 | 最大的未知数 | 延迟特征 | 多副本问题 | 判定 |
|---|---|---|---|---|---|
| A-1.0 tool-RPC | 中（自研协议 + 插件） | dsh 内建工具可否被插件替换（数日可证，§5.2） | 每 tool RTT；LAN 无感、WAN 5–20% | 无 | 研究主线（产品深度最大：单 harness × N 环境） |
| A-2.0 沙箱环完全体 | 高 | syscall 级拦截（gVisor 级） | mount 变体放大致命 | 无 | 环为目标架构（TB-3）；完全体非目标 |
| B 裸 log-resume | 低 | 无（AW-C1 语义现成） | 零 | **有**（被 user 正确否决） | 仅作为 B+ / B0 的状态面 |
| **B+ Docker 载体** | **低–中**（现成原语组合） | 传输量控制 / payload–image 拆分纪律 | 一次性 chunky 税 | 无（瞬态克隆） | **快速轨 MVP（TB-4）** |

架构异构注记：A 免疫——各侧原生执行各自代码，A 根本不做执行迁移（§10.3）；B+ 受 OCI 架构约束（同 arch 原生，异 arch 退化为模拟）。

**推荐：双轨并行，共享资产**——B+ 先行（2–3 周拿端到端瞬移体验 + T5 对照数据），A-1.0 并行研究（T1 为 go/no-go 门）。两轨共享 barrier 语义、Manifest（`sessionLog` 字段）、审计、jail；沙箱环（TB-3）是 A 的目标架构、也是两轨未来合流点（B+ 的容器本身就是一种环实现）。A-2.0 完全体与 B-full 同列远期备忘。

**B+ 里程碑（快速轨）**：

| 里程碑 | 内容 | 验收 |
|---|---|---|
| BP0 镜像化 | harness in Docker，PC 容器内跑通一条真实会话 | 容器内完成一次 TDD 循环；image 不含密钥、不含 workspace |
| BP1 瞬移回环 | barrier + rsync 增量 + DEV3 run + resume + 结果回收 + 克隆销毁 | 同一会话 PC→DEV3→PC 往返；两端 `docker images` hash 一致；DEV3 无残留 |
| BP2 数据面接入 | superD 消费远端容器会话（P5 形态）+ fire-and-forget 模式 | PC 离场后远端任务继续跑完、结果回家；Web UI 可见全过程 |

## 十、三轮深化（2026-09-19）：场景谱系、架构异构与传输适配层

### 10.1 场景谱系：延迟轴上的甜点区（user 洞察采纳）

瞬移的价值不均匀分布在延迟轴上——**内网与本机容器不是次要场景，是 A 线的甜点区**：

| 环境 | 典型 RTT | A 每 tool 开销 | A 每步开销（batch 后 ≈2 RTT） | 推荐载体 |
|---|---|---|---|---|
| 同机 Docker/LXD 容器 | <0.5ms | ≈0 | ≈0 | **A（stdio bearer）** |
| 内网/局域网 | 0.3–1ms | ≈0 | ≈0 | **A（SSH bearer）** |
| HK PC ↔ 菲/马 VPS（DEV3 类） | 40–80ms | 40–80ms | ≈100–160ms ≈ 单步 5–15% | 长任务→B+；短交互 A 可忍 |
| 跨洲弱网 | 150ms+ | 显著 | 显著 | B+（fire-and-forget） |

**裁决 TB-5（场景 × 载体映射）**：A 甜点区 = 本机容器/内网——延迟趋零时瞬移退化为**环境热切换**（零传输、即时换绑），且容器边界本身就是 jail（teleportd 的 jail 层在同机容器场景免装，安全模型最简）。B+ 甜点区 = WAN + 长任务 + PC 离场。同机容器的额外价值：试验性工具链、隔离脏环境、给并行 agent 挂 N 个环境——S-3 由远期升格为首发场景。

**开发顺序因此反转**：T0/T1 靶机 = 本机 Docker/LXD 容器（无 DEV3 依赖、无 WAN 噪声、秒级迭代），DEV3 作为 T1.5 的真实 WAN 靶标（里程碑表已改）。

### 10.2 传输适配层：bearer 抽象与守护进程分权（回答「协议层怎么兼容」）

**裁决 TB-6：协议契约 = 帧层语义；传输 = 可插拔 bearer**。上层语义零传输细节泄漏，bearer 是哑管道 + 能力声明：

```
原语语义层   fs / proc / pty / env / ctrl        —— 协议正本，永不含传输细节（不变量）
会话层       mux 帧 {id,domain,op,payload} + pipeline + batch + zstd
bearer 层    stdio │ SSH exec │ WebSocket │ QUIC/TCP —— 按场景插拔
安全层       随 bearer 继承：容器边界 │ SSH 凭证 │ 反代 TLS+token │ mTLS
```

**bearer 矩阵**：

| bearer | 场景 | 安全来源 | 备注 |
|---|---|---|---|
| **stdio** | 本机容器/同机 | 容器边界即 jail，零网络零认证 | teleportd 作为子进程 spawn，stdin/stdout 载协议；开发/测试快路径 |
| **SSH exec** | 内网/WAN（T-1 原案） | 既有 SSH 凭证，零新增端口 | 默认远端 bearer |
| **WebSocket** | browser harness（S-2） | 反代 TLS + token | **S-2 强制项**：浏览器发不了 SSH/裸 TCP，bearer 抽象因此不是镀金而是必需 |
| QUIC/裸 TCP | WAN 优化期 | mTLS | 0-RTT 重连、原生多流，弱网最优；后置（O-11） |

**明确不选 gRPC/WS 作为协议本身**：它们会从 bearer 变成协议，欠下 HTTP/2 的复杂度；自研 mux 帧极薄（msgpack + zstd），无需拥有权让渡。WS 仅在 browser 场景作 bearer 使用。

**bearer 能力声明**：`{rttClass, streams, mtu, ordering}`——会话层据此自适应（batch 大小、压缩开关、readahead：本机 stdio 全关，WAN 全开）。

**守护进程分权（回答「由谁统一管理」）**：网络细节由**两个半守护进程**分治——远端 **teleportd** 拥有 bearer 接受 + jail + 审计；本地 **link manager**（居 EnvSurface 内）拥有 bearer 选择、健康探测、重连与自适应。v0 从简：bearer 按环境配置静态指定，动态换绑后置（O-11）。

### 10.3 架构异构：user 判断的确认与细化

**确认**：Docker/OCI 不抹平 CPU 架构——容器是宿主内核上的**宿主架构原生执行**。x86 image 在 ARM 宿主 = qemu-user/binfmt 模拟（5–20x 慢，dev 工作负载不可用）；multi-arch image 解决的是**分发**不是**执行**（target arch 仍需对应构建）；macOS Docker Desktop 的 Rosetta 模拟好于 qemu 但仍非原生。

**对本仓栈的细化**：harness 主体是 JS（Node 有 arm64 build，天然可移植）；架构问题集中在**原生层**——DSH 的 `native/system` addon（linux-x64 glibc 二进制）与项目工具链（编译器、原生依赖）。即 image 的 JS 层跨架构共享、原生层必须 per-arch 构建。

**A 线对此完全免疫**：各侧原生执行各自代码，A 不做任何执行迁移——grep 在远端原生跑、bash 在远端原生跑，两侧架构不同毫无影响。这是 A 相对 B+ 的又一条结构性优势（已补记入 §9.3 注记）。

## 十一、接入拓扑与产品形态（八轮，Multica 式云端选项）

**产品三原则（本轮定版）**：**best effort、transparent、fail-close**——尽量包装、诚实告知、接不到就关。Harness 框架整体不动，只把它互动的环境逐项接过来。

### 11.1 零配置接入：单机免登录，跨机靠信任桥梁

- **单机模式**：本地环境（stdio bearer），零登录、零云依赖（T0 既有形态）。
- **跨机模式 = Rendezvous Service（云端选项，Multica 模式）**：
  - 注册表**只存** `{account, machineId, publicKey, reachability hints}`——永不碰 payload；
  - 两台机器各自**出站拨号**连云（HTTPS/WS——穿透几乎一切 NAT）；同一账户登录即配对合并；**首台新增机器需既有机器确认**（配对码），可随时撤销；
  - 配对后建通道：优先直连（对端公网可达或 UDP 打洞成功），回落**云中继**；中继模式全程 **E2E 加密**（云端只见密文）——「中转站不是数据偷窥者」靠设计保证而非承诺；
  - **self-host**：rendezvous 是组件不是锁，可自建在任意 VPS（O-12）。
- 先例：Tailscale（DERP 中继 + 打洞）、VS Code Remote Tunnels（`code tunnel` + 账户配对——与 Multica 模式同构）、Syncthing relay、ngrok。

### 11.2 双轴模型：深度 × 质量（回答「SSH 覆盖面是不是最广」）

**深度和覆盖是两个轴，不要混在协议名上**：

- **深度 = 端点能力**：能否跑 teleportd。能跑 → 全量原语面（fs/proc/pty/env/sock），与 bearer 无关；
- **质量 = bearer**：延迟/带宽/穿透性（stdio / SSH / QUIC / WS / 云中继，实测竞速择优）。
- **Tier 2 浅适配**：装不了 daemon 的机器（锁定环境、仅有 HTTP API）→ 按端点暴露面降级（fs 子集 / exec 子集），capability 块如实通告。

**SSH 覆盖面如实评估**：服务器（VPS）覆盖极高（DEV3 = 是）；桌面 Linux 默认常缺；Windows OpenSSH server 默认关闭；容器里不该有 sshd；且入站 SSH 解决不了 NAT。**真正普适的基线 = 出站 HTTPS/WS**（一切能上网的机器都通）。SSH 的正确定位：**服务器的质量 bearer + 引导 bearer**（可经 SSH 装上 daemon 再切最优通道），而非覆盖 bearer。覆盖面的正确表述：「能跑 daemon + 能出站联网」≈ 全部目标机器。

**协商机制 = 实测竞速而非偏好表**：link manager 并行探测候选（直连 SSH/QUIC、中继 WS），择优保持、持续探活、可热切换（O-11 落地点）。SSH 还有一个独特用法：**bootstrap 通道**——先用它装 daemon，装完即竞速换轨。

### 11.3 fail-close 语义：错误即修复提示

- 不可接通的能力 → 结构化 `E_UNSUPPORTED {capability, reason, hint}`，如 `{browser.cdp, chrome-not-installed, "apt install chromium && chromium --remote-debugging-port=9222"}`；
- **自愈回路**：agent 手里有环境 shell——「缺条件」多数可**自行修复**（装 Chrome、起 Xvfb、补权限），错误消息一律按「可自愈提示」撰写；修不了再放弃，两条路都比死报错强；
- fail-close 红线：**接不到就关，永不本地兜底**（反 split-brain：期待远端资源时静默回落本地 = 语义灾难）；
- 探测工具 `env.status`（能力/延迟等级/常驻服务/连接质量）供模型主动查询。

### 11.4 与 Super D 的耦合

- Rendezvous 配对 = Super D 既有 **Machine / Session Pairing** 概念的自动化形态：「Remote 手动登记」获得「同账户配对」选项——仍属用户明示同意，非自动扫描（不违反本地发现纪律）；
- 触及 ADR 0002 边缘：云中继通道上跑的是 teleport 协议（环境面），非 runtime RPC——建议并入 §5.1 的 ADR 候补一并裁决。

### 11.5 安装形态

- 远端 = teleportd 单二进制 + curl 安装脚本 + systemd unit；**安装时跑一次激进探测**（出站连通性、SSH 可用性、显示栈、容器运行时、CDP 浏览器）→ 产出该机 capability 块，上报 rendezvous 注册表；
- PC 侧 = EnvSurface 插件 + link manager；单机用户全程无感知云的存在。

## 十二、九轮实测（实验侧）：包装深度阶梯与 browser-use 解剖

问题（user）：工具层桥接未必够深——要不要让整个 harness 停下来重新发起、把进程包装好？一个进程到底要包装到什么程度（environment / PTY / proc / filesystem / sock）才能像在远端执行？先找机器实测。**本轮姊妹线**：同一轮讨论中 user 裁决抽出 `remote` 工具线（§5.3，Round 10 落档）——remote 是工具、teleport 是环境转移，两线分层不竞争。

### 12.1 browser-use 解剖（先看清被包装对象）

三层结构：**编排层**（LLM 工具逻辑：任务规划、DOM 决策）→ **驱动层**（Playwright：CDP 客户端）→ **浏览器**（Chromium：真正的物理世界——profile/downloads 的 FS、display、egress）。**裁决：Chromium 的位置决定「哪台电脑」**；驱动层位置只决定编排延迟；编排层留本地 CPU 无碍（它不触环境 touchpoint，只消费结果）。A 线的标准形态 = L1：编排+驱动本地、Chromium 远端。

### 12.2 包装深度阶梯（L 阶梯）

| 级 | 形态 | 包装物 | 状态 |
|---|---|---|---|
| L0 | 命令直传（CLI passthrough） | 无（一切远端） | **已实测 ✓** dev3 截图回流 + dev4 fail-close 样本 |
| L1 | 本地客户端 + 远端服务（CDP/sock 隧道） | 无（touchpoint 天然分离） | **已实测 ✓** ~100ms/op；egress 身份验证（PC `123.203.x` / dev3 `187.127.x`） |
| L2 | L1 + 一致性审计 | 同 L1 | 待做（split-brain 边界图） |
| L3 | 全进程包装（bwrap + sshfs + DISPLAY/net 重定向） | 整个工具进程 | 待做（「包到多深」的直接测量） |
| L4 | B+ Docker 载体对照 | — | 待做（传输账） |

场地侦察：dev2/dev3（x86_64，Chrome+Xvfb 齐备，~50ms 级）；dev4（**aarch64、无浏览器**，~500ms+ 级）= fail-close + 架构异构双样本。数据与协议见 [`2026-09-19-teleport-depth-experiments.md`](2026-09-19-teleport-depth-experiments.md)。

### 12.3 三个问题的裁决

- **要不要停机重启 harness？不要（裁决 TB-7）**。A 线的深度不来自重启 harness，而来自**工具执行基底的包装**——被包装的是 tools 的 children（bash/Chromium/LSP server），harness 本体永不需要停。全进程包装（L3）也不需要「停下来」：它是**以包装态启动**（wrapped launch），不是运行中迁移。停机-重启语义属于 B 线（quiescent barrier，§8.1），两线不要混用。
- **mirror 问题（user 洞察采纳，裁决 TB-8）**：远端可达度确实与本地通道建设相关，但对等的判据是**资源类别镜像**——进程的五类 touchpoint（FS / exec / net / display / sock）全部解析到环境实例即为对等；机制一一映射（本地也建 sock）是充分条件而非必要条件（L1 实测：一条 ssh -L 隧道即达成 sock 类对等的最小实现）。resume agent session 的权限对等 = Manifest 携带环境的 capability/身份上下文（与 residentServices 同级字段）。
- **实测先行（裁决 TB-9）**：L0/L1 零自研协议即通——**teleportd 的价值在原语面统一/jail/审计/常驻管理，不在连通性本身**。T0 落地前的连通性风险已被实测排除；`remote` 工具线（§5.3）正是这一事实的产品化：sshd/docker daemon 即零部署 daemon。下一步 L2/L3/L4 按实验协议推进。

### 12.4 五要素模型与重绑定点（十一轮，user 定调）

**模型（裁决 TB-10，采纳 user 表述）**：进程五要素 = CPU、内存（物理，永留本地）+ 文件系统、display、network（OS 提供的界面，逐个桥接）。GPU/USB/外设的尾巴**不做全桥接**——全桥接的极限 = 干脆远端装一模一样的 harness（= B+），有限集 + best effort 的经济学由此定价，fail-close 尾巴的正当性来自这里。

**对模型的三处精化**：

1. **第四要素是 proc/exec（模型的缺席者）**：harness 的环境交互大头不在自身而在 children（bash/Chromium/LSP server）——child 在哪 exec、带什么绑定 exec，与三要素同等重要；
2. **display 是组合服务不是原语**：X11/Wayland 本身跑在 socket + shm 之上——桥接 display 归约为「桥接一条 socket + 共享缓冲」（X11 天生网络透明）。这是 display「难在终端形态（帧流）、易在协议形态（sock 域）」的根本原因；
3. **harness 自身的 OS 接口用量极小且天然本地**：FS 用量 = config/session store（runtime state，按定义本地）；network 用量 = LLM API（按设计本地）；display = 无。**重绑需求全部住在 children 里**——「harness 不停」的严格版论证：不是不需要重绑，是它的重绑面天然为零（不受控的第三方 harness 除外，见下表第三行）。

**重绑定点轴（本模型最大产出：消解 A-1.0 vs A-2.0 之争）**：

| 定点 | 机制 | FS provider | net provider | 适用 |
|---|---|---|---|---|
| tool 边界 | 工具实现指向远端（A-1.0） | 原语 RPC（T-2） | 留本地 / socks | 自有 harness（DSH 插件） |
| child exec | children 于远端 spawn（L0/L1） | 远端原生 | 远端原生 | bash / 浏览器 / LSP |
| namespace 诞生 | wrapped launch（bwrap + sshfs，= L3） | **sshfs mount** | netns / proxy | 第三方 harness、不受控进程树 |

同一模型的三种取值，不是三条路线。**mount vs RPC 的「路线之争」随之消解**——它们是不同定点上的 provider 选择：namespace 定点用 sshfs 天经地义（进程要的就是 POSIX 面），tool 定点用 RPC 语义最优（§1.2）。运行中进程的绑定是**诞生时属性**：重绑 FS/display/net 的唯一干净方式 = 以新绑定重新 exec——对 harness 代价低（session 可 resume），此即 TB-7「以包装态启动」的严格含义。

**RustDesk 判决（裁决 TB-11）**：

- RustDesk 把 display 桥到了**终端形态**（连续帧流 + 输入注入 + relay/rendezvous），方向正确，但作为 harness 桥**消费者错位**：帧流是给眼睛的；harness 通道要的是给模型的**语义面**（episodic 截图 ~100KB + CDP/X11 协议级访问 + 输入注入）——按帧付 vision token 是最贵的消费方式；
- 且它不提供另两要素的桥接：file transfer 是「人的文件管理器」不是 FS **mount**（进程不能 `open()` 远端路径）；无 SOCKS/代理面；无可编程 API；
- **正确用法 = 借形不借位**：① 架构形态（client / server / relay——§11.1 Rendezvous 已采）；② **监督通道复用**：人看远端 GUI = noVNC / RustDesk / WebRTC 流进 Web UI（归 Super D 数据面）；③ 输入注入与视频编解码组件可复用。
- 一句话：**RustDesk 是给人看的 teleport；harness 需要给模型用的 teleport**——语义面优先，像素面兜底（真需要连续视觉的 agent 按自身节奏消费 screenshot 原语，即 DP-1）。

### 12.5 术语审查与子进程 FS 虚拟化机制阶梯（十二轮，user 提问）

**五要素模型的术语审查（user 框架成立，配 canonical 名）**：

| user 表述 | canonical 术语 | 精化 |
|---|---|---|
| CPU + 内存 = physical | von Neumann 物理基底；进程的**虚拟地址空间**是其本地视图 | 不可重指——试图重指它们的研究（分布式共享内存/进程迁移）= B-full，已判非目标 |
| 文件系统 = OS 给的 | **VFS**（虚拟文件系统）抽象，syscall 界面（open/stat/...） | 内核原语 ✓；重指点 = **mount / namespaces** |
| network = OS 给的 | **BSD sockets** API（socket/connect/...） | 内核原语 ✓；重指点 = socket 层 proxy / netns + slirp |
| display = OS 给的 | **display server / compositor**——**非内核原语**，是用户态 server（X server / Wayland compositor）架在内核原语（drm/framebuffer + unix socket + shm）上 | 精化：它是「OS 栈设施」而非内核抽象——**好消息**：天生协议化，归约为 sock 域（§4.10） |
| （缺席者） | **proc/exec**：clone/fork/exec + fd 表 + 信号 | children 是环境交互大头（TB-10 第四要素） |

- 整个进程所见 = 其 **execution environment**（执行环境）：虚拟地址空间 + 内核上下文（namespaces / mount 表 / fd 表 / 凭证）。teleport 的学理名字 = **indirection / location transparency**：logical 三要素只经 OS 界面被访问，**界面可重指**；Plan 9 的 per-process namespace（「每个进程有自己的资源视图」）是 Linux namespaces 的学理祖先，也是本方案的哲学锚点。
- **为什么 physical/logical 分裂恰好使 teleport 可能**：重指发生在界面处，物理基底不迁移。「不可能把远端 Linux 搬到本地跑」是正确的不可能——我们搬运的不是 OS，是**进程对 OS 界面的视图**。

**优先级（user 定，采纳）**：FS > network > display；display 放弃不阻塞（headless 即多数）。原则 = best effort, be transparent（§11 三原则既有）。

**子进程 FS 虚拟化：可行性 = 能，机制阶梯如下**。

原理根基 = **spawn-time binding（诞生时绑定）**：parent 经 exec 界面交付 child 的**整个初始上下文**——argv、envp、cwd、fds（0/1/2 与任意传递 fd）、mount/网络 namespace、凭证、rlimits。所以「给子进程桥接 FS」严格地 = 「在 exec 界面上交付一份被重指的 FS 视图」。机制按（权限 × 保真 × 性能）分五级：

| 级 | 机制 | 权限 | 保真/坑 |
|---|---|---|---|
| T0 | 路径约定：cwd 设为镜像目录 + 相对路径纪律 | 零 | 绝对路径即穿帮；脆 |
| T1 | **LD_PRELOAD** 路径重定向（open/stat/readlink... 查映射表） | 零 | 动态链接才有效；**Go/静态二进制直发 syscall 穿透**；children 继承（传播好） |
| T1' | **proot**（ptrace 外部拦截全部 syscall） | 零 | 静态二进制也覆盖；**每 syscall 双陷阱，2–10x+ 慢**；信号复杂 |
| **T2** | **unshare(user+mount ns) + FUSE mount + pivot_root 最小根**（user namespaces 使其零权限；bwrap 即 unshare+pivot_root 的包装器） | 零（userns） | **主路径**。**自有 FUSE 后端 = teleportd fs 域**——原语 RPC 与 POSIX 面共用同一数据源，**两 lanes 统一** |
| T3 | 容器 / systemd-nspawn / **gVisor** | 视形态 | 工业证明：gVisor 的 Sentry+gofer 就是「进程的 FS 被用户态文件服务器代理」的规模化形态——与本题同构 |
| T4 | 全远端 child（L0/L1：不虚拟化，直接远端） | 零 | 已实测 ✓；本地只留传输 |

- **T2 已知坑（L3 实验的检查单）**：① **inotify 在 FUSE 上静默失明**（内核限制）——LSP watcher 需 polling fallback 或由 teleportd 事件推送做「inotify 代理注入」；② mmap 共享写需 FUSE writeback cache 模式；③ stat 风暴 → attr/entry cache 超时 + readahead（§10.1 对策原样适用）；④ flock/fcntl 语义依 daemon；⑤ uid 映射走 userns；⑥ Ubuntu 24.04+ 对非特权 userns 有 AppArmor 约束——实测变量（dev3 的 26.04 同验，容器靶可绕）。
- **T2+ 加速位（可选层，shadow cache 哲学同款）**：overlayfs（lower = teleport FUSE 全量树，upper = 本地盘写层）→ 本地速写 + 后台 flusher 经 fs 域回推；写即时性换速度，冲突检测兜底。
- **关键发现**：T2 使 **teleportd fs 域成为两类 client 的统一后端**——tool-RPC（agent 工具，§1.2 主路径）与 FUSE/namespace（任意不受控进程）。FS 只实现一次，两个重绑定点共享。

**直接回答**：子进程 FS 虚拟化**能做**，且不是发明——是组装（unshare + FUSE + pivot_root 全是现成件，gVisor 证明了上限）。L3 从「能不能」升级为「逐项检查单走查」（上列六坑）。

### 12.7 工具异构与五类分类法（十四轮，user 提问）

**user 的检验**：代码运输对通用 interface（bash/execute，字面量即可）成立；但多 runtime 工具异构严重——命名不同（DSH `read` vs Claude `read_file`），形态更异构（job/job listing/sub-agent/memory…）。7 runtime × 30–40 工具。定制工具两条路：① 开发期清单梳理（有限集）；② 运行时动态监测——user 判几乎不可行：**(a) 同进程内调用无天然隔离边界；(b) 即使找到边界，运行时也无法界定工具触发后串联的整段代码**。两条 killer argument 成立，采纳。

**裁决 TB-13（工具分类法 / Tool-Shape Taxonomy）：运输契约，而非实现。**

工具 = **接口**（name + schema + result）+ **实现**（代码，运行在 harness 进程内）+ **后端**（环境 touchpoints）三段。teleport 只替换后端：接口保持、实现留本地（大脑侧）。**天然边界免费存在——模型的 tool invocation 本身就是离散的协议事件**（name + JSON args + 结构化 result），T-0 的切面在异构工具上原样成立。运行时「抽取下游代码」回答了错误的问题；正确的问题是「这个工具属于哪一类」。

**五类分类法（按形态，不按命名）**：

| 类 | 形态例子 | 处置 | 机制 |
|---|---|---|---|
| 1 原语形 | read / write / edit / glob / grep / read_image（`read_file` = 同形异名） | 后端替换 | 契约 adapter → teleport 原语（T-2） |
| 2 进程形 | bash / execute / jobs / background | 代码运输 + 常驻进程 | L0.5 heredoc / `exec.code`；job listing = proc/pty 原语 |
| 3 服务形 | MCP 工具、LSP、IDE 集成 | **隧道 server 至远端**，client 留本地 | sock 域按线协议转发——按协议泛化，与命名/编号无关 |
| 4 大脑形 | sub-agent、memory、skills、compaction | runtime state，**永不迁移** | 根本切分（§1.1）；sub-agent 多机 = S-4 每实例环境绑定（代码不动，绑定动） |
| 5 尾巴 | 其余异形 | fail-close + 自愈 | DP-3：先 bash 装条件再跑 |

**形态目录（回答「有限集」的真实量级）**：跨 7 runtime 的工具按**形态**归约 ≈ **8–12 个**（fs.read / fs.write / fs.edit / fs.search / shell / image / web / memory / agent-ops / job-ops / mcp-bridge / tail）。adapter 工作按形态计不按工具计——`read` vs `read_file` 只是 schema 翻译。a2a 工具面研究（Hermes/Claude/Codex/AGY tool faces，2026-09-20）已备大半材料；RuntimeProvider adapter 模式（session 面 7 个既有 adapter）向工具面同构扩展即可。

**异构 harness 的放置归宿（与放置法则闭环）**：工具分类回答「自有 runtime」（DSH 族：类 1–2 走 adapter）；**外来 harness**（Claude Code CLI 等——代码不是我们的小文本）**不逐工具适配**，按放置法则整体处置：**spawn-time binding（wrapped launch，L3）或整体远端（T4 / B+，即既有 remote-delegate 模型）**。大二进制整体运输，小文本按件运输——法则自动覆盖两类。

**诚实边界**：类 1 在 monolithic 集成的 runtime 上需逐个工程（有限且摊销）；类 5 长尾永远存在，fail-close 兜住；path 2 的字面义（运行时抽取）永久否决，**path 2'（运行时分类用于路由）保留**——按调用面模式匹配 + 侧效观察（spawn？socket？fs op？）选类，这是 capability surface（§4.9）在工具维度的应用，不是代码抽取。

### 12.6 放置法则与代码运输（十三轮，user 的 falsify 检验）

**user 的检验**：harness 本地执行 `grep -r`，若只桥 FS，须先把整树搬到本地 make it ready——数据为代码让路。而 grep 代码逻辑极简、文件服务需求极大；harness 的运行代码（LLM 写的脚本）通常也就 ~100 行。把原文字面量传到远端执行 = **工具/代码逻辑的 transport**，实际执行在远端。这是否 falsify 原设计（运行逻辑本地、只桥接 FS）？

**裁决 TB-12（放置法则 / Placement Law）**：规则不被 falsify——T-2/T-3 本就规定 grep/glob/bash 远端执行；被 falsify 的是**推理深度**：§1.2 从「语义覆盖 + 延迟容忍」论证远端执行，但没说出决定运输方向的第一性原理。user 补上了它，并引发两处微调：

- **成本不对称法则**：对任一操作比较 `C1 = 传输(数据→代码)` vs `C2 = 传输(代码+结果→数据)`。agent 负载里 C2/C1 ≈ 10³–10⁶（代码是 KB 级文本，数据是 GB 级树）。**运输方向必须 code→data**。先例：MapReduce（map 下发）、数据库查询下推、存储过程、边缘计算、Jupyter kernel（kernel 常驻数据侧）。
- **五要素精化：归属单位是每个代码单元，不是每台机器**。「runtime 留本地」的确切含义 = **编排大脑留本地**（LLM/上下文/memory/approval）；每个工具操作是一个代码单元，按放置法则调度到数据所属机器，并在那里获得**全套五要素**（远端 bash 不是「假装在远端」——它真的拥有一台远端计算机的 CPU/RAM/FS/net）。远端 child 的 CPU/RAM 是远端的事实不违反模型——模型是 per-code-unit 的。
- **agent-native twist（为何 agent 场景格外可行）**：被执行物常是模型刚写的**文本**（一行命令 / 100 行脚本）——代码即文本，文本即最廉价的运输货物。传统应用「大二进制小工作集」所以走不通这条路，agent 负载「小代码胖数据」，放置法则是压倒性的。
- **harness = scheduler**：PROC/EXEC 入口点（TB-10）由此升格——parent 的每次 exec 都是一次**放置决策**（本地 namespace 包装 vs 远端 spawn），bash 工具本质上是一个调度器。
- **两处微调（user 预言的 principle 调整）**：① §12.4 重绑定点表中 namespace 定点从并列 lane **降格为例外 lane**——仅限**不可运输代码**（交互密集 / 依赖就地 POSIX / 不受控第三方）；② FS 桥接从「首要（80%）」降为「不可运输代码的兜底」——被运输代码的 FS 视图是**原生的**（数据就在旁边），无需桥。§9.1「mount 只作旁路」由此强化为定论。

**实测（L0.5，dev3，2026-09-21）**：730 字节 Python 脚本经 ssh heredoc 运至 dev3，扫描 `/usr/lib` **933 MB / 37,581 文件**，1,305 命中，耗时 27s；本地 CPU 0.012s。**运输比 ≈ 1.3×10⁶ : 1**。反事实对照（FS 桥接同任务）：37,581 文件 × WAN stat/read 往返 + 933MB 过网 ≈ 半小时量级——**80x+ 差距且随延迟扩大**。数据见 experiments 文档 L0.5。

**机制（怎么做）**：

1. **bash 工具已经是代码运输 RPC**：100 行脚本 = heredoc 的一部分（`ssh dev3 'python3 -' < script.py`），v0 零新机制——L0.5 即此形态；
2. **v1 专用 `exec.code` 原语**：`{language, source, entry, stdin}` → 常驻解释器环境执行（DP-2 resident venv），回 stdout/stderr/exit + 产物路径（产物留远端，DP-1）；
3. **环境就绪是真正的成本中心**：运输便宜，「远端跑得起来」（依赖/版本）是经常性成本——对策 = 常驻 venv（DP-2）+ `env.status` 探测 + 自愈 pip 安装（§11.3 自愈回路）+ 内容寻址依赖缓存（mini-B+）；
4. **不可运输集合（红线）**：触本地 secrets 的代码（LLM key 不随行——需 LLM 的脚本经本地 proxy 回调）；与模型低延迟交互的 agentic 循环（留在编排大脑）；
5. **一致性红利**：代码 + 数据 + 产物同机，只有结果过网——split-brain 面严格缩小，L2 审计负担下降。

## 十三、v0 MVP 范围与里程碑

原则：每步独立可验收；验收一律第一人称实测（仓红线 1 同款标准）。

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| T0 协议骨架 | 帧格式 + pipeline + bearer 适配层（TB-6：stdio + SSH 双 bearer）；teleportd 最小面（fs read/write/list + proc spawn）；**靶机 = 本机 Docker/LXD 容器** | PC 脚本经 stdio 通道在容器内 spawn `echo` 收回流；同靶复测 SSH bearer 行为一致 |
| T1 全原语透传 | fs 全族 + glob/grep 远端执行；EnvSurface 以 cordis 插件形态替换/包装 DSH 环境工具（先验证 §5.2 关键点） | 本机容器靶：PC 的 DSH 会话对容器 workspace 走通真实 TDD 循环（远端跑测试、远端 edit 生效）；**T1.5：换 DEV3 靶（SSH bearer）复测同一验收** + `ss` 确认 DEV3 零新增监听 |
| T2 PTY | open/resize/signal + detach/attach + scrollback 回放 | 断网 30s 重连，远端长任务存活且回放窗口正确 |
| T3 一致性与结果面 | rev/CAS edit + 远端事件失效 + shadow cache（可拔层）+ DP-1 纪律（结果 cap/续读/媒体预缩/大文件缓存豁免） | 人为并发改写文件，edit 收到 conflict-fresh 而非静默覆盖；对 1GB 文件做 range read，抓包确认未整文件过网；拔掉缓存全回归绿 |
| T4 Manifest | export/apply（cwd/env/pty 句柄/幂等 journal） | 同一会话在两个远端 workspace 间瞬移，cwd/env/未落 journal 正确重建 |
| T5 Super D 集成评估 | roster 的 Environment 徽标 + selector 场景 + 与 P5 委托路线对照 | 产出对照实测报告（同任务两路线延迟/摩擦/部署成本），交 user 裁决产品去留 |

**teleportd 形态（开放问题 O-5）**：建议 Go 单静态二进制（linux/amd64 交叉编译、零依赖分发到任意 VPS 最省事）；代价是与仓栈（TS）分歧——client/EnvSurface 仍为 TS，落在仓内。

---

## 十四、开放问题（待 user 裁决）

- **O-1 传输终态**：SSH 复用流（v0 既定）vs 独立 daemon + QUIC（WAN 多路复用/0-RTT 重连更优，代价是 DEV3 新增监听端口与证书管理）。
- **O-2 shadow cache 是否进 v0**：建议否——纯透传先证明语义正确，缓存是 T3 纯加速层。
- **O-3 路径呈现**：已建议远端真实绝对路径（T-4），确认。
- **O-4 密钥回流**：read 拦截规则（路径模式 → 脱敏/审批升级）做不做、何时做。
- **O-5 teleportd 语言**：Go（分发优）vs TS（仓栈统一，但要带 Node 运行时上 DEV3）。倾向 Go。
- **O-6 UI 呈现**：Environment 徽标、瞬移操作的 UX 形态（roster 里长按瞬移？）。
- **O-7 资源竞争**：与 agent-worlds 主线的人力分配；teleport 以研究线启动、T1 为 go/no-go 门。
- **O-8 B 线升格条件**：T5 对照实测若证明 per-tool RTT 税构成真实痛点，B-logic 以「会话跨机 resume」形态启动（实验位 B0）；此前仅文档化。WASM 计算核并入 S-2（browser harness）评估。**二轮修订**：TB-4（§9.2 Docker 载体）使 B 轨以 B+ 形态提前为快速轨，本条门控仅约束「无容器的裸 log-resume」对照位 B0。
- **O-9 双轨资源配比**：B+ 快速轨（BP0–BP2，周级）与 A 主线（T0–T1 go/no-go）的人力分配；建议 B+ 先占 2–3 周拿端到端体验与 T5 对照数据。
- **O-10 net provider 换绑时机**：A 线的 egress 身份 v0 留本地（诚实缝之一，§9.1）；何时提供「远端 egress」后端（socks 回远端）待场景驱动。
- **O-11 bearer 自适应切换时机**：v0 bearer 按环境配置静态指定（本机容器=stdio，DEV3=SSH）；运行时动态探测 RTT 并换绑 bearer（如 SSH→QUIC）后置到 WAN 优化期。八轮修订：协商机制升级为**实测竞速**（并行探测、择优保持、热切换），仍后置。
- **O-12 Rendezvous 建制优先级**：self-host 先（自有 VPS 即可跑，避免过早承诺 SaaS 合规）vs SaaS 先（零配置体验最顺）；建议 self-host 先行、SaaS 跟随产品化。
- **O-13 L2–L4 实验排期**：L2 一致性审计 / L3 全进程包装（bwrap+sshfs）/ L4 B+ 传输账的优先序与时间盒；L3 是「进程包到多深」的直接测量，建议优先（与 `remote` 工具线的 RM 里程碑并行不悖——L 阶梯测的是 teleport 环境转移的深度上限，RM 线测的是工具面的日常可用性）。

## 十五、风险表

| 风险 | 等级 | 缓解 |
|---|---|---|
| WAN 延迟体验不可用 | 中 | 场景边界如实：甜点区 = LAN/同机房；pipeline+批处理优先；T5 对照实测拿数据说话 |
| DSH 内建工具不可替换（§5.2 关键点证伪） | 中 | 退化方案（同语义工具族）保底；或上游沟通/patch 层 |
| 范围蔓延成 sync 产品 | 中 | 反目标明文（§4.1.3）：不做全量同步、不做 POSIX 全集 |
| 伪安全（命令过滤） | 低 | v0 明文不做，jail+审计兜底（§4.5） |
| PTY 跨机迁移期待管理 | 低 | 边界明文（§4.3）：detach 存活 ≠ 迁移 |
| 云中继信任与合规 | 中 | E2E 加密（中继只见密文）+ 注册表最小化 + self-host 选项（§11.1） |

## 十六、词汇表增补候选（CONTEXT.md）

- **Teleport**：环境热绑定机制：runtime 永驻本地，Environment State 按原语面虚拟化到本地。
- **teleportd**：远端唯一部署物，环境原语守卫（RCE 级设防）。
- **EnvSurface**：本地虚拟环境适配层，透明替换 harness 环境工具。
- **Teleport Manifest**：环境状态序列化载体（cwd/env/PTY 句柄/journal）。
- **Environment Binding / 瞬移**：EnvSurface 对远端目标的换绑动作及其清单应用。
- **Runtime State vs Environment State**：本方案的根本切分（§1.1）。
- **Harness Transport（B 线）**：反向瞬移：harness 逻辑态经屏障点交接迁往远端执行；B-full（通用进程迁移）为非目标（TB-0）。
- **Quiescent Handoff / 屏障点交接**：只在步边界（无 in-flight 环境操作）执行的迁移协议；B-logic 的可行性根基（§8.1）。
- **沙箱环（Environment Provider Boundary）**：sandbox 从策略栅栏升级为环境提供者边界；FS/exec/net/env 四类 provider 各有可换绑后端（TB-3，§9.1）。
- **瞬态克隆（Ephemeral Clone）**：B+ 的副本哲学：内容寻址镜像按需克隆到远端、用后即焚、状态回家；非常驻安装（TB-4，§9.2）。
- **Bearer（传输适配层）**：可插拔的协议承载管道（stdio / SSH exec / WebSocket / QUIC）；协议契约在帧层，bearer 是哑管道 + 能力声明（TB-6，§10.2）。
- **结果面纪律（Result-Plane Discipline）**：工具通道只回传模型需要看的结果，不搬运数据；服务端 cap / 续读令牌 / 媒体预缩减，字节留在数据侧（DP-1，§4.7）。
- **常驻服务（Resident Services）**：需要全库/大数据集的 stateful 环境服务（LSP、构建守护、watcher、dev server）；随环境驻留远端、瞬移时重挂、通道只过语义结果（DP-2，§4.8）。
- **环境能力面（Capability Surface）**：hello 握手通告的环境能力块；harness 据此在会话组装时决定工具装载，降级对模型（unsupported 错误）与用户（UI 提示）分别呈现——「两半注册」哲学在环境维度的重放（§4.9）。
- **劣势延迟化（Latency-Only Degradation）**：环境边界的残余劣势统一转化为网络延迟与即时错误反馈；静态禁用缩至安全面与物理硬件残余；透明化降低发现成本（DP-3，§4.10）。
- **Rendezvous（云端信任桥梁）**：Multica 式配对注册表 + 打洞/中继服务；只存 `{account, machineId, publicKey, hints}`，中继全程 E2E 加密，可 self-host（§11.1）。
- **双轴模型（深度 × 质量）**：深度 = 端点能力（能否跑 teleportd），质量 = bearer（延迟/带宽/穿透性）；两轴独立，SSH 是服务器的质量 bearer 而非覆盖 bearer（§11.2）。
- **连接物流（Connection Logistics）**：连接保持、多路复用、重连、通道管理由 runtime 承担，模型只发语义请求——`web_fetch` 模式的推广（DP-4，§5.3；`remote` 工具化落地见 dashr 仓 `docs/10_plans/dashr-remote-tool-design.md`）。
- **包装深度阶梯（L 阶梯）**：L0 命令直传 → L1 本地客户端+远端服务（sock/CDP）→ L2 一致性审计 → L3 全进程包装（bwrap+sshfs）→ L4 B+ 对照；L0/L1 已实测（§12.2）。
- **五要素模型**：进程 = CPU/内存（物理，本地）+ FS/display/network（OS 界面，可逐个桥接）+ proc/exec（第四要素，children 定去向）；全桥接极限 = B+（TB-10，§12.4）。
- **重绑定点（Rebinding Point）**：环境绑定施加的位置——tool 边界 / child exec / namespace 诞生；同一模型的三种取值，mount 与 RPC 是不同定点上的 provider 选择（§12.4）。
- **Spawn-time Binding（诞生时绑定）**：parent 经 exec 界面交付 child 完整初始上下文（argv/envp/cwd/fds/namespaces/凭证）；子进程 FS 虚拟化 = 在该界面交付被重指的视图（§12.5）。
- **FUSE 统一后端**：teleportd fs 域同时服务 tool-RPC 与 namespace/FUSE 两类 client——FS 只实现一次，两个重绑定点共享（§12.5 T2）。
- **放置法则（Placement Law）**：成本不对称法则决定运输方向——代码（KB）与数据（GB）体积悬殊时，运输代码而非数据（TB-12，§12.6）；harness = scheduler，exec = 放置决策。
- **代码运输（Code Transport）**：以原文字面量/结构化载荷把工具与脚本运至数据侧执行；bash 工具即其 v0 形态（heredoc），`exec.code` 为 v1 结构化原语（§12.6）。
- **工具形态（Tool Shape）**：跨 runtime 归约的工具类别（≈8–12 个）；adapter 按形态实现，命名差异（read vs read_file）只是 schema 翻译；工具 = 接口 + 实现 + 后端三段，teleport 只换后端（TB-13，§12.7）。
