# 06 — 包与基线更新指南（Package Update Guidelines）

> **适用对象**：superd 仓的两种"更新"——
> **A 线**：上游 dsh 基线对齐（`upstream/deepseek-harness` checkout 换 tag，dev base 重建）；
> **B 线**：自有包的构建与发布（现 `apps/*` 各线产物；未来 `packages/superd-web-bundle`、`@pgmi-builds/agent-adapter-*` / `agent-ui-*` 插件包）。
>
> **正例来源**：dashr（better-dsh）仓 2026-09-21 的 `0.1.5-rc.2 → 0.1.6-alpha.2` 对齐轮全链路实证（报告：dashr 仓 `docs/50_test-reports/2026-09-17-plugins页六组件拆分实测报告.md` §七）。
> **分工**：本文件是操作手册（how）；红线与版本台账在根 `AGENTS.md` §〇/§二/§三（what & 现状），冲突以 AGENTS.md 为准。
> 写作时点：2026-09-21。上游基线 = `dsh-v0.1.5-rc.2`（现行值以 AGENTS.md §二台账为准）。

---

## 〇、总则

1. **对齐轮独立成轮**：上游换版是一次独立的 change——独立 commit、独立报告（`docs/test-reports/`），不与任何特性混车。对齐没落地前不开新特性。
2. **双版本面必须一起看**：本仓有两处"dsh 版本"——① `upstream/deepseek-harness` 的 checkout tag（dev base，谁 build 谁是 installation）；② 仓根/各 app 的**声明 pin**（exact-pin 字面值）。换版时先动 ①，② 跟随换 pin，然后 **heal 单实例**。两处漂移是常态（声明 pin 可能滞后于 checkout），每次对齐轮把台账对齐一次。
3. **上游源码零修改**：checkout 里只允许 sanctioned 补丁集（AGENTS.md §二清单；本次对齐可能新增，逐条记台账），其余改动一律走 `cordis.patch.yml` / superd 自有代码。
4. **升级 prod 级部署前先在 dev base 预演**：同版本 checkout → 全链路验证 → 报告，然后才谈对外发布（本仓 §〇 红线：第一人称实测 → 报告 → user 明确放行，三闸缺一不可）。
5. **多 workstream 并存纪律**：本仓多线并行（apps/* 各线 + `.scratch/` 实验）。动共享面（upstream、`node_modules` farm、根 package.json）前先 `git status` + 看 `.scratch/` 隔离区；**别人的未跟踪文件只隔离、不删除**（dashr 实证：另一 workstream 的未跟踪文件可让 pristine tag 构建整体失败，隔离到 `.scratch/<name>-quarantine/` 后构建即恢复）。

---

## 一、A 线：上游基线对齐操作程序

### 1. 预检（checkout 之前）

```bash
cd upstream/deepseek-harness && git status --short   # 应干净；有本地残留先甄别
git -C . log --oneline -1                            # 记住当前 tag 基线
```

- 上游 checkout 是**浅克隆物理 checkout**（AGENTS.md §二），确认无 worktree 漂移、无未跟踪文件。
- 仓根 superd 侧：确认 `node_modules/@deepseek-ai` farm 现状（`find node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l` 只应剩本仓自有物理包），对齐后要复核。

### 2. 换 tag 与补丁重放

```bash
git fetch --depth 1 origin tag <new-tag>
git checkout <new-tag>
```

- **勿盲 stash pop**：tag 之间 `pnpm-workspace.yaml`、`apps/web/package.json`、`pnpm-lock.yaml` 常有**实质 diff**（0.1.5→0.1.6 实证）。本地 patch 按**手解清单逐条重放**；`pnpm-lock.yaml` 一律 `git checkout HEAD --` 丢弃，由 `pnpm install` 重新生成。
- **sanctioned 补丁重放清单**（superd 现行三条，逐条核对是否仍适用 + 是否需要新增）：
  1. `pnpm-workspace.yaml` += `storeDir: /home/u1/workspaces/superd/.npm-cache/pnpm-store` + `verifyDepsBeforeRun: false`（pnpm 11 不读 `.npmrc`；用户级 store 在沙箱外只读，EROFS）；
  2. 根 `package.json` devDeps += `unrun@^0.3.1`（本机 Node 22.22.1 无 native TS，tsdown 落 unrun loader 所需）；
  3. `packages/client/tsdown.client.ts` 的 `REPOSITORY_ROOT` 改 `resolveRepositoryRoot()`（锚 `pnpm-workspace.yaml`；unrun 的 bundle 级 define 会改写 `import.meta.url`，深路径下 manifest glob 全空）。
- 新 tag 若带 `allowBuilds`/build-script 策略变化（strictDepBuilds），需要谁的 build script 就显式列谁（dashr 侧先例：`zeromq: true`，kernel IPC 依赖）。

### 3. install + build

```bash
pnpm install        # pnpm monorepo，永远不是 npm install；store 已重定向
pnpm run build      # tsx scripts/build.ts = native-system + lib(host/client) + web
```

构建失败排查序（dashr 0.1.6 对齐轮实证顺序）：

1. **未跟踪外来文件**（他 workstream 的 src/registry 文件混进构建图）→ 隔离到 `.scratch/`；
2. **vendor/* 幻影包**（见 §二第 1 条）→ 违规目录/文件外移；
3. 仍不明 → `DEBUG=tsdown:*` 看真实 entry 解析。

### 4. 对齐后必做（缺一即不算完成）

1. **heal 单实例**：`npm run heal`（`node scripts/heal-modules.mjs`；`--dry` 先看后改）把仓根 `node_modules/@deepseek-ai/*` 与 `$DSH_HOME/profiles/node_modules/@deepseek-ai/*` 翻到新 installation。任何 `npm install`/`pnpm install` 之后都可能物化出物理副本 → 双模块实例 → `dsh-scope` `kScope` Symbol 分裂（症状：`operation requires the Agent's own scope`）。复合检查：
   ```bash
   find node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l   # 只应剩本仓自有物理包
   ```
   （⚠ 2026-09-21 检查时 `scripts/heal-modules.mjs` 不在盘上、`scripts/profiles/{m0,ma}.mjs` 处于已删未暂存态——另一 workstream 工作树。对齐轮前先恢复/重写该脚本，恢复途径：`git checkout -- scripts/profiles/`；heal 本体未入库，需从 `.scratch/` 或历史会话找回。）
2. **行为 diff 清单**：按 AGENTS.md §二.2 的关键文件清单 diff 旧 tag → 新 tag（boot/profile、web-app patch、cmdline、connection、webserver、home-paths、profile-boot INSTALL_ANCHOR、`vendor/*/package.json`），结论写进对齐报告。
3. **声明 pin 跟随**：仓根及各 app 的 exact-pin 换到新版本字面值（`npm install --cache .npm-cache` 刷 lockfile），再做一次 heal。
4. **台账更新**：AGENTS.md §二版本行按 `值 [updated 日期, provenance] []` 格式落格，尾部 `[]` 留下次更新位。
5. **报告**：`docs/test-reports/<日期>-<tag>-对齐报告.md`——含补丁重放清单（新增/删除了哪几条）、构建产物计数、冒烟结论（`pnpm run dsh` / `apps/cli/lib/bin.js` 拉起 + `--dump-config`）。

---

## 二、0.1.6 线实证陷阱表（换 0.1.6+ 前必读；全部 dashr 2026-09-21 实证）

| # | 陷阱 | 事实与处置 |
|---|---|---|
| 1 | **root `tsdown.config.ts` 的 `vendor/*` workspace glob** | `vendor/` 下任何**缺 package.json 的目录**被当幻影包（名字回落 `@deepseek-ai/dsh-root` → `Cannot find entry lib/types/{...}` → 全 build 死）；vendor 根下的裸文档文件更早就有 ENOTDIR/exit 236 坑。**vendor/ 只许放带 package.json 的真包；文档一律外移 `.scratch/vendor-docs/`** |
| 2 | **未跟踪外来文件破坏 pristine 构建** | 另一 workstream 的未跟踪 src（dashr 案例：bun-compile 实验的 `bun-internal-bridge.ts` + `bun-registry/`）进构建图 → 模块找不到。**隔离不删除**：`.scratch/<name>-quarantine/`，构建完再回填 |
| 3 | **tag 间配置实质 diff** | `pnpm-workspace.yaml` / `apps/web/package.json` 跨 tag 必冲突 → 手解重放；`pnpm-lock.yaml` 永远丢弃重生成。0.1.6 的 workspace 策略（storeDir/allowBuilds/verifyDeps）与 0.1.5 不同构 |
| 4 | **Node 22.22.1 无 native TS** | tsdown auto loader 落 unrun → bundle 级 define 改写 `import.meta.url` → `REPOSITORY_ROOT` 必须显式解析（upstream CI 新 Node 看不到此问题，勿以"上游没这代码"为由删补丁） |
| 5 | **plugin-manager 新语义（0.1.6 侧栏 Plugins 页）** | 卡片**描述 = 包 package.json 的 `description` 字段**（不写 = 卡片无描述）；**"Components" = 该 bundle `cordis.patch.yml` 的 insert 行**（override 行不显示）；**"已安装"判定 = profile `package.json` 的 `dependencies` 声明**——测试 profile 即使是 symlink/link: 安装也必须声明版本条目，否则插件页卡片整个不出现 |
| 6 | **测试 profile 树是 symlink 生态** | 勿在测试 profile 跑 `pnpm install`——会把指向 monorepo 的 symlink 换成 registry 包。profile 的 `node_modules` 手工 symlink 指向 build 产物 |
| 7 | **web 构建走 workspace 内 vite** | `pnpm add` 之后 `npx vite` 会从根解析到 vite 8/rolldown —— web 构建一律 `pnpm run build:web`（workspace 内 vite），勿 npx 直呼 |

> 若行"浏览器侧 shell 需要 react 家族兼容"（superd 未来 ui 线大概率要）：dashr 的 preact 三件套补丁（`apps/web/vite.config.ts` alias 五条 → `preact/compat` + `resolve.dedupe: ['preact']` + `preact` 精确 pin devDep）可直接移植，见 dashr AGENTS.md §二 harness 本地 patch 第 3 条。

---

## 三、B 线：自有包的构建纪律

1. **canonical 源与部署副本分离**：canonical 保持 npm-range 的 `peerDependencies`（`optional: true`），**不锁 `workspace:*`**（发布语义）；内嵌/链接副本才做 devDeps 手术（`@deepseek-ai/dsh-*` = `workspace:*`）——pnpm 11 严格预发布 semver 下 npm-range 与 workspace 版本常不匹配（元组规则），autoInstallPeers 会落 registry 旧版 → 双身份 → tsc 品牌类型互斥。手术只在副本，canonical 不动。
2. **harness 依赖运行期全靠 host 自供**：插件的 `@deepseek-ai/*` 是 optional peers，运行期由 host ②③ 层解析；真实 `dependencies` 只放非 harness 自带库。不要给插件嵌套 `@deepseek-ai/*` 物理副本（版本偏斜负债 + 双 cordis 身份风险）。
3. **构建顺序陷阱（最高频翻车点）**：`tsdown` 默认 **clean `lib/`**——会连带抹掉 `lib/client/`。每次 host 半构建后**必须重跑 client 半**（`tsx scripts/build-client.ts` 直跑）；只跑 host 半 = 服务一个没有 client 半的插件（无 CSS/手势/卡片，症状是"功能整体消失"）。
4. **构建入口**：monorepo 内用 `pnpm --filter <pkg> exec tsdown`。裸跑 `node_modules/.bin/tsdown` 产出 `.mjs` 形态 → boot 即 `ERR_MODULE_NOT_FOUND lib/index.js`。
5. **cordis.patch.yml 写法**：insert 行（`{id, name, config, inject, disabled}`）= 插件页 Components 行 + 配置面；**后层同 id 整行重述（非 merge）**；`!!js` 表达式可读 `process.env` 与 loader 上下文，但**不能以 `[` 开头**（yaml 按 flow-seq 拒收）；schema 级 default 在插件加载期逐 key 填充并能穿透 overlay 层。
6. **包零 lifecycle script**（dashr 0.2.2-a 起的裁决方向）：kernel 供给走 spin-up/首用 lazy，不写 postinstall——带 build script 的版本在 pnpm strictDepBuilds 下要求 `allowBuilds`，是部署摩擦点。
7. **`files` 字段核对**：运行期 `readFileSync` 的资源（如随包发布的说明 md）必须列进 `package.json` `files`，漏列 = 模块期 ENOENT、插件加载即死。

---

## 四、B 线：发布与部署

1. **发布三闸**（本仓 AGENTS.md §〇，此处只列不辩）：第一人称实测通过（构建卫生 ≠ 验收）→ 报告落 `docs/test-reports/` → **user 单次明确放行**。`npm publish` 发了就撤不回；GitHub 侧可逆但同节奏，不抢跑。
2. **npm 供应链年龄门**：pnpm 11.7.0 自带 `minimumReleaseAge`（≈24h）策略引擎。**版本号形式的 exclude（`pkg@x.y.z`）只作用于解析相位，不盖锁文件校验相位**——新发布的包 24h 内任何 `pnpm install`/`add` 的锁校验都会再拦。**持久豁免 = 裸包名**：`minimumReleaseAgeExclude: ['<pkg>']` 全相位生效。
3. **升级用精确版本 add**：`pnpm add <pkg>@<exact>`，勿信 `@latest`（回落 + 静默覆盖部署位的坑仍在）。
4. **prod 部署正道 = user, just another user**：发布态部署从 registry 以普通用户方式装（npm/pnpm add 精确版本）；**手工 md5 同步仅限未发布的本地迭代**。升级前先在 dev base 预演同版本。
5. **微瑕攒批**：已发布版本的小瑕疵记录在案、攒进下一次批量发布，不为零碎微调烧版本号。

---

## 五、测试实例与验收要点

- 细则见根 AGENTS.md §三（端口纪律、launch 链、token/认证）。与"更新"直接相关的增量：
  - **token 每次启动轮换**：从 append 日志取 token 先记 `wc -l` 水位，只在水位之后 grep；
  - **两行环境必须带**（与 prod 对齐）：`DSH_TRUSTED_HOSTS`（/api fence + 插件 authorities 单源）、`UnsetEnvironment=DISPLAY WAYLAND_DISPLAY`（否则图形 env 下 directory-picker 选 native、zenity 弹在宿主桌面）；
  - **勿从 agent 沙箱 bash 直拉 daemon**（嵌套沙箱 → bwrap 探测失败 `SANDBOX_UNAVAILABLE`）——一律 `systemd-run --user`（沙箱内需单命令提权重跑同一条命令）；关停 `systemctl --user stop`，勿 kill；
  - **验收模式**：起了 Web 服务器就停下来交给 user——给 token URL（+ LAN/WAN 中继 URL）、**保持运行**，等 user 亲手测完再收尾；不得自行 kill 完才报告。

---

## 六、检查单

### 对齐轮（A 线）

- [ ] 上游工作树干净、旧 tag 记录在案
- [ ] 新 tag fetch + checkout（浅克隆约定保持）
- [ ] pnpm-lock 丢弃重生成；workspace/web-package diff 手解重放
- [ ] sanctioned 补丁逐条重放并核对适用性（新增/删除记台账）
- [ ] `pnpm install && pnpm run build` 全绿（失败按 §一.3 排查序）
- [ ] `vendor/` 下无缺 package.json 的目录/文件
- [ ] heal 单实例 + `! -type l` 复核
- [ ] 行为 diff 清单过一遍（AGENTS.md §二.2 文件清单）
- [ ] 声明 pin 跟随 + 再 heal
- [ ] 台账落格 + 对齐报告落 `docs/test-reports/`

### 发包（B 线）

- [ ] canonical peerDeps = npm range optional；副本手术只在其身
- [ ] host 半构建后 client 半重跑（`lib/client/` 在位探针）
- [ ] `pnpm --filter exec tsdown`（非裸 tsdown / 非 npx vite）
- [ ] `package.json` description + files 字段核对（插件页卡片描述 / 运行期资源）
- [ ] insert 行即 Components 行核对（override 行不上卡片）
- [ ] 第一人称实测 → 报告 → user 放行（三闸，顺序不可换）
- [ ] `minimumReleaseAgeExclude` 裸包名豁免在位；精确版本 add
- [ ] prod 部署走 registry 正道，dev base 已预演

---

## 附A：正本与镜像的关系

`docs/01–05` 簇是 dashr 仓 `docs/60_exploration-and-research/` 的**只读镜像**（2026-09-08 快照）。其中 `05-dashr-dev/upstream-alignment.md` 是对齐方法论的正本底稿；**0.1.6 对齐轮的新增教训（本文件 §二）后于该快照**， fresh 内容以 dashr 仓正本为准：

- dashr `AGENTS.md` §二（harness 本地 patch 全文 + 0.1.6 新坑）
- dashr `docs/50_test-reports/2026-09-17-plugins页六组件拆分实测报告.md` §七（0.1.6-alpha.2 对齐全记录）
- dashr `docs/specs/plugins-page-components/spec.md`（插件页卡片/Components 机制）

镜像集按 2026-09-08 惯例不追新；需要新知识时回 dashr 正本仓查，或经 user 决定重镜像。
