import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // SECURITY: Disable Vite telemetry (CRITICAL-004)
  telemetry: false,

  server: {
    port: 5176,
    strictPort: true,
    // SECURITY: Bind to localhost only (CRITICAL-003)
    host: '127.0.0.1',
  },
})
