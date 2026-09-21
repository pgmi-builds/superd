# 编译期 codemod 能走多远，剩什么必须留给运行时（2026-09-16）

> 语料：`upstream/deepseek-harness/packages/client` 全部 1711 个 ts/tsx（其中 React UI 语料 299 个 tsx / 80,652 行）。
> 目的：回答两个问题——(1) React 引擎里有哪些语义是编译期**静态转换无法忠实复现**的；(2) 编译期能做到什么程度，剩下哪些**必须由运行时承接**。

---

## 〇、先纠正一个错误分类（user 指正）

本文前一版把 `nextSibling` / `children[i]` / `parentElement` 列为「React 不可移植类别」。**这是错的**：这些是**纯 HTML/DOM 语言**，不是 React 的语法或 VDOM 语义，根本不存在「转换」问题——代码里出现就原样保留，codemod 不该碰、也不必拦。

普查里登记的 **52 文件 / 160 处** 属于这一类，**结论是「无可转换性」**，仅作背景登记。

真正该问的是：**React 的 VDOM/hooks 引擎提供了哪些*服务*，静态改写无法提供、必须在运行时继续提供？**

---

## 一、必须分清的两条轴

| 轴 | 内容 | 谁负责 |
|---|---|---|
| **语法转换** | JSX→模板、hooks→响应式原语、props/refs 改写 | codemod（编译期） |
| **语义承接** | 重跑模型、keyed reconciliation、订阅契约、portal 树、批处理/时序 | **运行时**（codemod 不能凭改写消掉） |

codemod 再彻底，也只是把「对引擎的调用」换成「对另一套运行时的调用」——**服务本身必须有人提供**。

---

## 二、语义载体普查（真语料）

| 类别 | 文件 | 处 | 归属 |
|---|---|---|---|
| 函数组件声明（重跑模型的载体） | 381 | 662 | 语法面 |
| 合成事件 `on*={}` | 133 | 913 | 语法面 → 原生监听 |
| `key={}` keyed reconciliation | 80 | 205 | **语义：运行时** |
| `useEffect` 依赖数组（时序语义） | 76 | 157 | **语义：运行时** |
| `useMemo`/`useCallback` 身份协议 | 59 | 194 | **语义：运行时（细粒度下多可消解）** |
| `useState` 函数式更新 | 53 | 83 | 语法面 |
| **纯 HTML 结构导航（无可转换性）** | 52 | 160 | **原样保留** |
| `memo()` 引用相等协议 | 18 | 26 | **语义：运行时** |
| `createPortal` | 16 | 18 | **语义：DOM 无处表达的树** |
| `useSyncExternalStore` | 15 | 21 | **语义：订阅契约** |
| `dangerouslySetInnerHTML` | 3 | 3 | 语法面 |
| `createContext`/`useContext` | 2 | 6 | **语义：树内隐式传递** |
| render-prop / children-as-function | 2 | 2 | 语法面（可展开为显式调用） |
| `ref.current` 直接操作 DOM | 1 | 3 | 原样保留（普通 DOM） |
| 错误边界 | 1 | 2 | **语义：捕获与恢复** |
| 挂载 / hydration 入口 | 1 | 2 | **语义：接管既有 DOM** |
| class 组件 | 1 | 1 | 语法面（可改写） |
| `React.Children`/`cloneElement` | 1 | 1 | 语法面 |
| Suspense / lazy | 0 | 0 | 语料未使用 |
| 并发 hooks（transition/deferred） | 0 | 0 | 语料未使用 |
| `forwardRef` / `useImperativeHandle` | 0 | 0 | 语料未使用 |
| `useReducer` | 0 | 0 | 语料未使用 |
| `defaultProps` / `propTypes` | 0 | 0 | 语料未使用 |

---

## 三、三桶分类

### 桶 1 —— 无可转换性（原样保留）
纯 HTML/JS：结构导航（160）、`ref.current` 直接 DOM（3）、框架无关纯逻辑（如 `dotState`/`statusLabel` 这类枚举映射）。
**处置：codemod 不碰。**

### 桶 2 —— 编译期可转换 + 需要一个**轻量运行时库**（不是 React 兼容层）
- **响应式**：`useState`/`useMemo`/`useCallback`/`useEffect` → signals 运行时（`@preact/signals-core`）+ effect 生命周期助手
- **keyed reconciliation**：`key=` → `repeat()` 指令（Lit 自带）
- **订阅契约**：`useSyncExternalStore` → store→signal 桥（必须带上「合并 microtask 通知」语义 + **单副本**约束，见目录红线）
- **事件**：`on*` → 原生 `addEventListener` / `@event`（913 处机械可改）

**这一桶的共同点：依赖极轻、无 React 语义包袱。** Lit 本身 + signals-core 就够。

### 桶 3 —— 语义残渣：DOM 里没有位置表达的东西
| 残渣 | 规模 | 为何编译期无解 |
|---|---|---|
| **portal 的组件树冒泡** | 18 处 / 16 文件 | DOM 只有一棵树；React 的 portal 在 DOM 被搬走、事件仍沿**组件树**冒泡。必须换成显式 event bus 或状态提升 |
| **context 隐式传递** | 6 处 / 2 文件 | 无 props 链的隐式传递需要 provider/consumer 运行时（或 `@lit/context`） |
| **错误边界** | 2 处 / 1 文件 | 需要「捕获子树异常 + 状态恢复」的包裹结构 |
| **hydration 接管** | 1 入口 | 需要 `hydrate`/DOM adoption 策略 |
| **memo 抑制语义** | 26 处 | 细粒度下多半自然消解，但「抑制失效导致级联更新」需逐处核对 |
| **批处理与提交时序** | 157 + 31（layout） | 依赖数组、cleanup 时序、layout/passive 两档，须由运行时 effect 调度器复刻 |

**桶 3 总计约 27 个调用点 / 20 个文件**——这是整个 DSH Web 语料里「DOM 无位置表达」的全部面积。

---

## 四、结论

1. **语法面：几乎 100% 可机械转换。** 语料是最友好的形态——函数组件为主（381/662）、class 仅 1 个、Suspense/lazy/并发/forwardRef/useReducer **全部为 0**。

2. **语义面：约 95% 可由「Lit + signals-core + 四个小助手」承接**（portal bus、错误边界、context、hydration）。

3. **因此 preact/compat 与「codemod + 轻运行时」是在买同一件东西**：
   - preact/compat = 免费获得桶 3 的全部语义（外加 React 兼容 API 面）；
   - codemod 路线 = 自己写那 4 个助手（≈27 个调用点），换取**产出是原生 DOM + 全局 CSS 直接命中**（无需 compat 层、无影子边界）。

4. **compile-time 的天花板不是语法，而是桶 3 的大小**；在本 App 里桶 3 很小（20 个文件），所以编译期路线**值得走**，且残余工作量可枚举、可估。

5. **永远无法静态保证的一类**（普查数不出来，只能逐处人审）：**「组件函数每次状态变化都重跑」这一模型本身**。任何依赖「函数体重执行」的写法（render 期副作用、render 期随机数、依赖闭包快照）在细粒度响应式下语义改变。语料的缓解因素：副作用集中在 `useEffect`（157 处）而非函数体，因此这一类的暴露面被压得较小——但**它必须作为人审清单存在，不能靠 AST 断言**。
