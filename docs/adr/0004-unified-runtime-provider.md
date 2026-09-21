# 统一 RuntimeProvider，不设 passthrough/translate 类型分裂

所有 adapter 实现同一接口，不区分"透传型/翻译型"。今天 DSH adapter 是 wire 级逐帧转发，但它与其他 adapter 在注册面、selector、UI 消费层完全同构；将来上游 DSH breaking change 时，翻译逻辑收进 DSH adapter 内部消化，下游消费层零改动。若引入类型分裂，等于把"当前的实现细节"固化为"架构分类"。
