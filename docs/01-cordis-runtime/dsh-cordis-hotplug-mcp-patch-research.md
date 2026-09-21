# DSH + Cordis 热插拔实测：profile patch 热重载、MCP 热挂载与渐进披露

> 记录：2026-09-05 · 一手核验：本机 prod `dsh 0.1.2-alpha.5`（npm 布局，
> `~/.local/lib/node_modules/@deepseek-ai/dsh`，profile `web`，systemd --user `dsh.service`）
> + `@deepseek-ai/dsh-app-boot` 源码（`lib/profile-boot-*.js` / `lib/index.js`）
> + `@deepseek-ai/dsh-mcp-client` 源码 + `graphify-http-mcp` 收编改造全程实测。
> 关联：`cordis-research.md`（Cordis 框架本体研究）· `../02-dsh-webui/dsh-web-profile-package-map.md`（profile 依赖拓扑）。

---

## 0. 结论先行（两个问题的答案）

**Q1：编辑 `cordis.patch.yml` 加/删 MCP server，就能热插拔，对吗？**
**对。** `cordis.patch.yml` 是本机 dsh **profile web 的用户 patch 层**（runtime 启动后依然"活着"的
配置文件）。web profile 的 `patchReload` 是 `live`：dsh 启动时经 Cordis HMR 服务 watch 这个文件，
**保存即触发**——重新解析 patch → 事务性重组插件树 → 新增的 insert 条目对应的插件实例被创建
（MCP client 连接远端并注册工具），删除的条目对应实例被 dispose（工具注销）。**不需要重启
`dsh web`，也不需要任何手动触发**（详见 §2 机制、§3 实测时间线）。

**Q2：改完 YAML 需要手动触发扫描吗？**
**不需要。** 保存文件本身就是触发。`watchUserPatches → hmr.registerConfig(filename, cb)`，
文件变更（含首次注册时的初始扫描）→ 回调重新 `loadOptionalPatches` 解析并热应用。全程自动。

**边界与前提（重要）：**
1. **仅 long-lived 面热插拔**：`web` 与自定义 profile 默认 `patchReload: "live"`；官方模板
   `acp` / `headless` / `sdk` / `sdk-minimal` 是 `startup` —— 那些面改 patch 需要重启才生效。
2. **工具面是"会话启动快照"**：某会话开始后其可调用工具清单已定稿；HMR 热增/热删的 MCP 工具
   只影响**之后新建的会话**（当前进行中的会话工具面不变）。
3. **YAML 只管配置，不管安装**：insert 引用的插件名必须在 loader 树里可解析。本机 5 个 MCP
   全部复用同一个内置桥插件 `@deepseek-ai/dsh-mcp-client`（host 依赖，profile 自带），所以
   纯 YAML 即可；**第三方插件要先进 profile**（`dsh plugin add <pkg>` / pnpm 装进
   `~/.dsh/profiles/web/package.json` 的 bundles），patch 里才能 insert。
4. **坏 patch 会 fail loud**：patch 文件存在但不可解析/不可应用 = 配置错误，启动或热重载时报错
   而不是静默跳过 —— 改完可用 dsh 自己的 loader 解析函数离线校验（见附录 C）。

---

## 1. 背景：为什么这事值得研究

DSH 的插件/配置体系把"运行时组合"和"配置热更"做成了第一公民，直接效果是：**MCP server 的
挂载/摘除/重挂变成了改一个 YAML、存盘即生效**。本次会话把这条链路完整跑了一遍并量化了
收益（一个自研 MCP server：schema 12.2 KB → 6.2 KB；顺带完成一次"全局服务收编治理"）。
本文把机制、实测、沉淀的模式一次写清，供后续在 dashr/better-dsh 开发里复用。

---

## 2. 机制拆解（源码级，一手核验）

### 2.1 Profile 树：patch 是"覆盖层"，不是唯一配置

```
~/.dsh/profiles/web/
├── package.json      # dsh.profile.bundles = [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app,
│                     #   dshmarket, dsh-better-sidebar, corti-memory, better-dsh]
├── cordis.yml        # 空 [] —— 树由 patch 组成，本文件只是占位
├── cordis.patch.yml  # ★ 用户 patch 层（本机所有 MCP insert 都在这里）
└── node_modules/     # pnpm hoisted 依赖树
```

