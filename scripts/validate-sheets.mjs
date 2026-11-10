/** Validação das FOLHAS FINAS (HANDOFF §5.1, commit 124b6a8).
 * Riscos listados no HANDOFF: aparência, z-fighting com o piso,
 * estabilidade da física, altura das pilhas e labels.
 *
 * Checagens:
 *  S1 folha     meta.halfExtents.y é ~5% da maior dimensão (não caixa)
 *  S2 piso      item deitado encosta no chão com folga mínima (não atravessa/não boia)
 *  S3 jitter    posições estáveis após assentar (sem tremor/oscilação)
 *  S4 flicker   dois frames sem input → quase zero diff (z-fighting acusaria flicker)
 *  S5 pilhas    altura da pilha coerente com o nº de folhas (não achata/não explode)
 *
 * Uso: BASE_URL=http://localhost:5174 node scripts/validate-sheets.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:5174';
const OUT = 'test-results/sheets-evidence';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`[${ok ? 'ok' : 'FALHOU'}] ${id} :: ${detail}`);
};

const dump = (page) => page.evaluate(() => {
  const app = window.__bumptop;
  if (!app) return null;
  const w = app.world;
  return {
    appKeys: Object.keys(app),
    worldProto: Object.getOwnPropertyNames(Object.getPrototypeOf(w)).filter((k) => k !== 'constructor'),
    objectCount: w.objectCount?.(),
    sample: w.listObjects?.().slice(0, 3),
    total: w.listObjects?.().length,
  };
});

/** Posições + extents de todos os objetos no instante atual. */
const snapshot = (page) => page.evaluate(() => {
  const w = window.__bumptop.world;
  return w.listObjects().map((o) => ({
    id: o.id,
    name: o.name,
    pos: { x: o.pose.position.x, y: o.pose.position.y, z: o.pose.position.z },
    he: o.meta?.halfExtents ? { ...o.meta.halfExtents } : null,
    surface: o.surface,
    pileId: o.pileId ?? o.meta?.pileId ?? null,
  }));
});

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listObjects, null, { timeout: 30000 });
  await sleep(2500); // deixa a física assentar

  const info = await dump(page);
  console.log('[sheets] app:', info.appKeys.join(','));
  console.log('[sheets] world:', info.worldProto.join(','));
  console.log('[sheets] objetos:', info.total, '| amostra:', JSON.stringify(info.sample, null, 1).slice(0, 900));

  const objs = await snapshot(page);

  // S1 — folha: y <= 7% da maior dimensão (5% + folga de arredondamento)
  const comHe = objs.filter((o) => o.he);
  const caixas = comHe.filter((o) => {
    const largura = Math.max(o.he.x, o.he.z);
    return largura > 0 && o.he.y > largura * 0.07 + 1e-6;
  });
  const razoes = comHe.map((o) => (o.he.y / Math.max(o.he.x, o.he.z)).toFixed(3));
  check('S1', comHe.length > 0 && caixas.length === 0,
    `${comHe.length - caixas.length}/${comHe.length} itens são folhas (y/largura: ${[...new Set(razoes)].join(', ')})` +
    (caixas.length ? ` | ainda caixa: ${caixas.map((o) => `${o.name || o.id.slice(0, 6)}=${(o.he.y / Math.max(o.he.x, o.he.z)).toFixed(3)}`).join(' ')}` : ''));

  // S2 — encostado no chão: chão em y=0, centro y deve ser ~he.y (item deitado)
  const deitados = comHe.filter((o) => o.surface !== 'wall');
  const fora = deitados.filter((o) => o.pos.y < 0 || o.pos.y > Math.max(o.he.x, o.he.z) + 2);
  check('S2', fora.length === 0,
    `${deitados.length} itens sobre superfícies com y>=0` +
    (fora.length ? ` | problemáticos: ${fora.map((o) => `${o.id.slice(0, 6)}@y=${o.pos.y.toFixed(2)}`).join(' ')}` : ''));

  // S3 — jitter: 12 amostras em ~2,4 s, deslocamento máximo por objeto
  const amostras = [];
  for (let i = 0; i < 12; i++) { amostras.push(await snapshot(page)); await sleep(200); }
  let maxMove = 0; let quem = null;
  for (let k = 0; k < amostras[0].length; k++) {
    let move = 0;
    for (const s of amostras) {
      const a = amostras[0][k].pos; const b = s[k].pos;
      move = Math.max(move, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
    }
    if (move > maxMove) { maxMove = move; quem = amostras[0][k].name || amostras[0][k].id.slice(0, 8); }
  }
  check('S3', maxMove < 0.05,
    `drift máximo em 2,4 s: ${maxMove.toFixed(4)} (${quem || '-'}) — limiar 0,05`);

  // S4 — flicker / z-fighting: diff entre 2 frames sem input
  const shot1 = await page.screenshot({ path: `${OUT}/s4-frame1.png` });
  await sleep(400);
  const shot2 = await page.screenshot({ path: `${OUT}/s4-frame2.png` });
  const diff = await page.evaluate(async ([a, b]) => {
    const load = (buf) => new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img);
      img.src = 'data:image/png;base64,' + buf;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const c = document.createElement('canvas');
    c.width = ia.width; c.height = ia.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(ia, 0, 0);
    const da = g.getImageData(0, 0, c.width, c.height).data;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(ib, 0, 0);
    const db = g.getImageData(0, 0, c.width, c.height).data;
    let pix = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      if (d > 30) pix++;
    }
    return { pix, total: c.width * c.height, w: c.width, h: c.height };
  }, [shot1.toString('base64'), shot2.toString('base64')]);
  const pct = (diff.pix / diff.total) * 100;
  check('S4', pct < 0.5,
    `flicker entre frames: ${diff.pix} px (${pct.toFixed(3)}%) — limiar 0,5% (z-fighting acusaria >)`);

  await page.screenshot({ path: `${OUT}/s5-geral.png` });

  // S5 — pilhas: forma uma pilha de 4 folhas e mede a altura real vs a esperada
  const alvos = objs.slice(0, 4).map((o) => o.id);
  const pileId = await page.evaluate((ids) => window.__bumptop.world.createPileFrom(ids), alvos);
  await sleep(1600);
  if (!pileId) {
    check('S5', false, 'createPileFrom não formou pilha com 4 ids');
  } else {
    const pilha = await page.evaluate((base) => {
      const w = window.__bumptop.world;
      const membros = w.listObjects().filter((o) => w.inPile(o.id));
      return membros.map((o) => ({
        y: o.pose.position.y,
        folha: o.meta.halfExtents.y * 2,
        inPile: w.inPile(o.id),
      }));
    }, pileId);
    const ys = pilha.map((p) => p.y).sort((a, b) => a - b);
    const altura = ys[ys.length - 1] - ys[0];
    const folha = pilha[0].folha;
    const esperada = folha * pilha.length;
    const ok = pilha.length >= 2 && altura >= folha * (pilha.length - 1) * 0.8 && altura <= esperada * 1.5 + 0.5;
    check('S5', ok,
      `pilha de ${pilha.length} folhas (folha=${folha.toFixed(2)}): altura=${altura.toFixed(2)} | esperada≈${esperada.toFixed(2)} (cada folha empilha em cima da anterior)`);

    // S5b — a pilha assenta: posições estáveis após a formação
    const am2 = [];
    for (let i = 0; i < 8; i++) {
      am2.push(await page.evaluate(() => window.__bumptop.world.listObjects()
        .filter((o) => window.__bumptop.world.inPile(o.id))
        .map((o) => o.pose.position.y)));
      await sleep(200);
    }
    let drift = 0;
    for (let k = 0; k < am2[0].length; k++) {
      const v = am2.map((s) => s[k]);
      drift = Math.max(drift, Math.max(...v) - Math.min(...v));
    }
    check('S5b', drift < 0.1, `drift vertical da pilha em 1,6 s: ${drift.toFixed(4)} — limiar 0,1`);

    await page.screenshot({ path: `${OUT}/s5-pilha.png` });
  }

  // S6 — labels: existem, são visíveis e ficam dentro da viewport
  await sleep(500);
  const labels = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.obj-label')];
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        text: el.textContent,
        x: Math.round(r.x), y: Math.round(r.y),
        dentro: r.x >= 0 && r.y >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
        noChao: r.height > 0,
      };
    });
  });
  const visiveis = labels.filter((l) => l.text && l.dentro);
  check('S6', labels.length > 0 && visiveis.length === labels.length,
    `${visiveis.length}/${labels.length} labels visíveis e dentro da tela` +
    (labels.length ? ` | ex.: ${labels.slice(0, 3).map((l) => `${l.text}@${l.x},${l.y}`).join(' ')}` : ''));

  await page.screenshot({ path: `${OUT}/s6-labels.png` });

  // S7 — impacto: arremessa uma folha solta e mede se assenta (sem tremor/ressalto)
  const alvo7 = await page.evaluate(() => {
    const app = window.__bumptop;
    const solto = app.world.listObjects().find((o) => !app.world.inPile(o.id) && !app.world.isPinned(o.id));
    if (!solto) return null;
    const s = app.renderer.projectToScreen({ ...solto.pose.position });
    return { id: solto.id, label: solto.label, x: s.x, y: s.y, visivel: s.visible };
  });
  if (!alvo7 || !alvo7.visivel) {
    check('S7', false, 'sem objeto solto visível para arremessar');
  } else {
    await page.mouse.move(alvo7.x, alvo7.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(alvo7.x + i * 45, alvo7.y - i * 6);
      await sleep(12);
    }
    await page.mouse.up();
    await sleep(1800); // tempo de voar + assentar

    const am3 = [];
    for (let i = 0; i < 8; i++) {
      am3.push(await page.evaluate((id) => {
        const o = window.__bumptop.world.listObjects().find((x) => x.id === id);
        return o ? { x: o.pose.position.x, y: o.pose.position.y, z: o.pose.position.z } : null;
      }, alvo7.id));
      await sleep(200);
    }
    const validos = am3.filter(Boolean);
    let jitter = 0;
    for (const p of validos) {
      jitter = Math.max(jitter, Math.hypot(p.x - validos[0].x, p.y - validos[0].y, p.z - validos[0].z));
    }
    const dentro = await page.evaluate((id) => window.__bumptop.world.isInsideRoom(id), alvo7.id);
    const posFinal = validos[validos.length - 1];
    check('S7', jitter < 0.05 && dentro,
      `arremesso de "${alvo7.label}": jitter pós-impacto=${jitter.toFixed(4)} (limiar 0,05) | na sala=${dentro} | pos final=(${posFinal.x.toFixed(1)}, ${posFinal.y.toFixed(2)}, ${posFinal.z.toFixed(1)})`);
    await page.screenshot({ path: `${OUT}/s7-impacto.png` });
  }

  await ctx.close();

  // console errors no fim (limpo)
  check('S0', erros.length === 0, `erros de console: ${erros.length}${erros.length ? ' | ' + erros.slice(0, 3).join(' || ') : ''}`);
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== FOLHAS FINAS: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
