# Web 前端空间可组合性调研

> 记录：2026-08-25 · 一手核验：MDN Web Components/Custom Elements/DSD 文档、webpack
> Module Federation 官方 docs、module-federation.io、native-federation.com、Angular DI
> 官方指南、qiankun/wujie 源码级对比（掘金 deep-dive）、htmx 官方 essays、Islands
> Architecture（Bridgetown / islands-architecture.com）。
> 本文是 `../01-cordis-runtime/cordis-research.md` 的 Web 侧对照：把 Cordis 的"时空可组合性"结论拿到浏览器端，
> 回答"HTML 前端能不能也做到模块即插即用（先只看空间维）"。

---

## 1. 一句话结论

**能，且分三层粒度，但空间维被浏览器"半完成"了：**
- **时间维（可逆效应 / 即插即拔）**——浏览器**原生已实现**：Custom Element 的
  `connectedCallback` / `disconnectedCallback` 就是一对平台级的可逆效应（插=setup，拔=teardown，
  元素移出 DOM 即触发、重新插入再触发，甚至元素 *移动* 都会重跑一遍）。
- **空间维（反应式余效应 / 依赖→激活停用）**——**只完成了一半**：
  - 「封装 + 组合」这半（Shadow DOM、`<slot>` 投影、`::part`、CSS custom properties、scoped
    registry）**原生已实现**；
  - 「依赖声明 → 自动拓扑 → 依赖齐/缺自动激活/停用」这半（Cordis 的 `inject` + `epoch`）——
    **浏览器没有原生对应，也没有哪个框架做到反应式**。最接近的是 Module Federation 的
    share scope（运行时依赖协商，但只在 bootstrap 一次性、按 semver 匹配、app 粒度、非反应式）。

**判定**：把 Cordis 的 `epoch`（依赖满足度签名 → 提供者撤走依赖者先停、回归自动恢复）搬到
浏览器，是当前 Web 生态的**真空区**。这也是"Web 版 Cordis"最值钱的研究方向。

---

## 2. 三层粒度测绘

HTML 前端的"模块"有三个正交的粒度，各有一套即插即用机制，别混为一谈：

| 粒度 | 单元 | 即插即用机制 | 代表 |
|---|---|---|---|
| **元素/组件层** | 单个自定义元素 | Custom Elements + Shadow DOM + slot + scoped registry | `<video>`、Shoelace、Lit |
| **应用层** | 独立构建/部署的前端应用 | Module Federation / single-spa / qiankun / wujie / iframe | 微前端 |
| **岛屿层** | 页面里一块独立水合的 SSR 区域 | DSD + partial hydration + `connectedCallback` | Astro、Bridgetown |

三层不是互斥，是叠加：一个微前端（应用层）内部用 Web Components（元素层）组装，页面壳用
Islands（岛屿层）做选择性水合。Cordis 的"space dimension"在浏览器里被摊到了这三层上。

---

## 3. 空间维映射（Cordis → Web 逐项对照）

Cordis 空间维 = **Reactive Coeffects**：组件声明依赖（`inject`）→ 自动拓扑编排 → 依赖齐
ACTIVE、缺 INACTIVE、提供者撤走依赖者先停、回归自动恢复。逐项找 Web 对应：

| Cordis 概念 | Web 对应 | 是否原生 | 缺口 |
|---|---|---|---|
| `Context`（运行时 proxy，属性走服务解析器） | 全局 registry / import map / Angular root injector | 部分 | 无"作用域 proxy 透明代理服务" |
| `inject`（依赖声明） | Angular 构造器注入 / React `useContext` / import specifier / MF `shared` | ✅ | 语义等价，但**绑定即终态**，不响应变化 |
| `ReflectService`（`provide`/`inject` 服务解析） | **Angular 分层注入器**（ElementInjector / EnvironmentInjector） | ✅ | 最接近的单体；但图是静态的 |
| `Service`（`super(ctx,name)` 注册 + 随 fiber 卸载自动注销） | Angular `providers:[...]` + 组件销毁→服务销毁 | ✅ | 生命周期销毁对齐；无"重新提供" |
| **`epoch`（依赖满足度签名 → 激活/停用）** | **无原生对应** | ❌ | **核心真空**（见 §5） |
| 提供者撤走→依赖者先停→回归自动恢复 | single-spa `activeWhen`（仅路由谓词）；无通用版 | ❌ | 仅路由键，非依赖键 |
| Scoped registry（作用域内定义） | **Scoped Custom Element Registries**（`CustomElementRegistry()` 构造器） | ✅（新） | 最干净的平行项，见下 |
| 上层 patch 按 id 整行替换插件 | Angular `{provide: X, useClass: Y}` provider override | ✅ | 子树级覆盖，静态声明 |

**Scoped Custom Element Registries 是最新、最干净的原生平行项**：它让一个 shadow tree 有自己
独立的元素定义表，不同子树可定义同名元素互不冲突——这正是 Cordis `Context.extend()` /
`isolate()` 作用域在 DOM 侧的镜像。2019 年前只有全局 `customElements` 单例，跨库组合必撞名；
现在作用域注册表把"组合"变成浏览器内置能力。

