# HRBuddy 二次开发改动记录

> 用途：本仓是 `makecindy/cindy` 的 fork（`ZDfordream/cindy`），用于改造为 HRBuddy。
> 本文按**需求**组织（改动 → 影响面 → 与上游同步方式），供从主仓 merge 时对照。
>
> **姊妹视图**：[`CHANGELOG.md`](./CHANGELOG.md) 按**时间**逐条记录每一次改动（含被回退的），
> 供回溯「某天改了什么、为什么、又撤了什么」。两份一起看最完整。
>
> 生成日期：2026-10-28；最近更新：2026-10-29。

## 0. 范围约定（来自需求文档 2026-10-28 版「改动要求」）

| 约定 | 落地 |
| --- | --- |
| **仅改 Desktop**，Mobile 暂不改 | mobile 改动已回退，改动存于 `mobile-changes.patch`（见 §5） |
| 每次修改后在本 Mac 部署查看效果 | 用 `pnpm restart:desktop:remote -- --mock`（免登录独立沙箱） |
| 详细记录改动，便于从主仓同步 | 本文 |

---

## 1. 品牌资产：图标 + 艺术字 → HRBuddy

**选型**：App 图标用 `icon-02-hr-monogram`（HR 字母组）；艺术字用 HRBuddy wordmark。
源资产：`/Users/zhudong/hrworkspace/HRBuddy-brand/`。

### 1.1 桌面 App 图标（5 件套）

- `apps/desktop/resources/icon-master-1024.png` ← HRBuddy 满幅母版（无圆角，圆角由派生脚本加）
- 重跑 `scripts/generate-mac-icns.mjs` / `scripts/generate-win-ico.mjs` 派生：
  `icon.icns`、`icon-dock.png`、`icon.ico`、`icon.png`、`cindy-updater/src-tauri/icons/{icon.ico,icon.png}`

> **同步提示**：这 5 个派生产物是二进制，上游 merge 时冲突直接取本仓版本即可；
> 母版换图后重跑两个脚本可完全再生。

### 1.2 艺术字 / 字标（保持各文件原画布尺寸，字标 contain 居中 → 零布局改动）

| 文件 | 说明 |
| --- | --- |
| `src/renderer/assets/logo-{light,dark}.png` | 主字标（useBrandLogo 出口） |
| `src/renderer/assets/cindy-logo-{light,dark}.png` | 内置主题 `brand.logo.src` |
| `src/renderer/assets/login/wordmark*.png` | 登录品牌舞台 |
| `src/renderer/assets/splash/wordmark*.png` | 远程隐私遮罩页（**注意命名相反**：`wordmark.png`=深色模式用） |
| `native/menubar/wordmark-{light,dark}.png` | mac 菜单栏面板字标 |
| `src/renderer/assets/head-image-{light,dark}.png` | 品牌锁定组件圆形标（改用 HR 图标） |
| `.github/assets/cindy-wordmark-{light,dark}.svg` | 字标 SVG 源 |
| `native/menubar/macos-menubar-helper.swift` | **手绘矢量标**：`cindyMarkPath` → `hrbuddyMarkPath`（HRBuddy 双峰签名，24pt viewBox） |

### 1.3 默认伙伴（Bot）头像

- `src/renderer/assets/bot-presets/cindy.png`（256²）
- `resources/companion-preset-avatars/cindy.png`（256²，**须与上者字节一致**，见 `companionIdentity.ts`）
- `native/agent-island/mascots/cindy.png`（128²）

> 文件名与 `cindy://avatar/preset/cindy` 标识符**未改**（属协议/标识符层）。

---

## 2. 产品名：Cindy → HRBuddy

### 2.1 单点真源（改这两处即全局生效）

| 文件 | 改动 |
| --- | --- |
| `packages/maker-shared/src/branding.ts` | `BRAND_NAME = 'HRBuddy'`（所有 `{{appName}}` 插值随之生效） |
| `packages/maker-shared/src/brandIdentity.ts` | `executableName` / `executableNameByRegion` 的 cn、global → `'HRBuddy'` |

**刻意不动的标识符**（改动会造成数据/协议迁移事故）：
`appIdByRegion`（`com.xd.*`）、`userDataDirNameByRegion`（`Cindy`/`CindyGlobal`/`CindyDev`）、
`primaryScheme`（`cindy`）、`cdnPrefix`、`updaterName`、`dbFilePrefix`、dev 区的 `CindyDev`。

