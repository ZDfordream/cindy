/**
 * 测试价值
 * - 生产入口与可观察结果：encryptPassword()（口令写入 j_password 前的唯一 SM2 加密入口）的输出
 *   = SECURITY_MARKER + 04||C1||C2||C3 密文 hex；空明文/空公钥抛错；同一明文两次加密密文不同但都能
 *   解回同一明文；vendor 解密回环还原原明文；失败错误文本不含口令明文。
 * - Bug／规则依据：HRMcp 复盘的最贵失败模式「登录密码加密格式错 → 服务端静默回 login_error=1」。
 *   回环钉死 2 参 encs 的 04||C1||C2||C3 布局（换 3 参 encs 会重排成 C1||C3||C2，门户静默 login_error，
 *   计划 Review Focus #2）；SECURITY_MARKER 钉死门户 recon/security.js 的 d.security
 *   （String.fromCharCode(0x534d, 0x3220, 0x4d45)）——错标同样静默 login_error，故对该协议常量保留字面量断言。
 * - 现有覆盖缺口：登录门禁新模块，此前没有任何 SM2 口令加密覆盖。
 * - 最小失败输入：encryptPassword('', pub) / encryptPassword(canary, '')；一次输出的前缀+hex 形态；
 *   同一明文两连加密；encs→decs 回环（ASCII 与多字节明文）；带孤代理项的明文触发 vendor 抛错路径查泄漏。
 * - tier：unit（vendor JS 在进程内 vm 沙箱执行，无网络、无子进程、无 Electron）。
 * - 实测耗时：单文件 ~0.6s（pnpm --dir apps/desktop exec vitest run src/main/hr-oa/__tests__/sm2Password.test.ts）。
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import { SECURITY_MARKER, encryptPassword } from '../sm2Password.js';

// vendor JS 在测试里作为**行为**驱动（vm 沙箱执行加密/解密），不是源码文本断言对象；
// 读取结果只进 runInContext，从不进 expect——test-hygiene 的 executedSourcePaths 豁免路径。
const desSource = readFileSync(new URL('../vendor/des.js', import.meta.url), 'utf8');
const sm2Source = readFileSync(new URL('../vendor/sm2.js', import.meta.url), 'utf8');

// SM2 曲线生成元 G（公钥 = 私钥标量 * G）。用有效曲线点做测试密钥，避开无效点在
// InitEncipher 里按随机标量偶发抛错的非确定性（HRMcp tests/test_sm2_bridge.py 同款替换）。
const GX = '32c4ae2c1f1981195f9904466a39c9948fe30bbff2660be1715a4589334c74c7';
const GY = 'bc3736a2f4f6779c59bdcee36b692153d0a9877cc62a474002df32e52139f0a0';

interface BigIntegerLike {
  toString(radix: number): string;
}

interface BigIntegerCtor {
  new (hex: string, radix: number): BigIntegerLike;
}

interface PointLike {
  getX(): { toBigInteger(): BigIntegerLike };
  getY(): { toBigInteger(): BigIntegerLike };
  multiply(k: BigIntegerLike): PointLike;
}

interface CipherLike {
  CreatePoint(xHex: string, yHex: string): PointLike;
  Decrypt(priv: BigIntegerLike, cipherBody: string): string;
}

interface VendorGlobals {
  SM2Utils: { encs(key: string, plain: string, cipherMode?: number): string };
  SM2: { SM2Cipher: new (cipherMode?: number) => CipherLike };
  CryptoJS: { lib: { WordArray: { init: { prototype: unknown } & (new (...args: unknown[]) => unknown) } } };
}

// sm2_encrypt.js 同款沙箱接线（window / navigator / Com_RegisterFile shim + des.js 旧构建缺的
// WordArray.init.prototype 桥）。vendor 源码原样执行、不手改。
function createVendorSandbox(): VendorGlobals {
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  sandbox.navigator = { appName: 'Netscape', appVersion: '5.0' };
  sandbox.Com_RegisterFile = () => {};
  const context = vm.createContext(sandbox);
  vm.runInContext(desSource, context, { filename: 'des.js' });
  vm.runInContext(sm2Source, context, { filename: 'sm2.js' });
  const globals = sandbox as unknown as VendorGlobals;
  globals.CryptoJS.lib.WordArray.init.prototype = globals.CryptoJS.lib.WordArray;
  return globals;
}

function pad64(hex: string): string {
  const even = hex.length % 2 ? '0' + hex : hex;
  return even.padStart(64, '0');
}

// 用 vendor 自己的椭圆曲线乘法自生成密钥对：priv = 随机标量，pub = G * priv。
function generateKeyPair(vendor: VendorGlobals): { pubHex: string; priv: BigIntegerLike } {
  const cipher = new vendor.SM2.SM2Cipher(0);
  const G = cipher.CreatePoint(GX, GY);
  const BigInteger = G.getX().toBigInteger().constructor as BigIntegerCtor;
  const privHex = randomBytes(32).toString('hex');
  const priv = new BigInteger(privHex, 16);
  const P = G.multiply(priv);
  const pubHex = '04' + pad64(P.getX().toBigInteger().toString(16)) + pad64(P.getY().toBigInteger().toString(16));
  return { pubHex, priv };
}

function vendorDecrypt(vendor: VendorGlobals, priv: BigIntegerLike, cipherHex: string): string {
  // 密文体去掉 04 非压缩点前缀后按 04||C1||C2||C3 里的 C1||C2||C3 段解。
  return new vendor.SM2.SM2Cipher(0).Decrypt(priv, cipherHex.slice(2));
}

const vendor = createVendorSandbox();
const { pubHex, priv } = generateKeyPair(vendor);

describe('SECURITY_MARKER', () => {
  it('is the portal security.js sm2 field marker (wrong marker → silent login_error)', () => {
    // 对外协议常量：recon/security.js 里 desEncrypt 返回 d.security + 密文，
    // sm2 模式的 d.security = String.fromCharCode(0x534d, 0x3220, 0x4d45)。
    // 写错（例如误写成 ASCII "SM2 "）服务端不认标记，登录被静默弹回 login_error。
    expect(SECURITY_MARKER).toBe(String.fromCharCode(0x534d, 0x3220, 0x4d45));
  });
});

describe('encryptPassword', () => {
  it('rejects empty plaintext and empty pubkey', () => {
    expect(() => encryptPassword('', pubHex)).toThrow();
    expect(() => encryptPassword('pw', '')).toThrow();
  });

  it('returns SECURITY_MARKER + 04-prefixed hex ciphertext', () => {
    const out = encryptPassword('test-pass', pubHex);
    expect(out.startsWith(SECURITY_MARKER)).toBe(true);
    const cipher = out.slice(SECURITY_MARKER.length);
    expect(cipher).toMatch(/^04[0-9a-f]+$/);
  });

  it('round-trips through the vendor decryptor (pins 2-arg encs 04||C1||C2||C3 layout)', () => {
    // 换成 3 参 encs(pub, plain, 1) 会重排成 C1||C3||C2，这里解密得 '' 而不是原明文——
    // 而门户对错误布局只回静默 login_error。ASCII 与多字节明文都过一遍。
    for (const plain of ['test-pass', '口令-2026']) {
      const out = encryptPassword(plain, pubHex);
      expect(vendorDecrypt(vendor, priv, out.slice(SECURITY_MARKER.length))).toBe(plain);
    }
  });

  it('is randomized per call but both ciphertexts decrypt to the same plaintext', () => {
    const a = encryptPassword('x', pubHex);
    const b = encryptPassword('x', pubHex);
    expect(a).not.toBe(b);
    expect(vendorDecrypt(vendor, priv, a.slice(SECURITY_MARKER.length))).toBe('x');
    expect(vendorDecrypt(vendor, priv, b.slice(SECURITY_MARKER.length))).toBe('x');
  });

  it('never lets the plaintext reach thrown error text', () => {
    const canary = 'SECRETPW-LEAK-CANARY';
    for (const run of [
      () => encryptPassword(canary, ''),
      // 孤代理项让 vendor 的 CryptoJS Utf8.parse 必抛 URI malformed —— 确定性 vendor 失败路径。
      () => encryptPassword(canary + '\uD800', pubHex),
    ]) {
      let message = '';
      try {
        run();
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).not.toBe('');
      expect(message.includes(canary)).toBe(false);
    }
  });
});
