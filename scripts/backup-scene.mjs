/** Backup/restauração da cena publicada (validações em produção não podem
 *  deixar a cena do site poluída).
 *
 *  Uso:
 *    BASE_URL=https://bumptop.netlify.app node scripts/backup-scene.mjs export  <arquivo.json>
 *    BASE_URL=https://bumptop.netlify.app node scripts/backup-scene.mjs import  <arquivo.json>
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:5175';
const [modo, arquivo] = process.argv.slice(2);
if (!['export', 'import'].includes(modo) || !arquivo) {
  console.error('Uso: node scripts/backup-scene.mjs export|import <arquivo.json>');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR', acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listObjects, null, { timeout: 30000 });
  await sleep(1500);

  /** Abre o menu do chão e devolve o item desejado (sem clicar). */
  async function menuFind(texto) {
    const pontos = [[720, 640], [250, 780], [1150, 780], [300, 320], [1120, 320], [720, 820]];
    for (const [x, y] of pontos) {
      await page.mouse.click(x, y, { button: 'right' });
      const tem = await page.waitForSelector('.ctx-menu', { timeout: 4000 }).catch(() => null);
      if (!tem) continue;
      const item = page.locator('.ctx-item', { hasText: texto }).first();
      if (await item.isVisible().catch(() => false)) return item;
      await page.keyboard.press('Escape');
      await sleep(250);
    }
    throw new Error(`item "${texto}" do menu do chão não encontrado`);
  }

  if (modo === 'export') {
    const item = await menuFind('Exportar cena');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      item.click(),
    ]);
    mkdirSync(dirname(arquivo), { recursive: true });
    await download.saveAs(arquivo);
    const snap = JSON.parse(readFileSync(arquivo, 'utf8'));
    console.log(`export: ${arquivo} com ${snap.objects?.length ?? 0} objetos`);
  } else {
    const item = await menuFind('Importar cena');
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10000 }),
      item.click(),
    ]);
    await fc.setFiles(arquivo);
    await sleep(1500);
    const snap = JSON.parse(readFileSync(arquivo, 'utf8'));
    const atual = await page.evaluate(() => window.__bumptop.world.listObjects().length);
    console.log(`import: ${atual} objetos no mundo (esperado ${snap.objects?.length})`);
    if (atual !== snap.objects?.length) process.exitCode = 1;
  }
  await ctx.close();
} finally {
  await browser.close();
}