### 2.2 i18n 五语 locale（3385 行）

- 策略：值里的产品名 **Cindy → 字面 `HRBuddy`**，**不用 `{{appName}}`**。
  原因：占位符契约要求各语与 en 的占位符多重集逐 key 一致；各语对品牌的提及次数本就不同，
  转占位符会把译文差异暴露成 29+ 处违规。字面替换零扰动。
- `CindyDev` / `CindyGlobal` / `CindyMake` / `isCindy` 等标识符经**双侧词边界**保护。
- `splash.*` 命名空间整体删除（含「唤醒 Cindy 中…」）；`splash.spawnFailed.*` 是更新器文案，
  迁至 `update.spawnFailed.*`。

### 2.3 主进程硬编码用户可见文案

`applicationMenuLabels.ts`、`endpointManifestDialogCopy.ts`、`notificationService.ts`、
`oauthResultPage.ts`、`clientEndpointsService.ts`、`turnRetryNotice.ts`、`wecomGroupNotification.ts`、
`installCliCommand.ts`、`linuxInstallation.ts`、`devKeychainName.ts`、
`cindy-make/versionStartup.ts`（钥匙串身份词表**新增** HRBuddy，保留 Cindy/CindyDev 以兼容既有 profile）。

### 2.4 安装包 / CLI

- `apps/desktop/package.json` `productName` → `HRBuddy`
- `scripts/ci/lib.mjs`：`PACKAGED_APP_NAME`、`RELEASE_ARTIFACT_BASENAME_BY_REGION`（`hrbuddy*`）
- `forge.config.ts`：`win32metadata.ProductName`、协议显示名 `HRBuddy Deep Link`（scheme 仍 `cindy://`）
- **CLI 启动器**：`resources/cli/cindy` → `resources/cli/hrbuddy`（git mv），`resolveBundledCliPath` 同步；
  命令名 = `brandExecutableName().toLowerCase()` → `hrbuddy`

### 2.5 默认伙伴身份（Bot SOUL）

`packages/maker-shared/src/botTemplatePreset.ts`：
- `CINDY_DEFAULT_IDENTITY` 文案改 HRBuddy 措辞
- **历史指纹全保留**：新建 `LEGACY_CINDY_DEFAULT_IDENTITIES` 数组收纳翻转前的两代原文，
  `inferBotTemplatePresetId` 一并匹配——存量安装里的默认伙伴仍能被识别，**不回写已有 SOUL**
- `bots.ts` 种子 `name: 'Cindy'` → `'HRBuddy'`；`botProfileDefaults.ts` 兜底名同步

> ⚠️ 同步主仓时若上游又改了 `CINDY_DEFAULT_IDENTITY`，必须把上游那代原文**追加**进
> `LEGACY_CINDY_DEFAULT_IDENTITIES`，不能覆盖。

---

## 3. 首启动：二进制内置 + 移除 splash / check-environment

### 3.1 二进制随安装包分发（claude / codex / pi / ripgrep）

- **打包期**：`forge.config.ts` 新增 `stageAgentBinaries()`，把
  `apps/{claude-code,codex-package,pi}-bin/<platform>/` 拷进 `resources/tools/<installSubdir>/`，
  布局与运行时 `CONFIG` 的 `installSubdir`/`binaryName` 对齐；`package-desktop.mjs` 预 ensure 全部四种。
- **运行期**：`agent-binaries/index.ts` 新增 `findBundledBinary()`（解析
  `process.resourcesPath/tools/<installSubdir>/<binaryName>`，只读、不复制）。
  优先级：**userData 受管安装 > 包内副本**；`getReadyBinaryPath` 回落 `resolveBaselineBinaryPath`（dev runtime / 包内副本），
  **刻意不回落 userData 扫描**（避免复活被版本仲裁否决的残留，见 `startup-policy.test.ts` 契约）。
- `prefetch` / `peekNeedsDownload` 在包内副本在位且无受管安装时直接短路 → **后台不再拉 400MB**。

> **同步提示**：Windows postPackage 已递归签 `resources/tools/**`，新增 exe 自动覆盖；
> macOS 包内目录不得回写（`ensureCodexCliLauncher` 自带 userData 限定，不会误改包内副本）。

### 3.2 移除 check-environment 与「唤醒 Cindy 中…」splash