---

## 4. 时间维映射（可逆效应）

Cordis 时间维 = **Revertible Effects**：每次上下文修改配显式逆函数，叠成撤销链，卸载时反向
执行（LIFO）。

| Cordis | Web 对应 | 性质 |
|---|---|---|
| `Fiber.effect(execute, label)` → 收集 disposer | `connectedCallback()`（setup） | 平台级 effect |
| 卸载时 disposers **逆序 LIFO**（`splice(0).reverse()`） | `disconnectedCallback()`（teardown）+ DOM 树移除天然后序 | 平台级逆函数 |
| 元素移动重跑 | `adoptedCallback` / 移动触发重 connected/disconnected | 比 Cordis 更激进 |
| single-spa `bootstrap→mount→unmount→unload` | 微前端显式可逆效应（Promise 化） | 框架级 effect/disposer |

**判定**：时间维在浏览器是**原生完成且免费**的——浏览器自己保证 `disconnectedCallback` 在元素
离开 DOM 时被调，不管元素是被 `innerHTML` 覆盖、被别的代码 `remove()`、还是整个子树被替换。
这正是 htmx 社区那句"everything in htmx has a DOM-based lifecycle"能成立的原因。**即插即拔这个
诉求，Web 从 2018 年起就已经交付了。**

---

## 5. 关键缺口：反应式依赖激活（`epoch`）为何 Web 没有

这是全文的题眼。Cordis 空间维的皇冠是 `epoch`：每个 fiber 持有一个"依赖满足度签名"，遍历每个
`inject` 声明，任一缺失 → INACTIVE → `_unload()`；全部存在 → 激活；提供者 uid 变化 → 依赖者先
unload 再 reload。**这是运行时、持续、反应式的**。

Web 为什么没有：

1. **Web 的依赖单元是 ES module，静态、构建期解析**。`import` 绑定即终态，没有"服务"这个可以
   在运行时上线/下线的概念。Cordis 有 `Service`（注册即提供、随 fiber 卸载即注销），浏览器
   DOM 里没有等价物。
2. **仅有的运行时依赖协商是一次的**：Module Federation 的 share scope（`singleton`/`requiredVersion`/
   `strictVersion`）和 Native Federation 的 import map 都是在**宿主 bootstrap 时**合并一次、
   按 semver 匹配后固化。没有"某个 shared 依赖之后被移除 → 消费它的 remote 自动卸载"这回事。
3. **仅有的反应式激活是路由键的**：single-spa 的 `activeWhen` 谓词在路由变化时
   mount/unmount，但键是 **URL**，不是**依赖**。没有框架拿"某个服务/能力是否在线"当激活键。

**推论（非事实，标记为待证）**：要在浏览器补上 `epoch`，最小改动路径是——
- 用一个运行时"服务注册表"（service registry）+ 自定义元素上的依赖声明属性（如
  `<x-panel requires="ctx.llm ctx.tools">`），
- 服务上线/下线时触发一次拓扑重算，把依赖缺失的元素 `disconnectedCallback` 掉、依赖回归时重新
  `connectedCallback`。
- 这套东西用原生 Custom Elements 生命周期 + Scoped Registry + 一个 observer 就能搭出来，不需要
  改浏览器。**换句话说：Cordis 的空间维，浏览器已经备齐了所有原料（时间维免费的、组合原生的），
  只差"谁把依赖图接上生命周期"这一小段胶水。** 这就是"Web 版 Cordis"的定义。

---

## 6. 竞品矩阵（空间可组合性维度）

按"同时具备 时间维可逆 + 空间维封装 + 空间维反应式依赖"三维打分：

| 方案 | 语言 | 时间维（可逆） | 空间维·封装组合 | 空间维·反应式依赖 | 免重启装卸 |
|---|---|---|---|---|---|
| **Custom Elements + Shadow DOM**（原生） | JS | ✅ connected/disconnected | ✅ slot/::part/scoped registry | ❌ | ✅ |
| **Angular 分层 DI** | TS | ✅ ngOnDestroy/scope teardown | 部分（组件树） | ❌（静态图） | 部分 |
| **single-spa** | JS | ✅ mount/unmount | ❌（靠 iframe/WC 补） | ⚠️ 仅路由键 activeWhen | ✅ |
| **Module Federation**（1.0/2.0） | JS | ❌（无卸载语义） | ❌ | ⚠️ share scope 一次性协商 | ❌ |
| **Native Federation**（import map + ESM） | JS | ❌ | ❌ | ⚠️ externals registry 一次性去重 | ❌ |
| **qiankun**（single-spa + Proxy 沙箱） | JS | ✅ 继承 single-spa | ✅ Shadow/scoped CSS | ❌ | ✅ |
| **wujie**（iframe + Web Components + Proxy） | JS | ✅ | ✅ 原生 iframe 隔离 | ❌ | ✅（保活） |
| **Astro / Bridgetown Islands** | JS/Ruby | ✅ island 独立水合 | ✅ DSD 封装 | ❌ | ✅ |
| **htmx + Web Components** | JS/HTML | ✅ DOM 生命周期 | ✅（可选 shadow） | ❌ | ✅ |
| **Cordis**（参照系） | TS | ✅ `effect` LIFO | ✅ `inject`+scoped ctx | ✅ **`epoch` 反应式** | ✅ |

