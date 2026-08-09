import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Internal imports use `#src/*`, declared once in package.json `imports`.
// Node, TypeScript and Vite all understand that field natively, so there is no
// alias to keep in sync here — a tsconfig `paths` entry would not have been
// visible to `node --test`.
//
// PWA (vite-plugin-pwa) is wired up in stage 6, not here — a service worker
// during early development caches stale builds and hides real bugs.
export default defineConfig({
  // Must match the repository name — GitHub Pages serves at /<repo>/.
  base: '/card-box/',
  plugins: [react(), tailwindcss()],
})