**已删除**：`check-environment` IPC handler（178 行）、`components/splash/`、`hooks/useSplash.ts`、
`contexts/EnvCheckContext.tsx` 及各自测试、preload 的 `checkEnvironment`/`onBinaryDownloadProgress`/
`checkAppUpdate`/`onAppUpdateProgress`/`autoRelaunchToUpdate`、i18n `splash` 命名空间、
`shared/startupGateStall.ts` 的 `envStatus`/`splashExited`/`splashExitCompleted`/`awaiting-splash-exit`。

**关键时序改动**：`registerMakerIpcs`（原 `registerMakerIpcsAfterSplash`，名字带 splash 但完全共享）
改由 `registerIpcHandlers()` 返回，在 **`createWindow()` 之前 await**——否则主 UI 会调到未注册的 `maker:*`。
`LoginHandoffContext` 去掉「等 splash 退场」锚（`reportSplashExited`/`reportSplashExitCompleted` 删除）。

> **同步提示**：上游若又给 splash 加功能，merge 时这些删除点会冲突；优先保留本仓的「无 splash」形态，
> 把上游新增能力接到 `registerMakerIpcs` 或新的启动钩子里。

---

## 4. 配色：对齐 WorkBuddy，白底（需求 3）

**真源**：`packages/design-tokens/src/reference/themes.json`（值）+ `src/themes/builtin.json`（$description）
+ `src/reference/shared.json`（windowBacking）。改完跑 `pnpm --filter @cindy/design-tokens generate`，
`check:generated` 是字节一致守卫，**不要手改 `colors.ts` / `cindy-light.ts` 的 GENERATED 区**。

`cindy-light` 亮色改动：

| token | 旧 | 新 |
| --- | --- | --- |
| `surface` / `panel-bg` / `surface-translucent-main` / `surface-elevated` / `surface-card-ivory` | `#F2F2ED` / `#FDFDF8` | **`#FFFFFF`** |
| `surface-hsl` / `background` / `splash-bg` / `titlebar` | `60.0 16.1% 93.9%` | **`0.0 0.0% 100.0%`** |
| `surface-elevated-soft` / `surface-chip-alt` / `perm-code-bg` | `#FAFAF5` | `#FAFAFA`（去暖） |
| `surface-translucent-overlay` | `rgba(251,251,246,0.90)` | `rgba(255,255,255,0.90)` |
| `settings-theme-auto-light` 等 4 个页底锚定派生 | `#F2F2ED` | `#FFFFFF` |
| `chat-input-bg` 等 8 个卡片派生 | `#FDFDF8` | `#FFFFFF` |
| `login-bg-base` | `#F2F2ED` | `var(--surface)`（治理合同：新 override 只能引用已治理 token） |
| `CINDY_ACRYLIC_WINDOW_BACKING.light` | `rgba(238,238,233,0.85)` | `rgba(245,245,245,0.85)` |

**暗色档未动**（需求只提白色背景）。

配套登记：`docs/design-rules/token-decision-table.md` §9.2、
`apps/desktop/src/renderer/themes/__tests__/cindyDecisionData.ts`（防手改漂移的冻结 map）。

---

## 5. Mobile：已回退，留待后续

需求文档要求「目前仅针对 DESKTOP」。已完成的 mobile 改动**已回退**，
补丁存于 [`mobile-changes.patch`](./mobile-changes.patch)（3397 行），日后重做：

```bash
git apply docs/dev-rules/hrbuddy-migration/mobile-changes.patch
```

内容包含：`app.json` 名称与权限文案、移动端图标 4 件、登录字标 @2x/@3x、
i18n 五语 locale、以及配套测试期望。

---

## 6. 尚未做 / 待定夺

| 项 | 说明 |
| --- | --- |
| 深处品牌残留 ~1485 处 / 432 文件 | 生成帮助知识 `helpKnowledge.generated.ts`（216）、maker-core Agent 提示词、SSH 注释等。改提示词须先读 `maker-core-and-agent-behavior.md`，风险高于 UI 文案 |
| 角色立绘 / slogan | hero、chibi、壁纸、`cindy-share-character.jpg`、「Dream it Create it」手写 slogan 仍是 Cindy 视觉体系，HRBuddy 无对应资产 |
| 公司名 | `author: "XD Inc."`、`win32metadata.CompanyName: 'XD'`、NSIS `feedback@cindy.app` 未改（需目标主体名） |
| 二进制内置实机打包验证 | 代码已落，需真打一次 win/mac 安装包确认首启零下载 |
| 深色模式白底 | 需求只提白色背景，暗色档保持原样 |

