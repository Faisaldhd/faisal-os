/**
 * Vault cryptography (Fai$al OS).
 *
 * Real encryption, not obfuscation: AES-GCM 256 with a key derived from the
 * passphrase by PBKDF2-SHA256. The on-disk document is a JSON envelope that holds
 * only public parameters (salt, IV, iteration count) plus the authenticated
 * ciphertext — never the passphrase and never the plaintext.
 *
 * Everything here is pure and dependency-injected (`CryptoLike` is a parameter), so
 * it runs unchanged in the browser, in tests, and in any other surface. No module
 * state, no storage access, no DOM.
 */

export interface CryptoLike {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

export interface VaultEnvelope {
  /** Envelope schema version. */
  v: number;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  /** base64 of the 16-byte salt. */
  salt: string;
  /** base64 of the 12-byte AES-GCM IV. */
  iv: string;
  /** base64 of the ciphertext (the GCM tag is appended by WebCrypto). */
  ct: string;
}

export type VaultErrorCode = 'bad-envelope' | 'unsupported' | 'wrong-passphrase';

export class VaultError extends Error {
  constructor(public code: VaultErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'VaultError';
  }
}

export const VAULT_ENVELOPE_VERSION = 1;
/** OWASP-scale PBKDF2 work factor; stored per envelope so old files keep opening. */
export const DEFAULT_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 8;
export const MIN_ITERATIONS = 1_000;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const KDF = 'PBKDF2-SHA256';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Decodes base64 into an `ArrayBuffer`-backed view, which is what WebCrypto's
 * `BufferSource` accepts (TS 5.7+ types `Uint8Array` by its backing buffer).
 */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Derives the AES-GCM key. The passphrase is never retained by this module. */
export async function deriveKey(
  crypto: CryptoLike,
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Validates an envelope read from disk or from an imported file. Throws VaultError. */
export function parseEnvelope(json: string): VaultEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new VaultError('bad-envelope', 'not JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new VaultError('bad-envelope', 'not an object');
  const e = raw as Partial<VaultEnvelope>;
  if (e.v !== VAULT_ENVELOPE_VERSION || e.kdf !== KDF) throw new VaultError('unsupported', 'unknown envelope version');
  if (typeof e.iterations !== 'number' || !Number.isFinite(e.iterations) || e.iterations < MIN_ITERATIONS) {
    throw new VaultError('bad-envelope', 'bad iteration count');
  }
  if (typeof e.salt !== 'string' || typeof e.iv !== 'string' || typeof e.ct !== 'string' || !e.salt || !e.iv || !e.ct) {
    throw new VaultError('bad-envelope', 'missing fields');
  }
  return { v: e.v, kdf: KDF, iterations: e.iterations, salt: e.salt, iv: e.iv, ct: e.ct };
}

/**
 * Encrypts with an already-derived key, reusing the envelope's salt and work factor
 * and drawing a fresh IV. Reusing the salt is safe (the key is unchanged); reusing an
 * IV under the same key is not, which is why every save draws a new one.
 */
export async function sealWithKey(
  crypto: CryptoLike,
  key: CryptoKey,
  plaintext: string,
  kdf: { salt: string; iterations: number },
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
  const envelope: VaultEnvelope = {
    v: VAULT_ENVELOPE_VERSION,
    kdf: KDF,
    iterations: kdf.iterations,
    salt: kdf.salt,
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ct)),
  };
  return JSON.stringify(envelope);
}

/** Creates a brand-new vault document for `passphrase`. */
export async function sealNewVault(
  crypto: CryptoLike,
  passphrase: string,
  plaintext: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<string> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new VaultError('unsupported', 'passphrase too short');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(crypto, passphrase, salt, iterations);
  return sealWithKey(crypto, key, plaintext, { salt: toBase64(salt), iterations });
}

export interface UnlockedVault {
  plaintext: string;
  /** Kept in memory only while unlocked; callers must drop it to lock. */
  key: CryptoKey;
  salt: string;
  iterations: number;
}

/** Opens an envelope. A wrong passphrase or a tampered file throws VaultError('wrong-passphrase'). */
export async function unlockVault(crypto: CryptoLike, passphrase: string, json: string): Promise<UnlockedVault> {
  const e = parseEnvelope(json);
  const key = await deriveKey(crypto, passphrase, fromBase64(e.salt), e.iterations);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(e.iv) }, key, fromBase64(e.ct));
  } catch {
    // GCM authentication failed: wrong passphrase or modified ciphertext.
    throw new VaultError('wrong-passphrase');
  }
  return { plaintext: decoder.decode(plain), key, salt: e.salt, iterations: e.iterations };
}

/** Convenience wrapper returning only the text. */
export async function openVault(crypto: CryptoLike, passphrase: string, json: string): Promise<string> {
  return (await unlockVault(crypto, passphrase, json)).plaintext;
}
