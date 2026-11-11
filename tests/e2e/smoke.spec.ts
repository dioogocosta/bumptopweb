/**
 * Smoke test E2E (Playwright) — valida que o app INICIA de verdade no navegador:
 *  - canvas WebGL montado
 *  - SQLite (OPFS ou fallback IndexedDB) inicializa e relata backend
 *  - cena de demonstração semeada
 *  - uma interação (arraste/toss) não quebra
 */
import { test, expect } from '@playwright/test';

declare global {
  interface Window {
    __bumptop?: {
      repo: { backend(): string; getSetting<T>(key: string, fallback: T): Promise<T> };
      world: any;
      renderer: any;
      overlay: any;
      files: {
        mode(): string;
        importDirectory(path?: string): Promise<{ total: number; files: number; thumbs: number }>;
      };
    };
  }
}

test('app inicializa com canvas, SQLite e cena semeada', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.goto('/');

  // Espera o bootstrap concluir (createApp resolve e expõe __bumptop)
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  // Canvas WebGL montado
  const canvas = page.locator('#scene-root canvas');
  await expect(canvas).toHaveCount(1);

  // Cena de demonstração semeada
  const count = await page.evaluate(() => window.__bumptop!.world.objectCount());
  expect(count).toBeGreaterThan(0);

  // Backend SQLite ativo (OPFS ou fallback IndexedDB)
  const backend = await page.evaluate(() => window.__bumptop!.repo.backend());
  expect(['opfs-sqlite', 'idb-sqlite']).toContain(backend);

  // Sem erros de console graves (ignora avisos de WebGL/software rendering)
  const fatal = errors.filter(
    (e) => !/SwiftShader|GroupMarkerNotSet|Automatic fallback|GPU stall|WebGL.*software/i.test(e),
  );
  expect(fatal, `Erros de console:\n${fatal.join('\n')}`).toHaveLength(0);
});

test('M1: labels de arquivo, presets de câmera e tema funcionam', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  // Labels projetados no DOM (nomes de arquivo da cena demo)
  await page.waitForTimeout(600);
  const labels = page.locator('.obj-label');
  await expect(labels.first()).toBeVisible();
  const text = await labels.first().textContent();
  expect(text).toBeTruthy();

  // Preset de câmera via teclado (1–4) não quebra e move a câmera
  const before = await page.evaluate(() => JSON.stringify(window.__bumptop!.world.getCamera()));
  await page.keyboard.press('2');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => JSON.stringify(window.__bumptop!.world.getCamera()));
  expect(after).not.toBe(before);

  // Cycling de tema (T) persiste no repo
  await page.keyboard.press('t');
  await page.waitForTimeout(400);
  const themeIdx = await page.evaluate(() => window.__bumptop!.repo.getSetting('themeIndex', 0));
  expect(themeIdx).toBe(1);
});

test('M2: serviço de filesystem ativo (modo + importação não quebra)', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  // Modo FS reportado (fs-access no Chromium headless com permissão, senão opfs)
  const mode = await page.evaluate(() => window.__bumptop!.files.mode());
  expect(['fs-access', 'opfs', 'virtual']).toContain(mode);

  // Importação do diretório raiz (vazio na demo) não lança erro
  const r = await page.evaluate(() => window.__bumptop!.files.importDirectory('/'));
  expect(r.total).toBeGreaterThanOrEqual(0);
  expect(r.files).toBeGreaterThanOrEqual(0);

  // Cena segue viva após importação
  const count = await page.evaluate(() => window.__bumptop!.world.objectCount());
  expect(count).toBeGreaterThan(0);
});

test('M6: notas adesivas criam/editam via API da cena', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  const before = await page.evaluate(() => window.__bumptop!.world.objectCount());
  const id = await page.evaluate(() => window.__bumptop!.world.addStickyNote({ x: 30, y: 6, z: 30 }, 'hello'));
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => window.__bumptop!.world.objectCount());
  expect(after).toBe(before + 1);

  // O texto vira o label projetado no DOM
  const label = page.locator('.obj-label', { hasText: 'hello' });
  await expect(label).toBeVisible();

  // Edição persiste no snapshot
  const text = await page.evaluate((nid: string) => {
    window.__bumptop!.world.setNoteText(nid, 'editado');
    return (window.__bumptop!.world.toSnapshot().objects as any[]).find((o) => o.id === nid)?.meta.noteText;
  }, id);
  expect(text).toBe('editado');
});

