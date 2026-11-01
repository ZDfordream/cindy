/**
 * profile.ts — HR OA 个人资料页解析（/sys/person/setting.do?setting=sys_zone_person_info）。
 *
 * 字段来源（实测页面结构，同 HRMcp/parsers.py::parse_person_profile）：
 *   - 页头 JS var 块（单引号字符串字面量）：userName / loginName / dept / telphone /
 *     email / title → name / loginName / dept / mobile / email / title；
 *   - checked 的 fdSex radio：M→'男'、F→'女'；
 *   - fdPersonId hidden input 的 value → personId。
 *
 * licenseId（证件 id）刻意**不提取**——绝不进任何输出（沿用 HRMcp 的排除裁决）。
 */

export interface PersonProfile {
  name: string;
  loginName: string;
  dept: string;
  mobile: string;
  email: string;
  title: string;
  sex: string;
  personId: string;
}

// 输出字段 → 页面 JS 变量名（主来源）。
const JS_VARS: ReadonlyArray<readonly [keyof PersonProfile, string]> = [
  ['name', 'userName'],
  ['loginName', 'loginName'],
  ['dept', 'dept'],
  ['mobile', 'telphone'],
  ['email', 'email'],
  ['title', 'title'],
];

const SEX_LABELS: Record<string, string> = { M: '男', F: '女' };

// 单引号 JS 字符串字面量，内部允许 \' / \\ 转义（同 parsers.py 的 _JS_STR_RE）。
const JS_STR_RE = "'((?:[^'\\\\]|\\\\.)*)'";
const INPUT_TAG_RE = /<input\b[^>]*>/gi;

function jsVarStr(html: string, varName: string): string {
  const m = new RegExp('var\\s+' + varName + '\\s*=\\s*' + JS_STR_RE).exec(html);
  if (!m) return '';
  return m[1].replace(/\\(.)/g, '$1');
}

function tagAttr(tag: string, attr: string): string {
  const m = new RegExp(attr + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))').exec(tag);
  if (!m) return '';
  return m[1] ?? m[2] ?? m[3] ?? '';
}

function sexFromRadios(html: string): string {
  for (const tag of html.match(INPUT_TAG_RE) ?? []) {
    if (!/name\s*=\s*["']?fdSex["']?/i.test(tag)) continue;
    if (/\bchecked\b/i.test(tag)) return SEX_LABELS[tagAttr(tag, 'value')] ?? '';
  }
  return '';
}

function personIdFromInput(html: string): string {
  for (const tag of html.match(INPUT_TAG_RE) ?? []) {
    if (/name\s*=\s*["']?fdPersonId["']?/i.test(tag)) return tagAttr(tag, 'value');
  }
  return '';
}

/**
 * 解析个人资料页 HTML；缺字段给 `''`，任何输入都不抛。
 */
export function parsePersonProfile(html: string): PersonProfile {
  const profile: PersonProfile = {
    name: '',
    loginName: '',
    dept: '',
    mobile: '',
    email: '',
    title: '',
    sex: '',
    personId: '',
  };
  for (const [key, varName] of JS_VARS) {
    profile[key] = jsVarStr(html, varName);
  }
  profile.sex = sexFromRadios(html);
  profile.personId = personIdFromInput(html);
  return profile;
}

/** 账号键 = personId || loginName；两者皆空返回 `''`。 */
export function accountKeyFor(profile: PersonProfile): string {
  return profile.personId || profile.loginName;
}
