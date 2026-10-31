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

- i18n 五语新增 `settings.providers.gateway.*`（6 key × 5 语）
- 3 个测试按新行为改写（`providersSectionDeepLink` / `providersSectionUnavailableModels` / `providersSectionAssetModule`）
- `design-inventory` 已重新生成（desktop.settings 文件数 209→210，radii 552→535）

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
「包括 UI」对齐 WorkBuddy，参考图两者都有。此处以需求为准。

### 9.3 配套

- i18n 五语新增 `settings.providers.modelDialog.*`（19 key × 5 语）
- 测试 6 个文件 / 234 用例通过；design-inventory 与颜色门禁全绿

**同步提示**：`AddGatewayDialog` 已删，上游若扩展它的能力不要恢复；`AddModelDialog` 的
OpenAI-only 约束来自需求 6，若日后要支持 Anthropic 网关，需新增协议分支而不是回退需求 4。
