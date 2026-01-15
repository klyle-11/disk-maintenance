/**
 * TypeScript definitions for Electron API exposed via preload script.
 */

export interface ElectronAPI {
  /**
   * Opens a native directory selection dialog.
   * @returns Promise that resolves to the selected directory path, or null if cancelled.
   */
  selectDirectory: () => Promise<string | null>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
