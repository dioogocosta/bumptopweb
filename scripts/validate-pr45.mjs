/** Sonda PR45 — Backlog (Taiga) no Control Manager:
 *
 *  P45-campo     tipo "Backlog (Taiga)" mostra o campo slug + datalist de projetos públicos
 *  P45-sem-slug  criar backlog SEM slug → aviso "sem projeto configurado" (não quebra)
 *  P45-criar     criar com slug → caixa backlog com `taigaProject` salvo
 *  P45-stories   user stories viram itens 3D (meta.taigaStoryId, rótulo "#ref …") + taigaStats
 *  P45-dashboard painel da parede criado para a caixa backlog (roomDashboards)
 *  P45-entrar    sair e voltar → resync NÃO duplica itens (mesma contagem)
 *  P45-reload    F5 → caixa backlog + slug + stats + itens persistem
 *  P45-console   zero erros de console
 *
 *  Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr45.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr45-evidence';
const SLUG = 'otimizacao-de-portfolio-de-sistemas-fnde';
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
  page.setDefaultNavigationTimeout(60000);
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));

  // PR44 tornou o prédio a primeira tela — `?nobuilding=1` abre direto na
  // caixa (o próprio PR44 usa esse param) p/ testar o fluxo do backlog.
  await page.goto(`${BASE}/?nobuilding=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listBoxes, null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const w = window.__bumptop?.world;
    return w.listObjects().length >= 3 && w.listObjects().every((o) => o.pose.position.y <= 2.2);
  }, { timeout: 20000 });

  const abrir = async () => {
    if (await page.locator('.boxes-modal').isVisible()) return;
    await page.locator('.settings-btn').click();
    await sleep(300);
  };
  const backlogBox = () => page.evaluate(() =>
    window.__bumptop.world.listBoxes().find((b) => b.type === 'backlog') ?? null);
  const contarStories = (id) => page.evaluate((bid) =>
    window.__bumptop.world.listObjects().filter((o) => o.meta?.boxId === bid && o.meta?.taigaStoryId !== undefined).length, id);

  // ---------- P45-campo ----------
  await abrir();
  await page.locator('.boxes-type-sel').selectOption('backlog');
  await sleep(300);
  const campoVisivel = await page.locator('.boxes-project').isVisible();
  // datalist carrega os projetos públicos do Taiga (rede; até 15s)
  let qtdProjetos = 0;
  for (let i = 0; i < 30 && qtdProjetos === 0; i++) {
    qtdProjetos = await page.locator('#boxes-projects-dl option').count();
    if (qtdProjetos === 0) await sleep(500);
  }
  check('P45-campo', campoVisivel && qtdProjetos > 0,
    `campo slug visível=${campoVisivel} | projetos públicos no datalist=${qtdProjetos}`);

  // ---------- P45-sem-slug ----------
  await page.locator('.boxes-type-sel').selectOption('backlog');
  await page.locator('.boxes-add').click();
  // o toast nasce ~300-500ms após o clique — espera aparecer (vive 2600ms)
  let aviso = '';
  for (let i = 0; i < 15 && !aviso.includes('projeto Taiga'); i++) {
    aviso = (await page.locator('.toast').allTextContents().catch(() => [])).join(' | ');
    if (!aviso.includes('projeto Taiga')) await sleep(300);
  }
  const boxSemSlug = await backlogBox();
  check('P45-sem-slug', !!boxSemSlug && !boxSemSlug.taigaProject && aviso.includes('projeto Taiga'),
    `caixa criada sem slug=${!!boxSemSlug} | toast="${aviso.trim()}"`);
  // remove a caixa de teste (confirmação)
  if (boxSemSlug) {
    await page.locator('.boxes-item', { hasText: 'Caixa 1' }).locator('.boxes-act-del').click();
    await page.locator('.boxes-yes').click();
    await sleep(400);
  }

  // ---------- P45-criar ----------
  await page.locator('.boxes-type-sel').selectOption('backlog');
  await page.locator('.boxes-project').fill(SLUG);
  await page.locator('.boxes-add').click();
  let box = null;
  for (let i = 0; i < 20 && !box; i++) { box = await backlogBox(); if (!box) await sleep(300); }
  check('P45-criar', !!box && box.taigaProject === SLUG,
    `caixa backlog=${!!box} | taigaProject="${box?.taigaProject}"`);
  await page.locator('.boxes-modal').press('Escape');
  await sleep(300);

  // ---------- P45-stories ----------
  let nStories = 0;
  for (let i = 0; i < 40 && nStories === 0; i++) { // fetch remoto + criação
    if (box) nStories = await contarStories(box.id);
    if (nStories === 0) await sleep(500);
  }
  const detalhes = await page.evaluate((bid) => {
    const w = window.__bumptop.world;
    const b = w.getBox(bid);
    const itens = w.listObjects().filter((o) => o.meta?.boxId === bid && o.meta?.taigaStoryId !== undefined);
    const soma = (b.taigaStats ?? []).reduce((a, s) => a + s.count, 0);
    return {
      stats: (b.taigaStats ?? []).map((s) => `${s.name}=${s.count}`).join(','),
      soma,
      rotulo: itens[0]?.label ?? '',
      comCor: itens.every((o) => typeof o.meta?.color === 'string'),
    };
  }, box?.id);
  check('P45-stories', nStories > 0 && detalhes.soma === nStories && detalhes.rotulo.startsWith('#'),
    `itens 3D=${nStories} | soma stats=${detalhes.soma} | stats=[${detalhes.stats}] | 1º rótulo="${detalhes.rotulo}"`);

  // ---------- P45-dashboard ----------
  const dash = await page.evaluate(() => {
    const r = window.__bumptop.renderer;
    return { tem: !!r.roomDashboards && r.roomDashboards.size > 0, n: r.roomDashboards?.size ?? 0 };
  });
  check('P45-dashboard', dash.tem, `painéis de parede criados=${dash.n}`);

  // ---------- P45-entrar (resync sem duplicar) ----------
  const antes = nStories;
  await abrir();
  await page.locator('.boxes-item', { hasText: box.name }).locator('.boxes-item-name')
    .click({ timeout: 60000 });
  // captura o toast de resync em tempo real (eles vivem só 2600ms)
  let toastResync = '';
  for (let i = 0; i < 20 && !toastResync.includes('sincronizado'); i++) {
    toastResync = (await page.locator('.toast').allTextContents().catch(() => [])).join(' | ');
    if (!toastResync.includes('sincronizado')) await sleep(300);
  }
  await sleep(1500); // troca de itens termina
  const depois = await contarStories(box.id);
  check('P45-entrar', depois === antes && toastResync.includes('sincronizado'),
    `antes=${antes} depois=${depois} (sem duplicar=${depois === antes}) | toast="${toastResync.trim()}"`);

  // ---------- P45-reload (persistência; cuidado com o bug OPFS: Esc + 10s) ----------
  if (await page.locator('.boxes-modal').isVisible()) await page.locator('.boxes-modal').press('Escape');
  await sleep(10000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listBoxes, null, { timeout: 30000 });
  await sleep(1500);
  const posReload = await page.evaluate((slug) => {
    const w = window.__bumptop.world;
    const b = w.listBoxes().find((x) => x.type === 'backlog');
    if (!b) return { tem: false };
    const itens = w.listObjects().filter((o) => o.meta?.boxId === b.id && o.meta?.taigaStoryId !== undefined).length;
    return {
      tem: true, slug: b.taigaProject, stats: (b.taigaStats ?? []).length, itens,
      nome: b.name,
    };
  }, SLUG);
  check('P45-reload', posReload.tem && posReload.slug === SLUG && posReload.stats > 0 && posReload.itens > 0,
    `após F5: caixa=${posReload.tem} slug="${posReload.slug}" stats=${posReload.stats} itens=${posReload.itens}`);

  // ---------- P45-console ----------
  const reais = erros.filter((t) =>
    !t.includes('favicon') && !t.includes('X-Frame') &&
    !t.includes('401') && !t.includes('Unauthorized') &&
    !/status of 400|status of 503|status of 404/.test(t));
  check('P45-console', reais.length === 0, `erros de console: ${reais.length} ${reais.slice(0, 2).join(' | ')}`);

  await page.screenshot({ path: `${OUT}/pr45-final.png` });
} catch (e) {
  fail++;
  console.log(`[ERRO] ${e?.message ?? e}`);
} finally {
  await browser.close();
}
console.log(`\n===== PR45: ${pass}/${pass + fail} =====`);
process.exit(fail === 0 ? 0 : 1);
