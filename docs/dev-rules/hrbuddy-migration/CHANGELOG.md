# HRBuddy 改动流水（按时间回溯）

> **用途**：逐条记录每一次改动，供后续回溯「某天改了什么、为什么、又退了什么」。
> **姊妹视图**：[`CHANGES.md`](./CHANGES.md) 按**需求**组织，供从 `makecindy/cindy` 主仓同步时对照。
>
> 记录约定：每条含 **改动 → 动机 → 影响面 → 验证**；被回退的改动**不删除条目**，而是标注
> `↩ 已回退` 并写明回退原因——回溯时「做过又撤」本身就是要找的信息。

---

## 2026-11-02

### 18. 个人信息与菜单迁移（profile-menu PRD）10 任务收口：个人弹层、退出确认、「插件·技能」、12h 刷新、横幅改版、埋点

> **需求分节对照**：PRD 交互稿 `hrbuddy_prd/design/hrbuddy-profile-menu.html`（§1–14）。
> 计划台账 `.superpowers/sdd/2026-11-02-profile-menu/`；产品登记与挂账见
> [CHANGES.md](./CHANGES.md) §12（直连 OA 不接 HRMcp、≡ 下线与恢复开关、U+00B7 字符规范、
> 退出前停任务、网络类不强退、服务端 401 N/A、StartupLogSupport 逃生口、「登录名」标签、
> Ruling I/J）。

- **改动（计划 10 任务）**：

  | # | 任务 | 交付 commit | 备注 |
  | --- | --- | --- | --- |
  1 | 静默重登修复（全计划前置） | `2001061f1a`→`209d4028be` | safeStorage「在盘暂读不出」新增 `unavailable` 载荷态（不再误删密文/误落 signed-out）+ 有界退避重试 + 聚焦恢复；`credentialLoadPending` 随显式登录/登出收口 |
  2 | 个人信息数据层 | `afdec6d73e` + `c2e5aeb4cd` | 直连门户取资料/头像（**不走 HRMcp**）；单飞 + epoch 取消 + 失败分流（expired 终态）+ 同账号缓存；mobile/sex 不落盘；串号缓存不采信 |
  3 | 侧栏个人入口 + 身份卡 | `f69cc4bfd6` | 44px 入口、`ProfileState` 五态、身份卡字段行与截断（SC-7）；`login_name` 标签**「登录名」**（不是「工号」） |
  4 | 个人弹层 + ≡ 迁移 | `89c89abd4a` + `95b78750d7` | ≡ 菜单项全迁 `ProfileMenu`（含 Ruling E「退出全屏」），≡ 随 `SHOW_CINDY_ACCOUNT_UI` **藏不删**；键盘全序、TT 抑制、锚点几何 |
  5 | 退出确认 + 任务中断 | `d4f8c6af79` + `c1a3d24d7c` | 确认弹窗（N=在途 Agent 轮会话数）+ **先停后落**（Ruling B/F：凡落 signed-out 先真停在途轮）+ 清理清单；服务端 401 在 hr 会话中性化（本期 N/A） |
  6 | 「插件·技能」改名 + 页签壳 | `0f0e680d6f` + `9e798dabfe` | 三处五语同步，**U+00B7 中间点**逐码点断言（禁 `・`/`•`/空格）；帮助知识生成源同步 |
  7 | 图标提示 TT 生命周期 | `5ee849f087` + `82370f73a2` | TT-01~TT-12（含菜单打开即隐、键盘开层不绕抑制窗）；**不为图标提示埋点** |
  8 | 12h 凭证静默刷新 | `4920ed5719` + `dbebfbb2e9` | 刷新=静默重登；1→5→15min 退避、10s 超时、网络类失败**不强退**（Ruling 6）；五路触发 + 业务闸；`token_refresh` 触发点 |
  9 | 未配置横幅改版 | `74fbd27014`→`3ed52f675b` | FR-HOME-BANNER-01~05（语义 token 登记）、FR-HOME-REMOVE-02 收窄（Ruling I：只删品牌行下拉）、Ruling J 对比度知情例外、`StartupLogSupport` 逃生口保留 |
  10 | 埋点 + 双模式/i18n/文档 | 本次 commit | PRD §11 十事件（下详） |

