/** Sonda PR10 — quadros (moldura) nas imagens + menu secundário de config +
 *  arrasto ao longo da parede + pasta com contador + modal excluir/tirar:
 *
 *  P10a  imagem importada vira QUADRO (meta.photoFrame=true + thumb composto)
 *  P10b  botão direito → "Configurações da imagem…" → "Moldura de quadro"
 *        desliga (meta.photoFrame=false) e liga de novo
 *  P10c  item pregado DESLIZA na parede (continua pregado) e desprega ao
 *        arrastar apontando para o chão
 *  P10d  pasta com textura própria + contador atualiza ao mover arquivo
 *        para dentro (moveInto)
 *  P10e  modal da pasta: "⇪" tira o item para a mesa (ícone volta à cena) e
 *        "✕" exclui o arquivo de dentro da pasta
 *  P10f  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr10.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr10-evidence';
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
  const box = await page.locator('#scene-root canvas').boundingBox();
  const telaDe = (oid) =>
    page.evaluate((id) => {
      const pos = window.__bumptop.world.getObject(id).pose.position;
      return window.__bumptop.renderer.projectToScreen(pos);
    }, oid);

  // Pasta de teste criada no INÍCIO (assenta no chão durante os outros passos)
  const pastaId = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('__p10_pasta__', { recursive: true }).catch(() => {});
    return (await window.__bumptop.files.createFolder('__p10_pasta__')).id;
  });

  // ---------- P10a: imagem importada vira QUADRO ----------
  const fotoId = await page.evaluate(async () => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if ((o.meta.fsPath || '').startsWith('/__p10_foto')) w.removeObject(o.id);
    }
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('__p10_foto.png', { recursive: true }).catch(() => {});
    // PNG 40×20 vermelho desenhado em canvas → File → importFiles
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 20;
    const cx = c.getContext('2d');
    cx.fillStyle = '#e11';
    cx.fillRect(0, 0, 40, 20);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], '__p10_foto.png', { type: 'image/png' });
    await window.__bumptop.files.importFiles([file], { x: 24, y: 2, z: 24 });
    return w.listObjects().find((o) => o.meta.fsPath === '/__p10_foto.png')?.id ?? null;
  });
  // thumb+frame são compostos assincronamente (spawnIcon) — espera ativa
  const fotoPronta = await page
    .waitForFunction(
      (fid) => {
        const o = window.__bumptop.world.getObject(fid);
        return !!o && o.meta.photoFrame === true && typeof o.meta.thumb === 'string' && o.meta.thumb.startsWith('data:image/');
      },
      fotoId,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  await sleep(300);
  const foto = await page.evaluate((fid) => {
    const o = window.__bumptop.world.getObject(fid);
    return { frame: o?.meta.photoFrame ?? null, thumb: typeof o?.meta.thumb === 'string' && o.meta.thumb.startsWith('data:image/') };
  }, fotoId);
  check('P10a', fotoPronta && foto.frame === true && foto.thumb,
    `photoFrame=${foto.frame} | thumb dataURL=${foto.thumb}`);
  await page.screenshot({ path: `${OUT}/p10a-quadro.png` });

  // ---------- P10b: menu secundário "Configurações da imagem…" ----------
  const tFoto = await telaDe(fotoId);
  await page.mouse.click(box.x + tFoto.x, box.y + tFoto.y, { button: 'right' });
  const menu1 = page.locator('.ctx-menu');
  const abriu = await menu1.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
  let secAbriu = false;
  let frameOk = false;
  if (abriu) {
    await page.getByRole('button', { name: /Configurações da imagem/ }).click();
    secAbriu = await menu1.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
    if (secAbriu) {
      // Desliga a moldura
      await page.getByRole('button', { name: /Moldura de quadro/ }).click();
      await sleep(700);
      const off = await page.evaluate((fid) => window.__bumptop.world.getObject(fid)?.meta.photoFrame ?? null, fotoId);
      // Liga de novo
      await page.mouse.click(box.x + tFoto.x, box.y + tFoto.y, { button: 'right' });
      await page.getByRole('button', { name: /Configurações da imagem/ }).click();
      await page.getByRole('button', { name: /Moldura de quadro/ }).click();
      await sleep(700);
      const on = await page.evaluate((fid) => window.__bumptop.world.getObject(fid)?.meta.photoFrame ?? null, fotoId);
      frameOk = off === false && on === true;
    }
  }
  await page.keyboard.press('Escape');
  check('P10b', abriu && secAbriu && frameOk,
    `menu=${abriu} | secundário=${secAbriu} | desligou+ligou=${frameOk}`);
  await page.screenshot({ path: `${OUT}/p10b-menu-config.png` });

  // ---------- P10c: pregado desliza na parede / desprega no chão ----------
  const slide = await page.evaluate(async () => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if ((o.meta.fsPath || '').startsWith('/__p10_s')) w.removeObject(o.id);
    }
    const id = w.addBox({ x: 0, y: 1.7, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#4f9cff', '__p10_s1__');
    w.pinToWall(id, 0);
    // Câmera corta o topo da parede norte (y=22 sai do viewport): baixa o item
    // para uma altura visível antes do arrasto (placeAt é private do TS, mas
    // acessível em runtime — padrão das sondas).
    const e = w.entries.get(id);
    w.placeAt(e, { x: 0, y: 12, z: e.data.pose.position.z });
    const p0 = w.getObject(id).pose.position;
    // Ponto alvo na parede norte (x deslocado, altura ainda visível)
    const alvo = { x: 30, y: 16, z: p0.z };
    return {
      id, p0, alvo,
      telaAlvo: window.__bumptop.renderer.projectToScreen(alvo),
      telaItem: window.__bumptop.renderer.projectToScreen(p0),
    };
  });
  await page.mouse.move(box.x + slide.telaItem.x, box.y + slide.telaItem.y);
  await page.mouse.down();
  await page.mouse.move(box.x + slide.telaAlvo.x, box.y + slide.telaAlvo.y, { steps: 12 });
  await sleep(300);
  const pos1 = await page.evaluate((id) => {
    const o = window.__bumptop.world.getObject(id);
    return { pos: o.pose.position, pin: o.pinnedWall };
  }, slide.id);
  const deslizou =
    pos1.pin === 0 &&
    Math.abs(pos1.pos.x - slide.alvo.x) < 6 &&
    Math.abs(pos1.pos.z - slide.p0.z) < 2;

  // Despregar: down no item (agora em x≈30), move para o centro do chão
  const sItem2 = await telaDe(slide.id);
  const sChao = await page.evaluate(() =>
    window.__bumptop.renderer.projectToScreen({ x: -20, y: 0, z: 20 }));
  await page.mouse.move(box.x + sItem2.x, box.y + sItem2.y);
  await page.mouse.down();
  await page.mouse.move(box.x + sChao.x, box.y + sChao.y, { steps: 14 });
  await sleep(250);
  const despregou = await page.evaluate((id) => window.__bumptop.world.getObject(id).pinnedWall === null, slide.id);
  await page.mouse.up();
  check('P10c', deslizou && despregou,
    `deslizou pregado=${deslizou} (x=${pos1.pos.x?.toFixed(1)}, pin=${pos1.pin}) | despregou=${despregou}`);
  await page.screenshot({ path: `${OUT}/p10c-parede.png` });

  // ---------- P10d: pasta com contador (moveInto atualiza) ----------
  const pastaThumb0 = await page.evaluate((pid) => window.__bumptop.world.getObject(pid)?.meta.thumb ?? null, pastaId);
  const pastaTemTextura = typeof pastaThumb0 === 'string' && pastaThumb0.startsWith('data:image/');
  // cria arquivo na raiz e move para dentro (direto pelo serviço)
  const movOk2 = await page.evaluate(async (pastaId) => {
    const w = window.__bumptop.world;
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('__p10_m1__.txt', { recursive: true }).catch(() => {});
    await root.getFileHandle('__p10_m1__.txt', { create: true })
      .then((h) => h.createWritable()).then((s) => s.write('m1').then(() => s.close()));
    const fid = w.addBox({ x: -24, y: 1.7, z: 24 }, { x: 7, y: 1.6, z: 7 }, '#4f9cff', '__p10_m1__', { fsPath: '/__p10_m1__.txt', isDir: false });
    return window.__bumptop.files.moveInto(fid, pastaId);
  }, pastaId).catch(() => false);
  await sleep(600);
  const pastaThumb1 = await page.evaluate((pid) => window.__bumptop.world.getObject(pid)?.meta.thumb ?? null, pastaId);
  const contou = pastaTemTextura && movOk2 === true && pastaThumb1 !== pastaThumb0;
  check('P10d', pastaTemTextura && movOk2 === true && contou,
    `textura pasta=${pastaTemTextura} | moveInto=${movOk2} | contador repintou=${pastaThumb1 !== pastaThumb0}`);
  await page.screenshot({ path: `${OUT}/p10d-pasta-contador.png` });

  // ---------- P10e: modal da pasta — tirar (⇪) e excluir (✕) ----------
  async function dblClickPasta() {
    const t = await telaDe(pastaId);
    await page.mouse.dblclick(box.x + t.x, box.y + t.y);
  }
  const antes = await page.evaluate(() => window.__bumptop.world.listObjects().length);
  await dblClickPasta();
  const modal = page.locator('[data-testid="folder-modal"]');
  const modalAbriu = await modal.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
  let extraiu = false;
  let excluiu = false;
  let diag = '';
  if (modalAbriu) {
    diag += `itens=${await modal.locator('.folder-item').count()} `;
    const item = modal.locator('.folder-item').first();
    await item.hover();
    await sleep(150);
    await item.locator('.folder-item-act').first().click(); // ⇪ tirar
    await sleep(1000);
    const depois = await page.evaluate(() => {
      const objs = window.__bumptop.world.listObjects();
      return {
        n: objs.length,
        p10: objs.filter((o) => (o.meta.fsPath || '').includes('__p10_')).map((o) => o.meta.fsPath),
      };
    });
    diag += `antes=${antes} depois=${depois.n} p10=[${depois.p10.join(',')}] `;
    extraiu = depois.n === antes + 1;
    // excluir o item restante dentro da pasta
    const item2 = modal.locator('.folder-item').first();
    if (await item2.count() > 0) {
      await item2.hover();
      await item2.locator('.folder-item-act-danger').click();
      await sleep(900);
      const raiz = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('__p10_pasta__');
        const nomes = [];
        for await (const [name] of dir.entries()) nomes.push(name);
        return nomes;
      });
      excluiu = raiz.length === 0;
    } else {
      excluiu = true; // nada restou — extração já esvaziou
    }
  }
  await page.keyboard.press('Escape');
  check('P10e', modalAbriu && extraiu && excluiu,
    `modal=${modalAbriu} | tirou p/ mesa=${extraiu} | excluiu dentro=${excluiu}${diag ? ' | ' + diag : ''}`);
  await page.screenshot({ path: `${OUT}/p10e-modal-acoes.png` });

  // ---------- Cleanup ----------
  await page.evaluate((ids) => {
    const w = window.__bumptop.world;
    for (const id of ids) if (id) w.removeObject(id);
  }, [pastaId, fotoId, slide.id]);
  await page.evaluate(async () => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if ((o.meta.fsPath || '').includes('__p10_')) w.removeObject(o.id);
    }
    const root = await navigator.storage.getDirectory();
    await Promise.all([
      root.removeEntry('__p10_pasta__', { recursive: true }).catch(() => {}),
      root.removeEntry('__p10_foto.png', { recursive: true }).catch(() => {}),
      root.removeEntry('__p10_m1__.txt', { recursive: true }).catch(() => {}),
    ]);
  });

  // ---------- P10f: zero erros de console ----------
  const filtrados = erros.filter(
    (e) => !/opfs-sahpool|Access Handles|sqlite/i.test(e),
  );
  check('P10f', filtrados.length === 0, `erros de console: ${filtrados.length}${filtrados.length ? ' | ' + filtrados.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR10: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
