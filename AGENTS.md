# Super D (superd) — 拓扑与 Dev/Test 约定

本文件是 agent 指引的一站式契约：操作红线、定位速查、上游基线与对齐纪律、dev/test 路径、规划工作流、当前仓状态。词汇表见 `CONTEXT.md`；设计正本见 `docs/`。

---

## 〇、Development Operation Contract — 红线

0. **生态即产品（Ecosystem-is-the-product；2026-09-22 user 裁决，最高优先）**：在 Node 生态里，写代码 ≠ 开发完成。依赖图、包管理器行为（npm pack 规则、pnpm store/linker/`file:` 语义）、解析算法（exports、node_modules 走查、symlink realpath）、交付通道（registry → 消费者安装），全部是产品本体的一部分。三条铁律：
   - a. **验收必须走交付形态、上目标环境**——本地源码树跑通只是冒烟；插件类改动一律目标机实装验证（dev3：tarball `corepack pnpm@10.33.2 add file:` → restart → journalctl `world failed` 计数 + mount 探针）。
   - b. **dev 脚手架不得含有交付物将不具备的任何机制**——凡是 farm、链接、硬编码路径曾替代码遮过丑的地方，就是埋雷清单；开发形态 = 交付形态（4999 线跑 pack 出来的 tarball，见 `super-dsh/AGENTS.md`）。
   - c. **业务代码永不迁就开发流程**——测试纪律（test home、禁碰 prod home）由 launcher/测试夹具强制执行；出现在 `src/` 里就是缺陷（先例：13 处 `assertNotProdHome` 守卫杀死 home 为 `~/.dsh` 的消费者，2026-09-22 已全数删除）。
1. **npm publish 前置条件，缺一不可，顺序不可换**（先例：npm 发了就发了，撤不回）：
   - a. **第一人称实测通过**：真实运行时里走通改动路径（起 4999 实例 + 浏览器/curl 实测）。进程没崩、单测绿、tsc 0——这些是构建卫生，**不是验收**。
   - b. 实测结果落报告（`docs/test-reports/` 惯例）。
   - c. **user 明确确认放行**（实测通过 ≠ 放行，两道独立闸门）。
   - d. **版本纪律（2026-09-22 user 裁决）**：测试/修复迭代一律字母后缀（`0.1.3-a/b/c…`，better-dsh 先例 `0.2.3-g`）；补丁号（`0.1.4`）与新 minor 只留给**真实 feature 发布**。pnpm 对同名同版本 `file:` 依赖静默 no-op——每次迭代必须换字母。
2. **验收标准与改动点同类**：改「运行时行为」就用「运行时行为」验收，不得降级为进程活性或静态证据。
3. **未经 user 单次明确同意，不得 `npm publish`**；授权粒度单次有效。
4. GitHub 侧（commit/tag/push）可逆，跟随上述节奏，不抢跑。
5. **上游源码零修改**：依赖全部 exact-pin，改动一律走 patch 层（`cordis.patch.yml`）/自有插件；vendor 保护机制（`superd vendor verify/restore`，蓝图 §5）落地后强制启用。

---

## 一、这是什么（定位速查）

- **superd = 独立 App（最小 cordis 宿主）**，不是 dsh 的插件/profile/fork。桥接层：把本机与远端已有 Agent 运行时映射到 DSH Web UI 可消费的数据面；**自己不跑 agent、不存原始会话**（唯一持久状态 = pairing 表）。
- 双包结构：根 `superD`（CLI `superd`）+ `packages/superd-web-bundle`（web 面 bundle：载体 + 中性底座 roster patch + 胶水插件）。后续 per-runtime 对偶包：`@pgmi-builds/agent-adapter-*`（数据面）+ `@pgmi-builds/agent-ui-*`（呈现面）。
- 命名纪律：App 名 Super Dash / 品牌 Super D / 代码与 CLI `superd`（无空格连字符）；上游 UI 内 DSH 字样原样保留（品牌原则：仅自研代码用 Super D 品牌）。
- 设计正本：`docs/00-blueprint.md`（v0.4a）+ `docs/01-component-boundaries.md`（v0.3）+ `docs/adr/0001–0007` + `CONTEXT.md` 词汇表。研究镜像 `docs/01–05` 簇**只读**（正本在 dashr 仓）。

---