---

## 7. 与主仓同步的建议顺序

1. 先 merge 主仓到本 fork，**保留本仓的品牌与 splash 删除**（冲突点集中在
   `bootstrap-electron.ts`、`agent-binaries/`、`botTemplatePreset.ts`、`design-tokens/`）。
2. 品牌二进制资产冲突直接取本仓。
3. `design-tokens` 冲突：以 `reference/themes.json` 的值为准重新 `generate`，不要手改生成区。
4. 每次 merge 后跑：`pnpm --filter @cindy/design-tokens check:generated`、
   `pnpm check:design-colors`、`pnpm check:design-inventory`、`pnpm check:i18n`、
   `node scripts/brand-terminology-guard.mjs`、`pnpm test:unit:related`。

---

## 8. 模型供应商：极度简单设置（需求 4，2026-10-29）

> 裁决：**只留三个输入框，删掉其余向导**；**只给 Claude Code**（按需求字面）。
> 已配置的供应商不受影响，改造只动**新增入口**。

### 8.1 新增入口

`设置 → 模型供应商 → 添加供应商` 现在直接打开 **`AddGatewayDialog`**：
三个输入框 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / 模型，协议固定
`anthropic-messages`、Runtime 固定 `claude-code`。展示名从 URL host 推导（不再单列名称）。

实现要点：
- 复用 `ConfirmDialog` + `FormField` + `Input`（DESIGN.md §4「新对话框复用同一结构」）；
- 宽 460px、有 Cancel 不给 ×、点遮罩不关闭、打开聚焦首个输入框；
- 凭证走 `createCustomProvider(config, { 'claude-code': token })`，落 keychain，不进 Git。

### 8.2 移除

- **删除 `AddProviderWizard.tsx`**（2403 行多供应商 / 多协议向导）及其 3 个专属测试
  （`addProviderWizardPresetEntry` / `OpenAiAuth` / `OpenaiEntry`）。
- `OFFICIAL_API_PRESETS` 仍是连接表单的数据依赖，**抽出到 `providerPresets.ts`**（101 行），
  向导文件才得以删除。
- 深链 `?wizard=1` / `?connect=<preset-id>` 与「检测到本机 CLI」建议行的行为改写：
  前者打开网关表单，后者打开既有 `ProviderConnectionDialog`。

### 8.3 配套

- i18n 五语新增 `settings.providers.gateway.*`（6 key × 5 语）——**已随需求 6 的
  `AddModelDialog` 取代而零引用，2026-11-01 PRD 对齐收口时 5 语同步删除**（勿在上游 merge 时复活）
- 3 个测试按新行为改写（`providersSectionDeepLink` / `providersSectionUnavailableModels` / `providersSectionAssetModule`）
- `design-inventory` 已重新生成（desktop.settings 文件数 209→210，radii 552→535）
- **视觉偏离登记（2026-11-01 PRD 版式，模型设置面）统一见 §9.4**：列表卡 16 /
  弹窗 22·14 / primary 深色填充等，覆盖旧「10px 圆角 / 遮罩可关」条目；本分节与
  需求 6 的弹窗 + 列表几何一律以 §9.4 表为准。

⚠️ **已知限制（2026-10-31 模型网关 v1 取代本条入口后带入，Ruling 21）**：多窗口同时编辑模型条目时，启停/连通状态元数据与 `~/.hrbuddy/models.json` 镜像按整份快照 last-writer-wins 互相覆盖、全局当前模型各窗口各持一份（重开开关/重测/重选即可恢复，凭证与配置本体不丢）；多实例同步挂跟进，本轮不做。

**同步提示**：上游若扩展了 AddProviderWizard 的能力，merge 时会撞删除点；请评估是否
仍要保留在 HRBuddy 的「极简」形态下，需要时把它接到 `ProviderConnectionDialog` 而不是恢复向导。

---

## 9. 需求 5/6：设置弹窗化 + 模型供应商对齐 WorkBuddy（2026-10-29）

