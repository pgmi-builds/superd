# Bun 编译自包含二进制 × Cordis 运行时自举 — Feasibility 研究

> 记录：2026-09-03 · 一手核验：upstream checkout `dsh-v0.1.2-alpha.5` vendored loader/include/hmr 源码 +
> `packages/boot/app-boot` 源码 + Bun 官方 executables 文档（2026-09 抓取）+ oven-sh/bun#11732（API 实查
> state=open）+ vercel/turborepo#11900 patch（2026-02 合并的生产级修复）+ azu/bun-build-dynamic-import repro。
> 本文是 [cordis-research.md](./cordis-research.md) §4.2 的深化：那一节给了"可行但有工程成本"的一行结论，
> 本文把"成本"拆到确切的机制、确切的失败面、和确切的缓解配方。

**范围声明（owner 已裁决，不再争论）**：node-pty 等 native addon 对 Bun 预编译的不兼容是已知项，开发具体
工具时 exclude 或换 `Bun.Terminal`，本文不展开（见 cordis-research.md §4.2 的政策）。本文只回答一个问题：
**Cordis 的运行时自举——扫配置、解析包名、动态 import 插件——在 `bun build --compile` 的自包含二进制里
会发生什么，能不能救，怎么救。**
>
**修订 v5（2026-09-05/06，PoC V3 全核验收）**：§7.5 记录 bun-compiled dsh 全核本地+ctr-1 双绿、
npm better-dsh 0.2.2-b 动态装载、新硬事实 B14–B23。

> **修订 v2（2026-09-03 同日，owner 边界重述）**：划分线不是"第一方/第三方插件"，而是 **Bun 预编译界**——
> 编译期可枚举集（含 vendored 第三方，不问出身）vs 编译后运行时动态集。据此新增方案 E（Bun 静态核 +
> Node sidecar 双运行时）、§2 B10–B12（OpenClaw / better-sqlite3 / execa 行为级 divergence 实证）。
>
> **修订 v3（2026-09-04，实测补充）**：新增 §7"纯静态 Cordis 项目的 Bun 直构验证"——合成 PoC 五面全绿，
> Orchestra a2a daemon 真实目标零改动直构冒烟通过（43 模块 181ms → 79MB 单文件，MCP ping 活体回包）。
>
> **修订 v4（2026-09-04，PoC V2）**：新增 §7.4"运行时热加载 JS-only 插件"——同一样本（Orchestra 副本）
> 预编译剔除 provider-pi-agent、运行后 drop 回扫描路径、rescan 加载注册，全序列实测通过；过程中撞出
> 新硬事实 **B13**（编译产物内磁盘模块的裸包名 import 完全不沿 node_modules 上溯），最终配方 = 运行时
> `Bun.build` + walker（Turborepo #11900 同款）。
> 立即可落地。产物与日志：`.scratch/bun-poc/`。
---

## 0. 结论速览

**Feasible，但"纯自包含单文件"和"保留全部运行时模块动态性"二者不可兼得——这不是 Bun 的 bug，是 bundler
与 plugin-host 的本质张力（Deno/esbuild/webpack 同款）。正确的目标形态是"编译核心 + 分层插件解析策略"：**

- **编译期已知集 → 构建期冻结**（codegen 静态注册表，全部 bundle 进二进制，字面量动态 import 保懒加载）。
  "已知集"不问作者出身：第一方插件、工具自有组件、vendored 依赖、依赖树里的第三方包——凡 build 时已在
  模块图内者皆是。Cordis 的动态性分两层：**配置树动态性**（yml 行的 insert/patch/config/inject/disabled，
  运行时解释，完全保留）与**模块集动态性**（import 哪个包，冻结侧冻结）。这条边界同时是 **shim 可行性
  的边界**：已知集内任何 Bun 不兼容都是 build-time 工程项（alias/shim/exclude，图在我们手里）；无界集内
  没有收敛解。对工具发行，冻结核恰是 reproducibility 收益。
- **运行时动态集（编译后才到达的插件，天然 TS/Node 形态）→ 承接路线三条**：B（Bun 运行时内磁盘解析 +
  walker patch，Turborepo 生产配方）、E（Node sidecar 真实运行时承接，§4-E）、C（runtime bundling
  桥接）。用户侧只解包不做版本解析的原则不变。
  "closed packaged runtimes" 概念、"Built bins need the Loader's native helper for bare plugin
  specifiers" 的自述——upstream 作者已经在想打包形态，且所有动态 import 收敛在**我们自己 vendor 的两个
  choke point** 上，不是黑盒。
- 真正阴险的不是"找不到包"（fail-loud，好修），而是**双实例身份问题**（磁盘插件 import `@deepseek-ai/*`
  解析到磁盘副本 → 两个 cordis/Fiber 并存）。有解（external 共享树 / virtual namespace 桥接），但必须作为
  build 纪律 + boot 时断言来执行。

---

## 1. "自举"到底指什么 — Cordis 运行时加载面盘点（源码级）

把"运行时扫描 + 动态 import"拆成六个具体机制，每个的 bundle 敏感性完全不同：

### 1.1 Boot 链与 baseUrl 锚定

```
bin.js（薄壳）→ boot() 【packages/boot/app-boot/src/index.ts:777】
  ├─ new Context()                        # 框架基底
  ├─ await ctx.plugin(Loader)             # vendored loader 挂载
  ├─ ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'   # index.ts:784
  └─ mountRootInclude(ctx, configPath, patches, bareModuleBaseUrl)         # index.ts:789
```

`baseUrl` = **配置文件所在目录**（profile 目录）。相对路径插件条目（`./foo`）以它为锚 → 这是纯磁盘锚定，
编译二进制下 fs 照常工作，**不受影响**。

### 1.2 `tree.import` — 所有插件模块 import 的收敛点

`vendor/loader/src/config/tree.ts:145`，三分支：

```ts
import(name) {
  if (name.startsWith('cordis:')) {
    return this.ctx.loader.builtins[name.slice(7)]        // ① 内存表，零 fs
  }
  if (this.ctx.loader.internal) {
    return await this.ctx.loader.internal.import(name, this.ctx.baseUrl!, {})  // ② Node 内部 loader
  } else if (name.startsWith('.')) {
    return await import(new URL(name, this.ctx.baseUrl).href)                 // ③a 相对 → 绝对 file URL
  } else {
    return await import(name)                                                  // ③b 裸包名，不可分析
  }
}
```

