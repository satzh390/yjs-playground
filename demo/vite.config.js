import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    dedupe: ['@y/y', '@y/protocols']
  },
  optimizeDeps: {
    exclude: ['@y/protocols']
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT || 5173),
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:1234',
        changeOrigin: true
      }
    }
  }
})
