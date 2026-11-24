import { test, expect } from '@playwright/test';

test.describe('TRON Light Cycles (Modo Game)', () => {
  test('abre Game Grid, inicia moto, move em 3D sem travar e vira sem autocolisão', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as any).__bumptop?.world));

    // Clica no botão Modo Game (TRON) no HUD
    const gameBtn = page.locator('.game-mode-btn');
    await expect(gameBtn).toBeVisible();
    await gameBtn.click();

    // Abre o Game Grid com 4 quadrantes e escolha de moto azul/vermelha
    const modal = page.locator('.tron-grid-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.tron-quadrant')).toHaveCount(4);
    await expect(modal.locator('.tron-bike-card.blue')).toBeVisible();
    await expect(modal.locator('.tron-bike-card.red')).toBeVisible();

    // Seleciona moto azul e inicia
    await modal.locator('.tron-bike-card.blue').click();
    await modal.locator('.tron-start-btn').click();

    // Aguarda o prédio terminar o fade e o jogo iniciar
    const tronHud = page.locator('.tron-game-container');
    await expect(tronHud).toBeVisible({ timeout: 5000 });

    // O HUD do BumpTop fica oculto durante o jogo (sem sobreposição)
    await expect(page.locator('#overlay-root')).toBeHidden();

    // Verifica que a câmera 3D do renderer principal está se movendo continuamente
    const pos1 = await page.evaluate(() => {
      const r = (window as any).__bumptop.renderer;
      return { x: r.camera.position.x, z: r.camera.position.z };
    });
    await page.waitForTimeout(450);
    const pos2 = await page.evaluate(() => {
      const r = (window as any).__bumptop.renderer;
      return { x: r.camera.position.x, z: r.camera.position.z };
    });
    const movedDist = Math.hypot(pos2.x - pos1.x, pos2.z - pos1.z);
    expect(movedDist).toBeGreaterThan(3);

    // Vira para a esquerda e para a direita: NÃO deve desintegrar imediatamente!
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(350);
    await expect(page.locator('.tron-status-overlay')).toBeHidden();

    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(350);
    await expect(page.locator('.tron-status-overlay')).toBeHidden();

    // Sai do game e restaura o ambiente
    await page.locator('.tron-exit-btn').click();
    await expect(tronHud).toBeHidden();
    await expect(page.locator('#overlay-root')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