- **① `cordis:` builtins**（include/group 等）：静态注册的内存表，bundle 安全 ✅
- **② Node internals 深集成**（见 1.3）：Bun 下拿不到 → 走兜底，**graceful 降级 ✅**
- **③a 相对名**：先展开成绝对 file URL 再 import → 磁盘锚定，Bun 运行时可 import 磁盘 JS/TS ✅
- **③b 裸包名**：`await import(name)`，specifier 来自 yml/patch 行，**完全不可静态分析** ⚠️ —— 用户说的
  "最要命"就是这一行（以及 1.4 的同款）

### 1.3 Node internals 深集成（loader 的 `internal`）与 HMR

`vendor/loader/src/internal.ts` 的 `ModuleLoader.fromInternal()`：

- 门槛：`process.versions.node` major ≥ 22，且要拿到 `internal/modules/esm/loader` 的
  `getOrInitializeCascadedLoader()` —— 靠 `--expose-internals` execArgv **或**
  `require('node-addon-require-builtin')`（一个 native addon）。
- 拿不到 → `fromInternal()` 返回 `undefined` → loader 全链走 ③ 兜底。**这是文档化的降级路径，不是崩**。
- 唯一硬依赖者是 HMR（`vendor/hmr/src/index.ts:121`：`--expose-internals is required for HMR service`，
  它直接操作 Node 内部 ESM `loadCache` 做模块驱逐）。**HMR 是 dev-only 面，dev 线继续用 Node 跑即可**；
  编译二进制（本来就是 ship 形态）丢 HMR 无损。

### 1.4 `mountRootInclude` 的裸包名 seam —— upstream 已经在为打包形态留口

`packages/boot/app-boot/src/index.ts:501-518`：当传了 `bareModuleBaseUrl`，root include 换成
`HostResolvedRootInclude`，把裸包名的解析基点从"配置工程"改指"**installed-host base**"：

```ts
if (internal === undefined) return super.import(specifier, getOuterStack)
return internal.import(specifier, bareModuleBaseUrl, {})
```

docstring（index.ts:745-757）原文值得照抄，因为它证明 upstream 对本研究的主题已有预设计：

> bare package names resolve there by default or against an explicit `bareModuleBaseUrl` **for closed
> packaged runtimes** … use it when the host, rather than the configuration project, **owns the complete
> plugin set**. … Built bins **need the Loader's native helper for bare plugin specifiers**; relative
> specifiers do not. … The package build **embeds Include while leaving Loader external**, so the built
> include tree and host **share one Loader peer**.

三句话三个信号：(a) "闭包打包运行时"已是设计词汇；(b) built bin + 裸包名 = 已知难点，当前答案是 Node
native helper（Bun 下没有 → 正是我们要替换的 seam）；(c) 构建已经用 "external peer 保单实例" 的纪律
（Include 内嵌、Loader 留 external 共享）——**双实例问题不是新问题，是这个纪律的推广**。

### 1.5 配置层的其余机制（全部 bundle 友好）

- `!!js` 表达式 = `new Function('ctx','expr',…)`（`vendor/loader/src/config/utils.ts:5`），纯 JS，无
  `node:vm`，Bun 支持 ✅
- YAML/patch 行读写 = fs + yaml，`--dump-config` 预览同理 ✅
- profile 目录 = `package.json`（out-of-tree 插件 deps + `dsh.profile.bundles` 列序）+
  `cordis.patch.yml` + pnpm `node_modules`（`packages/boot/app-boot/src/profile.ts:5-19`）——纯磁盘数据
  结构，二进制照读 ✅

### 1.6 盘点结论

**"Cordis 会运行时自举"作为 barrier，其实精确化为两个 choke point 上的裸包名动态 import**：
`Tree.import` ③b 和 `HostResolvedRootInclude` 的裸名分支。两者都在我们自己 vendor/维护的代码里
（vendor/loader + app-boot），可patch面极小。其余自举面（builtins、相对路径、yml/patch/!!js、baseUrl）
在编译二进制下要么天然安全，要么走文档化降级。**barrier 真实存在，但它是"两个函数的裸包名分支"，不是
"框架级黑盒"。**

---

## 2. Bun `--compile` 的模块解析事实（2026-09 现状）

全部带来源；这些是本研究的硬地基：

