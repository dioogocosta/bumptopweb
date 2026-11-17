/** Sonda PR4b — CRUD de caixas no Control Manager:
 *
 *  P4b-criar    botão "+ Nova caixa" cria "Caixa 1" (vira ativa, painel reabre)
 *  P4b-renomear ✏️ inline: renomeia para "Projetos" (Enter confirma)
 *  P4b-buscar   campo de pesquisa filtra por nome; limpar volta tudo
 *  P4b-entrar   clicar na caixa renomeada: ativa + câmera voa + nota nasce nela
 *  P4b-excluir  🗑 com confirmação: caixa sai, itens voltam p/ a Caixa Comum
 *  P4b-protege  Caixa Comum (padrão) NÃO tem botão de excluir
 *  P4b-reload   recarregar a página: caixas renomeadas/criadas persistem
 *  P4b-console  zero erros de console
 *
 *  Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr4b.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr4b-evidence';
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

  // limpa caixas de execuções anteriores (exclui tudo menos a padrão)
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

  // ---------- P4b-criar ----------
  await abrir();
  const antes = await page.evaluate(() => window.__bumptop.world.listBoxes().length);
  await page.locator('.boxes-add').click();
  await sleep(400);
  const nomes1 = await page.locator('.boxes-item-name').allTextContents();
  const ativa1 = await page.evaluate(() => window.__bumptop.world.getCurrentBoxId() !== 'box-default');
  check('P4b-criar', nomes1.includes('Caixa 1') && (await page.evaluate(() => window.__bumptop.world.listBoxes().length)) === antes + 1 && ativa1,
    `criada "Caixa 1"=[${nomes1.join(' | ')}] virou ativa=${ativa1}`);

  // ---------- P4b-renomear ----------
  // NOTA: ao abrir o rename o texto vira `value` do input (hasText não enxerga
  // valor de input) — os passos seguintes usam locator GLOBAL .boxes-rename
  await page.locator('.boxes-item', { hasText: 'Caixa 1' }).locator('.boxes-act-ren').click();
  await page.locator('.boxes-rename').fill('Projetos');
  await page.locator('.boxes-rename').press('Enter');
  await sleep(400);
  const nomes2 = await page.locator('.boxes-item-name').allTextContents();
  check('P4b-renomear', nomes2.includes('Projetos'), `lista=[${nomes2.join(' | ')}]`);

  // ---------- P4b-buscar ----------
  await page.locator('.boxes-search').fill('pro');
  await sleep(250);
  const filtradas = await page.locator('.boxes-item-name').allTextContents();
  await page.locator('.boxes-search').fill('');
  await sleep(250);
  const todas = await page.locator('.boxes-item-name').allTextContents();
  check('P4b-buscar', filtradas.length === 1 && filtradas[0] === 'Projetos' && todas.length === 2,
    `"pro" → [${filtradas.join('|')}] | limpo → [${todas.join(' | ')}]`);

  // ---------- P4b-entrar (caixa renomeada) ----------
  const boxId = await page.evaluate(() => window.__bumptop.world.listBoxes().find((b) => b.name === 'Projetos')?.id);
  await page.locator('.boxes-item', { hasText: 'Projetos' }).locator('.boxes-item-name').click();
  await sleep(250);
  await sleep(1800);
  const estado = await page.evaluate((id) => {
    const w = window.__bumptop.world;
    const cam = w.getCamera();
    const box = w.getBox(id);
    const nota = w.addStickyNote({ x: 500, y: 1.2, z: 0 }, 'P4BDENTRO');
    const p = w.getObject(nota).pose.position;
    return {
      ativa: w.getCurrentBoxId() === id,
      perto: Math.hypot(cam.target.x - box.pos.x, cam.target.z - box.pos.z) < 12,
      nela: w.getObject(nota).meta.boxId === id,
      dentro: Math.abs(p.x - box.pos.x) <= 124,
      notaId: nota,
    };
  }, boxId);
  await page.evaluate((id) => window.__bumptop.world.removeObject(id), estado.notaId);
  check('P4b-entrar', estado.ativa && estado.perto && estado.nela && estado.dentro,
    `ativa=${estado.ativa} câmera perto=${estado.perto} nota nasce nela=${estado.nela} posição dentro=${estado.dentro}`);

  // ---------- P4b-protege ----------
  await abrir();
  const temDelNaComum = await page.evaluate(() => {
    const w = window.__bumptop.world;
    // a Caixa Comum é a padrão: sem 🗑 no DOM E removeBoxEntity('box-default') = null
    const semDel = !window.__bumptop.overlay;
    return { semDel, core: w.removeBoxEntity('box-default') === null };
  });
  const delButtons = await page.locator('.boxes-act-del').count();
  check('P4b-protege', delButtons === 1 && temDelNaComum.core,
    `🗑 só na caixa nova (count=${delButtons}) | core recusa excluir a padrão=${temDelNaComum.core}`);

  // ---------- P4b-excluir (com confirmação) ----------
  const itensNaB2 = await page.evaluate((id) =>
    window.__bumptop.world.listObjects().filter((o) => o.meta.boxId === id).length, boxId);
  // cria uma nota na caixa p/ ter algo que volte
  await page.evaluate(() => window.__bumptop.world.addStickyNote({ x: 500, y: 1.2, z: 0 }, 'VOLTAR'));
  await sleep(100);
  // NOTA: na confirmação o textContent do item é limpo (hasText órfão) —
  // o ✅ usa locator GLOBAL .boxes-yes
  await page.locator('.boxes-item', { hasText: 'Projetos' }).locator('.boxes-act-del').click();
  await page.locator('.boxes-yes').click();
  await sleep(500);
  const nomes3 = await page.locator('.boxes-item-name').allTextContents();
  const movidos = await page.evaluate((id) => {
    const w = window.__bumptop.world;
    const b2 = w.listBoxes().find((b) => b.id === id);
    const voltaram = w.listObjects().filter((o) => o.meta?.noteText === 'VOLTAR');
    return { existe: !!b2, naPadrao: voltaram.every((o) => o.meta.boxId === 'box-default'), n: voltaram.length };
  }, boxId);
  check('P4b-excluir', !nomes3.includes('Projetos') && !movidos.existe && movidos.n === 1 && movidos.naPadrao,
    `caixa saiu da lista=${!movidos.existe} nota voltou p/ Comum=${movidos.naPadrao} (itens antes: ${itensNaB2})`);

  // ---------- P4b-reload (persistência) ----------
  // cria de novo + renomeia e recarrega (flush local é ~2s)
  await page.evaluate(() => window.__bumptop.world.addBoxEntity('Persiste', { x: 400, z: 0 }));
  await sleep(3000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listBoxes, null, { timeout: 30000 });
  await sleep(800);
  const persistiu = await page.evaluate(() => {
    const w = window.__bumptop.world;
    return { tem: w.listBoxes().some((b) => b.name === 'Persiste'), total: w.listBoxes().length };
  });
  check('P4b-reload', persistiu.tem && persistiu.total === 2,
    `após reload: caixas=${persistiu.total} "Persiste" existe=${persistiu.tem}`);

  // limpa a caixa de teste
  await page.evaluate(() => {
    const w = window.__bumptop.world;
    const b = w.listBoxes().find((x) => x.name === 'Persiste');
    if (b) w.removeBoxEntity(b.id);
  });

  // ---------- P4b-console ----------
  const reais = erros.filter((t) =>
    !t.includes('favicon') && !t.includes('X-Frame') &&
    !t.includes('401') && !t.includes('Unauthorized') &&
    !/status of 400|status of 503|status of 404/.test(t));
  check('P4b-console', reais.length === 0, `erros de console: ${reais.length}`);

  await page.screenshot({ path: `${OUT}/pr4b-final.png` });
} catch (e) {
  fail++;
  console.log(`[ERRO] ${e?.message ?? e}`);
} finally {
  await browser.close();
}
console.log(`\n===== PR4b: ${pass}/${pass + fail} =====`);
process.exit(fail === 0 ? 0 : 1);
