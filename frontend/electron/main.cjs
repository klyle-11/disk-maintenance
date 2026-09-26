/**
 * Disk Intelligence - Electron Main Process
 * ==========================================
 * Creates the window, supervises the Python backend, and wires up IPC.
 *
 * The window is created immediately and the backend starts alongside it, so
 * the app is never a blank screen while a 27MB bundle unpacks. Backend status
 * is pushed to the renderer, which shows it inline.
 */

const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { BackendSupervisor } = require('./backend.cjs');

const isDev = process.env.NODE_ENV === 'development';
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5176';

let mainWindow = null;
let backend = null;

// Only one instance: a second one would fight over the port and the database.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function logPath() {
  return path.join(app.getPath('userData'), 'logs', 'backend.log');
}

// ============================================================================
// Window
// ============================================================================

/** Wait for the Vite dev server, then load it. Retries until it answers. */
function loadDevServer(win, attempt = 0) {
  const http = require('http');
  const req = http.get(DEV_SERVER_URL, { timeout: 1000 }, () => {
    req.destroy();
    if (!win.isDestroyed()) win.loadURL(DEV_SERVER_URL);
  });
  const retry = () => {
    req.destroy();
    if (win.isDestroyed()) return;
    if (attempt === 0) console.log(`[dev] waiting for ${DEV_SERVER_URL}…`);
    if (attempt > 60) {
      console.error(`[dev] ${DEV_SERVER_URL} never came up — is \`npm run dev:vite\` running?`);
      return;
    }
    setTimeout(() => loadDevServer(win, attempt + 1), 500);
  };
  req.on('error', retry);
  req.on('timeout', retry);
}

function createWindow() {
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
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    show: false,
  });

  if (isDev) {
    // Electron and Vite start together, so the dev server is often not up
    // yet. Loading straight away gave a blank window that never recovered.
    loadDevServer(mainWindow);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Push the current backend status as soon as the renderer can receive it.
  mainWindow.webContents.on('did-finish-load', () => {
    if (backend) sendStatus(backend.status());
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backend:status', status);
  }
}

// ============================================================================
// IPC
// ============================================================================

ipcMain.handle('dialog:selectDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties: ['openDirectory'],
    title: 'Select Directory to Scan',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// The renderer cannot know the port ahead of time: the backend may have moved
// to a free one. It asks for its API base URL at startup instead.
ipcMain.handle('backend:status', () => (backend ? backend.status() : null));

ipcMain.handle('backend:retry', async () => {
  if (!backend) return null;
  await backend.retry();
  return backend.status();
});

ipcMain.handle('backend:openLog', async () => {
  const target = logPath();
  if (!fs.existsSync(target)) return false;
  shell.showItemInFolder(target);
  return true;
});

ipcMain.handle('shell:showItem', async (_event, targetPath) => {
  if (typeof targetPath !== 'string' || !targetPath) return false;
  // Only ever reveal in the file manager. Never open or execute.
  if (!fs.existsSync(targetPath)) return false;
  shell.showItemInFolder(targetPath);
  return true;
});

// ============================================================================
// Lifecycle
// ============================================================================

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  backend = new BackendSupervisor({ isDev, logPath: logPath() });
  backend.on('status', sendStatus);

  // Window first, backend alongside it. The renderer renders its own
  // "starting…" state, which beats staring at nothing for 30 seconds.
  createWindow();
  backend.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let stopped = false;
function shutdown() {
  if (stopped) return;
  stopped = true;
  if (backend) backend.stop();
}

app.on('before-quit', shutdown);
app.on('will-quit', shutdown);
process.on('exit', shutdown);
// Without these the backend outlives a Ctrl-C in development.
process.on('SIGINT', () => {
  shutdown();
  app.quit();
});
process.on('SIGTERM', () => {
  shutdown();
  app.quit();
});

// Security: never let the renderer navigate away or open new windows.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    const allowed = isDev ? DEV_SERVER_URL : 'file://';
    if (!url.startsWith(allowed)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
});