- **任务 10（本条主体）——埋点（PRD §11）**：
  - `HrOaEventName` 增 10 事件（24 总）：`profile_fetch`（source/result/duration_ms/has_cache）、
    `profile_avatar_error`（size）、`profile_menu_open`（method/profile_state）、
    `profile_menu_click`（item/method，含 FR-MENU-02 的 ⌘, 等价动作 method=shortcut）、
    `logout_confirm_view`（has_running_task）、`logout_confirm_result`（result/method）、
    `logout` **增 `entry`**（profile_menu | session_check | token_refresh）、`nav_click`（item 五值）、
    `plugins_skills_tab`（tab）、`token_refresh`（trigger/result/attempt/duration_ms/overdue_ms）、
    `home_banner_click`；通用属性沿用 §10.1。
  - 触发点接线：profileService（单飞合并只记实际请求一次）、ProfileAvatar、ProfileEntry/rail 入口
    （method 随开层意图）、ProfileMenu、LogoutConfirmDialog、hrOaAuthStore（entry 经 signed-out
    状态从 main 带到 renderer——`token_refresh` 拒绝强退标 `entry:'token_refresh'`，其余失效
    默认 session_check）、SidebarTopNav（行/rail/更多共用一处 + 新建）、PluginManagementLayout
    页签切换、OnboardingHomeBanner「去配置」。
  - **Task 8 挂账一并收口**：`token_refresh` 补进 `HR_OA_EVENT_PROPS` 白名单（缺行 = 生产静默
    丢弃、事件永不上线），telemetry.test 对**真** `trackHrOaEvent` 钉住出货。
  - 采集边界（S-3，哨兵测试钉死）：24 事件逐个喂姓名/登录名/邮箱/手机号/头像地址/person_id/
    Cookie/X-Auth-Token/口令/API Key/明文账号/带凭证 URL 哨兵，JSON 载荷零出现；账号只出
    `account_hash`、URL 只出 `url_host`；**不为图标提示埋点**（事件名表无 tooltip 家族）。
  - 双模式目检顺手修一处版式缺陷：身份卡字段行标签列原为 2 字宽（`dt.w-7`，按「工号/邮箱」
    定死），OQ-3 改「登录名」（3 字）后 zh-CN 折成「登录/名」、zh-TW/ja/en 亦折行——改两列
    grid（标签 `max-content` + 值 1fr 截断），五语标签单行、两行列对齐，颜色仍走语义 token。

- **动机**：owner 提供 profile-menu PRD，要求登录人个人信息/头像进侧栏、≡ 菜单迁个人弹层并加
  退出确认、「插件·技能」统一命名、12h 凭证静默续期、未配置横幅改版；§11 十一项指标
  （获取成功率、头像可见 P90、退出确认取消率、迁移项使用量、刷新成功率、使用中途过期次数）
  需要上述埋点供数。
- **影响面**：Desktop HR 会话全链（登录恢复、个人资料、侧栏入口、弹层、退出、导航、页签、
  横幅、凭证刷新、埋点模块）。Mobile 不动；凭证/缓存红线不变（口令只进钥匙串、资料缓存不含
  mobile/sex、埋点不含个人字段）。无新增 UI 文案 key 的任务本条（十事件纯属性维度）。
- **验证**：desktop typecheck ✅；telemetry.test.ts 6/6 ✅（24 事件表 + 真 trackHrOaEvent
  token_refresh 出货 + 哨兵 PII/凭证穿透 + 无 tooltip 埋点；**TDD 证据**：白名单行未落时
  4 例 RED（事件被静默丢弃、载荷缺键），补行后 GREEN）；profileService 15/15 ✅（含
  profile_fetch 四类映射 + 单飞只记一次；**突变红验**：注释掉 track 调用 4 例即红）；
  hr-oa-profile 58、homeBanner 10、SidebarTopNav/auth/plugin 相关套件 ✅；`pnpm test:unit:related`
  / `check:i18n` / `check:i18n-glossary` / `check:design-colors` / `check:design-inventory` /
  `check:test-hygiene` 全绿；Light + Dark 实机目检见计划台账 task-10-report。

