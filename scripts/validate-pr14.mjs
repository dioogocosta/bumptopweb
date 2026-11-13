/** Sonda PR14 — clique na nota abre o EDITOR RICO (sem card escuro de leitura):
 *
 *  P14a  1 clique na nota abre o editor rico e NÃO o card escuro
 *        [data-testid=file-preview] (o "card preto" reportado)
 *  P14b  duplo-clique abre o editor e ele NÃO fecha sozinho (guard 350 ms
 *        no backdrop — o 2º clique do duplo-clique não fecha o modal)
 *  P14c  editar via clique simples persiste (Fechar → meta.noteText)
 *  P14d  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr14.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr14-evidence';
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

  const notaId = await page.evaluate(() => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if ((o.meta.noteText || '').includes('__p14__')) w.removeObject(o.id);
    }
    return w.addStickyNote({ x: 40, y: 1.2, z: -40 }, '__p14__ texto inicial');
  });
  ids.push(notaId);
  await sleep(300);
  const t = await telaDe(notaId);
  const px = box.x + t.x;
  const py = box.y + t.y;

  // ---------- P14a: 1 clique → editor rico (NÃO card escuro) ----------
  await page.mouse.click(px, py);
  const modal = page.locator('[data-testid="note-rich"]');
  const abriu = await modal.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
  const escuro = await page
    .locator('[data-testid="file-preview"]')
    .waitFor({ state: 'visible', timeout: 800 })
    .then(() => true)
    .catch(() => false);
  check('P14a', abriu && !escuro,
    `1 clique → editor rico=${abriu} | card escuro apareceu=${escuro} (deve ser false)`);
  await page.screenshot({ path: `${OUT}/p14a-clique-editor.png` });

  // ---------- P14b: duplo-clique não abre-e-fecha (guard no backdrop) ----------
  await page.keyboard.press('Escape'); // fecha o do P14a
  await modal.waitFor({ state: 'detached', timeout: 4000 });
  await sleep(300);
  await page.mouse.dblclick(px, py);
  const abriu2 = await modal.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
  await sleep(700); // o 2º clique do duplo-clique fecharia aqui se o guard falhasse
  const aindaAberto = await modal.isVisible();
  check('P14b', abriu2 && aindaAberto,
    `duplo-clique abriu=${abriu2} | continuou aberto após 700 ms=${aindaAberto}`);
  await page.screenshot({ path: `${OUT}/p14b-duplo-clique.png` });

  // ---------- P14c: editar via clique simples persiste ----------
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'detached', timeout: 4000 });
  await sleep(300);
  await page.mouse.click(px, py); // clique simples → editor
  await modal.waitFor({ state: 'visible', timeout: 4000 });
  const editor = page.locator('.note-rich-content');
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('texto editado pelo clique simples __p14__');
  await sleep(300);
  await page.locator('.note-rich-done').click();
  await modal.waitFor({ state: 'detached', timeout: 4000 });
  await sleep(500);
  const salvo = await page.evaluate((id) => window.__bumptop.world.getObject(id)?.meta.noteText ?? '', notaId);
  check('P14c', salvo.includes('texto editado pelo clique simples'),
    `meta.noteText='${salvo.slice(0, 50)}…'`);

  // ---------- Cleanup ----------
  await cleanup();

  // ---------- P14d: zero erros de console ----------
  const filtrados = erros.filter((e) => !/opfs-sahpool|Access Handles|sqlite/i.test(e));
  check('P14d', filtrados.length === 0,
    `erros de console: ${filtrados.length}${filtrados.length ? ' | ' + filtrados.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR14: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
