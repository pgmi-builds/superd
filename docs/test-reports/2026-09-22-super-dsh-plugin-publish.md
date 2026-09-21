# 2026-09-22 — super-dsh（Agent Worlds 线）dsh 插件化发布实测报告

**发布物**：`super-dsh@0.1.0`（unscoped，dsh 插件/composition 面）+ 7 个 scoped 依赖包
`@pgmi-builds/agent-hub@0.1.0`、`@pgmi-builds/agent-adapter-{omp,codex,claude,pi,hermes,agy}@0.1.0`。
**授权**：user 本会话明确指令「publish the `super-dsh` as super-dsh, unscoped, available, this time
make it `super-dsh` (the ./super-dsh alone) is a dsh plugin」（三闸之放行闸；实测与报告见下）。
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
