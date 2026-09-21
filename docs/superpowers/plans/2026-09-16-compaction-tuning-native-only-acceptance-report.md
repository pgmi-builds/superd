# Compaction-tuning 验收报告：压缩阈值行 = 世界分隔的活证据（含 WebUI 层）
- **日期**: 2026-09-16
- **状态（2026-09-16 user 裁决后更新）**: **探针包已拔除删除**。本线纯粹是 multi-agent 功能，不涉及 Native Dash Runtime 的 functionality（compaction 等）——那属于 Dash 开发项目的 shipment 范畴。本报告**降级为分隔证据的存档**：包没了，证据与机制结论继续成立（见下文「核心结论」），且不得作为本线新增 native 功能的理由。
- **实例**: `aw-4999-test.service`（systemd-run --user，SUPERD_KEEP=1，**保持运行待 user 亲测**）
- **入口（WAN）**: `https://test.pc.randomhash.app/?token=…`（Caddy `test.pc.randomhash.app → 127.0.0.1:4999`，header_up Host 重写 + 剥 Origin；实测 303→cookie→200 走通公网域名）
- **入口（loopback）**: `http://127.0.0.1:4999/?token=…`
- **token 注意**: 一次 boot 会打**多行** `dsh web: ?token=`，只有该段**第一行**是活 token（`start-4999.sh` 的 `tail -1` 惯例会抓到死 token，本轮已实测校正）。
- **前置**: 4999 原占用者（aw-claude 实例 + 其中继）经 user 授权直接停掉。

## 本次落了什么

`@pgmi-builds/compaction-tuning`（`apps/agent-worlds/compaction-tuning/`，移植自 dashr `src/compaction`）：

- **宿主半**：装 `compaction-tuning` settings namespace（`thresholdRatio` + composition-only 的 `retainTokens`）；设置提交即把值**替换到活 `compaction-basic` 引擎**的 policy 对象上（引擎逐步边界重读，无需重启/重载）。
- **bundle patch**：重新启用 dsh-web-app 默认禁用的 `compaction-basic` + `command-compact`（不启用引擎则 tuning 无同步对象；应用于 web-app 之后，覆盖其 disable）。
- **客户端半**：Settings → General 页「自动压缩阈值」stepper（10–95%，步进 5%，无 Save 按钮、逐击即写、revision 栅栏）。
- **接线 = ctx0-only**：`test/smoke.mjs` 里只进 `aw-ctx0` profile（bundles + `PGMB_PACKAGES` + dependencies）；omp / codex 世界的 profile **不列该 bundle**（§12 per-agent 定制权的 native 侧实例——native 世界的能力也归 native 的 composition 自持）。

## 核心结论：压缩阈值行只在原生 DSH WebUI 出现，外国世界 UI 不出现 —— 这本身就是世界分隔的证明（连 WebUI 层都分隔）

**机制**（同一个浏览器页、同一个 origin、同一个认证域——ctx0 cookie，S4）：

1. 浏览器壳与 client entries 由**服务 HTML 的那个 composition**（ctx0）产出（§4.1 客户端面交付层）——`@pgmi-builds/compaction-tuning` 的 client entry 就在 ctx0 的 boot graph 里，跟着壳发给浏览器。
2. 但这一行**渲染与否由被寻址世界的宿主面决定**：行的 `loadConfig` 走 `settings.describe` RPC，经 hub 委托打到**当前 selector 指向的 ctx**。native（ctx0）→ namespace 在，行渲染；omp / codex → 该世界的 ctx 根本没有 compose 这个 bundle，namespace 不存在 → `loadConfig` 解析 `null` → **行什么都不画**（未服务 namespace 的 settings 卡契约，不是 CSS 藏起来，是节点都不进）。
3. 写路径同理：stepper 的 `save` 带 revision 栅栏写回**同一个被寻址世界**；在外国世界，行不存在，自然无写入口。

**wire 实测（2026-09-16，4999 实例，cookie 握手后）**：

| 寻址 | `settings.describe` namespaces | `compaction-tuning` |
|---|---|---|
| ctx0（原生） | `… llm-deepseek, web-search-deepseek,` **`compaction-tuning`** `…` | **在**（value=0.8/50000, revision 0） |
| `/omp/api`（omp 世界） | `agent-default-model, …, shell, permission` | **不在** |
| `/codex/api`（codex 世界） | `agent-default-model, …, shell, permission` | **不在** |

**读法**：UI 不是壳的常量装饰，而是**被寻址世界 composition 的投影**——同一个壳、同一份浏览器代码，指到哪个世界就画出哪个世界有的东西。压缩阈值行只在原生世界可写、外国世界连节点都没有，等于给「世界分隔」补上了 **WebUI 层**的活体证据：不止后端 ctx 分隔（各自 home、各自会话、各自 settings 存储），**呈现层同样按世界分隔**。

**边界（防误读）**：这证明的是「per-world 宿主 composition 决定 UI 内容」，不是「外国世界没有浏览器页」。若某 adapter 要自己的阈值行（§12 per-agent 定制权），正路是它自己的 composition 自持一个 namespace + 行——分隔的缝在 composition，不在浏览器。

## 行为级验收（第一人称实测，非静态证据）

| 验收点 | 结果 |
|---|---|
| ctx0 `settings.describe` 含 `compaction-tuning` | ✅ base=value=`{thresholdRatio:0.8, retainTokens:50000}` |
| 写入 → 持久化 → 活引擎同步 | ✅ 写 0.65 后以一次性探针 boot 同一 composition（`test/aw-probe.mjs`，一次性 home + 端口改 4985），引擎 config 实测 `thresholdRatio: 0.65`、`retainRatio` 被丢弃、其余字段逐字保留、对象 frozen；已复位 0.8（revision 2） |
| 外国世界无 namespace | ✅ 上表 |
| 浏览器 boot graph 含 client entry（inject 边齐）+ combo 产物 200 | ✅ `/plugins/??@pgmi-builds/compaction-tuning/client.js` 含 `settings.general.item` 注册 |
| 包测试（先 build 后 test） | ✅ `npm test` 6/6 绿（`node --test test/*.test.mjs` 惯例） |
| 上游单实例纪律 | ✅ 包内 `node_modules` 无 `@deepseek-ai/*` 物理副本 |
| WAN（Caddy 域名） | ✅ 303→cookie→200 |

## 文件清单

- 新包：`apps/agent-worlds/compaction-tuning/`（`package.json` / `cordis.patch.yml` / `src/{index,install,config}.ts` / `src/client/*` / `scripts/build-client.ts` / `test/host.test.mjs`）
- 接线：`apps/agent-worlds/test/smoke.mjs`（aw-ctx0 bundles + PGMB_PACKAGES + dependencies，仅 ctx0）
- 诊断：`apps/agent-worlds/test/aw-probe.mjs`（一次性 home 探针，零触碰共享 home 写路径之外的状态）

## 关停

`systemctl --user stop aw-4999-test`（user 亲测完成后执行）。