> 需求 6 与需求 4 冲突（Anthropic vs OpenAI 兼容）；owner 裁决：**只做 OpenAI 兼容（照需求 6 字面）**，
> 供应商下拉**只保留「自定义」一项**。

### 9.1 需求 5 — 设置以弹窗打开

新增 `SettingsModalHost.tsx`，替换路由出口的 `SettingsView`：遮罩 + 居中大面板 + 右上角 ×，
Esc 可关、点遮罩不关。**保留 `?tab=` 深链与 `SettingsView` 本体**，改动半径局限在路由出口。

⚠️ **已知取舍**：路由仍是 `/settings`，进入设置时下层内容会被路由替换，不是 WorkBuddy 那样
把设置浮在当前会话之上。要做到后者需把设置从「内容区路由」改成「壳层浮层」，会动 router
内容区结构与深链语义——需要时单独做一版。

### 9.2 需求 6 — 添加模型弹窗（OpenAI 兼容）

`AddModelDialog.tsx` **取代**需求 4 的 `AddGatewayDialog`（已删除），逐项对齐 WorkBuddy 参考图：

| WorkBuddy | 落地 |
| --- | --- |
| 标题「添加模型」+ 右上角 × | ✅ |
| 供应商（仅支持 OpenAI 兼容协议 API）+ 查看文档 ↗ | ✅ |
| 供应商下拉 | ✅ 只含「自定义」（owner 裁决） |
| 接口地址 | ✅ `openai-chat`，placeholder `https://api.example.com/v1/chat/completions` |
| API Key（显隐 + 测试连接） | ✅ 复用 `Input secret` 内置显隐 |
| 模型名称 | ✅ placeholder `gpt-4o 或 openai/gpt-4o` |
| 高级配置 | ✅ 工具调用 / 图片输入 / 思考模式 / 自定义协议（后两项对应 `supportsToolCalls` / `supportsImageInput` / `reasoningRequired` / 协议覆盖） |
| 取消 / 保存 | ✅ |

协议固定 **OpenAI 兼容**（`openai-chat`，「自定义协议」可切 `openai-responses`）。
需求 4 的 Anthropic 路径**按裁决移除**；原 `http://model.mify.ai.srv/anthropic` 是
Anthropic 兼容端点，需换成它的 OpenAI 兼容端点才能继续用。

⚠️ **有意偏离 DESIGN.md §4**：规范写「有 Cancel 的对话框不带右上角 ×」，但需求要求
「包括 UI」对齐 WorkBuddy，参考图两者都有。此处以需求为准。弹窗与模型列表的
全部视觉偏离登记见 **§9.4**（PRD 2026-11-01 版式，覆盖旧「10px 圆角 / 遮罩可关」条目）。

### 9.3 配套

- i18n 五语新增 `settings.providers.modelDialog.*`（19 key × 5 语）
- 测试 6 个文件 / 234 用例通过；design-inventory 与颜色门禁全绿

**同步提示**：`AddGatewayDialog` 已删，上游若扩展它的能力不要恢复；`AddModelDialog` 的
OpenAI-only 约束来自需求 6，若日后要支持 Anthropic 网关，需新增协议分支而不是回退需求 4。

### 9.4 设计偏离登记 — PRD model-provider-settings（2026-11-01 版式）

> 适用面：模型设置弹窗（`ModelGatewayForm`）、模型列表（`ModelGatewayList`/`Row`）与其
> toast / 动效。PRD 交互稿 `hrbuddy_prd/design/model-provider-settings.html` 是这些面的
> 视觉权威；下表**登记为有意偏离 DESIGN.md §4/§5**，评审不要当 bug 修。
> **PRD 2026-11-01 版式覆盖旧登记的「输入框 10px 圆角」（CHANGELOG 条目 7）与
> 「点遮罩可关」（CHANGELOG 条目 8）两条**；遮罩行为已按 PRD 改为 dirty 抖动不关
> （clean 可关，Esc/取消/✕ 任何态可关），旧条目仅存历史。

