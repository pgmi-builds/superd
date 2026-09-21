# DSH Web UI 移动端（iOS Safari）输入体验研究 — focus 放大 / 键盘遮蔽（v2）

- 日期：2026-09-03（v1 初稿；v2 同日晚修订，含 TypingMind 逆向实录与裁决更新）
- 范围：DSH Web UI（`upstream/deepseek-harness` checkout，tag `dsh-v0.1.2-alpha.5`）在 iOS Safari 上的输入体验。**遵 user 2026-09-03 裁决：只解决 ①focus 放大、②虚拟键盘遮挡两个问题；左栏挤压会话区（原 D4）no-go** —— 那是框架级问题，改它是无底洞；侧栏弹出时内容完整即可，隐藏侧栏后自然回到会话区，挤压是暂时性的，由它去。
- 参照物：typingmind.com（逆向实录见 §2）；上游源码逐行取证；WebKit Bugzilla 现状核查（2026-09-03）。
- 关联：`docs/50_test-reports/v0.2.1f-plugin-shipped-ui-patches实测报告.md`（手势/mobile CSS 已发布态）、`ios-chat-app-bridge-research.md`（native 壳路线）。逆向工作产物：`work/typingmind-re/`（case: `work/typingmind-web-re`，reverse-skill offline-sample）。

---

## 0. 结论（TL;DR）

两个目标问题全部可在 better-dsh 插件内闭环，**零上游改动**。v2 关键更新：

1. **16px 论据已从"推断"升级为"实测"**：TypingMind 聊天输入框 **手机 16px / 桌面 14px**（CDP 活体测量，§2.3）—— 它不是"字体小也没事"，而是刻意在手机端维持 16px、桌面才降到 14px（Tailwind `text-base sm:text-sm`）。你看它"字也不大"是桌面印象。
2. **行业存在两条正路**（§3.2）：A) 移动端字号地板 16px（TypingMind 现行）；B) JS 在 iOS 窄屏把 `user-scalable` 翻成 `no`（**iOS 10+ 并不禁双指缩放，只杀 focus 自动放大**；Discourse 曾用 A 后整体迁移到 B，原因是 A 的视觉膨胀）。DSH 选 A/B/A+B 是待讨论的决策点。
3. **键盘问题存在两层事实**（§3.3）：浏览器内 Safari = 键盘 overlay 无 opt-out（WebKit 259770 仍 NEW），必须 visualViewport shim；**PWA standalone 态 = 引擎原生 resize（innerHeight/dvh 随键盘收缩）**，无需 shim —— 这就是 TypingMind 零键盘代码的原因（它的推荐移动形态是 PWA）。DSH manifest 已是 fullscreen，"推荐 PWA + 保留浏览器内 shim"可作组合策略。
4. **动态岛假设有真实对应物但不是本症状的机制**（§4）：WebKit 300523（iOS 26.0 仅动态岛机型，键盘关闭/滚动后 viewport 上移数像素侵入安全区，26.1 beta 已修，应用侧无法绕过）—— 证明"动态岛参与 viewport 计算出错"这类 bug 存在，但其症状是**几像素上移**，不是 120% 宽度放大；放大是 font-size 机制（16/14≈1.14 起步，与观察值吻合）。

---

## 1. 症状与根因（v1 取证维持有效，摘要）

### D1 — focus/JS 定位输入框 → 页面放大到 115–120%

- viewport：`apps/web/index.html:5` = `width=device-width, initial-scale=1`，全仓无 `maximum-scale`/`user-scalable` 处理。
- 字号：composer `.card { font-size: var(--dsh-content-font-size, 14px) }`（`InputBar.module.css:55`，`.input` 继承；contenteditable 锚点 `[data-composer-input]`）；`--dsh-content-font-size` 由 `ui-theme/src/boot-theme.ts:21` 写 body，**默认 14px**；permission/model 原生 `<select>` 13px。全仓可聚焦控件 13–14px，全部低于 iOS 16px 阈值 → focus 必放大。16/14 ≈ 1.14，与观察到的 115–120% 吻合。

