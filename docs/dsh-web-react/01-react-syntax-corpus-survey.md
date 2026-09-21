# DSH Web UI — React 语法与语料全量普查（2026-09-13）

方向：**dsh-web-react**（DSH Web 面的 React 技术栈分析；上游基线 `0.1.3-alpha.2`，本地参照 checkout `upstream/deepseek-harness`，只读）。

方法：对 `packages/client` 下全部 `*.tsx`（299 个文件、80,652 行）做正则统计；import 面按真实 `import ... from 'react'/'react-dom'` 语句解析（多行 import 已归一化）。数字为静态统计，供 compat 覆盖面评估用。

---

## 一、结论先行

1. **组件定义几乎 100% 是函数组件**：全语料只有 **1 个 class 组件**（`ui-renderer/src/client/scoped-slots.tsx` 的 `SlotErrorBoundary extends Component`，错误边界）。
2. **Hooks 实际只用 9 种**；`useReducer` / `useImperativeHandle` / `useTransition` / `useDeferredValue` / `useInsertionEffect` / `useDebugValue` / `useActionState` / `useOptimistic` **全部为 0**。
3. **并发特性零使用**：`<Suspense>`、`lazy()`、`forwardRef`、`startTransition` 在整个语料中**一次都没出现**——这是 preact/compat（缺并发特性）可行性的核心依据。
4. `useState`、`useId` 等**全部是 React 内建 hooks**（`useId` 是 React 18 新增），不是自研或第三方；运行时全部经平台模块表以 `require("react")` 解析。

## 二、语料范围（按行数排序，前 15）

| 包 | tsx 文件数 | 行数 | | 包 | 文件数 | 行数 |
|---|---|---|---|---|---|---|
| ui-primitives | 61 | 11,424 | | ui-renderer | 11 | 3,211 |
| ui-chat | 37 | 9,375 | | ui-directory-picker-browse | 3 | 3,042 |
| ui-trajectory | 12 | 8,300 | | ui-subagent | 3 | 1,706 |
| ui-conversation | 29 | 7,925 | | ui-agent-preset | 5 | 1,592 |
| ui-tool | 30 | 6,143 | | ui-attachment | 12 | 1,560 |
| ui-settings-models | 13 | 6,022 | | ui-settings-plugins | 10 | 1,447 |
| ui-workspace | 8 | 4,816 | | 其余 24 个包 | — | ~7,000 |

（全表共 38 个 `ui-*` 包 + `locale`；shell 侧 `apps/web` 仅 ~10 行入口，React 种子在 `dsh-client-web/src/seed.ts`，见 §六。）

## 三、Hooks 清单（occurrences = 全文出现次数；files = 实际 import 该 hook 的文件数）

| Hook | occurrences | files | 备注 |
|---|---|---|---|
| `useState` | 317 | 76 | React 内建，最重 |
| `useRef` | 235 | 49 | |
| `useEffect` | 196 | 60 | |
| `useMemo` | 130 | 35 | 引用相等性作为渲染协议的一部分 |
| `useCallback` | 114 | 26 | |
| `useLayoutEffect` | 31 | 13 | |
| `useSyncExternalStore` | 32 | 10 | React 18 内建（另有 shim 包仅 ui-renderer 一处内联） |
| `useId` | 20 | 10 | **React 18 新增**，SSR 安全 id |
| `useContext` | 4 | 1 | `createContext` 也仅 1 处 |
| 其余 8 个 hooks | **0** | 0 | 见 §一.2 |

## 四、react-dom 面

| API | 用量 | 位置 |
|---|---|---|
| `createPortal` | 13 个 import / 27 处 | 各弹层类组件通用 |
| `createRoot` / `hydrateRoot` / `flushSync` | 各 1 处 | **只在 `ui-renderer/src/client/index.ts` 的 `mountApp`**（挂载面：有 `data-dsh-boot` 标记则 `hydrateRoot` 保 SSR boot DOM，否则 `createRoot` + `flushSync` 首渲染） |
| `render`（旧 API） | 0 | |

## 五、React 顶级 API 与 JSX 语法特征

顶级 API（import 语句数）：`memo` ×17（另有 1 处 `React.memo` 命名空间写法）、`Fragment` ×10、`createElement` ×3、`StrictMode` ×2、`cloneElement` / `createContext` / `Component` / `FC` 各 ×1。**`forwardRef`、`Suspense`、`lazy` = 0。**

JSX 特征（出现次数）：`className=` ×1668、`key=` ×187、fragment 速记 `<>` ×166、`ref=` ×78、`style={{}}` ×25、`<Fragment>` ×20、`dangerouslySetInnerHTML` ×1（仅 boot handoff 一处，注入 SSR 预渲染 HTML）。

组件定义方式：`function X()` 声明 ×321（含非导出内部组件）、`export function X` ×158、`export const X = () =>` ×103、`class extends Component` ×1。导出风格以具名函数导出为主。

## 六、类型导入面（纯编译期，运行时零影响）

`ReactNode` ×68、`ComponentProps` ×12、`CSSProperties` ×11、`KeyboardEvent` ×12、`MouseEvent` ×7、`MutableRefObject`/`RefObject`/`Ref` 等。这些来自 `react` 的**类型 only** 导入，编译后消失，与选哪个运行时引擎无关。

## 七、对 compat 替换（preact/compat）的覆盖判定

| 检查项 | 结果 |
|---|---|
| hooks 9 种 | preact/compat 全部实现 ✅ |
| `memo` / `Fragment` / `createElement` / `cloneElement` / `StrictMode` | 实现 ✅ |
| `createPortal`（react-dom） | `preact/compat` 导出 ✅ |
| `createRoot` / `hydrateRoot` / `flushSync` | `preact/compat/client` ✅（ui-renderer 一处，已实测走通） |
| `useSyncExternalStore` | ✅（shim 仅 ui-renderer 一处内联） |
| class 组件 | ✅（仅 1 个 ErrorBoundary） |
| `forwardRef` / `Suspense` / `lazy` / 并发 hooks | **语料中不存在** → compat 的已知缺口不在本语料触达范围 |

> 实证对照：`apps/ui-preact` PoC 已按此清单全量挂载成功（零 pageerror / 零 console.error）。

## 八、回答速记

**「useState、useId 这些全都是 React 的，对吧？」** —— 对。全部 9 种 hooks + memo/Fragment/createPortal 等都是 React（或 react-dom）的官方 API，DSH 没有自研 hooks、没有 UI 框架包装层；它们在运行时统一经平台模块表以 `"react"` / `"react-dom"` 这些模块名解析，因此可以整体重定向到 preact/compat。
