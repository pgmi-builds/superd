# Teleport 包装深度实测报告（第九轮：进程要包装到什么程度）

- **日期**: 2026-09-19（实测执行于 2026-09-21 凌晨会话）
- **定位**: 实验报告 + 后续实验协议；回答主文档 §十二 的包装深度阶梯问题，为主设计文档 `2026-09-19-teleport-design.md` 的 L 级阶梯提供第一批实测数据
- **场地**: PC（本机，Ubuntu x86_64，Wayland）↔ dev2 / dev3 / dev4
- **产物**: `.scratch/teleport-exp/l0-dev3.png`（远端渲染回流的首个工件）

---

## 一、场地侦察（2026-09-21 实测）

| 机器 | 架构/系统 | 浏览器 | Xvfb | docker/lxc | 延迟（SSH 会话 / ping） |
|---|---|---|---|---|---|
| PC（本机） | x86_64 Ubuntu | chromium + chrome + firefox | ✓ | docker | — |
| dev2 | x86_64 Ubuntu 24.04 | google-chrome | ✓ | ✓/✓ | ~0.7s 会话 / ping **49.6ms** |
| dev3 | x86_64 Ubuntu 26.04 | chromium + google-chrome | ✓ | ✓/✓ | ~0.7s 会话 / ping 被滤（≈50ms 级） |
| dev4 | **aarch64** Ubuntu 24.04 | **无** | 无 | ✓/✓ | **~2.8s 会话**（≈500ms+ 级） |

侦察即产出三个天然样本：dev2/dev3 = 深度桥接靶机；dev4 = **fail-close 活样本 + 架构异构活样本**（arm64，验证 §10.3 的 A 线架构免疫主张）。

注意：SSH 会话耗时（0.7s/2.8s）含握手 2-3 个 RTT 与认证——**不是**持久连接上的单操作延迟（见 §三 L1 实测）。

## 二、实验阶梯设计

| 级 | 形态 | 本地 CPU 跑什么 | 远端是什么 | 验证的问题 |
|---|---|---|---|---|
| L0 | 命令直传（CLI passthrough） | 无 | 一切（运行时+浏览器+产物） | 最浅桥接即可用吗？fail-close 形态？ |
| L1 | 本地客户端 + 远端浏览器（CDP/sock 隧道） | 编排逻辑（curl/Playwright 驱动） | Chromium（物理世界） | 「Chromium 的位置决定哪台电脑」 |
| L2 | L1 + 一致性审计 | 编排 + 本地 FS 触碰 | Chromium + 产物 | split-brain 在哪发生（mirror 问题） |
| L3 | 全进程包装（bwrap + sshfs + DISPLAY/env/net 重定向） | **整个工具进程**，但 touchpoint 全远端 | 环境本体 | 一个进程要包到多深才能「像在远端执行」 |
| L4 | 对照组：B+ Docker 载体 | 无 | 全部 | 传输账实测 |

## 三、L0 实测：命令直传（已验证 ✓）

```
ssh dev3 'google-chrome --headless=new --no-sandbox --screenshot=/tmp/teleport-l0.png \
  --window-size=1024,768 --virtual-time-budget=8000 https://example.com'
# → 19422 bytes PNG（1024x768）写入 dev3 /tmp
# → scp 回流 PC，zai-vision 确认渲染正确（Example Domain 标题/正文/链接齐全）
```

- dbus/UPower 报错为服务器无桌面服务的装饰性噪声，不影响渲染。
- **fail-close 样本（dev4）**：`google-chrome: command not found`——诚实错误形态到手。映射到设计：`E_UNSUPPORTED {capability: browser.cli, reason: chrome-not-installed, hint: "apt install chromium-browser（arm64 有包）"}`。**且 agent 手里有 dev4 的 shell——它可以自己修**（自愈回路，§11.3 的实测佐证）。

## 四、L1 实测：本地客户端驱动远端浏览器（已验证 ✓）

```
dev3:  setsid google-chrome --headless=new --remote-debugging-port=9222 \
         --remote-debugging-address=127.0.0.1 --user-data-dir=/tmp/...   # 常驻，脱离会话存活
PC:    ssh -N -L 19222:127.0.0.1:9222 dev3                              # sock 隧道（§4.10 sock 域实形）
PC:    curl http://127.0.0.1:19222/json/version                          # ✓ Chrome/147.0.7727.137
PC:    curl -X PUT ".../json/new?https://api.ipify.org"                  # ✓ 远端开 tab 并导航
```

