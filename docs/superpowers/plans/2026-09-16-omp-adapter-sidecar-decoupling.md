# OMP Adapter：Sidecar 与周期任务彻底解耦（lazy-only sidecar）

日期：2026-09-16 · 线：apps/agent-worlds/agent-omp · 状态：**T1–T7 已执行（ca9eefd…ab6d117），tsc 0 错、node --test 57 pass / 2 fail（均为 stash 验证过的预存环境失败）· 运行时验收待 user 于 4999 实测**

## 0. User 裁决（本轮指令，逐条）

1. **skills + slash commands 改为手动读盘**：启动读一次，之后**每小时**一次。不再经 sidecar。
2. **无消费者 / 有消费者但无活跃会话**（开 WebUI 看一眼、回放、关掉）：一律 1h 节奏，**不为该场景加速**。消费者加速后续再议。
3. **SDK sidecar 从 30s tick 完全剥离**，变成 lazy spawning：tick 永不拉起 sidecar。
4. 活跃会话时的 default model 反馈（change model → TUI 语义等同 default 转变）属**实时数据流解析**，本轮不做，后续统一处理。

## 1. 背景事实（本轮源码/实测结论）

- sidecar 零定时器、零 watcher（`sidecar/main.ts` 纯 stdin 请求循环）；一切周期性来自 adapter 的 30s `run()`。
- 30s tick 当前触碰 sidecar 的唯一点：`refreshOmpModelsCli()`（`index.ts:274`）→ 每次起/杀一个 ~220MB bun 子进程（实测 PID 12→59，~0.9s boot）。
- boot 期隐性 spawn 还有三处：`ompAvailableModelsSync()` warm（`#registerModelCatalog`）、`ompModelRolesSync()` warm（`ompProviderIds`）、`void listSlashCommands()`（`discovery.ts:81`）。
- resume 有映射时 eager spawn（`index.ts:468`）——宿主对 cold session 的 follow-promote（`history.ts:201`）使「WebUI 打开旧会话」即触发。
- 宿主侧磁盘读地基已在：`readOmpDefaultModelFromConfig`（mini-YAML 扫描）、`loadModelsDb`（node:sqlite 只读）、`loadModelsYml`。
- SDK discovery 是 10+ provider（claude/codex/agents/omp-plugins/opencode/…）+ capability 层的深度依赖网，**整包不可 vendor**（main=.ts、Bun.*/bun:ffi）。

## 2. Scope

**In**：T1 磁盘发现读取器；T2 discovery 重接线 + 1h knob；T3 tick 与 sidecar 解耦 + boot 目录磁盘优先；T4 modelRoles 宿主读；T5 resume lazy；T6 死路径清理；T7 构建/全测/AGENTS.md 回写。

**Out（后续任务）**：消费者检测与加速；fs.watch；活跃会话 change-model→default 反馈；宿主侧 modelRoles 写（写路径维持「写时按需 lazy spawn sidecar」）；dataflow 解析。

## 3. 保真度边界（slash/skills 磁盘读取器 v1）

- 扫描根（v1）：OMP 原生 `~/.omp/agent/{commands,skills}`、项目 `<cwd>/.omp/{commands,skills}`；claude 格式 `~/.claude/{commands,skills}`、`<cwd>/.claude/{commands,skills}`（skills 为 `<dir>/SKILL.md`）。
- **不含**：embedded 内置模板、codex/opencode/cursor/gemini 等外来 provider、capability 层语义（at-imports、managed skills、extensionRoots reload）。差异显式记录，必要时后续扩根。
- frontmatter 解析：`description` / `argument-hint`（命令）、`name`/`description`（技能），手写解析，零新依赖。
- 实现前置：以 SDK `src/discovery/agents.ts`、`helpers.ts` 的实际根为准复核上述路径（T1 第一步），不符以 SDK 为准。

## 4. Tasks（TDD bite-size，每任务独立可测 + commit；测试导入 dist/，先 build 后 test）

- **T1** 新模块 `src/omp-disk-discovery.ts`：`readSlashCommands(cwd?)` / `readSkills(cwd?)` 纯读盘；fixture 测试（临时目录造命令/技能文件）。验收：roots 与 SDK 一致；空目录/坏 frontmatter fail-soft。
- **T2** `discovery.ts` 重接线：boot 注册一次 + `setInterval` 1h（新 knob `OMP_DISCOVERY_REFRESH_INTERVAL_MS`，默认 3_600_000，0 禁用）重挂（先 dispose 旧注册再重注册）。验收：不再 import sdk-client；测试断言重注册幂等。
- **T3** tick 解耦：`sdk-client` 导出 `isSharedSidecarLive()`；`refreshOmpModelsCli` 改走 `callSharedIfLive`（sidecar 不活 → 直接 false，**绝不 spawn**）；`loadOmpModels` 磁盘优先（DB∪YML），`ompAvailableModelsSync` 去掉 boot warm。验收：tick 路径源级断言无 `callShared`；冷启动零 spawn（冒烟阶段人验）。
- **T4** `omp-store` 扩展 mini-YAML 扫描读整个 `modelRoles` 块（`readOmpModelRolesFromConfig`）；`ompProviderIds` 改用它；删除 `ompModelRolesSync` 调用。验收：roles 排序不触 sidecar。
- **T5** resume lazy：`index.ts:468` → `new LazyOmpRpc(["--approval-mode", approvalMode, "--resume", ompFile], spawnCwd)`。验收：resume 不再 `OmpSdkClient.spawn`（源级断言 + 语义注释）。
- **T6** 死路径清理：删 `readOmpTranscriptSdk`、`sessions.listAll`/sdkIndex 暖取（无调用者或仅测试 fallback），确保无隐性 sidecar 引用。
- **T7** `npm run build` + `node --test test/*.test.mjs` 全绿；`AGENTS.md`（omp-web）回写本坑与新 knob；更新本 plan 状态。

## 5. 验收（运行时，按仓规交用户）

4998 冒烟（user 在场时执行）：冷启动浏览/回放零 `sidecar/main.ts` 进程；首 prompt 恰一次 spawn；idle-exit 后进程消失；tick 一个周期无 spawn；`/` 菜单与技能清单来自磁盘且 1h 刷新。

## 6. 决策记录

- 写路径（WebUI default → config.yml）维持 sidecar 按需 spawn：写是罕见事件，不值得宿主重写 YAML writer（2026-09-16 user 方案评审结论）。
- discovery v1 根子集 + 无 embedded：务实保真度边界，差异显式（§3）。