**判定**：Web 生态在"时间维 + 空间维·封装"两项上完全覆盖 Cordis（且时间维还是原生免费的）；
**全表唯一没有的，就是空间维·反应式依赖这一列**。整张表就 Cordis 一个 ✅。这就是差距，也是
"HTML 前端即插即用"这问题最诚实的答案：**即插即用（时间维）早就有了；依赖驱动的即插即用
（空间维）没有，且是所有主流前端框架共同的盲区。**

---

## 7. 微前端沙箱的附带发现（与 Cordis 异构桥呼应）

`../01-cordis-runtime/cordis-research.md` §5 的结论是"跨语言 = 进程边界 + IPC 桥"。微前端沙箱是同一思想的 DOM 侧翻版：

- **qiankun 3.0**：`Proxy` + `with` + `Compartment` 三层模拟一个假 window（`Membrane` 拦截
  get/set、`rebindTarget2Fn` 重绑 native 函数防 `Illegal invocation`、patch `addEventListener`/
  `setInterval` 以便卸载时清理）。
- **wujie**：**隐藏 iframe 提供真实独立 window/document/history/location**（原生隔离），DOM 操作
  经 Proxy 代理到 Shadow DOM。**这是"用原生沙箱（iframe）当隔离边界 + Proxy 当桥"**——与 Cordis
  "Python 子进程 + fd3 帧协议"是同构的：**隔离靠真边界，桥接靠显式协议，消费者无感。**

对应关系：Cordis 的 `ctx.codeRuntime`（Python 子进程 + fd3）↔ 微前端的 iframe（子应用 window）
+ Proxy（DOM 桥）。都在说同一件事：**真隔离必须用运行时原生边界，桥是净新增的显式工作**。

---

## 8. 落到 dsh 的意义（为何这个调研现在做）

dsh 是 Web-first（`../01-cordis-runtime/cordis-research.md` 提过其 Web 表面像 DeepSeek 官方 chat 页，append-only
session log、trajectory view）。它的插件在 **Cordis 层**已实现时空可组合性，但它的**前端表面
**目前仍是单体页面（React/自研栈），插件对 UI 的贡献是硬编码的。

若要让 dsh 的"everything is plugin"穿透到 UI 层——即**插件自带前端面板、即插即用**——现成的三
条路：
1. **Web Components**：插件暴露 `<dsh-*>` 自定义元素，走原生 slot/::part 组合（元素层，最小侵入）。
2. **Islands**：SSR 壳 + 插件面板作为可选择性水合岛屿（岛屿层）。
3. **微前端**：重型插件独立构建，Module Federation / Native Federation 运行时装载（应用层）。

**判定**：元素层（Web Components）+ 岛屿层已能覆盖绝大多数插件 UI 诉求，且与 Cordis 的"最小
侵入、零特权核心"哲学一致——插件注册一个自定义元素就像注册一个 Cordis Service。真正的难点
仍在 §5：**若插件 UI 依赖某服务（如 `ctx.llm` 未配）而该服务下线，UI 面板要不要自动灰掉/卸载？
** 答案是当前 Web 生态做不到反应式，除非自建 §5 的"服务注册表 + 依赖声明 + observer"胶水。
这恰好是 Cordis 已有、而前端缺失的那一块。

---

## 来源

- MDN：`Using custom elements`（含 Scoped Custom Element Registries、`:state()`、`::part`）、
  `Web Components`、`Using templates and slots`、`Declarative Shadow DOM`（web.dev）
- webpack：`Module Federation` concepts（Container/ContainerReference、shared scope、singleton）
- module-federation.io（MF 2.0：Manifest / Federation Runtime / Runtime Plugin System）
- native-federation.com：`Runtime`（import map + externals registry 去重）、`Mental Model`、
  `Architecture`（Core/Adapter/Runtime/Orchestrator 四层）
- single-spa：`bootstrap/mount/unmount/unload` 生命周期 + `activeWhen` 路由谓词
- qiankun（umijs/qiankun 3.0）：Membrane/Compartment/Patchers 沙箱、strictStyleIsolation
- wujie（Tencent/wujie）：iframe 原生隔离 + Web Components + Proxy 双容器架构
- Angular：`Hierarchical injectors`、`Defining dependency providers`（ElementInjector /
  EnvironmentInjector / provider override / lazy-module injector / teardown）
- htmx：`Web Components Work Great with htmx`、`htmx.process(shadowRoot)`、shadow DOM host selector
- Islands：islands-architecture.com（Katie Sylor-Miller / Jason Miller）、Bridgetown DSD/Islands、
  Codrops `Server-first Web Components with DSD, HTMX, and Islands`
- 掘金《Qiankun vs Wujie：微前端框架深度对比》（沙箱/隔离/插件系统源码级矩阵）
