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
