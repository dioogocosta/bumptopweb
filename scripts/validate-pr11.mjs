/** Sonda PR11 — zoom da câmera + pregar em qualquer parede + handle de
 *  rotação (endireitar/girar) + arrastar item de pilha aberta:
 *
 *  P11a  zoom da câmera: PageUp/PageDown aproximam/afastam e os botões
 *        🔍+/🔍− do topo-esquerda fazem o mesmo (distância muda de verdade)
 *  P11b  arrastar um item do chão até as paredes OESTE (2) e LESTE (3)
 *        prega automaticamente em cada uma (autoWallPin default ON)
 *  P11c  ícone ↻ no canto do bbox: clique parado ENDIREITA o objeto
 *        (rotação → identidade) e arrastar horizontalmente GIRA em Y
 *  P11d  pilha ABERTA em grade: arrastar um item o PUXA da pilha e move;
 *        o restante continua na pilha
 *  P11e  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr11.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr11-evidence';
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
  const limpaP11 = () =>
    page.evaluate(() => {
      const w = window.__bumptop.world;
      for (const o of w.listObjects()) {
        if ((o.label || '').includes('__p11_')) w.removeObject(o.id);
      }
    });

  await limpaP11();

  // ---------- P11a: zoom da câmera (teclado + botões) ----------
  const d0 = await page.evaluate(() => window.__bumptop.world.getCamera().distance);
  await page.keyboard.press('PageDown'); // afastar
  await sleep(300);
  const dAfas = await page.evaluate(() => window.__bumptop.world.getCamera().distance);
  await page.keyboard.press('PageUp'); // aproximar
  await sleep(300);
  const dAprox = await page.evaluate(() => window.__bumptop.world.getCamera().distance);
  const tecladoOk = dAfas > d0 * 1.03 && dAprox < dAfas * 0.97;
  // Botões 🔍+ (aproxima) e 🔍− (afasta)
  await page.locator('.zoom-controls button').first().click();
  await sleep(300);
  const dBtnIn = await page.evaluate(() => window.__bumptop.world.getCamera().distance);
  await page.locator('.zoom-controls button').nth(1).click();
  await sleep(300);
  const dBtnOut = await page.evaluate(() => window.__bumptop.world.getCamera().distance);
  const botoesOk = dBtnIn < dBtnOut * 0.97 && dBtnOut > dBtnIn * 1.03;
  check('P11a', tecladoOk && botoesOk,
    `teclado: ${d0.toFixed(0)}→PageDown ${dAfas.toFixed(0)}→PageUp ${dAprox.toFixed(0)} | ` +
    `botões: 🔍+ ${dBtnIn.toFixed(0)} < 🔍− ${dBtnOut.toFixed(0)}`);
  await page.screenshot({ path: `${OUT}/p11a-zoom-controles.png` });

  // ---------- P11b: pregar nas paredes OESTE (2) e LESTE (3) ----------
  async function pregaParede(x0, z0, alvo, parede) {
    const id = await page.evaluate(({ x0, z0 }) => {
      const w = window.__bumptop.world;
      return w.addBox({ x: x0, y: 1.7, z: z0 }, { x: 7, y: 1.6, z: 7 }, '#4f9cff', '__p11_parede__');
    }, { x0, z0 });
    await sleep(250);
    const tItem = await telaDe(id);
    const tAlvo = await page.evaluate((a) => window.__bumptop.renderer.projectToScreen(a), alvo);
    await page.mouse.move(box.x + tItem.x, box.y + tItem.y);
    await page.mouse.down();
    await page.mouse.move(box.x + tAlvo.x, box.y + tAlvo.y, { steps: 14 });
    await sleep(300);
    await page.mouse.up();
    await sleep(400);
    const pin = await page.evaluate((oid) => window.__bumptop.world.getObject(oid)?.pinnedWall ?? null, id);
    return { id, pin, parede };
  }
  const oeste = await pregaParede(0, -30, { x: -128, y: 1.7, z: -30 }, 2);
  const leste = await pregaParede(0, 30, { x: 128, y: 1.7, z: 30 }, 3);
  check('P11b', oeste.pin === 2 && leste.pin === 3,
    `parede oeste pin=${oeste.pin} (esperado 2) | parede leste pin=${leste.pin} (esperado 3)`);
  await page.screenshot({ path: `${OUT}/p11b-paredes.png` });

  // ---------- P11c: handle de rotação (endireitar + girar) ----------
  const rotId = await page.evaluate(() => {
    const w = window.__bumptop.world;
    return w.addBox({ x: -30, y: 1.7, z: -30 }, { x: 7, y: 1.6, z: 7 }, '#ffdd55', '__p11_rot__');
  });
  await sleep(250);
  // Clica no item para selecionar
  const tRot = await telaDe(rotId);
  await page.mouse.click(box.x + tRot.x, box.y + tRot.y);
  await sleep(400);
  const handle = page.locator('.rotate-handle');
  const handleVisivel = await handle.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
  // Aplica uma rotação inicial ≠ 0 (seleção já ativa)
  const rot0 = await page.evaluate((oid) => {
    const w = window.__bumptop.world;
    w.rotateSelection(1.2, [oid]);
    return w.getObject(oid).pose.rotation;
  }, rotId);
  await sleep(250);
  // Clique PARADO no ↻ → endireita (identidade)
  let endireitou = false;
  if (handleVisivel) {
    await handle.click();
    await sleep(400);
    const r1 = await page.evaluate((oid) => window.__bumptop.world.getObject(oid).pose.rotation, rotId);
    endireitou = Math.abs(r1.y) < 0.02 && Math.abs(r1.w - 1) < 0.02;
  }
  // Arrastar o ↻ na horizontal → gira em Y (antes do arrasto está reto)
  let girou = false;
  if (handleVisivel) {
    const rotAntes = await page.evaluate((oid) => window.__bumptop.world.getObject(oid).pose.rotation, rotId);
    const hb = await handle.boundingBox();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 120, hb.y + hb.height / 2, { steps: 8 });
    await page.mouse.up();
    await sleep(300);
    const r2 = await page.evaluate((oid) => window.__bumptop.world.getObject(oid).pose.rotation, rotId);
    girou = Math.abs(r2.y) > 0.05 && Math.abs(r2.w - 1) > 0.01;
  }
  check('P11c', handleVisivel && endireitou && girou,
    `handle visível=${handleVisivel} | clique endireitou=${endireitou} (rot0.y=${rot0.y?.toFixed(2)}) | arrasto girou=${girou}`);
  await page.screenshot({ path: `${OUT}/p11c-rotate-handle.png` });

  // ---------- P11d: pilha aberta — arrastar item puxa da pilha ----------
  const pile = await page.evaluate(() => {
    const w = window.__bumptop.world;
    const ids = [
      w.addBox({ x: 40, y: 1.7, z: 40 }, { x: 7, y: 1.6, z: 7 }, '#66cc88', '__p11_p1__'),
      w.addBox({ x: 42, y: 1.7, z: 42 }, { x: 7, y: 1.6, z: 7 }, '#66cc88', '__p11_p2__'),
      w.addBox({ x: 44, y: 1.7, z: 44 }, { x: 7, y: 1.6, z: 7 }, '#66cc88', '__p11_p3__'),
    ];
    const base = w.createPileFrom(ids);
    return { ids, base };
  });
  await sleep(400);
  const abriu = await page.evaluate((base) => window.__bumptop.world.openPileGrid(base), pile.base);
  await sleep(600);
  const estado0 = await page.evaluate(({ ids, base }) => {
    const w = window.__bumptop.world;
    return {
      membros: ids.map((id) => w.inPile(id)),
      pilhaAberta: ids.every((id) => w.isPileOpen(id)),
    };
  }, pile);
  // Arrasta o 1º item da grade para longe
  const tP1 = await telaDe(pile.ids[0]);
  const tDrop = await page.evaluate(() => window.__bumptop.renderer.projectToScreen({ x: -40, y: 1.7, z: -40 }));
  await page.mouse.move(box.x + tP1.x, box.y + tP1.y);
  await page.mouse.down();
  await page.mouse.move(box.x + tDrop.x, box.y + tDrop.y, { steps: 12 });
  await sleep(300);
  await page.mouse.up();
  await sleep(500);
  const estado1 = await page.evaluate(({ ids, base }) => {
    const w = window.__bumptop.world;
    return {
      puxado: !w.inPile(ids[0]),
      outrosNaPilha: w.inPile(ids[1]) && w.inPile(ids[2]),
      pos: w.getObject(ids[0]).pose.position,
    };
  }, pile);
  const moveu = Math.hypot(estado1.pos.x - 40, estado1.pos.z - 40) > 10;
  check('P11d', abriu && estado0.pilhaAberta && estado1.puxado && estado1.outrosNaPilha && moveu,
    `abriu grade=${abriu} | pilhaAberta=${estado0.pilhaAberta} | puxou 1º=${estado1.puxado} | ` +
    `restantes na pilha=${estado1.outrosNaPilha} | moveu=${moveu} (Δ=${Math.hypot(estado1.pos.x - 40, estado1.pos.z - 40).toFixed(0)})`);
  await page.screenshot({ path: `${OUT}/p11d-pilha-aberta.png` });

  // ---------- Cleanup ----------
  await page.evaluate(() => {
    const w = window.__bumptop.world;
    w.closeOpenPile();
    for (const o of w.listObjects()) {
      if ((o.label || '').includes('__p11_')) w.removeObject(o.id);
    }
  });
  await sleep(300);

  // ---------- P11e: zero erros de console ----------
  const filtrados = erros.filter((e) => !/opfs-sahpool|Access Handles|sqlite/i.test(e));
  check('P11e', filtrados.length === 0,
    `erros de console: ${filtrados.length}${filtrados.length ? ' | ' + filtrados.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR11: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
