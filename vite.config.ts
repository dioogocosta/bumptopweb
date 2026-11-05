/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const root = import.meta.dirname;

// BumpTop 3D Web — configuração de build
// - PWA com injectManifest (controle fino do Service Worker, necessário p/ precachear WASM)
// - Alias de paths espelhando a arquitetura hexagonal (core/ é puro)
export default defineConfig({
  resolve: {
    alias: {
      '@core': `${root}/src/core`,
      '@app': `${root}/src/app`,
      '@physics': `${root}/src/physics`,
      '@render': `${root}/src/render`,
      '@persistence': `${root}/src/persistence`,
      '@fs': `${root}/src/fs`,
      '@input': `${root}/src/input`,
      '@overlay': `${root}/src/overlay`,
    },
  },
  // Rapier e SQLite são WASM; o COOP/COEP não é necessário com OpfsSAHPoolVfs,
  // mas deixamos headers prontos caso migremos p/ SharedArrayBuffer no futuro.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Separa WASM-backed libs p/ cache eficiente no SW
        manualChunks(id) {
          if (id.includes('rapier')) return 'rapier';
          if (id.includes('sqlite')) return 'sqlite';
          if (id.includes('three')) return 'three';
        },
      },
    },
  },
  plugins: [
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/pwa',
      filename: 'sw.ts',
      registerType: 'prompt', // update flow controlado (toast "Atualizar")
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'BumpTop 3D',
        short_name: 'BumpTop',
        description: 'Desktop 3D no navegador — organize seus arquivos em pilhas físicas.',
        theme_color: '#1a1a20',
        background_color: '#1a1a20',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
      injectManifest: {
        // WASM + assets grandes no precache
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,wasm,ico}'],
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: { reporter: ['text', 'html'] },
  },
});
