import { manifest } from './manifest';
import type { AppContext, AppModule, SystemEvents } from '../../kernel/types';
import { HOME, VFSError } from '../../kernel/types';
import { basename, normalize } from '../../kernel/path';
import { defineStrings, t } from '../../kernel/i18n';
import { shellConfirm } from '../../shell/dialog';
import { promptDialog } from './dialog';
import './editor.css';

defineStrings('editor', {
  ar: {
    title: 'محرر النصوص',
    untitled: 'بدون عنوان',
    new: 'جديد',
    save: 'حفظ',
    saveAs: 'حفظ باسم',
    wrap: 'التفاف السطر',
    find: 'بحث',
    findPlaceholder: 'ابحث في النص…',
    next: 'التالي',
    prev: 'السابق',
    close: 'إغلاق',
    saveAsTitle: 'حفظ باسم',
    saveAsPrompt: 'المسار (تحت /home/user)',
    saveAsInvalid: 'يجب أن يكون المسار داخل /home/user',
    saveAsEmpty: 'المسار لا يمكن أن يكون فارغاً',
    matchCount: '{current}/{total}',
    noMatches: 'لا نتائج',
    errorGeneric: 'حدث خطأ: {message}',
    ln: 'سطر {line}',
    savedStatus: 'تم الحفظ',
    discardTitle: 'تجاهل التغييرات غير المحفوظة؟',
    discardBody: 'في «{name}» تغييرات لم تُحفظ، وستضيع إذا تابعت.',
    discard: 'تجاهل التغييرات',
    keep: 'متابعة التحرير',
    externalReloaded: 'تم تحديث «{name}» من القرص',
    externalChanged: 'تغيّر «{name}» على القرص ولديك تغييرات غير محفوظة؛ لم يُحدَّث المحرر.',
    externalDeleted: 'حُذف «{name}» من القرص',
  },
  en: {
    title: 'Text Editor',
    untitled: 'Untitled',
    new: 'New',
    save: 'Save',
    saveAs: 'Save As',
    wrap: 'Wrap',
    find: 'Find',
    findPlaceholder: 'Find in text…',
    next: 'Next',
    prev: 'Prev',
    close: 'Close',
    saveAsTitle: 'Save As',
    saveAsPrompt: 'Path (under /home/user)',
    saveAsInvalid: 'Path must be inside /home/user',
    saveAsEmpty: 'Path cannot be empty',
    matchCount: '{current}/{total}',
    noMatches: 'No matches',
    errorGeneric: 'Error: {message}',
    ln: 'Line {line}',
    savedStatus: 'Saved',
    discardTitle: 'Discard unsaved changes?',
    discardBody: '“{name}” has changes that haven’t been saved. They will be lost if you continue.',
    discard: 'Discard changes',
    keep: 'Keep editing',
    externalReloaded: 'Reloaded “{name}” from disk',
    externalChanged: '“{name}” changed on disk and you have unsaved changes; the editor was not updated.',
    externalDeleted: '“{name}” was deleted on disk',
  },
});

