/** Sonda PR17 — teclado no celular: editor da nota em folha tela-cheia:
 *
 *  P17a  meta viewport com interactive-widget=resizes-content (o viewport
 *        encolhe quando o teclado abre — Chrome/Android)
 *  P17b  desktop: modal CENTRALIZADO 90vh (comportamento preservado)
 *  P17c  mobile: modal OCUPA A TELA TODA (folha, estilo Keep) e a barra
 *        de ferramentas fica dentro da tela (logo acima do teclado)
 *  P17d  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr17.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr17-evidence';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`[${ok ? 'ok' : 'FALHOU'}] ${id} :: ${detail}`);
};

const abrirEditor = async (page) => {
  const notaId = await page.evaluate(() => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if (((o.meta?.noteText) || '').includes('NOTA P17')) w.removeObject(o.id);
    }
    return w.addStickyNote({ x: -18, y: 1.2, z: -18 }, 'NOTA P17 folha');
  });
  await sleep(400);
  const box = await page.locator('#scene-root canvas').boundingBox();
  const tela = await page.evaluate((oid) => {
    const pos = window.__bumptop.world.getObject(oid).pose.position;
    return window.__bumptop.renderer.projectToScreen(pos);
  }, notaId);
  await page.mouse.click(box.x + tela.x, box.y + tela.y);
  const modal = page.locator('[data-testid="note-rich"]');
  const abriu = await modal.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
  return { notaId, modal, abriu, box };
};

const browser = await chromium.launch();
try {
  const erros = [];

  // ---------- P17a: meta resizes-content ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
    page.on('pageerror', (e) => erros.push(String(e)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__bumptop, null, { timeout: 30000 });
    const meta = await page.evaluate(
      () => document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
    );
    check('P17a', meta.includes('interactive-widget=resizes-content'),
      `meta=${meta.includes('interactive-widget=resizes-content') ? 'com resizes-content' : meta}`);
    await ctx.close();
  }

  // ---------- P17b: desktop — modal centralizado (não tela toda) ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
    page.on('pageerror', (e) => erros.push(String(e)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const w = window.__bumptop?.world;
      return !!w && w.listObjects().length >= 3 && w.listObjects().every((o) => o.pose.position.y <= 2.2);
    }, null, { timeout: 20000 });
    const { notaId, modal, abriu } = await abrirEditor(page);
    if (abriu) {
      const mb = await modal.boundingBox();
      const vp = page.viewportSize();
      const centrado = mb.x > 10 && mb.y > 10 && mb.width < vp.width - 10 && mb.height < vp.height - 10;
      check('P17b', centrado,
        `modal centralizado=${centrado} (${Math.round(mb.width)}x${Math.round(mb.height)} em ${vp.width}x${vp.height})`);
      await page.screenshot({ path: `${OUT}/p17b-desktop.png` });
      await page.keyboard.press('Escape');
      await modal.waitFor({ state: 'detached', timeout: 4000 });
    } else check('P17b', false, 'editor não abriu');
    await page.evaluate((oid) => window.__bumptop.world.removeObject(oid), notaId);
    await ctx.close();
  }

  // ---------- P17c: mobile — folha tela-cheia + toolbar visível ----------
  {
    const ctx = await browser.newContext({
      viewport: { width: 412, height: 915 },
      hasTouch: true,
      isMobile: true,
      locale: 'pt-BR',
    });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
    page.on('pageerror', (e) => erros.push(String(e)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__bumptop, null, { timeout: 30000 });
    await sleep(1000);
    const { notaId, modal, abriu } = await abrirEditor(page);
    if (abriu) {
      const mb = await modal.boundingBox();
      const vp = page.viewportSize();
      const telaToda =
        mb.x <= 1 && mb.y <= 1 &&
        Math.abs(mb.width - vp.width) <= 2 &&
        Math.abs(mb.height - vp.height) <= 2;
      const tb = await page.locator('.note-rich-toolbar').boundingBox();
      const toolbarVisivel = tb.y + tb.height <= vp.height + 1;
      check('P17c', telaToda && toolbarVisivel,
        `folha tela-toda=${telaToda} (${Math.round(mb.width)}x${Math.round(mb.height)} em ${vp.width}x${vp.height}) | toolbar dentro da tela=${toolbarVisivel} (bottom ${Math.round(tb.y + tb.height)})`);
      await page.screenshot({ path: `${OUT}/p17c-mobile-folha.png` });
      await page.keyboard.press('Escape');
      await modal.waitFor({ state: 'detached', timeout: 4000 });
    } else check('P17c', false, 'editor não abriu');
    await page.evaluate((oid) => window.__bumptop.world.removeObject(oid), notaId);
    await ctx.close();
  }

  // ---------- P17d: zero erros de console ----------
  const filtrados = erros.filter((e) => !/opfs-sahpool|Access Handles|sqlite/i.test(e));
  check('P17d', filtrados.length === 0,
    `erros de console: ${filtrados.length}${filtrados.length ? ' | ' + filtrados.slice(0, 3).join(' || ') : ''}`);
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR17: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
