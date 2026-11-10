/** Sonda PR2 — item 5 (mover pilha em grupo):
 *  Seleção múltipla contendo uma pilha + itens soltos: arrastar move a pilha
 *  INTEIRA junto (sem "voltar" ao lugar antigo no release) e o clique simples
 *  sem seleção múltipla continua arrancando o item (pendingPull preservado).
 *
 * Checagens:
 *  P2a  setup: pilha de 3 + solto; seleção = membro da pilha + solto
 *  P2b  arraste em grupo → pilha + solto movem com o MESMO delta e pilha segue formada
 *  P2c  origem da pilha atualizada (centro acompanha o arrasto, não volta)
 *  P2d  clique simples sem seleção múltipla ainda arranca o item da pilha
 *  P2e  seleção de itens soltos NÃO sequestra o clique na pilha (arranca)
 *  P2f  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:5175 node scripts/validate-pr2.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:5175';
const OUT = 'test-results/pr2-evidence';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`[${ok ? 'ok' : 'FALHOU'}] ${id} :: ${detail}`);
};

/** Espera as poses do mundo ficarem estáveis por ≥500 ms (física assentou). */
async function esperarEstavel(page) {
  await page.waitForFunction(() => {
    const w = window.__bumptop?.world;
    if (!w) return false;
    const objs = w.listObjects();
    if (!objs.length) return false;
    const key = objs
      .map((o) => `${o.pose.position.x.toFixed(2)},${o.pose.position.y.toFixed(2)},${o.pose.position.z.toFixed(2)}`)
      .join('|');
    const now = Date.now();
    if (window.__settle?.key === key) return now - window.__settle.t >= 500;
    window.__settle = { key, t: now };
    return false;
  }, null, { timeout: 20000 });
  await sleep(400);
}

/** Abre o browser e espera a cena assentar. */
async function abrirCena(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listObjects, null, { timeout: 30000 });
  await esperarEstavel(page);
}

/**
 * Garante uma pilha de 3 (demo) + 2 soltos. A cena persiste entre cenários
 * (item 2), então desmancha pilhas restauradas antes de recriar.
 */
async function setup(page) {
  await page.evaluate(() => {
    const w = window.__bumptop.world;
    for (const o of w.toSnapshot().objects) if (w.inPile(o.id)) w.breakPile(o.id);
  });
  await esperarEstavel(page);
  const ids = await page.evaluate(() => {
    const w = window.__bumptop.world;
    const pile = w.toSnapshot().objects.slice(0, 3).map((o) => o.id);
    w.createPileFrom(pile);
    const solto1 = w.addBox({ x: 30, y: 1.6, z: 40 }, { x: 7, y: 1.6, z: 7 }, '#4f9cff', 'solto1.txt');
    const solto2 = w.addBox({ x: -30, y: 1.6, z: 40 }, { x: 7, y: 1.6, z: 7 }, '#9cff4f', 'solto2.txt');
    return { pile, solto1, solto2 };
  });
  await sleep(700); // soltos terminam de cair
  return ids;
}

/** Posição de tela de um objeto (canvas + offset do boundingBox). */
async function telaDe(page, id) {
  const s = await page.evaluate((oid) => {
    const pos = window.__bumptop.world.getObject(oid).pose.position;
    return window.__bumptop.renderer.projectToScreen(pos);
  }, id);
  const box = await page.locator('#scene-root canvas').boundingBox();
  return { x: box.x + s.x, y: box.y + s.y, visible: s.visible !== false };
}

