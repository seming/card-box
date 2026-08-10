import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Internal imports use `#src/*`, declared once in package.json `imports`.
// Node, TypeScript and Vite all understand that field natively, so there is no
// alias to keep in sync here — a tsconfig `paths` entry would not have been
// visible to `node --test`.
const BASE = '/card-box/'

export default defineConfig({
  // Must match the repository name — GitHub Pages serves at /<repo>/.
  base: BASE,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Installing to the iOS home screen is not a nicety: Safari wipes
      // script-writable storage for a site untouched for seven days, and a home
      // screen app is exempt. Without this the review history is on a timer.
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        id: BASE,
        name: 'cardbox',
        short_name: 'cardbox',
        description: 'Spaced-repetition flashcards, offline first',
        lang: 'en',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f9f9f7',
        theme_color: '#f9f9f7',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Every route is the same shell; the router reads the path at runtime.
        navigateFallback: `${BASE}index.html`,
      },
    }),
  ],
})
