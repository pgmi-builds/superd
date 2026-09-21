# 上游版本对齐 Runbook（Upstream Alignment）

> **2026-09-06 蒸馏回写**：本文完整收编 `.agents/skills/upstream-alignment/SKILL.md`（行级保留全部流程与坑表）。
> 按 owner 裁决该 skill 属删除对象，**skill 删除后本文件为对齐轮的操作化文档入口**。
> 本 repo 是上游 dsh（deepseek-harness）的插件项目。上游每次发版后的适配流程固定如下；
> **先读根目录 `AGENTS.md`（一站式契约：prod 拓扑 / Dev-Test 1 4999 实例 / Dev-Test 2 / 供应链年龄门），本文件是"对齐轮"的操作化**。
> 核心原则：对齐轮只做"跟版本、验运行、记发现"，发现的问题一律记录为下一波 change，不在本轮顺手修 feature。

## S0 情报（可选但推荐）

- 上游 tag 间差异调研：npm tarball diff + `git diff <old-tag>..<new-tag>` + 仓内 `.agents/notes/implemented/` 设计笔记。
- 产出/更新 `docs/50_test-reports/upstream-dsh-<version>-report.md`（差异分析报告；既有先例：`upstream-dsh-0.1.2-alpha.5-report.md`）。

## S1 侦察（切换前必须）

```bash
cd ~/workspaces/dashr/upstream/deepseek-harness
git fetch origin && git ls-remote --tags origin | tail   # 目标 tag 存在性
# ① patch 载体文件 tag 间是否变动（决定 stash pop 是否干净）
git diff <old-tag> <new-tag> -- package.json pnpm-workspace.yaml packages/client/tsdown.client.ts
# ② dashr 副本引用的 @deepseek-ai/* 名字在新 tag 包集合里是否都在
#    （脚本比对 packages/better-dsh/better-dsh/package.json 的引用名 vs `git ls-tree -r --name-only <new-tag>` 里所有 package.json 的 name）
```

## S2 切换与 patch 重放

```bash
git diff > ~/workspaces/dashr/.scratch/<old-tag>-local-patches-backup.patch   # 备份
git checkout -- pnpm-lock.yaml            # lock 反正要重生成
git stash push -m "local patches" package.json pnpm-workspace.yaml packages/client/tsdown.client.ts
git checkout <new-tag>
git stash pop                             # 冲突则按备份 patch 手工重放
# 验证三 patch 在场：
grep -c '"unrun"' package.json
grep -c "storeDir\|verifyDepsBeforeRun" pnpm-workspace.yaml
grep -c "resolveRepositoryRoot" packages/client/tsdown.client.ts
```

## S3 副本地化（rsync 之后必查）

- **重删 stale peerDep**：副本 `packages/better-dsh/better-dsh/package.json` 里 `@deepseek-ai/dsh-client-runtime` 的 peerDependencies 行 + `peerDependenciesMeta` 条目（rsync 会从 canonical 带回；workspace 无此包、npm 无匹配版本，install 直接 `ERR_PNPM_NO_MATCHING_VERSION`）。
- `pnpm-workspace.yaml` `allowBuilds` 有 `zeromq: true`（kernel IPC 依赖；pnpm 占位符 = 硬错）。

## S4 安装 / S5 构建

```bash
set -o pipefail    # 管道 tail 会吞退出码，一律 pipefail
pnpm install       # store 已重定向 .scratch/pnpm-store；错误读全文，勿只看尾部
pnpm run build
pnpm --filter better-dsh exec tsdown     # 插件半边（勿在副本里 npm run build：prebuild 拷 ../docs 会失败）
# ⚠ tsdown 默认 clean lib/ —— 会连带抹掉 lib/client/！client 半必须重跑：
cd packages/better-dsh/better-dsh && ../../node_modules/.bin/tsx scripts/build-client.ts && cd ../../..
```

## S6 启动 4999 实例

```bash
systemctl --user stop dsh-4999-test 2>/dev/null   # 有旧实例先停
systemd-run --user --unit=dsh-4999-test \
  -p WorkingDirectory=/home/u1/workspaces/dashr/upstream/deepseek-harness \
  -p Environment=DSH_HOME=/home/u1/workspaces/dashr/.dsh-test \
  -p StandardOutput=append:/home/u1/workspaces/dashr/.scratch/dsh-4999.log \
  -p StandardError=append:/home/u1/workspaces/dashr/.scratch/dsh-4999.log \
  "$(which node)" --import tsx/esm apps/cli/src/bin.ts web --no-open --port 4999
# token 从 .scratch/dsh-4999.log 取；prod ~/.dsh 全程不动
# ⚠ agent 从沙箱会话重启必须走 systemd-run（沙箱内拉 daemon = 嵌套沙箱，
#    其 bwrap 探测必败 → agent bash 无沙箱后端）；沙箱内连 user bus 被拒时
#    单命令 danger-full-access 升级（见 AGENTS.md 启动/重启节）
```

