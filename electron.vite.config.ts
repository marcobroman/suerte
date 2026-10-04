import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@': resolve(__dirname, 'src/renderer/src'),
  '@main': resolve(__dirname, 'src/main'),
  '@shared': resolve(__dirname, 'src/shared')
}

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      minify: true,
      chunkSizeWarningLimit: 1500
    }
  }
})
