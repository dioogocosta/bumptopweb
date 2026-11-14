/**
 * E2E mobile — gestos de toque em emulação (Pixel 7).
 *
 * Cobre o caminho touch que o desktop não exercita:
 *  - tap seleciona
 *  - long-press abre o menu de contexto
 *  - layout retrato + safe-area não quebram o overlay
 */
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }, testInfo) => {
  // Este spec roda só no projeto mobile (emulação touch)
  test.skip(testInfo.project.name !== 'mobile', 'spec exclusivo do projeto mobile');
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });
});

test('mobile: app inicializa com canvas em viewport touch', async ({ page }) => {
  const canvas = page.locator('#scene-root canvas');
  await expect(canvas).toBeVisible();

  const size = await canvas.boundingBox();
  expect(size!.width).toBeGreaterThan(200);
  expect(size!.height).toBeGreaterThan(200);

  // Sem erros de console fatais
  const fatal = await page.evaluate(() =>
    (window as unknown as { __errors?: string[] }).__errors ?? [],
  );
  expect(fatal).toHaveLength(0);
});

test('mobile: long-press abre o menu de contexto', async ({ page }) => {
  const canvas = page.locator('#scene-root canvas');
  const box = (await canvas.boundingBox())!;

  // Toque longo no chão (longe do centro onde ficam os ícones demo)
  await page.touchscreen.tap(box.x + box.width * 0.25, box.y + box.height * 0.3);
  // O adapter usa pointer events; emulação de long-press via dispatch
  await page.evaluate(() => {
    const canvas = document.querySelector('#scene-root canvas') as HTMLElement;
    const r = canvas.getBoundingClientRect();
    const opts = { pointerId: 7, pointerType: 'touch', clientX: r.left + 60, clientY: r.top + 60, bubbles: true };
    canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
  });
  await page.waitForTimeout(700); // > LONG_PRESS_MS (500)
  const menu = page.locator('.ctx-menu');
  await expect(menu).toBeVisible();

  // Limpa o pointer pendente
  await page.evaluate(() => {
    const canvas = document.querySelector('#scene-root canvas') as HTMLElement;
    canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 7, pointerType: 'touch', bubbles: true }));
  });
});

test('mobile: labels projetados aparecem sem transbordar a tela', async ({ page }) => {
  await page.waitForTimeout(600);
  const label = page.locator('.obj-label').first();
  await expect(label).toBeVisible();

  const viewport = page.viewportSize()!;
  const lb = (await label.boundingBox())!;
  expect(lb.x).toBeGreaterThanOrEqual(0);
  expect(lb.x + lb.width).toBeLessThanOrEqual(viewport.width + 1);
});

