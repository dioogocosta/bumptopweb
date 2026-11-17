/** Sonda PR4a — Control Manager (engrenagem + painel de caixas):
 *
 *  P4a-botao   engrenagem na barra (SVG + título "Control Manager")
 *  P4a-abre    painel de vidro abre: título "Caixas" + lista com as pastas
 *  P4a-voo     clicar numa caixa fecha o painel e a câmera voa até ela
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
  await page.waitForFunction(() => window.__bumptop?.files?.createFolder, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const w = window.__bumptop?.world;
    return w.listObjects().length >= 3 && w.listObjects().every((o) => o.pose.position.y <= 2.2);
  }, { timeout: 20000 });

  // 2 caixas (pastas) para o painel listar (limpa as de execuções anteriores)
  const [c1, c2] = await page.evaluate(async () => {
    const f = window.__bumptop.files;
    for (const o of window.__bumptop.world.listObjects()) {
      if (o.meta?.isDir === true && (o.label === 'P4A Caixa Um' || o.label === 'P4A Caixa Dois')) {
        window.__bumptop.world.removeObject(o.id);
      }
    }
    const a = await f.createFolder('P4A Caixa Um', { x: 40, y: 1.6, z: -30 });
    const b = await f.createFolder('P4A Caixa Dois', { x: -40, y: 1.6, z: 30 });
    return [a, b];
  });
  await sleep(500);

  // ---------- P4a-botao ----------
  const svgOk = (await page.locator('.zoom-controls .settings-btn svg').count()) === 1;
  const title = await page.locator('.settings-btn').getAttribute('title');
  check('P4a-botao', svgOk && /Control Manager/.test(title ?? ''), `svg=true título="${title}"`);

  // ---------- P4a-abre ----------
  await page.locator('.settings-btn').click();
  await sleep(300);
  const visivel = await page.locator('.boxes-modal').isVisible();
  const tituloTxt = (await page.locator('.boxes-title').textContent()) ?? '';
  const itens = await page.locator('.boxes-item').count();
  const nomes = await page.locator('.boxes-item').allTextContents();
  check('P4a-abre', visivel && tituloTxt === 'Caixas' && itens === 2 &&
    nomes.includes('P4A Caixa Um') && nomes.includes('P4A Caixa Dois'),
    `painel=true título="${tituloTxt}" itens=${itens} [${nomes.join(' | ')}]`);

  // ---------- P4a-voo ----------
  const alvo = await page.evaluate((id) => window.__bumptop.world.getObject(id).pose.position, c1.id);
  await page.locator('.boxes-item', { hasText: 'P4A Caixa Um' }).click();
  await sleep(250);
  const fechou = !(await page.locator('.boxes-modal').isVisible());
  await sleep(1800); // animação de voo (0,9 s) + folga
  const cam = await page.evaluate(() => {
    const c = window.__bumptop.world.getCamera();
    return { x: c.target.x, z: c.target.z, d: c.distance };
  });
  const perto = Math.hypot(cam.x - alvo.x, cam.z - alvo.z) < 8;
  check('P4a-voo', fechou && perto && cam.d < 130,
    `painel fechou=${fechou} câmera perto da caixa=${perto} (${cam.x.toFixed(0)},${cam.z.toFixed(0)}) dist=${cam.d.toFixed(0)}`);

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
