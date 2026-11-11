/** Sonda PR7 — drop em pasta no meio da sala (fix do pick) + excluir pasta
 *  via MENU REAL (tombstone + fs.remove + watcher não ressuscita):
 *
 *  P7a  setup: pasta no centro + arquivo ao lado (ambos visíveis)
 *  P7b  drag REAL do arquivo sobre a pasta → ícone sai da cena e o arquivo
 *       entra em /__drop_pasta__/__drop_arq__.txt no OPFS (cenário que
 *       falhava: o arrastado sob o cursor "ganhava" o pick)
 *  P7c  excluir pasta via MENU REAL (right-click → Excluir): ícone sai +
 *       diretório apagado do OPFS
 *  P7d  watcher (5 s) NÃO recria o ícone (antes: pasta ressuscitava)
 *  P7e  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:5175 node scripts/validate-pr7.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:5175';
const OUT = 'test-results/pr7-evidence';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`[${ok ? 'ok' : 'FALHOU'}] ${id} :: ${detail}`);
};

/** Verifica um caminho no OPFS. Retorna 'arquivo' | 'pasta' | false. */
function noOpfs(page, caminho) {
  return page.evaluate(async (p) => {
    const segs = p.split('/').filter(Boolean);
    const root = await navigator.storage.getDirectory();
    try {
      let dir = root;
      for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
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
    return w.listObjects().length > 0 && w.listObjects().every((o) => o.pose.position.y <= 2.2);
  }, { timeout: 20000 });

  // ---------- P7a: setup — cena limpa, pasta no CENTRO, arquivo ao lado ----------
  // Ambos com conteúdo REAL no OPFS (sem isso o watcher de 5 s remove os
  // ícones cujo fsPath não está no listing — e o moveInto precisa ler o arquivo)
  const ids = await page.evaluate(async () => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) w.removeObject(o.id);
    const root = await navigator.storage.getDirectory();
    for (const n of ['__drop_pasta__', '__drop_arq__.txt']) {
      await root.removeEntry(n, { recursive: true }).catch(() => {});
    }
    await root
      .getFileHandle('__drop_arq__.txt', { create: true })
      .then((h) => h.createWritable())
      .then((s) => s.write('conteudo sonda P7').then(() => s.close()));
    const pasta = (await window.__bumptop.files.createFolder('__drop_pasta__')).id;
    const arq = w.addBox(
      { x: 40, y: 1.7, z: 20 },
      { x: 7, y: 1.6, z: 7 },
      '#4f9cff',
      '__drop_arq__',
      { fsPath: '/__drop_arq__.txt', isDir: false },
    );
    return { pasta, arq };
  });
  await page.waitForFunction(
    () => window.__bumptop.world.listObjects().length === 2 &&
      window.__bumptop.world.listObjects().every((o) => o.pose.position.y <= 2.2),
    { timeout: 10000 },
  );
  const tela = await page.evaluate((ids) => {
    const p1 = window.__bumptop.renderer.projectToScreen(window.__bumptop.world.getObject(ids.pasta).pose.position);
    const p2 = window.__bumptop.renderer.projectToScreen(window.__bumptop.world.getObject(ids.arq).pose.position);
    return { pasta: p1, arq: p2 };
  }, ids);
  check('P7a', tela.pasta.visible && tela.arq.visible,
    `pasta e arquivo visíveis na tela (${tela.pasta.visible}/${tela.arq.visible})`);
  await page.screenshot({ path: `${OUT}/p7a-setup.png` });

  // ---------- P7b: drag REAL no MEIO da sala → moveInto ----------
  const box = await page.locator('#scene-root canvas').boundingBox();
  await page.mouse.move(box.x + tela.arq.x, box.y + tela.arq.y);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(
      box.x + tela.arq.x + ((tela.pasta.x - tela.arq.x) * i) / 14,
      box.y + tela.arq.y + ((tela.pasta.y - tela.arq.y) * i) / 14,
    );
    await sleep(40);
  }
  await sleep(2200); // mola converge
  await page.mouse.up();
  let dentro = false;
  let sumiu = false;
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    if (!dentro) dentro = (await noOpfs(page, '/__drop_pasta__/__drop_arq__.txt')) === 'arquivo';
    if (!sumiu) sumiu = await page.evaluate((id) => window.__bumptop.world.getObject(id) === null, ids.arq);
    if (dentro && sumiu) break;
  }
  check('P7b', dentro && sumiu,
    `arquivo dentro da pasta no OPFS=${dentro} | ícone saiu da cena=${sumiu} (o pick do drop agora exclui o arrastado)`);
  await page.screenshot({ path: `${OUT}/p7b-apos-drop.png` });

  // ---------- P7c: excluir a pasta via MENU REAL ----------
  const tPasta = await page.evaluate((id) => {
    const pos = window.__bumptop.world.getObject(id).pose.position;
    return window.__bumptop.renderer.projectToScreen(pos);
  }, ids.pasta);
  await page.mouse.click(box.x + tPasta.x, box.y + tPasta.y, { button: 'right' });
  const menu = page.locator('.ctx-menu');
  const menuOk = await menu.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
  const excluir = menu.locator('.radial-btn-label, .ctx-item').filter({ hasText: 'Excluir' }).first();
  const itemOk = menuOk && (await excluir.isVisible().catch(() => false));
  if (itemOk) await excluir.click();
  await page.screenshot({ path: `${OUT}/p7c-menu-excluir.png` });
  let dirFoi = false;
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    dirFoi = (await noOpfs(page, '/__drop_pasta__')) === false;
    if (dirFoi) break;
  }
  const pastaFora = await page.evaluate((id) => window.__bumptop.world.getObject(id) === null, ids.pasta);
  check('P7c', itemOk && dirFoi && pastaFora,
    `menu Excluir=${itemOk} | ícone fora da cena=${pastaFora} | diretório OPFS apagado=${dirFoi}`);

  // ---------- P7d: watcher (5 s) não ressuscita ----------
  await sleep(6200);
  const ressuscitou = await page.evaluate(
    (id) => window.__bumptop.world.getObject(id) !== null,
    ids.pasta,
  );
  const dirVoltou = (await noOpfs(page, '/__drop_pasta__')) !== false;
  check('P7d', !ressuscitou && !dirVoltou,
    `pós-watcher: ícone recriado=${ressuscitou} | dir no OPFS=${dirVoltou} (tombstone impedindo)`);

  // ---------- P7e: zero erros de console ----------
  check('P7e', erros.length === 0,
    `erros de console: ${erros.length}${erros.length ? ' | ' + erros.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR7: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