组合顺序（`dsh-app-boot` `composeEntries`/`prepareProfile`）：
`cordis.yml 根条目` + 每个 bundle 的 `cordis.patch.yml` + **用户层 `cordis.patch.yml`** +
home 级 patch + `--patch` overlay —— 用户层永远最后覆盖。patch 条目三种形态：

| 形态 | 作用 | 本机例子 |
|---|---|---|
| `{id, config}` | 覆盖某个既有插件配置 | `agent-presets.default: standard`（dashr bundle 钉的 `dashr` preset 缺失 → 回退）、`dashr-repl` 的 `trustedPageAuthorities` |
| `{insert: [...]}` | 向树里插入新插件实例 | 5 个 MCP server（见 §4） |
| `{id, disabled: true}` | 禁用行（⚠ 2026-09-05 勘误：无独立 `disable:` 键，实为 `disabled` 字段覆盖；也无 delete 形态，唯一删除等价物即此） | （本机未用） |
| `{id, config}` | 覆盖某个既有插件配置 | `agent-presets.default: standard`（dashr bundle 钉的 `dashr` preset 缺失 → 回退）、`dashr-repl` 的 `trustedPageAuthorities` |
| `{insert: [...]}` | 向树里插入新插件实例 | 5 个 MCP server（见 §4） |
| `{disable: [...]}` | 停用（本机未用） | — |

### 2.2 patchReload：live vs startup

`PROFILE_TEMPLATES`（`dsh-app-boot`）：

- `web` → `live`（"hot-reloaded on long-lived surfaces"）
- `acp` / `headless` / `sdk` / `sdk-minimal` → `startup`
- 自定义 profile（名字不在模板表）→ 默认 `live`

`profile-boot` 的运行时判定（`lib/profile-boot-*.js`）：

```js
if (composed.profile.patchReload === "live" && …) {
    if (ctx.get("hmr") === void 0) await ctx.loader.create({
        name: "@deepseek-ai/cordis-plugin-hmr", config: { root: [] } });
    await watchUserPatches(ctx, { filename: composed.profile.patchPath, … });
}
```

### 2.3 HMR 链路（保存 → 生效的每一步）

```
保存 cordis.patch.yml
  → hmr.registerConfig(filename, cb) 的文件 watch 触发（Cordis HMR 服务）
  → cb: loadOptionalPatches(binName, file) 重新解析（!!js 表达式可 eval process.env）
  → composeLive() = bundle patches + 用户 patch + overlays 的深拷贝合并
  → entry.update({ config: { …includeConfig, patches } })   ← 事务性
  → 差异插件 dispose / create（Cordis "可逆效应"）：新增 insert → 实例激活；
     删除/变更的条目 → 旧实例回滚、新实例上线
```

关键实现（`dsh-app-boot/lib/index.js` `watchUserPatches`）：

```js
const register = hmr.registerConfig(filename, async () => {
    const patches = compose(loadOptionalPatches(binName, filename) ?? []);
    await entry.update({ config: { …includeConfig, patches } });
});
```

### 2.4 dsh-mcp-client：一个插件实例 = 一个 MCP server

`@deepseek-ai/dsh-mcp-client` 是 Cordis 命名空间插件：**每个实例连一个 MCP server**，
把它的工具注册到 harness 的 `ctx.tools`，公开名 `mcp__<serverName>__<rawName>`。
所以 5 个 MCP = 5 条 insert，全部复用同一插件名、只是 config 不同：

```yaml
- insert:
    - id: mcp-graphify        # 实例 id（唯一）
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: graphify  # 工具命名空间（mcp__graphify__*）
        transport: streamable-http
        url: http://127.0.0.1:4749/mcp
        toolCallTimeoutMs: 120000
```

配置面（源码 `lib/types/*.d.ts`）：`transport: 'stdio' | 'streamable-http'`；
stdio 侧 `command/args/env/cwd`，HTTP 侧 `url/headers`；公共 `serverName`/
`toolCallTimeoutMs`/`failOnStartupError`/`reconnect`。

连接语义（`lib/index.js` `syncTools`）：连接时**一次全量 `tools/list`（含 drain pagination）**
并整代注册；收到 `notifications/tools/list_changed` 会重同步换代（旧代先 dispose 再注册新代）。
**模型只能调用已注册名字的工具** —— 这决定了"渐进披露"只能在 schema 体积上做、不能藏名字
（详见 §4.3）。

