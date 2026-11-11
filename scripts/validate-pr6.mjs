/** Sonda PR6 — correção da persistência no backend de fallback (idb-sqlite):
 *  Reproduz o cenário do dono: 2 abas do MESMO perfil → a 2ª aba falha no VFS
 *  opfs-sahpool (exclusivo) e cai no backend idb-sqlite. ANTES do fix, toda
 *  escrita nesse backend lançava "P.export is not a function" e NADA persistia
 *  (F5 zerava a cena, notas perdidas, pasta não movia arquivos).
 *
 * Checagens (todas na ABA 2, backend idb-sqlite):
 *  P6a  backend da aba 2 é 'idb-sqlite' (fallback ativo)
 *  P6b  setSetting/getSetting imediato OK (antes: ERRO P.export)
 *  P6c  setting sobrevive ao RELOAD (export→IDB→deserialize)
 *  P6d  saveScene com objeto marcador → reload → objeto sobrevive
 *  P6e  zero erros de console na aba 2
 *
 * Uso: BASE_URL=http://localhost:5175 node scripts/validate-pr6.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:5175';
const OUT = 'test-results/pr6-evidence';
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

  // Aba 1: fica com o VFS opfs-sahpool (exclusivo)
  const p1 = await ctx.newPage();
  await p1.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p1.waitForFunction(() => window.__bumptop?.repo, null, { timeout: 30000 });
  await sleep(1500);

  // Aba 2: MESMO contexto → sahpool ocupado → fallback idb-sqlite
  const p2 = await ctx.newPage();
  const erros = [];
  p2.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  p2.on('pageerror', (e) => erros.push(String(e)));
  await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p2.waitForFunction(() => window.__bumptop?.repo, null, { timeout: 30000 });
  await sleep(1500);

  // ---------- P6a: backend da aba 2 ----------
  const b2 = await p2.evaluate(() => window.__bumptop.repo.backend());
  check('P6a', b2 === 'idb-sqlite', `backend da aba 2 = ${b2} (esperado idb-sqlite — o caso do dono)`);

  // ---------- P6b: escrita imediata ----------
  const probe1 = await p2.evaluate(async () => {
    const repo = window.__bumptop.repo;
    try {
      await repo.setSetting('__probe_p6', { t: 123, nome: 'sonda' });
      const v = await repo.getSetting('__probe_p6', null);
      return { ok: true, leitura: JSON.stringify(v) };
    } catch (e) {
      return { ok: false, erro: e.message };
    }
  });
  check('P6b', probe1.ok && probe1.leitura.includes('sonda'),
    `setSetting+getSetting=${JSON.stringify(probe1)} (antes do fix: ERRO "P.export is not a function")`);

  // ---------- P6c: sobrevive ao reload ----------
  await p2.reload({ waitUntil: 'domcontentloaded' });
  await p2.waitForFunction(() => window.__bumptop?.repo, null, { timeout: 30000 });
  await sleep(1500);
  const b2b = await p2.evaluate(() => window.__bumptop.repo.backend());
  const probe2 = await p2.evaluate(async () => {
    try {
      const v = await window.__bumptop.repo.getSetting('__probe_p6', null);
      return JSON.stringify(v);
    } catch (e) {
      return 'ERRO: ' + e.message;
    }
  });
  check('P6c', b2b === 'idb-sqlite' && probe2.includes('sonda'),
    `pós-reload: backend=${b2b} | probe=${probe2} ${probe2.includes('sonda') ? '← SOBREVIVEU' : '← PERDIDO'}`);
  await p2.screenshot({ path: `${OUT}/p6c-pos-reload.png` });

  // ---------- P6d: saveScene com marcador → reload → sobrevive ----------
  const marcador = await p2.evaluate(async () => {
    const { world, repo } = window.__bumptop;
    // Remove marcadores de rodadas anteriores
    for (const o of world.listObjects()) {
      if (o.label === '__sonda_p6__') world.removeObject(o.id);
    }
    world.addBox({ x: 60, y: 1.7, z: 30 }, { x: 7, y: 1.6, z: 7 }, '#ff8787', '__sonda_p6__', {});
    await repo.saveScene(world.toSnapshot());
    return { total: world.listObjects().length };
  });
  await sleep(300);
  await p2.reload({ waitUntil: 'domcontentloaded' });
  await p2.waitForFunction(() => window.__bumptop?.repo, null, { timeout: 30000 });
  await sleep(2000); // loadScene + física assentar
  const sobreviveu = await p2.evaluate(() => {
    const w = window.__bumptop.world;
    return { tem: w.listObjects().some((o) => o.label === '__sonda_p6__'), total: w.listObjects().length };
  });
  check('P6d', sobreviveu.tem,
    `saveScene(marcador) → reload → objeto na cena=${sobreviveu.tem} (total=${sobreviveu.total}, antes do reload=${marcador.total})`);
  await p2.screenshot({ path: `${OUT}/p6d-cena-restaurada.png` });

  // ---------- P6e: zero erros de console na aba 2 ----------
  // Os erros "opfs-sahpool ... Access Handles cannot be created" são do próprio
  // sqlite-wasm TENTANDO (e falhando) abrir o VFS exclusivo na 2ª aba — é o
  // mecanismo de fallback funcionando, não um bug do app.
  const relevantes = erros.filter(
    (e) => !/opfs-sahpool|createSyncAccessHandle|removeVfs|OPFS/i.test(e),
  );
  check('P6e', relevantes.length === 0,
    `erros de console relevantes: ${relevantes.length} (ruído do fallback OPFS: ${erros.length - relevantes.length})${relevantes.length ? ' | ' + relevantes.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR6: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
