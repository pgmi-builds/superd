# React→Lit Codemod PoC（模式目录 + CDP 对比台）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `apps/react-codemod-to-lit/`（自包含嵌套仓，root exclude 已覆盖）落地第一条「React hooks → Lit + Signals」手工试点：取上游 `ui-jobs/JobListAction.tsx` 的**模式骨架**（非业务依赖）做 React(preact/compat) 与 Lit+signals 双胞胎实现，用 CDP 驱动两者走同一交互脚本并做 DOM 对齐断言，产出**模式目录第一卷**（每条 = ast-grep 模式 + 语料计数 + 映射写法 + 验收结果）。

**Architecture:** 组件级 PoC，不起 DSH daemon。单页双栏：左 = React twins（经 vite alias 跑在 preact/compat 上——已验证的宿主引擎），右 = Lit + `@preact/signals-core`（TC39 `.value` 形态，承接 2026-09-14 数据桥 spike 的 runtime 裁决）。playwright 脚本按步骤驱动（开合 → 外点关闭 → job 进入 running → tick 走秒 → 完成），每步对两栏各抓 DOM 快照，归一化后 diff 断言行为等价。

**Tech Stack:** TypeScript + vite 6.3.6、preact 10.x（alias react→preact/compat）、`@preact/signals-core`、lit 3.x、playwright 1.60.0、exact-pin、`npm install --cache .npm-cache`。

**前置事实（来自 `docs/dsh-web-react/01` 普查与 `02-ui-lit-compile-retrospective`）：**
- 语料 hooks 有限集：9 种；`useState` 317 / `useRef` 235 / `useEffect` 196 / `useMemo` 130 / `useCallback` 114 调用点。
- 编译期全量翻译已裁决停止；本方向 = **手工按模式迁移**，codemod 只做「模式定位 + 机械面改写」。
- 数据桥三根因（signals-core 双副本 / 同步通知重入 / 追踪作用域泄漏）已知且有修法；本 PoC 单仓单副本自然规避，但模式目录要写「双副本红线」条目。

## Global Constraints

- 上游源码零修改：试点组件是**模式复刻**（写成独立文件），不 import 上游任何包。
- 测试数据/home：本 PoC 无 daemon、无 DSH_HOME 依赖。静态站 `vite preview` 起在 **4987**（4996-4999 族与 4986 已占；起前 `ss` 预检，用完即停）。
- 仓自包含：独立 git（root `.git/info/exclude` 已含 `apps/react-codemod-to-lit/`）；依赖 exact-pin。
- codemod 设备面：ast-grep（语料模式普查）、ast_edit（机械改写）、lsp（诊断）——每任务至少一处使用并记录。

---

### Task 1: 仓骨架 + 依赖安装

- [x] `package.json`（name=`@pgmi-builds/react-codemod-to-lit-poc`，exact-pin）/ `vite.config.ts`（alias react 家族→preact/compat，同 ui-preact 写法）/ `tsconfig.json` / `README.md` / `git init`。
- [x] `npm install --cache .npm-cache`（lit、preact、@preact/signals、@preact/signals-core、vite、typescript、playwright、@types）。

### Task 2: 双胞胎组件（模式复刻 ui-jobs/JobListAction）

- [x] `src/react/job-list-action.tsx`：React hooks 写法，覆盖 6 个模式形状——P1 开合布尔 useState、P2 外点关闭（useEffect+useRef+pointerdown）、P3 状态枚举映射（纯函数，两栏共享一份）、P4 keyed 列表渲染、P5 live tick（running 中 setInterval 走秒，useEffect cleanup）、P6 useMemo 派生统计。
- [x] `src/lit/job-list-action.ts`：Lit + signals-core 同构实现（signal/computed/effect + lifecycle 承接 P2/P5；`repeat` 指令承接 P4）。
- [x] `src/main.ts` + `index.html`：双栏并排挂载，同一家 store 数据源分别注入。

### Task 3: 语料模式普查（ast-grep）

- [x] 用 dvc `ast_grep` 对 `upstream/deepseek-harness/packages/client` 跑 6 个模式的 AST 模式（如 `useState($B)`、`useEffect(() => {$...}, [$D])`），记录每模式命中数与代表文件，写入模式目录。

### Task 4: CDP 对比台

- [x] `test/cdp-parity.mjs`（playwright）：`vite build` + `vite preview --port 4987` → 按 5 步脚本驱动左右两栏 → 每步抓两栏容器 innerHTML → 归一化（去时间数字差异、空白）→ 断言结构等价 → 产出 `test/report.json` + 结论。
- [x] dvc `browser` 对 preview 页做一次 live smoke（开合断言）。
- [x] lsp 诊断双胞胎文件 0 error；ast_edit 演示一处机械改写（`className`→`class` 面或等价形状）并 dryRun/apply 记录。

### Task 5: 模式目录第一卷 + 收尾

- [x] `docs/pattern-catalog-01.md`：每条模式 = React 写法 / Lit+signals 写法 / 语义差异注记（cleanup→disconnectedCallback 等）/ ast-grep 定位模式 / 语料计数 / CDP 验收结论。含「双副本红线」「时间归一化」两条运维注记。
- [x] `npm test`（跑 cdp-parity）+ commit（仓内 git）。

## Acceptance

1. preview 页双栏交互行为逐步骤等价（report.json 全绿）。
2. 模式目录 6 条齐备且每条带语料计数（ast-grep 实测）。
3. 仓内 git 全程 commit；无 daemon、无上游修改、无 prod home 触碰。
