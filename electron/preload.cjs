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
  onOpenTab: (callback) => {
    const listener = (_event, payload) => {
      if (payload && typeof payload.url === 'string') callback(payload.url, Number(payload.fromId));
    };
    ipcRenderer.on('faisal:open-tab', listener);
    return () => ipcRenderer.removeListener('faisal:open-tab', listener);
  },
});