test('interação (arraste) não lança erro', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  const box = await page.locator('#scene-root canvas').boundingBox();
  if (!box) return;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Simula um arraste rápido (potencial toss)
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < 12; i++) await page.mouse.move(cx + i * 18, cy - i * 4);
  await page.mouse.up();

  // Dá alguns frames p/ a física processar
  await page.waitForTimeout(500);
  const count = await page.evaluate(() => window.__bumptop!.world.objectCount());
  expect(count).toBeGreaterThan(0);
});

test('menu de contexto: botão direito → criar nota → editar → excluir', async ({ page }) => {  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  const box = (await page.locator('#scene-root canvas').boundingBox())!;
  const startCount = await page.evaluate(() => window.__bumptop!.world.objectCount());

  // Piso vazio no quadrante inferior esquerdo (dentro da sala, longe dos ícones demo)
  const fx = box.x + box.width * 0.3;
  const fy = box.y + box.height * 0.85;
  await page.mouse.click(fx, fy, { button: 'right' });

  // O menu aparece com "Nova nota adesiva"
  const menu = page.locator('.ctx-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByText('Nova nota adesiva')).toBeVisible();

  // Clica no item (regressão do bug: dispatch após remove() perdia o evento)
  await menu.getByText('Nova nota adesiva').click();

  // Editor abre → escreve e salva
  const editor = page.locator('.note-editor');
  await expect(editor).toBeVisible();
  await editor.locator('textarea').fill('nota do teste');
  await editor.getByRole('button', { name: 'Salvar' }).click();

  // Nota criada: contador subiu
  await page.waitForTimeout(300);
  const afterCreate = await page.evaluate(() => window.__bumptop!.world.objectCount());
  expect(afterCreate).toBe(startCount + 1);

  // Botão direito NO MESMO PONTO (em cima da nota recém-criada)
  await page.mouse.click(fx, fy, { button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.getByText('Excluir')).toBeVisible();
  await menu.getByText('Excluir').click();

  await page.waitForTimeout(500);
  const afterDelete = await page.evaluate(() => window.__bumptop!.world.objectCount());
  expect(afterDelete).toBe(startCount);
});

test('laço (Fase 7): mouse no chão vazio desenha o retângulo e seleciona', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  const box = (await page.locator('#scene-root canvas').boundingBox())!;
  const start = { x: box.x + 60, y: box.y + 60 }; // canto = chão vazio (mesmo ponto do menu)
  const end = { x: box.x + box.width - 60, y: box.y + box.height - 60 };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Arrasta cobrindo quase toda a tela (os ícones demo projetam no centro)
  await page.mouse.move(end.x, end.y, { steps: 8 });

  // Durante o arraste o rubber-band / laço livre fica visível
  const lasso = page.locator('.lasso-rect');
  await expect(lasso).toBeVisible();
  // Linha pontilhada e ponta da caneta azul do laço livre (P1)
  await expect(lasso.locator('.lasso-line')).toBeVisible();
  await expect(lasso.locator('.lasso-pen-tip')).toBeVisible();

  await page.mouse.up();
  // Soltar remove o retângulo…
  await expect(lasso).toHaveCount(0);
  // …mas mantém a seleção dos itens cobertos
  const selected = await page.evaluate(() => window.__bumptop!.world.getSelectedIds());
  expect(selected.length).toBeGreaterThan(0);
});

test('laço: clicar no chão vazio sem arrastar NÃO deixa seleção', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  const box = (await page.locator('#scene-root canvas').boundingBox())!;
  // Down + up no mesmo ponto: retângulo 0×0 não seleciona nada
  await page.mouse.click(box.x + 60, box.y + 60);

  await page.waitForTimeout(200);
  const selected = await page.evaluate(() => window.__bumptop!.world.getSelectedIds());
  expect(selected).toHaveLength(0);
});

