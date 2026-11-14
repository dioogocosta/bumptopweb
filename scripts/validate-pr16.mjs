/** Sonda PR16 — colar com formatação + ícones de zoom em SVG:
 *
 *  P16a  botões de zoom usam ícones SVG (2 svg: alça + '+' / alça + '−')
 *  P16b  colar HTML estilo Google Keep preserva PARÁGRAFOS no modelo
 *        (meta.noteText com múltiplas linhas — não um blob de uma linha)
 *  P16c  negrito/itálico preservados como markdown-lite (** / *)
 *  P16d  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr16.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr16-evidence';
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

  // ---------- P16a: ícones SVG nos botões de zoom ----------
  const zoom = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.zoom-controls button')];
    return {
      total: btns.length,
      svgs: btns.filter((b) => b.querySelector('svg')).length,
      emojis: btns.filter((b) => /🔍/.test(b.textContent || '')).length,
    };
  });
  check('P16a', zoom.total >= 2 && zoom.svgs >= 2 && zoom.emojis === 0,
    `botões=${zoom.total} | com svg=${zoom.svgs} | com emoji=${zoom.emojis} (deve ser 0)`);
  await page.screenshot({ path: `${OUT}/p16a-icones-zoom.png`, clip: { x: 0, y: 0, width: 220, height: 60 } });

  // ---------- Nota de teste ----------
  const notaId = await page.evaluate(() => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if (((o.meta?.noteText) || '').includes('NOTA P16')) w.removeObject(o.id);
    }
    return w.addStickyNote({ x: 30, y: 1.2, z: -30 }, 'NOTA P16 original');
  });
  await sleep(400);
  const box = await page.locator('#scene-root canvas').boundingBox();
  const tela = await page.evaluate((oid) => {
    const pos = window.__bumptop.world.getObject(oid).pose.position;
    return window.__bumptop.renderer.projectToScreen(pos);
  }, notaId);

  // Abre o editor (clique na nota — PR14)
  await page.mouse.click(box.x + tela.x, box.y + tela.y);
  const modal = page.locator('[data-testid="note-rich"]');
  const abriu = await modal.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);

  // ---------- P16b/P16c: colar HTML estilo Google Keep ----------
  if (abriu) {
    await page.locator('.note-rich-content').click();
    await page.evaluate(() => {
      const ed = document.querySelector('.note-rich-content');
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(ed);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
      const dt = new DataTransfer();
      dt.setData(
        'text/html',
        '<b style="font-weight:600">linha um negrito</b><br>' +
          '<i>linha dois italico</i><div><br></div><div>terceiro paragrafo</div>',
      );
      dt.setData('text/plain', 'fallback texto plano');
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await sleep(250);
    await page.locator('.note-rich-done').click();
    await modal.waitFor({ state: 'detached', timeout: 4000 });
    await sleep(400);
    const salvo = await page.evaluate(
      (oid) => window.__bumptop.world.getObject(oid)?.meta.noteText ?? '',
      notaId,
    );
    const linhas = salvo.split('\n').length;
    check('P16b', linhas >= 4 && !salvo.includes('fallback'),
      `linhas no modelo=${linhas} (>=4; antes: 1 blob) | sem fallback=${!salvo.includes('fallback')}`);
    check('P16c', salvo.includes('**linha um negrito**') && salvo.includes('*linha dois italico*') && salvo.includes('\n\nterceiro paragrafo'),
      `negrito=${salvo.includes('**linha um negrito**')} | itálico=${salvo.includes('*linha dois italico*')} | parágrafo em branco=${salvo.includes('\n\nterceiro paragrafo')}`);
    await page.screenshot({ path: `${OUT}/p16c-nota-salva.png` });
  } else {
    check('P16b', false, 'editor rico não abriu');
    check('P16c', false, 'editor rico não abriu');
  }

  // Cleanup
  await page.evaluate((oid) => window.__bumptop.world.removeObject(oid), notaId);

  // ---------- P16d: zero erros de console ----------
  const filtrados = erros.filter((e) => !/opfs-sahpool|Access Handles|sqlite/i.test(e));
  check('P16d', filtrados.length === 0,
    `erros de console: ${filtrados.length}${filtrados.length ? ' | ' + filtrados.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR16: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
