/**
 * 测试价值
 * - 生产入口与可观察结果：`trackHrOaEvent()`（main/hr-oa/telemetry.ts）——PRD §10.2 的 14 个
 *   登录漏斗事件 + profile-menu PRD §11 的 10 个新事件逐个经登记 sink 发出，事件属性键与两张
 *   表一致；`registerHrOaTelemetrySink` 可替换出口（后续接真实后端不改调用点）。
 * - Bug／规则依据：login-onboarding PRD §10 + profile-menu PRD §11（埋点与数据指标）+
 *   S-1 / §7.3 采集边界红线——口令、API Key、明文账号、姓名/登录名/邮箱/手机号/头像地址/
 *   person_id 明文、完整接口地址绝不进埋点；账号只以 `account_hash`（SHA-256 前 8 位）出现，
 *   接口地址只以 `url_host` 出现；不为图标提示埋点（§11 末句）。另含 Task 8 挂账：`token_refresh`
 *   未进白名单即被 `trackHrOaEvent` **静默丢弃**（事件永不上线）——必须对**真**
 *   `trackHrOaEvent` 断言出货（tokenRefresh.test.mock 了 telemetry，缺行不红）。
 * - 现有覆盖缺口：§11 的 10 个新事件（含 `logout.entry`、`token_refresh` 五字段）此前不在
 *   白名单表与哨兵网内；哨兵集也未含姓名/登录名/邮箱/手机号/头像地址/person_id/Cookie/
 *   X-Auth-Token 八类 §11 明文禁区。
 * - 最小失败输入：表驱动 24 事件各发一次断言属性键（缺白名单行 = 载荷缺失即红）；哨兵
 *   PII／凭证值塞进每个事件的允许键与禁用键，断言发出的 JSON 载荷零出现。
 * - tier：unit（纯内存 sink，logger 打桩；无网络、无 IPC）。
 * - 实测耗时：约 10ms（本机 2026-11-02，
 *   `pnpm --dir apps/desktop exec vitest run src/main/hr-oa/__tests__/telemetry.test.ts`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  HR_OA_EVENT_PROPS,
  hashHrAccount,
  registerHrOaTelemetrySink,
  setHrOaTelemetryContext,
  trackHrOaEvent,
  type HrOaEventName,
  type HrOaEventPayload,
} from '../telemetry.js';

/** PRD §10.2 + §11：24 个事件 → 各自的事件属性键（通用属性除外）。对外协议，改表=改数仓。 */
const EXPECTED_EVENT_PROPS: Record<HrOaEventName, readonly string[]> = {
  welcome_view: ['from'],
  login_click: [],
  login_view: [],
  login_submit: ['account_type'],
  login_result: ['result', 'duration_ms', 'attempt_no'],
  model_dialog_view: ['origin'],
  model_field_error: ['field', 'error_type'],
  model_save_submit: ['origin', 'url_host', 'model_id'],
  model_save_result: ['origin', 'result', 'duration_ms'],
  model_dialog_skip: ['origin', 'method', 'had_input'],
  home_view: ['model_state', 'entry'],
  home_gate_trigger: ['trigger'],
  message_send: ['model_state', 'source', 'is_first_message'],
  logout: ['reason', 'entry'],
  profile_fetch: ['source', 'result', 'duration_ms', 'has_cache'],
  profile_avatar_error: ['size'],
  profile_menu_open: ['method', 'profile_state'],
  profile_menu_click: ['item', 'method'],
  logout_confirm_view: ['has_running_task'],
  logout_confirm_result: ['result', 'method'],
  nav_click: ['item'],
  plugins_skills_tab: ['tab'],
  token_refresh: ['trigger', 'result', 'attempt', 'duration_ms', 'overdue_ms'],
  home_banner_click: [],
};

/** 每个事件的合法样本值（覆盖 PRD 枚举中的任意合法取值即可）。 */
const SAMPLE_PROPS: Record<HrOaEventName, Record<string, unknown>> = {
  welcome_view: { from: 'launch' },
  login_click: {},
  login_view: {},
  login_submit: { account_type: 'account' },
  login_result: { result: 'success', duration_ms: 812, attempt_no: 1 },
  model_dialog_view: { origin: 'onboarding' },
  model_field_error: { field: 'url', error_type: 'empty' },
  model_save_submit: { origin: 'home_send', url_host: 'api.example.com', model_id: 'gpt-4o' },
  model_save_result: { origin: 'home_send', result: 'timeout', duration_ms: 10000 },
  model_dialog_skip: { origin: 'onboarding', method: 'esc', had_input: true },
  home_view: { model_state: 'unconfigured', entry: 'skip' },
  home_gate_trigger: { trigger: 'customize' },
  message_send: { model_state: 'configured', source: 'suggestion', is_first_message: true },
  logout: { reason: 'token_expired', entry: 'token_refresh' },
  profile_fetch: { source: 'stale', result: 'success', duration_ms: 460, has_cache: true },
  profile_avatar_error: { size: 28 },
  profile_menu_open: { method: 'keyboard', profile_state: 'ready' },
  profile_menu_click: { item: 'settings', method: 'shortcut' },
  logout_confirm_view: { has_running_task: true },
  logout_confirm_result: { result: 'cancel', method: 'esc' },
  nav_click: { item: 'plugins_skills' },
  plugins_skills_tab: { tab: 'skills' },
  token_refresh: {
    trigger: 'wake',
    result: 'success',
    attempt: 0,
    duration_ms: 903,
    overdue_ms: 61_000,
  },
  home_banner_click: {},
};

