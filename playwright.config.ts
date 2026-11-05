import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:4173',
    headless: true,
    // App é pt-BR por detecção de navigator.language — fixa o locale p/ os
    // E2E afirmarem os textos em português (i18n, P0)
    locale: 'pt-BR',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      // Emulação mobile (touch + viewport retrato + DPR alto).
      // Chromium com isMobile cobre os gestos (tap/long-press/pinch) p/ Android
      // e iOS Safari usa o mesmo código (OPFS fallback testado no modo virtual).
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
      },
    },
  ],
  webServer: {
    command: 'npm run preview',
    port: 4173,
    reuseExistingServer: true,
    timeout: 60000,
  },
});