test('P0: botão Reset Camera restaura a vista padrão', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  // Sai da vista padrão (preset 2 = top-down, distância 300)
  await page.evaluate(() => window.__bumptop!.world.setCameraPreset(2));
  const moved = await page.evaluate(
    () => (window.__bumptop!.world.getCamera() as { distance: number }).distance,
  );
  expect(moved).not.toBe(210);

  // Botão no canto superior direito → volta ao preset 1 (distância 210)
  const btn = page.getByRole('button', { name: 'Redefinir câmera' });
  await expect(btn).toBeVisible();
  await btn.click();

  const after = await page.evaluate(
    () => (window.__bumptop!.world.getCamera() as { distance: number }).distance,
  );
  expect(after).toBe(210);
});

test('P0: todo item do menu de contexto tem tooltip (data-hint)', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  const box = (await page.locator('#scene-root canvas').boundingBox())!;
  await page.mouse.click(box.x + 60, box.y + 60, { button: 'right' });

  const menu = page.locator('.ctx-menu');
  await expect(menu).toBeVisible();
  const total = await menu.locator('.ctx-item').count();
  const hinted = menu.locator('.ctx-item[data-hint]');
  expect(total).toBeGreaterThan(1);
  expect(await hinted.count()).toBe(total);
  // Dica preenchida (texto real, não chave)
  const hint = await hinted.first().getAttribute('data-hint');
  expect(hint).toBeTruthy();
  expect(hint).not.toContain('hint.');
});

test('P1: Pile Widget Halo aparece ao pairar sobre uma pilha com botões e tooltips', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  // Aguarda os itens da cena demo assentarem no chão com a física
  await page.waitForFunction(() => {
    const w = window.__bumptop?.world;
    if (!w) return false;
    const objs = w.listObjects();
    return objs.length >= 3 && objs.slice(0, 3).every((o: any) => o.pose.position.y <= 2.0);
  }, { timeout: 15000 });

  // Cria uma pilha com os dois primeiros itens da cena demo (já no chão)
  const screenPos = await page.evaluate(() => {
    const w = window.__bumptop!.world;
    const snap = w.toSnapshot();
    const a = snap.objects[0].id;
    const b = snap.objects[1].id;
    w.createPileFrom([a, b]);
    const pos = w.getObject(a)!.pose.position;
    const s = window.__bumptop!.renderer.projectToScreen(pos);
    return { ...s, pileId: a };
  });

  const box = (await page.locator('#scene-root canvas').boundingBox())!;
  const targetX = box.x + screenPos.x;
  const targetY = box.y + screenPos.y;

  // Move o mouse sobre a pilha no canvas
  await page.mouse.move(targetX, targetY);
  await page.waitForTimeout(300);

  const halo = page.locator('.pile-halo');
  await expect(halo).toBeVisible();

  // Verifica os 5 botões de ação do halo
  const buttons = halo.locator('.pile-halo-btn');
  expect(await buttons.count()).toBe(5);

  // Todo botão tem tooltip data-hint preenchido
  const hinted = halo.locator('.pile-halo-btn[data-hint]');
  expect(await hinted.count()).toBe(5);
  const firstHint = await hinted.first().getAttribute('data-hint');
  expect(firstHint).toBeTruthy();
  expect(firstHint).not.toContain('halo.');

  // Clica no botão de alternar leque (fan)
  const fanBtn = halo.locator('[data-action="fan"]');
  await fanBtn.click();
  await page.waitForTimeout(300);

  // Verifica que o layout mudou para leque
  const isLeaf = await page.evaluate(() => {
    const snap = window.__bumptop!.world.toSnapshot() as any;
    return (Object.values(snap.piles)[0] as any)?.layout === 2; // PileLayout.Leaf
  });
  expect(isLeaf).toBe(true);
});

