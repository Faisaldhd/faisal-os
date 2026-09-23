/**
 * Vault (الخزنة) — passphrase-encrypted notes stored as one envelope file in the VFS.
 *
 * What it protects: the file on disk holds only salt/IV/iterations plus authenticated
 * ciphertext, so nothing inside it is readable without the passphrase — not from the
 * Files app, not from the Terminal, not from a browser-storage dump.
 *
 * What it does not protect (stated in the UI as well): the rest of the file system, and
 * the plaintext while the vault is unlocked — the key lives in this window's memory until
 * it is locked or the window closes, and every app shares one JavaScript realm.
 */
import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { HOME } from '../../kernel/types';
import { join } from '../../kernel/path';
import { defineStrings, t } from '../../kernel/i18n';
import {
  DEFAULT_ITERATIONS,
  MIN_PASSPHRASE_LENGTH,
  VaultError,
  parseEnvelope,
  sealNewVault,
  sealWithKey,
  unlockVault,
  type CryptoLike,
} from './crypto';
import './vault.css';

defineStrings('vault', {
  ar: {
    title: 'الخزنة',
    setupIntro: 'أنشئ كلمة مرور رئيسية. المحتوى يُشفَّر بها (AES-GCM 256) ولا يمكن فتحه بدونها.',
    passphrase: 'كلمة المرور الرئيسية',
    confirm: 'تأكيد كلمة المرور',
    create: 'إنشاء الخزنة',
    lockedIntro: 'الخزنة مقفلة. أدخل كلمة المرور الرئيسية لفتحها.',
    unlock: 'فتح',
    content: 'المحتوى السري',
    save: 'حفظ',
    saved: 'تم الحفظ والتشفير',
    lock: 'قفل',
    locked: 'تم القفل وإزالة المفتاح من الذاكرة',
    export: 'تصدير',
    import: 'استيراد',
    imported: 'تم الاستيراد. أدخل كلمة مرور هذا الملف لفتحه.',
    unrecoverable: 'لا يمكن استرجاع كلمة المرور إن نسيتها — لا يوجد باب خلفي ولا استعادة.',
    notProtected: 'الخزنة تحمي ما بداخلها بعد القفل فقط. بقية ملفات النظام ليست محمية بها.',
    autoLock: 'تُقفل تلقائيًا بعد 10 دقائق من عدم الاستخدام، وعند إغلاق النافذة.',
    fileLabel: 'الملف المشفَّر',
    unsupported: 'هذا المتصفح لا يوفّر WebCrypto، فلا يمكن تشفير الخزنة.',
    errShort: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل',
    errMismatch: 'كلمتا المرور غير متطابقتين',
    errWrong: 'كلمة المرور غير صحيحة، أو الملف معدَّل',
    errBadFile: 'الملف ليس خزنة صالحة',
    errGeneric: 'حدث خطأ غير متوقع',
    replaceBroken: 'الملف الحالي تالف — إنشاء خزنة جديدة يستبدله',
  },
  en: {
    title: 'Vault',
    setupIntro: 'Create a master passphrase. The content is encrypted with it (AES-GCM 256) and cannot be opened without it.',
    passphrase: 'Master passphrase',
    confirm: 'Confirm passphrase',
    create: 'Create vault',
    lockedIntro: 'The vault is locked. Enter the master passphrase to open it.',
    unlock: 'Unlock',
    content: 'Secret content',
    save: 'Save',
    saved: 'Saved and encrypted',
    lock: 'Lock',
    locked: 'Locked — the key was dropped from memory',
    export: 'Export',
    import: 'Import',
    imported: 'Imported. Enter that file\'s passphrase to open it.',
    unrecoverable: 'A forgotten passphrase cannot be recovered — there is no back door.',
    notProtected: 'The vault protects only its own content once locked. The rest of the file system is not covered.',
    autoLock: 'Locks itself after 10 minutes idle, and when the window closes.',
    fileLabel: 'Encrypted file',
    unsupported: 'This browser has no WebCrypto, so the vault cannot encrypt.',
    errShort: 'The passphrase must be at least 8 characters',
    errMismatch: 'The two passphrases do not match',
    errWrong: 'Wrong passphrase, or the file was modified',
    errBadFile: 'That file is not a valid vault',
    errGeneric: 'Something went wrong',
    replaceBroken: 'The current file is unreadable — creating a new vault replaces it',
  },
});