| # | 项 | PRD 值 | DESIGN 分级 | 落地 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 1 | 弹窗面板圆角 | 22px（`.dialog`） | 容器 12px | `ModelGatewayForm` 面板 `!rounded-[22px]`（覆盖共享 `modal-panel` 0.75rem） | 覆盖旧「10px」条目同族几何 |
| 2 | 弹窗输入 / 按钮圆角 | 14px（`.input`/`.btn`） | 单行输入胶囊 9999 / 内层 8 | `!rounded-[14px]`（`FIELD_INPUT_CLASS`、取消 / 保存） | 覆盖 CHANGELOG 条目 7 的「10px 圆角」登记 |
| 3 | primary 按钮深色填充 | #1f1f21 实底白字（`.btn.primary`） | primary 为 `--surface-chip` 浅灰 chip | 保存钮 `palette="confirmation"` → `confirm-btn-primary-bg`（light 深 #171717 / dark 浅 #fafafa 反转实底） | 语义 token 两模式同源，未写死色值 |
| 4 | 模型列表卡 / 空态框圆角 | 16px（`.list`/`.empty`） | 容器 12px（`rounded-xl`） | `rounded-2xl` | 列表为单卡 + 行间分隔线，空态虚线框 |
| 5 | 行几何 | 行高 54、gap 14、左右 padding 18 | — | `h-[54px]` / `gap-3.5` / `px-[18px]` | PRD `.row` |
| 6 | 状态点 | 12px 四态（空心灰 / 绿 / 红 / 旋环） | — | `h-3 w-3`；idle `--text-tertiary` 空心、ok `--card-status-done`、fail `--error-fg`、testing 旋环 | 颜色全语义 token，两模式同源；禁裸色 |
| 7 | 状态文字 | 宽 74 左对齐、hover 下划线、title「点击测试连通性」 | — | `w-[74px]` + `enabled:hover:underline` | 四态文案：未测试 / {n}ms / 连不上 / 测试中… |
| 8 | 行内开关 | 40×24（thumb 20、位移 16） | 共享 `Switch` 为 36×20 批准几何 | `ModelGatewayRow` 本地 `role="switch"` 控件（`h-6 w-10`），颜色走 `switch-track-on/off`、`switch-thumb-on/off` token | 不改共享 primitive；拖拽手势不带（PRD 开关为点击切换） |
| 9 | 删除 toast | 深色浮层底部居中 +「撤销」，5s 消失 | 共享 Toast 顶部胶囊 | 复用全局 `toast` + `action`（duration 5000，与删除窗口同步） | **视觉有意沿用应用统一 Toast**，不用 PRD 底部深色浮层 |
| 10 | 撤销回原位 flash | 1.4s 浅蓝退底（`.row.flash` #e8f0fe） | — | globals.css `.model-gateway-row-flash`，底色 `color-mix(var(--switch-track-on) 18%, transparent)` | 主题色派生，两模式同源；减弱动效由 motion 归零策略统一处理 |
| 11 | 遮罩行为 | dirty 不关 + 面板 shake；clean 可关 | DESIGN §4「点遮罩不得关闭」 | Task 2 已落地（`modal-panel.shake`） | 覆盖 CHANGELOG 条目 8 的「遮罩可关」登记 |
| 12 | 弹窗 × 与「取消」并存 | 参考图两者都有 | §4「有 Cancel 不带 ×」 | 既有偏离登记 1，保留 | — |
| 13 | 名称字号 | 14.5px/500（`.name`） | 字号白名单 UI 段 {…14,15…} | `text-14 font-medium` | 14.5 不在白名单（禁 `text-[14.5px]`），取最近档 |
| 14 | 空态文案字号 | 13.5px（`.empty p`） | 字号白名单 UI 段 {…13,14…} | `text-14` | 13.5 不在白名单（禁小数），取整 14；与表 13 的 14.5→14 同规则（半值取偶数档） |

颜色硬约束：上表任何色值都必须经语义 token（`--switch-*` / `--card-status-done` /
`--error-fg` / `--text-*` / `--confirm-btn-primary-*`）落地，Light/Dark 双模式同源；
`check:design-colors` 拦新增裸色。

---

## 10. model-gateway 计划：裁决与挂账（2026-10-31，计划收尾）

计划 `docs/superpowers/plans/2026-10-31-model-gateway-settings-and-chat.md` 全部 7 任务 +
最终全分支 review 一轮 fix 后收官。逐任务过程与全部裁定原文见计划 SDD 台账
（`.superpowers/sdd/…/progress.md`，gitignore 本地件）；此处只留**会约束后续改动**的裁决与挂账。

### 10.1 长期有效的裁决（改到对面前先看这条）