## S7 冒烟清单

1. `DSH_HOME=… npm run dsh -- web --dump-config | grep -A3 dashr-repl`（工具行 + `DASHR_KERNEL_PYTHON` 注入）。
2. 工具面与上一版的差异（重点看上游报告标记的行为变化，例：alpha.5 的 web_fetch 默认开放）。
3. `curl -c jar -L '<token-url>'` → 根页 200 + 一个新构建 asset 200。
4. 客户端卡冒烟（若 dashr 有 client 产物）：鉴权拉 shell 页 grep `"id":"better-dsh"` 的 boot 行 → curl 其 `/plugins/??better-dsh/client.js&rev=…` URL → 200 且与 `lib/client/index.js` 字节一致；副本内构建一律 `tsx scripts/build-client.ts` 直跑（npm run 会死于 npm 自身的 workspace 枚举，见 AGENTS.md）。
5. **行形状漂移查表（三处，全在 dashr 侧有重述/依赖）**：① `packages/bundle/web-app/cordis.patch.yml` 的 `connection` 行（我们整行重述了 `name`/`inject`/`config`，`trustedHosts: !!js` 拼接扩展式——行形状变了重述要跟）；② `packages/client/connection/src/client/index.ts` 的 `__DSH_TRANSPORT__`/`ownsHost` 消费点（我们 off-label 用它翻 isLoopback——上游新增消费点 = 行为面变宽，需复核）；③ `packages/client/ui-layout/src/client/AppFrame.tsx` 的语义属性（`data-sidebar-collapsed` 等，mobile CSS 的选择器锚）。
6. **fence/isLoopback 双腿冒烟**（v0.2.1f 起）：daemon 带 `DSH_TRUSTED_HOSTS=probe.example` → `curl -H 'Host: probe.example' …/api/x` = **401**（过栅栏卡认证）vs `-H 'Host: evil.example'` = **403**；鉴权拉 shell 页 grep `__DSH_TRANSPORT__`（boot script 在场）+ application batch grep `data-sidebar-collapsed`（mobile 模块在场）。
7. 让 user/agent 在实例上做功能实测，UI 手工核查。
8. **zoomGuard 行形状查表（两处，boot script 依赖此前提）**：① `apps/web/index.html` 的 `<meta name="viewport">` 行——zoomGuard 的 stock 记录与 token merge 以它为基线（上游改 content 或自带 maximum-scale → merge 语义复核，同 key 覆盖仍幂等）；② `packages/host/webserver/src/injections.ts` 的 head 注入 splice 位置——注入脚本落在 `<head>` 开标签后、stock meta **之前**，zoomGuard 的 provisional-meta + MutationObserver reconcile 依赖该次序（上游若挪注入位置或 meta 位置 → 复核 reconcile 路径；stock 先于脚本在场时走直接改写路径，两路径都有单测钉住）。

## 报告与产出

- 实测报告 `docs/50_test-reports/upstream-dsh-<version>-local-test-report.md`，骨架沿用既有报告：实测范围与结果表 → 环境事实 → 重点观察 → 发现的瑕疵（定性 + 去向）→ 流程化产出 → Open items。
- 瑕疵 → 下一波 alignment change（区分：dashr 计划 feature vs user 私人 patch vs 真回归）。
- 约定/坑有新增 → 回写 `AGENTS.md`（它是一站式契约）。

## 已知坑速查

| 坑 | 处置 |
|---|---|
| rsync 带回 stale `dsh-client-runtime` peerDep | 每次 rsync 后重删（S3） |
| pnpm 11.7 `allowBuilds` 占位符 `set this to true or false` | 改成显式布尔（zeromq: true） |
| 管道吞 install/build 退出码 | `set -o pipefail` |
| pnpm 打完 `Done` 后子进程偶发不退出（11.7.0 边车） | Ctrl-C / kill 无损 |
| 供应链年龄门挡新发布插件（prod add 场景） | 精确版本 add，勿信 `@latest`（见 AGENTS.md） |
| dashr web UI 卡片半边（`build-client`）monorepo 内未跑 | 需要时单独补（`tsx scripts/build-client.ts`） |

## 蒸馏注记（2026-09-06）

- 与 skill 原文的差异仅为路径修正：实测报告实际归档于 `docs/50_test-reports/`（skill 原文写 `docs/upstream-dsh-…`）；插件包名统一为发布后的 `better-dsh`（skill 原文有 `@pgmi-builds/better-dsh` 旧名残留）。
- 流程内容与 AGENTS.md（Dev/Test 1 节）重叠部分以 AGENTS.md 为准；本文件保留逐步骤操作细节与两张"行形状漂移查表"（S7.5 / S7.8），这些在 AGENTS.md 中只有结论性提及。
