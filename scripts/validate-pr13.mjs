/** Sonda PR13 — correções do sistema de notas (WYSIWYG / checkbox / lembrete):
 *
 *  P13a  duplo-clique abre o modal rico GRANDE (≥80% da tela)
 *  P13b  WYSIWYG: B renderiza <b> de verdade (SEM ** no texto) e H1 vira
 *        bloco .nl-h1 (SEM # no texto)
 *  P13c  checkbox CLICÁVEL: ☑ cria item; clicar no .nl-box marca ✓
 *        (data-done="1" + line-through) e o modelo grava "- [x] item"
 *  P13d  lembrete custom: datetime-local com evento `input` + Fechar
 *        consolida em meta.noteReminder (bug do `change` corrigido)
 *  P13e  lembrete vencido dispara SEM depender do foco (toast ⏰ + flag)
 *  P13f  nota antiga (só noteText) continua renderizando a face
 *  P13g  zero erros de console
 *
 * Uso: BASE_URL=http://localhost:4173 node scripts/validate-pr13.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const OUT = 'test-results/pr13-evidence';
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
  const ids = [];
  const cleanup = async () => {
    await page.evaluate((list) => {
      const w = window.__bumptop.world;
      for (const id of list) if (w.getObject(id)) w.removeObject(id);
    }, ids);
  };

  // Nota de teste num canto livre da sala
  const notaId = await page.evaluate(() => {
    const w = window.__bumptop.world;
    for (const o of w.listObjects()) {
      if ((o.meta.noteText || '').includes('__p13__')) w.removeObject(o.id);
    }
    return w.addStickyNote({ x: 40, y: 1.2, z: -40 }, '__p13__');
  });
  ids.push(notaId);
  await sleep(300);

  const abrirModal = async () => {
    const t = await telaDe(notaId);
    await page.mouse.dblclick(box.x + t.x, box.y + t.y);
    await page.locator('[data-testid="note-rich"]').waitFor({ state: 'visible', timeout: 5000 });
    await sleep(200);
  };
  const fechar = async () => {
    await page.locator('.note-rich-done').click();
    await page.locator('[data-testid="note-rich"]').waitFor({ state: 'detached', timeout: 5000 });
    await sleep(500);
  };

  // ---------- P13a: modal rico GRANDE ----------
  await abrirModal();
  const modal = page.locator('[data-testid="note-rich"]');
  const tamanho = await modal.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width / window.innerWidth, h: r.height / window.innerHeight };
  });
  check('P13a', tamanho.w >= 0.8 && tamanho.h >= 0.75,
    `largura ${(tamanho.w * 100).toFixed(0)}% ≥80% | altura ${(tamanho.h * 100).toFixed(0)}% ≥75%`);
  await page.screenshot({ path: `${OUT}/p13a-modal-grande.png` });

  // ---------- P13b: WYSIWYG — B sem ** e H1 sem # ----------
  const editor = page.locator('.note-rich-content');
  await editor.click();
  await page.keyboard.type('destaque');
  await sleep(200);
  // Seleciona toda a linha
  await page.evaluate(() => {
    const ed = document.querySelector('.note-rich-content');
    const line = ed.querySelector('.nl-line');
    const r = document.createRange();
    r.selectNodeContents(line);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.locator('.note-rich-tool').filter({ hasText: 'Aa ▾' }).click();
  await page.locator('.note-rich-fmt-item').filter({ hasText: /^B$/ }).click();
  await sleep(200);
  const comBold = await editor.evaluate((el) => ({
    html: el.innerHTML,
    texto: el.textContent,
  }));
  // Caret continua na linha → aplica H1
  await page.locator('.note-rich-tool').filter({ hasText: 'Aa ▾' }).click();
  await page.locator('.note-rich-fmt-item').filter({ hasText: /^H1$/ }).click();
  await sleep(200);
  const comH1 = await editor.evaluate((el) => ({
    classe: el.querySelector('.nl-line')?.className ?? '',
    texto: el.textContent,
  }));
  const wysiwygOk =
    comBold.html.includes('<b>') &&
    !comBold.texto.includes('**') &&
    comH1.classe.includes('nl-h1') &&
    !comH1.texto.includes('#');
  check('P13b', wysiwygOk,
    `B html=${comBold.html.includes('<b>')} | sem **=${!comBold.texto.includes('**')} | nl-h1=${comH1.classe.includes('nl-h1')} | sem #=${!comH1.texto.includes('#')}`);
  await page.screenshot({ path: `${OUT}/p13b-wysiwyg.png` });

  // ---------- P13c: checkbox CLICÁVEL com riscado ----------
  // Nova linha (Enter) → digita item → ☑ → clica no box
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('tarefa p13');
  await page.locator('.note-rich-tool').filter({ hasText: '☑' }).click();
  await sleep(200);
  const item = editor.locator('.nl-item').last();
  const pendente = await item.getAttribute('data-done');
  const temBox = (await item.locator('.nl-box').count()) === 1;
  // Clica NO checkbox → marca ✓
  await item.locator('.nl-box').click();
  await sleep(200);
  const marcado = await item.getAttribute('data-done');
  const riscado = await item.evaluate((el) => {
    const t = el.querySelector('.nl-text');
    return t ? getComputedStyle(t).textDecorationLine.includes('line-through') : false;
  });
  // Fecha e confere o MODELO (markdown persiste retrocompatível)
  await fechar();
  const modelo = await page.evaluate((id) => window.__bumptop.world.getObject(id)?.meta.noteText ?? '', notaId);
  const checkboxOk =
    pendente === '0' && temBox && marcado === '1' && riscado &&
    modelo.includes('- [x] tarefa p13');
  check('P13c', checkboxOk,
    `box=${temBox} | done ${pendente}→${marcado} | riscado=${riscado} | modelo='${modelo.replace(/\n/g, ' ⏎ ').slice(0, 60)}…'`);
  await page.screenshot({ path: `${OUT}/p13c-checkbox.png` });

  // ---------- P13d: lembrete custom (datetime + Fechar consolida) ----------
  await abrirModal();
  await page.locator('.note-rich-tool').filter({ hasText: '⏰' }).click();
  await sleep(200);
  // Preenche o datetime e dispara `input` (o fluxo real do usuário)
  const alvo = new Date(2027, 0, 5, 9, 30, 0, 0).getTime();
  const alvoLocal = '2027-01-05T09:30';
  await page.evaluate((v) => {
    const dt = document.querySelector('.note-rich-remind-dt');
    dt.value = v;
    dt.dispatchEvent(new Event('input', { bubbles: true }));
  }, alvoLocal);
  // NÃO clica em nada do popover: fecha o modal direto (caso que falhava)
  await fechar();
  const rem = await page.evaluate((id) => {
    const o = window.__bumptop.world.getObject(id);
    return { at: o?.meta.noteReminder ?? null, fired: o?.meta.noteReminderFired };
  }, notaId);
  const customOk = rem.at === alvo && rem.fired === false;
  check('P13d', customOk,
    `esperado ${new Date(alvo).toLocaleString('pt-BR')} | gravado ${rem.at === null ? 'NADA (bug antigo)' : new Date(rem.at).toLocaleString('pt-BR')}`);
  await page.screenshot({ path: `${OUT}/p13d-lembrete-custom.png` });

  // ---------- P13e: lembrete vencido dispara (toast ⏰ + flag) ----------
  await page.evaluate((id) => {
    const w = window.__bumptop.world;
    w.setNoteMeta(id, { noteReminder: Date.now() - 2000 });
  }, notaId);
  const disparou = await page
    .waitForFunction(
      (id) => {
        const o = window.__bumptop.world.getObject(id);
        const toast = document.querySelector('.toast')?.textContent ?? '';
        return o?.meta.noteReminderFired === true && toast.includes('Lembrete');
      },
      notaId,
      { timeout: 18000 },
    )
    .then(() => true)
    .catch(() => false);
  check('P13e', disparou, `agendador (10 s, sem guard de foco) disparou=${disparou}`);
  await page.screenshot({ path: `${OUT}/p13e-lembrete-disparo.png` });

  // ---------- P13f: nota antiga (texto puro) continua renderizando ----------
  const antigaId = await page.evaluate(() => {
    const w = window.__bumptop.world;
    return w.addStickyNote({ x: -40, y: 1.2, z: 40 }, 'nota antiga de texto simples');
  });
  ids.push(antigaId);
  await sleep(500);
  const antiga = await page.evaluate((id) => {
    const o = window.__bumptop.world.getObject(id);
    return { text: o?.meta.noteText, thumb: (o?.meta.thumb ?? '').startsWith('data:image/png') };
  }, antigaId);
  check('P13f', antiga.text === 'nota antiga de texto simples' && antiga.thumb,
    `noteText ok=${antiga.text === 'nota antiga de texto simples'} | face png=${antiga.thumb}`);

  // ---------- Cleanup ----------
  await cleanup();

  // ---------- P13g: zero erros de console ----------
  const filtrados = erros.filter((e) => !/opfs-sahpool|Access Handles|sqlite/i.test(e));
  check('P13g', filtrados.length === 0,
    `erros de console: ${filtrados.length}${filtrados.length ? ' | ' + filtrados.slice(0, 3).join(' || ') : ''}`);

  await ctx.close();
} finally {
  await browser.close();
}

const falhas = results.filter((r) => !r.ok).length;
console.log(`\n===== PR13: ${results.length - falhas}/${results.length} =====`);
process.exit(falhas ? 1 : 0);