| # | 裁决 | 约束 |
|---|---|---|
| R4 | `ModelEntry.id` 是稳定句柄（= custom provider id），`modelId` 另存；~~排序按 modelId~~ **↩ 已推翻**（PRD 2026-11-01）：改插入序、新条目追加末尾 | 任何按 id 索引的消费方（currentModel、models.json）依赖稳定句柄，禁止改回「id=上游 model id」；稳定句柄部分继续有效 |
| R5 | `enabled`/`status`/`lastTestedAt` 走 localStorage `hrbuddy.modelGatewayMeta` | provider 配置 normalize 会剥未知字段，别往 config 里塞 |
| R14 | ~~保存即测试：保存成功即写本次探测结果，不做「改后置 untested」~~ **↩ 已推翻**（PRD 2026-11-01）：保存不探测、存后「未测试」、点状态文字才测 | ~~与设计稿 §5.2「正常路径无未测试行」一致~~ 以 PRD 2026-11-01 为准 |
| R17 | `~/.hrbuddy/models.json` 是 store 的 1:1 投影：`exportModels(list)` 整组替换、调用方送全量、`ExportedModel.id` 用稳定句柄 | 不是增量日志；不经 gateway store 建的自定义供应商不进镜像（有意） |
| R18 | 主聊天发送路径消费全局当前模型（范围仅主聊天；bots/scheduler/aux/plugins 留计划 2） | 切模型必须反映到实际发送，不许做成装饰 |
| R19 | 旧供应商 UI（含左栏本机 CLI 建议行入口）统一藏在 `SHOW_LEGACY_PROVIDER_UI` 单一恢复点后 | 藏不删；恢复 flag 时入口与表单一并回来 |
| R20 | **全局当前模型只作用于 claude-code 发送路径**，codex/pi 等引擎路由不受影响 | 网关条目仅配 claude-code runtime + anthropic-messages；要扩大覆盖面须先立新裁决 |
| R21 | 多窗口并发编辑模型设置为 **v1 已知限制**（整份快照互相覆盖，见 `ModelGatewayStore.ts` 头注） | 做多实例同步前，别在多窗口同时改模型设置 |

**PRD 对齐计划（2026-11-01）推翻的三条旧裁定**（上表行内已标 ↩，此处集中留痕）：

| 旧裁定 | 旧内容 | 现行（PRD 2026-11-01） |
|---|---|---|
| R14「保存即测试」 | 保存成功即写探测结果，无「未测试」行 | 保存不探测、存后「未测试」、点状态文字才测 |
| R4 之一「排序按 modelId」 | 列表按 modelId 字母序 | 插入序、新条目追加末尾 |
| 「点遮罩可关」（CHANGELOG 条目 8） | 弹窗遮罩一点即关 | clean 可关 / dirty 抖动不关；Esc / 取消 / ✕ 始终可关 |

### 10.2 挂账跟进（合并前已分流：以下为 defer 项，按需立项）

- **错误路径加固**：`ModelGatewayStore` load 失败会 brick（loadRef 永久 rejected）；列表行 retest/delete/toggle 无 catch，keychain IPC 失败成 unhandled rejection → 统一补 `.catch` + 失败可重试。
- **搜索索引一行收口**：`ProvidersSection.settings-search.ts` 的 `addProvider` title 仍为「添加供应商」，与按钮新文案「添加模型」漂移（最终 fix wave 的 F2 只授权改按钮）。
- **chatInputModelLoading.test.tsx 8 条 Task 6 遗留失败**：仍断言已下线的 ModelSelector/空槽，需按 ChatModelMenu 重写后清零（改前改后同名单，与本轮 fix 无关）。
- **a11y**：ChatModelMenu 无 disabled/in-flight 态、面板打开不移焦点、roving focus 缺失。
- **可观测性**：`toMirrorRow` 静默丢行不留 warn；`mirrorRowFromEntry` 类型与 main 侧重复可挪 shared/；`status.detail` 落盘已过脱敏+512 截断，将来透传响应体时再加清洗。
- **多窗口同步**（R21 的正式解）：meta 读-合并-写 / storage 事件同步 / 镜像写前重建。
- **styleRoots**：`features/model-gateway/` 样式源未纳入 design-inventory 的 styleRoots，Token/裸色计数不覆盖该目录。

### 10.3 集成门收尾补裁（2026-11-01）

