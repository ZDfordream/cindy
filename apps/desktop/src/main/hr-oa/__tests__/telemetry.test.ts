/**
 * 测试价值
 * - 生产入口与可观察结果：`trackHrOaEvent()`（main/hr-oa/telemetry.ts）——PRD §10.2 的 14 个
 *   HR OA 漏斗事件逐个经登记 sink 发出，事件属性键与 §10.2 表一致；`registerHrOaTelemetrySink`
 *   可替换出口（后续接真实后端不改调用点）。
 * - Bug／规则依据：login-onboarding PRD §10（埋点与数据指标）+ S-1 / §7.3 采集边界红线——
 *   口令、API Key、明文账号、完整接口地址绝不进埋点；账号只以 `account_hash`（SHA-256 前 8 位）
 *   出现，接口地址只以 `url_host` 出现。
 * - 现有覆盖缺口：本模块是新增；此前没有任何 HR OA 埋点组装／脱敏覆盖，也没有哨兵密钥
 *   穿透 14 事件证明采集边界。
 * - 最小失败输入：表驱动 14 事件各发一次断言属性键；哨兵口令／API Key／明文账号／带凭证
 *   全 URL 塞进每个事件的允许键与禁用键，断言发出的 JSON 载荷不含任何哨兵。
 * - tier：unit（纯内存 sink，logger 打桩；无网络、无 IPC）。
 * - 实测耗时：约 6ms（本机 2026-11-01，
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

/** PRD §10.2：14 个事件 → 各自的事件属性键（通用属性除外）。 */
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
  logout: ['reason'],
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
  logout: { reason: 'token_expired' },
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

  it('14 个事件的属性键与 PRD §10.2 表一致（事件键 + 5 个通用属性）', () => {
    expect(Object.keys(HR_OA_EVENT_PROPS).sort()).toEqual(Object.keys(EXPECTED_EVENT_PROPS).sort());
    for (const [name, keys] of Object.entries(EXPECTED_EVENT_PROPS)) {
      expect([...HR_OA_EVENT_PROPS[name as HrOaEventName]].sort(), name).toEqual([...keys].sort());
    }

    for (const name of Object.keys(EXPECTED_EVENT_PROPS) as HrOaEventName[]) {
      trackHrOaEvent(name, { ...SAMPLE_PROPS[name] });
    }
    expect(captured).toHaveLength(14);

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

  it('采集边界：哨兵口令/API Key/明文账号/完整 URL 穿透 14 事件后不出现在载荷', () => {
    const SECRETS = [
      'SENTINEL_PASSWORD_9f3a',
      'SENTINEL_API_KEY_77b1',
      'SENTINEL_SECRET_c2d4',
      'sentinel-user@example.com',
      'SENTINEL_TOKEN_ab12',
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
    };

    for (const name of Object.keys(EXPECTED_EVENT_PROPS) as HrOaEventName[]) {
      trackHrOaEvent(name, { ...SAMPLE_PROPS[name], ...secretProps });
    }
    expect(captured).toHaveLength(14);

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
    const hostDumped = JSON.stringify(captured[14]);
    for (const sentinel of SECRETS) {
      expect(hostDumped, `url_host 未收窄，泄漏 ${sentinel}`).not.toContain(sentinel);
    }
    expect(captured[14].properties.url_host).toBe('private.example.com:9443');
  });

  it('未知事件名不发出；表外属性键被丢弃；注销 sink 后回退默认出口不抛错', () => {
    trackHrOaEvent('not_an_event', { foo: 'bar' });
    expect(captured).toHaveLength(0);

    trackHrOaEvent('logout', { reason: 'user', extra: 'dropped' });
    expect(captured).toHaveLength(1);
    expect(captured[0].properties.extra).toBeUndefined();

    const unregister = registerHrOaTelemetrySink(null);
    expect(() => trackHrOaEvent('login_click', {})).not.toThrow();
    unregister();
  });
});
