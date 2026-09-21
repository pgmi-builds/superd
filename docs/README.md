# Super D — docs 索引

> 本仓文档分四层：**规划**（蓝图 + 组件边界）、**决策**（ADR）、**superd 专属研究**（research/ +
> 嵌入模式）、**镜像研究集**（01–05 簇，dashr 仓研究文档的只读副本）。
> 2026-09-08 整理：research/ 去重（4 个与镜像集/dashr 重复的文件已删，见 §3）。

## 1. 规划与决策

| 文件 | 说明 |
|---|---|
| [`00-blueprint.md`](./00-blueprint.md) | 开发蓝图 **v0.4**（grilling 4 轮收敛 + 2026-09-08 v0.2–v0.4 修订：Agent UI Adapter 对偶组合层、DSH 全透传与认证链、selector 落位 `sidebar.footer.action`） |
| [`01-component-boundaries.md`](./01-component-boundaries.md) | 组件边界与 UI 组合层 **v0.3**：两幅 Mermaid（host / 浏览器侧）+ 包 roster 三档草案 + 切换机制两档 |
| [`06-package-update-guidelines.md`](./06-package-update-guidelines.md) | **包与基线更新指南**（2026-09-21）：上游 dsh 基线对齐操作程序 + 0.1.6 线实证陷阱表 + 自有包构建/发布纪律（正例 = dashr 对齐轮；红线仍以根 AGENTS.md §〇 为准） |
| [`adr/`](./adr/) | 架构决策记录 0001–0007（**0006** 前端组合层对偶、**0007** DSH 透传 + routing mux + token mint 为 2026-09-08 新增；0001/0005 附当日精化注） |
| [`image.png`](./image.png) | selector 位置参考截图（Codex 侧栏形态：brand → 命令行区 → Projects） |

## 2. superd 专属研究

| 文件 | 说明 |
|---|---|
| [`research/research-heterogeneous-agent-runtimes.md`](./research/research-heterogeneous-agent-runtimes.md) | 六家异构 runtime（Claude Code / Codex / Hermes / Pi / OMP…）SDK 与协议面调研——adapter 接入层选型依据（蓝图 §3） |
| [`superpowers/plans/2026-09-12-tui-terminal-surface-research.md`](./superpowers/plans/2026-09-12-tui-terminal-surface-research.md) | **TUI 终端入口**（App feature 子方向）：社区 7 个 TUI 插件实现/成熟度对比 + 上游 dsh 无自带 TUI 但留有隐性挂载入口（profile bundle / cmdline 透传 / session log 重放 / ACP）——2026-09-12 |


## 3. 镜像研究集（01–05 簇，只读）

`01-cordis-runtime/`、`02-dsh/`、`03-mobile-ios/`、`04-session-storage/`、`05-dashr-dev/` 五簇是
dashr 仓 `docs/60_exploration-and-research/` 的**只读镜像**（2026-09-08 复制，hash 与 dashr 逐一
一致）：Cordis 框架与 JS/TS 语言层、DSH Web UI 架构与 wire 层（含 `webui-wire-data/` 机器工件）、
iOS/移动端、会话存储与 compaction、插件开发实操。**正本在 dashr**——修改请去正本仓，勿在此编辑。

> 2026-09-08 去重记录：原 `research/` 里的 `dsh-webui-{backend-data-inventory,wire-appendix,
> strip-boundary-research}.md` 与 `ios-chat-app-bridge-research.md`（strip-boundary 为旧版，与
> 镜像集新版仅差 4 行）与镜像集/dashr 完全重复，已删除；`research-heterogeneous-agent-runtimes.md`
> 为 superd 专属，保留。
