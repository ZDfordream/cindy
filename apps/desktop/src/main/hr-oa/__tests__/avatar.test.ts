/**
 * 测试价值
 * - 生产入口与可观察结果：`avatarUrl()` 的地址构造（精确字符串：personId / size=b /
 *   s_time 三要素齐全，末尾斜杠归一）；`fetchAvatar()` 成功回 `{ bytes, contentType,
 *   key: personId+sTime }`（key 即缓存键）且请求地址就是 avatarUrl 的产物；transport 抛错 /
 *   非 200 / personId 空一律回 `null` 且不抛；失败路径的日志与返回值不含口令明文、
 *   不含 person_id 明文（错误原文不落日志、URL query 剥离）。
 * - Bug／规则依据：profile-menu 集成设计 §4.1 头像地址规律（H8）`image.jsp?personId=&
 *   size=b&s_time=` 与「缓存键 = person_id + s_time」（FR-PROFILE-02）；反目标「person_id
 *   明文绝不进日志/埋点」；凭证红线「口令绝不进日志」。头像失败必须 fail-soft 回 null
 *   （身份卡有品牌首字兜底，取图层不得把 transport 抛错漏成未处理拒绝或缓存到错误页）。
 * - 现有覆盖缺口：新模块，此前无头像取图层；oaClient.test.ts 只覆盖登录/资料 HTML 请求，
 *   不覆盖二进制取图与失败收口。
 * - 最小失败输入：精确 URL 一次；假 transport 回 200 + 二进制体往返断言 bytes；抛含口令
 *   哨兵与带 person_id query 的 Error 断言回 null 且日志零泄漏；非 200 断言不把错误页当
 *   头像；personId:'' 断言零请求。
 * - tier：unit（假 transport，无真实网络、无 Electron session）。
 * - 实测耗时：见文件末尾运行记录（单文件须 ≤5s）。
 */
import { describe, expect, it, vi } from 'vitest';

const logCalls = vi.hoisted(() => [] as Array<{ level: string; args: unknown[] }>);

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    trace: (...args: unknown[]) => logCalls.push({ level: 'trace', args }),
    debug: (...args: unknown[]) => logCalls.push({ level: 'debug', args }),
    info: (...args: unknown[]) => logCalls.push({ level: 'info', args }),
    warn: (...args: unknown[]) => logCalls.push({ level: 'warn', args }),
    error: (...args: unknown[]) => logCalls.push({ level: 'error', args }),
  }),
}));

import { avatarUrl, fetchAvatar } from '../avatar.js';
import type { OaResponse, OaTransport } from '../oaClient.js';

/** 二进制安全夹具：transport 合同里 body 是 string（latin1 语义），用 charCode 组装。 */
function binaryString(bytes: readonly number[]): string {
  return String.fromCharCode(...bytes);
}

function loggedText(): string {
  return logCalls
    .flatMap((c) => c.args)
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
}

describe('avatarUrl', () => {
  it('构造含 personId / size=b / s_time 的精确地址', () => {
    expect(avatarUrl('http://oa.example', 'p-1', '1710000000000')).toBe(
      'http://oa.example/sys/person/image.jsp?personId=p-1&size=b&s_time=1710000000000',
    );
    // 末尾斜杠归一（与 oaClient 的 absolute() 同口径），不得拼出 //sys/。
    expect(avatarUrl('http://oa.example/', 'p-1', 1710000000000)).toBe(
      'http://oa.example/sys/person/image.jsp?personId=p-1&size=b&s_time=1710000000000',
    );
  });
});

describe('fetchAvatar', () => {
  it('成功回 bytes / contentType / key（key = personId+sTime），请求地址即 avatarUrl', async () => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff];
    const request = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: binaryString(bytes),
      finalUrl: 'http://oa.example/sys/person/image.jsp',
    }));
    const transport: OaTransport = { request };

    const result = await fetchAvatar({
      baseUrl: 'http://oa.example',
      transport,
      personId: 'p-1',
      sTime: '1710',
    });

    expect(result).toEqual({
      key: 'p-11710',
      bytes: Uint8Array.from(bytes),
      contentType: 'image/png',
    });
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      path: avatarUrl('http://oa.example', 'p-1', '1710'),
    });
  });

  it('失败（抛错 / 非 200）一律 null 不抛，日志与返回值不出现口令与 person_id', async () => {
    const PASSWORD = 'pw-not-a-real-secret';
    logCalls.length = 0;
    const request = vi.fn(async (): Promise<OaResponse> => {
      // 传输层错误文本模拟粘连敏感信息（口令 + 带 person_id query 的完整地址）。
      throw new Error(
        `boom ${PASSWORD} GET http://oa.example/sys/person/image.jsp?personId=p-1&size=b&s_time=1710`,
      );
    });
    const transport: OaTransport = { request };

    const result = await fetchAvatar({
      baseUrl: 'http://oa.example',
      transport,
      personId: 'p-1',
      sTime: '1710',
    });
    expect(result).toBeNull();

    // 非 200（例如错误页）不得当成头像字节缓存。
    request.mockImplementation(async () => ({
      status: 500,
      headers: { 'content-type': 'text/html' },
      body: '<html>oops</html>',
      finalUrl: 'http://oa.example/sys/person/image.jsp',
    }));
    expect(
      await fetchAvatar({ baseUrl: 'http://oa.example', transport, personId: 'p-1', sTime: '1710' }),
    ).toBeNull();

    const logged = loggedText();
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain('p-1');
    expect(logged).not.toContain('personId=');
  });

  it('personId 为空回 null 且不发请求', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: binaryString([1, 2]),
      finalUrl: '',
    }));
    const transport: OaTransport = { request };

    expect(
      await fetchAvatar({ baseUrl: 'http://oa.example', transport, personId: '', sTime: '1710' }),
    ).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