test('P1: Dwell & Scrub exibe anel verde e faixa de miniaturas ao repousar sobre pilha', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  // Aguarda os itens da cena demo assentarem no chão com a física
  await page.waitForFunction(() => {
    const w = window.__bumptop?.world;
    if (!w) return false;
    const objs = w.listObjects();
    return objs.length >= 3 && objs.slice(0, 3).every((o: any) => o.pose.position.y <= 2.0);
  }, { timeout: 15000 });

  // Cria uma pilha com 3 itens
  const info = await page.evaluate(() => {
    const w = window.__bumptop!.world;
    const snap = w.toSnapshot();
    const a = snap.objects[0].id;
    const b = snap.objects[1].id;
    const c = snap.objects[2].id;
    w.createPileFrom([a, b, c]);
    const pos = w.getObject(a)!.pose.position;
    const s = window.__bumptop!.renderer.projectToScreen(pos);
    return { ...s, pileId: a, secondId: b };
  });

  const box = (await page.locator('#scene-root canvas').boundingBox())!;
  const targetX = box.x + info.x;
  const targetY = box.y + info.y;

  // Move o mouse sobre a pilha e repousa por > 400ms para ativar o dwell
  await page.mouse.move(targetX, targetY);
  await page.waitForTimeout(600);

  // Anel de dwell fica ativo
  const dwellRing = page.locator('.dwell-ring');
  await expect(dwellRing).toBeVisible();
  await expect(dwellRing).toHaveClass(/active/);

  // Faixa de miniaturas (scrub strip) aparece
  const scrubStrip = page.locator('.scrub-strip');
  await expect(scrubStrip).toBeVisible();

  // Contém 3 chips correspondentes aos 3 arquivos
  const chips = scrubStrip.locator('.scrub-chip');
  expect(await chips.count()).toBe(3);

  // Clica no segundo chip
  const secondChip = scrubStrip.locator(`.scrub-chip[data-id="${info.secondId}"]`);
  await secondChip.click();
  await page.waitForTimeout(200);

  // O item clicado foi selecionado
  const selectedId = await page.evaluate(() => window.__bumptop!.world.getSelectedId());
  expect(selectedId).toBe(info.secondId);
});

test('P1: Exploding Piles & Auto-Align toggles no menu de contexto e Sacudir pilha', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  const box = (await page.locator('#scene-root canvas').boundingBox())!;
  const floorPoint = { x: box.x + 60, y: box.y + 60 };

  // 1. Botão direito no chão vazio: exibe toggles de Auto-Align e Explodir Pilhas
  await page.mouse.click(floorPoint.x, floorPoint.y, { button: 'right' });
  const menu = page.locator('.ctx-menu');
  await expect(menu).toBeVisible();

  const autoAlignItem = menu.locator('.radial-btn-label').filter({ hasText: 'Alinhamento automático' });
  await expect(autoAlignItem).toBeVisible();
  const explodeItem = menu.locator('.radial-btn-label').filter({ hasText: 'Explodir pilhas ao puxar' });
  await expect(explodeItem).toBeVisible();

  // Alterna auto-align
  await autoAlignItem.click();
  await expect(page.locator('.toast').filter({ hasText: 'Alinhamento automático' })).toBeVisible();

  // Aguarda os itens assentarem no chão
  await page.waitForFunction(() => {
    const w = window.__bumptop?.world;
    if (!w) return false;
    const objs = w.listObjects();
    return objs.length >= 3 && objs.slice(0, 3).every((o: any) => o.pose.position.y <= 2.0);
  }, { timeout: 15000 });

  // 2. Cria pilha com 3 itens e testa "Sacudir pilha"
  const pileInfo = await page.evaluate(() => {
    const w = window.__bumptop!.world;
    const snap = w.toSnapshot();
    const a = snap.objects[0].id;
    const b = snap.objects[1].id;
    const c = snap.objects[2].id;
    w.createPileFrom([a, b, c]);
    const pos = w.getObject(a)!.pose.position;
    const s = window.__bumptop!.renderer.projectToScreen(pos);
    return { ...s, a, b, c };
  });

  const pileScreen = { x: box.x + pileInfo.x, y: box.y + pileInfo.y };
  await page.mouse.click(pileScreen.x, pileScreen.y, { button: 'right' });
  await expect(menu).toBeVisible();

  const shakeItem = menu.getByText('Sacudir pilha');
  await expect(shakeItem).toBeVisible();
  await shakeItem.click();

  await expect(page.locator('.toast').filter({ hasText: 'Pilha sacudida' })).toBeVisible();
  const inPileAfter = await page.evaluate(({ a, b, c }) => {
    const w = window.__bumptop!.world;
    return w.inPile(a) || w.inPile(b) || w.inPile(c);
  }, pileInfo);
  expect(inPileAfter).toBe(false);
});

