# HRBuddy 改动流水（按时间回溯）

> **用途**：逐条记录每一次改动，供后续回溯「某天改了什么、为什么、又退了什么」。
> **姊妹视图**：[`CHANGES.md`](./CHANGES.md) 按**需求**组织，供从 `makecindy/cindy` 主仓同步时对照。
>
> 记录约定：每条含 **改动 → 动机 → 影响面 → 验证**；被回退的改动**不删除条目**，而是标注
> `↩ 已回退` 并写明回退原因——回溯时「做过又撤」本身就是要找的信息。

---

## 2026-10-29

### 14. 上下间距改到容器级（所有选项页）
- **改动**：`SettingsView` 内容列加 `pt-6 pb-6`；同时撤掉上一轮只给 `ProvidersSection` 加的局部间距。
- **动机**：owner「设置弹窗，所有选项的右侧边栏都要有上下间距，不仅仅模型供应商卡」。
- **影响**：18 个选项页（通用/外观/…/关于）统一 24px 上下留白。
- **验证**：逐 tab 实测 computed padding = 24px/24px。

### 13. 「自定义模型」卡片 ↩ 已撤掉
- **改动**：移除右栏顶部的卡片（标题 + 添加模型按钮 + models.json 说明）。
- **动机**：owner「右侧卡片，还是使用原来的样式和能力，不改了」「撤掉」。
- **影响**：右栏回到改造前形态；`~/.hrbuddy/models.json` 的**自动写入行为保留**（那是行为不是 UI）。
- **验证**：141/141 测试通过；实测卡片已无、详情全在。

### 12. 右栏只留卡片、隐藏详情块 ↩ 已回退
- **改动**：加 `SHOW_PROVIDER_DETAIL` 开关把详情块（断开/远程调用/模型开关/账户资产）隐藏。
- **动机**：owner 一度选择「卡片纯净版」。
- **代价**：实测 **98 个测试失败**（5 文件），且丢失断开供应商/开关模型/看余额等能力。
- **↩ 回退原因**：owner 改口「还是使用原来的样式和能力，不改了」。
- **教训**：功能收窄类改动应先测代价再动手；本次先测出 98 失败并报告，owner 据此改了主意——流程有效。

### 11. 「自定义模型」卡片按 WorkBuddy 重排
- **改动**：改为卡片容器（圆角+边框+底色），标题左 / 按钮右，说明在下方且 `models.json` 路径下划线强调。
- **动机**：owner 贴参考图要求「UI 和布局对齐 workbuddy」。
- **验证**：实机截图逐项对照参考图。

### 10. 需求 7：自定义模型卡片 + models.json 导出
- **改动**：右栏顶部加「自定义模型」区 + 「添加模型」按钮；新增 `hrbuddyModelsExport.ts`，创建供应商成功后镜像写入 `~/.hrbuddy/models.json`。
- **路径裁决**：需求原文写 `~/.workbuddy/models.json`（WorkBuddy 的路径），改为 `~/.hrbuddy/models.json` 避免与真 WorkBuddy 互相覆盖；owner 已确认。
- **安全**：只写模型元数据（id/name/provider/baseUrl/能力），**绝不含 API key**；幂等合并，失败不阻断。
- **验证**：类型 + 231 测试 + i18n 门禁。

### 9. 弹窗关闭 bug 修复
- **改动**：`AddModelDialog` 补 `if (!open) return null;`。
- **根因**：组件常驻挂载，`onClose` 只改 state 但 DOM 还在 → 点 × 看起来「关不掉」。我重写组件时把 open 门丢了；mock 测试的桩自己判了 open，所以没拦住。
- **验证**：实测「初始未开 / 点开 / 点 × 关 / 点遮罩关」四项全通过。

### 8. 点遮罩关闭弹窗（对齐 WorkBuddy）
- **改动**：`AddModelDialog` 与 `SettingsModalHost` 的遮罩可点关闭。
- **⚠️ 有意偏离 DESIGN.md §4**（「点遮罩不得关闭弹窗」）：owner 要求对齐 WorkBuddy。
- **细节**：保存中点遮罩不响应，防误触丢已填内容。

### 7. 需求 6：添加模型弹窗（OpenAI 兼容）
- **改动**：新增 `AddModelDialog.tsx` 取代需求 4 的 `AddGatewayDialog`（已删）；协议固定 `openai-chat`。
- **⚠️ 与需求 4 冲突**（Anthropic vs OpenAI）：owner 裁决「只做 OpenAI 兼容（照需求 6 字面）」。
- **⚠️ 有意偏离 DESIGN.md 两处**：① 有 Cancel 仍带右上角 ×；② 输入框 10px 圆角而非 9999px 胶囊。
- **模型能力默认全开**（owner 后续裁决，去掉「高级配置」四个勾选）：`supportsToolCalls` / `supportsImageInput` / `reasoningRequired` 全 true。
  - **语义提醒**：`reasoningRequired` 是「思考不可关闭」（移除 off 档），不是「支持思考」；owner 明确「不要去掉」。
