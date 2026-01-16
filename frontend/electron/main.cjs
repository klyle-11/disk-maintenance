/**
 * Disk Intelligence - Electron Main Process
 * ==========================================
 * Main process for the Electron application.
 *
 * This file creates the browser window and handles
 * app lifecycle events.
 */

const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('path');

// Determine if we're in development mode
const isDev = process.env.NODE_ENV === 'development';

// Keep a global reference of the window object
let mainWindow = null;

function createWindow() {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#11111b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    // Window styling - use native frame on macOS
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    show: false, // Don't show until ready
  });

  // Load the app
  if (isDev) {
    // In development, load from Vite dev server (port 5300 to avoid conflicts)
    mainWindow.loadURL('http://localhost:5176');
    // Open DevTools in development
    mainWindow.webContents.openDevTools();
  } else {
    // In production, load the built files
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Show window when ready to prevent visual flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Handle external links - open in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Cleanup on window close
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handlers
// ============================================================================

/**
 * Handle directory selection dialog requests.
 * Opens a native OS dialog that only allows selecting directories.
 */
ipcMain.handle('dialog:selectDirectory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Directory to Scan',
  });

  // Return the first selected path, or null if cancelled
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

// App Lifecycle
// ============================================================================

// Create window when Electron is ready
app.whenReady().then(() => {
  createWindow();

  // On macOS, re-create window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Security: Prevent new window creation
app.on('web-contents-created', (event, contents) => {
  contents.on('new-window', (event, navigationUrl) => {
    event.preventDefault();
    shell.openExternal(navigationUrl);
  });
});

// TODO: Add IPC handlers for native file dialogs
// TODO: Add auto-updater for production builds
// TODO: Add system tray support
// TODO: Add native menu customization
