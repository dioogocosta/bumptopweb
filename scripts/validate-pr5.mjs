/** Sonda PR5 — item 6 (pasta virtual na cena):
 *  Cria a pasta pelo MENU REAL do chão (right-click → "Nova pasta"), escreve
 *  um arquivo real no OPFS, ARRASTA de verdade o arquivo sobre a pasta
 *  (moveInto) e depois abre a pasta com duplo-clique real (importa o
 *  conteúdo de volta para a cena). O teste de dedup (2ª pasta) roda DEPOIS
 *  para não criar ambiguidade no drop.
 *
 * Checagens:
 *  P5a  menu do chão tem "Nova pasta" e clicar cria objeto isDir + dir no OPFS
 *  P5b  arrastar o arquivo sobre a pasta → ícone sai da cena e o arquivo vai
 *       para dentro da pasta no OPFS (/Nova pasta/prev-teste.txt)
 *  P5c  duplo-clique na pasta → openObject importa: ícone do arquivo interno
 *       volta à cena com fsPath dentro da pasta
 *  P5d  segunda pasta vira "Nova pasta (2)" (dedup de nome)
 *  P5e  cleanup: pasta e arquivos removidos do OPFS; objetos FS fora da cena
 *  P5f  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:5175 node scripts/validate-pr5.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:5175';
const OUT = 'test-results/pr5-evidence';
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

/** Posição de tela de um objeto (canvas + offset do boundingBox). */
async function telaDe(page, id) {
  const s = await page.evaluate((oid) => {
    const pos = window.__bumptop.world.getObject(oid).pose.position;
    return window.__bumptop.renderer.projectToScreen(pos);
  }, id);
  const box = await page.locator('#scene-root canvas').boundingBox();
  return { x: box.x + s.x, y: box.y + s.y, visible: s.visible !== false };
}

/** Verifica (com tentativas) um caminho no OPFS. */
function noOpfs(page, caminho) {
  // caminho: '/Nova pasta/prev-teste.txt' ou '/Nova pasta'
  return page.evaluate(async (p) => {
    const segs = p.split('/').filter(Boolean);
    const root = await navigator.storage.getDirectory();
    try {
      let dir = root;
      for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
      if (segs.length === 0) return true;
      const last = segs[segs.length - 1];
      try {
        await dir.getFileHandle(last);
        return 'arquivo';
      } catch {
        await dir.getDirectoryHandle(last);
        return 'pasta';
      }
    } catch {
      return false;
    }
  }, caminho);
}

