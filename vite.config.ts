import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'
import fs from 'fs'

// Copy electron/remote/web/ to dist-electron/remote/web/ so the packaged main
// process can serve the remote share UI via LocalServer.
function copyRemoteWeb() {
  return {
    name: 'copy-remote-web',
    closeBundle() {
      const src = path.resolve(__dirname, 'electron/remote/web')
      const dest = path.resolve(__dirname, 'dist-electron/remote/web')
      if (!fs.existsSync(src)) return
      fs.rmSync(dest, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.cpSync(src, dest, { recursive: true })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          plugins: [copyRemoteWeb()],
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // Must stay external: either native addons vite can't bundle
              // (node-pty) or optional native ws addons. When vite bundles
              // `ws`'s optional `require('bufferutil')` it replaces the
              // import with an EMPTY STUB module, which bypasses ws's
              // try/catch fallback and crashes mid-frame with
              // "h.mask is not a function". Keeping them external means
              // runtime `require` throws (packages aren't installed) and
              // ws correctly falls back to its pure-JS implementation.
              external: ['node-pty', 'bufferutil', 'utf-8-validate'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(args) {
          args.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
