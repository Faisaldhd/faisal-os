/**
 * Session lock (شاشة القفل) — an optional passphrase curtain with a password the user picks.
 *
 * Honest scope, stated in the UI as well: this is a curtain inside a web page, not disk
 * encryption. The stored record is a PBKDF2-SHA256 verifier — never the passphrase — and the
 * desktop is not reachable while the curtain is up (`inert` on the shell root), but anyone who
 * owns the browser profile or opens DevTools can read the OS data and delete the record.
 * Real protection is the operating system's own login plus a separate browser profile.
 *
 * The record lives under its own localStorage key rather than the kernel settings store, so an
 * app holding the `settings` permission cannot silently remove the lock.
 */
import { t } from '../kernel/i18n';
import { renderIcon } from './icon';
import { MARK_GLYPH_GOLD_SVG } from '../brand/logo';

/** The vault app has its own copy; the shell must not import from an app track. */
export interface CryptoLike {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

export interface LockRecord {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  /** base64 salt (16 bytes). */
  salt: string;
  /** base64 PBKDF2 output (32 bytes) — a verifier, not the key. */
  hash: string;
  hint?: string;
}

const STORAGE_KEY = 'faisal.lock.record';
/**
 * Smaller than the vault's work factor on purpose: this verifier runs on every boot, and it is
 * not what stands between an attacker and the data (see the module note).
 */
export const LOCK_ITERATIONS = 250_000;
export const MIN_LOCK_PASSWORD = 4;
export const STRONG_LOCK_PASSWORD = 8;
const SALT_BYTES = 16;
const KDF = 'PBKDF2-SHA256';

const encoder = new TextEncoder();

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Validates a stored record. Anything unexpected means "no lock", never a crash at boot. */
export function parseLockRecord(raw: unknown): LockRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Partial<LockRecord>;
  if (r.v !== 1 || r.kdf !== KDF) return null;
  if (typeof r.iterations !== 'number' || !Number.isFinite(r.iterations) || r.iterations < 1_000) return null;
  if (typeof r.salt !== 'string' || !r.salt || typeof r.hash !== 'string' || !r.hash) return null;
  if (r.hint !== undefined && typeof r.hint !== 'string') return null;
  return { v: 1, kdf: KDF, iterations: r.iterations, salt: r.salt, hash: r.hash, hint: r.hint };
}