// -------------------------------------------------------------------------
// PR15 — Modo Laço no toque: botão ⬭ liga; arrastar o dedo no chão vazio
// desenha o laço e seleciona vários; toque parado no chão desliga.
// (page.touchscreen só tem tap — o arrasto touch é simulado com
// PointerEvent pointerType:'touch' via dispatchEvent, como no long-press.)
// -------------------------------------------------------------------------
test('PR15: modo laço no toque — botão liga, arrasto seleciona vários, toque parado desliga', async ({ page }) => {
  const canvas = page.locator('#scene-root canvas');
  const box = (await canvas.boundingBox())!;

  // Dois objetos perto do centro, afastados entre si, para o laço englobar
  const ids = await page.evaluate(() => {
    const w = window.__bumptop!.world;
    return [
      w.addBox({ x: -18, y: 1.6, z: -18 }, { x: 6, y: 1.6, z: 6 }, '#fff', 'p15a.txt'),
      w.addBox({ x: 18, y: 1.6, z: 14 }, { x: 6, y: 1.6, z: 6 }, '#fff', 'p15b.txt'),
    ];
  });
  await page.waitForTimeout(400);

  // Ponto de partida no chão VAZIO: canto inferior-esquerdo (longe dos
  // ícones demo do centro e do reset-cam do topo-direito)
  const inicio = { x: box.x + 12, y: box.y + box.height - 12 };
  // Destino: canto superior-direito → o AABB do laço cobre o canvas todo
  const fim = { x: box.x + box.width - 12, y: box.y + 12 };

  // 1) Toque no botão ⬭ → liga o modo laço
  await page.locator('.lasso-btn').click();
  await expect(page.locator('.lasso-btn.sel')).toBeVisible();
  expect(await page.evaluate(() => window.__bumptop!.world.isLassoMode())).toBe(true);

  // 2) Arrasto touch no chão vazio desenha o laço
  // isPrimary:true é essencial — sem ele o adapter trata como 2º dedo (pinch)
  await page.evaluate(({ p }) => {
    const canvas = document.querySelector('#scene-root canvas') as HTMLElement;
    const ev = (type: string, x: number, y: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, { pointerId: 31, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true }),
      );
    ev('pointerdown', p.x0, p.y0);
    ev('pointermove', p.x0 + (p.x1 - p.x0) * 0.4, p.y0 + (p.y1 - p.y0) * 0.4);
  }, { p: { x0: inicio.x, y0: inicio.y, x1: fim.x, y1: fim.y } });

  // O retângulo/laço está visível durante o gesto
  await expect(page.locator('.lasso-rect')).toBeVisible();

  // Continua o arrasto até englobar os dois e solta
  await page.evaluate(({ p }) => {
    const canvas = document.querySelector('#scene-root canvas') as HTMLElement;
    const ev = (type: string, x: number, y: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, { pointerId: 31, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true }),
      );
    ev('pointermove', p.x1, p.y1);
    ev('pointerup', p.x1, p.y1);
  }, { p: { x0: inicio.x, y0: inicio.y, x1: fim.x, y1: fim.y } });

  const sel = await page.evaluate(() => window.__bumptop!.world.getSelectedIds());
  expect(sel).toContain(ids[0]);
  expect(sel).toContain(ids[1]);
  // Laço fechado de verdade mantém o modo ligado
  expect(await page.evaluate(() => window.__bumptop!.world.isLassoMode())).toBe(true);

  // Limpa os objetos de teste (o toque-parado tem de cair no chão VAZIO)
  await page.evaluate((list) => {
    const w = window.__bumptop!.world;
    for (const id of list) if (w.getObject(id)) w.removeObject(id);
  }, ids);
  await page.waitForTimeout(300);

  // 3) Toque PARADO no chão (sem desenhar) desliga o modo
  await page.evaluate(({ p }) => {
    const canvas = document.querySelector('#scene-root canvas') as HTMLElement;
    const ev = (type: string, x: number, y: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, { pointerId: 32, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true }),
      );
    ev('pointerdown', p.x, p.y);
    ev('pointerup', p.x + 2, p.y + 1);
  }, { p: { x: box.x + 20, y: box.y + box.height - 20 } });
  expect(await page.evaluate(() => window.__bumptop!.world.isLassoMode())).toBe(false);
  await expect(page.locator('.lasso-btn.sel')).toHaveCount(0);
});

// -------------------------------------------------------------------------
// PR17 — teclado no celular: o editor da nota vira FOLHA em tela cheia
// (viewport com interactive-widget=resizes-content + CSS mobile), então o
// teclado nunca cobre o campo de digitação nem a barra de ferramentas.
// -------------------------------------------------------------------------
test('PR17: editor da nota em folha tela-cheia no mobile + meta resizes-content', async ({ page }) => {
  // 1) meta viewport pede resize do conteúdo com o teclado (Chrome/Android)
  const meta = await page.evaluate(() =>
    document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
  );
  expect(meta).toContain('interactive-widget=resizes-content');

  // Nota de teste e clique → editor rico
  const notaId = await page.evaluate(() => {
    const w = window.__bumptop!.world;
    for (const o of w.listObjects()) {
      if (((o.meta?.noteText as string) || '').includes('NOTA P17')) w.removeObject(o.id);
    }
    return w.addStickyNote({ x: -18, y: 1.6, z: -18 }, 'NOTA P17 folha');
  });
  await page.waitForTimeout(400);
  const tela = await page.evaluate((oid) => {
    const pos = window.__bumptop!.world.getObject(oid)!.pose.position;
    return window.__bumptop!.renderer.projectToScreen(pos);
  }, notaId);
  const box = (await page.locator('#scene-root canvas').boundingBox())!;
  await page.mouse.click(box.x + tela.x, box.y + tela.y);
  const modal = page.locator('[data-testid="note-rich"]');
  await expect(modal).toBeVisible({ timeout: 4000 });

  // 2) No mobile o modal OCUPA A TELA TODA (folha), sem margens
  const mb = (await modal.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(mb.x).toBeLessThanOrEqual(1);
  expect(mb.y).toBeLessThanOrEqual(1);
  expect(Math.abs(mb.width - vp.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(mb.height - vp.height)).toBeLessThanOrEqual(2);

  // 3) A barra de ferramentas fica DENTRO da tela (acima do teclado quando
  // ele abrir — o viewport encolhe e a folha acompanha)
  const tb = (await page.locator('.note-rich-toolbar').boundingBox())!;
  expect(tb.y + tb.height).toBeLessThanOrEqual(vp.height + 1);

  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await page.evaluate((oid) => window.__bumptop!.world.removeObject(oid), notaId);
});
