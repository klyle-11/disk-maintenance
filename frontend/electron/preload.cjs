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
  /**
   * Opens a native directory selection dialog.
   * @returns {Promise<string|null>} The selected directory path, or null if cancelled.
   */
  selectDirectory: async () => {
    return await ipcRenderer.invoke('dialog:selectDirectory');
  },
});
