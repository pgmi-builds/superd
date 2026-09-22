# 2026-09-22 — super-dsh（Agent Worlds 线）dsh 插件化发布实测报告

> **⚠ 0.1.0 作废（同日裁决）**：0.1.0 按 1+7 多包拓扑发布，违背 user 的 better-dsh 单包模型
> （`~/workspaces/dashr/better-dsh`：一包一发、一卡、Components 内嵌可独立开关），且 4 个
> adapter 的 `file:../agent-hub` 依赖在消费机安装即炸（ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND）。
> **修正版 = `super-dsh@0.1.1` 单包**（§七 补记）；7 个 scoped 包已停止使用，撤销需 user 侧
> 2FA（本机 granular token 只许 publish 不许 delete）。0.1.0 版本号在 npm 上不复用。

**发布物**：`super-dsh@0.1.1`（unscoped 单包，dsh 插件/composition 面，内嵌全部组件）。
~~`@pgmi-builds/agent-*@0.1.0` ×7~~（0.1.0 已废）。
**授权**：user 本会话明确指令「publish the `super-dsh` as super-dsh, unscoped, available, this time
make it `super-dsh` (the ./super-dsh alone) is a dsh plugin」+ 同日纠正裁决「better-dsh 模型，
one pack」（三闸之放行闸；实测与报告见下）。
**操作手册**：`docs/06-package-update-guidelines.md`（B 线）；红线以根 `AGENTS.md` §〇 为准。

---

## 一、包结构裁决（为什么是 1+7 而不是单 tarball）

adapter bundle patch 与 world 插件全部以裸名（`@pgmi-builds/agent-adapter-*`、
`@pgmi-builds/agent-hub`）互指，world 树的 mount 行也直引 hub。单包内嵌（monolith）需改写全部
patch 拓扑为 subpath 并维护第二份名字映射——违背 §三.1 canonical 语义。故：

- **7 个 scoped 包** = canonical 源码包（peerDeps 保持 npm-range optional；零 lifecycle script；
  files 覆盖 dist/lib/sidecar/bridge/cordis.patch.yml——**agent-agy 补了 `bridge/`**，其
  `agy-client.js` 运行期从包根解析 `bridge/agy_bridge.py`，漏列即模块期 ENOENT，正是 §三.7 陷阱）。
- **`super-dsh`** = 纯 composition 插件：`dsh.bundle.patch`（composite ctx0 face：hub + 5 个
  world 行 + claude join 行 + directory-picker browse 对 + auto 关闭）+ `dsh.client`（re-export
  hub client 的 `./client` shim，selector 挂点）+ 依赖 exact-pin 上述 7 包。一条
  `dsh plugin add super-dsh` 即整线。

全部版本对齐 0.1.0（各包首次公开发布；`agent-omp` 旧名 0.2.2-b / aw 系 0.0.1-aw 均为本地史）。

## 二、本次新增代码：world 自举（publish story 的缺口补齐)

dev 线由 `test/smoke.mjs` 手工预置每个 world 的嵌套 profile 与 `@pgmi-builds` 链接；外部安装
（`dsh plugin add`）没有 bootstrap——不补则所有 world spawn 必败。新增：

- **`agent-hub/src/world-provision.ts` → `provisionWorldProfile()`**：幂等写
  `<DSH_HOME>/agents/<label>/profiles/web/{package.json,cordis.patch.yml}`（bundles =
  base+web-app+adapter；home pinning 层与 smoke 逐字对齐）+ lstat 安全重链
  `profiles/node_modules/@pgmi-builds/{adapter,hub}`。链接身份规则：hub 链接目标 = 本模块
  自解析（import.meta.url 自指，dev/registry 两态都指 canonical）；adapter 链接目标 =
  调用方 world 插件实际解析到的副本（与 ctx0 同实例，杜绝双 hub）。
- **六个 spawn 位点接入**（5 个 adapter world-plugin + hub `world-join`（claude））：
  `bareModuleBaseUrl: AW_BARE_BASE ?? provisioned ?? undefined`——env 优先，dev 线零回归；
  解析失败回 null（dev 线继续走 bootstrap）。
