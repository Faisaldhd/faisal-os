/**
 * @vitest-environment node
 *
 * Runs under Node, which exposes the same WebCrypto API the browser does (jsdom does not).
 * The module under test takes the crypto object as a parameter, so no shim is involved.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ITERATIONS,
  MIN_ITERATIONS,
  MIN_PASSPHRASE_LENGTH,
  VaultError,
  fromBase64,
  openVault,
  parseEnvelope,
  sealNewVault,
  sealWithKey,
  toBase64,
  unlockVault,
  type CryptoLike,
} from './crypto';

/** Node's WebCrypto is the same API the browser exposes; the module takes it as a parameter. */
const nodeCrypto = globalThis.crypto as unknown as CryptoLike;
/** Small work factor keeps the suite fast; the envelope stores it, so files still open. */
const FAST = MIN_ITERATIONS;
const PASS = 'correct horse battery staple';

function code(err: unknown): string {
  return err instanceof VaultError ? err.code : `not-a-vault-error: ${String(err)}`;
}

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe('envelope', () => {
  it('carries only public parameters, never the plaintext or the passphrase', async () => {
    const secret = 'رقم الحساب السري 4417';
    const json = await sealNewVault(nodeCrypto, PASS, secret, FAST);
    expect(json).not.toContain(secret);
    expect(json).not.toContain(PASS);
    const e = parseEnvelope(json);
    expect(e.v).toBe(1);
    expect(e.kdf).toBe('PBKDF2-SHA256');
    expect(e.iterations).toBe(FAST);
    expect(fromBase64(e.salt)).toHaveLength(16);
    expect(fromBase64(e.iv)).toHaveLength(12);
    expect(fromBase64(e.ct).length).toBeGreaterThan(secret.length);
  });

  it('rejects malformed documents instead of guessing', () => {
    expect(code(catchSync(() => parseEnvelope('not json')))).toBe('bad-envelope');
    expect(code(catchSync(() => parseEnvelope('[]')))).toBe('bad-envelope');
    expect(code(catchSync(() => parseEnvelope('{"v":2,"kdf":"PBKDF2-SHA256","iterations":600000,"salt":"a","iv":"b","ct":"c"}')))).toBe('unsupported');
    expect(code(catchSync(() => parseEnvelope('{"v":1,"kdf":"PBKDF2-SHA256","iterations":10,"salt":"a","iv":"b","ct":"c"}')))).toBe('bad-envelope');
    expect(code(catchSync(() => parseEnvelope('{"v":1,"kdf":"PBKDF2-SHA256","iterations":600000,"salt":"","iv":"b","ct":"c"}')))).toBe('bad-envelope');
  });
});

/** parseEnvelope is synchronous but the assertion helper reads better as a value. */
function catchSync(fn: () => unknown): unknown {
  try {
    fn();
    return 'no error';
  } catch (err) {
    return err;
  }
}

describe('seal and open', () => {
  it('round-trips a document', async () => {
    const secret = 'مفتاح الاحتياط: 8842-1190\nسطر ثانٍ';
    const json = await sealNewVault(nodeCrypto, PASS, secret, FAST);
    await expect(openVault(nodeCrypto, PASS, json)).resolves.toBe(secret);
  });

  it('round-trips an empty document', async () => {
    const json = await sealNewVault(nodeCrypto, PASS, '', FAST);
    await expect(openVault(nodeCrypto, PASS, json)).resolves.toBe('');
  });

  it('refuses a short passphrase rather than creating a weak vault', async () => {
    await expect(sealNewVault(nodeCrypto, 'short', 'x', FAST)).rejects.toMatchObject({ code: 'unsupported' });
    expect(MIN_PASSPHRASE_LENGTH).toBeGreaterThan(0);
  });

  it('fails cleanly on a wrong passphrase', async () => {
    const json = await sealNewVault(nodeCrypto, PASS, 'secret', FAST);
    await expect(openVault(nodeCrypto, 'wrong passphrase', json)).rejects.toMatchObject({ code: 'wrong-passphrase' });
  });

  it('detects a tampered ciphertext (GCM authentication)', async () => {
    const json = await sealNewVault(nodeCrypto, PASS, 'secret', FAST);
    const e = parseEnvelope(json);
    const ct = fromBase64(e.ct);
    ct[0] ^= 0xff;
    const tampered = JSON.stringify({ ...e, ct: toBase64(ct) });
    await expect(openVault(nodeCrypto, PASS, tampered)).rejects.toMatchObject({ code: 'wrong-passphrase' });
  });

  it('re-encrypts with a fresh IV but the same salt and work factor', async () => {
    const first = await sealNewVault(nodeCrypto, PASS, 'one', FAST);
    const { key, salt, iterations } = await unlockVault(nodeCrypto, PASS, first);
    const second = await sealWithKey(nodeCrypto, key, 'two', { salt, iterations });
    const a = parseEnvelope(first);
    const b = parseEnvelope(second);
    expect(b.salt).toBe(a.salt);
    expect(b.iterations).toBe(a.iterations);
    expect(b.iv).not.toBe(a.iv);
    expect(b.ct).not.toBe(a.ct);
    await expect(openVault(nodeCrypto, PASS, second)).resolves.toBe('two');
  });

  it('produces a different ciphertext each save even for identical content', async () => {
    const a = await sealNewVault(nodeCrypto, PASS, 'same', FAST);
    const { key, salt, iterations } = await unlockVault(nodeCrypto, PASS, a);
    const b = await sealWithKey(nodeCrypto, key, 'same', { salt, iterations });
    expect(parseEnvelope(b).ct).not.toBe(parseEnvelope(a).ct);
  });

  it('defaults to a modern work factor', () => {
    expect(DEFAULT_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });
});