---

## 3. 实测时间线（2026-09-05，全部真实回放）

| 时刻 | 动作 | 生效方式 | 结果 |
|---|---|---|---|
| 上午 | patch 加入 `mcp-exa` + `mcp-graphify` | **保存即 HMR**，无重启 | loader 解析 7 顶层条目；DSH 工具面 +2 server |
| 上午 | patch 移除 `mcp-graphify`（评估期暂摘） | **保存即 HMR**，无重启 | 回到 4 个 MCP，graphify 工具自动注销 |
| 下午 | graphify server 端渐进披露改造 + 收编（见 §4、§5） | `busctl` 经 systemd bus `RestartUnit` | 新代码上线，工具 16→17 |
| 下午 | patch 重挂 `mcp-graphify` | **保存即 HMR**，无重启 | 5 个 MCP；`mcp__graphify__*` 在新会话可见 |

全程 `dsh web` 服务进程从未重启；`cordis.patch.yml` 的每次变更都只靠文件保存触发。
（注意：systemctl --user 在本 agent 沙箱连不上 private socket，但 `busctl --user call
org.freedesktop.systemd1 … RestartUnit` 可走 D-Bus 直达 systemd，实测可用。）

### 3.1 schema payload 实测（同一 server，改造前后）

| 指标 | 改造前 | 改造后 | 说明 |
|---|---|---|---|
| 工具数 | 16 | **17**（+`detailed_description`） | help 入口按需返回手册 |
| description 合计 | 5,074 chars（均 317） | **1,462 chars**（均 86） | 一行化 + 手册外置 |
| `outputSchema` | 每工具一个（非标准、被客户端忽略） | **0** | FastMCP `structured_output=False` |
| tools/list compact | 12,235 B | **6,187 B** | ~2× |
| token 估算（÷3.5~4） | ~3.1K | **~1.5–1.8K** | 每请求全量随行，乘模型往返次数 |

---

## 4. 沉淀的模式一：MCP server 端"渐进披露"（CLI --help 语义）

### 4.1 动机

MCP 客户端对 server 是 eager 全量注册；schema（尤其长 description）**每个模型请求都全量随行**、
按 input token 计费。Hermes 2026-07 曾因 graphify eager 注入占 code profile 上下文 ~10%
(~15.5KB/轮) 而把 MCP 降级成 skill —— 同一 server、同一配置，问题出在**服务端把手册写在
description 里**。

### 4.2 做法

1. `tools/list` 里每个工具只留：**名字 + 一行功能性描述 + 极简 typed schema**（足够模型构造首次调用）。
2. 完整手册（参数语义 / 示例 / 返回形态 / CLI 等价）移入服务端常驻字典，经新增的总入口工具
   **按需返回**：`detailed_description(tool?)` —— 无参 = 工具目录，带参 = 单工具手册。
3. 类比：人和模型遇到陌生 CLI 都会先 `-h/--help` —— 这是双方都"原生"的渐进披露。

实现要点（graphify-http-mcp.py canonical 版）：
- `_HELP: dict[str,str]` 存 16 条手册；`detailed_description` 负责索引/详情/未知名提示。
- **FastMCP 实测坑①**：docstring 全量（含 Args/Returns 段）会进 `description` → 必须一行化。
- **FastMCP 实测坑②**：该版本默认给每个工具发 `outputSchema`（非 MCP 标准字段，客户端忽略但
  白吃 payload）→ 用 `structured_output=False` 的装饰器别名统一抑制（`def _tool(fn):
  return mcp.tool(structured_output=False)(fn)`）。
- 残余可压项（本次未做，边际收益 ~1.4KB）：inputSchema 里的 `title` 字段（"Graph Path"、
  "query_graphArguments" 等）可后处理剥掉；需要侵入 FastMCP 内部，收益 ~25%，先不碰。

### 4.3 架构红利

披露坍缩在 **server 端**、MCP 配置在各 runtime 间不变 → server 改一次，Hermes / DSH / OMP /
Claude Code 等所有消费者**自动**同时瘦身。这也是"配置跨运行时复用"的正确姿势：把变体下沉到
自己写的服务里，而不是在每个运行时各改一遍。

---

