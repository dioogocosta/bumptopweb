/** Sonda PR3 — item 4 (duplo-clique na parede → foco da câmera):
 *
 *  P3a  duplo-clique na parede norte → vista frontal (elev 0.45, dist 240, pivot y 14)
 *  P3b  duplo-clique na parede oeste → azimuth gira para π/2
 *  P3c  duplo-clique no chão vazio → câmera NÃO muda
 *  P3d  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:5175 node scripts/validate-pr3.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:5175';
const OUT = 'test-results/pr3-evidence';
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

/** Projeção na tela de um ponto do mundo (canvas + offset). */
async function telaDe(page, ponto) {
  const s = await page.evaluate((p) => window.__bumptop.renderer.projectToScreen(p), ponto);
  const box = await page.locator('#scene-root canvas').boundingBox();
  return { x: box.x + s.x, y: box.y + s.y, visible: s.visible !== false };
}

const camera = (page) => page.evaluate(() => window.__bumptop.world.getCamera());

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listObjects, null, { timeout: 30000 });
  await esperarEstavel(page);

  // P3a — duplo-clique na parede norte → vista frontal
  const tNorte = await telaDe(page, { x: 0, y: 10, z: -130 });
  check('P3a0', tNorte.visible, `ponto da parede norte projetado na tela=${tNorte.visible}`);
  await page.mouse.dblclick(tNorte.x, tNorte.y);
  await sleep(1600); // animação ~0.8 s
  const camN = await camera(page);
  const okN =
    Math.abs(camN.elevation - 0.45) < 0.05 &&
    Math.abs(camN.distance - 240) < 1 &&
    Math.abs(camN.target.y - 14) < 0.5 &&
    Math.abs(camN.azimuth - 0) < 0.05;
  check('P3a', okN,
    `norte → elev=${camN.elevation.toFixed(3)} (esp 0.45) | dist=${camN.distance.toFixed(1)} (esp 240) | pivot.y=${camN.target.y.toFixed(1)} (esp 14) | az=${camN.azimuth.toFixed(3)}`);
  await page.screenshot({ path: `${OUT}/p3a-parede-norte.png` });

  // P3b — duplo-clique na parede oeste → azimuth π/2
  const tOeste = await telaDe(page, { x: -130, y: 10, z: -60 });
  await page.mouse.dblclick(tOeste.x, tOeste.y);
  await sleep(1600);
  const camO = await camera(page);
  const okO = Math.abs(camO.azimuth - Math.PI / 2) < 0.05;
  check('P3b', tOeste.visible && okO,
    `oeste → az=${camO.azimuth.toFixed(3)} (esp ${'(π/2=' + (Math.PI / 2).toFixed(3) + ')'} | na tela=${tOeste.visible}`);
  await page.screenshot({ path: `${OUT}/p3b-parede-oeste.png` });

  // P3c — duplo-clique no chão vazio → câmera intacta
  const vazio = await page.evaluate(() => {
    const w = window.__bumptop.world;
    const r = window.__bumptop.renderer;
    const cand = [[80, -80], [-80, -80], [80, 80], [-80, 80], [0, -100], [100, 0], [-100, 0], [0, 100], [60, -20], [-60, 20]];
    for (const [x, z] of cand) {
      const pt = { x, y: 0, z };
      if (w.pickObjectAt(pt) !== null) continue;
      if (w.pickWall(pt) !== null) continue;
      const s = r.projectToScreen(pt);
      if (s.visible) return { x: s.x, y: s.y };
    }
    return null;
  });
  const camAntes = await camera(page);
  if (vazio) {
    const box = await page.locator('#scene-root canvas').boundingBox();
    await page.mouse.dblclick(box.x + vazio.x, box.y + vazio.y);
    await sleep(1000);
  }
  const camDepois = await camera(page);
  const mudou =
    camDepois.azimuth !== camAntes.azimuth ||
    camDepois.elevation !== camAntes.elevation ||
    camDepois.distance !== camAntes.distance ||
    camDepois.target.y !== camAntes.target.y;
  check('P3c', vazio !== null && !mudou,
    `chão vazio encontrado=${vazio !== null} | câmera mudou=${mudou}`);

  // P3d — zero erros de console
  check('P3d', erros.length === 0,
    `erros de console: ${erros.length}${erros.length ? ' | ' + erros.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR3: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
