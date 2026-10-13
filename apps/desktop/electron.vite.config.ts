import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // @mockscope/core ships TypeScript source, so bundle it rather than requiring it at runtime.
    build: { externalizeDeps: { exclude: ['@mockscope/core'] } },
  },
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
    plugins: [react()],
  },
})