---

## 2026-11-01

### 17. 登录与模型添加（login-onboarding PRD）8 任务收口：门禁、S3 引导、埋点

> **需求分节对照**：PRD 交互稿 `hrbuddy_prd/design/hrbuddy-login-onboarding.html`（§1–13）。
> 计划台账 `.superpowers/sdd/2026-11-01-login-onboarding/`；产品登记与挂账见
> [CHANGES.md](./CHANGES.md) §11（账号层恢复开关、`hr` 会话模式、账号键冻结、SM2-only、
> deferred-minor 挂账）。

- **改动（计划 8 任务）**：

  | # | 任务 | 交付 commit | 备注 |
  | --- | --- | --- | --- |
  | 1 | 门户登录客户端 | `8b853504a2` + `36fc719623` | OA 登录 + 资料解析；口令 **SM2-only** 加密桥（2 参 `encs` `04\|\|C1\|\|C2\|\|C3` 布局，security 标记 = fromCharCode('SM2 ME')）；锁定判据收窄到 `login_error` 命中 `/lock(ed)?/i` |
  | 2 | 登录态生命周期 | `a6f877ec7d` + `db59cd7277` | 钥匙串凭证 + **账号键首次冻结**（键漂移 = 换 dataOwner，禁止）+ `AppSessionMode='hr'` 会话提交；资料失败退化用缓存冻结键 |
  | 3 | S1 欢迎页 + S2 登录页 | `222e4f352c` + `d8e52eb336` | 吉祥物两态几何、S1↔S2 转场、行内错误/抖动/锁定/超时五态；动效与几何按评审裁决收敛 |
  | 4 | 登录门禁接路由 | `ba6d9336e7` + `61d0535ab3` | `HrOaGate` 拦路由；**Cindy 账号层整体「藏不删」**（`SHOW_CINDY_ACCOUNT_UI` 单一恢复点）；门禁记忆升模块级，跨 ownerKey 重挂载不丢 |
  | 5 | S3 添加模型弹窗 | `acaa00d190` + `655915931b` + `0f331029ca` | onboarding 来源（跳过 + 底部提示）；**Ruling 9** `probeOnSave` 分流：S3/首页弹窗保存即真实连通性检测（10s 超时、失败零落库），设置面保持「保存不探测」（两 PRD 冲突仍挂账 CHANGES §6） |
  | 6 | 首页两态 + 补配门禁 | `b6d99329e4` | S4a/S4b 两态（`hydrated` 门）、未配置横幅、发送/选择器/建议/横幅四入口统一门禁（`home_gate_trigger.trigger` 收口） |
  | 7 | 退出登录 / 失效 / 会话规则 | `80091dc6c6` + `30085abb4a` | 「更多」浮层（自定义 + 退出登录）、T9/T10 转场、失效 toast 不误弹、同账号再登不重弹 S3；回落弹窗全窗单例 |
  | 8 | 埋点 + 双模式收口 + 文档 | 本次 commit | PRD §10 的 14 事件（下详） |

