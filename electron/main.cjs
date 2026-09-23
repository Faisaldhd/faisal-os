/**
 * Fai$al OS — desktop shell (Electron main process).
 *
 * Why this exists: inside a normal browser tab the OS can only show other sites
 * through an <iframe>, and most big sites (Google, YouTube, GitHub, …) forbid
 * that with X-Frame-Options / frame-ancestors. In the desktop build the Browser
 * and Web apps use Electron's <webview> instead: a real top-level browsing
 * context in its own process, which those headers do not apply to. Nothing is
 * proxied and no header is stripped — the site is loaded exactly as Chrome would.
 *
 * Security posture:
 *  • The OS page runs sandboxed with contextIsolation and no Node; the only
 *    thing it sees is the tiny `faisalDesktop` bridge from preload.cjs.
 *  • The OS is served from a private `app://` origin, never from file://.
 *  • Every <webview> is forced into a sandboxed, Node-less, preload-less guest
 *    on its own persistent session partition, and may only load http(s).
 *  • The OS window itself can never navigate away from app://.
 */
'use strict';

const { app, BrowserWindow, protocol, net, session, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const HOST = 'faisal-os';
const APP_ORIGIN = `${SCHEME}://${HOST}`;
const DIST = path.resolve(__dirname, '..', 'dist');
/** Cookies, logins and storage of browsed sites live here — separate from the OS. */
const WEB_PARTITION = 'persist:faisal-web';

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const isWebUrl = (url) => {
  try {
    const { protocol: p } = new URL(url);
    return p === 'https:' || p === 'http:';
  } catch {
    return false;
  }
};

/** Serves dist/ under app://faisal-os/, refusing anything that escapes it. */
function serveDist() {
  protocol.handle(SCHEME, (request) => {
    const { host, pathname } = new URL(request.url);
    if (host !== HOST) return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.normalize(path.join(DIST, rel));
    if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

/**
 * Browsed sites get a plain Chrome user agent: many (Google sign-in among them)
 * refuse or degrade for a UA that advertises Electron or an unknown app.
 */
function setupWebSession() {
  const ses = session.fromPartition(WEB_PARTITION);
  ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|faisal-os)\/\S+/g, ''));
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write', 'media', 'pointerLock']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#16264F',
    title: 'Fai$al OS',
    // Windows/macOS take the installer's icon; Linux window managers need it here.
    icon: path.join(DIST, 'icons', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
    },
  });

  const wc = win.webContents;

  // The OS window never leaves its own origin; web links go to the system browser.
  wc.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN + '/')) {
      event.preventDefault();
      if (isWebUrl(url)) shell.openExternal(url);
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Lock down every <webview> before it is created, whatever the page asked for.
  wc.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    params.partition = WEB_PARTITION;
    if (!isWebUrl(params.src)) event.preventDefault();
  });

  wc.on('did-attach-webview', (_event, guest) => {
    // Popups / target=_blank become a new tab in the Browser window that owns the guest.
    guest.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url) && !wc.isDestroyed()) wc.send('faisal:open-tab', { url, fromId: guest.id });
      return { action: 'deny' };
    });
    guest.on('will-navigate', (event, url) => {
      if (!isWebUrl(url)) event.preventDefault();
    });
  });

  win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}

/**
 * Auto-update from GitHub Releases (installed builds only; `npm run desktop`
 * runs from source and never updates itself). The update downloads in the
 * background; the user chooses to restart now, otherwise it installs on quit.
 * Being offline or having no release yet is not an error worth showing.
 */
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * What the About page shows. status: dev (running from source) | idle |
 * checking | latest | downloading | ready | error.
 */
let updateState = { status: app.isPackaged ? 'idle' : 'dev' };
let updater = null;

function setUpdateState(next) {
  updateState = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('faisal:update-status', updateState);
  }
}

function checkForUpdates() {
  if (!updater) return;
  // A finished download stays ready; re-checking would only hide the restart button.
  if (updateState.status === 'ready' || updateState.status === 'downloading') return;
  updater.checkForUpdates().catch((err) => {
    console.warn('[update]', err?.message ?? err);
    setUpdateState({ status: 'error', message: String(err?.message ?? err) });
  });
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setUpdateState({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => setUpdateState({ status: 'latest' }));
  autoUpdater.on('update-available', (info) => setUpdateState({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) =>
    setUpdateState({ status: 'downloading', version: updateState.version, percent: Math.round(p.percent) }));

  let prompted = false;
  autoUpdater.on('update-downloaded', async (info) => {
    setUpdateState({ status: 'ready', version: info.version });
    if (prompted) return;
    prompted = true;
    const ar = app.getLocale().startsWith('ar');
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ar ? ['إعادة التشغيل الآن', 'لاحقًا'] : ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Fai$al OS',
      message: ar ? `التحديث ${info.version} جاهز` : `Update ${info.version} is ready`,
      detail: ar
        ? 'أعد التشغيل لتثبيته الآن، أو سيُثبَّت تلقائيًا عند إغلاق التطبيق.'
        : 'Restart to install it now, or it installs automatically when you quit.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => {
    console.warn('[update]', err?.message ?? err);
    setUpdateState({ status: 'error', message: String(err?.message ?? err) });
  });

  checkForUpdates();
  setInterval(checkForUpdates, UPDATE_EVERY_MS);
}

ipcMain.handle('faisal:app-info', () => ({ version: app.getVersion(), update: updateState }));
ipcMain.handle('faisal:update-check', () => checkForUpdates());
ipcMain.handle('faisal:update-install', () => {
  if (updater && updateState.status === 'ready') updater.quitAndInstall();
});

ipcMain.handle('faisal:open-external', (_event, url) => {
  if (typeof url === 'string' && isWebUrl(url)) return shell.openExternal(url);
  return undefined;
});

app.whenReady().then(() => {
  serveDist();
  setupWebSession();
  createWindow();
  setupAutoUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