- **解析器防坑**：包 exports 不导出 `./package.json`（`ERR_PACKAGE_PATH_NOT_EXPORTED`），
  改用上游 `packageDirFromAnchor` 同款 `resolve.paths()` + `existsSync` 走法。

## 三、tarball 实测闸（publish 前第一人称，consumer 拓扑）

方法：8 个 tarball → 全新 home `.tests/plugin-acc`，profile `acc-web` 以 npm 物理安装
（413 包；`@deepseek-ai` 不在 profile 树 ✓ 单实例纪律）；**installation-anchor 拓扑**
（anchor = `upstream/.../apps/cli/package.json`，与消费机「运行中 dsh 的 package.json」同构；
bare base = `healProfilesModuleFallback` 产物 + `@pgmi-builds` 物理链接）；启动
`test/plugin-acc-boot.mjs`（bundles 含 `super-dsh`，零手工 patch）`systemd-run --user` 单元
`superd-acc-4996-test`，端口 4996（4999 让位于在役 aw 线）。

**结果（全部 PASS）**：

| 检查 | 结果 |
|---|---|
| 单元状态 / 监听 | active / LISTEN 127.0.0.1:4996 |
| 日志错误 | 0 条 error |
| 认证面 | token URL 303 入站；裸 GET 401 fence |
| world 自举 | 6/6：`agents/<label>/profiles/web` 三 bundle 齐全 + 链接就位 |
| world 挂载（carrier，同认证域） | omp/codex/claude/pi/hermes/agy 全部 200 |
| `/omp/api/agent-runtime` 控制面 | 200 |
| ctx0 app 页 | 200，模块 loader 头正常 |

**实测拦下的发布级缺陷**（不发不知道，发了就 404）：
1. 根 `super-dsh` dependencies 误用目录名（`@pgmi-builds/agent-agy`）而非真实包名
   （`@pgmi-builds/agent-adapter-agy`）——registry 安装 6/7 必 404。已改真名。
2. `agent-agy` 缺 `files` 字段（会把 src/.venv 全发出去且丢 bridge/）。已补。
3. provisioner 的 package.json 子路径解析在限制性 exports 下必败（见 §二）。

## 四、构建卫生与已知环境性失败

- hub tsc + build-client（host 半后重跑 client 半，§三.3）全绿；6 adapter tsc 全绿。
- hub `npm test`：65/66 绿；`spawn-world.test.mjs` 失败于**自身模块顶的 cpSync 引导**（向
  在役线 home `.tests/aw` 覆盖拷贝 ctx1-min，目录已存在含 symlink → EEXIST 类失败）——
  失败点先于本次任何改动代码执行，属预存环境漂移，非回归。⚠ 该测试写在线 home，后续应改
  指独立 home（攒批）。
- omp sidecar 系测试沙箱只读 DB 失败为已知环境项（omp AGENTS §五·五），不阻断。

## 五、发布与消费侧说明

- 发布顺序：7 个 scoped（`publishConfig.access: public`）→ `super-dsh`（unscoped 默认
  public；发布前 registry 查重 `super-dsh`/`superdsh` 均 404，无 typosquat 冲突对象）。
  发布后 `npm view` 复核 tarball URL。
- **dev3 消费路径**：`dsh plugin --profile web add super-dsh@0.1.0`（精确版本，§四.3；
  勿 @latest）→ `systemctl --user restart dsh.service` → 侧栏出现 runtime selector，
  Plugins 页出 `superd` 卡片（描述 = 包 description；Components = composite insert 行）。
  pnpm 11 消费者如启 `minimumReleaseAge`，需 `minimumReleaseAgeExclude: ['super-dsh',
  '@pgmi-builds/agent-hub', …]`（裸包名全相位豁免，§四.2）。
- world 就位条件：各 foreign runtime 按原生 home 就绪（`~/.omp`、`~/.codex`、`~/.claude`、
  `~/.pi`、hermes gateway、agy SDK/venv）；未就绪的 runtime 在 roster 显示未 ready，不拖垮
  其它 world。world 数据全部落 `<DSH_HOME>/agents/<label>/`，原生 home 零重定向（S3/S7）。

## 六、遗留

- 验收实例按验收模式保持运行（`systemctl --user stop superd-acc-4996-test` 关停）；
  4999 在役 aw 线未动。