function launch(ctx: AppContext): void {
  const { sys, window: win, args } = ctx;
  const vfs = sys.vfs;

  let currentPath: string | null = null;
  let dirty = false;
  let wrap = false;
  /** Path this editor is writing right now, so the echo of its own write is ignored. */
  let selfWrite: string | null = null;
  /** mtime of the bytes the buffer was last synced with (read or written by us). */
  let syncedMtime = 0;
  let unsubFs: (() => void) | null = null;
  let unsubActivate: (() => void) | null = null;

  const root = document.createElement('div');
  root.className = 'faisal-editor';

  const toolbar = document.createElement('div');
  toolbar.className = 'faisal-editor-toolbar';

  const findBar = document.createElement('div');
  findBar.className = 'faisal-editor-findbar';

  const body = document.createElement('div');
  body.className = 'faisal-editor-body';

  const gutter = document.createElement('div');
  gutter.className = 'faisal-editor-gutter';

  const textarea = document.createElement('textarea');
  textarea.className = 'faisal-editor-textarea';
  textarea.spellcheck = false;
  textarea.dir = 'auto';
  textarea.setAttribute('autocomplete', 'off');
  textarea.setAttribute('autocapitalize', 'off');

  body.append(gutter, textarea);

  const statusbar = document.createElement('div');
  statusbar.className = 'faisal-editor-statusbar';
  const statusPath = document.createElement('span');
  const statusLine = document.createElement('span');
  const statusMsg = document.createElement('span');
  statusbar.append(statusPath, statusLine, statusMsg);

  root.append(toolbar, findBar, body, statusbar);
  win.content.append(root);

  function makeBtn(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'faisal-editor-btn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  const newBtn = makeBtn(t('editor.new'), () => void newFile());
  const saveBtn = makeBtn(t('editor.save'), () => void save());
  const saveAsBtn = makeBtn(t('editor.saveAs'), () => void saveAs());
  const spacer = document.createElement('div');
  spacer.className = 'faisal-editor-spacer';
  const wrapBtn = makeBtn(t('editor.wrap'), () => toggleWrap());
  const findBtn = makeBtn(t('editor.find'), () => toggleFind());

  toolbar.append(newBtn, saveBtn, saveAsBtn, spacer, wrapBtn, findBtn);

  const findInput = document.createElement('input');
  findInput.type = 'text';
  findInput.dir = 'auto';
  findInput.placeholder = t('editor.findPlaceholder');
  const findPrev = makeBtn(t('editor.prev'), () => findStep(-1));
  const findNext = makeBtn(t('editor.next'), () => findStep(1));
  const findCount = document.createElement('span');
  findCount.className = 'faisal-editor-find-count';
  const findClose = makeBtn(t('editor.close'), () => toggleFind(false));
  findBar.append(findInput, findPrev, findNext, findCount, findClose);

  function fileTitle(): string {
    const name = currentPath ? basename(currentPath) : t('editor.untitled');
    return (dirty ? '● ' : '') + name;
  }

  function updateTitle() {
    win.setTitle(fileTitle());
  }

  function setDirty(v: boolean) {
    dirty = v;
    updateTitle();
  }

  function updateGutter() {
    const lines = textarea.value.split('\n').length;
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= lines; i++) {
      const d = document.createElement('div');
      d.textContent = String(i);
      frag.appendChild(d);
    }
    gutter.replaceChildren(frag);
    gutter.scrollTop = textarea.scrollTop;
  }

  function updateStatusLine() {
    const upTo = textarea.value.slice(0, textarea.selectionStart);
    const line = upTo.split('\n').length;
    statusLine.textContent = t('editor.ln', { line });
  }

  textarea.addEventListener('input', () => {
    setDirty(true);
    updateGutter();
    updateStatusLine();
  });
  textarea.addEventListener('scroll', () => { gutter.scrollTop = textarea.scrollTop; });
  textarea.addEventListener('click', updateStatusLine);
  textarea.addEventListener('keyup', updateStatusLine);

  function showStatus(msg: string) {
    statusMsg.textContent = msg;
  }

  function errorMessage(err: unknown): string {
    if (err instanceof VFSError) return `${err.code}: ${err.path}`;
    return err instanceof Error ? err.message : String(err);
  }

  /** mtime of a path, or 0 when it cannot be read (missing / not permitted). */
  async function readMtime(path: string): Promise<number> {
    try { return (await vfs.stat(path)).mtime; } catch { return 0; }
  }

  /** Writes the buffer, flagging the write as our own so its fs:change echo is ignored. */
  async function writeBuffer(path: string, text: string): Promise<void> {
    selfWrite = path;
    try {
      await vfs.writeFile(path, text);
    } finally {
      selfWrite = null;
    }
    syncedMtime = await readMtime(path);
  }

  /** Re-reads the file into the buffer, keeping the caret inside the new text. */
  async function reloadFromDisk(path: string, mtime: number): Promise<void> {
    try {
      const text = await vfs.readText(path);
      const caret = textarea.selectionStart;
      const focused = document.activeElement === textarea;
      syncedMtime = mtime;
      textarea.value = text;
      if (focused) {
        const at = Math.min(caret, text.length);
        textarea.setSelectionRange(at, at);
      }
      setDirty(false);
      updateGutter();
      updateStatusLine();
      showStatus(t('editor.externalReloaded', { name: basename(path) }));
    } catch (err) {
      showStatus(t('editor.errorGeneric', { message: errorMessage(err) }));
    }
  }

  /**
   * Someone else touched the open file. Our own writes are ignored (selfWrite / mtime);
   * unsaved edits are never overwritten — the user only gets a notice.
   */
  async function onExternalChange(ev: SystemEvents['fs:change']): Promise<void> {
    if (!currentPath || ev.path !== currentPath || selfWrite === currentPath) return;
    const name = basename(currentPath);
    if (ev.kind === 'delete') {
      syncedMtime = 0;
      showStatus(t('editor.externalDeleted', { name }));
      return;
    }
    const mtime = await readMtime(ev.path);
    if (!mtime) {
      syncedMtime = 0;
      showStatus(t('editor.externalDeleted', { name }));
      return;
    }
    if (syncedMtime && mtime === syncedMtime) return; // already in sync with the disk
    if (dirty) {
      showStatus(t('editor.externalChanged', { name }));
      return;
    }
    await reloadFromDisk(ev.path, mtime);
  }

  async function openFile(path: string) {
    try {
      const loaded = normalize(path);
      const text = await vfs.readText(loaded);
      currentPath = loaded;
      textarea.value = text;
      setDirty(false);
      statusPath.textContent = currentPath;
      updateGutter();
      updateStatusLine();
      showStatus('');
      syncedMtime = await readMtime(loaded);
    } catch (err) {
      showStatus(t('editor.errorGeneric', { message: errorMessage(err) }));
    }
  }

  /** True when there is nothing to lose, or the user agreed to drop the changes. */
  async function confirmDiscard(): Promise<boolean> {
    if (!dirty) return true;
    return shellConfirm({
      title: t('editor.discardTitle'),
      message: t('editor.discardBody', { name: currentPath ? basename(currentPath) : t('editor.untitled') }),
      okLabel: t('editor.discard'),
      cancelLabel: t('editor.keep'),
      danger: true,
    });
  }
  win.setCloseGuard(confirmDiscard);
  // Leaving the page with unsaved text asks the browser to warn as well.
  const onBeforeUnload = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
  window.addEventListener('beforeunload', onBeforeUnload);
  win.onClose(() => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    unsubFs?.();
    unsubActivate?.();
  });

  // The file may change underneath us (terminal, files app, another process).
  unsubFs = sys.bus.on('fs:change', (ev) => { void onExternalChange(ev); });

  /**
   * The editor is single-instance: opening another file from Files reaches this window
   * (see 'app:activate'). Unsaved work still wins — the user is asked first.
   */
  async function onActivate(path: string): Promise<void> {
    const target = normalize(path);
    if (target === currentPath) return;
    if (!(await confirmDiscard())) return;
    await openFile(target);
    textarea.focus();
  }
  unsubActivate = sys.bus.on('app:activate', (ev) => {
    if (ev.windowId !== win.id) return;
    const path = ev.args[0];
    if (path) void onActivate(path);
  });

  async function newFile() {
    if (!(await confirmDiscard())) return;
    currentPath = null;
    textarea.value = '';
    setDirty(false);
    statusPath.textContent = t('editor.untitled');
    updateGutter();
    updateStatusLine();
    showStatus('');
    textarea.focus();
  }

  async function save() {
    if (!currentPath) {
      await saveAs();
      return;
    }
    try {
      await writeBuffer(currentPath, textarea.value);
      setDirty(false);
      showStatus(t('editor.savedStatus'));
    } catch (err) {
      showStatus(t('editor.errorGeneric', { message: errorMessage(err) }));
    }
  }

  async function saveAs() {
    const initial = currentPath ?? `${HOME}/untitled.txt`;
    const path = await promptDialog(win.content, {
      title: t('editor.saveAsTitle'),
      message: t('editor.saveAsPrompt'),
      initialValue: initial,
      okLabel: t('editor.save'),
      cancelLabel: t('editor.close'),
      validate: (v) => {
        if (!v) return t('editor.saveAsEmpty');
        const n = normalize(v);
        if (n !== HOME && !n.startsWith(HOME + '/')) return t('editor.saveAsInvalid');
        return null;
      },
    });
    if (!path) return;
    const dest = normalize(path);
    try {
      await writeBuffer(dest, textarea.value);
      currentPath = dest;
      statusPath.textContent = currentPath;
      setDirty(false);
      showStatus(t('editor.savedStatus'));
    } catch (err) {
      showStatus(t('editor.errorGeneric', { message: errorMessage(err) }));
    }
  }

  function toggleWrap(force?: boolean) {
    wrap = force ?? !wrap;
    textarea.classList.toggle('is-wrap', wrap);
    wrapBtn.classList.toggle('is-active', wrap);
  }

  // ---- find ----
  let matches: number[] = [];
  let matchIndex = -1;

  function toggleFind(force?: boolean) {
    const open = force ?? !findBar.classList.contains('is-open');
    findBar.classList.toggle('is-open', open);
    if (open) {
      findInput.focus();
      findInput.select();
      computeMatches();
    }
  }

  function computeMatches() {
    matches = [];
    matchIndex = -1;
    const needle = findInput.value;
    if (needle) {
      const hay = textarea.value;
      let i = 0;
      while (true) {
        const idx = hay.indexOf(needle, i);
        if (idx === -1) break;
        matches.push(idx);
        i = idx + needle.length;
      }
    }
    findCount.textContent = matches.length > 0
      ? t('editor.matchCount', { current: 1, total: matches.length })
      : (needle ? t('editor.noMatches') : '');
    if (matches.length > 0) selectMatch(0);
  }

  function selectMatch(i: number) {
    matchIndex = i;
    const start = matches[i];
    const needle = findInput.value;
    textarea.focus();
    textarea.setSelectionRange(start, start + needle.length);
    findCount.textContent = t('editor.matchCount', { current: i + 1, total: matches.length });
    // scroll selection into view roughly
    const before = textarea.value.slice(0, start);
    const line = before.split('\n').length;
    const lineHeight = 19.5;
    textarea.scrollTop = Math.max(0, (line - 3) * lineHeight);
    gutter.scrollTop = textarea.scrollTop;
  }

  function findStep(dir: 1 | -1) {
    if (matches.length === 0) { computeMatches(); return; }
    const next = (matchIndex + dir + matches.length) % matches.length;
    selectMatch(next);
  }

  findInput.addEventListener('input', computeMatches);
  findInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); toggleFind(false); textarea.focus(); }
  });

  root.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
    else if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); toggleFind(true); }
  });

  updateTitle();
  toggleWrap(false);
  updateGutter();
  updateStatusLine();

  if (args[0]) {
    void openFile(args[0]);
  } else {
    void newFile();
  }
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
