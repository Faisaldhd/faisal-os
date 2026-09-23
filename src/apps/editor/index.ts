import type { AppContext, AppModule } from '../../kernel/types';
import { HOME, VFSError } from '../../kernel/types';
import { basename, normalize } from '../../kernel/path';
import { defineStrings, t } from '../../kernel/i18n';
import { promptDialog } from './dialog';
import './editor.css';
import { ICON_EDITOR } from '../../brand/icons';

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
  },
});

function launch(ctx: AppContext): void {
  const { sys, window: win, args } = ctx;
  const vfs = sys.vfs;

  let currentPath: string | null = null;
  let dirty = false;
  let wrap = false;

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

  async function openFile(path: string) {
    try {
      const text = await vfs.readText(path);
      currentPath = normalize(path);
      textarea.value = text;
      setDirty(false);
      statusPath.textContent = currentPath;
      updateGutter();
      updateStatusLine();
      showStatus('');
    } catch (err) {
      showStatus(t('editor.errorGeneric', { message: errorMessage(err) }));
    }
  }

  async function newFile() {
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
      await vfs.writeFile(currentPath, textarea.value);
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
      await vfs.writeFile(dest, textarea.value);
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
  manifest: {
    id: 'org.faisal.TextEditor',
    name: { ar: 'محرر النصوص', en: 'Text Editor' },
    description: { ar: 'محرر نصوص بسيط', en: 'A simple text editor' },
    icon: ICON_EDITOR,
    permissions: ['fs:home'],
    opens: ['.txt', '.md', '.json', '.js', '.ts', '.css', '.html', '.sh', '.conf', '.log'],
  },
  launch,
};

export default app;
