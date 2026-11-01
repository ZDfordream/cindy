/**
 * 测试价值
 * - 生产入口与可观察结果：parsePersonProfile() 从 setting.do 页面 HTML 解析 8 字段资料
 *   （name/loginName/dept/mobile/email/title/sex/personId，缺字段给 ''）；accountKeyFor()
 *   = personId || loginName。资料展示与账号键是登录后数据分区的直接输入。
 * - Bug／规则依据：HRMcp parsers.parse_person_profile 的实测页面结构（页头 JS var 块 +
 *   checked fdSex radio + fdPersonId hidden input）；licenseId（证件 id）刻意不提取，
 *   绝不能进输出（计划 Step 7）；accountKeyFor 的 personId 优先 / 回退 loginName。
 * - 现有覆盖缺口：登录门禁新模块，此前没有资料页解析覆盖。
 * - 最小失败输入：最小页面夹具（全 8 字段 + licenseId 旁路值 + 转义 var 值）；空 HTML 全缺省；
 *   accountKeyFor 的 personId 优先 / 双空回退。
 * - tier：unit（纯 HTML 字符串解析，无 IO）。
 * - 实测耗时：单文件 ~0.3s（pnpm --dir apps/desktop exec vitest run src/main/hr-oa/__tests__/profile.test.ts）。
 */
import { describe, expect, it } from 'vitest';

import { accountKeyFor, parsePersonProfile, type PersonProfile } from '../profile.js';

const FULL_HTML = [
  '<html><head><script>',
  "var userName = '张三';",
  "var loginName = 'u123';",
  "var dept = '人力资源部';",
  "var telphone = '13800000000';",
  "var email = 'u123@example.com';",
  "var title = 'HR\\'s BP';",
  "var licenseId = 'SECRET-LICENSE-ID';",
  '</script></head><body>',
  '<input type="radio" name="fdSex" value="M" checked>',
  '<input type="radio" name="fdSex" value="F">',
  '<input type="hidden" name="fdPersonId" value="p42">',
  '</body></html>',
].join('\n');

describe('parsePersonProfile', () => {
  it('parses the 8 profile fields from the setting page', () => {
    const profile = parsePersonProfile(FULL_HTML);
    expect(profile).toEqual({
      name: '张三',
      loginName: 'u123',
      dept: '人力资源部',
      mobile: '13800000000',
      email: 'u123@example.com',
      // 转义引号被还原（页面 JS 字符串字面量语义）。
      title: "HR's BP",
      sex: '男',
      personId: 'p42',
    } satisfies PersonProfile);
  });

  it('never surfaces licenseId (证件 id) in any output field', () => {
    const profile = parsePersonProfile(FULL_HTML);
    expect(Object.values(profile).join('\u0000').includes('SECRET-LICENSE-ID')).toBe(false);
  });

  it('defaults missing fields to empty strings', () => {
    expect(parsePersonProfile('<html>no vars here</html>')).toEqual({
      name: '',
      loginName: '',
      dept: '',
      mobile: '',
      email: '',
      title: '',
      sex: '',
      personId: '',
    });
  });
});

describe('accountKeyFor', () => {
  it('prefers personId, falls back to loginName, and stays empty when both are empty', () => {
    const base: PersonProfile = {
      name: '',
      loginName: 'u1',
      dept: '',
      mobile: '',
      email: '',
      title: '',
      sex: '',
      personId: 'p9',
    };
    expect(accountKeyFor(base)).toBe('p9');
    expect(accountKeyFor({ ...base, personId: '' })).toBe('u1');
    expect(accountKeyFor({ ...base, personId: '', loginName: '' })).toBe('');
  });
});
