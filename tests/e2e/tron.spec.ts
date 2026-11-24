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
    // Visitante não logado NÃO vê o ranking
    await expect(modal.locator('.tron-ranking-box')).toHaveCount(0);

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

  test('2 jogadores local (desktop) divide a tela e aceita Setas (P1) e A/D (P2)', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Modo 2 jogadores local é exclusivo de desktop');

    await page.goto('/');
    await page.waitForFunction(() => Boolean((window as any).__bumptop?.world));
    await page.locator('.game-mode-btn').click();

    const modal = page.locator('.tron-grid-modal');
    await expect(modal).toBeVisible();
    // Seleciona 2 Jogadores e divisão horizontal
    await modal.locator('.tron-mode-btn').nth(1).click();
    await modal.locator('.tron-split-wrap .tron-mode-btn').nth(1).click();
    await modal.locator('.tron-start-btn').click();

    const tronHud = page.locator('.tron-game-container');
    await expect(tronHud).toBeVisible({ timeout: 5000 });
    await expect(tronHud.locator('.tron-split-divider.horizontal')).toBeVisible();
    await expect(tronHud.locator('.tron-p-badge.p1')).toContainText('PLAYER 1');
    await expect(tronHud.locator('.tron-p-badge.p2')).toContainText('PLAYER 2');

    // P1 usa Setas e P2 usa A/D sem conflito e sem desintegrar na curva
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('a');
    await page.waitForTimeout(350);
    await expect(page.locator('.tron-status-overlay')).toBeHidden();

    await page.locator('.tron-exit-btn').click();
    await expect(tronHud).toBeHidden();
  });
});