| # | 裁决 | 约束 |
|---|---|---|
| R22 | `productName`（HRBuddy）与 userData 目录名（Cindy 族）**有意解耦**：userData 由主进程 `app.setPath` 显式钉住，不再等同 productName | 禁止移除该显式钉子；`brand-identity-sync` 已改钉「productName=BRAND_NAME + 钉子存在 + userDataDirName 冻结 Cindy」 |
| R23 | ChatModelMenu 接受补回「选完模型焦点归还编辑器」（Task 6 换入口时丢的真回归，`chatInputAnnotationAbort` 用例钉住） | 后续改菜单焦点策略时保住该归还 |
| R24 | effort 档位 UI 自 Task 6 换模型入口后**整面消失**，且 effort「投影优先」显示与发送侧「committed 优先」语义分叉 | **产品待决**（是否恢复档位 UI、统一哪套语义）——原「投影优先」用例因无载体裁剪，未虚构替代行为 |
| R25 | 远程机器切换入口 `MachineSwitcherMenu` 无人渲染属侧栏清理的**有意移除**（owner「体验不佳」），源码合同改钉新现实 | 别当丢失功能「修回来」；要恢复须先推翻该取舍 |
| R26 | `remove` 走**软去标记**：立即摘列表并 strip `catalogPresetId` + 空 keys；撤销窗口内 undo 重新标记、按原索引插回；5s 窗口后才真删（含 keychain 密钥）；卸载 flush 未决删除 | 撤销窗口内强杀进程，残留配置不得复活到列表；真删不得早于窗口；`REMOVE_UNDO_WINDOW_MS` 为 store 导出同源引用 |
| R27 | baseUrl URL **拒收 userinfo**：`new URL()` 解析出的 username/password 非空即拒（含仅用户名）；path / query 里的 `@` 不误伤 | 护 `~/.hrbuddy/models.json` 凭证红线（R17）——URL 不得携带凭证；文案 `settings.providers.modelDialog.urlNoCredentials` |
| R28 | baseUrl `new URL()` **解析失败即拒**（不再空转放行）：按既有 `baseUrlInvalid` 拒收，不新增 key | 堵「正则过 + 解析抛」复合畸形（如 `https://user:pass@host:99999`）把 userinfo 带进镜像的旁路；与 R27 同护 models.json |

> 表内 R22–R25 来自集成门收尾（2026-11-01）；**R26–R28 来自 PRD 对齐计划**（2026-11-01，
> `.superpowers/sdd/2026-11-01-model-gateway-prd-alignment/`，任务 1–4）。

**收尾挂账（并入 §10.2）**：
- R24 的 effort 档位产品待决（上面一行）。
- `MainListScopeHeader.tsx` 残留死 import（侧栏清理遗留）。
- 既有通过用例里残留永真的 `queryByTestId('model-selector')` 断言，应删或改钉 ChatModelMenu。
- `chatInputModelLoading` 原 8 条重写为 7 条（唯一删除项 = R24 无载体用例），guest 锁选在 ChatModelMenu 无禁用态承载（deferred），现状钉在用例注释里。

### 10.4 PRD 对齐计划挂账（2026-11-01，model-provider-settings）

PRD `/Users/zhudong/hrworkspace/hrbuddy_prd/design/model-provider-settings.html` 六条交互已全量落地（R26–28 与三条推翻见 §10.1/§10.3）。合并后跟进项：

- **在途重测的代数 token 硬化**：现方案按配置指纹比对丢弃陈旧回写（主路径已闭）；「删除→撤销→编辑」四步连招同窗 + 亚帧同到站两条窄路未封，可改探测代数 token 一并封死。丢弃路径目前静默（行停「未测试」无提示），可选补提示。
- **store 层 URL 校验纵深**：R27/28 的 userinfo/解析闸现在只在 Form；`add`/`update` 是公开 API，后来者绕过 Form 仍可写坏 baseUrl 进镜像——建议把校验收进 store。
- **小扫尾打包**：状态文字 `truncate`+title（ja/ko 长文案换行）、标题计数 `hydrated` 前闪 (0)、存量 16 个零引用 `modelDialog.*` 孤儿 key、store `done` 直调双保险钉。
- **保存在途 Esc 口径**：「任何状态可关」= 非保存在途（busyRef 门闩有意），已写 Form 头注。
- （存量，见条目 16 附记）姊妹 worker 配置 `process.env` 内联 `{}` bug。
