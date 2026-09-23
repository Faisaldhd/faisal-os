import { manifest } from './manifest';
import type { AppContext, AppModule, Stat } from '../../kernel/types';
import { HOME, VFSError } from '../../kernel/types';
import { basename, dirname, join, normalize } from '../../kernel/path';
import { defineStrings, t } from '../../kernel/i18n';
import { formatBytes, formatDate } from './format';
import { copyRecursive, targetPathFor, uniqueName } from './copy';
import {
  FILES_MIME,
  PATHS_MIME,
  PATHS_PLAIN_MIME,
  decideDrop,
  dropRefusedKey,
  moveEntry,
  resolveDragPaths,
  type MoveRefusal,
} from './dnd';
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
    moveTo: 'نقل إلى…',
    moveToTitle: 'نقل إلى مجلد',
    moveToPrompt: 'مسار المجلد الهدف',
    dndRefusedSelf: 'لا يمكن نقل العنصر إلى نفسه',
    dndRefusedSubtree: 'لا يمكن نقل مجلد إلى داخل نفسه',
    dndRefusedSameParent: 'العنصر موجود في هذا المجلد بالفعل',
    dndRefusedNotDirectory: 'يمكن الإفلات في المجلدات فقط',
    dndRefusedNameTaken: 'يوجد عنصر بهذا الاسم في المجلد الهدف',
    dndRefusedNoTarget: 'أفلِت العنصر فوق مجلد',
    dndRefusedMissing: 'لم يعد العنصر المسحوب موجوداً',
    dndRefusedUnknown: 'لا يمكن الإفلات هنا',
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
    moveTo: 'Move to…',
    moveToTitle: 'Move to folder',
    moveToPrompt: 'Destination folder path',
    dndRefusedSelf: 'Cannot move an item into itself',
    dndRefusedSubtree: 'Cannot move a folder inside itself',
    dndRefusedSameParent: 'That item is already in this folder',
    dndRefusedNotDirectory: 'Drop onto a folder only',
    dndRefusedNameTaken: 'The destination already has an item with that name',
    dndRefusedNoTarget: 'Drop the item onto a folder',
    dndRefusedMissing: 'The dragged item no longer exists',
    dndRefusedUnknown: 'Cannot drop here',
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
  /** Set by onClose; once true no further UI work is done on the detached window. */
  let closed = false;
  /** Pending blob-URL revoke of a download, tracked so onClose can settle it exactly once. */
  let pendingRevoke: { timer: number; url: string } | null = null;

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

  fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    if (!files) return;
    // The picker is cleared after the upload, exactly as before; drop uploads leave it alone.
    void performUploads(files).then(() => {
      if (!closed) fileInput.value = '';
    });
  });

  /**
   * The one upload path, shared by the picker and by files dropped onto the app.
   * Names are never clobbered: a free name is picked first; the VFS still enforces its own
   * per-file and total size quotas inside writeFile.
   */
  async function performUploads(files: ArrayLike<File>): Promise<void> {
    for (const f of Array.from(files)) {
      if (closed) return;
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        const name = await uniqueName(vfs, currentPath, sanitizeUploadName(f.name), t('files.copyOf'));
        if (closed) return;
        await vfs.writeFile(join(currentPath, name), buf);
      } catch (err) {
        if (closed) return;
        showError(err);
      }
    }
  }

  /** Keeps a single path segment: strips separators and refuses "." / ".." so an upload cannot escape the folder. */
  function sanitizeUploadName(name: string): string {
    const base = name.split(/[/\\]/).pop()?.trim() || 'file';
    return base === '.' || base === '..' ? 'file' : base;
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
        if (closed) return;
        showError(err);
      }
      if (closed) return;
    }
  }

  function copySelection(mode: 'copy' | 'cut') {
    if (selection.size === 0) return;
    clipboard = { mode, paths: [...selection] };
  }

  /**
   * Shows the reason a move/drop was refused instead of spamming an error dialog.
   * Returns false for the benign no-op (already in that folder), which stays silent.
   */
  function reportRefusal(reason: MoveRefusal): boolean {
    if (reason !== 'sameParent') statusEl.textContent = t(dropRefusedKey(reason));
    return false;
  }

  /** The single move path: clipboard cut-paste, drag & drop and "Move to…" all land here. */
  async function commitMove(sources: string[], destDir: string): Promise<boolean> {
    let movedAny = false;
    for (const src of sources) {
      if (closed) return movedAny;
      const res = await moveEntry(vfs, src, destDir, { onConflict: 'uniquify', copySuffix: t('files.copyOf') });
      if (closed) return movedAny;
      if (!res.ok) {
        if (!movedAny) reportRefusal(res.reason);
        continue;
      }
      movedAny = true;
    }
    return movedAny;
  }

  async function pasteClipboard() {
    if (!clipboard) return;
    const { mode, paths } = clipboard;
    for (const src of paths) {
      if (closed) return;
      try {
        if (mode === 'copy') {
          const name = await uniqueName(vfs, currentPath, basename(src), t('files.copyOf'));
          if (closed) return;
          await copyRecursive(vfs, src, join(currentPath, name));
        } else {
          // The same guards as a drop: self, own subtree and same folder are refused.
          await commitMove([src], currentPath);
        }
      } catch (err) {
        if (closed) return;
        showError(err);
      }
    }
    if (mode === 'cut') clipboard = null;
  }

  /**
   * Accessible move: the context menu's "Move to…" asks for a destination folder and runs the
   * same mover as a drag, so a keyboard-only user is never blocked. It behaves exactly like a
   * drop of the current selection onto that folder (including the same refusals).
   */
  async function moveSelectionToDialog() {
    if (selection.size === 0) return;
    const paths = [...selection];
    const suggested = dirname(paths[0]) === currentPath ? (currentPath === HOME ? join(HOME, 'Documents') : dirname(currentPath)) : currentPath;
    const answer = await promptDialog(win.content, {
      title: t('files.moveToTitle'),
      message: t('files.moveToPrompt'),
      initialValue: suggested,
      okLabel: t('files.moveTo'),
      cancelLabel: t('files.cancel'),
      validate: (v) => (v.startsWith('/') ? null : t('files.nameInvalid')),
    });
    if (!answer) return;
    const destDir = normalize(answer);
    const moved = await commitMove(paths, destDir);
    if (moved) selection = new Set();
    await refresh();
  }

  async function downloadEntry(st: Stat) {
    try {
      const data = await vfs.readFile(st.path);
      if (closed) return;
      const blob = new Blob([data.slice()], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = st.name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Tracked so onClose can settle it; the callback and close revoke exactly once either way.
      const timer = window.setTimeout(() => {
        if (pendingRevoke?.timer === timer) pendingRevoke = null;
        URL.revokeObjectURL(url);
      }, 4000);
      pendingRevoke = { timer, url };
    } catch (err) {
      if (closed) return;
      showError(err);
    }
  }

  /** Revokes the pending download URL and clears its timer, exactly once. */
  function settlePendingRevoke() {
    if (!pendingRevoke) return;
    const { timer, url } = pendingRevoke;
    pendingRevoke = null;
    window.clearTimeout(timer);
    URL.revokeObjectURL(url);
  }

  // ---- context menu ----
  let openMenu: HTMLElement | null = null;
  let menuListenerTimer: number | null = null;
  /** Closes the menu and always drops its document listener and pending attach timer. */
  function closeMenu() {
    if (menuListenerTimer !== null) {
      window.clearTimeout(menuListenerTimer);
      menuListenerTimer = null;
    }
    document.removeEventListener('mousedown', onDocMouseDown);
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
    menuListenerTimer = window.setTimeout(() => {
      menuListenerTimer = null;
      document.addEventListener('mousedown', onDocMouseDown);
    }, 0);
  }

  function onDocMouseDown(e: MouseEvent) {
    if (openMenu && !openMenu.contains(e.target as Node)) closeMenu();
  }

  function entryMenuItems(st: Stat) {
    const items: Array<{ label: string; action: () => void; danger?: boolean } | null> = [
      { label: t('files.open'), action: () => void openEntry(st) },
      { label: t('files.rename'), action: () => void renameSelection() },
      null,
      { label: t('files.copy'), action: () => copySelection('copy') },
      { label: t('files.cut'), action: () => copySelection('cut') },
      // Keyboard/context-menu route to the same mover a drag uses, so dragging is never
      // the only way to move an entry into another folder.
      { label: t('files.moveTo'), action: () => void moveSelectionToDialog() },
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

  // ---- drag & drop ----
  /** Row currently highlighted as a move destination, or null. */
  let dropRowEl: HTMLElement | null = null;

  /** The stat of the row the pointer is over; null for the empty area around the rows. */
  function dropTargetFor(e: DragEvent): Stat | null {
    const row = e.target instanceof Element ? e.target.closest('.faisal-files-item, .faisal-files-list-row') : null;
    if (!row) return null;
    return entries.find((x) => x.path === (row as HTMLElement).dataset.path) ?? null;
  }

  function setDropTarget(row: HTMLElement | null) {
    if (dropRowEl === row) return;
    dropRowEl?.classList.remove('is-drop-target');
    dropRowEl = row;
    dropRowEl?.classList.add('is-drop-target');
  }

  function dragTypes(e: DragEvent): string[] {
    const dt = e.dataTransfer;
    if (!dt) return [];
    return Array.from(dt.types ?? []);
  }

  function hasDraggedFiles(e: DragEvent): boolean {
    const dt = e.dataTransfer;
    if (!dt) return false;
    return dt.files?.length > 0 || Array.from(dt.items ?? []).some((it) => it.kind === 'file');
  }

  /** Decides (and highlights) what a drop over a row would do. Pure logic lives in dnd.ts. */
  function prepareRowDrop(e: DragEvent): { sources: string[]; destDir: string } | null {
    const row = e.target instanceof Element ? e.target.closest('.faisal-files-item, .faisal-files-list-row') as HTMLElement | null : null;
    const target = dropTargetFor(e);
    const sources = resolveDragPaths(dragTypes(e), (f) => e.dataTransfer?.getData(f) ?? '');
    const decision = decideDrop({
      types: dragTypes(e),
      sources,
      target: target ? { path: target.path, type: target.type } : null,
      // A drop may rename to a free name but must never overwrite an existing entry.
      resolveName: (dir, name) => (existsIn(dir, name) ? { finalName: name, conflict: true } : { finalName: name, conflict: false }),
    });
    if (decision.kind !== 'move') {
      setDropTarget(null);
      return null;
    }
    setDropTarget(row);
    return { sources: decision.sources, destDir: decision.destDir };
  }

  /** Synchronous existence view of the entries currently listed (a drop target's children). */
  function existsIn(dir: string, name: string): boolean {
    const full = join(dir, name);
    return entries.some((x) => x.path === full);
  }

  async function applyDrop(sources: string[], destDir: string) {
    const moved = await commitMove(sources, destDir);
    if (closed) return;
    if (moved) selection = new Set();
    await refresh();
  }

  async function handleExternalDrop(e: DragEvent) {
    if (closed) return;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      await performUploads(files);
    } else {
      // Some browsers only expose dropped files through items.
      const collected: File[] = [];
      for (const it of Array.from(e.dataTransfer?.items ?? [])) {
        if (it.kind !== 'file') continue;
        const f = it.getAsFile();
        if (f) collected.push(f);
      }
      await performUploads(collected);
    }
    if (closed) return;
    await refresh();
  }

  // View-level drag handlers are attached once (not per render) and cover both the rows
  // (internal moves) and the empty area (external uploads); onClose detaches them.
  const onViewDragover = (e: DragEvent) => {
    if (hasDraggedFiles(e)) {
      if (dragTypes(e).includes(PATHS_MIME)) return; // internal drag: rows own the highlight
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      viewEl.classList.add('faisal-files-dropzone-active');
      return;
    }
    if (!dragTypes(e).includes(PATHS_MIME)) return; // unrelated drag (e.g. selected text): ignore
    if (prepareRowDrop(e) && e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  };

  const onViewDragleave = (e: DragEvent) => {
    // Only when the pointer really left the view, not when moving between child rows.
    const to = e.relatedTarget;
    if (!(to instanceof Node) || !viewEl.contains(to)) {
      viewEl.classList.remove('faisal-files-dropzone-active');
      setDropTarget(null);
    }
  };

  const onViewDrop = (e: DragEvent) => {
    viewEl.classList.remove('faisal-files-dropzone-active');
    if (closed) { setDropTarget(null); return; }
    if (hasDraggedFiles(e)) {
      if (dragTypes(e).includes(PATHS_MIME)) return;
      e.preventDefault();
      setDropTarget(null);
      void handleExternalDrop(e);
      return;
    }
    if (!dragTypes(e).includes(PATHS_MIME)) return; // never hijack unrelated drags
    e.preventDefault();
    // The transfer must be read while the drop event is still live.
    const result = prepareRowDrop(e);
    setDropTarget(null);
    if (result) void applyDrop(result.sources, result.destDir);
  };

  const onViewDragend = () => {
    viewEl.classList.remove('faisal-files-dropzone-active');
    setDropTarget(null);
  };

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
    el.dataset.path = st.path;
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      // Dragging one entry of a multi-selection moves the whole selection.
      const paths = selection.has(st.path) && selection.size > 0 ? [...selection] : [st.path];
      const dt = e.dataTransfer;
      if (!dt) return;
      dt.setData(PATHS_MIME, paths.join('\n'));
      dt.setData(PATHS_PLAIN_MIME, paths.join('\n'));
      dt.effectAllowed = 'move';
      // A small ghost instead of the whole row.
      const ghost = el.firstElementChild;
      if (ghost && typeof dt.setDragImage === 'function') dt.setDragImage(ghost as Element, 20, 20);
      if (!selection.has(st.path)) selectOnly(st.path);
    });
    el.addEventListener('dragend', () => {
      setDropTarget(null);
      viewEl.classList.remove('faisal-files-dropzone-active');
    });
    el.addEventListener('dragover', (e) => {
      // Only an internal path drag may be dropped on a row; external files go to the view.
      if (!dragTypes(e).includes(PATHS_MIME)) return;
      if (st.type !== 'dir') { setDropTarget(null); return; } // never accept on a file row
      if (prepareRowDrop(e)) e.preventDefault();
    });
    el.addEventListener('drop', (e) => {
      if (!dragTypes(e).includes(PATHS_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      const result = prepareRowDrop(e);
      setDropTarget(null);
      if (result) void applyDrop(result.sources, result.destDir);
    });
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
      item.dataset.path = st.path;
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

  // drag & drop (attached once here, detached in onClose)
  viewEl.addEventListener('dragover', onViewDragover);
  viewEl.addEventListener('dragleave', onViewDragleave);
  viewEl.addEventListener('drop', onViewDrop);
  viewEl.addEventListener('dragend', onViewDragend);

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
    closed = true;
    unsubFs();
    closeMenu();
    document.removeEventListener('mousedown', onDocMouseDown);
    viewEl.removeEventListener('dragover', onViewDragover);
    viewEl.removeEventListener('dragleave', onViewDragleave);
    viewEl.removeEventListener('drop', onViewDrop);
    viewEl.removeEventListener('dragend', onViewDragend);
    settlePendingRevoke();
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
