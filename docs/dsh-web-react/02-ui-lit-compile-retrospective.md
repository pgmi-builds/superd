# UI Lit Compile 方向复盘（实验计划存档）

- 日期：2026-09-12 收官（user 裁决停止）
- 代码资产：`apps/ui-lit-compile/`（独立 git，14 commits，保留不再推进）
- 姊妹仓：`apps/ui-preact/`（部署/测试回路）；语料基线：`upstream/deepseek-harness`（dsh-v0.1.3-alpha.2，零修改）
- 前置研究：`docs/dsh-web-react/01-react-syntax-corpus-survey.md`（React 语法有限集普查）

## 一、实验目标与总体思路

把 DSH Web UI 从 React 迁移到 Lit + TC39 Signals，**不手改 8 万行 React 语料**：做一个编译期引擎（两遍 babel），把上游 TSX 编译为原生 DOM 表达式 + signals，再用一个原生 renderer 替换 `ui-renderer`，全量跑起整个 App。验收标准：**像素级（vision 截图）可见**，DOM 元素存在 / console 零错误不算通过。

## 二、引擎构成（已实现）

- **pass1 `hooks-transform`**：React hooks → signals（`useState`→`state()`、`useMemo`/`useEffect`→`derived`/副作用；运行时导入统一 `_lit_` 前缀别名防局部变量遮蔽；`React.useX` 命名空间归一化）。
- **pass2 fork `babel-plugin-jsx-dom-expressions`**（babel-preset-solid 内核）：TSX → DOM 表达式，`moduleName='ui-lit/runtime'`，wrapConditionals + delegateEvents。
- **runtime**：vendored dom-expressions `client/*` + 自研 `rxcore.js`（基于 `@preact/signals-core` 1.14，TC39 `.value` 形态）；补 `createPortal`/`createElement`/`Fragment` shim、`toKebab` style 处理。
- **native renderer**（`pkg-src/native-slots.jsx`）：`createNativeRenderer(ctx, registry)` 直接消费 `registry.hostFace()`，selector-hook 桥（`externalStore` + sourceSignalCache）、每会话 `storeOf`、chain 选举、locale、`root()` effect 生命周期。

## 三、验证结论（按层次）

| 层 | 深度 | 结论 |
|---|---|---|
| Slot 层 | **浅** | SlotCore framework-free，`hostFace()` 可被原生 renderer 直接消费，未重写任何 slot 语义。**不是卡点** |
| JSX 语法层 | **几乎免费** | 359 文件 357 个可编译（91.6%→100% convertible）。fork dom-expressions 正确；Mitosis 不适合（要求受控子集过 IR，命令式 React 语料过不了） |
| Hooks→Signals 语义 | **深** | 求值模型不同：React 整函数重跑+diff 有容错；signals 细粒度零容错，编译变换必须精确捕获每条依赖边，漏一条就静默定格且不报错 |
| React 运行时契约 | **长尾** | createElement 返回描述对象、createPortal、children 归一化、style 驼峰等隐式行为，8 万行=8 万个隐式假设，逐个以像素 bug 形式暴露 |
| **数据桥** | **真卡点（未解）** | `HostObservable → externalStore → signal` 生命周期问题：静态骨架像素级正确（侧栏/hero/composer/三栏几何全对、0 console 错误），但一切**异步数据驱动区域全空**（session list、workspace 文件夹名、chat area） |

## 四、经验教训

1. **「语法子集干净」≠「移植成本低」**：成本大头在运行时契约与数据管道，随语料面积线性增长。早期可行性判断只做语法普查，系统性低估了后半程。
2. **范式容错差是本质**：React 错了还能看（多渲染一次结果仍对），signals 错了静默定格。编译到零容错范式后，React 语料里所有欠债一次暴露。
3. **空白测试环境使故障不可判定**：空白 home 下初始快照为空，「订阅坏了」vs「没数据」无法区分。**验证数据驱动 UI 必须先从真实实例（3080/3081）克隆会话数据**。
4. **像素级验收是对的**：过程中多次「DOM 有元素、console 无错」的宣称被截图证伪。
5. **调试回路成本主导**：每个 bug 都很小（kebab-case、import 参数顺序、变量遮蔽），但每个都要 headless-chromium + vision 一轮才能发现，累计成本远超修复本身。

## 五、若重启：新实验方向（本复盘的结论性输出）

> **从数据桥入手，不从编译器入手。**

前置事实：编译器（语法层）已被证明可行；slot 层已被证明可原生消费。唯一未验证的环节是数据桥在**真实数据**上的正确性。

实验计划（spike 性质）：

1. **建真实数据测试床**：从 3080/3081 参照实例克隆真实 home（sessions/workspaces/projections）到测试 home，消除「空数据不可判定」问题。
2. **最小数据桥验证**：不改 UI——只写一个探针页/脚本，把 `sessions`、session scope adapter `current`、`projections.faceOf` 等关键 HostObservable 逐一接 `externalStore`→signal，断言：初始快照非空、订阅推送后 signal 更新、无订阅泄漏（computed 重跑计数）。
3. **桥验证到像素级后**，再回到编译产物上让 session list / chat area 点亮。
4. 每一步都先有真实数据、再做改动；禁止在空白 home 上调试数据路径。

落位：新方向子目录 `apps/dev-base/`（探索方向 base，superpowers 流程：brainstorm → spec → writing-plans）。

## 六、Spike 结果（2026-09-14，apps/react-codemod-to-lit）——数据桥已修复

真实数据测试床（从 ~/.dsh 克隆 agent-harness/base 两个 workspace 的 sessions 到 4998 测试 home）+ 20 级探针阶梯，定位出三个叠加根因并全部修复：

1. **signals-core 双副本**：38 个 shadow 包各自内联一份 signals-core；renderer 的 externalStore signal（副本 A）在其他包的 computed（副本 B）里被读——跨副本无依赖追踪：**初值流通、更新永久丢失**。修复：`ui-lit/runtime` 成为模块表单词（shell 单例 seed），pkg-build 全包 `--external`。
2. **同步通知重入**：store 通知在写入者栈内同步投递 → effect 自嵌套 >100 层（"Cycle detected"）。修复：externalStore 通知走合并的 `queueMicrotask`（对齐 React uSES 语义）。
3. **追踪作用域泄漏**：slot 组件在父级 insert memo 的被追踪作用域内同步执行，子组件读的信号全泄进父 memo 依赖 → 子组件一次 store 写入导致整棵子树重建（agentPresets fetch 风暴 2434 req/3s）。修复：renderEntry 在 `untrack` 下执行组件。

**验收（vision 像素级）**：session list 渲染真实会话行（标题+时间）；点击会话 → conversation header（标题/Chat/Trajectory tabs）、composer、会话统计 footer（"1 turns · 1 steps | LLM 1.8s | 123 tok/s | Cache hit 99.9%…"）全部点亮；0 console 错误、无请求循环。

**已知残留（后续工作，非 spike 范围）**：
- 消息正文区仍空（stats 已到，消息列表渲染另有门）；
- stock React 组件条目（如 dsh-session-log-export 的 SessionLogDownloadHeaderAction）被原生 renderer 直调崩溃（`__H`），需 preact island 桥（同 sidebar-bridge 模式）；
- details 右栏因 rc.2 基座漂移禁用了 sidebar-right（dockkit 缺词）；
- rc.2 基座与 alpha.2 编译语料的版本混合待对齐。

commits：ui-lit-compile `dc6ab56`、ui-preact `d5271ec`、react-codemod-to-lit `bf88555`（探针阶梯存档）。
