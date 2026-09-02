import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The API in development; in any deployment the same origin serves both.
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
  build: { outDir: 'dist' },
})