| # | 事实 | 来源 |
|---|---|---|
| B1 | 编译产物 = 全部被 import 的模块（含字面量动态 import，配 `--splitting` 保懒加载 chunk）+ **完整 Bun 运行时**；built-in Bun/Node API 全支持 | [Bun executables docs](https://bun.sh/docs/bundler/executables)（splitting 示例本身就是 `await import("./lazy.ts")` 编译后免磁盘可用） |
| B2 | **非可分析动态 import 的裸包名**：运行时从导入者的虚拟位置 `/$bunfs/root/…` 向上找 node_modules → 必败：`Cannot find package "rambda" from "/$bunfs/root/bun-example"`（`import.meta.resolve` 同败） | [azu/bun-build-dynamic-import](https://github.com/azu/bun-build-dynamic-import) repro |
| B3 | 请求"用 flag 收编非可分析动态 import"的 issue **至今 open**（enhancement/bundler，7 评论，2024-06 开，2025-11 仍有活动，无里程碑）；Deno 同问题已用 `--include <path>` 解决 | [oven-sh/bun#11732](https://github.com/oven-sh/bun/issues/11732) |
| B4 | 编译产物内 `createRequire().resolve()` **不可靠**（不沿 node_modules 祖先上溯）→ 生产级 workaround = 手写 node_modules 目录 walker，把**绝对路径**喂回去，Node builtin 标 `external: true` | [vercel/turborepo#11900](https://github.com/vercel/turborepo/pull/11900)（fix #11882，2026-02） |
| B5 | 相对路径若不在 bundle 内 → **从进程 cwd 读磁盘**，不存在则报错（Worker/SQLite 章节明示 cwd 锚定语义） | [Bun executables docs](https://bun.sh/docs/bundler/executables) |
| B6 | 内嵌运行时是完整的：编译产物可 `BUN_BE_BUN=1` 直接当 **bun CLI** 用（install/run/打包），即二进制自带转译器与包管理器——**用户侧可以完全不装 Node/pnpm** | 同上（v1.2.16+） |
| B7 | `Bun.build` 在编译产物内可用 → **运行时打包**模式成立：Turborepo 在编译产物里对用户磁盘上的 TS 配置现场 `Bun.build`，并用 onResolve/onLoad **virtual namespace 把二进制内置模块桥接给用户代码**（`BINARY_MODULES`），node builtin 走 external | [vercel/turborepo#11900](https://github.com/vercel/turborepo/pull/11900) |
| B8 | `--asset ./dir` 可整树内嵌，运行时经 `import.meta.dir`（虚拟根 `/$bunfs`）+ `node:fs`（readdirSync 等）可达；`with {type:"file"}` 内嵌文件同理；`Bun.isStandaloneExecutable` 可探测编译态；bytecode/sourcemap/minify/交叉编译齐备；`--compile` 不支持 `--outdir/--public-path/--no-bundle` | 同上 |
| B9 | `.env`/`bunfig.toml` 运行时自动加载（默认开），tsconfig/package.json 默认不加载（可开） | 同上 |
| B10 | **行为级 divergence（隐性、不可枚举）**：Bun 的 spawn 会消费 `encoding` 选项 → execa 的 `encoding:"buffer"` 组合直接抛 `ERR_UNKNOWN_ENCODING`（stable 1.3.14 仍复现）；`bun install` 解不了 pnpm workspace 布局。这类不兼容**踩到才知道**，无静态清单可穷举 | [openclaw#114256](https://github.com/openclaw/openclaw/pull/114256)（2026-07 merged）引 [oven-sh/bun#36049](https://github.com/oven-sh/bun/issues/36049) |
| B11 | `node:sqlite`：Bun ≤1.3.x **不提供**；1.4.0 canary（**Rust 重写线**）起提供（`DatabaseSync` 实测可用）。388k★ 的 OpenClaw 接法 = `process.getBuiltinModule('node:sqlite')` **feature-probe，不做品牌/版本门** | [openclaw#114256](https://github.com/openclaw/openclaw/pull/114256) |
| B12 | `better-sqlite3`：可跑但**需重编译**；且有真实 N-API crash 服务启动失败案例，社区以 `bun:sqlite` 规避——native addon 在 Bun 下的"能用"是逐版本、逐包的灰色地带 | [oven-sh/bun#16050](https://github.com/oven-sh/bun/issues/16050)、[opencode-telegram-bridge#34](https://github.com/gabriel-trigo/opencode-telegram-bridge/issues/34)、[OmniRoute#11468](https://github.com/diegosouzapw/OmniRoute/pull/11468) |
推论：**Bun 编译世界的模块解析 = "bundle 内虚拟根（`/$bunfs`）+ 磁盘（绝对路径/cwd 相对）"两界**。裸包名
只在磁盘界有 node_modules 语义，而 bundled 模块住在虚拟界 → B2 必败。这就是 1.2 ③b 在编译产物下的死因。

---

## 3. 冲突矩阵：Cordis 自举面 × Bun compile

| Cordis 机制（§1） | Node 语义 | Bun compile 语义 | 差距判定 |
|---|---|---|---|
| `cordis:` builtins（include/group） | 内存表 | bundle 内 ✅ | 无 |
| 相对名插件（`./x` → baseUrl 绝对 URL） | 磁盘 import | 磁盘 import（运行时转译 TS 可用，B1/B6/B7） | 无 |
| **裸包名（`Tree.import` ③b / `HostResolvedRootInclude`）** | node_modules 分层上溯（①→④ 层） | **B2 必败**（虚拟根无 node_modules）；`createRequire` 也不可靠（B4） | **核心差距，§4-B patch** |
| `internal`（Node cascaded loader） | 经 native addon/`--expose-internals` 取 internals | 取不到 → `fromInternal()`=undefined → **文档化降级**到兜底 import | 无阻断（丢深集成） |
| HMR（loadCache 驱逐） | 硬依赖 internals | 直接抛 `--expose-internals is required` | **放弃于编译形态**；dev 线保留 Node |
| `!!js` / yml / patch 行 / `--dump-config` | new Function + fs + yaml | 同左，全支持 | 无 |
| profile 目录（package.json/bundles/pnpm 树） | 磁盘数据结构 | 磁盘照读（B5/B9） | 无 |
| **磁盘插件 runtime-import `@deepseek-ai/*` peers**（14/14 实证，见 AGENTS.md §一） | host ②③ 层单一物理副本 → 单实例 | 解析到磁盘副本或失败 → **双实例/断裂风险** | **§5 专节，比 B2 阴险** |
| `dsh plugin add` → pnpm 子进程 | 用户侧需 Node+pnpm | 可改 `BUN_BE_BUN=1` 自身当包管理器（B6） | 运营面机会（§6） |

---

## 4. 缓解方案空间（按"自包含性 × 动态性"光谱）

### 方案 A：Frozen composition — 构建期 codegen 静态插件注册表（编译期已知集）

- **机制**：构建期枚举已知集（第一方 bundle `dsh-base`/`dsh-web-app`、工具自有组件、vendored 与依赖树第三方——凡 build 时在图内者，不问出身），生成
  `plugins.generated.ts`：`{ 'dsh-base': () => import('<literal path>'), … }`（**字面量** → 可分析 →
  被 bundle，`--splitting` 下每个插件是懒加载 chunk，B1）。patch `Tree.import`/root include：
  **registry-first，磁盘-fallback**。二进制内建 `Loader` 身份天然单实例（bundler 去重）。
- **得到**：真·单文件；启动即 fail-loud 审计（`assertEntriesLoaded`）语义不变；`cordis.patch.yml` 整条
  patch 线**原样可用**——patch 是配置层，id 覆盖/config/inject/`!!js` 全在运行时解释。Cordis 面向用户的
  组合动态性（配置树）一点没冻。
- **失去**：二进制内置插件不可热插拔（本来就无此需求）；内置集升级 = 重新发二进制（对工具发行恰是
  reproducibility 收益）。
- **成本**：codegen 脚本 + loader 一处 patch（registry 查询优先）。低。

### 方案 B：Hybrid closed runtime — 二进制核 + 磁盘 profile 树（第三方插件）

- **机制**：二进制 = Bun 运行时 + harness 核 + vendored loader；`$DSH_HOME/profiles/<name>/` 磁盘树照旧
  （package.json + node_modules）。**裸包名 patch**（在 `HostResolvedRootInclude.import` 的
  `internal === undefined` 分支 + `Tree.import` ③b）：手写 node_modules walker（从 `baseUrl` /
  `bareModuleBaseUrl` 指向的 profile 目录上溯）→ 得绝对路径 → `pathToFileURL().href` → `import()`。
  这就是 Turborepo #11900 的生产配方（B4），一行不差地适用：他们的场景（编译产物加载用户磁盘配置、配置
  import npm 包）与 Cordis loader 加载磁盘插件**同构**。
- **得到**：第三方插件生态全保留——用户 `dsh plugin add X` 装进 profile 目录，重启即挂载；相对名/裸名/
  `cordis:` 全通。**用户侧无版本解析**：发布物是"预解析好的树"（CI 里 pnpm 已经算完 lockfile），或运行时
  `BUN_BE_BUN=1` 自装（B6）。
- **失去**：不再是单文件（二进制 + DSH_HOME 树）——但"避免用户侧 Node 依赖/版本解析"的原始动机完整保住。
- **成本**：walker patch（~50 行，Turborepo patch 可参考）+ 解析锚点测试。中低。

### 方案 C：Runtime bundling — Turborepo 全套（virtual namespace 桥接，B 方案进阶）

- **机制**（B7）：磁盘插件不直接 `import()`，而是现场 `Bun.build`：onResolve 对裸包名先查磁盘 walker；
  查不到再查 `BINARY_MODULES`（二进制内嵌的 `@deepseek-ai/*` 等 host 包）→ 转向 virtual namespace，
  onLoad 把内嵌模块**桥接**给插件代码。
- **得到**：磁盘插件可以直接 import host 包且**单实例**（§5 的最优解）；比 B 多了对外部插件的完整身份控制。
- **失去**：桥接层是自维护面（CJS/ESM 边界、export 形状、加载延迟）；复杂度显著高于 B。
- **定位**：B 跑通后的按需升级，不是首选项。

### 方案 D：等上游 — `--include` flag（#11732）/ Deno 式收编

Deno 用 `--include` 解决了同构问题，Bun issue 两岁半仍 open（B3）。**不作为路径，只作观察项**：一旦落地，
A 的 codegen 可换成声明式 `--include` 清单，B 的磁盘集也可预收编。

### 方案 E：Node sidecar — Bun 静态核 + IPC + 真 Node 运行时承接动态面（owner 提案，v2 新增）

- **动机**：动态集的无界性使"Bun 运行时内兼容一切 Node 插件"不收敛——B10 类**行为级 divergence**（连
  `child_process` 的 option 组合都能翻车）没有静态清单可穷举，只有踩到才知道。唯一"完全兼容 Node 生态"
  的东西是 Node 本身 → 动态面整体路由给真实 Node sidecar，Bun 侧只保静态核。
- **先例校准（没有听起来那么"没人做过"）**：家族先例 = VS Code Extension Host（主进程 + 扩展宿主进程 +
  RPC 化 API 面）、Claude Code（bun 单文件 + MCP 子进程生态——动态面全在 bun 体外跑，即 E-seam 形态的
  大规模存在证明）、dsh 自己的 fd3 code-runtime（cordis-research.md §5 桥表）。**真正没人 ship 过的只有
  一块：跨进程 Cordis context bridge**（inject-epoch 反应式、fiber disposal 传播、事件全序跨边界）——
  cordis-research.md §7.2(b) 已判"研究级、非免费午餐"。
- **三个子形态，成本差一个量级**：
  - **E-seam**：动态组件经工具面接入（MCP/ACP/subprocess 工具），不进 context graph。现有原语直接可用，
    成本≈0；代价是动态组件不是"Cordis 公民"（无 inject/services/events）。
  - **E-subtree**：动态插件挂 Node 侧真实 cordis+loader（磁盘树），整组作为一个 remote group 桥回核心
    图；服务/事件在**组边界**显式代理。桥面收窄为接口清单，工程可控——"野心方案"的可交付版本。
  - **E-full**：双 context 全语义融合（任意插件可挂任意侧、inject 跨边界反应）。研究级，月级成本，不建议
    作首发目标。
- **架构红利**：双实例问题被**驯化**——两个 context 是设计而非事故（§5 身份风险在边界上显式化）；
  sidecar 用磁盘树真 cordis，身份天然一致。
- **成本/风险**：IPC 管道不贵（dsh 有 sdk-jsonrpc/acp/fd3 库存），贵在 Cordis 语义保真（E-full 的
  inject-epoch 跨边界）；artifact 变"Bun 核 + pinned node + 插件树"（约两份运行时体积）；**若多数用户
  最终都要 sidecar，Bun 简洁性论证反转**——这是必须用真实插件集先测的决策变量；另 Bun 1.4 起 runtime
  本身在 Rust 重写线上（B11），把 C 类深度桥接押在其上要计入成熟度风险。
- **Node 从哪来**：随包 pinned node（免用户安装与版本解析，原始动机保全）或 tiered——默认单文件，检测到
  动态插件需求才要求/下载 sidecar。

### 推荐（v2）：**B 与 E 是升级关系，不是二选一**

loader 做**双运行时路由**——patch 行声明（或 probe）`runtime: bun|node`：纯 JS/TS 动态插件在 Bun 运行时
内直接跑（B 的 walker patch 覆盖大多数）；带 native / 踩 B10 类雷的插件路由到 Node sidecar（E-subtree
起步）。无动态插件 = 单文件（tiered）。路由判定用 OpenClaw 验证过的 **feature-probe** 模式
（`process.getBuiltinModule` / 试载探测），不做品牌/版本门。C（runtime bundling 桥接）降级为 B 的可选
增强；D（#11732）保持观察。

---

## 5. 双实例身份问题（比"找不到包"更阴险，单独一节）

**现象**：磁盘插件（B/C 世界）运行时 `import '@deepseek-ai/cordis'`（better-dsh 实证 14 个 host 包是
**运行期 import**，非 type-only，见 AGENTS.md §一）。Node 部署下 ②③ 层的单一物理副本保证插件与 host 拿到
**同一个模块实例**。编译世界里 host 的副本在 `/$bunfs` 内，磁盘插件的解析只能落在磁盘 → 两个 cordis 并存。

**为什么致命**：cordis 的 `RegistryService` 按 callback 身份键控、`ReflectService` 沿 fiber 祖先解析、
`ctx` proxy 与 `instanceof`/`symbols.isolate` 边界判定全部依赖**跨模块单实例**。双实例不一定立刻崩——
更坏：半工作状态（事件两套、fiber 图断裂、卸载链丢失），恰好踩中 cordis-research.md §2 "两份 cordis 身份
风险" 的老坑。

**解法（按纪律强度排序）**：

1. **external 共享树**（B 的正统解）：身份关键包（`@deepseek-ai/cordis`、vendored loader、
   `cosmokit`、`schemastery`）在二进制 build 里标 **`--external`**，运行时从磁盘共享树加载——host 与磁盘
   插件解析到同一物理副本。app-boot 已有同构先例："embeds Include while **leaving Loader external**, so
   the built include tree and host **share one Loader peer**"（§1.4 引文）——把这个纪律从"Loader 一个包"
   推广到"身份关键包清单"即可。代价：这批包必须随 DSH_HOME 树一起 ship（树本来就要 ship，边际成本≈0）。
2. **virtual namespace 桥接**（C）：二进制内嵌包经 runtime bundling 桥给插件，单实例由 build plugin 保证。
3. **boot 断言**（无论选哪条）：启动时 probe 单实例（如 `ctx.loader` 与插件侧 `import` 得到的
   `Loader`/`Context` 同源），fail-loud 拒绝双实例启动——把隐性半工作态变成显性启动错误，符合 dsh 的
   fail-loud 哲学。
4. **方案 E 的驯化红利**：若动态面走 Node sidecar，Node 侧用磁盘树里的真 cordis——双 context 是显式设计
   而非事故，身份一致性在边界两侧各自成立；本节三条纪律只适用于"Bun 进程内同时存在双侧副本"的 B/C 世界。
---

## 6. 运营面（简述）

- **用户安装面**：单文件（A）或"二进制+解包树"（B），均无 Node 版本协商、无 pnpm hoisting 分层、无
  用户侧供应链年龄门（`minimumReleaseAge` 是用户 install 相位的 pnpm 策略——版本解析已在 CI 完成即消解）。
  这正对 AGENTS.md 里记录的 0.2.2 发布日 install 被拦一类运营痛点。
- **`dsh plugin add`**：现走 pnpm 子进程（AGENTS.md §一）。Bun 世界两条路：`BUN_BE_BUN=1 ./dsh install`
  （B6，二进制自身即包管理器，用户零依赖）或继续要求 pnpm（锁 pnpm 生态语义：年龄门、hoisted 模型）。
  注意 bun install ≠ pnpm（lockfile/hoist/策略引擎均不同）——切换是生态决策不是纯技术决策，**列为开放
  问题**。
- **dev/test 线不变**：4999 源码级实例、HMR、`--expose-internals` 全部留在 Node 轨道（§1.3）；编译形态只
  是 ship 面的新成员。两轨道同源（cordis-research.md §4.2 的"195 包照旧 tsdown 构建，只在装配层用 Bun"）。

---

## 7. 纯静态 Cordis 项目的 Bun 直构验证（v3，立即可落地的 takeaway）

> 前提收窄（owner 裁决）：不考虑运行时动态扫描/动态加载插件（那是以后的事），不考虑 node-pty/
> node-sqlite 等底层兼容。问题收窄为：**纯基于 Cordis 原生 TS 框架开发的项目——插件全部编译期已知，
> 按闭包/静态打包——能否直接 `bun build --compile`？** 答案：**能，本机已实测通过**。适用对象：自写
> 小工具/App、DSH 类发行版、自定义插件打包、Orchestra 式常驻 A2A MCP 服务。

### 7.1 合成 PoC（`.scratch/bun-poc/`，可复跑）

- **布局**：vendored `cordis@4.0.2` / `cordis-plugin-loader@1.0.3` / `cordis-plugin-include` 全部经
  `@deepseek-ai/*/src/*.ts` **TS 源码直构**（PoC 的 node_modules symlink 指向 checkout `vendor/*`，
  per-package 依赖经 pnpm realpath 链自动解析）；入口 = app-boot `mountRootInclude` 的最小复刻
  （`new Context()` → `ctx.plugin(Loader)` → `builtins.include = Include` → `loader.create({id:'include',
  name:'cordis:include', config:{path: cordis.yml}})`）。
- **构建**：`bun build --compile --minify --sourcemap entry.ts --outfile poc` → 25 模块 / 133ms / 79MB
  （Bun 1.4.0 = Rust 重写线，Node compat v26.3.0；bun 安装于 `.scratch/bun-install/`）。
- **五面探针全绿**：
  ① 磁盘配置树运行时读取（`config/cordis.yml` 不进 bundle，改 yml 免重编）；
  ② `!!js` 表达式运行时求值 + env 穿透（`greeting = !!js '"js-expr-ok:" + (process.env.POC_USER ?? "anon")`
     → `POC_USER=alice` 时 echo 返回 `js-expr-ok:alice: hi`，实测）；
  ③ **磁盘 TS 插件现场转译加载**（loader ③a 兜底分支：相对名 → baseUrl 绝对 file URL → 编译产物内嵌
     Bun 运行时 on-the-fly transpile——"自举"的相对路径半边在编译世界原生可用）；
  ④ 编译期已知插件 static import 进 bundle（单实例）；
  ⑤ 常驻 HTTP daemon（`node:http`），冷启动到首个响应 ~250–270ms；
  另：`loader.internal=fallback` 实证——Node internals 深集成在 Bun 下走文档化降级，不崩（§1.3 预测兑现）。
- **两个 gotcha（均 fail-loud，不阴险）**：
  a. `--bytecode` 与入口 top-level await 不兼容（build 期 `Unexpected .` parse error）——入口包 async
     main() 或弃 bytecode；
  b. 相对路径插件名锚在 **config 目录（baseUrl）**，不是二进制 cwd——PoC 首跑即栽在此（`./plugins/x`
     被解析成 `config/plugins/x`），但报错是标准磁盘语义（`Cannot find module '<绝对路径>' imported from
     /$bunfs/root/poc`），排查零困难。

### 7.2 真实目标：Orchestra a2a daemon 直构冒烟（零源码改动）

```bash
cd /home/u1/workspaces/orchestra/src/packages/app
bun build --compile --minify --sourcemap src/bin.ts --outfile <scratch>/orchestra
# 43 modules · 181ms compile · 79MB
A2A_PORT=4210 ./orchestra
# cordis-orchestra A2A daemon listening on http://0.0.0.0:4210
#   runtimes: hermes-default, …, antigravity（10/10 注册）
#   agents:   pc-hermes-default, …, pc-antigravity（9/9 预注册）
#   tools: a2a_agents | a2a_session_state | a2a_send | a2a_read | a2a_close
curl -X POST :4210/ -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'   # → {"jsonrpc":"2.0","id":1,"result":{}}
```

- Orchestra 正属"编译期已知集"形态：`packages/app` 对全部 workspace 兄弟 + `@deepseek-ai/cordis` 纯静态
  import、**零 native**、boot = `new Context()` + 挂插件树 + `node:http` 常驻（A2A MCP 端点）——与
  owner 描述一字不差。
- 观察项：pnpm workspace symlink 树 bun bundler 直接可解；`'./index.js'` → `src/index.ts` 的 TS 扩展名
  别名自动处理；冒烟用 `HOME` 重定向 + `A2A_PORT` 避开 4200 活体，未触碰 Orchestra 源树与真实数据。

### 7.3 Takeaway（操作结论）

**凡满足"插件集编译期已知 + 无 native addon"的 Cordis / 纯 Node 项目，今天就能用一条命令获得单文件
发行物**：`bun build --compile --minify --sourcemap <entry> --outfile <name>`。磁盘 yml 配置面与 `!!js`
照常动态（改配置免重编）；需要动态**插件模块**时再启用 §4-B（walker patch）/ §4-E（sidecar 路由）；
native 兼容（§2 B10–B12）与跨进程桥接均不阻塞这一步。此路径零框架改动、零源码改动，是本研究中
**唯一无需任何前置工程即可落地**的结论。

### 7.4 PoC V2：运行时热加载 JS-only 插件（剔除 → drop → 扫描加载；2026-09-04 实测通过）

> 同一样本（Orchestra），独立产物（`.scratch/bun-poc-v2/`：源树副本 45MB + 二进制；v1 的 `.scratch/bun-poc/`
> 原样保留；Orchestra 真身零触碰）。核心增量：**预编译时剔除一个子包，运行起来后把包放回它扫描的路径，
> 验证运行时动态扫描并加载**（不验证适配器功能，只看 Adapter 是否出现在运行时）。

- **事实先行**：Orchestra 现状**没有**目录扫描机制——7 个 adapter 全部在 `bin.ts` 静态 import + 手工映射
  （`packages/adapter/provider-*`；递归 grep 无 readdir/动态 import）。owner 记忆中的"Provider 扫描子目录
  加载 Adapter"与代码不符。故 PoC 在**副本**中加装最小 scan-load 胶水（= 研究 §4-B 模式的最小实例化），
  改动共三处、全部标注 instrumentation：
  1. `bin.ts`：剔除 `provider-pi-agent` 的静态 import 与数组项（构建图 **43→40 模块**，剔除实证）；
  2. `agent-factory`：+3 行（`ctx.provide('agentFactory', this)` + `register()` + `listKinds()`——运行期注册面）；
  3. 新增 `adapter-scan.ts`（~170 行）：扫 `adapters/` 目录 → 解析各包入口（package.json exports/main）→
     加载 → 发现 `create*Provider` 工厂 → `ctx.get('agentFactory').register()`；独立 probe server（不侵入
     a2a-server）：`GET /adapters` / `POST /adapters/rescan`。
- **实验序列（全绿）**：
  - Phase A（`adapters/` 空）：起 daemon → kinds = 9（无 pi-agent），a2a ping 正常；
  - Phase B（`cp -a` 原样 TS 源码包 drop + 修 1 条 symlink）：`POST /adapters/rescan` →
    `loaded: ["provider-pi-agent (kind=pi-agent)"]`，kinds = **10 含 pi-agent**——**PI Agent Adapter 出现在
    运行时，PoC 达标**；幂等复扫 → skipped；a2a 面持续健康。
- **过程中撞出的新硬事实（B13，比 B2/B4 更狠）**：编译产物内，**磁盘加载模块的裸包名 import 完全不沿
  node_modules 上溯**——pi-agent（value-import `@cordis-orchestra/schema`）raw import 必败
  `Cannot find package`；且包级共享树无效、cwd 级共享树也无效（pnpm 相对 symlink 经 cp 后悬空还需修链）；
  **同一棵树纯 `bun` 跑秒解**。Turborepo #11900 "不沿祖先上溯"的判断在 disk→disk 方向同样成立——他们
  选择"运行时 build 用户代码"不是偷懒，是唯一通路。
- **最终配方（§4-B/C 的最小实证）**：胶水在 rescan 时对磁盘包做**运行时 `Bun.build`**（编译产物内嵌运行时
  自带 bundler，B7）：onResolve walker 沿 importer 目录上溯手解裸包名 → 磁盘绝对路径；node builtin 标
  `external` → 产出 7.4KB 自包含 ESM chunk（`adapters/.build/<pkg>/index.js`，`// @bun` header）→
  `import()` 产物 → 注册。**drop 的包原样 TS 源码、零构建要求**（转译+打包都发生在宿主运行时里）。
- **结论与边界**：热加载 JS-only 插件在 Bun 编译形态**成立**，但通路不是"直接 import"而是"运行时 mini-bundle"
  ——本 PoC = ~170 行胶水 + 3 行宿主 instrumentation。未尽事项：每次加载有 bundling 延迟（未测量，生产需
  mtime/hash 缓存）；schema 双实例身份按 §5 预期存在（注册/枚举不受影响，instanceof 敏感路径需 external
  共享树纪律）；文件 watch 可替代 POST rescan（机制等价，PoC 取确定性触发）；加载失败仅进 errors 报告，
  生产应接 fail-loud 审计。
---

### 7.5 PoC V3：bun-compiled dsh 全核启动 + npm better-dsh 动态装载（2026-09-05/06 实测通过）

**目标**：把 §7.4 的桥接到**真实 dsh 全核**——`apps/cli` 整个 2239 模块 universe（含 dsh-base / dsh-web-app
bundle 行、host-webserver、client-modules、cordis-plugin-hmr）编译成单二进制，本地与容器（ctr-1, incus）
各自 boot 到 `dsh web: http://…?token=…`，再在容器内 `npm install better-dsh@0.2.2-b`（registry 安装）后
重启核，验证 **post-built 插件经运行时桥装载且 client 半由核伺服**。

**通过判定（两处均绿）**：daemon 打印 token URL；shell HTTP 200 且 module table 含 `better-dsh`（含
`dashr-repl` 行）；`/plugins/??better-dsh/client.js&rev=…` HTTP 200（17857 字节，与 npm 安装物一致）。

**新增硬事实（在 B1–B13 / §7.1–7.4 之上）**：

- **B14（node:module 面）**：bun 1.4 的 `node:module` **缺 `stripTypeScriptTypes`**；静态具名 import 在
  模块装载即抛 SyntaxError。PTC worker（code-runtime-worker-thread）改 `createRequire` 惰性 + 用点号 guard
  （tsdown/rolldown 会把 namespace 访问整形回具名 import，故必须走 createRequire）。
- **B15（模块作用域 manifest 读取）**：`createRequire(import.meta.url)('../package.json')` 取版本在模块
  顶层执行 → 二进制内 `/$bunfs` 解析失败 = boot 死（llm/attribution、session-telemetry-otel 及其内联
  传播体 repeat-tool-reminder/tmux-context/tool-subagent-report）。全部改 try/catch + `0.0.0` 兜底。
- **B16（native N-API 全家）**：bun 1.4 二进制内 NAPI 缺陷逐个拦路，且各有解法：
  sharp（attachment-local，模块顶层 import）→ 惰性 `await import` + 用点 construct；koffi（win32-process/
  sandbox-windows-acl/subprocess-local windows-inspector，模块顶层类型构造）→ **createRequire proxy，require
  失败时返回自递归 inert token**（type-builder 调用在模块作用域求值，不能 throw，size assert 需 typeof 门）；
  node-pty（subprocess-local 顶层 import）→ 惰性；`@xterm/headless`（terminal-bash 顶层 createRequire）→
  惰性；**zeromq 的 N-API 直撞 `uv_async_init` → bun panic（oven-sh/bun#18546）**，better-dsh 的 lib 顶层
  `import { Dealer, Subscriber } from "zeromq"` 会在装载即崩 → 部署位 patch（脚本
  `.scratch/bun-poc-v2/patch-betterdsh-zeromq.py`）：改惰性 construct proxy（Node 语义不变）。
- **B17（import.meta.resolve 于 $bunfs）**：web-app 顶层 `import.meta.resolve('open')` → in-binary 抛
  "Cannot find package"；改 try/catch 空串 + `DSH_WEB_FRONTEND_DIR` 部署覆盖（dist 资产走磁盘）。
- **B18（运行时 Bun.build 的插件面，关键）**：bun 1.4 的 `Bun.build` **plugin onResolve 返回解析路径会让
  构建抛空日志 "Bundle failed"**（无 logs/无 stack，且随二进制代码布局**非确定**——同一源码 35/36 次跑通、
  37+ 稳定崩）→ **改用 build 内建 `alias` 表**（bare→bridge chunk 文件，内部解析稳定）通过；onLoad/onLog
  注册本身也会崩（r-log 实证）。registry 命中全部走 alias；非内嵌磁盘依赖（schemastery/zeromq/file-type…）
  交给默认解析（磁盘 node_modules walk ✓，等价 §7.4 walker-only 实证）。
- **B19（运行时 chunk 与 import.meta.url 资产）**：bridge 产物必须**发射在入口文件同目录（兄弟副本
  `.dsh-bun-<name>.entry.js`）**，否则 `readFileSync(new URL('../control-prompt.md', import.meta.url))`
  类资产读取（better-dsh 顶层读包根 md）落到缓存目录 → ENOENT。
- **B20（loader.internal 全表面）**：替换体不能只有 `import`：cordis-plugin-hmr apply 读 `loadCache`
  （给空 Map，主 job 缺失 → externals 空集兜底）；client-modules `locatePkgJson` 读 `resolveSync` 且要
  **`{url}` 对象**（v1 形参序）并指到**磁盘包**（nearestPackage 上溯找 package.json → compose 出磁盘 client
  半，由 host-webserver 从磁盘伺服）。
- **B21（registry 键 = base ∪ subpath 行）**：bundle YAML 的 `name:` 行含 subpath（`@deepseek-ai/dsh-web-app/
  startup`、`…/model-selection-settings`）→ 生成器须按行键各自 embed（entry = exports map 的 subpath 文件），
  桥的磁盘 walk 同理解析 subpath exports。
- **B22（profile ③ 层形态）**：upstream `ensureSymlink` 对 `profiles/node_modules/<scope>/<pkg>` **逐包
  lstat**——③ 层必须是 scope 内每包一条 symlink（scope 目录本身是真实目录），不是整个 scope 一条链。
- **B23（registry 剔除项）**：`@deepseek-ai/schemastery`/`cosmokit` 不进 registry embed（保留给磁盘插件
  自取 npm 嵌套副本；两个 registry chunk 相邻时触发 B18 抖动面），cordis/14 个 harness peer 仍必须
  registry（identity 纪律，§5）。

**容器面（ctr-1, incus 7.0.1, Ubuntu 26.04, node v22）**：npm 全局 `@deepseek-ai/dsh@0.1.2-rc.1` 即
磁盘树 ④；③ 层按 B22 建 symlink；web profile（bundles: dsh-base + dsh-web-app + better-dsh）npm 装
better-dsh 0.2.2-b（registry 同源）+ zeromq patch；`DSH_INSTALL_ANCHOR`=rc.1 包 manifest、
`DSH_WEB_FRONTEND_DIR`=rc.1 内 dsh-web-frontend/dist → boot 绿。

**honest 边界（本节 PoC 未覆盖）**：koffi/zeromq/node-pty 在 bun 核内属 fail-open（Win32/Jupyter/PTY 路径
用点才报错）；磁盘非内嵌 @deepseek-ai 依赖（home-paths/fs/sandbox/scope）走磁盘副本 = 与 registry 单实例
纪律的例外（双实例仅限非行包、纯 util 面，文档化接受）；hmr 文件 watch 语义在编译核退化（loadCache 空）；
client 半由磁盘伺服而非内嵌（alpha 资产版本可能落后核一档）。

**可复现性**：全部源码改动 = `upstream/deepseek-harness` 工作树的 git diff
（`.scratch/bun-poc-v2/checkout-patches.diff`，14 处零 vendor 改动 seam 同 §7.3 纪律）+ 未跟踪文件
`packages/boot/app-boot/src/bun-internal-bridge.ts`、`packages/boot/app-boot/bun-registry/`
（生成物）、`packages/boot/app-boot/node_modules/dsh-bun-registry-entries → ../bun-registry`；
生成器 `.scratch/gen-bun-registry.ts`；部署位 patch `.scratch/bun-poc-v2/patch-betterdsh-zeromq.py`。
二进制 `.scratch/dsh-bun-core`（84–88MB）；本地验收 home `.dsh-bun-test`（独立 DSH_HOME）。

---
## 8. 判决

1. **Barrier 2（自举）是真的，但被高估为"框架级"；实测是"两个 choke point 的裸包名分支"**，且 loader 是
   自家 vendor 代码、upstream 已有 `bareModuleBaseUrl`/"closed packaged runtime" 的设计预留。可patch面小、
   边界清晰。
2. **Bun 侧的失败模式有生产级先例与配方**：B2/B4（azu repro、Turborepo #11900）不仅确诊了"编译产物内
   裸包名/`createRequire` 必败"，还交付了被验证的 workaround（手写 walker + 绝对路径 + external builtin
   + virtual namespace）。
3. **A（冻结已知集）+ B（磁盘承接动态集）是基线形态**；**E（Node sidecar）按真实插件集的 Bun 通过率
   决定是首发件还是后备件**（§4-E 路由器模式：`runtime: bun|node` 双路由 + feature-probe）。Deno 的
   `--include` 是该张力的生态级参照物；Bun 尚未跟进（#11732 open）。
4. **必须带着 §5 的身份纪律上线**：external 共享树 + boot 单实例断言，否则双实例会把问题变成最难查的
   半工作态。
5. **PoC 清单**（按依赖序，预计一天内可跑完判定）：
   a. 最小 cordis app（vendored core + loader + 一个静态插件 + 一行 yml）`bun build --compile` → 预期
      boot 成功（core 零 native、`new Function`/fs/yaml 全通）。——**✅ 已实测通过（§7.1，且超额：含磁盘
      TS 插件现场转译与 `!!js`/env 探针；Orchestra 真实目标一并通过，§7.2）**
   b. 加一行裸包名条目 + 磁盘 node_modules → 复现 B2 报错 → 打 walker patch（Turborepo 配方）→ 复通。
   c. 双实例 probe：磁盘插件 import `@deepseek-ai/cordis`，断言与 host 同实例 → 验证 external 共享树。
   d. A 的 codegen registry（bund bundles 列表生成）→ registry-first → 懒加载 chunk + fail-loud 审计。
   e. `BUN_BE_BUN=1 ./dsh install` 在 profile 目录装一个真插件（运营面冒烟）。
   f. 双运行时路由率测定：拿 3–5 个真实目标动态插件在 Bun 运行时试载（`process.getBuiltinModule` probe
      + 试 import + native 探测）→ 通过率决定 E-sidecar 是首发件还是后备件。
   g. E-subtree 最小桥：Node 侧起真 loader 挂一个 group，服务/事件经组边界代理回 Bun 核——验证桥面接口
      清单是否收敛（§4-E 的可交付性判定）。
   h. 磁盘 JS-only 插件热加载。——**✅ 已实测通过（§7.4）**：剔除→drop→rescan→运行时出现 adapter，
      配方 = 运行时 Bun.build + walker（Turborepo #11900 同款）；raw import 路线被 B13 判死。
   i. **bun-compiled dsh 全核启动 + npm post-built 插件装载。——✅ 已实测通过（§7.5）**：本地
      `.dsh-bun-test` 与容器 ctr-1 双绿；配方 = registry alias tier（内建 `alias` 表，规避 B18 的插件面
      崩溃）+ 磁盘默认解析 + entry-同目录 chunk（B19）+ loader.internal 全表面镜像（B20）+ native 惰性/
      token 全家（B16）+ 部署位 zeromq/asset patch；鉴定边界见 §7.5 honest 段。

---

## 来源

- 本仓一手源码：`upstream/deepseek-harness`（`dsh-v0.1.2-alpha.5`）`vendor/loader/src/{internal.ts,
  config/tree.ts, config/utils.ts, index.ts}`、`vendor/hmr/src/index.ts`、
  `packages/boot/app-boot/src/{index.ts, profile.ts}`
- 实测产物（v3）：`.scratch/bun-poc/`（Bun 1.4.0 装于 `.scratch/bun-install/`）——合成 PoC `entry.ts` +
  `config/cordis.yml` + `plugins/echo.ts` + 探针日志 `poc.log`/`poc2.log`/`orchestra.log`；Orchestra
  源树只读冒烟（`/home/u1/workspaces/orchestra/src/packages/app`，零改动、产物落本仓 scratch）
- 实测产物（v4，PoC V2）：`.scratch/bun-poc-v2/`——Orchestra 源树副本 `src/`（45MB，改动仅 bin.ts 剔除 +
  agent-factory 3 行 instrumentation + 新增 `packages/app/src/adapter-scan.ts`）、二进制 `orchestra-v2`
  （40 模块）、运行目录 `rt/`（adapters/ 扫描面 + drop 的 provider-pi-agent + `.build/` 运行时 bundle 产物）、
  日志 `run*.log`（含 B13 失败序列与最终全绿序列）
- [Bun — Single-file executable（2026-09）](https://bun.sh/docs/bundler/executables)：bundled modules +
  运行时、cwd 锚定（Worker/SQLite）、`/$bunfs` 内嵌文件与 `--asset` 目录树、`BUN_BE_BUN=1`、
  `--splitting`、bytecode/sourcemap、不支持项清单
- [azu/bun-build-dynamic-import](https://github.com/azu/bun-build-dynamic-import)：非可分析动态 import 在
  编译产物的 `Cannot find package … from "/$bunfs/root/…"` repro
- [oven-sh/bun#11732](https://github.com/oven-sh/bun/issues/11732)：`--include` flag 请求，state=open
  （API 实查 2026-09-03）；issue 正文引 Deno `--include` 先例
- [vercel/turborepo#11900](https://github.com/vercel/turborepo/pull/11900)（fix #11882，2026-02）：
  编译产物内 `createRequire().resolve()` 不可靠 → 手写 node_modules walker；运行时 `Bun.build` 用户配置 +
  `BINARY_MODULES` virtual namespace 桥接 + node builtin `external: true`；含回归测试
- [openclaw/openclaw#114256](https://github.com/openclaw/openclaw/pull/114256)（2026-07 merged）：388k★ TS
  工具加实验性 Bun 支持实录——node:sqlite 在 1.3.x 缺、1.4.0 canary（Rust 重写线）提供；execa
  `encoding:"buffer"` 触发 #36049；接法 = `process.getBuiltinModule` feature-probe 而非品牌门
- [oven-sh/bun#36049](https://github.com/oven-sh/bun/issues/36049)（spawn `encoding` divergence，stable
  1.3.14 复现）、[oven-sh/bun#16050](https://github.com/oven-sh/bun/issues/16050)（better-sqlite3 需重编译）、
  [opencode-telegram-bridge#34](https://github.com/gabriel-trigo/opencode-telegram-bridge/issues/34)
  （better-sqlite3 N-API crash 实案）、[OmniRoute#11468](https://github.com/diegosouzapw/OmniRoute/pull/11468)
  （以 bun:sqlite 规避 N-API crash）
- 本仓既有研究：[cordis-research.md](./cordis-research.md) §2（no privileged core / bootstrap 链）、§4.2
  （Bun 编译首判：native addon 政策、Claude Code 先例、tsdown 线不动）；AGENTS.md §一（①→④ 解析分层、
  14/14 运行期 host import、供应链年龄门运营史）