- hub spawn-world 测试的 home 指向、以及根占位包 `@pgmi-builds/superd` 的 repository.url
  陈旧（mark1kwok → pgmi-builds），攒入下一批。

## 七、0.1.1 单包重做（同日；better-dsh 模型对齐）

**user 裁决**：插件模型 = better-dsh——一包一发，webui 一张插件卡，点进去 Components
（= 本包 cordis.patch.yml 的 insert 行）逐行独立开关（cordis hmr）。0.1.0 的 1+7 拓扑
（scoped 依赖扇出）不符合该模型，且 adapter 残留的 `file:../agent-hub` 依赖在消费机
pnpm 安装即炸。

**单包结构（对齐 better-dsh）**：

- 全部组件内嵌为 `super-dsh/` 的兄弟子目录（agent-hub/dist+lib、agent-*/dist、sidecar、
  bridge、各子 package.json + cordis.patch.yml），`files` 允许列表封口；
  **每个内嵌目录放空 `.npmignore`**——否则各自 `.gitignore` 的 `dist/` 规则在父包 pack 时
  把内嵌构建产物剥掉（本次实测踩中：首包 133 文件缺 5 个 adapter 的 dist）。
- cordis.patch.yml 的 insert 行全部**自指 subpath**（better-dsh 同款）：
  `super-dsh/hub`、`super-dsh/world/{omp,codex,pi,hermes,agy}`、`super-dsh/join` ——
  插件页 Components 逐行 = 这些 row，独立开关。
- 五个 adapter world-plugin 对 hub 的 import 改相对路径
  （`'../../agent-hub/dist/index.js'`，repo 布局与单包布局同构，两端通用）；
  claude 的 /world 本就 inert 不动。
- 真实运行时依赖上收为 super-dsh 的 `dependencies`（claude-agent-sdk、codex+sdk、
  pi-coding-agent（两 scope）、bun、ws、zod）；`file:`/`link:` 依赖零残留；
  harness 依赖照旧 optional peers，host 自供。
- **provisioner 改兄弟推导**：hub 根 = 本模块上两级，adapter = 兄弟 `agent-<key>`，
  world 链接 `@pgmi-builds/{adapter,hub}` → 内嵌兄弟目录 + `@deepseek-ai` 整 scope 单链接
  → 共享 heal farm（世界树的全部裸名一行链接搞定）；零 registry 解析。

**0.1.1 tarball 实测（全新 home `.tests/plugin-acc2`，单 tgz 安装，407 包）**：

| 检查 | 结果 |
|---|---|
| 单元 / 监听 | active / LISTEN 4996 |
| 日志错误 | 0 |
| 认证面 | token 303 / 裸 401 |
| world 自举 + 挂载 | 6/6 profiles 三 bundle 齐全；6/6 mount 200 |
| 安装树 | 仅 `node_modules/super-dsh/`（内嵌 agent-*），零 @pgmi-builds 包 |

**实测新增坑（已修，全在 0.1.1 里）**：
1. 内嵌目录 `.gitignore` 在父包 pack 时剥构建产物 → 空 `.npmignore` 压制（见上）。
2. 验收 boot 不能传 `bareModuleBaseUrl`：真 dsh 不传，裸名走 include 根旁的 ambient 链
   （profile node_modules → 共享 farm）；传了 embedder base 反而让 `super-dsh/*` 行
   只在 farm 里找（实测第 2 次失败根因）。
3. 世界树裸名解析需 `@deepseek-ai` scope：provisioner 单链接指向首个可见 scope 目录
   （dsh home = heal farm；dev = repo farm），免逐包 farming。

**registry 状态**：`super-dsh@0.1.1` 已发布（`npm publish` 走同一 granular token）。
7 个 scoped 0.1.0 的 unpublish 被拒（403：granular token bypass-2FA 不可 delete）——
需 user 侧带 OTP 执行：
`npm unpublish @pgmi-builds/agent-hub@0.1.0 --force --otp=<code>`（其余 6 个同理）。
在撤销前它们是无引用死包（0.1.1 不依赖任何 scoped 包），不碍安装。

**dev3 消费（重试命令）**：

```bash
dsh plugin --profile web add super-dsh@0.1.1   # 或 super-dsh@latest
systemctl --user restart dsh.service
```

