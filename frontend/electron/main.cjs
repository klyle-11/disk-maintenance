/**
 * Disk Intelligence - Electron Main Process
 * ==========================================
 * Main process for the Electron application.
 *
 * This file creates the browser window, manages the Python backend
 * process lifecycle, and handles app lifecycle events.
 */

const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

// Determine if we're in development mode
const isDev = process.env.NODE_ENV === 'development';

// Backend configuration
const BACKEND_PORT = 8001;
const BACKEND_HOST = '127.0.0.1';

// Keep a global reference of the window object and backend process
let mainWindow = null;
let backendProcess = null;

// ============================================================================
// Backend Process Management
// ============================================================================

/**
 * Get the path to the backend executable.
 * In development, we run the Python script directly.
 * In production, we run the PyInstaller-bundled executable.
 */
function getBackendPath() {
  if (isDev) {
    return null; // In dev mode, backend is started separately
  }

  // In production, the backend executable is in the resources/backend directory
  const resourcesPath = process.resourcesPath;

  if (process.platform === 'win32') {
    return path.join(resourcesPath, 'backend', 'disk-intelligence-backend.exe');
  } else {
    return path.join(resourcesPath, 'backend', 'disk-intelligence-backend');
  }
}

/**
 * Check if the backend port is already in use.
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, BACKEND_HOST);
  });
}

/**
 * Wait for the backend to be ready by polling the health endpoint.
 */
function waitForBackend(maxRetries = 30, interval = 500) {
  return new Promise((resolve, reject) => {
    let retries = 0;

    const check = () => {
      const http = require('http');
      const req = http.get(`http://${BACKEND_HOST}:${BACKEND_PORT}/api/health`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          retry();
        }
      });

      req.on('error', () => {
        retry();
      });

      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      retries++;
      if (retries >= maxRetries) {
        reject(new Error('Backend failed to start within timeout'));
      } else {
        setTimeout(check, interval);
      }
    };

    check();
  });
}

/**
 * Start the backend process.
 * In development mode, the backend should be started manually.
 */
async function startBackend() {
  if (isDev) {
    console.log('[Backend] Development mode — backend should be started manually');
    return;
  }

  const backendPath = getBackendPath();
  console.log(`[Backend] Starting backend: ${backendPath}`);

  // Check if the executable exists
  const fs = require('fs');
  if (!fs.existsSync(backendPath)) {
    console.error(`[Backend] Backend executable not found at: ${backendPath}`);
    dialog.showErrorBox(
      'Backend Not Found',
      `Could not find the backend executable at:\n${backendPath}\n\nPlease reinstall the application.`
    );
    app.quit();
    return;
  }

  // Check if port is already in use
  const portInUse = await isPortInUse(BACKEND_PORT);
  if (portInUse) {
    console.log(`[Backend] Port ${BACKEND_PORT} already in use, assuming backend is running`);
    return;
  }

  // Spawn the backend process
  backendProcess = spawn(backendPath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Ensure the backend uses the correct port
      BACKEND_PORT: String(BACKEND_PORT),
    },
    // Detach on non-Windows so the process doesn't keep the parent alive
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  backendProcess.stdout.on('data', (data) => {
    console.log(`[Backend stdout] ${data.toString().trim()}`);
  });

  backendProcess.stderr.on('data', (data) => {
    console.error(`[Backend stderr] ${data.toString().trim()}`);
  });

  backendProcess.on('error', (err) => {
    console.error(`[Backend] Failed to start: ${err.message}`);
    dialog.showErrorBox(
      'Backend Error',
      `Failed to start the backend process:\n${err.message}`
    );
  });

  backendProcess.on('exit', (code, signal) => {
    console.log(`[Backend] Exited with code ${code}, signal ${signal}`);
    backendProcess = null;
  });

  // Wait for the backend to be ready
  try {
    await waitForBackend();
    console.log('[Backend] Backend is ready');
  } catch (err) {
    console.error(`[Backend] ${err.message}`);
    dialog.showErrorBox(
      'Backend Startup Timeout',
      'The backend took too long to start. The application may not work correctly.'
    );
  }
}

/**
 * Stop the backend process gracefully.
 */
function stopBackend() {
  if (!backendProcess) return;

  console.log('[Backend] Stopping backend process...');

  try {
    if (process.platform === 'win32') {
      // On Windows, use taskkill to ensure the process tree is killed
      spawn('taskkill', ['/pid', String(backendProcess.pid), '/f', '/t'], {
        windowsHide: true,
      });
    } else {
      // On macOS/Linux, send SIGTERM
      backendProcess.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (backendProcess) {
          backendProcess.kill('SIGKILL');
        }
      }, 5000);
    }
  } catch (err) {
    console.error(`[Backend] Error stopping backend: ${err.message}`);
  }

  backendProcess = null;
}

// ============================================================================
// Window Management
// ============================================================================

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
    // In development, load from Vite dev server (port 5176)
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

// ============================================================================
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

// ============================================================================
// App Lifecycle
// ============================================================================

// Create window when Electron is ready
app.whenReady().then(async () => {
  // Start the backend first
  await startBackend();

  // Then create the window
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

// Clean up backend process before quitting
app.on('before-quit', () => {
  stopBackend();
});

app.on('will-quit', () => {
  stopBackend();
});

// Security: Prevent new window creation
app.on('web-contents-created', (event, contents) => {
  contents.on('new-window', (event, navigationUrl) => {
    event.preventDefault();
    shell.openExternal(navigationUrl);
  });
});
