import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { mockscope } from '@mockscope/vite'
import { liveApi } from './live-api.ts'

export default defineConfig({
  plugins: [react(), mockscope(), liveApi()],
})
