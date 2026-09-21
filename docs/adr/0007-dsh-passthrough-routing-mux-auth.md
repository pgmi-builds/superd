# DSH 面全透传 + routing mux；认证走服务端 token→cookie mint

2026-09-08 accepted（蓝图 v0.3 §3.6；决策 #20/#21）

session / workspace / settings 三面逐帧透传到目标 machine——superD 的 DSH UI 包与上游**锁死同版**
（无滞后），数据面契约逐字节一致，透传零翻译、上游新 feature 自动出现。superD 自有面
（machines / selector / pairing / TG bindings）由 routing mux 按 RPC method namespace 分流本地应答；
分界不在"哪些面透传"，而在"哪些 namespace 属于 superD"。

**否决前端直连上游端口**（方案二）：① remote runtime 无公网面，multi-machine 不可行（ADR 0002）；
② cookie 是 authority-bound 的，浏览器对 3090/3080 两套 authority 两套握手；③ 上游 `/api` 信任栅栏
要求 Origin 与 Host 同 authority，3090 页面跨源打 3080 被直接拒；④ 统一认证/审计/TG 复用被打散。

**认证（一手源码：client-connection/src/{browser-auth,rpc-host,api-request-trust}.ts）**：DSH launch
token 每次进程启动轮换，但仅用于一次性 mint HMAC 签名 cookie（`dsh-auth-*`，HttpOnly /
SameSite=Strict，默认 30 天）；签名密钥**持久**存于 DSH credentials store ⇒ **cookie 跨上游重启
有效**。adapter 服务端持 cookie jar 附带全部转发（loopback Host 天然过信任栅栏；认证这道 loopback
不免，靠的是持有 cookie）。

**否决 patch 上游去 token gate**：`BrowserAuth` 在 Connection 插件激活时无条件创建，config 仅
`trustedHosts / cookieMaxAgeDays / maxRequestBodyBytes`，无 auth-off 口；patch 违反 ADR 0005 的
"永不改上游源码"。

## Consequences

- machine token 仅首次配置或 cookie 过期（默认 30 天）时提供一次；DSH 重启不需要换 token。
- settings 按 machine 整体呈现；superD 自有 namespace 永不与上游 namespace 合并写入（跨边界
  `replace()` 是 CAS 灾难，写只走各自 namespace 内 path-op）。
- superD 自身浏览器面复用 client-connection 同款 token URL + cookie（浏览器↔superD 唯一认证面
  的 MVP 实现；authChain / Caddy 白名单前置）。
- 附带收获：GET `/` 未带凭证返回 401 + 特征响应体 `dsh web authentication required; reopen the
  URL printed by dsh web.`——零认证且带 DSH 指纹的存在性探针（蓝图开放问题 #4 已解决）。
