/**
 * Fai$al OS — desktop preload. Runs sandboxed with contextIsolation, so the
 * page only ever sees this frozen object, never ipcRenderer or Node.
 * The renderer-side contract lives in src/shell/native-web.ts.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('faisalDesktop', {
  isDesktop: true,
  /** Opens an http(s) URL in the user's real system browser. */
  openExternal: (url) => ipcRenderer.invoke('faisal:open-external', String(url)),
  /**
   * Subscribes to "a page inside a <webview> asked for a new window".
   * `fromId` is the guest's webContents id, so each Browser window only
   * handles popups from its own tabs. Returns an unsubscribe function.
   */
  /** { version, update } — the installed app version and the current update state. */
  appInfo: () => ipcRenderer.invoke('faisal:app-info'),
  checkForUpdates: () => ipcRenderer.invoke('faisal:update-check'),
  /** Restarts into a downloaded update (no-op unless one is ready). */
  installUpdate: () => ipcRenderer.invoke('faisal:update-install'),
  /** Subscribes to update state changes. Returns an unsubscribe function. */
  onUpdateStatus: (callback) => {
    const listener = (_event, state) => {
      if (state && typeof state.status === 'string') callback(state);
    };
    ipcRenderer.on('faisal:update-status', listener);
    return () => ipcRenderer.removeListener('faisal:update-status', listener);
  },
  onOpenTab: (callback) => {
    const listener = (_event, payload) => {
      if (payload && typeof payload.url === 'string') callback(payload.url, Number(payload.fromId));
    };
    ipcRenderer.on('faisal:open-tab', listener);
    return () => ipcRenderer.removeListener('faisal:open-tab', listener);
  },
});