## 5. 沉淀的模式二：自研 MCP server 的收编治理

### 5.1 问题（审计发现）

graphify-http-mcp 是**全局 MCP 服务**，却只有 `~/.hermes/services/` 与
`~/.hermes/profiles/code/services/` 两份**无版本控制的物理副本**（md5 相同、非 symlink）；
dev 侧文档/unit 模板在 base 仓库但整目录从未提交。全局服务挂在某个 agent runtime 的 profile
目录里 = 部署位即单点、无 canonical、易漂移。

### 5.2 收编动作（本次落地）

1. **canonical 源码** → `~/workspaces/base/40_Services/05_graphify/graphify-http-mcp.py`
   （部署资产随 tier 目录入库；base git 提交 `d56e61c`）。
2. **unit 模板** → 同目录 `templates/graphify-http-mcp.service`；live unit
   `~/.config/systemd/user/` ExecStart 指向 canonical 路径。
3. `~/.hermes` 两份副本 → **symlink 指回 canonical**（不再有分叉副本）。
4. **路径逻辑与文件位置解耦**：wrapper 原来用 `Path(__file__).resolve()...` 推算 uv python
   路径（只在 `~/.hermes/services/` 深度成立），改为 `Path.home()` 推算 + `GRAPHIFY_PYTHON`
   env 覆盖 —— 文件挪进 base 深层目录后依然能启动。
5. 风险提示：若某 runtime 按 profile **重新 stage services（copy 而非保留 symlink）**会盖掉
   symlink —— 收编后要留意这类"写回副本"逻辑。

---

## 6. 一句话沉淀

**DSH 的热插拔 = Cordis 的"可逆效应 + 反应式余效应"在 profile patch 层的落地**：把
"配置文件"做成能被 HMR 监控、事务性重组合的覆盖层，于是 MCP 的挂/摘/重挂、插件的加/减/改，
都是"改 YAML、存盘、等下一个会话"；而 schema 开销这类**服务端可修的问题，永远优先修在服务端**，
让所有消费者零改动地同时受益。

---

## 附录 A：本机 5 个 MCP 的 patch 摘要

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml —— 每个 - insert: 块 = 一个 MCP server
mcp-cordis-a2a   → streamable-http https://a2a.randomhash.app/?uuid=…   （A2A 桥）
mcp-zai-vision   → stdio  npx -y @z_ai/mcp-server@latest                 （GLM-4.6V，ZAI_PLAN_API_KEY）
mcp-web-reader   → streamable-http https://api.z.ai/api/mcp/web_reader/mcp（Bearer $ZAI_PLAN_API_KEY）
mcp-exa          → streamable-http https://mcp.exa.ai/mcp                （x-api-key $EXA_API_KEY）
mcp-graphify     → streamable-http http://127.0.0.1:4749/mcp             （本机自研，canonical 于 base）
```

## 附录 B：相关源码/文件索引

- `~/.dsh/profiles/web/cordis.patch.yml` · `cordis.yml` · `package.json`
- `~/.local/lib/node_modules/@deepseek-ai/dsh/`（lib/profile-boot-*.js、bin.js）
- `…/@deepseek-ai/dsh-app-boot/lib/index.js`（watchUserPatches / PROFILE_TEMPLATES / loadOptionalPatches）
- `…/@deepseek-ai/dsh-mcp-client/lib/index.js`（syncTools / 类型定义 lib/types/*.d.ts）
- `~/workspaces/base/40_Services/05_graphify/graphify-http-mcp.py`（canonical + _HELP 渐进披露实现）
- 上游：Cordis = `@deepseek-ai/cordis`（vendored）/ `github.com/cordiverse/cordis`；
  框架本体研究见同目录 `cordis-research.md`

## 附录 C：patch 离线校验（loader 同款解析）

不重启、不触发热重载的前提下验证 `cordis.patch.yml` 能否被 dsh 真实解析：

```bash
cd /home/u1/.local/lib/node_modules/@deepseek-ai/dsh
node --input-type=module -e "
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot';
const p = loadOptionalPatches('validate', '/home/u1/.dsh/profiles/web/cordis.patch.yml');
console.log('parse OK —', p.length, 'entries');
"
```

解析抛错 = patch 有问题（fail loud），先修再存盘，避免把坏配置热重载进运行中的树。