副作用提示：`super-dsh@0.1.0`（多包废案）若已被 pnpm 半安装，先
`dsh plugin --profile web remove super-dsh` 或手动清 `profiles/web/package.json` 里
super-dsh 条目 + `pnpm install` 再加 0.1.1。

## 八、0.1.2 热修（同日；dev3 重启后站点不可达的疑因 + 加固）

dev3 装 0.1.1 成功（`+ super-dsh 0.1.1`，pnpm 警告仅 peer 提示）但重启 dsh 后
`dsh.dev3` 不可达 —— 服务在 boot 阶段死亡。0.1.1 有一处**会在消费环境杀死整个 boot** 的
线内缺陷：

- 六个 spawn 位点以 `process.env.DSH_HOME ?? join(process.cwd(), '.tests', 'aw')` 推导
  world 根。消费机没有 `DSH_HOME` env（harness 从不导出），cwd 也不是仓库根 —— 轻则把
  world 建到垃圾树，重则 `mkdirSync`/provision 在 `apply()` 内抛出 → loader entry apply
  失败 → **整个宿主 boot 失败**（omp AGENTS §五 早有同款坑记录，此处漏防）。

**0.1.2 修正**：

1. world 根改 `resolveDshHome()`（`@deepseek-ai/dsh-home-paths`，显式 > `$DSH_HOME` >
   `~/.dsh`）——dev 线 env 行为不变，消费机正确落到 `~/.dsh/agents/<label>`。
2. **世界失败永不下毒宿主树**：`provisionWorldProfile` 改为从不抛出（内部 try/catch →
   null）；每个 spawn 位点的 world promise 挂 `.catch`（记日志 + 解析 null）——任何
   world 失败只降级为 roster not-ready，不再 fail 整个 loader entry。
3. 补 `@modelcontextprotocol/sdk@^1.29.0` 进 dependencies（claude-agent-sdk 与
   @google/genai 的共同 peer，dev3 警告消音）。

**0.1.2 tarball 重验**（同验收拓扑）：active / LISTEN 4996 / 0 错误 / 6/6 mount 200 /
token 303、裸 401。

**dev3 重试**：

```bash
dsh plugin --profile web add super-dsh@0.1.2
systemctl --user restart dsh.service
```

若站点仍不可达，取 `journalctl --user -u dsh.service -n 80`（或对应 unit 日志）回传——
0.1.2 起任何 world 失败只会在日志里记一行 `[super-dsh] <key> world failed:`，宿主照常起。

## 九、0.1.3 热修（同日；dev3 无 agent selector 的根因）

**症状**：dev3 装 0.1.2 后服务起来了、Plugins 卡片可见，但侧栏底部**没有 runtime
selector**——而 4999 aw 线有。此前验收只覆盖了服务面（mount 200），没验浏览器面（selector
是 hub 的 client half，`sidebar.footer.action` 槽）。本轮回补浏览器面验收。

**根因（上游 `packages/client/modules` 源码实证，两处叠加）**：

1. **subpath row 永不注册 client half**：client-module 扫描对每个 loader row 调
   `exactPackageSpecifier(name)`——`super-dsh/hub`、`super-dsh/world/omp` 这类带子路径的
   名字解析不出包名，源码注释原文「subpath entries (…/gateway) land here — permanently
   not a client row」。better-dsh 能出卡片+组件，是因为它有一条**裸名 row**
   （`name: 'better-dsh'`）承载 client 注册。0.1.2 的 composite patch 全是子路径 row →
   super-dsh 的 client half 从未进模块表（实测 combo 列表里无 `super-dsh/client.js`）。
2. **注册按 build 时烧死的 id 配对**：浏览器 loader 用
   `pendingQueue.findIndex(r => r.id === <graphId>)` 配对；graph row id = 组合包名
   （`super-dsh`），而 hub 的 client bundle 烧死的 id 是 `@pgmi-builds/agent-hub`——即便
   注册了也对不上。4999 线没这个问题，因为那里组合包就是 hub 自己，两 id 天然一致。

**0.1.3 修正**：

- composite patch 增加**裸名 row**（`- id: agent-hub, name: 'super-dsh'`；根 exports
  `.` → agent-hub/dist/index.js）承载 client 注册；world/join 子路径 row 维持服务面职责。
