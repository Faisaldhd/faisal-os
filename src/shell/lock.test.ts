/**
 * @vitest-environment node
 *
 * Runs under Node, which exposes the same WebCrypto API the browser does (jsdom does not).
 */
import { describe, it, expect } from 'vitest';
import {
  LOCK_ITERATIONS,
  MIN_LOCK_PASSWORD,
  STRONG_LOCK_PASSWORD,
  fromBase64,
  hashPassword,
  makeLockRecord,
  parseLockRecord,
  toBase64,
  verifyPassword,
  type CryptoLike,
} from './lock';

const crypto = globalThis.crypto as unknown as CryptoLike;
const PASS = 'my-lock-2026';

describe('parseLockRecord', () => {
  it('accepts a well-formed record', async () => {
    const record = await makeLockRecord(crypto, PASS, 'a hint');
    expect(parseLockRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it('refuses anything unexpected instead of throwing at boot', () => {
    expect(parseLockRecord(null)).toBeNull();
    expect(parseLockRecord([])).toBeNull();
    expect(parseLockRecord('nope')).toBeNull();
    expect(parseLockRecord({ v: 2, kdf: 'PBKDF2-SHA256', iterations: 250000, salt: 'a', hash: 'b' })).toBeNull();
    expect(parseLockRecord({ v: 1, kdf: 'scrypt', iterations: 250000, salt: 'a', hash: 'b' })).toBeNull();
    expect(parseLockRecord({ v: 1, kdf: 'PBKDF2-SHA256', iterations: 10, salt: 'a', hash: 'b' })).toBeNull();
    expect(parseLockRecord({ v: 1, kdf: 'PBKDF2-SHA256', iterations: 250000, salt: '', hash: 'b' })).toBeNull();
    expect(parseLockRecord({ v: 1, kdf: 'PBKDF2-SHA256', iterations: 250000, salt: 'a', hash: 'b', hint: 5 })).toBeNull();
  });
});

describe('password verifier', () => {
  it('stores a verifier, never the passphrase', async () => {
    const record = await makeLockRecord(crypto, PASS, 'hint');
    const json = JSON.stringify(record);
    expect(json).not.toContain(PASS);
    expect(fromBase64(record.salt)).toHaveLength(16);
    expect(fromBase64(record.hash)).toHaveLength(32);
    expect(record.iterations).toBe(LOCK_ITERATIONS);
    expect(record.hint).toBe('hint');
  });

  it('accepts the right passphrase and rejects everything else', async () => {
    const record = await makeLockRecord(crypto, PASS);
    await expect(verifyPassword(crypto, PASS, record)).resolves.toBe(true);
    await expect(verifyPassword(crypto, `${PASS} `, record)).resolves.toBe(false);
    await expect(verifyPassword(crypto, PASS.toUpperCase(), record)).resolves.toBe(false);
    await expect(verifyPassword(crypto, '', record)).resolves.toBe(false);
  });

  it('rejects a tampered verifier', async () => {
    const record = await makeLockRecord(crypto, PASS);
    const hash = fromBase64(record.hash);
    hash[0] ^= 0xff;
    await expect(verifyPassword(crypto, PASS, { ...record, hash: toBase64(hash) })).resolves.toBe(false);
  });

  it('salts per record, so two identical passphrases hash differently', async () => {
    const a = await makeLockRecord(crypto, PASS);
    const b = await makeLockRecord(crypto, PASS);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('is deterministic for the same passphrase and salt', async () => {
    const salt = fromBase64((await makeLockRecord(crypto, PASS)).salt);
    const first = await hashPassword(crypto, PASS, salt, 1000);
    const second = await hashPassword(crypto, PASS, salt, 1000);
    expect(first).toBe(second);
  });

  it('keeps a short hint but truncates an over-long one', async () => {
    const record = await makeLockRecord(crypto, PASS, 'x'.repeat(200));
    expect(record.hint).toHaveLength(80);
    const blank = await makeLockRecord(crypto, PASS, '   ');
    expect(blank.hint).toBeUndefined();
  });

  it('documents its own minimums', () => {
    expect(MIN_LOCK_PASSWORD).toBeGreaterThan(0);
    expect(STRONG_LOCK_PASSWORD).toBeGreaterThan(MIN_LOCK_PASSWORD);
  });
});
