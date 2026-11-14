/** Sonda PR15 — Modo Laço no TOQUE (seleção múltipla mobile):
 *
 *  P15a  botão ⬭ (zoom-controls) liga o modo laço (isLassoMode + .sel)
 *  P15b  arrasto touch no chão vazio desenha o laço (.lasso-rect) e
 *        seleciona vários objetos (getSelectedIds)
 *  P15c  toque PARADO no chão desliga o modo (botão perde .sel)
 *  P15d  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr15.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr15-evidence';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`[${ok ? 'ok' : 'FALHOU'}] ${id} :: ${detail}`);
};

const browser = await chromium.launch();
try {
  // Contexto mobile: viewport estreita + touch (Pixel-ish)
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    hasTouch: true,
    isMobile: true,
    locale: 'pt-BR',
  });
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listObjects, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  const box = await page.locator('#scene-root canvas').boundingBox();

  // Dois objetos perto do centro para o laço englobar
  const ids = await page.evaluate(() => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if ((o.name || '').startsWith('p15')) w.removeObject(o.id);
    }
    return [
      w.addBox({ x: -18, y: 1.6, z: -18 }, { x: 6, y: 1.6, z: 6 }, '#fff', 'p15a.txt'),
      w.addBox({ x: 18, y: 1.6, z: 14 }, { x: 6, y: 1.6, z: 6 }, '#fff', 'p15b.txt'),
    ];
  });
  await sleep(400);

  const dispatchTouch = (pg, id, type, x, y) =>
    pg.evaluate(({ i, t, x: cx, y: cy }) => {
      const canvas = document.querySelector('#scene-root canvas');
      canvas.dispatchEvent(new PointerEvent(t, {
        pointerId: i, pointerType: 'touch', isPrimary: true,
        clientX: cx, clientY: cy, bubbles: true,
      }));
    }, { i: id, t: type, x, y });

  // ---------- P15a: botão ⬭ liga o modo ----------
  await page.locator('.lasso-btn').click();
  await sleep(200);
  const btnSel = await page.locator('.lasso-btn.sel').count();
  const modo = await page.evaluate(() => window.__bumptop.world.isLassoMode());
  check('P15a', btnSel === 1 && modo,
    `botão .sel=${btnSel === 1} | isLassoMode=${modo}`);
  await page.screenshot({ path: `${OUT}/p15a-modo-ligado.png` });

  // ---------- P15b: arrasto touch no chão vazio desenha o laço ----------
  const inicio = { x: box.x + 12, y: box.y + box.height - 12 };
  const fim = { x: box.x + box.width - 12, y: box.y + 12 };
  await dispatchTouch(page, 31, 'pointerdown', inicio.x, inicio.y);
  await dispatchTouch(page, 31, 'pointermove',
    inicio.x + (fim.x - inicio.x) * 0.4, inicio.y + (fim.y - inicio.y) * 0.4);
  await sleep(150);
  const rectVisivel = await page.locator('.lasso-rect').isVisible();
  await page.screenshot({ path: `${OUT}/p15b-lasso-desenhando.png` });
  await dispatchTouch(page, 31, 'pointermove', fim.x, fim.y);
  await dispatchTouch(page, 31, 'pointerup', fim.x, fim.y);
  await sleep(300);
  const sel = await page.evaluate(() => window.__bumptop.world.getSelectedIds());
  const ambos = sel.includes(ids[0]) && sel.includes(ids[1]);
  check('P15b', rectVisivel && ambos,
    `.lasso-rect visível=${rectVisivel} | selecionados=${sel.length} | a+b contidos=${ambos}`);

  // ---------- P15c: toque PARADO no chão desliga o modo ----------
  // (limpa os objetos p/ o toque cair no chão VAZIO)
  await page.evaluate((list) => {
    const w = window.__bumptop.world;
    for (const id of list) if (w.getObject(id)) w.removeObject(id);
  }, ids);
  await sleep(300);
  await dispatchTouch(page, 32, 'pointerdown', box.x + 20, box.y + box.height - 20);
  await dispatchTouch(page, 32, 'pointerup', box.x + 22, box.y + box.height - 19);
  await sleep(250);
  const modo2 = await page.evaluate(() => window.__bumptop.world.isLassoMode());
  const btnSel2 = await page.locator('.lasso-btn.sel').count();
  check('P15c', !modo2 && btnSel2 === 0,
    `isLassoMode=${modo2} (deve ser false) | botão .sel=${btnSel2} (deve ser 0)`);
  await page.screenshot({ path: `${OUT}/p15c-modo-desligado.png` });

  // ---------- P15d: zero erros de console ----------
  const filtrados = erros.filter((e) => !/opfs-sahpool|Access Handles|sqlite/i.test(e));
  check('P15d', filtrados.length === 0,
    `erros de console: ${filtrados.length}${filtrados.length ? ' | ' + filtrados.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR15: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
