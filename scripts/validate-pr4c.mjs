/**
 * Sonda PR4c — Tipos de caixa (Root/Kanban):
 *
 *  P4c-criar-root    criar caixa com tipo "root" → type='root' no core
 *  P4c-criar-kanban  criar caixa com tipo "kanban" → type='kanban' no core
 *  P4c-badge         painel mostra badge de tipo (Raiz/Kanban) no item
 *  P4c-select        select de tipo no cabeçalho do painel
 *  P4c-kanban-lane   nota na caixa kanban ganha meta.kanbanLane (0/1/2)
 *  P4c-root-dash     dashboard ROOT: setRoomDashboard chamado com stats
 *  P4c-reload        tipo persiste após reload
 *  P4c-console       zero erros de console
 *
 *  Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr4c.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr4c-evidence';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (id, detail) => { pass++; console.log(`[ok] ${id} :: ${detail}`); };
const check = (id, cond, detail) => {
  if (cond) ok(id, detail);
  else { fail++; console.log(`[FALHA] ${id} :: ${detail}`); }
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listBoxes, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const w = window.__bumptop?.world;
    return w.listObjects().length >= 3 && w.listObjects().every((o) => o.pose.position.y <= 2.2);
  }, { timeout: 20000 });

  // limpa caixas de execuções anteriores
  await page.evaluate(() => {
    const w = window.__bumptop.world;
    for (const b of w.listBoxes()) if (b.id !== 'box-default') w.removeBoxEntity(b.id);
    w.setCurrentBox('box-default');
  });
  await sleep(400);

  const abrir = async () => {
    if (await page.locator('.boxes-modal').isVisible()) return;
    await page.locator('.settings-btn').click();
    await sleep(300);
  };

  // ---------- P4c-select ----------
  await abrir();
  const temSelect = await page.locator('.boxes-type-sel').count();
  const opts = await page.locator('.boxes-type-sel option').allTextContents();
  check('P4c-select', temSelect === 1 && opts.length >= 3,
    `select=${temSelect} opções=[${opts.join(' | ')}]`);

  // ---------- P4c-criar-root ----------
  await page.locator('.boxes-type-sel').selectOption('root');
  await page.locator('.boxes-add').click();
  await sleep(400);
  const rootBox = await page.evaluate(() => {
    const w = window.__bumptop.world;
    const b = w.listBoxes().find((x) => x.type === 'root');
    return b ? { id: b.id, name: b.name, type: b.type } : null;
  });
  check('P4c-criar-root', !!rootBox && rootBox.type === 'root',
    `caixa root criada=${!!rootBox} type=${rootBox?.type}`);

  // ---------- P4c-criar-kanban ----------
  await page.locator('.boxes-type-sel').selectOption('kanban');
  await page.locator('.boxes-add').click();
  await sleep(400);
  const kanbanBox = await page.evaluate(() => {
    const w = window.__bumptop.world;
    const b = w.listBoxes().find((x) => x.type === 'kanban');
    return b ? { id: b.id, name: b.name, type: b.type } : null;
  });
  check('P4c-criar-kanban', !!kanbanBox && kanbanBox.type === 'kanban',
    `caixa kanban criada=${!!kanbanBox} type=${kanbanBox?.type}`);

  // ---------- P4c-badge ----------
  await abrir();
  const badges = await page.locator('.boxes-type-badge').allTextContents();
  check('P4c-badge', badges.some((b) => b.includes('Raiz')) && badges.some((b) => b.includes('Kanban')),
    `badges=[${badges.join(' | ')}]`);

  // ---------- P4c-kanban-lane ----------
  const lanes = await page.evaluate((kId) => {
    const w = window.__bumptop.world;
    w.setCurrentBox(kId);
    const esq = w.addStickyNote({ x: w.getBox(kId).pos.x - 100, y: 1.2, z: 0 }, 'e');
    const cen = w.addStickyNote({ x: w.getBox(kId).pos.x, y: 1.2, z: 0 }, 'c');
    const dir = w.addStickyNote({ x: w.getBox(kId).pos.x + 100, y: 1.2, z: 0 }, 'd');
    return {
      esq: w.getObject(esq).meta.kanbanLane,
      cen: w.getObject(cen).meta.kanbanLane,
      dir: w.getObject(dir).meta.kanbanLane,
    };
  }, kanbanBox.id);
  check('P4c-kanban-lane', lanes.esq === 0 && lanes.cen === 1 && lanes.dir === 2,
    `esq=${lanes.esq} cen=${lanes.cen} dir=${lanes.dir}`);

  // ---------- P4c-root-dash ----------
  const dash = await page.evaluate((rId) => {
    const w = window.__bumptop.world;
    w.setCurrentBox(rId);
    w.addStickyNote({ x: w.getBox(rId).pos.x + 10, y: 1.2, z: 0 }, 'n1');
    w.addStickyNote({ x: w.getBox(rId).pos.x + 20, y: 1.2, z: 10 }, 'n2');
    w.update(1 / 30);
    const r = window.__bumptop.renderer;
    // procura o dashboard no renderer (roomDashboards)
    const rooms = r.roomDashboards || new Map();
    const dash = rooms.get('room:' + Math.round(w.getBox(rId).pos.x) + '|' + Math.round(w.getBox(rId).pos.z));
    return dash ? { tem: true, itens: dash.canvas ? 1 : 0 } : { tem: false };
  }, rootBox.id);
  check('P4c-root-dash', dash.tem,
    `dashboard criado=${dash.tem}`);

  // ---------- P4c-reload ----------
  await sleep(3000); // flush de persistência
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listBoxes, null, { timeout: 30000 });
  await sleep(800);
  const persistiu = await page.evaluate(() => {
    const w = window.__bumptop.world;
    return {
      temRoot: w.listBoxes().some((b) => b.type === 'root'),
      temKanban: w.listBoxes().some((b) => b.type === 'kanban'),
      total: w.listBoxes().length,
    };
  });
  check('P4c-reload', persistiu.temRoot && persistiu.temKanban && persistiu.total >= 3,
    `após reload: root=${persistiu.temRoot} kanban=${persistiu.temKanban} total=${persistiu.total}`);

  // limpa caixas de teste
  await page.evaluate(() => {
    const w = window.__bumptop.world;
    for (const b of w.listBoxes()) if (b.id !== 'box-default') w.removeBoxEntity(b.id);
    w.setCurrentBox('box-default');
  });

  // ---------- P4c-console ----------
  const reais = erros.filter((t) =>
    !t.includes('favicon') && !t.includes('X-Frame') &&
    !t.includes('401') && !t.includes('Unauthorized') &&
    !/status of 400|status of 503|status of 404/.test(t));
  check('P4c-console', reais.length === 0, `erros de console: ${reais.length}`);

  await page.screenshot({ path: `${OUT}/pr4c-final.png` });
} catch (e) {
  fail++;
  console.log(`[ERRO] ${e?.message ?? e}`);
} finally {
  await browser.close();
}
console.log(`\n===== PR4c: ${pass}/${pass + fail} =====`);
process.exit(fail === 0 ? 0 : 1);
