/** Sonda PR18 — busca nas notas (botão 🔍 ao lado dos zooms):
 *
 *  P18a  botão de busca abre o campo (barra com input + ‹ n/m › + ✕)
 *  P18b  digitar filtra: destaque (.search-hl) SÓ nas notas que casam +
 *        contador "0/n"
 *  P18c  Enter vai para a 1ª nota: contador "1/n" + câmera aproxima
 *        (zoom in) e o alvo da câmera chega perto da nota
 *  P18d  setas navegam: › → próximo (2/n), ‹ → volta (1/n)
 *  P18e  ✕ fecha e limpa os destaques; zero erros de console
 *
 * Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr18.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr18-evidence';
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

  // 3 notas: 2 com o termo, 1 sem
  const [a, b] = await page.evaluate(() => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if (((o.meta?.noteText) || '').includes('P18BUSCA')) w.removeObject(o.id);
    }
    return [
      w.addStickyNote({ x: 20, y: 1.2, z: 20 }, 'P18BUSCA primeira nota'),
      w.addStickyNote({ x: -20, y: 1.2, z: -20 }, 'P18BUSCA segunda nota'),
      w.addStickyNote({ x: 0, y: 1.2, z: 35 }, 'nota qualquer sem o termo'),
    ];
  });
  await sleep(400);

  // ---------- P18a: botão abre o campo ----------
  const btnOk = (await page.locator('.zoom-controls .search-btn svg').count()) === 1;
  await page.locator('.search-btn').click();
  const barraOk = await page.locator('.search-bar').isVisible();
  check('P18a', btnOk && barraOk,
    `botão com svg=${btnOk} | barra visível=${barraOk}`);
  await page.screenshot({ path: `${OUT}/p18a-barra.png` });

  // ---------- P18b: filtra + destaques + contador ----------
  await page.locator('.search-input').fill('P18BUSCA');
  await sleep(600); // debounce 200 ms + frame
  const marcados = await page.locator('.search-hl').count();
  const contador = (await page.locator('.search-count').textContent())?.trim();
  check('P18b', marcados === 2 && contador === '0/2',
    `destaques=${marcados} (deve ser 2) | contador=${contador} (deve ser 0/2)`);
  await page.screenshot({ path: `${OUT}/p18b-destaques.png` });

  // ---------- P18c: Enter → voa para a 1ª nota ----------
  const cam0 = await page.evaluate(() => window.__bumptop.world.getCamera());
  await page.locator('.search-input').press('Enter');
  await sleep(1400); // animação ~0.9 s
  const cam1 = await page.evaluate(() => window.__bumptop.world.getCamera());
  const posA = await page.evaluate((oid) => window.__bumptop.world.getObject(oid).pose.position, a);
  const pertoA = Math.hypot(cam1.target.x - posA.x, cam1.target.z - posA.z) < 8;
  const contadorC = (await page.locator('.search-count').textContent())?.trim();
  check('P18c', contadorC === '1/2' && cam1.distance < cam0.distance * 0.75 && pertoA,
    `contador=${contadorC} | zoom in=${Math.round(cam0.distance)}→${Math.round(cam1.distance)} | alvo perto da nota=${pertoA}`);
  await page.screenshot({ path: `${OUT}/p18c-voou.png` });

  // ---------- P18d: setas navegam ----------
  await page.locator('.search-next').click();
  await sleep(1300);
  const cont2 = (await page.locator('.search-count').textContent())?.trim();
  const posB = await page.evaluate((oid) => window.__bumptop.world.getObject(oid).pose.position, b);
  const cam2 = await page.evaluate(() => window.__bumptop.world.getCamera());
  const pertoB = Math.hypot(cam2.target.x - posB.x, cam2.target.z - posB.z) < 8;
  await page.locator('.search-prev').click();
  await sleep(1300);
  const cont3 = (await page.locator('.search-count').textContent())?.trim();
  check('P18d', cont2 === '2/2' && pertoB && cont3 === '1/2',
    `› contador=${cont2} e voou p/ nota 2=${pertoB} | ‹ contador=${cont3}`);
  await page.screenshot({ path: `${OUT}/p18d-navegou.png` });

  // ---------- P18e: fecha e limpa ----------
  await page.locator('.search-close').click();
  await sleep(300);
  const marcadosFim = await page.locator('.search-hl').count();
  const stateOff = await page.evaluate(() => window.__bumptop.world.getSearchState() === null);
  check('P18e', marcadosFim === 0 && stateOff,
    `destaques após fechar=${marcadosFim} | busca encerrada=${stateOff}`);
  await page.evaluate((ids) => {
    const w = window.__bumptop.world;
    for (const id of ids) if (w.getObject(id)) w.removeObject(id);
  }, [a, b]);

  // ---------- console ----------
  const filtrados = erros.filter((e) => !/opfs-sahpool|Access Handles|sqlite/i.test(e));
  check('P18f', filtrados.length === 0,
    `erros de console: ${filtrados.length}${filtrados.length ? ' | ' + filtrados.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR18: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
