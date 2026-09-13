import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Served from the root of kendacar.org, not a repo subfolder.
  base: '/',
})
