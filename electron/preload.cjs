/**
 * Seren — Electron preload.
 *
 * Runs in an isolated world (contextIsolation: true) and exposes the smallest
 * possible surface to the web app: a desktop marker plus the three helpers the
 * boot/error screen needs. No Node APIs, no filesystem, no ipcRenderer are
 * handed to page code.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serenDesktop', {
  /** Lets the UI detect it is running inside the desktop shell (vs a browser). */
  isDesktop: true,
  /** { appVersion, electronVersion, platform } — resolved over IPC so the
   *  preload needs no access to the sandboxed `process` object. */
  getAppInfo: () => ipcRenderer.invoke('seren:app-info'),
  /** Re-launch the local server and retry loading the app (boot-failure page). */
  retryBoot: () => ipcRenderer.invoke('seren:retry-boot'),
  /** Reveal the OS app-data folder (Settings → Your Data). */
  openDataFolder: () => ipcRenderer.invoke('seren:open-data-folder'),
  /** Reveal seren-server.log in the OS file manager (boot-failure page). */
  openLogFile: () => ipcRenderer.invoke('seren:open-log'),
});
