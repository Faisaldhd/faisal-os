import { manifest } from './manifest';
import type { AppContext, AppModule, Stat } from '../../kernel/types';
import { HOME, VFSError } from '../../kernel/types';
import { basename, dirname, join, normalize } from '../../kernel/path';
import { defineStrings, t } from '../../kernel/i18n';
import { formatBytes, formatDate } from './format';
import { copyRecursive, sameOrDescendant, targetPathFor, uniqueName } from './copy';
import { confirmDialog, promptDialog } from './dialog';
import { ICONS, icon } from './icons';
import './files.css';

defineStrings('files', {
  ar: {
    title: 'الملفات',
    home: 'المنزل',
    documents: 'المستندات',
    downloads: 'التنزيلات',
    pictures: 'الصور',
    music: 'الموسيقى',
    desktop: 'سطح المكتب',
    back: 'رجوع',
    forward: 'تقدم',
    up: 'للأعلى',
    gridView: 'شبكة',
    listView: 'قائمة',
    newFolder: 'مجلد جديد',
    upload: 'رفع',
    download: 'تنزيل',
    rename: 'إعادة تسمية',
    delete: 'حذف',
    copy: 'نسخ',
    cut: 'قص',
    paste: 'لصق',
    open: 'فتح',
    name: 'الاسم',
    size: 'الحجم',
    modified: 'آخر تعديل',
    empty: 'هذا المجلد فارغ',
    newFolderTitle: 'مجلد جديد',
    newFolderPrompt: 'اسم المجلد الجديد',
    renameTitle: 'إعادة تسمية',
    renamePrompt: 'الاسم الجديد',
    deleteTitle: 'تأكيد الحذف',
    deleteOne: 'هل تريد حذف "{name}"؟ لا يمكن التراجع عن هذا الإجراء.',
    deleteMany: 'هل تريد حذف {count} عناصر؟ لا يمكن التراجع عن هذا الإجراء.',
    ok: 'موافق',
    cancel: 'إلغاء',
    itemsSelected: '{count} محدد',
    itemsCount: '{count} عنصر',
    nameEmpty: 'الاسم لا يمكن أن يكون فارغاً',
    nameInvalid: 'اسم غير صالح',
    nameExists: 'هذا الاسم موجود بالفعل',
    errorGeneric: 'حدث خطأ: {message}',
    copyOf: 'نسخة',
  },
  en: {
    title: 'Files',
    home: 'Home',
    documents: 'Documents',
    downloads: 'Downloads',
    pictures: 'Pictures',
    music: 'Music',
    desktop: 'Desktop',
    back: 'Back',
    forward: 'Forward',
    up: 'Up',
    gridView: 'Grid',
    listView: 'List',
    newFolder: 'New Folder',
    upload: 'Upload',
    download: 'Download',
    rename: 'Rename',
    delete: 'Delete',
    copy: 'Copy',
    cut: 'Cut',
    paste: 'Paste',
    open: 'Open',
    name: 'Name',
    size: 'Size',
    modified: 'Modified',
    empty: 'This folder is empty',
    newFolderTitle: 'New Folder',
    newFolderPrompt: 'New folder name',
    renameTitle: 'Rename',
    renamePrompt: 'New name',
    deleteTitle: 'Confirm delete',
    deleteOne: 'Delete "{name}"? This cannot be undone.',
    deleteMany: 'Delete {count} items? This cannot be undone.',
    ok: 'OK',
    cancel: 'Cancel',
    itemsSelected: '{count} selected',
    itemsCount: '{count} items',
    nameEmpty: 'Name cannot be empty',
    nameInvalid: 'Invalid name',
    nameExists: 'That name already exists',
    errorGeneric: 'Error: {message}',
    copyOf: 'copy',
  },
});

type ViewMode = 'grid' | 'list';
type SortKey = 'name' | 'date' | 'size';

interface SidebarEntry {
  key: string;
  label: string;
  path: string;
  svg: string;
}