/** Posições (x,z) dos ids, inPile de cada um e centro da pilha. */
function poses(page, ids, pileId) {
  return page.evaluate(({ ids, pileId }) => {
    const w = window.__bumptop.world;
    const out = { pos: {}, inPile: {}, center: null };
    for (const id of ids) {
      const p = w.getObject(id).pose.position;
      out.pos[id] = { x: p.x, z: p.z };
      out.inPile[id] = w.inPile(id);
    }
    const c = w.getPileCenter(pileId);
    out.center = c ? { x: c.x, z: c.z } : null;
    return out;
  }, { ids, pileId });
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));

  // ---------- Cenário 1: arraste em grupo com pilha ----------
  await abrirCena(page);
  const { pile, solto1 } = await setup(page);
  const [o0, o1, o2] = pile;

  // Seleciona um MEMBRO da pilha (não a base) + o solto
  await page.evaluate(({ o1, solto1 }) => {
    const w = window.__bumptop.world;
    w.select(o1);
    w.toggleSelect(solto1);
  }, { o1, solto1 });
  const sel = await page.evaluate(() => window.__bumptop.world.getSelectedIds());
  const ids = [...pile, solto1];
  const antes = await poses(page, ids, o0);
  const t = await telaDe(page, o1);
  check('P2a', sel.length === 2 && t.visible,
    `seleção=${sel.length} (membro da pilha + solto) | membro na tela=${t.visible}`);

  // Arrasta: down sobre a pilha, move +150/+80 px, espera a mola assentar, up
  await page.mouse.move(t.x, t.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(t.x + i * 15, t.y + i * 8);
    await sleep(30);
  }
  await sleep(2200); // mola amortecida converge (120+ frames)
  await page.mouse.up();
  await sleep(400);
  await page.screenshot({ path: `${OUT}/p2b-arraste-grupo.png` });

  const depois = await poses(page, ids, o0);
  const dSolto = { x: depois.pos[solto1].x - antes.pos[solto1].x, z: depois.pos[solto1].z - antes.pos[solto1].z };
  const movDist = Math.hypot(dSolto.x, dSolto.z);
  let maxDiff = 0;
  for (const id of pile) {
    const d = { x: depois.pos[id].x - antes.pos[id].x, z: depois.pos[id].z - antes.pos[id].z };
    maxDiff = Math.max(maxDiff, Math.hypot(d.x - dSolto.x, d.z - dSolto.z));
  }
  const formada = pile.every((id) => depois.inPile[id]);
  check('P2b', movDist > 10 && maxDiff < 2 && formada,
    `solto moveu ${movDist.toFixed(1)} u | máx divergência pilha vs solto=${maxDiff.toFixed(3)} u | pilha formada=${formada}`);

  // P2c — origem da pilha atualizada (centro acompanha; não "volta")
  const dCentro = { x: depois.center.x - antes.center.x, z: depois.center.z - antes.center.z };
  const diffCentro = Math.hypot(dCentro.x - dSolto.x, dCentro.z - dSolto.z);
  check('P2c', diffCentro < 2,
    `centro moveu (${dCentro.x.toFixed(1)}, ${dCentro.z.toFixed(1)}) vs solto (${dSolto.x.toFixed(1)}, ${dSolto.z.toFixed(1)}) | dif=${diffCentro.toFixed(3)}`);

  // ---------- Cenário 2: clique simples sem seleção múltipla arranca ----------
  await abrirCena(page);
  const s2 = await setup(page);
  const t0 = await telaDe(page, s2.pile[0]);
  await page.mouse.move(t0.x, t0.y);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(400);
  const arrancou = await page.evaluate((id) => !window.__bumptop.world.inPile(id), s2.pile[0]);
  check('P2d', arrancou, `clique simples (sem seleção) → item arrancado=${arrancou}`);
  await page.screenshot({ path: `${OUT}/p2d-clique-simples.png` });

  // ---------- Cenário 3: seleção de soltos não sequestra clique na pilha ----------
  await abrirCena(page);
  const s3 = await setup(page);
  await page.evaluate(({ solto1, solto2 }) => {
    const w = window.__bumptop.world;
    w.select(solto1);
    w.toggleSelect(solto2);
  }, s3);
  const sel3 = await page.evaluate(() => window.__bumptop.world.getSelectedIds());
  const t3 = await telaDe(page, s3.pile[0]);
  await page.mouse.move(t3.x, t3.y);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(400);
  const arrancou3 = await page.evaluate((id) => !window.__bumptop.world.inPile(id), s3.pile[0]);
  check('P2e', sel3.length === 2 && arrancou3,
    `seleção de ${sel3.length} soltos → clique na pilha ainda arranca=${arrancou3}`);

  check('P2f', erros.length === 0,
    `erros de console: ${erros.length}${erros.length ? ' | ' + erros.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR2: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
