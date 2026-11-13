/** Sonda PR9 — texto da nota NA FACE do papel + pilha em grade (painel de
 *  vidro + ✕) + pasta em modal de vidro:
 *
 *  P9a  nota SEM label DOM (o texto vive na textura da face) + meta.noteText
 *  P9b  clique na nota → modal [data-testid=file-preview] com o conteúdo
 *       COMPLETO + fecha com Esc (regressão PR8)
 *  P9c  duplo-clique na pilha → grade aberta (isPileOpen) + ✕ visível;
 *       clique no ✕ fecha a pilha (volta a Stack)
 *  P9d  duplo-clique na pasta → modal [data-testid=folder-modal] com os
 *       itens dentro (.folder-item-name); Esc fecha
 *  P9e  duplo-clique no chão vazio também fecha a pilha aberta
 *  P9f  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr9.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr9-evidence';
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
  const dblClickEm = async (oid) => {
    const t = await telaDe(oid);
    await page.mouse.dblclick(box.x + t.x, box.y + t.y);
  };

  // ---------- Pasta de teste (criada no INÍCIO p/ assentar antes do P9d) ----------
  const pastaId = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('__p9_pasta__', { recursive: true }).catch(() => {});
    // PRIMEIRO a pasta pelo FileService (senão o dedup cria "(2)")
    const id = (await window.__bumptop.files.createFolder('__p9_pasta__')).id;
    // DEPOIS o arquivo dentro dela
    await root
      .getDirectoryHandle('__p9_pasta__')
      .then((d) => d.getFileHandle('__p9_x__.txt', { create: true }))
      .then((h) => h.createWritable())
      .then((s) => s.write('conteudo x').then(() => s.close()));
    return id;
  });

  // ---------- P9a: nota com texto NA FACE (sem label DOM) ----------
  const textoLongo =
    'Primeira linha da nota escrita no papel amarelo. ' +
    'Segunda linha continua para garantir o truncamento visual na face. ' +
    'Terceira linha fecha o texto com mais caracteres ainda.';
  const notaId = await page.evaluate((txt) => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if (w.isStickyNote(o.id) && (o.meta.noteText || '').startsWith('Primeira linha')) {
        w.removeObject(o.id);
      }
    }
    return w.addStickyNote({ x: 30, y: 6, z: 30 }, txt);
  }, textoLongo);
  await sleep(700);
  const nota = await page.evaluate((nid) => {
    const o = window.__bumptop.world.getObject(nid);
    const labelNota = document.querySelector('.obj-label.note');
    const labelsDaNota = [...document.querySelectorAll('.obj-label')].filter(
      (el) => el.textContent === (o.meta.noteText || '').slice(0, 30),
    ).length;
    return {
      noteText: o.meta.noteText ?? null,
      temLabelNote: !!labelNota,
      labelsTexto: labelsDaNota,
    };
  }, notaId);
  check('P9a', nota.noteText === textoLongo && !nota.temLabelNote && nota.labelsTexto === 0,
    `noteText ok=${nota.noteText === textoLongo} | label .note ausente=${!nota.temLabelNote} | labels com o texto=${nota.labelsTexto}`);
  await page.screenshot({ path: `${OUT}/p9a-nota-face.png` });

  // ---------- P9b: clique abre o EDITOR RICO com o conteúdo COMPLETO (PR14) ----------
  const tNota = await telaDe(notaId);
  await page.mouse.click(box.x + tNota.x, box.y + tNota.y);
  const modal = page.locator('[data-testid="note-rich"]');
  const leitorOk = await modal.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
  const semLeitorEscuro = (await page.locator('[data-testid="file-preview"]').count()) === 0;
  const lido = leitorOk ? await page.locator('.note-rich-content').textContent() : '';
  await page.keyboard.press('Escape');
  check('P9b', leitorOk && semLeitorEscuro && (lido || '').includes(textoLongo),
    `editor rico abriu=${leitorOk} | card escuro ausente=${semLeitorEscuro} | conteúdo completo=${(lido || '').includes(textoLongo)} (${(lido || '').length} chars)`);
  await page.screenshot({ path: `${OUT}/p9b-leitor-nota.png` });

  // ---------- Pilha de teste (base + 2 arquivos) ----------
  const baseId = await page.evaluate(async () => {
    const w = window.__bumptop.world;
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('__p9_s1__.txt', { recursive: true }).catch(() => {});
    await root.removeEntry('__p9_s2__.txt', { recursive: true }).catch(() => {});
    for (const n of ['__p9_s1__.txt', '__p9_s2__.txt']) {
      await root
        .getFileHandle(n, { create: true })
        .then((h) => h.createWritable())
        .then((s) => s.write('conteudo ' + n).then(() => s.close()));
    }
    // diretório real da base (o watcher de 5s remove objetos com fsPath inexistente)
    await root.getDirectoryHandle('__p9_base__', { create: true });
    for (const o of w.listObjects()) {
      if ((o.meta.fsPath || '').startsWith('/__p9_s')) w.removeObject(o.id);
    }
    const s1 = w.addBox({ x: 20, y: 1.7, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#4f9cff', '__p9_s1__', { fsPath: '/__p9_s1__.txt', isDir: false });
    const s2 = w.addBox({ x: 24, y: 1.7, z: 4 }, { x: 7, y: 1.6, z: 7 }, '#4f9cff', '__p9_s2__', { fsPath: '/__p9_s2__.txt', isDir: false });
    const base = w.addBox({ x: 28, y: 1.7, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#4f9cff', '__p9_base__', { fsPath: '/__p9_base__', isDir: true });
    w.addToPile(base, s1);
    w.addToPile(base, s2);
    return base;
  });
  await sleep(700);

  // ---------- P9c: duplo-clique na pilha → grade + ✕ fecha ----------
  await dblClickEm(baseId);
  const gradeAbriu = await page
    .waitForFunction((oid) => window.__bumptop.world.isPileOpen(oid) === true, baseId, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  const closeBtn = page.locator('.pile-close-btn');
  const xVisivel = gradeAbriu && (await closeBtn.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false));
  await page.screenshot({ path: `${OUT}/p9c-pilha-grade.png` });
  let xFechou = false;
  if (xVisivel) {
    await closeBtn.click();
    xFechou = await page
      .waitForFunction((oid) => window.__bumptop.world.isPileOpen(oid) === false, baseId, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
  }
  check('P9c', gradeAbriu && xVisivel && xFechou,
    `grade abriu=${gradeAbriu} | ✕ visível=${xVisivel} | ✕ fechou=${xFechou}`);
  await page.screenshot({ path: `${OUT}/p9c-pilha-fechada.png` });

  // ---------- P9d: duplo-clique na pasta → modal de vidro com itens ----------
  // (a pasta foi criada no início e já assentou no chão durante P9a–P9c)
  await sleep(300);
  await dblClickEm(pastaId);
  await sleep(500);
  const dbgD = await page.evaluate((pid) => {
    const w = window.__bumptop.world;
    const o = w.getObject(pid);
    const modal = document.querySelector('[data-testid="folder-modal"]');
    const preview = document.querySelector('[data-testid="file-preview"]');
    return {
      pastaExiste: !!o,
      pos: o ? o.pose.position : null,
      modal: !!modal,
      preview: !!preview,
    };
  }, pastaId);
  console.log('  [dbg-d]', JSON.stringify(dbgD));
  const pastaModal = page.locator('[data-testid="folder-modal"]');
  const pastaAbriu = await pastaModal.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
  const itens = pastaAbriu ? await pastaModal.locator('.folder-item-name').allTextContents() : [];
  await page.keyboard.press('Escape');
  const pastaFechou = await pastaModal.waitFor({ state: 'hidden', timeout: 3000 }).then(() => true).catch(() => false);
  check('P9d', pastaAbriu && itens.includes('__p9_x__.txt') && pastaFechou,
    `modal pasta=${pastaAbriu} | itens=${JSON.stringify(itens)} | Esc fechou=${pastaFechou}`);
  await page.screenshot({ path: `${OUT}/p9d-pasta-modal.png` });

  // ---------- P9e: duplo-clique no chão vazio fecha a pilha ----------
  await dblClickEm(baseId); // reabre a grade
  const reabriu = await page
    .waitForFunction((oid) => window.__bumptop.world.isPileOpen(oid) === true, baseId, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  await page.mouse.dblclick(box.x + box.width * 0.2, box.y + box.height * 0.82); // chão vazio
  const chaoFechou = await page
    .waitForFunction((oid) => window.__bumptop.world.isPileOpen(oid) === false, baseId, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check('P9e', reabriu && chaoFechou, `reabriu=${reabriu} | chão fechou=${chaoFechou}`);

  // ---------- Cleanup ----------
  await page.evaluate((ids) => {
    const w = window.__bumptop.world;
    for (const id of ids) w.removeObject(id);
  }, [baseId, pastaId, notaId]);
  await page.evaluate(async () => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if ((o.meta.fsPath || '').startsWith('/__p9_s')) w.removeObject(o.id);
    }
    await navigator.storage
      .getDirectory()
      .then((r) => Promise.all([
        r.removeEntry('__p9_s1__.txt', { recursive: true }).catch(() => {}),
        r.removeEntry('__p9_s2__.txt', { recursive: true }).catch(() => {}),
        r.removeEntry('__p9_base__', { recursive: true }).catch(() => {}),
        r.removeEntry('__p9_pasta__', { recursive: true }).catch(() => {}),
      ]));
  });

  // ---------- P9f: zero erros de console ----------
  const filtrados = erros.filter(
    (e) => !/opfs-sahpool|Access Handles|sqlite/i.test(e), // ruído do fallback (2ª aba)
  );
  check('P9f', filtrados.length === 0, `erros de console: ${filtrados.length}${filtrados.length ? ' | ' + filtrados.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR9: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
