import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Use relative paths so Electron can load built files via file:// protocol
  base: './',

  // SECURITY: Disable Vite telemetry (CRITICAL-004)
  telemetry: false,

  build: {
    rollupOptions: {
      // The main window, and the tray's mini panel (Tauri only).
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        tray: fileURLToPath(new URL('./tray.html', import.meta.url)),
      },
    },
  },

  server: {
    port: 5176,
    strictPort: true,
    // SECURITY: Bind to localhost only (CRITICAL-003)
    host: '127.0.0.1',
  },
})
