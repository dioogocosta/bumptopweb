/** Sonda PR12 (regressão pós-PR13) — sistema de notas rico:
 *
 *  P12a  duplo-clique abre o modal rico GRANDE (≥80% da tela)
 *  P12c  paleta: clicar uma cor muda o fundo do modal e persiste em
 *        meta.noteBg (textura regenerada)
 *  P12e  desenho: ✍ abre canvas, desenhar e concluir grava meta.noteDrawing
 *  P12f  lembrete rápido ⏰ "Amanhã 08:00" grava meta.noteReminder; lembrete
 *        vencido dispara (toast ⏰ + noteReminderFired)
 *  P12g  nota antiga (só noteText) continua renderizando a face
 *  P12h  zero erros de console
 *
 * (P12b/P12d — formatação e checklist — foram reescritas no PR13 WYSIWYG:
 *  cobertas pela sonda validate-pr13.mjs.)
 *
 * Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr12.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr12-evidence';
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
  const box = await page.locator('#scene-root canvas').boundingBox();
  const telaDe = (oid) =>
    page.evaluate((id) => {
      const pos = window.__bumptop.world.getObject(id).pose.position;
      return window.__bumptop.renderer.projectToScreen(pos);
    }, oid);
  const ids = [];
  const cleanup = async () => {
    await page.evaluate((list) => {
      const w = window.__bumptop.world;
      for (const id of list) if (w.getObject(id)) w.removeObject(id);
    }, ids);
  };

  // Nota de teste num canto livre da sala
  const notaId = await page.evaluate(() => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if ((o.meta.noteText || '').includes('__p12__')) w.removeObject(o.id);
    }
    return w.addStickyNote({ x: 40, y: 1.2, z: -40 }, '__p12__');
  });
  ids.push(notaId);
  await sleep(300);

  const abrirModal = async () => {
    const t = await telaDe(notaId);
    await page.mouse.dblclick(box.x + t.x, box.y + t.y);
    await page.locator('[data-testid="note-rich"]').waitFor({ state: 'visible', timeout: 5000 });
    await sleep(200);
  };
  const fechar = async () => {
    await page.locator('.note-rich-done').click();
    await page.locator('[data-testid="note-rich"]').waitFor({ state: 'detached', timeout: 5000 });
    await sleep(600);
  };

  // ---------- P12a: modal rico GRANDE ----------
  await abrirModal();
  const modal = page.locator('[data-testid="note-rich"]');
  const tamanho = await modal.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width / window.innerWidth, h: r.height / window.innerHeight };
  });
  check('P12a', tamanho.w >= 0.8 && tamanho.h >= 0.75,
    `largura ${(tamanho.w * 100).toFixed(0)}% ≥80% | altura ${(tamanho.h * 100).toFixed(0)}% ≥75%`);
  await page.screenshot({ path: `${OUT}/p12a-modal-grande.png` });

  // ---------- P12c: paleta de cor de fundo ----------
  const editor = page.locator('.note-rich-content');
  await editor.click();
  await page.keyboard.type('nota paleta');
  await page.locator('.note-rich-tool').filter({ hasText: '🎨' }).click();
  const swatches = page.locator('.note-rich-swatch');
  const nSw = await swatches.count();
  await swatches.nth(2).click(); // #f28b82 (coral)
  const bgModal = await modal.evaluate((el) => getComputedStyle(el).backgroundColor);
  const thumb0 = await page.evaluate((id) => window.__bumptop.world.getObject(id)?.meta.thumb ?? null, notaId);
  await fechar();
  const metaBg = await page.evaluate((id) => window.__bumptop.world.getObject(id)?.meta.noteBg ?? null, notaId);
  const thumb1 = await page.evaluate((id) => window.__bumptop.world.getObject(id)?.meta.thumb ?? null, notaId);
  check('P12c', nSw >= 8 && bgModal.includes('242, 139, 130') && metaBg === '#f28b82' && thumb0 !== thumb1,
    `paleta=${nSw} cores | modal bg=${bgModal} | meta.noteBg=${metaBg} | textura repintou=${thumb0 !== thumb1}`);

  // ---------- P12e: desenho (✍ → canvas → ✓) ----------
  await abrirModal();
  await page.locator('.note-rich-tool').filter({ hasText: '✍' }).click();
  const canvas = page.locator('.note-rich-canvas');
  const cvis = await canvas.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
  let desenhou = false;
  if (cvis) {
    const cb = await canvas.boundingBox();
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await page.mouse.down();
    for (let i = 0; i <= 10; i++) {
      await page.mouse.move(cb.x + cb.width / 2 + i * 8, cb.y + cb.height / 2 + i * 3);
    }
    await page.mouse.up();
    await sleep(200);
    await page.locator('.note-rich-draw-bar button').filter({ hasText: '✓' }).click();
    await sleep(200);
    desenhou = await editor.isVisible();
  }
  await fechar();
  const noteDrawing = await page.evaluate((id) => window.__bumptop.world.getObject(id)?.meta.noteDrawing ?? null, notaId);
  check('P12e', cvis && desenhou && typeof noteDrawing === 'string' && noteDrawing.startsWith('data:image/png'),
    `canvas=${cvis} | voltou ao editor=${desenhou} | meta.noteDrawing png=${typeof noteDrawing === 'string'}`);
  await page.screenshot({ path: `${OUT}/p12e-desenho.png` });

  // ---------- P12f: lembrete rápido (⏰ Amanhã) + disparo do agendador ----------
  await abrirModal();
  await page.locator('.note-rich-tool').filter({ hasText: '⏰' }).click();
  await sleep(200);
  const amanhaRow = page.locator('.note-rich-remind-row').filter({ hasText: 'Amanhã' });
  await amanhaRow.click();
  await sleep(300);
  const chip = await page.locator('.note-rich-remind-info').textContent();
  await fechar();
  const lembrete = await page.evaluate((id) => {
    const o = window.__bumptop.world.getObject(id);
    return { at: o?.meta.noteReminder ?? null, fired: o?.meta.noteReminderFired };
  }, notaId);
  const amanhaOk =
    lembrete.at !== null &&
    new Date(lembrete.at).getHours() === 8 &&
    lembrete.fired === false;
  // Lembrete vencido → o agendador (10 s) dispara: toast ⏰ + flag
  await page.evaluate((id) => {
    const w = window.__bumptop.world;
    w.setNoteMeta(id, { noteReminder: Date.now() - 2000 });
  }, notaId);
  const disparou = await page
    .waitForFunction(
      (id) => {
        const o = window.__bumptop.world.getObject(id);
        const toast = document.querySelector('.toast')?.textContent ?? '';
        return o?.meta.noteReminderFired === true && toast.includes('Lembrete');
      },
      notaId,
      { timeout: 25000 },
    )
    .then(() => true)
    .catch(() => false);
  check('P12f', amanhaOk && disparou && chip?.includes('⏰'),
    `amanhã 08:00=${amanhaOk} | chip='${chip}' | agendador disparou=${disparou}`);
  await page.screenshot({ path: `${OUT}/p12f-lembrete.png` });

  // ---------- P12g: nota antiga (texto puro) continua renderizando ----------
  const antigaId = await page.evaluate(() => {
    const w = window.__bumptop.world;
    return w.addStickyNote({ x: -40, y: 1.2, z: 40 }, 'nota antiga de texto simples');
  });
  ids.push(antigaId);
  await sleep(500);
  const antiga = await page.evaluate((id) => {
    const o = window.__bumptop.world.getObject(id);
    return { text: o?.meta.noteText, thumb: (o?.meta.thumb ?? '').startsWith('data:image/png') };
  }, antigaId);
  check('P12g', antiga.text === 'nota antiga de texto simples' && antiga.thumb,
    `noteText ok=${antiga.text === 'nota antiga de texto simples'} | face png=${antiga.thumb}`);

  // ---------- Cleanup ----------
  await cleanup();

  // ---------- P12h: zero erros de console ----------
  const filtrados = erros.filter((e) => !/opfs-sahpool|Access Handles|sqlite/i.test(e));
  check('P12h', filtrados.length === 0,
    `erros de console: ${filtrados.length}${filtrados.length ? ' | ' + filtrados.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR12: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