/** Clica com o botão direito em pontos do chão até achar o item desejado. */
async function menuClick(page, texto) {
  const box = await page.locator('#scene-root canvas').boundingBox();
  const pontos = [
    [box.x + 60, box.y + 60], [box.x + 100, box.y + 700], [box.x + 1200, box.y + 700],
    [box.x + 1300, box.y + 200], [box.x + 300, box.y + 820], [box.x + 720, box.y + 830],
  ];
  for (const [x, y] of pontos) {
    await page.mouse.click(x, y, { button: 'right' });
    const tem = await page.waitForSelector('.ctx-menu', { timeout: 3000 }).catch(() => null);
    if (!tem) continue;
    const item = page.locator('.radial-btn-label, .ctx-item').filter({ hasText: texto }).first();
    if (await item.isVisible().catch(() => false)) {
      await item.click();
      await sleep(600);
      return true;
    }
    await page.keyboard.press('Escape');
    await sleep(250);
  }
  return false;
}

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

  // ---------- P5a: menu real do chão → "Nova pasta" ----------
  const clicou = await menuClick(page, 'Nova pasta');
  const pasta = await page.evaluate(() => {
    const w = window.__bumptop.world;
    const obj = w.listObjects().find((o) => o.meta.isDir === true);
    if (!obj) return null;
    return { id: obj.id, fsPath: obj.meta.fsPath };
  });
  const dirOk = (await noOpfs(page, '/Nova pasta')) === 'pasta';
  check('P5a', clicou && pasta !== null && pasta.fsPath === '/Nova pasta' && dirOk,
    `menu clicou=${clicou} | objeto pasta fsPath=${pasta?.fsPath} | dir no OPFS=${dirOk}`);
  await page.screenshot({ path: `${OUT}/p5a-nova-pasta.png` });

  // ---------- P5b: escreve arquivo REAL e arrasta sobre a pasta ----------
  const fileObj = await page.evaluate(async () => {
    const w = window.__bumptop.world;
    const root = await navigator.storage.getDirectory();
    await root
      .getFileHandle('prev-teste.txt', { create: true })
      .then((h) => h.createWritable())
      .then((s) => s.write('conteudo sonda P5').then(() => s.close()));
    const id = w.addBox({ x: 40, y: 1.7, z: 20 }, { x: 7, y: 1.6, z: 7 }, '#4f9cff', 'prev-teste.txt', {
      fsPath: '/prev-teste.txt',
      isDir: false,
    });
    return id;
  });
  await sleep(900);
  await esperarEstavel(page);
  const tArq = await telaDe(page, fileObj);
  const tPasta = await telaDe(page, pasta.id);
  check('P5b0', tArq.visible && tPasta.visible,
    `arquivo e pasta visíveis na tela (${tArq.visible}/${tPasta.visible})`);
  // Drag REAL: down no arquivo, ~14 passos até a pasta, espera a mola, up
  await page.mouse.move(tArq.x, tArq.y);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(tArq.x + ((tPasta.x - tArq.x) * i) / 14, tArq.y + ((tPasta.y - tArq.y) * i) / 14);
    await sleep(40);
  }
  await sleep(2200); // mola converge
  await page.mouse.up();
  // Espera o moveInto terminar (o arquivo entra na pasta E o ícone sai da
  // cena — a remoção do ícone vem depois de upsertFsEntry no worker SQLite,
  // então espera os DOIS com folga)
  let dentroNaPasta = false;
  let sumiuReal = false;
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    if (!dentroNaPasta) dentroNaPasta = (await noOpfs(page, '/Nova pasta/prev-teste.txt')) === 'arquivo';
    if (!sumiuReal) sumiuReal = await page.evaluate((id) => window.__bumptop.world.getObject(id) === null, fileObj);
    if (dentroNaPasta && sumiuReal) break;
  }
  check('P5b', sumiuReal && dentroNaPasta,
    `ícone saiu da cena=${sumiuReal} | arquivo dentro da pasta no OPFS=${dentroNaPasta}`);
  await page.screenshot({ path: `${OUT}/p5b-apos-drag.png` });

  // ---------- P5c: duplo-clique REAL na pasta → importa o conteúdo ----------
  const tPasta2 = await telaDe(page, pasta.id);
  await page.mouse.dblclick(tPasta2.x, tPasta2.y);
  // Espera o ícone interno aparecer na cena (importDirectory substitui a pasta)
  let importado = false;
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    importado = await page.evaluate(() =>
      window.__bumptop.world.listObjects().some((o) => o.meta.fsPath === '/Nova pasta/prev-teste.txt'),
    );
    if (importado) break;
  }
  check('P5c', importado,
    `ícone do arquivo interno na cena com fsPath=/Nova pasta/prev-teste.txt=${importado}`);
  await page.screenshot({ path: `${OUT}/p5c-pasta-importada.png` });

  // ---------- P5d: segunda pasta → "Nova pasta (2)" (dedup) ----------
  const clicou2 = await menuClick(page, 'Nova pasta');
  let dedupOk = clicou2;
  if (clicou2) {
    let temSegunda = false;
    for (let i = 0; i < 8; i++) {
      await sleep(400);
      temSegunda = (await noOpfs(page, '/Nova pasta (2)')) === 'pasta';
      if (temSegunda) break;
    }
    dedupOk = temSegunda;
  }
  check('P5d', dedupOk, `segunda pasta criada como "Nova pasta (2)"=${dedupOk}`);

  // ---------- P5e: cleanup — remove objetos FS e diretórios do OPFS ----------
  const cleanup = await page.evaluate(async () => {
    const w = window.__bumptop.world;
    const fsObjs = w.listObjects().filter((o) => typeof o.meta.fsPath === 'string');
    for (const o of fsObjs) w.removeObject(o.id);
    const root = await navigator.storage.getDirectory();
    const apagados = [];
    for (const name of ['Nova pasta', 'Nova pasta (2)', 'prev-teste.txt']) {
      try {
        await root.removeEntry(name, { recursive: true });
        apagados.push(name);
      } catch { /* já não existe */ }
    }
    const restou = w.listObjects().some((o) => typeof o.meta.fsPath === 'string');
    return { removidos: fsObjs.length, apagados, restou };
  });
  await sleep(500);
  check('P5e', cleanup.removidos > 0 && !cleanup.restou && cleanup.apagados.length >= 2,
    `objetos FS removidos=${cleanup.removidos} | restou FS na cena=${cleanup.restou} | entradas OPFS apagadas=${cleanup.apagados.length} (${cleanup.apagados.join(', ')})`);

  // ---------- P5f: zero erros de console ----------
  check('P5f', erros.length === 0,
    `erros de console: ${erros.length}${erros.length ? ' | ' + erros.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR5: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