const COMMON_PROPS = ['app_version', 'os_version', 'session_id', 'account_hash', 'ts'];

describe('trackHrOaEvent', () => {
  let captured: HrOaEventPayload[];

  beforeEach(() => {
    captured = [];
    setHrOaTelemetryContext({
      appVersion: '1.2.3',
      osVersion: '15.0',
      sessionId: 'sess-fixed',
      account: 'alice',
    });
    registerHrOaTelemetrySink((payload) => {
      captured.push(payload);
    });
  });

  afterEach(() => {
    registerHrOaTelemetrySink(null);
    setHrOaTelemetryContext({ account: null });
  });

  it('24 个事件的属性键与 PRD §10.2/§11 表一致（事件键 + 5 个通用属性）', () => {
    expect(Object.keys(HR_OA_EVENT_PROPS).sort()).toEqual(Object.keys(EXPECTED_EVENT_PROPS).sort());
    for (const [name, keys] of Object.entries(EXPECTED_EVENT_PROPS)) {
      expect([...HR_OA_EVENT_PROPS[name as HrOaEventName]].sort(), name).toEqual([...keys].sort());
    }

    for (const name of Object.keys(EXPECTED_EVENT_PROPS) as HrOaEventName[]) {
      trackHrOaEvent(name, { ...SAMPLE_PROPS[name] });
    }
    expect(captured).toHaveLength(24);

    for (const [index, name] of (Object.keys(EXPECTED_EVENT_PROPS) as HrOaEventName[]).entries()) {
      const payload = captured[index];
      expect(payload.name).toBe(name);
      const keys = Object.keys(payload.properties);
      for (const common of COMMON_PROPS) expect(keys, `${name} 缺通用属性`).toContain(common);
      const eventKeys = keys.filter((key) => !COMMON_PROPS.includes(key));
      expect(eventKeys.sort(), name).toEqual([...EXPECTED_EVENT_PROPS[name]].sort());
      for (const [key, value] of Object.entries(SAMPLE_PROPS[name])) {
        expect(payload.properties[key], `${name}.${key}`).toEqual(value);
      }
    }
  });

  it('token_refresh 经真 trackHrOaEvent 出货（Task 8 挂账：缺白名单行=生产静默丢弃）', () => {
    // 本文件不 mock telemetry 模块——这里断言的就是生产同款 trackHrOaEvent 会把
    // token_refresh 交给 sink。tokenRefresh.test.ts mock 了 telemetry，白名单漏行不红。
    trackHrOaEvent('token_refresh', {
      trigger: 'timer',
      result: 'network_error',
      attempt: 2,
      duration_ms: 1200,
      overdue_ms: -3,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].name).toBe('token_refresh');
    expect(captured[0].properties).toMatchObject({
      trigger: 'timer',
      result: 'network_error',
      attempt: 2,
      duration_ms: 1200,
      overdue_ms: -3,
    });
  });

  it('通用属性取自上下文：account_hash 为 SHA-256 前 8 位，ts 为时间戳', () => {
    const before = Date.now();
    trackHrOaEvent('login_view', {});
    const props = captured[0].properties;
    expect(props.app_version).toBe('1.2.3');
    expect(props.os_version).toBe('15.0');
    expect(props.session_id).toBe('sess-fixed');
    expect(props.account_hash).toBe(hashHrAccount('alice'));
    expect(props.account_hash).toMatch(/^[0-9a-f]{8}$/);
    expect(props.ts as number).toBeGreaterThanOrEqual(before);
  });

  it('采集边界：哨兵 PII／凭证／明文账号／完整 URL 穿透 24 事件后不出现在载荷', () => {
    const SECRETS = [
      'SENTINEL_PASSWORD_9f3a',
      'SENTINEL_API_KEY_77b1',
      'SENTINEL_SECRET_c2d4',
      'sentinel-user@example.com',
      'SENTINEL_TOKEN_ab12',
      // §11 禁区八类（姓名 / 登录名 / 邮箱 / 手机号 / 头像地址 / person_id /
      // Cookie / X-Auth-Token）：值喂进禁用键（白名单外）与 account/url_host 收窄面。
      'SENTINEL_NAME_5a6b',
      'SENTINEL_LOGIN_6c7d',
      'SENTINEL_EMAIL_7e8f@corp.example.com',
      'SENTINEL_MOBILE_13900139000',
      'SENTINEL_AVATAR_8a9b',
      'SENTINEL_PERSONID_9c0d',
      'SENTINEL_COOKIE_0e1f',
      'SENTINEL_XAUTH_2a3b',
    ];
    const secretProps: Record<string, unknown> = {
      password: SECRETS[0],
      apiKey: SECRETS[1],
      api_key: SECRETS[1],
      secret: SECRETS[2],
      token: SECRETS[4],
      authorization: `Bearer ${SECRETS[4]}`,
      account: SECRETS[3],
      baseUrl: `https://${SECRETS[1]}:${SECRETS[0]}@private.example.com:9443/v1/secret-path?key=${SECRETS[2]}`,
      url: `https://internal.example.com/${SECRETS[2]}`,
      // §11 明文禁区键名（含驼峰/下划线两式）。
      name: SECRETS[5],
      login_name: SECRETS[6],
      loginName: SECRETS[6],
      email: SECRETS[7],
      mobile: SECRETS[8],
      phone: SECRETS[8],
      avatar_url: SECRETS[9],
      avatarUrl: SECRETS[9],
      person_id: SECRETS[10],
      personId: SECRETS[10],
      cookie: SECRETS[11],
      'x-auth-token': SECRETS[12],
      xAuthToken: SECRETS[12],
    };

    for (const name of Object.keys(EXPECTED_EVENT_PROPS) as HrOaEventName[]) {
      trackHrOaEvent(name, { ...SAMPLE_PROPS[name], ...secretProps });
    }
    expect(captured).toHaveLength(24);

    for (const payload of captured) {
      const dumped = JSON.stringify(payload);
      for (const sentinel of SECRETS) {
        expect(dumped, `${payload.name} 泄漏 ${sentinel}`).not.toContain(sentinel);
      }
      // 明文账号只许以哈希形态存在；完整 URL 只许以 host 形态存在。
      expect(payload.properties.account).toBeUndefined();
      expect(payload.properties.baseUrl).toBeUndefined();
      expect(payload.properties.url).toBeUndefined();
      expect(payload.properties.account_hash).toBe(hashHrAccount(SECRETS[3]));
    }

    // model_save_submit 的 url_host 允许键被塞入带凭证全 URL 时也必须收窄成 host。
    trackHrOaEvent('model_save_submit', {
      origin: 'onboarding',
      model_id: 'm1',
      url_host: `https://${SECRETS[1]}:${SECRETS[0]}@private.example.com:9443/v1/secret-path?key=${SECRETS[2]}`,
    });
    const hostDumped = JSON.stringify(captured[24]);
    for (const sentinel of SECRETS) {
      expect(hostDumped, `url_host 未收窄，泄漏 ${sentinel}`).not.toContain(sentinel);
    }
    expect(captured[24].properties.url_host).toBe('private.example.com:9443');
  });

  it('不为图标提示埋点（§11 末句）：事件名表无 tooltip 家族，提示事件名被静默丢弃', () => {
    const tooltipish = Object.keys(HR_OA_EVENT_PROPS).filter((name) =>
      /tooltip|(^|_)tip($|_)|hint/i.test(name),
    );
    expect(tooltipish).toEqual([]);

    trackHrOaEvent('tooltip_show', { target: 'settings' });
    trackHrOaEvent('tip_hover', { target: 'settings' });
    trackHrOaEvent('hint_view', { target: 'settings' });
    expect(captured).toHaveLength(0);
  });

  it('未知事件名不发出；表外属性键被丢弃；注销 sink 后回退默认出口不抛错', () => {
    trackHrOaEvent('not_an_event', { foo: 'bar' });
    expect(captured).toHaveLength(0);

    trackHrOaEvent('logout', { reason: 'user', entry: 'profile_menu', extra: 'dropped' });
    expect(captured).toHaveLength(1);
    expect(captured[0].properties.extra).toBeUndefined();
    expect(captured[0].properties.entry).toBe('profile_menu');

    const unregister = registerHrOaTelemetrySink(null);
    expect(() => trackHrOaEvent('login_click', {})).not.toThrow();
    unregister();
  });
});
