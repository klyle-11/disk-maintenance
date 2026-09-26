/**
 * Disk Intelligence - Electron Preload Script
 * ============================================
 * Securely exposes IPC methods to the renderer process.
 *
 * This script runs in a special context that has access to both
 * Node.js APIs and the renderer's window object. It uses contextBridge
 * to safely expose specific functionality without compromising security.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Expose a secure API to the renderer process.
 * This API is accessible via window.electronAPI in the renderer.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  /**
   * Opens a native directory selection dialog.
   * @returns {Promise<string|null>} The selected directory path, or null if cancelled.
   */
  selectDirectory: async () => {
    return await ipcRenderer.invoke('dialog:selectDirectory');
  },

  /**
   * Current backend status, including the base URL to talk to.
   * The port is not fixed: if something else holds 8001 the backend moves.
   * @returns {Promise<object|null>}
   */
  getBackendStatus: async () => {
    return await ipcRenderer.invoke('backend:status');
  },

  /** Subscribe to backend status changes. Returns an unsubscribe function. */
  onBackendStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('backend:status', handler);
    return () => ipcRenderer.removeListener('backend:status', handler);
  },

  /** Restart the backend after a failure. */
  retryBackend: async () => {
    return await ipcRenderer.invoke('backend:retry');
  },

  /** Reveal the backend log in the file manager. */
  openBackendLog: async () => {
    return await ipcRenderer.invoke('backend:openLog');
  },

  /** Reveal a scanned path in Finder/Explorer. Never opens or runs it. */
  revealPath: async (targetPath) => {
    return await ipcRenderer.invoke('shell:showItem', targetPath);
  },
});
