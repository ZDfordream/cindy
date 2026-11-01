/**
 * sm2Password.ts — HR OA 门户登录口令的 SM2 加密桥。
 *
 * 复刻门户自己的 recon/security.js 字段格式：`d.security + SM2 密文 hex`。
 * vendor sm2.js/des.js 原样拷贝自 HRMcp/vendor（勿手改），经 Node `vm` 沙箱在
 * 进程内执行；接线同 HRMcp/vendor/sm2_encrypt.js（含 des.js 旧构建缺的
 * CryptoJS.lib.WordArray.init.prototype 桥）。
 *
 * 密文布局必须是 2 参 `SM2Utils.encs(pub, plain)` 产出的 `04||C1||C2||C3`：
 * 换 3 参 `encs(pub, plain, 1)` 会重排成 `04||C1||C3||C2`，门户**静默**弹回
 * login_error（见 HRMcp/vendor/sm2_encrypt.js 头注）。
 *
 * 安全红线：口令明文不得出现在任何异常文本里——错误消息一律过 scrub 把明文换成 `***`。
 */

import vm from 'node:vm';

import desSource from './vendor/des.js?raw';
import sm2Source from './vendor/sm2.js?raw';

/**
 * 门户 recon/security.js 的 sm2 标记：`d.security = String.fromCharCode(0x534d, 0x3220, 0x4d45)`
 * （3 个 UTF-16 code unit，即 '卍㈠䵅'；按大端字节读是 "SM2 ME"）。`desEncrypt` 返回
 * `d.security + 密文`。标记写错服务端不认，登录被**静默**弹回 login_error——计划文本里
 * 的 ASCII "SM2 " 是对这串 fromCharCode 的误读，线上格式以 recon/security.js 与
 * HRMcp/oa_client.py（实测可用）为准。
 */
export const SECURITY_MARKER = String.fromCharCode(0x534d, 0x3220, 0x4d45);

interface Sm2Utils {
  // cipherMode 省略即 C1C2C3；切勿传 1（会变 C1C3C2）。
  encs(key: string, plain: string, cipherMode?: number): string;
}

interface SandboxGlobals {
  SM2Utils: Sm2Utils;
  CryptoJS: { lib: { WordArray: { init: { prototype: unknown } & object } } };
}

/** 照 sm2_encrypt.js 的 scrub：错误文本里的明文替换为 ***。 */
function scrub(text: string, secret: string): string {
  return secret ? String(text).split(secret).join('***') : String(text);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let cachedSm2: Sm2Utils | null = null;

function loadSm2Utils(): Sm2Utils {
  if (cachedSm2) return cachedSm2;
  // sm2_encrypt.js 同款沙箱 shim：sm2.js 期望浏览器侧的 window/navigator/Com_RegisterFile。
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  sandbox.navigator = { appName: 'Netscape', appVersion: '5.0' };
  sandbox.Com_RegisterFile = () => {};
  const context = vm.createContext(sandbox);
  vm.runInContext(desSource, context, { filename: 'des.js' });
  vm.runInContext(sm2Source, context, { filename: 'sm2.js' });
  const globals = sandbox as unknown as SandboxGlobals;
  // des.js 的 CryptoJS.Base.extend 是旧构建，缺 crypto-js 的 `init.prototype = <class>`
  // 接线；不补这行 sm2.js 的 GetHex 会把 WordArray 序列化成 "[object Object]"。
  globals.CryptoJS.lib.WordArray.init.prototype = globals.CryptoJS.lib.WordArray;
  cachedSm2 = globals.SM2Utils;
  return cachedSm2;
}

/**
 * 按门户 security.js 的格式加密登录口令，返回 `SECURITY_MARKER + 密文 hex`。
 *
 * @param plain 口令明文（不得为空——vendor 对空串静默返回 ''）
 * @param pubkeyHex 门户 session.jsp `getSM2PubKey()` 的 SM2 公钥 hex（不得为空）
 * @throws Error 空参、vendor 加载或加密失败；消息里的明文一律已被替换为 `***`
 */
export function encryptPassword(plain: string, pubkeyHex: string): string {
  if (!plain) throw new Error('password must be non-empty');
  if (!pubkeyHex) throw new Error('pubkey hex must be non-empty');
  let cipher: string;
  try {
    // 2 参调用 = SM2Cipher(0) = 04||C1||C2||C3，与门户 security.js 的 desEncrypt 同序。
    cipher = loadSm2Utils().encs(pubkeyHex, plain);
  } catch (e) {
    throw new Error('sm2 encryption failed: ' + scrub(errorText(e), plain));
  }
  if (!cipher) throw new Error('sm2 encryption produced empty ciphertext');
  return SECURITY_MARKER + cipher;
}
