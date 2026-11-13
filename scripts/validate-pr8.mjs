/** Sonda PR8 — arrastar arquivo do SO para a cena + ler nota completa +
 *  salvar arquivo no computador:
 *
 *  P8a  drop com DataTransfer (File real) → objeto com fsPath na cena +
 *       conteúdo REAL gravado no OPFS + realce .drop-file durante o dragover
 *  P8b  label do card da nota: classe .note, texto completo no DOM (> 40)
 *  P8c  clique na nota → modal [data-testid=file-preview] com o CONTEÚDO
 *       COMPLETO (não truncado) + fecha com Esc
 *  P8d  menu "Salvar no computador" → evento de download com nome do arquivo
 *  P8e  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr8.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr8-evidence';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`[${ok ? 'ok' : 'FALHOU'}] ${id} :: ${detail}`);
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listObjects, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const w = window.__bumptop?.world;
    return w.listObjects().length >= 3 && w.listObjects().every((o) => o.pose.position.y <= 2.2);
  }, { timeout: 20000 });

  // ---------- P8a: drop de arquivo DO SO ----------
  const dropOk = await page.evaluate(async () => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if (o.meta.fsPath === '/__p8_drop__.txt') w.removeObject(o.id);
    }
    await navigator.storage
      .getDirectory()
      .then((r) => r.removeEntry('__p8_drop__.txt', { recursive: true }).catch(() => {}));
    const canvas = document.querySelector('#scene-root canvas');
    const rect = canvas.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.items.add(new File(['conteudo sonda p8'], '__p8_drop__.txt', { type: 'text/plain' }));
    const cx = rect.left + rect.width * 0.55;
    const cy = rect.top + rect.height * 0.6;
    canvas.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, clientX: cx, clientY: cy, bubbles: true }));
    const realce = canvas.classList.contains('drop-file');
    canvas.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: cx, clientY: cy, bubbles: true }));
    const saiuRealce = !canvas.classList.contains('drop-file');
    return { realce, saiuRealce };
  });
  let objNaCena = false;
  let conteudo = null;
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    objNaCena = await page.evaluate(
      () => window.__bumptop.world.listObjects().some((o) => o.meta.fsPath === '/__p8_drop__.txt'),
    );
    if (!objNaCena) continue;
    conteudo = await page.evaluate(async () =>
      navigator.storage
        .getDirectory()
        .then((r) => r.getFileHandle('__p8_drop__.txt'))
        .then((h) => h.getFile())
        .then((f) => f.text())
        .catch(() => null),
    );
    if (conteudo !== null) break;
  }
  check('P8a', dropOk.realce && dropOk.saiuRealce && objNaCena && conteudo === 'conteudo sonda p8',
    `realce arraste=${dropOk.realce}/${dropOk.saiuRealce} | objeto na cena=${objNaCena} | conteúdo no OPFS=${JSON.stringify(conteudo)}`);
  await page.screenshot({ path: `${OUT}/p8a-drop.png` });

  // ---------- P8b: label da nota com texto completo + classe note ----------
  const textoLongo =
    'Primeira linha da nota com bastante texto para estourar o tamanho do card. ' +
    'Segunda linha continua o conteudo para garantir o truncamento visual. ' +
    'Terceira linha fecha o teste com mais caracteres ainda.';
  const notaId = await page.evaluate((txt) => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if (w.isStickyNote(o.id) && (o.meta.noteText || '').startsWith('Primeira linha')) {
        w.removeObject(o.id);
      }
    }
    return w.addStickyNote({ x: 30, y: 6, z: 30 }, txt);
  }, textoLongo);
  await sleep(600);
  const label = await page.evaluate(() => {
    const el = document.querySelector('.obj-label.note');
    return { tem: !!el, chars: el?.textContent?.length ?? 0 };
  });
  check('P8b', label.tem && label.chars > 100,
    `label .note presente=${label.tem} | chars no DOM=${label.chars} (antes: corte em 40)`);
  await page.screenshot({ path: `${OUT}/p8b-nota-card.png` });

  // ---------- P8c: clique na nota → EDITOR RICO com o conteúdo COMPLETO ----------
  // (PR14: o card escuro de leitura saiu — o clique abre o editor rico)
  const tela = await page.evaluate((oid) => {
    const pos = window.__bumptop.world.getObject(oid).pose.position;
    return window.__bumptop.renderer.projectToScreen(pos);
  }, notaId);
  const box = await page.locator('#scene-root canvas').boundingBox();
  await page.mouse.click(box.x + tela.x, box.y + tela.y);
  const modal = page.locator('[data-testid="note-rich"]');
  const modalOk = await modal.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
  const semLeitorEscuro = (await page.locator('[data-testid="file-preview"]').count()) === 0;
  const mostrado = modalOk ? await page.locator('.note-rich-content').textContent() : '';
  await page.keyboard.press('Escape');
  check('P8c', modalOk && semLeitorEscuro && (mostrado || '').includes(textoLongo),
    `editor rico abriu=${modalOk} | card escuro ausente=${semLeitorEscuro} | conteúdo completo=${(mostrado || '').includes(textoLongo)} (${(mostrado || '').length} chars)`);
  await page.screenshot({ path: `${OUT}/p8c-leitor-nota.png` });

  // ---------- P8d: menu "Salvar no computador" dispara download ----------
  const tAlvo = await page.evaluate(() => {
    const w = window.__bumptop.world;
    const o = w.listObjects().find((x) => x.meta.fsPath === '/__p8_drop__.txt');
    return window.__bumptop.renderer.projectToScreen(o.pose.position);
  });
  await page.mouse.click(box.x + tAlvo.x, box.y + tAlvo.y, { button: 'right' });
  const menu = page.locator('.ctx-menu');
  const menuOk = await menu.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
  const item = menu.locator('.radial-btn-label, .ctx-item').filter({ hasText: 'Salvar no computador' }).first();
  const itemOk = menuOk && (await item.isVisible().catch(() => false));
  let downloadOk = false;
  let nomeDownload = '';
  if (itemOk) {
    const dlPromise = page.waitForEvent('download', { timeout: 6000 }).catch(() => null);
    await item.click();
    const dl = await dlPromise;
    downloadOk = !!dl;
    nomeDownload = dl?.suggestedFilename() ?? '';
  }
  check('P8d', itemOk && downloadOk && nomeDownload === '__p8_drop__.txt',
    `menu item=${itemOk} | download disparado=${downloadOk} | nome="${nomeDownload}"`);
  await page.screenshot({ path: `${OUT}/p8d-menu-salvar.png` });

  // ---------- Cleanup ----------
  await page.evaluate(async () => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if (o.meta.fsPath === '/__p8_drop__.txt' || o.id.includes('nota')) w.removeObject(o.id);
    }
    w.removeObject('__p8_nota__');
    await navigator.storage
      .getDirectory()
      .then((r) => r.removeEntry('__p8_drop__.txt', { recursive: true }).catch(() => {}));
  });

  // ---------- P8e: zero erros de console ----------
  const filtrados = erros.filter(
    (e) => !/opfs-sahpool|Access Handles|sqlite/i.test(e), // ruído do fallback (2ª aba)
  );
  check('P8e', filtrados.length === 0, `erros de console: ${filtrados.length}${filtrados.length ? ' | ' + filtrados.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR8: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