const VAULT_PATH = join(HOME, 'Documents', 'faisal-os.vault');
const AUTO_LOCK_MS = 10 * 60 * 1000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export async function launch(ctx: AppContext): Promise<void> {
  const { sys, window: win } = ctx;
  const webCrypto = globalThis.crypto as CryptoLike | undefined;
  const root = el('div', 'faisal-vault');
  win.content.append(root);

  if (!webCrypto?.subtle) {
    root.append(el('h2', undefined, t('vault.title')), el('p', undefined, t('vault.unsupported')));
    return;
  }

  let mode: 'setup' | 'locked' | 'unlocked' | 'broken' = 'setup';
  let key: CryptoKey | null = null;
  let salt = '';
  let iterations = DEFAULT_ITERATIONS;
  let envelope = '';
  let idleTimer = 0;
  let urlTimer = 0;

  const status = el('div', 'faisal-vault-status');
  const setStatus = (message: string, isError = false) => {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  };

  const clearIdle = () => { if (idleTimer) { window.clearTimeout(idleTimer); idleTimer = 0; } };
  const lock = (message = t('vault.locked')) => {
    clearIdle();
    key = null;
    mode = 'locked';
    render();
    setStatus(message);
  };
  const armIdle = () => {
    clearIdle();
    idleTimer = window.setTimeout(() => lock(), AUTO_LOCK_MS);
  };

  function errorText(err: unknown): string {
    if (err instanceof VaultError) {
      if (err.code === 'wrong-passphrase') return t('vault.errWrong');
      if (err.code === 'bad-envelope' || err.code === 'unsupported') return t('vault.errBadFile');
    }
    return t('vault.errGeneric');
  }

  async function persist(text: string): Promise<void> {
    if (!key) return;
    envelope = await sealWithKey(webCrypto as CryptoLike, key, text, { salt, iterations });
    await sys.vfs.mkdir(join(HOME, 'Documents'), { recursive: true });
    await sys.vfs.writeFile(VAULT_PATH, envelope);
  }

  function passwordField(labelText: string): { wrap: HTMLElement; input: HTMLInputElement } {
    const wrap = el('div', 'faisal-vault-field');
    const label = el('label', undefined, labelText);
    const input = el('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    wrap.append(label, input);
    return { wrap, input };
  }

  const fileInput = el('input', 'faisal-vault-import');
  fileInput.type = 'file';
  fileInput.accept = '.vault,application/json';

  function renderSetup(broken: boolean): void {
    root.replaceChildren();
    const pass = passwordField(t('vault.passphrase'));
    const confirm = passwordField(t('vault.confirm'));
    const actions = el('div', 'faisal-vault-actions');
    const create = el('button', 'is-primary', t('vault.create'));
    actions.append(create);
    const importBtn = el('button', undefined, t('vault.import'));
    actions.append(importBtn);

    create.addEventListener('click', () => {
      void (async () => {
        try {
          const value = pass.input.value;
          if (value.length < MIN_PASSPHRASE_LENGTH) { setStatus(t('vault.errShort'), true); return; }
          if (value !== confirm.input.value) { setStatus(t('vault.errMismatch'), true); return; }
          const created = await sealNewVault(webCrypto as CryptoLike, value, '', DEFAULT_ITERATIONS);
          await sys.vfs.mkdir(join(HOME, 'Documents'), { recursive: true });
          await sys.vfs.writeFile(VAULT_PATH, created);
          // Unlocking right away proves the file we just wrote opens with this passphrase.
          const opened = await unlockVault(webCrypto as CryptoLike, value, created);
          envelope = created;
          key = opened.key;
          salt = opened.salt;
          iterations = opened.iterations;
          mode = 'unlocked';
          render();
          setStatus(t('vault.saved'));
          armIdle();
        } catch (err) {
          setStatus(errorText(err), true);
        }
      })();
    });

    importBtn.addEventListener('click', () => fileInput.click());

    root.append(el('h2', undefined, t('vault.title')));
    if (broken) root.append(el('p', undefined, t('vault.replaceBroken')));
    root.append(el('p', undefined, t('vault.setupIntro')), pass.wrap, confirm.wrap, actions, status);
    root.append(el('p', 'faisal-vault-note', t('vault.unrecoverable')));
    root.append(el('p', 'faisal-vault-note', t('vault.notProtected')));
    root.append(el('p', 'faisal-vault-path', VAULT_PATH), fileInput);
    pass.input.focus();
  }

  function renderLocked(): void {
    root.replaceChildren();
    const pass = passwordField(t('vault.passphrase'));
    const actions = el('div', 'faisal-vault-actions');
    const unlock = el('button', 'is-primary', t('vault.unlock'));
    actions.append(unlock);
    const importBtn = el('button', undefined, t('vault.import'));
    actions.append(importBtn);
    importBtn.addEventListener('click', () => fileInput.click());

    const submit = () => {
      void (async () => {
        try {
          const opened = await unlockVault(webCrypto as CryptoLike, pass.input.value, envelope);
          key = opened.key;
          salt = opened.salt;
          iterations = opened.iterations;
          mode = 'unlocked';
          render(opened.plaintext);
          armIdle();
        } catch (err) {
          setStatus(errorText(err), true);
        }
      })();
    };
    unlock.addEventListener('click', submit);
    pass.input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });

    root.append(el('h2', undefined, t('vault.title')), el('p', undefined, t('vault.lockedIntro')), pass.wrap, actions, status);
    root.append(el('p', 'faisal-vault-note', t('vault.notProtected')), el('p', 'faisal-vault-path', VAULT_PATH), fileInput);
    pass.input.focus();
  }

  function render(content = ''): void {
    if (mode === 'setup' || mode === 'broken') { renderSetup(mode === 'broken'); return; }
    if (mode === 'locked') { renderLocked(); return; }

    root.replaceChildren();
    const area = el('textarea');
    area.value = content;
    area.spellcheck = false;
    area.setAttribute('aria-label', t('vault.content'));
    area.addEventListener('input', armIdle);

    const actions = el('div', 'faisal-vault-actions');
    const save = el('button', 'is-primary', t('vault.save'));
    const lockBtn = el('button', undefined, t('vault.lock'));
    const exportBtn = el('button', undefined, t('vault.export'));
    const importBtn = el('button', undefined, t('vault.import'));
    actions.append(save, lockBtn, exportBtn, importBtn);

    save.addEventListener('click', () => {
      void (async () => {
        try {
          await persist(area.value);
          armIdle();
          setStatus(t('vault.saved'));
        } catch (err) {
          setStatus(errorText(err), true);
        }
      })();
    });
    lockBtn.addEventListener('click', () => lock());
    exportBtn.addEventListener('click', () => {
      const blob = new Blob([envelope], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a');
      a.href = url;
      a.download = 'faisal-os.vault';
      a.click();
      urlTimer = window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
    importBtn.addEventListener('click', () => fileInput.click());
    area.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save.click(); }
    });

    root.append(el('h2', undefined, t('vault.title')), area, actions, status);
    root.append(el('p', 'faisal-vault-note', t('vault.autoLock')));
    root.append(el('p', 'faisal-vault-note', t('vault.notProtected')), el('p', 'faisal-vault-path', VAULT_PATH), fileInput);
    area.focus();
  }

  fileInput.addEventListener('change', () => {
    void (async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        parseEnvelope(text); // reject anything that is not a vault before touching the stored file
        await sys.vfs.mkdir(join(HOME, 'Documents'), { recursive: true });
        await sys.vfs.writeFile(VAULT_PATH, text);
        envelope = text;
        lock(t('vault.imported'));
      } catch (err) {
        setStatus(errorText(err), true);
      } finally {
        fileInput.value = '';
      }
    })();
  });

  root.append(fileInput);

  // Boot: read whatever is stored and pick the opening state.
  try {
    if (await sys.vfs.exists(VAULT_PATH)) {
      const stored = await sys.vfs.readText(VAULT_PATH);
      try {
        parseEnvelope(stored);
        envelope = stored;
        mode = 'locked';
      } catch {
        mode = 'broken';
      }
    }
  } catch {
    mode = 'setup'; // unreadable path: start fresh rather than refusing to open
  }
  render();

  win.onClose(() => {
    clearIdle();
    if (urlTimer) window.clearTimeout(urlTimer);
    key = null; // drop the only reference to the derived key
  });
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
