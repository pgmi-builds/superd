# Remote machine 仅 superD-to-superD

远端机器上必须有 superD 实例，本机 superD 只连远端 superD 的 URL，v1 不支持直连裸 runtime endpoint。理由：CLI 型 runtime（OMP、Claude Code 等）没有网络服务概念，跨机 RPC 根本无从发起；且只有 superD 能自描述"我有哪些 runtime 与 consumer"，UI 的 Local/Remote 层级列表天然成立。出站协议因此只有一种（我们自己的 wire 面），auth/Caddy 拓扑只需设计一次。将来确有需求再加 `kind: raw` 档。