test('P1: duplo-clique na parede foca a câmera na vista frontal (item 4)', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  // Aguarda os itens da cena demo assentarem no chão com a física
  await page.waitForFunction(() => {
    const w = window.__bumptop?.world;
    if (!w) return false;
    const objs = w.listObjects();
    return objs.length >= 3 && objs.slice(0, 3).every((o: any) => o.pose.position.y <= 2.0);
  }, { timeout: 15000 });

  const antes = await page.evaluate(() => window.__bumptop!.world.getCamera());

  // Projeta um ponto no MEIO da parede norte (face interna em z=-125): o ray
  // da tela até ele cruza a parede e o resolveFloor cai fora da sala.
  const pt = await page.evaluate(() => {
    const s = window.__bumptop!.renderer.projectToScreen({ x: 0, y: 10, z: -130 });
    return { ...s };
  });
  expect(pt.visible).toBe(true);

  const box = (await page.locator('#scene-root canvas').boundingBox())!;
  await page.mouse.dblclick(box.x + pt.x, box.y + pt.y);
  await page.waitForTimeout(1500); // animação da câmera ~0.8 s

  const depois = await page.evaluate(() => window.__bumptop!.world.getCamera());
  // Vista frontal da parede norte: elevação baixa, distância 240, pivot (0,14,0)
  expect(depois.elevation).toBeCloseTo(0.45, 1);
  expect(depois.distance).toBeCloseTo(240, 0);
  expect(depois.target.y).toBeCloseTo(14, 0);
  expect(depois.azimuth).toBeCloseTo(0, 1);
  // A câmera de fato animou (não era esse o estado antes)
  expect(depois.elevation).not.toBeCloseTo(antes.elevation, 1);
});

test('P1: modal de preview in-app abre imagem/texto/pdf e fecha (item 3)', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  const modal = page.locator('[data-testid="file-preview"]');

  // 1. Imagem (PNG 1×1 vermelho, data URL) → <img> carrega
  const dataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await page.evaluate((url) => {
    window.__bumptop!.overlay.showPreview({ name: 'teste.png', mime: 'image/png', url });
  }, dataUrl);
  await expect(modal).toBeVisible();
  const img = modal.locator('.file-preview-image');
  await expect(img).toBeVisible();
  await expect(img).toHaveJSProperty('naturalWidth', 1);
  await expect(modal.locator('.file-preview-name')).toHaveText('teste.png');

  // Fecha com Esc
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  // 2. Texto → <pre> com o conteúdo
  await page.evaluate(() => {
    window.__bumptop!.overlay.showPreview({ name: 'nota.txt', mime: 'text/plain', text: 'linha um\nlinha dois' });
  });
  await expect(modal).toBeVisible();
  await expect(modal.locator('.file-preview-text')).toHaveText('linha um\nlinha dois');

  // Fecha com ✕
  await modal.locator('.file-preview-close').click();
  await expect(modal).toHaveCount(0);

  // 3. PDF → iframe do visualizador
  await page.evaluate(() => {
    window.__bumptop!.overlay.showPreview({ name: 'doc.pdf', mime: 'application/pdf', url: 'data:application/pdf,' });
  });
  await expect(modal).toBeVisible();
  await expect(modal.locator('.file-preview-pdf')).toBeVisible();

  // Fecha com clique no fundo (backdrop)
  await page.mouse.click(10, 300); // fora do modal (centro em 720, ~450)
  await expect(modal).toHaveCount(0);
});