export function readLockRecord(): LockRecord | null {
  try {
    return parseLockRecord(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

function writeLockRecord(record: LockRecord | null): void {
  try {
    if (record) localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* private mode: the lock simply will not persist */ }
}

/** PBKDF2-SHA256 over the passphrase. */
export async function hashPassword(
  crypto: CryptoLike,
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<string> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, 256);
  return toBase64(new Uint8Array(bits));
}

export async function makeLockRecord(crypto: CryptoLike, passphrase: string, hint?: string): Promise<LockRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await hashPassword(crypto, passphrase, salt, LOCK_ITERATIONS);
  const record: LockRecord = { v: 1, kdf: KDF, iterations: LOCK_ITERATIONS, salt: toBase64(salt), hash };
  const trimmed = hint?.trim();
  if (trimmed) record.hint = trimmed.slice(0, 80);
  return record;
}

export async function verifyPassword(crypto: CryptoLike, passphrase: string, record: LockRecord): Promise<boolean> {
  const candidate = await hashPassword(crypto, passphrase, fromBase64(record.salt), record.iterations);
  // Length-constant comparison of two base64 strings of equal size.
  if (candidate.length !== record.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i += 1) diff |= candidate.charCodeAt(i) ^ record.hash.charCodeAt(i);
  return diff === 0;
}

export interface LockController {
  isEnabled(): boolean;
  isLocked(): boolean;
  /** Shows the curtain. Does nothing when no password is set. */
  lock(): void;
  /** Password setup screen (first time, or after verifying in manage mode). */
  openSetup(): void;
  /** Asks for the current password, then offers change/remove. */
  openManage(): void;
}

type Mode = 'locked' | 'setup' | 'manage';

export function mountLock(): LockController {
  const crypto = globalThis.crypto as CryptoLike | undefined;
  let overlay: HTMLElement | null = null;
  let mode: Mode = 'locked';
  let record: LockRecord | null = readLockRecord();
  let pending: LockRecord | null = null; // change-of-password draft

  function shellRoot(): HTMLElement | null {
    return document.getElementById('faisal-root');
  }

  function setBackgroundInert(on: boolean): void {
    const root = shellRoot();
    if (!root) return;
    if (on) root.setAttribute('inert', '');
    else root.removeAttribute('inert');
  }

  function close(): void {
    overlay?.remove();
    overlay = null;
    setBackgroundInert(false);
    document.removeEventListener('keydown', onKeydown, true);
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') ev.preventDefault(); // the curtain is not dismissable
    if (ev.key !== 'Tab' || !overlay) return;
    const focusables = [...overlay.querySelectorAll<HTMLElement>('button, input')].filter((n) => !n.hasAttribute('disabled'));
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (ev.shiftKey && (active === first || !overlay.contains(active))) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
  }

  function field(label: string, type = 'password'): { wrap: HTMLElement; input: HTMLInputElement } {
    const wrap = document.createElement('label');
    wrap.className = 'faisal-lock-field';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = type;
    input.autocomplete = 'off';
    input.spellcheck = false;
    wrap.append(span, input);
    return { wrap, input };
  }

  function button(label: string, primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'faisal-lock-btn' + (primary ? ' is-primary' : '');
    b.textContent = label;
    return b;
  }

  function frame(title: string, subtitle: string): { card: HTMLElement; body: HTMLElement; status: HTMLElement } {
    overlay = document.createElement('div');
    overlay.className = 'faisal-lock';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    const card = document.createElement('div');
    card.className = 'faisal-lock-card';
    const mark = document.createElement('div');
    mark.className = 'faisal-lock-mark';
    mark.append(renderIcon(MARK_GLYPH_GOLD_SVG));
    const h = document.createElement('h2');
    h.textContent = title;
    const p = document.createElement('p');
    p.className = 'faisal-lock-sub';
    p.textContent = subtitle;
    const body = document.createElement('div');
    body.className = 'faisal-lock-body';
    const status = document.createElement('div');
    status.className = 'faisal-lock-status';
    const scope = document.createElement('p');
    scope.className = 'faisal-lock-scope';
    scope.textContent = t('shell.lock.scope');
    card.append(mark, h, p, body, status, scope);
    overlay.append(card);
    document.body.append(overlay);
    setBackgroundInert(true);
    document.addEventListener('keydown', onKeydown, true);
    return { card, body, status };
  }

  function fail(status: HTMLElement, message: string): void {
    status.textContent = message;
    status.classList.add('is-error');
    const card = overlay?.querySelector('.faisal-lock-card');
    card?.classList.add('is-shake');
    window.setTimeout(() => card?.classList.remove('is-shake'), 400);
  }

  function renderLocked(): void {
    mode = 'locked';
    const { body, status } = frame(t('shell.lock.title'), t('shell.lock.subtitle'));
    const pass = field(t('shell.lock.password'));
    const actions = document.createElement('div');
    actions.className = 'faisal-lock-actions';
    const submit = button(t('shell.lock.unlock'), true);
    actions.append(submit);
    body.append(pass.wrap, actions, status);
    if (record?.hint) {
      const hint = document.createElement('p');
      hint.className = 'faisal-lock-hint';
      hint.textContent = `${t('shell.lock.hintShown')}: ${record.hint}`;
      body.append(hint);
    }
    const forgot = document.createElement('p');
    forgot.className = 'faisal-lock-scope';
    forgot.textContent = t('shell.lock.forgot');
    body.append(forgot);

    const attempt = () => {
      void (async () => {
        if (!crypto?.subtle || !record) return;
        const ok = await verifyPassword(crypto, pass.input.value, record);
        if (!ok) { fail(status, t('shell.lock.errWrong')); pass.input.select(); return; }
        close();
      })();
    };
    submit.addEventListener('click', attempt);
    pass.input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') attempt(); });
    pass.input.focus();
  }

  function renderSetup(title: string, onDone: (next: LockRecord) => void, allowRemove: boolean): void {
    mode = 'setup';
    const { body, status } = frame(title, t('shell.lock.setSubtitle'));
    const pass = field(t('shell.lock.password'));
    const confirm = field(t('shell.lock.confirm'));
    const hint = field(t('shell.lock.hint'), 'text');
    const actions = document.createElement('div');
    actions.className = 'faisal-lock-actions';
    const save = button(t('shell.lock.save'), true);
    actions.append(save);
    let remove: HTMLButtonElement | null = null;
    if (allowRemove) {
      remove = button(t('shell.lock.remove'));
      remove.classList.add('is-danger');
      actions.append(remove);
    }
    body.append(pass.wrap, confirm.wrap, hint.wrap, actions, status);

    save.addEventListener('click', () => {
      void (async () => {
        if (!crypto?.subtle) { fail(status, t('shell.lock.errUnsupported')); return; }
        const value = pass.input.value;
        if (value.length < MIN_LOCK_PASSWORD) { fail(status, t('shell.lock.errShort')); return; }
        if (value !== confirm.input.value) { fail(status, t('shell.lock.errMismatch')); return; }
        const next = await makeLockRecord(crypto, value, hint.input.value);
        writeLockRecord(next);
        record = next;
        onDone(next);
        if (value.length < STRONG_LOCK_PASSWORD) {
          status.classList.remove('is-error');
          status.textContent = t('shell.lock.warnWeak');
        }
        close();
      })();
    });
    remove?.addEventListener('click', () => {
      writeLockRecord(null);
      record = null;
      close();
    });
    pass.input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') confirm.input.focus(); });
    confirm.input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save.click(); });
    pass.input.focus();
  }

  function renderManage(): void {
    mode = 'manage';
    const { body, status } = frame(t('shell.lock.manageTitle'), t('shell.lock.manageSubtitle'));
    const pass = field(t('shell.lock.current'));
    const actions = document.createElement('div');
    actions.className = 'faisal-lock-actions';
    const next = button(t('shell.lock.continue'), true);
    actions.append(next);
    body.append(pass.wrap, actions, status);
    const attempt = () => {
      void (async () => {
        if (!crypto?.subtle || !record) { fail(status, t('shell.lock.errUnsupported')); return; }
        const ok = await verifyPassword(crypto, pass.input.value, record);
        if (!ok) { fail(status, t('shell.lock.errWrong')); pass.input.select(); return; }
        overlay?.remove();
        overlay = null;
        document.removeEventListener('keydown', onKeydown, true);
        renderSetup(t('shell.lock.changeTitle'), () => { /* record already stored */ }, true);
      })();
    };
    next.addEventListener('click', attempt);
    pass.input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') attempt(); });
    pass.input.focus();
  }

  return {
    isEnabled: () => record !== null,
    isLocked: () => overlay !== null && mode === 'locked',
    lock: () => { if (readLockRecord()) { record = readLockRecord(); if (!overlay) renderLocked(); } },
    openSetup: () => { if (!overlay) renderSetup(t('shell.lock.setTitle'), () => { /* stored already */ }, record !== null); },
    openManage: () => {
      if (!readLockRecord()) { renderSetup(t('shell.lock.setTitle'), () => { /* stored already */ }, false); return; }
      record = readLockRecord();
      renderManage();
    },
  };
}