- 新增 `super-dsh/client/index.js`：专用 client bundle（agent-hub/scripts/
  build-superd-client.mjs，同 closure-factory 配方，**id='super-dsh'**）；exports
  `./client` 改指它。hub 自带 lib/client（id=@pgmi-builds/agent-hub）留给 dev 线直挂。

**验收（0.1.3 tarball，含浏览器面探针）**：active / 0 error / 6/6 mount 200 **且**
combo 列表含 `super-dsh/client.js`、batch 内容含 `id: "super-dsh"` 与
`sidebar.footer.action` 槽位挂载——selector 配对链完整。

**dev3 消费**：`dsh plugin --profile web add super-dsh@0.1.3 && systemctl --user restart
dsh.service`。旧 `@pgmi-builds/superd@0.1.0` 是无 bundle 的惰性依赖，与本缺陷无关，
清掉纯属卫生：`dsh plugin --profile web remove @pgmi-builds/superd`。

## 十、0.1.3-a/b/c（同日；dev3 实机排障轮 + 版本纪律）

**user 裁决（版本纪律）**：测试迭代一律字母后缀（`0.1.3-a/b/c…`，better-dsh 先例
`0.2.3-g`），不再烧补丁号。**dev3 实机可达**：`ssh dev3`（webui 本机 127.0.0.1:3080；
dsh.dev3 域名有 Caddy IP 白名单，机内 egress 也 403，不作为验收通道）；机上 pnpm =
`corepack pnpm@10.33.2`（默认 corepack 是 v11/store v11，profile 树是 v10 store，版本必须钉）。

**0.1.3-a（world scope 饥饿修复）**：0.1.3 在 dev3 上 worlds 全挂。journal 实证两级根因：
①profile 自己的 pnpm 树里有一个 **2 条目的残缺 `@deepseek-ai` scope**，provisioner 的
resolve.paths 走查链先撞它（链接 → 残缺 scope → 世界树饿死）；②换成 home farm 后仍缺
16 个新包（farm 244 vs 安装树 260——0.1.6 新增 ptc-runtime/image-offload/mcp-resources 等；
ctx0 靠 app-boot 的安装锚 resolve 回退活着，显式 bare base 的世界树没有该回退）。**修**：
world 的 `@deepseek-ai` 改**真目录 + 逐包符号链接并集**（farm 先、安装树 `dirname(ANCHOR)
/node_modules/@deepseek-ai` 补缺；dev3 实测并集 269 条）。坑：pnpm `file:` 同名同版本
不重取——`0.1.3-a` 装第二次是 no-op，**每轮迭代必须换字母**。

**0.1.3-b = a 的重发**（同码，破 pnpm file: 缓存）。dev3 实证：world scope 269，
world-failed 从 6 → 1（只剩 pi）。

**0.1.3-c（prod-home 守卫错杀消费者）**：pi world 挂于
`pi-home: refusing prod home as pi state dir: ~/.dsh/agents/pi`——7 个 adapter、13 处
`assertNotProdHome` 把**本仓红线**（dev 机的 `~/.dsh` = Dash Agent prod）当成了普适约束；
消费者机的 `~/.dsh` 就是其真实 dsh home，`<home>/agents/<label>` 正是 S3/S7 设计布局。
**修**：红线改 opt-in——`SUPERD_DEV_REDLINE=1` 时守卫生效（dev 线 bootstrap
smoke.mjs 已设），发布态信任宿主 home。五个 adapter 重建。

**dev3 终态（registry `super-dsh@0.1.3-c` 实装，journal 验证）**：installed 0.1.3-c /
service active / **world-failed 0** / Cannot find package **0**；六 mount 经 carrier 认证门
应答（shell 内 token 舞步受限，浏览器会话为终验）。顺手清掉 `@pgmi-builds/superd@0.1.0`
惰性依赖（`pnpm remove`，restart 后 world-failed 仍 0；profile 依赖余
task-board / better-dsh / super-dsh）。

**验收方法论修正（固化为规）**：dsh 插件类改动一律**目标机实装验收**（ssh dev3 →
tarball `corepack pnpm@10.33.2 add file:` → restart → journal world-failed 计数 + mount
探针），本仓 .tests 实例只作 rc.2 基线的先期冒烟。
