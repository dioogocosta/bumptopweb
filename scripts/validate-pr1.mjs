/** Sonda PR1 — itens 1 e 2 (HANDOFF do dono):
 *  1) Nomes dos arquivos como opção do menu (toggle + persistência da preferência)
 *  2) Persistência: flush ao esconder aba + save imediato da nota + export/import JSON
 *
 * Checagens:
 *  P1a  labels visíveis por padrão
 *  P1b  menu do chão tem o item "Nomes dos arquivos (✓)"
 *  P1c  desligar → labels somem
 *  P1d  religar → labels voltam
 *  P1e  preferência persiste no reload (desligado → continua desligado)
 *  P1f  editar nota e recarregar ANTES do flush de 2 s → texto sobrevive (save imediato)
 *  P1g  exportar cena → download JSON com objects[]
 *  P1h  importar → cena restaurada (toast)
 *  P1i  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:5175 node scripts/validate-pr1.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:5175';
const OUT = 'test-results/pr1-evidence';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`[${ok ? 'ok' : 'FALHOU'}] ${id} :: ${detail}`);
};

const nLabels = (page) => page.locator('.obj-label').count();

/**
 * Abre o menu do CHÃO (botão direito em ponto vazio) e devolve o item desejado.
 * Tenta vários pontos: sobre objeto o menu é outro (não tem estes itens).
 */
async function menuChao(page, texto) {
  const pontos = [
    [720, 640], [250, 780], [1150, 780], [300, 320], [1120, 320], [720, 820],
  ];
  for (const [x, y] of pontos) {
    await page.mouse.click(x, y, { button: 'right' });
    const temMenu = await page.waitForSelector('.ctx-menu', { timeout: 4000 }).catch(() => null);
    if (!temMenu) continue;
    const item = page.locator('.ctx-item', { hasText: texto }).first();
    const achou = await item.isVisible().catch(() => false);
    if (achou) return { x, y, item };
    await page.keyboard.press('Escape');
    await sleep(250);
  }
  throw new Error(`menu do chão com "${texto}" não encontrado em nenhum ponto`);
}

/** Abre o menu do chão e clica no item. */
async function menuClick(page, texto) {
  const m = await menuChao(page, texto);
  await m.item.click();
  await sleep(350);
  return m;
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR', acceptDownloads: true });
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listObjects, null, { timeout: 30000 });
  await sleep(2500);

  // P1a — labels por padrão
  const n0 = await nLabels(page);
  check('P1a', n0 > 0, `${n0} labels visíveis no início`);

  // P1b/P1c — menu do chão com o toggle e desligar
  await menuClick(page, 'Nomes dos arquivos');
  const n1 = await nLabels(page);
  check('P1c', n1 === 0, `após desligar: ${n1} labels (esperado 0)`);

  // P1d — religar
  await menuClick(page, 'Nomes dos arquivos');
  const n2 = await nLabels(page);
  check('P1d', n2 > 0, `após religar: ${n2} labels (esperado >0)`);
  await page.screenshot({ path: `${OUT}/p1d-nomes-ligados.png` });

  // P1e — preferência persiste no reload (deixa DESLIGADO, recarrega, religa)
  await menuClick(page, 'Nomes dos arquivos');
  const antesReload = await nLabels(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listObjects, null, { timeout: 30000 });
  await sleep(2000);
  const depoisReload = await nLabels(page);
  check('P1e', antesReload === 0 && depoisReload === 0,
    `desligado antes do reload=${antesReload === 0}, depois do reload=${depoisReload === 0} labels`);
  await menuClick(page, 'Nomes dos arquivos'); // religa p/ próximos passos

  // P1f — nota salva ANTES do flush de 2 s (save imediato)
  const mNota = await menuChao(page, 'Nova nota adesiva');
  await mNota.item.click();
  await page.waitForSelector('textarea', { timeout: 5000 });
  await page.locator('textarea').fill('anotação de teste PR1');
  const t0 = Date.now();
  await page.locator('.ctx-item', { hasText: 'Salvar' }).first().click();
  await sleep(400); // bem menos que o SAVE_INTERVAL de 2000 ms
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listObjects, null, { timeout: 30000 });
  const notaOk = await page.evaluate(() =>
    window.__bumptop.world.listObjects().some((o) => o.meta?.noteText === 'anotação de teste PR1'));
  check('P1f', notaOk, `reload ${Date.now() - t0} ms após salvar → nota recuperada=${notaOk}`);

  // P1g — exportar cena
  const mExp = await menuChao(page, 'Exportar cena');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    mExp.item.click(),
  ]);
  const caminho = `${OUT}/cena-exportada.json`;
  await download.saveAs(caminho);
  const snap = JSON.parse(readFileSync(caminho, 'utf8'));
  check('P1g', Array.isArray(snap.objects) && snap.objects.length > 0,
    `download "${download.suggestedFilename()}" com ${snap.objects?.length ?? 0} objetos`);

  // P1h — importar de volta (filechooser nativo aberto pelo input dinâmico)
  const mImp = await menuChao(page, 'Importar cena');
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    mImp.item.click(),
  ]);
  await fc.setFiles(caminho);
  await sleep(1500);
  const importado = await page.evaluate(() => window.__bumptop.world.listObjects().length);
  const toastImport = await page.locator('text=Cena importada').count();
  check('P1h', importado === snap.objects.length && toastImport > 0,
    `import: ${importado} objetos no mundo (export tinham ${snap.objects.length}) | toast=${toastImport > 0}`);

  await page.screenshot({ path: `${OUT}/p1h-pos-import.png` });

  check('P1i', erros.length === 0, `erros de console: ${erros.length}${erros.length ? ' | ' + erros.slice(0, 3).join(' || ') : ''}`);
  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR1: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
