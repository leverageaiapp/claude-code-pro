// Copy Excalidraw's drawing fonts from node_modules into public/ so
// window.EXCALIDRAW_ASSET_PATH can load them at runtime. Runs on
// postinstall across macOS/Linux/Windows — don't shell out to `cp`.

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const src = path.join(
  root,
  'node_modules',
  '@excalidraw',
  'excalidraw',
  'dist',
  'prod',
  'fonts',
)
const dest = path.join(root, 'public', 'excalidraw-assets', 'fonts')

if (!fs.existsSync(src)) {
  // Package not installed yet (e.g. fresh clone before first install
  // completes) — postinstall will re-run after install finishes.
  process.exit(0)
}

fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.cpSync(src, dest, { recursive: true })

console.log(`Copied Excalidraw fonts -> ${path.relative(root, dest)}`)
