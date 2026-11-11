/** Sonda PR4 — item 3 (abrir arquivos: modal in-app / download):
 *  Escreve arquivos REAIS no OPFS, cria os objetos na cena com fsPath e
 *  dispara duplo-clique REAL na tela — sem atalhos internos.
 *
 * Checagens:
 *  P4a  setup: 3 arquivos escritos no OPFS + objetos criados com fsPath
 *  P4b  duplo-clique na imagem → modal in-app com <img> carregada
 *  P4c  duplo-clique no texto → modal in-app com o CONTEÚDO em <pre>
 *  P4d  duplo-clique no zip → evento de DOWNLOAD (sem modal)
 *  P4e  cleanup: objetos removidos + arquivos OPFS apagados
 *  P4f  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:5175 node scripts/validate-pr4.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:5175';
const OUT = 'test-results/pr4-evidence';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`[${ok ? 'ok' : 'FALHOU'}] ${id} :: ${detail}`);
};

/** PNG 1×1 vermelho (base64) — bytes reais para o arquivo do OPFS. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'pt-BR',
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__bumptop?.world?.listObjects, null, { timeout: 30000 });
  await esperarEstavel(page);

  // ---------- P4a: escreve arquivos REAIS no OPFS e cria os objetos ----------
  const setup = await page.evaluate(async (pngB64) => {
    const w = window.__bumptop.world;
    const root = await navigator.storage.getDirectory();

    // PNG: bytes binários reais
    const bin = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0));
    await root.getFileHandle('prev-teste.png', { create: true }).then((h) => h.createWritable()).then((s) => s.write(bin).then(() => s.close()));
    // Texto com conteúdo verificável
    await root.getFileHandle('prev-teste.txt', { create: true }).then((h) => h.createWritable()).then((s) => s.write('conteudo sonda P4 linha 1\nlinha 2').then(() => s.close()));
    // ZIP: assinatura PK
    const zip = new TextEncoder().encode('PK\x03\x04 arquivo de teste');
    await root.getFileHandle('prev-teste.zip', { create: true }).then((h) => h.createWritable()).then((s) => s.write(zip).then(() => s.close()));

    // Confere a escrita lendo de volta
    const lido = await root.getFileHandle('prev-teste.png').then((h) => h.getFile()).then((f) => f.size);
    if (lido !== bin.length) throw new Error(`png no OPFS com tamanho errado: ${lido} != ${bin.length}`);

    // Cria os objetos na cena com fsPath (como o importDirectory faria)
    const mk = (name, x) =>
      w.addBox({ x, y: 1.7, z: -40 }, { x: 7, y: 1.6, z: 7 }, '#4f9cff', name, { fsPath: `/${name}`, isDir: false });
    const idPng = mk('prev-teste.png', -30);
    const idTxt = mk('prev-teste.txt', 0);
    const idZip = mk('prev-teste.zip', 30);
    return { idPng, idTxt, idZip };
  }, PNG_1PX.toString('base64'));
  await sleep(900); // objetos caem no chão
  await esperarEstavel(page);
  const existem = await page.evaluate((ids) =>
    ids.every((id) => window.__bumptop.world.getObject(id) !== null),
  [setup.idPng, setup.idTxt, setup.idZip]);
  check('P4a', existem, `arquivos OPFS escritos + 3 objetos com fsPath na cena=${existem}`);

  // ---------- P4b: duplo-clique REAL na imagem → modal com <img> ----------
  const tPng = await telaDe(page, setup.idPng);
  check('P4b0', tPng.visible, `objeto da imagem visível na tela=${tPng.visible}`);
  await page.mouse.dblclick(tPng.x, tPng.y);
  const modal = page.locator('[data-testid="file-preview"]');
  await modal.waitFor({ state: 'visible', timeout: 5000 });
  const img = modal.locator('.file-preview-image');
  await page.waitForFunction(
    () => document.querySelector('.file-preview-image')?.naturalWidth === 1,
    null,
    { timeout: 5000 },
  );
  const nomeImg = await modal.locator('.file-preview-name').textContent();
  check('P4b', nomeImg === 'prev-teste.png',
    `modal aberto com <img> carregada (naturalWidth=1) | nome="${nomeImg}"`);
  await page.screenshot({ path: `${OUT}/p4b-modal-imagem.png` });
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'detached', timeout: 3000 });

  // ---------- P4c: duplo-clique REAL no texto → <pre> com o conteúdo ----------
  const tTxt = await telaDe(page, setup.idTxt);
  await page.mouse.dblclick(tTxt.x, tTxt.y);
  await modal.waitFor({ state: 'visible', timeout: 5000 });
  const texto = await modal.locator('.file-preview-text').textContent();
  check('P4c', texto === 'conteudo sonda P4 linha 1\nlinha 2',
    `modal de texto com conteúdo em <pre>=${JSON.stringify(texto)}`);
  await page.screenshot({ path: `${OUT}/p4c-modal-texto.png` });
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'detached', timeout: 3000 });

  // ---------- P4d: duplo-clique REAL no zip → DOWNLOAD (sem modal) ----------
  const tZip = await telaDe(page, setup.idZip);
  const dlPromise = page.waitForEvent('download', { timeout: 8000 });
  await page.mouse.dblclick(tZip.x, tZip.y);
  const dl = await dlPromise;
  const abriuModal = await modal.isVisible().catch(() => false);
  check('P4d', !abriuModal && dl.suggestedFilename() === 'prev-teste.zip',
    `download disparado="${dl.suggestedFilename()}" | modal abriu=${abriuModal}`);
  await page.screenshot({ path: `${OUT}/p4d-zip-download.png` });

  // ---------- P4e: cleanup — remove os objetos e os arquivos do OPFS ----------
  const cleanup = await page.evaluate(async (ids) => {
    const w = window.__bumptop.world;
    for (const id of ids) w.removeObject(id);
    const root = await navigator.storage.getDirectory();
    const removidos = [];
    for (const name of ['prev-teste.png', 'prev-teste.txt', 'prev-teste.zip']) {
      try {
        await root.removeEntry(name);
        removidos.push(name);
      } catch { /* já não existe */ }
    }
    return { objetos: ids.every((id) => w.getObject(id) === null), removidos };
  }, [setup.idPng, setup.idTxt, setup.idZip]);
  await sleep(600);
  check('P4e', cleanup.objetos && cleanup.removidos.length === 3,
    `objetos removidos=${cleanup.objetos} | arquivos OPFS apagados=${cleanup.removidos.length}/3`);

  // ---------- P4f: zero erros de console ----------
  check('P4f', erros.length === 0,
    `erros de console: ${erros.length}${erros.length ? ' | ' + erros.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR4: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