- **导航在 dev3 执行**：tab 属于 dev3 的 Chrome 进程，页面抓取走 dev3 的网络栈。
- **egress 身份实测**：PC egress = `123.203.190.98`，dev3 egress = `187.127.111.29`——「瞬移后网络身份属于环境」有了具体数字。
- **Playwright 的接入点就是这条隧道**：`chromium.connectOverCDP('http://127.0.0.1:19222')`——browser-use 全功能栈无需任何改造即可落到此形态。

**单操作延迟（持久连接上 5× /json/version）**：`0.103 / 0.101 / 0.098 / 0.158 / 0.399s`——典型 **~100ms/op**，与主文档 §4.1 的 WAN 预估（40–80ms + SSH channel 开销）吻合；单次 398ms 尖峰提示需关注长尾（T3 的 readahead/批处理正是对策）。

## 五、阶段性结论（映射回设计裁决）

1. **L0/L1 零自研协议即通**：今天 SSH + chrome + curl 就跑完了「最浅桥接」与「sock 域 + CDP」两级——§4.10 的判断（CDP 隧道成本极低、可随 T2 早落）被实测确认，甚至比预期更早：**不依赖 teleportd 也能先通**（teleportd 的价值在原语面统一、jail、审计与常驻管理，不在连通性本身）。
2. **browser-use 解剖**（回答第九轮问题）：编排层（LLM 工具逻辑）→ Playwright 驱动 → Chromium。**Chromium 在哪，浏览器触碰的物理世界（profile/downloads 的 FS、display、egress）就在哪**；Playwright 驱动在哪只决定编排延迟。L1 让 Chromium 落位远端、编排留本地——正是 A 线的标准形态。
3. **mirror 问题的实测面**：对等不需要「本地也建一个 sock」——本地只需要一条到环境实例的解析路径（隧道即最小实现）。一般化：**资源类别镜像**（FS/exec/net/display/sock 五类 touchpoint 全部解析到环境实例）是必要充分条件；机制一一映射（sock↔sock）只是其充分实现。
4. dev4（arm64、无浏览器）证明：fail-close 的错误形态是可用信息而非终点——agent 可自装浏览器修复。

## 五、阶段性结论（映射回设计裁决）

### L0.5 代码运输实测（2026-09-21）

**形态**：把 730 字节 Python 脚本经 `ssh dev3 'python3 - /usr/lib "import os"' < script.py` 作为**原文字面量**运输，远端执行目录树扫描：

```
files=37581  scanned_bytes=933,143,904  hits=1305  duration=26.97s
本地 CPU: user 0.012s / sys 0.008s（几乎为零）
```

- **运输比 ≈ 1.3×10⁶ : 1**（730B 代码 vs 933MB 数据未过网）。
- **反事实对照**（FS 桥接同任务）：37,581 文件的 WAN stat/read 往返 + 933MB 传输 ≈ 半小时量级——放置法则差距 80x+ 且随延迟扩大。
- 脚本首运即踩一个 bug（str pattern vs bytes line）→ 修正 → 重运：**代码即文本**的迭代回路在实测里自然发生（模型改 1 行、重运 730B，成本可忽略）。
- 结论：主文档 §12.6 放置法则（TB-12）的实测支撑；bash/heredoc 即 v0 的代码运输 RPC，零新机制。

## 六、后续实验协议（待执行）

- **L2 一致性审计**：L1 隧道上跑一段 Playwright 脚本：下载文件 → 读该文件路径 → 观察 split-brain 点（下载落在 dev3 FS，本地 read 失败）。产出：工具清单中哪些必须走远端解析的精确边界。
- **L3 全进程包装**：`bwrap --bind sshfs-mount / --dev /dev --proc /proc ...` + `DISPLAY=dev3:0` + env/cwd 重定向，本地跑同一 browser-use 命令，逐层加包装直到行为与远端不可区分。**这是「进程要包到多深」的直接测量**——预期结论：FS + display + egress 三类 touchpoint 覆盖后即可达成 90% 不可区分，proc/socket 边角由 fail-close 兜住。
- **L4 对照**：B+ 全量（docker commit/payload rsync 往返计时），补 §9.2 的传输账。
- dev2 复测 L0/L1（排除单机特异性）；dev4 跑自愈路径（apt 装 arm64 chromium → L0 复通）作为 fail-close→self-remediation 完整回路的演示。

## 七、运维注记

- 本机 sandbox 会回收 `ssh -f` 守护进程——长连隧道须用托管后台作业（job 制）持有，或将来交给 link manager 常驻。
- 系统级 `/etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf` 权限异常导致 ssh 拒跑，绕法 `ssh -F ~/.ssh/config`（记录在案，勿修系统文件）。
