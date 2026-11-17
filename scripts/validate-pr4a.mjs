/** Sonda PR4a — Control Manager (engrenagem + painel de CAIXAS):
 *
 *  P4a-botao   engrenagem na barra (SVG + título "Control Manager")
 *  P4a-abre    painel de vidro abre: "Caixa Comum" (ativa) + caixa criada
 *  P4a-entra   clicar numa caixa fecha o painel, vira a ATIVA e voa até ela;
 *              nota nova nasce DENTRO dela (meta.boxId + posição clampada)
 *  P4a-esc     Esc fecha o painel
 *  P4a-fundo   clique no fundo (fora do card) fecha
 *  P4a-console zero erros de console
 *
 *  Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr4a.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr4a-evidence';
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

  // Caixa nova ao lado da original (o CRUD pela UI entra no 4.2)
  const box2 = await page.evaluate(() => {
    const w = window.__bumptop.world;
    // limpa execução anterior (mundo persiste entre reloads no preview)
    for (const b of w.listBoxes()) {
      if (b.name === 'P4A Caixa Dois') w.removeObjectSafe?.(b.id);
    }
    w.setCurrentBox('box-default');
    return w.addBoxEntity('P4A Caixa Dois', { x: 400, z: 0 });
  });
  await page.evaluate(() => window.__bumptop.world.setCurrentBox('box-default'));
  await sleep(400);

  // ---------- P4a-botao ----------
  const svgOk = (await page.locator('.zoom-controls .settings-btn svg').count()) === 1;
  const title = await page.locator('.settings-btn').getAttribute('title');
  check('P4a-botao', svgOk && /Control Manager/.test(title ?? ''), `svg=true título="${title}"`);

  // ---------- P4a-abre ----------
  await page.locator('.settings-btn').click();
  await sleep(300);
  const visivel = await page.locator('.boxes-modal').isVisible();
  const tituloTxt = (await page.locator('.boxes-title').textContent()) ?? '';
  const nomes = await page.locator('.boxes-item').allTextContents();
  const comumOk = nomes.includes('Caixa Comum') && nomes.includes('P4A Caixa Dois');
  const curOk = (await page.locator('.boxes-item.cur').textContent())?.includes('Caixa Comum') ?? false;
  check('P4a-abre', visivel && tituloTxt === 'Caixas' && comumOk && curOk,
    `painel=true título="${tituloTxt}" caixas=[${nomes.join(' | ')}] ativa="Caixa Comum"=${curOk}`);

  // ---------- P4a-entra ----------
  await page.locator('.boxes-item', { hasText: 'P4A Caixa Dois' }).click();
  await sleep(250);
  const fechou = !(await page.locator('.boxes-modal').isVisible());
  await sleep(1800); // animação de voo (0,9 s) + folga
  const estado = await page.evaluate((id) => {
    const w = window.__bumptop.world;
    const cam = w.getCamera();
    const nota = w.addStickyNote({ x: 400 + 500, y: 1.2, z: 0 }, 'P4ADENTRO');
    const p = w.getObject(nota).pose.position;
    return {
      ativa: w.getCurrentBoxId() === id,
      camX: cam.target.x,
      camZ: cam.target.z,
      boxId: w.getObject(nota).meta.boxId === id,
      dentro: Math.abs(p.x - 400) <= 124 && Math.abs(p.z) <= 124,
      notaId: nota,
    };
  }, box2.id);
  await page.evaluate((id) => window.__bumptop.world.removeObject(id), estado.notaId);
  const perto = Math.hypot(estado.camX - 400, estado.camZ - 0) < 12;
  check('P4a-entra', fechou && estado.ativa && perto && estado.boxId && estado.dentro,
    `painel fechou=${fechou} virou ativa=${estado.ativa} câmera perto=${perto} nota nasce nela=${estado.boxId} posição dentro=${estado.dentro}`);

  // ---------- P4a-esc ----------
  await page.locator('.settings-btn').click();
  await sleep(250);
  await page.keyboard.press('Escape');
  await sleep(200);
  check('P4a-esc', !(await page.locator('.boxes-modal').isVisible()), 'Esc fechou o painel');

  // ---------- P4a-fundo ----------
  await page.locator('.settings-btn').click();
  await sleep(250);
  await page.mouse.click(60, 300); // fora do card (centro ~720,450)
  await sleep(200);
  check('P4a-fundo', !(await page.locator('.boxes-modal').isVisible()), 'clique no fundo fechou');

  // ---------- P4a-console ----------
  const reais = erros.filter((t) =>
    !t.includes('favicon') && !t.includes('X-Frame') &&
    !t.includes('401') && !t.includes('Unauthorized') &&
    !/status of 400|status of 503|status of 404/.test(t));
  check('P4a-console', reais.length === 0, `erros de console: ${reais.length}`);

  await page.screenshot({ path: `${OUT}/pr4a-final.png` });
} catch (e) {
  fail++;
  console.log(`[ERRO] ${e?.message ?? e}`);
} finally {
  await browser.close();
}
console.log(`\n===== PR4a: ${pass}/${pass + fail} =====`);
process.exit(fail === 0 ? 0 : 1);