function invalidName(name: string): boolean {
  return !name || name === '.' || name === '..' || name.includes('/');
}

function errorMessage(err: unknown): string {
  if (err instanceof VFSError) return `${err.code}: ${err.path}`;
  return err instanceof Error ? err.message : String(err);
}

function launch(ctx: AppContext): void {
  const { sys, window: win, args } = ctx;
  const vfs = sys.vfs;

  const sidebar: SidebarEntry[] = [
    { key: 'home', label: t('files.home'), path: HOME, svg: ICONS.home },
    { key: 'documents', label: t('files.documents'), path: join(HOME, 'Documents'), svg: ICONS.documents },
    { key: 'downloads', label: t('files.downloads'), path: join(HOME, 'Downloads'), svg: ICONS.downloads },
    { key: 'pictures', label: t('files.pictures'), path: join(HOME, 'Pictures'), svg: ICONS.pictures },
    { key: 'music', label: t('files.music'), path: join(HOME, 'Music'), svg: ICONS.music },
    { key: 'desktop', label: t('files.desktop'), path: join(HOME, 'Desktop'), svg: ICONS.desktop },
  ];

  const startDir = args[0] ? normalize(args[0]) : HOME;

  let currentPath = startDir;
  const history: string[] = [currentPath];
  let historyIndex = 0;
  let viewMode: ViewMode = 'grid';
  let sortKey: SortKey = 'name';
  let sortAsc = true;
  let selection = new Set<string>();
  let clipboard: { mode: 'copy' | 'cut'; paths: string[] } | null = null;
  let entries: Stat[] = [];
  let focusIndex = -1;

  win.setTitle(t('files.title'));

  const root = document.createElement('div');
  root.className = 'faisal-files';

  const sidebarEl = document.createElement('nav');
  sidebarEl.className = 'faisal-files-sidebar';

  const mainEl = document.createElement('div');
  mainEl.className = 'faisal-files-main';

  const toolbar = document.createElement('div');
  toolbar.className = 'faisal-files-toolbar';

  const crumbs = document.createElement('div');
  crumbs.className = 'faisal-files-breadcrumbs';

  const viewEl = document.createElement('div');
  viewEl.className = 'faisal-files-view';
  viewEl.tabIndex = 0;

  const statusEl = document.createElement('div');
  statusEl.className = 'faisal-files-status';

  mainEl.append(toolbar, crumbs, viewEl, statusEl);
  root.append(sidebarEl, mainEl);
  win.content.append(root);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  root.appendChild(fileInput);

  // ---- toolbar buttons ----
  function makeBtn(svg: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'faisal-files-btn';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(icon(svg));
    b.addEventListener('click', onClick);
    return b;
  }

  const backBtn = makeBtn(ICONS.back, t('files.back'), () => goBack());
  const forwardBtn = makeBtn(ICONS.forward, t('files.forward'), () => goForward());
  const upBtn = makeBtn(ICONS.up, t('files.up'), () => goUp());
  const spacer = document.createElement('div');
  spacer.className = 'faisal-files-spacer';
  const gridBtn = makeBtn(ICONS.grid, t('files.gridView'), () => setView('grid'));
  const listBtn = makeBtn(ICONS.list, t('files.listView'), () => setView('list'));
  const newFolderBtn = makeBtn(ICONS.newFolder, t('files.newFolder'), () => createFolder());
  const uploadBtn = makeBtn(ICONS.upload, t('files.upload'), () => fileInput.click());

  toolbar.append(backBtn, forwardBtn, upBtn, spacer, gridBtn, listBtn, newFolderBtn, uploadBtn);

  sidebar.forEach((s) => {
    const b = document.createElement('button');
    b.className = 'faisal-files-sidebar-item';
    b.dataset.path = s.path;
    b.appendChild(icon(s.svg));
    const span = document.createElement('span');
    span.textContent = s.label;
    b.appendChild(span);
    b.addEventListener('click', () => navigate(s.path));
    sidebarEl.appendChild(b);
  });

  fileInput.addEventListener('change', async () => {
    const files = fileInput.files;
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        const dest = join(currentPath, sanitizeUploadName(f.name));
        await vfs.writeFile(dest, buf);
      } catch (err) {
        showError(err);
      }
    }
    fileInput.value = '';
  });

  function sanitizeUploadName(name: string): string {
    const base = name.split('/').pop() || 'file';
    return base.trim() || 'file';
  }

  let unsubFs: () => void;

  function showError(err: unknown) {
    statusEl.textContent = t('files.errorGeneric', { message: errorMessage(err) });
  }

  function clearError() {
    statusEl.textContent = '';
  }

  function updateSidebarActive() {
    sidebarEl.querySelectorAll<HTMLButtonElement>('.faisal-files-sidebar-item').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.path === currentPath);
    });
  }

  function renderCrumbs() {
    crumbs.replaceChildren();
    const segs = currentPath === '/' ? [] : currentPath.split('/').filter(Boolean);
    let acc = '';
    const rootBtn = document.createElement('button');
    rootBtn.className = 'faisal-files-crumb';
    rootBtn.textContent = '/';
    rootBtn.addEventListener('click', () => navigate('/'));
    crumbs.appendChild(rootBtn);
    for (const seg of segs) {
      acc += '/' + seg;
      const sep = document.createElement('span');
      sep.className = 'faisal-files-crumb-sep';
      sep.textContent = '/';
      crumbs.appendChild(sep);
      const p = acc;
      const b = document.createElement('button');
      b.className = 'faisal-files-crumb';
      b.textContent = seg;
      b.addEventListener('click', () => navigate(p));
      crumbs.appendChild(b);
    }
  }

  function setView(mode: ViewMode) {
    viewMode = mode;
    gridBtn.classList.toggle('is-active', mode === 'grid');
    listBtn.classList.toggle('is-active', mode === 'list');
    render();
  }

  function sortEntries(list: Stat[]): Stat[] {
    const dirsFirst = [...list].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      let cmp = 0;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      else if (sortKey === 'date') cmp = a.mtime - b.mtime;
      else cmp = a.size - b.size;
      return sortAsc ? cmp : -cmp;
    });
    return dirsFirst;
  }

  async function refresh() {
    try {
      entries = sortEntries(await vfs.readdir(currentPath));
      clearError();
    } catch (err) {
      entries = [];
      showError(err);
    }
    // drop stale selection entries
    const valid = new Set(entries.map((e) => e.path));
    selection = new Set([...selection].filter((p) => valid.has(p)));
    render();
  }

  function updateNavButtons() {
    backBtn.toggleAttribute('disabled', historyIndex <= 0);
    forwardBtn.toggleAttribute('disabled', historyIndex >= history.length - 1);
    upBtn.toggleAttribute('disabled', currentPath === HOME || !currentPath.startsWith(HOME));
  }

  async function navigate(path: string, opts: { pushHistory?: boolean } = { pushHistory: true }) {
    const norm = normalize(path);
    try {
      const st = await vfs.stat(norm);
      if (st.type !== 'dir') return;
    } catch (err) {
      showError(err);
      return;
    }
    currentPath = norm;
    if (opts.pushHistory !== false) {
      history.splice(historyIndex + 1);
      history.push(currentPath);
      historyIndex = history.length - 1;
    }
    selection = new Set();
    focusIndex = -1;
    updateSidebarActive();
    renderCrumbs();
    updateNavButtons();
    await refresh();
  }

  function goBack() {
    if (historyIndex <= 0) return;
    historyIndex--;
    void navigate(history[historyIndex], { pushHistory: false }).then(updateNavButtons);
  }

  function goForward() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    void navigate(history[historyIndex], { pushHistory: false }).then(updateNavButtons);
  }

  function goUp() {
    if (currentPath === HOME) return;
    void navigate(dirname(currentPath));
  }

  async function openEntry(st: Stat) {
    if (st.type === 'dir') {
      await navigate(st.path);
      return;
    }
    const manifest = sys.apps.appForFile(st.path);
    if (manifest) await sys.apps.launch(manifest.id, [st.path]);
  }

  async function createFolder() {
    const name = await promptDialog(win.content, {
      title: t('files.newFolderTitle'),
      message: t('files.newFolderPrompt'),
      okLabel: t('files.ok'),
      cancelLabel: t('files.cancel'),
      validate: (v) => {
        if (!v) return t('files.nameEmpty');
        if (invalidName(v)) return t('files.nameInvalid');
        return null;
      },
    });
    if (!name) return;
    const path = join(currentPath, name);
    try {
      await vfs.mkdir(path);
    } catch (err) {
      if (err instanceof VFSError && err.code === 'EEXIST') showError(new Error(t('files.nameExists')));
      else showError(err);
    }
  }

  async function renameSelection() {
    if (selection.size !== 1) return;
    const path = [...selection][0];
    const st = entries.find((e) => e.path === path);
    if (!st) return;
    const name = await promptDialog(win.content, {
      title: t('files.renameTitle'),
      message: t('files.renamePrompt'),
      initialValue: st.name,
      okLabel: t('files.ok'),
      cancelLabel: t('files.cancel'),
      validate: (v) => {
        if (!v) return t('files.nameEmpty');
        if (invalidName(v)) return t('files.nameInvalid');
        return null;
      },
    });
    if (!name || name === st.name) return;
    const dest = join(currentPath, name);
    try {
      await vfs.rename(path, dest);
    } catch (err) {
      if (err instanceof VFSError && err.code === 'EEXIST') showError(new Error(t('files.nameExists')));
      else showError(err);
    }
  }

  async function deleteSelection() {
    if (selection.size === 0) return;
    const paths = [...selection];
    const message = paths.length === 1
      ? t('files.deleteOne', { name: basename(paths[0]) })
      : t('files.deleteMany', { count: paths.length });
    const ok = await confirmDialog(win.content, {
      title: t('files.deleteTitle'),
      message,
      okLabel: t('files.delete'),
      cancelLabel: t('files.cancel'),
      danger: true,
    });
    if (!ok) return;
    for (const p of paths) {
      try {
        await vfs.remove(p, { recursive: true });
      } catch (err) {
        showError(err);
      }
    }
  }

  function copySelection(mode: 'copy' | 'cut') {
    if (selection.size === 0) return;
    clipboard = { mode, paths: [...selection] };
  }

  async function pasteClipboard() {
    if (!clipboard) return;
    const { mode, paths } = clipboard;
    for (const src of paths) {
      try {
        if (mode === 'cut' && sameOrDescendant(src, currentPath)) continue; // can't move into itself
        let dest = targetPathFor(src, currentPath);
        if (mode === 'copy') {
          const name = await uniqueName(vfs, currentPath, basename(src), t('files.copyOf'));
          dest = join(currentPath, name);
          await copyRecursive(vfs, src, dest);
        } else {
          if (dest === src) continue;
          if (await vfs.exists(dest)) {
            const name = await uniqueName(vfs, currentPath, basename(src), t('files.copyOf'));
            dest = join(currentPath, name);
          }
          await vfs.rename(src, dest);
        }
      } catch (err) {
        showError(err);
      }
    }
    if (mode === 'cut') clipboard = null;
  }

  async function downloadEntry(st: Stat) {
    try {
      const data = await vfs.readFile(st.path);
      const blob = new Blob([data.slice()], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = st.name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      showError(err);
    }
  }

  // ---- context menu ----
  let openMenu: HTMLElement | null = null;
  function closeMenu() {
    openMenu?.remove();
    openMenu = null;
  }

  function showMenu(x: number, y: number, items: Array<{ label: string; action: () => void; danger?: boolean } | null>) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'faisal-files-menu';
    for (const item of items) {
      if (item === null) {
        const sep = document.createElement('div');
        sep.className = 'faisal-files-menu-sep';
        menu.appendChild(sep);
        continue;
      }
      const b = document.createElement('button');
      b.className = 'faisal-files-menu-item' + (item.danger ? ' is-danger' : '');
      b.textContent = item.label;
      b.addEventListener('click', () => { closeMenu(); item.action(); });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    menu.style.left = `${Math.min(x, vw - rect.width - 8)}px`;
    menu.style.top = `${Math.min(y, vh - rect.height - 8)}px`;
    openMenu = menu;
    setTimeout(() => document.addEventListener('mousedown', onDocMouseDown), 0);
  }

  function onDocMouseDown(e: MouseEvent) {
    if (openMenu && !openMenu.contains(e.target as Node)) {
      closeMenu();
      document.removeEventListener('mousedown', onDocMouseDown);
    }
  }

  function entryMenuItems(st: Stat) {
    const items: Array<{ label: string; action: () => void; danger?: boolean } | null> = [
      { label: t('files.open'), action: () => void openEntry(st) },
      { label: t('files.rename'), action: () => void renameSelection() },
      null,
      { label: t('files.copy'), action: () => copySelection('copy') },
      { label: t('files.cut'), action: () => copySelection('cut') },
    ];
    if (st.type === 'file') items.push({ label: t('files.download'), action: () => void downloadEntry(st) });
    items.push(null, { label: t('files.delete'), action: () => void deleteSelection(), danger: true });
    return items;
  }

  function emptyAreaMenuItems() {
    const items: Array<{ label: string; action: () => void } | null> = [
      { label: t('files.newFolder'), action: () => void createFolder() },
    ];
    if (clipboard) items.push({ label: t('files.paste'), action: () => void pasteClipboard() });
    items.push({ label: t('files.upload'), action: () => fileInput.click() });
    return items;
  }

  // ---- rendering ----
  function orderedPaths(): string[] {
    return entries.map((e) => e.path);
  }

  function selectOnly(path: string) {
    selection = new Set([path]);
  }

  function toggleSelect(path: string) {
    if (selection.has(path)) selection.delete(path);
    else selection.add(path);
  }

  function render() {
    viewEl.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'faisal-files-empty';
      empty.textContent = t('files.empty');
      viewEl.appendChild(empty);
    } else if (viewMode === 'grid') {
      renderGrid();
    } else {
      renderList();
    }
    updateStatus();
  }

  function updateStatus() {
    statusEl.textContent = selection.size > 0
      ? t('files.itemsSelected', { count: selection.size })
      : t('files.itemsCount', { count: entries.length });
  }

  function attachItemEvents(el: HTMLElement, st: Stat, index: number) {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) toggleSelect(st.path);
      else selectOnly(st.path);
      focusIndex = index;
      render();
    });
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      void openEntry(st);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!selection.has(st.path)) selectOnly(st.path);
      focusIndex = index;
      render();
      showMenu(e.clientX, e.clientY, entryMenuItems(st));
    });
  }

  function renderGrid() {
    const grid = document.createElement('div');
    grid.className = 'faisal-files-grid';
    entries.forEach((st, i) => {
      const item = document.createElement('div');
      item.className = 'faisal-files-item' + (selection.has(st.path) ? ' is-selected' : '');
      const iconWrap = document.createElement('div');
      iconWrap.className = 'faisal-files-item-icon';
      iconWrap.appendChild(icon(st.type === 'dir' ? ICONS.folder : ICONS.file));
      const name = document.createElement('div');
      name.className = 'faisal-files-item-name';
      name.textContent = st.name;
      item.append(iconWrap, name);
      attachItemEvents(item, st, i);
      grid.appendChild(item);
    });
    viewEl.appendChild(grid);
  }

  function sortHeaderBtn(label: string, key: SortKey): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label + (sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : '');
    b.addEventListener('click', () => {
      if (sortKey === key) sortAsc = !sortAsc;
      else { sortKey = key; sortAsc = true; }
      entries = sortEntries(entries);
      render();
    });
    return b;
  }

  function renderList() {
    const list = document.createElement('div');
    list.className = 'faisal-files-list';

    const header = document.createElement('div');
    header.className = 'faisal-files-list-header';
    header.append(
      sortHeaderBtn(t('files.name'), 'name'),
      sortHeaderBtn(t('files.size'), 'size'),
      sortHeaderBtn(t('files.modified'), 'date'),
    );
    list.appendChild(header);

    entries.forEach((st, i) => {
      const row = document.createElement('div');
      row.className = 'faisal-files-list-row' + (selection.has(st.path) ? ' is-selected' : '');
      const nameCell = document.createElement('div');
      nameCell.className = 'faisal-files-list-name';
      nameCell.appendChild(icon(st.type === 'dir' ? ICONS.folder : ICONS.file));
      const nameText = document.createElement('span');
      nameText.textContent = st.name;
      nameCell.appendChild(nameText);
      const sizeCell = document.createElement('div');
      sizeCell.className = 'faisal-files-list-meta';
      sizeCell.textContent = st.type === 'dir' ? '—' : formatBytes(st.size, sys.locale());
      const dateCell = document.createElement('div');
      dateCell.className = 'faisal-files-list-meta';
      dateCell.textContent = formatDate(st.mtime, sys.locale());
      row.append(nameCell, sizeCell, dateCell);
      attachItemEvents(row, st, i);
      list.appendChild(row);
    });
    viewEl.appendChild(list);
  }

  // background click clears selection; background context menu shows folder actions
  viewEl.addEventListener('click', () => {
    if (selection.size > 0) { selection = new Set(); render(); }
  });
  viewEl.addEventListener('contextmenu', (e) => {
    if (e.target !== viewEl) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, emptyAreaMenuItems());
  });

  viewEl.addEventListener('keydown', (e) => {
    const paths = orderedPaths();
    if (paths.length === 0 && e.key !== 'Backspace') return;
    const cols = viewMode === 'grid' ? Math.max(1, Math.floor(viewEl.clientWidth / 96)) : 1;

    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        focusIndex = Math.min(paths.length - 1, focusIndex + 1);
        selectOnly(paths[focusIndex]);
        render();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        focusIndex = Math.max(0, focusIndex - 1);
        selectOnly(paths[focusIndex]);
        render();
        break;
      case 'ArrowDown':
        e.preventDefault();
        focusIndex = Math.min(paths.length - 1, focusIndex + cols);
        selectOnly(paths[focusIndex]);
        render();
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusIndex = Math.max(0, focusIndex - cols);
        selectOnly(paths[focusIndex]);
        render();
        break;
      case 'Enter': {
        e.preventDefault();
        const st = entries.find((s) => s.path === paths[focusIndex]);
        if (st) void openEntry(st);
        break;
      }
      case 'Delete':
        e.preventDefault();
        void deleteSelection();
        break;
      case 'Backspace':
        e.preventDefault();
        goUp();
        break;
      case 'F2':
        e.preventDefault();
        void renameSelection();
        break;
      case 'c':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); copySelection('copy'); }
        break;
      case 'x':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); copySelection('cut'); }
        break;
      case 'v':
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); void pasteClipboard(); }
        break;
      default:
        return;
    }
  });

  unsubFs = sys.bus.on('fs:change', (payload) => {
    const dirOf = (p: string) => dirname(p);
    if (dirOf(payload.path) === currentPath || (payload.oldPath && dirOf(payload.oldPath) === currentPath)) {
      void refresh();
    }
  });

  win.onClose(() => {
    unsubFs();
    closeMenu();
    document.removeEventListener('mousedown', onDocMouseDown);
  });

  updateSidebarActive();
  renderCrumbs();
  updateNavButtons();
  setView('grid');
  void refresh();
}

const app: AppModule = {
  manifest,
  launch,
};

export default app;