- **移除**「查看文档 ↗」（owner 要求）。
- **同步提示**：上游若扩展 AddProviderWizard 不要恢复；`AddModelDialog` 的 OpenAI-only 来自需求 6。

### 6. 需求 5：设置以弹窗打开
- **改动**：新增 `SettingsModalHost.tsx` 包住 `SettingsView`（遮罩+圆角面板+×+Esc）。
- **保留** `?tab=` 深链与 `SettingsView` 本体，改动半径限于路由出口。
- **⚠️ 已知取舍**：路由仍是 `/settings`，进入设置时下层内容被路由替换，不是 WorkBuddy 那样浮在当前会话之上。要做到后者需把设置从「内容区路由」改成「壳层浮层」，会动 router 结构与深链语义。

### 5. 需求 4：模型供应商极度简单设置 ↩ 部分被需求 6 取代
- **改动**：新增 `AddGatewayDialog.tsx`（三输入框 ANTHROPIC_BASE_URL / AUTH_TOKEN / 模型）；删除 `AddProviderWizard.tsx`（2403 行）及 3 个向导专属测试。
- **抽取**：`OFFICIAL_API_PRESETS` 是连接表单的数据依赖 → 独立为 `providerPresets.ts`（101 行），向导才得以删除。
- **↩ 后续**：需求 6 要求 OpenAI 兼容 + WorkBuddy UI，本弹窗被 `AddModelDialog` 取代。

### 4. 遮罩点击 / 弹窗关闭行为
- 见条目 8、9。

---

## 2026-10-28

### 3. 二进制内置 + 移除 splash / check-environment（需求 2）
- **改动**：`forge.config.ts` 新增 `stageAgentBinaries()`，claude/codex/pi/ripgrep 拷进 `resources/tools/`；`agent-binaries/index.ts` 新增 `findBundledBinary()` 解析包内副本；删除 `check-environment` handler（178 行）与 splash 全链路。
- **关键时序**：`registerMakerIpcs` 前移到 `createWindow()` 之前——否则主 UI 会调到未注册的 `maker:*`。
- **优先级**：userData 受管安装 > 包内副本；`getReadyBinaryPath` 回落**仅只读基线**（dev runtime / 包内副本），刻意不回落 userData 扫描，避免复活被版本仲裁否决的残留。
- **未验证**：二进制内置需真打 win/mac 安装包才能确认首启零下载。

### 2. 产品名 Cindy → HRBuddy（需求 1）
- **单点真源**：`branding.ts` 的 `BRAND_NAME` + `brandIdentity.ts` 的 `executableName(ByRegion)`。
- **i18n 策略**：值里的产品名用**字面 `HRBuddy`** 而非 `{{appName}}`。
  - **原因**：占位符契约要求各语与 en 的占位符多重集逐 key 一致，而各语品牌提及次数本就不同；转占位符会暴露 29+ 处违规。字面替换零扰动。
- **刻意不动**：appId / userData 目录 / 深链 scheme / cdnPrefix / updaterName / dbFilePrefix / `CindyDev`。
- **保护规则**：`Cindy(?!字母)` 双侧词边界，放过 `CindyDev` / `CindyGlobal` / `CindyMake` / `isCindy`。

### 1. 品牌资产（需求 1）
- 图标 5 件套 + 移动端图标 + 艺术字 21 张 + 默认伙伴头像 + 手绘菜单栏矢量标。
- 导出策略：保持各文件原画布尺寸、字标 contain 居中 → **零布局改动、零拉伸**。

---

## 过程中的失误（供回溯/避坑）

| # | 失误 | 影响 | 处置 |
|---|---|---|---|
| 1 | 删 `data-splash-active` 留下**孤儿 CSS 块** | 全局 CSS 语法错误，一度致 141 测试失败 | 修块 + 解析校验 |
| 2 | 字符串替换正则误伤**标识符**（`CindyMakePreflightDialog` 导入路径） | 收集失败 | 改双侧词边界 `(?<![A-Za-z])Cindy(?![A-Za-z])` |
| 3 | 把改名扫进**全部 717 个测试文件** | 误改 bot 名/进程名/夹具，失败 28→81 | 全部回退，只重做 21 个经验证文件 |
| 4 | `git checkout HEAD -- <file>` 恢复测试时**误退未提交的适配** | 测试适配丢失 | 重新补；**教训：未提交改动不能用 checkout 回退单文件** |
| 5 | 组件重写时丢掉 `if (!open) return null` | 弹窗常驻渲染，点 × 无效 | 补门 + 实测四项 |
| 6 | `AddModelDialog` 用了不存在的 `ConfirmDialog error` 属性 | 类型错误 | 改为内容区显示 |
| 7 | i18n 插入时漏尾逗号 / 漏 `import json` | JSON 写坏两次 | 修复 + 加载即校验 |

**模式教训**：批量改写类操作必须**先小样本验证、双侧边界保护标识符、改后立即跑门禁**；
回退未提交改动用 `git checkout` 之外的方式（或先提交）。