### D2 — 键盘弹出时页面不上推，input 被 overlay 遮住

- WebKit 未实现 `interactive-widget`（[bug 259770](https://bugs.webkit.org/show_bug.cgi?id=259770)，2026-09-03 核查仍 NEW/P2/Nobody）→ iOS 浏览器内键盘 overlay layout viewport，无 opt-out。
- DSH 布局：`html/body/#root {height:100%}`（`client/web/src/base.css:6`）+ `.frame` grid overflow hidden，composer 在文档流底部 → Safari 只做不可控 page pan，经常 pan 不到位。
- 唯一引擎 API：`window.visualViewport`（`resize`/`scroll` + `height`/`offsetTop`/`scale`）。`100dvh` 无济于事（响应工具栏不响应键盘）。

### D3 — 切会话自动 focus（D1+D2 的连锁触发器，保留在方案内待裁决）

`InputBar.tsx` unlock effect：`useEffect(..., [locked, sessionId, editor])` → `editor.getRootElement()?.focus()` —— 注释原文 "Unlock (mount / session switch) returns focus to the box"。切会话/首载 hero 必触发程序化聚焦 = 无人请求的键盘 + 放大。桌面这是特性（键盘用户续打），移动端是 bug。**user 裁决聚焦两症状，D3 正是两症状在"切会话"场景的共同触发层**，修它属于两症状的修复范围，但是否要"移动端切会话后不聚焦"仍留作决策点（§6）。

### ~~D4 — 左栏挤压~~（no-go，user 2026-09-03 裁决）

不再处理。机制留档备查：`narrowExpanded` 仅跨 1024 断点清除；`computeColumns` sidebar 永不让步（`SIDEBAR_MIN=264`），center 吸收全部赤字。v1 里的 M4（点击 treeitem 自动收栏）随之撤销。

---

## 2. TypingMind 逆向实录（2026-09-03，work/typingmind-re）

### 2.1 分发形态定性：无 DMG，现行 = PWA only

官方 install 文档（docs.typingmind.com/install-typingmind-app）明示安装方式 = **PWA**：桌面 Chrome/Edge 地址栏安装图标、iOS Safari Add to Home Screen，"No app store, no download required"。历史上的 macOS app（changelog "MacOS app v1.15.0"，Setapp 渠道）已非现行分发。GitHub `typingmind/typingmind` 是 issue/docs 门面，应用本体闭源。**结论：web bundle（typingmind.com 的 Next.js chunks + PWA 全家桶）就是完整 app package** —— 逆向它 = 逆向完整应用。

### 2.2 静态扫描（149 个 JS chunk ≈11MB + 4 个 CSS，样本 tarball 已存 case）

| 检索 | 结果 |
|---|---|
| `visualViewport` | 仅 1 处，Floating UI 定位库内部偏移计算 —— **无键盘 shim** |
| `maximum-scale` / `user-scalable` / viewport 改写 | **无**（JS 与 CSS 均零命中） |
| `fontSize:"16px"` JS | 2 处 = Prism 代码高亮主题（噪音） |
| `safe-area-inset` | **真实使用**：CSS `env(safe-area-inset-bottom/left/right)`；JS 侧 workspace bar 高度 `calc(58px + env(safe-area-inset-bottom))`（chunk 3a4r…）—— 标准全面屏适配通道 |
| "dynamic island"/"notch" | 零真实命中（唯一 "notch" 是用户评价文案） |
| 表单基线 | Tailwind Forms 全局：`[type=text],…,textarea,select { font-size:1rem }` = 16px（无 html 根字号覆写） |
| PWA | manifest `display:standalone`；全套 iPhone/iPad splash；`apple-mobile-web-app-capable` |

### 2.3 活体测量（CDP 双宽度，google-chrome --remote-debugging-port + Node 22 原生 WebSocket，`Emulation.setDeviceMetricsOverride`）

主输入框 `<textarea id="chat-input-textbox">`，类名含 `text-base ... sm:text-sm`：

| viewport | computed font-size（#chat-input-textbox） | 机制 |
|---|---|---|
| 390×844（手机） | **16px** | `text-base`（1rem）生效 |
| 1280×900（桌面） | **14px** | `sm:text-sm`（≥640px 才降档） |

同页实测：viewport meta 活体值 `initial-scale=1, viewport-fit=cover`；搜索框 16px；根字号 16px（未覆写）。

**结论：TypingMind 对 focus 放大的对策 = 手机端输入面 16px（Tailwind 响应式降档手法）+ 不动 viewport meta + 无任何 JS 键盘/缩放处理。** 它的移动端键盘体验依赖 PWA standalone 的引擎原生行为（§3.3）。

### 2.4 行业演化旁证：Discourse PR #30877

Discourse 曾实现方案 A：`--font-size-ios-input: max(1em, 16px)`（其注释原话 "inputs/textareas in iOS need to be at least 16px to avoid triggering zoom on focus"），后整体替换为方案 B：iOS 上 JS 把 `user-scalable=yes` 翻成 `no`，注释原话："**In iOS Safari, setting user-scalable=no doesn't actually prevent the user from zooming in. But, it does prevent the annoying 'auto zoom' when focussing input fields with small font-sizes.**" —— 迁移动机是 A 造成输入框视觉膨胀。两条路都被大型产品实证有效。

---

## 3. 机制结论与充要性（v2 修正）

### 3.1 放大机制的准确表述

iOS Safari（默认配置）在 `initial-scale=1` 且未禁缩放时，对 computed font-size **< 16px** 的可聚焦控件（input/select/textarea/contenteditable）在 focus 时自动放大 visual viewport 至文本 ≥16px 可读级。这是充分条件级的行业共识（TypingMind 刻意工程 + Discourse 注释 + 大量社区文献），且数值与 DSH 症状吻合（14px→×1.14）。**充要性的诚实边界**：
- 16px 在**默认 Safari 配置**下充分；非绝对必要（maximum-scale/user-scalable=no 亦阻断）。
- 例外残存：用户系统级辅助功能（更大文本、Safari 每站 Page Zoom 设置）可抬高实际阈值或残留缩放；`<select>` 聚焦在个别 iOS 版本有独立报告（如 SO #64076385 "not prevented with 16px"，403 未能取全文，标题即反例存在性证明）。**这恰是 A+B 双保险的理由**（§6 决策点 1）。

### 3.2 方案空间（放大问题）

| 方案 | 手段 | 代价 | 先例 |
|---|---|---|---|
| **A 字号地板** | 窄屏 CSS：`[data-composer-input],[data-composer-placeholder],input,select,textarea { font-size: max(16px, var(--dsh-content-font-size,14px)) }` | 输入面视觉变大（13/14→16px）；对字号偏好用户保序 | TypingMind 现行；Discourse v1 |
| **B 禁缩放标记** | 窄屏 JS 改写 viewport meta 追加 `maximum-scale=1, user-scalable=no` | iOS 10+ **不禁双指缩放**（Discourse 注释实证），只杀 focus 自动放大；桌面/Android 不动 | Discourse v2（现行） |
| A+B | 地板兜字义，标记兜例外 | 叠加 | —— |

B 的实现要点：只在 narrow + touch 检测下改写（避免桌面与 Android 误伤），boot script 早期执行（先于任何 focus）。

### 3.3 键盘机制的两层事实（v2 关键更新）

- **浏览器内 Safari**：键盘 overlay，无 opt-out（259770），必须 `visualViewport` shim（v1 M2 方案维持）：`intrusion = innerHeight − visualViewport.height`，>阈值且 `scale≈1` 时以 `--dashr-vvh` 收缩 `#root` + `scrollTo(0,0)` 抗 pan。
- **PWA standalone（Add to Home Screen）**：dev.to 2026-07 实测文（iOS 17/18）：键盘弹出时 **`window.innerHeight`、`visualViewport.height`、`100dvh` 全部收缩**（引擎原生 resize，等价 `resizes-content`），`interactive-widget` 在 standalone 被忽略。已知 bug：**键盘关闭后 viewport 卡在小尺寸不恢复**（直到杀进程）；社区解法 = blur 后 140ms 对全高元素做 `display:none→reflow→restore` 翻转强制重测（配 backdrop-filter 遮罩隐藏闪跳）。**TypingMind 零键盘代码成立的原因 = 其推荐移动形态是 PWA standalone**。DSH 的 manifest 已是 `display:fullscreen`，具备同路线条件。
- 策略组合（待讨论）：浏览器内 Safari 用户 → M2 shim；PWA 用户 → 引擎原生 + 可选 viewport-stuck 自愈；是否把"装成 PWA"作为官方推荐移动用法（对齐 typingmind）是产品决策点（§6 决策点 3）。

---

## 4. 动态岛假设验证（user 2026-09-03 提出方向）

**方向部分成立 —— 动态岛确实参与了一类真实 viewport bug，但不是本症状的机制：**

- [WebKit bug 300523](https://bugs.webkit.org/show_bug.cgi?id=300523)（REGRESSION, iOS 26.0，iPhone 15 Pro 实测 100% 复现，非动态岛机型 iPhone 13 Pro Max iOS 18 不复现）：键盘关闭或滚动/重渲染后，Safari **错误计算 visual viewport 高度，内容上移数像素侵入动态岛安全区**（fixed/sticky 头部漂移）。`viewport-fit=cover/contain`、`env(safe-area-inset-top)` padding、visualViewport JS 重算**均无法绕过**；Simon Fraser 确认 iOS 26.1 beta 已修。
- 该 bug 的症状是**纵向几像素漂移**，不是横向 115–120% 放大，且只在 iOS 26.0 存在（26.1 已修）。DSH 若在 iOS 26.0 真机观察到顶栏上漂数像素，即此 bug，升级即愈，应用侧无动作空间。
- **机制结论**：布局视口宽度由 viewport meta 决定（390pt 机型 = 390 CSS px），动态岛裁剪通过 `env(safe-area-inset-*)` 暴露、不改变布局宽度与缩放比；"focus 后重新拿 2000px 物理高度再按旧比例放大"无证据支持（按此假设放大应与焦点控件字号无关，而 TypingMind 16px 输入框在同一机型上不放大 —— 反证）。**120% 放大维持 font-size 机制定性**；动态岛类 bug 作为独立 bug class 记录在案。

---

## 5. 实现方案（v2，全部 better-dsh 插件增量，零上游改动；待批准后动工）

配置通道沿用 `__DASHR_MOBILE__`（`web-trust.ts` boot script）扩键：`zoomGuard: 'font' | 'meta' | 'both' | 'off'`（默认待裁决）、`keyboardShim: true`、`focusGate: true`（若裁决保留 D3 修复）。

- **M1 放大防护**（对应 §3.2 A/B，二选一或叠加，boot script 装 B、claimStyles 装 A）。
- **M2 浏览器内键盘 shim**（§3.3；visualViewport → `--dashr-vvh` 收缩 `#root`；阈值 + scale guard + rAF 合帧）。
- **M2b standalone viewport 自愈**（可选）：blur 后 display-flip 重测，防 PWA 态卡小 viewport。
- **M3 focus gate**（D3 触发层，裁决点 2）：boot script 包 `HTMLElement.prototype.focus`，只拦窄屏 `[data-composer-input]` 的非用户发起聚焦（pointerdown 在 `[data-composer-card]`/弹层内放行）。若裁决"移动端切会话保留自动聚焦"，则 M3 撤销，症状由 M1+M2 兜底（键盘弹出但可见、不放大）。
- ~~M4 自动收左栏~~ —— **撤销**（D4 no-go）。

桌面零影响（全部 narrow-gated）；验证计划维持 v1 §5（4999 预演 + client spec + 真机 iOS 清单），真机清单新增：iOS 26.0 顶栏上漂观察项（对照 300523）、PWA standalone 态键盘 + 卡死自愈验证。

---

## 6. 待讨论决策点（user 明确先讨论后开发）

1. **放大防护选型**：A（字号地板，视觉变大）/ B（user-scalable=no 标记，iOS 10+ 不禁双指）/ A+B 双保险。倾向建议：**B 为主 + A 只保 composer**（B 零视觉扰动且 Discourse 实证；composer 16px 同时改善手机可读性）——待你裁决。
2. **切会话自动聚焦（D3）**：移动端是否取消？（取消 = 切会话后纯净阅读态；保留 = 现状行为，靠 M1+M2 兜底症状。）
3. **移动端官方形态**：是否把"Add to Home Screen（PWA standalone）"作为推荐用法（键盘问题在引擎层消失，对齐 typingmind 路线）？浏览器内 Safari 用户仍由 M2 覆盖。
4. M2b（standalone 卡死自愈）是否纳入首版。

## 7. 证据索引（v2 增补）

| 事实 | 位置/来源 |
|---|---|
| TypingMind 分发 = PWA only（无 DMG） | docs.typingmind.com/install-typingmind-app（2026-09-03） |
| 输入框 16px@390 / 14px@1280（实测） | CDP 活体测量，脚本 `work/typingmind-re/measure.mjs`，样本 `work/typingmind-re/typingmind-web-bundle.tar.gz` |
| Tailwind Forms 基线 1rem=16px | 其 CSS chunk（case 存档） |
| 无键盘 shim / 无 viewport 改写 | bundle 全量 grep（case 存档） |
| safe-area = env() 标准通道 | 其 CSS + chunk 3a4r…（case 存档） |
| Discourse A→B 迁移及 B 不禁双指缩放 | Discourse PR #30877 diff（注释原话） |
| standalone PWA 键盘 resize + 卡死 bug + display-flip 自愈 | dev.to/cederhook 2026-07（iOS 17/18 实测） |
| 动态岛 viewport bug（上移数像素，26.1 修） | WebKit bug 300523 |
| 浏览器内无 interactive-widget | WebKit bug 259770（仍 NEW/Nobody） |
| DSH 侧全部源码锚点 | 见 v1 §6（`apps/web/index.html:5`、`InputBar.module.css:55`、`boot-theme.ts:21`、`InputBar.tsx` unlock effect、`base.css:6`、`columns.ts`、`stores.ts`） |

## 8. 参考文献

- [WebKit Bug 259770 – interactive-widget](https://bugs.webkit.org/show_bug.cgi?id=259770) · [WebKit Bug 300523 – Dynamic Island viewport shift](https://bugs.webkit.org/show_bug.cgi?id=300523)
- [Discourse PR #30877 – Replace font-size-ios-input workaround](https://github.com/discourse/discourse/pull/30877)
- [Fixing the iOS standalone-PWA keyboard bug (dev.to, 2026-07)](https://dev.to/cederhook/fixing-the-ios-standalone-pwa-keyboard-bug-that-shrinks-your-viewport-for-good-63d)
- [Chromium: viewport resize behavior](https://developer.chrome.com/blog/viewport-resize-behavior/) · [CSS Viewport §interactive-widget](https://drafts.csswg.org/css-viewport-1/#interactive-widget-section)
- [TIL: Avoid text-sm on inputs (guidefari)](https://guidefari.com/safari-ios-input-zoom/) · [SO #64076385 – 16px 反例存在性](https://stackoverflow.com/questions/64076385/input-zoom-on-iphone-safari-not-prevented-with-16px)
- typingmind.com（bundle/manifest/viewport 实测）；docs.typingmind.com（install 文档）