- **任务 8（本条主体）——埋点（PRD §10）**：
  - `main/hr-oa/telemetry.ts`：14 事件（`HrOaEventName`，类型合同在 `shared/hrOaTelemetry.ts`
    ——renderer 不得 import main）+ 每事件**属性白名单** + 通用属性（app_version /
    os_version / session_id / account_hash / ts）组装；**采集边界**（S-1 红线，哨兵测试
    钉死）：口令/API Key/token 键名命中即弃、明文账号只出 `account_hash`（SHA-256 前 8 hex）、
    接口地址收窄 `url_host`（含凭证 URL 也只出 host）；**sink 可替换**（`registerHrOaTelemetrySink`，
    默认结构化日志 `hr-oa.telemetry`——暂无既有客户端分析通道可接，正式后端接入只换注册点）。
  - 触发点全量接线：S1/S2 曝光与登录五态（Welcome/Login）、`model_*` 六值 origin 维度
    （`trackOrigin` 只在 onboarding 家族传；设置面整族不发）、`model_dialog_skip.method`
    按控件记实（close_x / skip_button / cancel / esc / mask）+ `had_input`、
    `home_view` 到达账本（login/launch/skip/save，曝光落定一次性消费）、
    `home_gate_trigger`（send/selector/suggestion/banner/**customize** 两宿主路径各一次）、
    `message_send`（合成器唯一出口；source 按「发出正文 = 最近建议填入」判定、
    `is_first_message` = 会话首条）、`logout`（user/token_expired）。
  - `scripts/shared/design-inventory.mjs`：路由入口解析兼容「藏不删」开关三元
    （`SHOW_X ? <Page /> : <Other />`），catalog 仍登记恢复面。

- **动机**：owner 提供 login-onboarding PRD，要求未登录不得进首页、登录后可跳过添加模型、
  首页两态持续补配入口；漏斗 14 事件为「登录成功率 / 首次模型配置完成率 / 跳过率 / TTFM /
  登录→首页耗时」五个指标供数。
- **影响面**：Desktop 登录门禁（router / hr-oa-auth / hr-oa main）、S3 与首页补配
  （model-gateway + OnboardingSessionHost）、合成器发送打点（ChatInput）、埋点模块（新增）。
  Mobile 不动；`~/.hrbuddy/models.json` 与 keychain 凭证红线不变。**无新增 UI 文案 key**
  （五语 i18n 不扩表）。
- **验证**：desktop typecheck ✅；telemetry.test.ts 4/4 ✅（14 事件表 + 哨兵密钥穿透 +
  白名单/未知事件/sink 注销；**TDD 证据**：绕过白名单的突变使哨兵用例 RED（精确点名泄漏的
  口令），还原后 GREEN）；`pnpm test:unit:related` / `check:i18n`（五语一致）/
  `check:i18n-glossary` / `check:design-colors` / `check:design-inventory`（57 surfaces）/
  `check:test-hygiene` / `check:dco` 全 ✅（明细见任务报告；收口顺带修掉 5 个计划内 latent
  测试断裂，见任务报告 §7.1）；`--mock` 实机目检 **S4a/S4b 双模式**（Light + Dark 各过目
  横幅/红绿点/发送钮两态）；**S1/S2/S3 与弹窗开启、reduce-motion 未实机**（mock 门禁旁路 +
  合成输入通道受限，逐屏原因与等价覆盖见任务报告 §5）——不以「复用 themed token」冒充双模式。

> **附记（口径）**：`model_save_result` 触发点 = 连通性检测**回包**（非落库结果）——探测成功后
> 磁盘落库失败的稀有路径不改写本事件；`message_send` 只计合成器出口（点击/Enter/语音/代发），
> mivo UI 动作与编辑重发不计；S3 保存/跳过会在弹窗结束处改写 `home_view.entry`（=save/skip），
> 一次到达只发一条曝光。

---

### 16. 模型设置对齐 PRD 2026-11-01（PRD 对齐计划 4 任务收口）

> **需求分节对照**：PRD 交互稿 `hrbuddy_prd/design/model-provider-settings.html` 是模型
> 供应商设置面的视觉与交互权威（覆盖条目 15 的部分语义与条目 7/8 的旧视觉登记）。计划
> 台账 `.superpowers/sdd/2026-11-01-model-gateway-prd-alignment/`；偏离登记与裁决正本
> 见 [CHANGES.md](./CHANGES.md) §9.4（14 行表）、§10.1（推翻留痕）、§10.3（R26–R28）。

- **推翻旧裁定三条（均以 PRD 2026-11-01 为准）**：
  1. **R14「保存即测试」→ 已推翻**：保存不探测、存后「未测试」、点状态文字才测；
  2. **「排序按 modelId」→ 已推翻**（R4 的排序半句）：插入序、新条目追加末尾（稳定句柄半句仍有效）；
  3. **「点遮罩可关」→ 已推翻**（条目 8）：clean 可关 / dirty 抖动不关；Esc / 取消 / ✕ 始终可关。
- **新裁决 R26–R28**（正文见 CHANGES.md §10.3）：
  - R26 `remove` 软去标记：摘列表 + strip `catalogPresetId`/空 keys，undo 重新标记按原索引插回，
    5s 窗口后真删（含 keychain）；窗口内强杀进程残留配置不复活；
  - R27 baseUrl URL 拒收 userinfo（护 `models.json` 凭证红线）；
  - R28 `new URL()` 解析失败即拒（堵复合畸形旁路）。
- **改动（计划 4 任务）**：

  | # | 任务 | 交付 commit | 备注 |
  | --- | --- | --- | --- |
  | 1 | store 语义对齐 PRD | `4b8eaa550c` | 插入序、add 恒 untested、update 三字段变更重置 untested、remove 5s 撤销（R26）、`--mock` 探测演示规则（url 含 fail → 连不上，否则延迟 60–380ms） |
  | 2 | 添加/编辑弹窗 | `7784779b63` + `8df85a249f` + `b4f0e91e63` | 合法性门（三项合法前保存禁用）、modelId 重复拦截、dirty 遮罩抖动；fix 轮 R27/R28 URL 校验 |
  | 3 | 列表/行 + 视觉 | `073a192d69` + `d364cd763a` | 状态点四态 + 点状态文字重测、删除 5s 撤销 toast、行内开关、空态、弹窗 22/14 圆角对齐、§9.4 登记；fix 轮撤销窗口与 toast 同步收口 + 焦点环 |
  | 4 | 收口 | 本次 commit | CHANGES/CHANGELOG 三条推翻标注 + R26–R28 登记 + §9.4 空态字号行；删零引用 `settings.providers.gateway.*`（6 key × 5 语）；门禁 + 双模式目检 |

- **动机**：owner 提供 PRD 交互稿，要求模型供应商设置面（弹窗 + 列表 + 交互脚本）对齐。
- **影响面**：Desktop 设置 → 模型供应商 + model-gateway store/表单/列表；`~/.hrbuddy/models.json`
  镜像与 keychain 凭证红线不变（R17）。Mobile 不动。
- **验证**：desktop typecheck ✅；model-gateway + new-chat/chatInput 相关 31 文件 345/345 ✅；
  `check:i18n`（14051 key 五语一致，-6 零引用 gateway key）/ `check:i18n-glossary` /
  `design:inventory` / `check:design-colors` / `check:test-hygiene` 全 ✅；
  `--mock --isolated=hrbuddy-prd` 实机目检 **Light + Dark 双模式**各走 PRD 五条交互
  （添加弹窗合法性门、保存追加末尾「未测试」、点状态文字重测、编辑回填/删除 5s 撤销/开关、
  Esc/取消/✕ 关 + dirty 遮罩抖动），mock 演示规则（fail→连不上 / 其它→延迟 ms）两模态均生效。

> **收口顺带修复**：`vite.preload.config.ts` 补 `environments.client.keepProcessEnv: true`——
> Vite 对非 lib 构建默认把 `process.env` 内联成 `{}`，而 forge preload target 走
> `build.rollupOptions.input`（插件模板为 web 资源改道），导致 preload 的
> `process.env.XDT_UI_MOCK` 投影被静态替换成空对象、`uiMockData` 恒 false、mock 演示
> 规则永不生效（实机复现后定位）。**NODE_ENV 语义更正**：`keepProcessEnv` 会整表跳过
> Vite 的 processEnv define（含 `process.env.NODE_ENV`），故 preload-target bundle 的
> `process.env` 与 `NODE_ENV` **均改为运行时读取**（与 main 的 build.lib 语义一致，
> 结论仍安全），不再按构建期值做死代码折叠；要保折叠需显式补 `define`（本轮不加）。
> **follow-up 挂账**：姊妹 worker 配置（`vite.watcher-host.config.ts` 等）同款内联 `{}`
> 存量 bug，watcherHostProcess 的 env 注入旁路静默失效——后续统一加构建物断言收口。

---

## 2026-10-31

### 15. 模型供应商重设计：模型网关（实现计划 7 任务一并交付）

> **需求分节对照**：[CHANGES.md](./CHANGES.md) §8（需求 4 模型供应商极度简单设置）、
> §9（需求 5/6 设置弹窗化 + 添加模型弹窗）的模型供应商条线，由本次重设计取代并收口；
> 需求 7 的「自定义模型」卡片（本文件 2026-10-29 条目 10）→ 被模型网关列表取代，
> `~/.hrbuddy/models.json` 自动写入行为保留（条目 13 的裁决不变）。设计定案见
> `docs/superpowers/specs/2026-10-31-model-provider-redesign-design.md`。

- **改动（计划 7 任务）**：
  1. **模型条目 store**（`apps/desktop/src/renderer/features/model-gateway/`）：
     `useModelGateway()` / `ModelEntry` 为模型配置唯一真源（稳定 id 永不因编辑换；
     `enabled` / `status` / `lastTestedAt` 落 localStorage `hrbuddy.modelGatewayMeta`）。
     旧配置不迁移（owner「清空重来」），无新表单标记的条目不进列表。
     - **↩ 「排序按 modelId」已废**（2026-11-01 PRD 对齐计划推翻 R4 排序半句）：
       改插入序、新条目追加末尾；稳定句柄半句继续有效。
  2. **连通测试**：保存时 + 手动重测时经 `maker:provider:test-connection` 发
     `/v1/messages` 最小探测；不做周期巡检；结果写回 status + lastTestedAt。
     - **↩ 保存探测已废**（2026-11-01 PRD 对齐计划推翻 R14「保存即测试」）：
       保存不探测、存后「未测试」、点状态文字才测；现行语义见下方条目 16。
  3. **设置右栏模型列表**：`ModelGatewayList` 挂右栏顶部常驻（含 Cindy 登录引导面），
     可启停行 = 状态点 + 延迟/原因 + 编辑/删除 + 开关（关掉不进聊天下拉但配置还在）。
  4. **三栏表单**：`ModelGatewayForm`（接口地址 / 密钥 / 模型，协议写死
     anthropic-messages；**测不通不让存**；密钥只进 keychain/safeStorage）。
     - **↩ 「测不通不让存」已废**（2026-11-01 PRD 对齐计划）：合法性门即存，
       保存不探测；URL 另增 userinfo 拒收（R27）与解析失败即拒（R28）。
  5. **models.json 镜像**：IPC `hrbuddy-models:export` 把元数据（含 enabled/status，
     **绝不含密钥**）写 `~/.hrbuddy/models.json`（需求 7 路径裁决不变）。
  6. **聊天下拉**：输入框右下角 `ChatModelMenu` + 全局当前模型（跨重启记住、作用后续
     消息），菜单底部弱链跳设置的模型列表。
  7. **旧多供应商 UI 隐藏（单一恢复点）**：`legacyVisibility.ts` 的
     `SHOW_LEGACY_PROVIDER_UI`（默认 `false`）把右栏旧详情块整体收起——身份行/断开/
     「···」菜单、账户资产（余额/套餐/用量）、「允许被远程调用」+ 远程与分享入口、
     预设/多协议/「获取模型列表」入口；左栏「检测到本机 CLI」建议行（打开旧完整表单的
     活口）同收该开关（Ruling 19）。**保留代码**（owner「藏起来以后再说」）；
     把常量改回 `true` 即整块恢复。⚠️ 与本文件条目 12（`SHOW_PROVIDER_DETAIL` 已回退）
     的区别：那次收窄后 owner 改口；本次是重设计定案的一部分，默认面就是简单三栏。
- **commit → 任务对照**（Ruling 7 收尾：条目由一笔记录收口 7 任务，但交付散在多笔提交；
  同任务多笔 = 主体 + 裁决/修复轮，与 `.superpowers/sdd/2026-10-31-model-gateway-settings-and-chat/progress.md`
  各任务「交付：」行一一对应，不改提交历史）：

  | # | 任务 | 交付 commit | 备注 |
  | --- | --- | --- | --- |
  | 1 | 模型条目 store | `fea2ea5457` + `46bcc6b692` | 主体；稳定句柄 + localStorage meta |
  | 2 | 连通测试 | `5ca7101a6d` | |
  | 3 | 设置右栏模型列表 | `0c75f9749b` | |
  | 4 | 三栏表单 | `7e2f91e1e3` + `c0f88c02ab` + `96c6d14531` | 主体；Ruling 14 探测结果入 status；Esc 单层抢占 + Ruling 16 |
  | 5 | models.json 镜像 | `01747911ae` + `46b394a597` | 主体；Ruling 17 1:1 投影 |
  | 6 | 聊天下拉 | `836d22d541` + `66da6334f1` + `21d2408a1d` | 主体；Ruling 18 发送路径消费；加载窗口不抹当前模型 |
  | 7 | 旧多供应商 UI 隐藏 | `56a15985f5` + `5bb51d1c2b` | 主体；Ruling 19 建议行同收 |

- **动机**：owner「使用方只需要填写三处地方即可快速简单配置使用」「旧功能藏起来以后再说」。
- **影响面**：Desktop 设置 → 模型供应商 + 主聊天下拉；Mobile 不动。`providersSection*`
  断言旧详情块的用例按工程约定 §3.2 裁剪/改写（逐条依据见各测试文件就地注释与
  `providersSectionAssetModule.test.tsx` 头部处置表）。
- **验证**：desktop typecheck ✅；model-gateway + providersSection* 共 65/65 ✅；
  `check:i18n` / `design:inventory` / `check:design-colors` / `check:test-hygiene` ✅；
  `--mock --isolated=hrbuddy-gw7` 实机目检 Light + Dark：右栏只剩模型列表
  （状态点三态、编辑/删除/开关齐全），身份/资产/远程调用/获取模型列表块全部不渲染。

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
- **↩ 已被 2026-11-01 PRD 版式推翻**：模型设置弹窗遮罩改为 clean 可关 / dirty 抖动不关
  （`modal-panel.shake`），不再一律点遮罩即关；现行登记见 `CHANGES.md` §9.4。

### 7. 需求 6：添加模型弹窗（OpenAI 兼容）
- **改动**：新增 `AddModelDialog.tsx` 取代需求 4 的 `AddGatewayDialog`（已删）；协议固定 `openai-chat`。
- **⚠️ 与需求 4 冲突**（Anthropic vs OpenAI）：owner 裁决「只做 OpenAI 兼容（照需求 6 字面）」。
- **⚠️ 有意偏离 DESIGN.md 两处**：① 有 Cancel 仍带右上角 ×；② 输入框 10px 圆角而非 9999px 胶囊。
  - **↩ ② 已被 2026-11-01 PRD 版式推翻**：模型设置弹窗输入/按钮改 14px、面板 22px，
    「10px 圆角」登记作废；现行登记见 `CHANGES.md` §9.4。
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

- **改动（2026-11-01）**：修发送门禁冷启动竞态——`useCurrentModelRoute` 区分「尚未水合」与「无模型」，零来源门禁只在 providers/网关条目表就绪时判定，加载窗口 Send 置灰、间接派发静默等待；此前启动后 ~1.5s 内点发送会把 `sendModel` 落回内置默认模型并误弹「当前模型没有可用来源」。回归钉子：`chatInputModelLoading` 水合窗口两用例 + 稳态真零来源对照。已知残留：`ensureLoaded` 无 catch（既有挂账），listProviders 拒绝时发送持续置灰 fail-closed。