## 二、上游基线与对齐（Upstream Baseline & Alignment）

- **版本台账（动态；格式 = `值 [updated 日期, provenance]`，尾部 `[]` 为下次更新位）**：
  - **dev 时点的上游版本**（`upstream/deepseek-harness` checkout，本仓唯一测试基准）：`dsh-v0.1.6-alpha.2` [updated 2026-09-22 对齐轮，**物理 checkout**：detached 到该 tag、浅克隆；与 npm/本机 prod/dev3 同版。三个 sanctioned 补丁重放顺利（tsdown.client.ts 直接过、unrun/storeDir 手插）。**0.1.6 破坏面（已移植）**：`agents.announce(agent, source)` 必填 source 且内联发 `agent/created`（手动 `agent/session-start` 发射已废）；`AgentPresetRoster` 新增必填 `modeSelectionEnabled`；boot 启动审计（StartupError）把「部分 entry 导入失败」从警告变硬失败。**checkout 基线的解析事实**：`@deepseek-ai` 闭包分散在各 workspace 包自己的 node_modules（apps/cli 只挂直接依赖 113 个；bundle/web-app 96、bundle/base 含 ptc-runtime 等）——super-dsh 的 world scope union 已加工作区枚举源（锚上溯 `pnpm-workspace.yaml` → packages/*/*、vendor/*、apps/* 的全部 scope；裸文件 ENOTDIR 已加目录守卫）。报告：`docs/test-reports/2026-09-22-super-dsh-plugin-publish.md` §十二] []
  - 上游 checkout 的**产物边界与 sanctioned 补丁集**：源 = **纯 src**（`apps/cli/{src,config,reference,tests}`、`packages/*/*/src`、`vendor/*`）+ 配置；构建产物 `lib/`/`dist/`、`node_modules/` 都在 `.gitignore` 里，只有 `pnpm install && pnpm run build` 之后才存在。它是 **pnpm monorepo**（`packageManager: pnpm@11.7.0` + `pnpm-workspace.yaml` + `pnpm-lock.yaml`；无 package-lock）。**三个允许的本地补丁（2026-09-14 user 放行；镜像 dsh-omp/dashr，除此之外零修改）**：① `pnpm-workspace.yaml` += `storeDir: /home/u1/workspaces/superd/.npm-cache/pnpm-store` + `verifyDepsBeforeRun: false`（pnpm 11 不读 `.npmrc`，用户级 store 在沙箱外只读）；② 根 `package.json` devDeps += `unrun@^0.3.1`（tsdown 0.22 config loader 需要，上游未声明）；③ `packages/client/tsdown.client.ts` 的 `REPOSITORY_ROOT` 改 `resolveRepositoryRoot()`（锚 `pnpm-workspace.yaml`，cwd 回退；unrun 会改写 `import.meta.url`）。跑源码 = `pnpm install`（**不是 `npm install`**）→ `pnpm run build`（`tsx scripts/build.ts` = native-system + lib(host/client) + web）→ `pnpm run dsh`；build 后也可直接 `node apps/cli/lib/bin.js`。node 引擎用系统的（`/opt/node-v22.23.2/bin/node`）[updated 2026-09-14] []。
  - 声明 pin（仓根 `package.json` / `package-lock.json`）：`0.1.3-alpha.2` [updated 2026-09-08，**物理文件**字面值，与运行时可能不一致] []。
  - 框架伴生：`@deepseek-ai/cordis@4.0.2`、`cordis-plugin-loader@1.0.3`、`cordis-plugin-include@1.0.7`、`schemastery@3.18.2`、`commander@15.0.0` []。
- **install 树 = 谁跑 launcher，谁就是解析源（2026-09-14 实测）**：`apps/cli/src/profile-boot.ts` 的 `INSTALL_ANCHOR = <运行中 dsh 的 package.json>`；启动时 `healProfilesModuleFallback({installAnchor})` 对 app 的 dependencies+peerDependencies 做 BFS，在 `$DSH_HOME/profiles/node_modules/<pkg>` 建 symlink 指向解析结果——**跑谁就指谁**（本机跑全局 dsh → 指全局 install；Docker / 自包含 → 指那份）。**同一 DSH_HOME 换 installation 的三条路**：① **自包含 dev base**：在 checkout 里 `pnpm install && pnpm run build`（带上面三个 sanctioned 补丁）→ checkout 成为 installation（2026-09-22 起仓根 farm 已删，无需再 heal 仓根链接；全局 prod 不动）；② 另一前缀装一份预编译包（`npm install -g --prefix ~/.local-dsh-<ver> @deepseek-ai/dsh@<ver>`）跑 `~/.local-dsh-<ver>/bin/dsh`——**无需任何源码补丁**，最省事的去全局依赖；③ profile 本地 pnpm 树物理装 `@deepseek-ai/*`（解析更近、胜过 fallback，但**违反单实例纪律**、重复 cordis/scope，仅当清楚后果时用）。**注意**：fallback 按 install generation 幂等重建，同一 `DSH_HOME` 混跑两种 installation 会来回改写 symlink——一个 DSH_HOME 只服务一种 installation。
- **版本事实（2026-09-14）**：alpha.2→rc.2 = 3170 文件、+104k/-18k（大周期）。`--host 0.0.0.0` 在 rc.2 被 CLI 硬拒（`packages/bundle/web-app/src/startup.ts`，RCE 安全门），但 webserver config schema 仍收 `0.0.0.0`（见 §三端口纪律）。
- **对齐轮程序（上游每发一版必跑）**：
  1. `git fetch --depth 1 origin tag <new-tag>` → checkout；
  2. diff 关键文件清单：`packages/boot/app-boot/src/{index,profile}.ts`、`packages/bundle/web-app/{cordis.patch.yml,src/*}`、`packages/boot/cmdline/src/index.ts`、`packages/client/connection/src/{browser-auth,rpc-host}.ts`、`packages/host/{frontend-static,webserver}/src/index.ts`、`packages/util/home-paths/src/index.ts`、`apps/cli/src/profile-boot.ts`、`vendor/*/package.json`；
  3. 无破坏 → 全仓 sed 换 pin（每包一行）→ `npm install --cache .npm-cache` → `npm test`；有破坏 → 更新受影响代码块与计划文档后再换 pin；
  4. 记录对齐结论（commit message 或 docs）；
  5. **换 pin / 装依赖后查 `@deepseek-ai` 单实例**：`npm install`（尤其子包内）会把 install 树符号链接重新物化为物理副本 → 双模块实例 → `dsh-scope` `kScope` 分裂（scope 全家桶症状）。检查命令见 §三（现役 scope = `.tests/profiles/node_modules/@deepseek-ai`；旧 heal 修复脚本已随 2026-09-22 housekeeping 移除，出错时手工重链 symlink）。

---

## 三、Dev/Test 约定

- **依赖解析 = 单一 install 树（2026-09-22 更新）**：`$DSH_HOME/profiles/node_modules`（dsh 自带 installation fallback，现 = `.tests/profiles/node_modules`）指向 **repo 内 checkout build**（`upstream/deepseek-harness/{packages,vendor}/*`）——2026-09-14 起 dev base 即此 build；更早是全局 install（`/home/u1/.local/lib/node_modules/@deepseek-ai/dsh/...`）。**仓根 `node_modules` farm 已于 2026-09-22 housekeeping 删除**（原 heal 维护的 symlink farm，`scripts/heal-modules.mjs` 亦已删；若复活需重建，见本文历史版本）。**这是必需态，不是违规**（本文旧版「repo 本地 node_modules 是唯一依赖来源 / 禁止 symlink 全局树」已被 2026-09-10 实测推翻）。禁止的只是 NODE_PATH 顶替安装树。**单实例纪律**：任何 `npm install`（尤其子包内）都会把 `@deepseek-ai/*` 重新物化成物理副本 → 双模块实例 → `dsh-scope` `kScope` Symbol 分裂（症状：`file-upload: operation requires the Agent's own scope`、`agent-presets: refusing to compose an unscoped context`）。每次 install 后必查现存 scope：
  ```bash
  find .tests/profiles/node_modules/@deepseek-ai -maxdepth 1 -mindepth 1 ! -type l   # 只应剩历史物理遗留，新条目应为 symlink
  ```
  **`~/.dsh` 的 scope 除非有意，绝不指**。**仓根 `package.json` 刻意不声明 dependencies**：各线依赖由各线自己的 `package.json` / `node_modules` 负责（super-dsh 各 adapter 包自包含）。仓内缓存安装用 `npm install --cache .npm-cache`（默认 `~/.npm` 在沙箱下 EROFS）；exact-pin，无 `^`。
- **Test home / profile 路径**：dev/test 一律 `DSH_HOME=<仓根>/.tests`（gitignored；2026-09-22 由 `.superd-test` 改名）或 tmpdir。**绝不触碰 `~/.dsh`（Dash Agent prod）与 `~/.superd`**。profile 落位 `$DSH_HOME/profiles/<name>/`：`package.json`（`dsh.profile.bundles` 顺序 + `dependencies` 的 `link:` 本地包）、`cordis.patch.yml`（profile 用户层，**端口写在这里**）、`pnpm-workspace.yaml`（`nodeLinker: hoisted`、`autoInstallPeers: false`）。各线 bootstrap **自带在各自 `test/` 目录**（现役：`super-dsh/test/`；旧 `scripts/profiles/{ma,ctx0,ctx1-omp,m0}.mjs` 集中目录已随仓重排移除）；脚本幂等，**重跑即重建 profile 并重链 `link:` 本地包**。用户的 `DSH_HOME` 环境变量**永不被 superd 继承**（`src/home.ts` 契约）。
- **上游源码（upstream src）**：`upstream/deepseek-harness` @ **`dsh-v0.1.6-alpha.2`**（gitignored checkout，见 §二）；需要 diff 上游行为时进入，跑源码 = `pnpm install && pnpm run build && pnpm run dsh`（pnpm monorepo，**不是 `npm install`**）。**repo-local home（现 `.tests`，旧名 `.superd-test`）的线自 2026-09-14 起吃 repo 内 build**（checkout 已 install+build，`apps/cli/lib/bin.js` 即 installation）；⚠️ 带 `DSH_HOME=$HOME/.dsh` / `$HOME/.omp/omp-web` 的线（`archive/ui-preact`、`archive/react-codemod-to-lit`、`archive/multi-agent/agent-omp-sdk`，均已入库 `archive/`）**必须继续用机器全局 dsh，绝不可指向 repo build**——那个 installation 会把 prod home 的 fallback 重写成自己（触碰 `~/.dsh`，红线）。
- **端口纪律（user 恒以非 loopback 实测）**：
  - **4999 = 共用测试口 + live Caddy `test.pc.randomhash.app → 127.0.0.1:4999`**（`header_up Host` 重写 + 剥 `Origin`，无 gate）：绑 4999 的实例**任何场合用户都能看到**（`https://test.pc.randomhash.app/?token=…`）。代价 = 同一时间只能一条线占 4999；现役占用方 = super-dsh 线（2026-09-16 user 裁决，详见 `super-dsh/AGENTS.md`），react-lit 线曾用 4998。
  - **非 4999 端口**：用户看不到，需补一条路——(a) Caddy 加域名段（**未经明确批准勿改 live Caddyfile**）；(b) **socat 中继**（dashr §二惯例）：`/usr/bin/socat TCP-LISTEN:<port>,fork,reuseaddr,bind=<LAN_IP> TCP:127.0.0.1:<port>`，只绑 LAN IP、**绝不绑 0.0.0.0**（同口碰撞 EADDRINUSE），并把 `--trusted-host <域名>` / `DSH_TRUSTED_HOSTS` 带上（LAN Host 才过 /api fence）；(c) 走别的线的反代域名。
  - **勿用 config `host: 0.0.0.0` 当 LAN 手段**：CLI `--host 0.0.0.0` 在 rc.2 被硬拒（RCE 门），patch 层字面量 `0.0.0.0` 虽能绕过（schema 仍收），但那是 off-label 的 RCE 暴露面——优先 Caddy / socat。
  - 端口族：4996-4999 为 superd 多线占用（ctx0 / m0 / ctx1-omp / ma），拉起前 `ss -tln | grep -E ':(499[6-9]|309[0-9])'` 查占用，冲突就换（4986 曾用）。
- **拉起 / 关停（sandbox-safe）**：**勿从 agent 沙箱 bash 直拉 daemon**（继承嵌套沙箱 → bwrap 探测失败 `SANDBOX_UNAVAILABLE`）。一律 `systemd-run --user`（沙箱内连 user bus 被拒，单命令 `danger-full-access` 升级）。配方：`WorkingDirectory`=仓根、`Environment=DSH_HOME=<仓根>/.tests`、`UnsetEnvironment=DISPLAY WAYLAND_DISPLAY`、日志 append 到 `.scratch/<unit>.log`、unit 名 `<线名>-<port>-test`。ExecStart 的 launcher：**repo-local home 的线 = repo build**（`/opt/node-v22.23.2/bin/node <仓根>/upstream/deepseek-harness/apps/cli/lib/bin.js --profile <name> --no-open [--trusted-host <h>]`）；**prod-home 的线 = `/home/u1/.local/bin/dsh`**（见上条红线）。**优先复用既有脚本，勿手搓**：现役模板族在 `super-dsh/test/`（`start-4999.sh`、`start-{codex,claude,hermes,pi}-app.sh` 等；端口预检 + token 提取 + LAN/中继开关）；历史模板在 `archive/*/test/`。关停 `systemctl --user stop <unit>`（**勿 kill**）。
- **典型启动链（历史参考：`archive/multi-agent/test/start-4999.sh`，ma 线已存档；现役以 `super-dsh/test/start-4999.sh` 为准）**：`bash start-<port>.sh` → ① `ss` 预检占用即拒 → ② 线自带 bootstrap 幂等生成 `.tests/profiles/<name>/`（`package.json` 的 `dsh.profile.bundles` + `cordis.patch.yml` 端口/host + `pnpm-workspace.yaml`）并 `pnpm install`（hoisted；`@deepseek-ai/*` 靠 fallback 不在 profile 树里）→ ③ `systemd-run --user --unit=<线>-<port>-test -p WorkingDirectory=<仓根> -p Environment=DSH_HOME=<仓根>/.tests -p Environment=PATH=… -p StandardOutput/Error=append:<log> <node> <dsh> --profile <name> --no-open [--trusted-host …]`——argv = **`node <dsh launcher js>`**（`node=/opt/node-v22.23.2/bin/node`；`dsh` = **repo build** `$REPO/upstream/deepseek-harness/apps/cli/lib/bin.js`，`SUPERD_DSH` 可覆盖，缺 build 才回落 `/home/u1/.local/bin/dsh`；shebang 被显式 node 调用绕过）→ ④ 轮询 `ss` 等监听 + 只取本次日志水位后的 token → 打印 local/lan/wan URL。（历史链中的 `scripts/profiles/ma.mjs` 与 `scripts/heal-modules.mjs` 重链步骤已随 2026-09-22 housekeeping 移除。）**进程内接着**：`runCli()` → `runProfile()` → `loadProfile()`（读每个 bundle 的 `dsh.bundle.patch`）→ `healProfilesModuleFallback()`（**这一步把 `$DSH_HOME/profiles/node_modules` 钉到当前 installation**）→ `composeEntries()`（bundle patch 依序拍平 + profile patch + `--patch`）→ `boot()` 挂**唯一的 `cordis:include` 根** → Loader 按 `name` 逐个 import/apply → `webserver` 行绑定端口并打印 token（`--no-open` 抑制开浏览器）。
- **token / 认证**：token 每次启动轮换；从 append 日志取时先记 `wc -l` 水位，只在水位之后 grep `?token=…`（否则抓到上一轮）。curl 冒烟 `curl -c jar -L '<token-url>'`（303 靠 cookie 保认证）。存活探针：GET `/` 无 token/cookie → 401 `dsh web authentication required`。
- **验收模式（2026-09-09 user 裁决）**：起了 Web 服务器就停下来交给用户——给出 token URL（+ LAN/WAN URL）、**保持运行**，等用户亲手测完再收尾；不得自行 kill 完才报告。
- 测试/调试：各线 `npm test`；组合查看 `dsh --profile <name> --dump-config`（与 boot 共用同一 patch 算法）。

---

## 四、规划与执行工作流（Superpowers）

- 流程链：brainstorming（已完成：grilling 4 轮 → 蓝图 v0.4a + ADR 0001–0007）→ **writing-plans**（当前）→ executing-plans / subagent-driven-development。
- 计划落位：`docs/superpowers/plans/YYYY-MM-DD-<feature>.md`；TDD bite-size 任务，每任务独立可测交付 + commit。
- M1 计划序列：**P1 骨架+宿主（计划就绪）** → P2 Machine/Pairing/Selector → P3 DSH adapter 全透传 → P4 OMP adapter → P5 DEV3 remote + 半构建验收。
- 决策落档纪律：设计裁决进蓝图 §9 决策表/ADR；开放问题关闭用蓝图 §11 划掉格式；计划内决策记录在任务 Interfaces。

---

## 五、Repo 状态（2026-09-22 快照，apps/ 退役重排）

- **主线 + 存档布局（2026-09-22 housekeeping，user 四项裁决落地）**：`super-dsh/` = **主线**（原 `apps/agent-worlds`，Agent Worlds 融合线：`agent-{agy,claude,codex,hermes,hub,omp,pi}` adapter 包 + `test/` 启动脚本族；局部规则见 `super-dsh/AGENTS.md` 与 `agent-adapter-dev-rules.md`）；`archive/` = **存档线**（`multi-agent/`（git-tracked）、`multi-agent-ctx/`（冻结）、`ui-preact/`、`ui-lit-compile/`、`react-codemod-to-lit/`）——**`apps/` 目录退役删除**（连带清除 `apps/.npm-cache` 469M 旧缓存）；`.tests/` = **dev/test home**（原 `.superd-test` 改名，809M，gitignored；`aw/` 历史 home、`agents/<label>/` world home、`profiles/<label>/`）；`.worktrees/` = 未来 dev worktree 落位（git 排除）；`upstream/` = 上游 checkout（dev base）；`docs/` 设计正本齐备（blueprint / boundaries / adr / superpowers plans / test-reports）。**已删**：根 `node_modules/`（heal farm 1.2M）、`scripts/`（profiles bootstrap + heal-modules.mjs，bootstrap 回归各线 `test/`）。根 `package.json` 仅占位（无 dependencies、无 scripts）。git 排除分工：`.gitignore` = `.tests/`、`node_modules/`、`upstream/`、`.npm-cache/`、`.dsh_better_edit/`；`.git/info/exclude` = `.scratch/`、`.worktrees/`、`archive/`、`super-dsh/`（exclude 不影响已 tracked 的 `archive/multi-agent`）。
- **运行态（2026-09-22 快照）**：housekeeping 时点 ps 未见本仓 dsh/bin.js 实例（4990/4999 端口有监听、归属未确认；起线前照旧 `ss` 预检）；3080 = Dash Agent prod、3081 = omp-web prod（同机其它仓，勿动）；4999 的 Caddy `test.pc` 指向保持。
- **上游 checkout @ `dsh-v0.1.6-alpha.2` 为 dev base**（2026-09-22 对齐轮 `pnpm install && pnpm run build` 全绿）：`upstream/deepseek-harness/apps/cli/lib/bin.js` 即 installation。**现役唯一 `@deepseek-ai` scope = `.tests/profiles/node_modules/@deepseek-ai/*`**（仓根 farm 已删；2026-09-14 的双 scope 态就此收编）。参考源 dsh-omp（OMP adapter 蓝本）与 dashr 仓在同机 `~/workspaces/`。
- 待决：`.agents/`（superpowers 技能目录）入库与否——user 裁决搁置（ignore）。

---

## 六、嵌套 AGENTS.md 约定（Nested AGENTS.md Convention）

子目录可放置自己的 `AGENTS.md` 承载局部规则；本节约定其组织、作用范围与优先级。

- **嵌套（Nesting）**：支持层层嵌套，但**每一层并非都必须有**——只在有实质内容的子目录放置（源码子项目，如 `super-dsh/`、`archive/multi-agent/dsh-multi-agent-registry/`）。根目录本文件是总纲（base），子目录只补充/覆盖本目录相关规则；中间层级无 `AGENTS.md` 则跳过，沿用最近上层。
- **作用范围（Scope）**：每个 `AGENTS.md` 只管辖其所在目录及所有子目录（subtree），不约束兄弟目录、不反向影响上层。
- **优先级（Precedence）**：对某文件，生效规则 = 从根到该文件路径上所有 `AGENTS.md` 的叠加；冲突时离文件最近的胜出（nearest wins）；用户在会话中显式给出的指令优先级高于任何 `AGENTS.md`。
- **定位写法（不写层级号）**：子目录 `AGENTS.md` 声明自身路径并指向上一层（无中间层则直指根目录），不写绝对层级号；后续更深的子模块若有本地需要，由其自行创建。
