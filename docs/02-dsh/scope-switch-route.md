# 作用域切入路线（loader 行热翻转）——可行性研究档案

- 日期：2026-09-10
- 性质：**研究档案**（方向备选材料之一；multi-agent registry 路线搁置后的候选切入，未立项）
- 源码锚点：`upstream/deepseek-harness` @ `dsh-v0.1.3-alpha.2`；`cordis-plugin-loader@1.0.3`（dsh 安装树内实源）
- 背景：registry 多槽路线实测失败（服务面进程级单例，见 `multi-agent-registry.md` 顶部状态）。本路线回答"能否不碰 Agent Registry 单槽、以作用域为切入点做 runtime 切换"。

## 〇、结论速览

**可行，且比 registry 多槽便宜一个数量级**：不动 `agents` 单槽，"切换" = 通过 `ctx.loader` 的 `entry.update({disabled})` **热翻转 loader 行**（native 世界行 ↔ omp 世界行互斥）。撞名、目录、清单、运行时四条混线全部被互斥结构性消灭；代价是全 app 粒度互斥（不能两个 runtime 同时服务不同会话）与换出即杀（可加确认提示）。

## 一、两种"作用域"辨析（源头核实）

1. **dsh-scope**（`packages/core/scope`）：事件路由 + 注册视图分层。`createScope(ctx, key, {parent})` 铸带标签 ctx + fiber；未打标签监听即 global 层；注册视图沿父链向下继承、事件准入沿父链向上。**不做服务隔离**。用户记忆中的 "global 作用域" 即此层的无标签基座。
2. **cordis-plugin-loader EntryGroup / entry.update**：运行时插件装卸。`entry.update(Partial<EntryOptions>, create, force)` 内部 `await this._dispose(previous)` 后重建 fiber——**热装卸是一等 API**（HMR 插件 = 其上的文件监听器）。

## 二、五个问题的答案

| 问题 | 答案（源码依据） |
|---|---|
| 作用域能否包裹 Agent Registry？ | 不能"包裹"（`agents` 由 base 行在根 fiber provide，消费者全在根，后建 scope 在根之下无法为既有消费者改写根服务）；但能**轮换**——agent-loop 行 fiber 卸载时其 `setFactory` effect disposer 自动退槽，omp 行加载时入槽，Registry 原装不动 |
| 自定义作用域 + 按钮触发？ | 机制即 `ctx.inject(['loader'])` → `ctx.loader.entries()` 按 id 找行 → `entry.update({disabled})`。上游 `dsh-host-plugin-inventory` 证明只读访问路径；写路径 API 公开，无现成 UI |
| 谁包含谁 → 策略 | registry 多槽退役；切到 OMP = 热禁 `agent-loop`+`llm-pi-ai`/`llm-deepseek`+`agent-presets` 行、热启 `omp-provider` 行——恰好等于 omp-web-sdk 独占形态的 patch 行语义，原包几乎原样可用 |
| 作用域单槽/多槽？active 概念？ | 都非内建。dsh-scope 任意多、可嵌套、无 active；loader group 任意多并发。互斥由切换方自持 |
| 换出即杀？ | 是。`entry.update` dispose 旧 fiber → 该世界服务退场；AgentRegistry `internal/status` 监听发现 UNLOADING 祖先 → `closeInitiators()` 关闭活 agent。会话在盘无损，可切回 resume。切换前查活 agent 弹"任务将被终止"提示 |

## 三、已核实的机制细节

- 互斥消撞名：任一时刻只有一家 llm 路由在注册，`DUPLICATE_ADAPTER`（fail-loud）不会触发——比"关掉 omp 路由"的 disable 补丁干净。
- 根树不落盘：`Loader.write()` 对根树是 no-op（in-memory），运行时翻转**不持久化**；重启回 patch 行静态形态。持久化选择由切换方自写（profile patch 或自有小状态）。
- loader 有内建 isolate 插件（`fiber.entry.options.disabled = true` 沿祖先组下压）——组禁用语义现成。

## 四、spike 前必须实证的三点

1. **热翻转时序安全**：prompt 进行中禁 agent-loop，`closeInitiators` 的 initiatorDrain 排水是否干净。
2. **disabled 行常驻**：omp-provider 行初始 disabled 进 patch——包已装、fiber 不建，验证不触发其 fail-loud。
3. **client compose 跟随**：行集变化经 `loader/partial-dispose` 驱动 client bundle 表更新，UI 无残留。

## 五、与 Multi-Context 蓝图的关系

另一候选 `docs/superpowers/plans/2026-09-10-multi-context-design.md`（多 Cordis Context 容器 + BFF 导流门）隔离更彻底（跨进程/跨 Context），成本也最高；本路线（loader 热翻转）是单进程内的最廉价互斥形态，可作为 Multi-Context 的先导实验或独立小步。两者都待用户裁决取舍。
