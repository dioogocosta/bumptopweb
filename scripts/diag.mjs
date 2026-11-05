/**
 * Diagnóstico de runtime (não é teste) — carrega o preview e imprime
 * console + pageerror + estado do body p/ capturar a causa de falha de init.
 * Uso: node scripts/diag.mjs  (requer `npm run preview` rodando em :4173)
 */
import { chromium } from '@playwright/test';

const url = process.env.DIAG_URL ?? 'http://localhost:4173';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} :: ${r.failure()?.errorText}`));

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(9000);

const state = await page.evaluate(() => ({
  hasApp: !!window.__bumptop,
  backend: window.__bumptop?.repo?.backend?.() ?? null,
  count: window.__bumptop?.world?.objectCount?.() ?? null,
  hasCanvas: !!document.querySelector('#scene-root canvas'),
  bodyText: document.body.innerText.slice(0, 800),
}));

console.log('=== CONSOLE/ERROS ===');
for (const l of logs) console.log(l);
console.log('=== STATE ===');
console.log(JSON.stringify(state, null, 2));

await browser.close();
