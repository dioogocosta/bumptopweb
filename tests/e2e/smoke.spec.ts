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
        importFiles(files: File[], at?: { x: number; y: number; z: number }): Promise<unknown>;
        createFolder(
          name: string,
          at?: { x: number; y: number; z: number },
        ): Promise<{ id: string; name: string } | null>;
        deleteFsObject(id: string): Promise<boolean>;
        moveInto(srcId: string, dirId: string): Promise<boolean>;
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

  // Nota criada com o texto no meta (PR9: o texto vive na textura da face, sem label DOM)
  const nota = await page.evaluate((nid: string) => {
    const o = window.__bumptop!.world.getObject(nid)!;
    return {
      isSticky: window.__bumptop!.world.isStickyNote(nid),
      texto: (o.meta.noteText as string) ?? '',
    };
  }, id);
  expect(nota.isSticky).toBe(true);
  expect(nota.texto).toBe('hello');

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

  // Editor WYSIWYG (PR13) abre → escreve e fecha (Fechar salva)
  const editor = page.locator('[data-testid="note-rich"]');
  await expect(editor).toBeVisible();
  await editor.locator('.note-rich-content').fill('nota do teste');
  await editor.locator('.note-rich-done').click(); // Fechar salva
  await expect(editor).toHaveCount(0);

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

test('P1: Nova pasta no menu do chão cria pasta virtual na cena (item 6)', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });

  // Aguarda os itens assentarem
  await page.waitForFunction(() => {
    const w = window.__bumptop?.world;
    if (!w) return false;
    const objs = w.listObjects();
    return objs.length >= 3 && objs.slice(0, 3).every((o: any) => o.pose.position.y <= 2.0);
  }, { timeout: 15000 });

  const box = (await page.locator('#scene-root canvas').boundingBox())!;
  // Ponto do chão livre (canto inferior direito do canvas)
  const floorPoint = { x: box.x + 60, y: box.y + 60 };
  await page.mouse.click(floorPoint.x, floorPoint.y, { button: 'right' });
  const menu = page.locator('.ctx-menu');
  await expect(menu).toBeVisible();

  const pastaItem = menu.locator('.radial-btn-label, .ctx-item').filter({ hasText: 'Nova pasta' }).first();
  await expect(pastaItem).toBeVisible();
  await pastaItem.click();

  await expect(page.locator('.toast').filter({ hasText: 'criada' })).toBeVisible();

  // A pasta está na cena com isDir + fsPath e o diretório existe no OPFS
  const pasta = await page.evaluate(async () => {
    const w = window.__bumptop!.world;
    const obj = w.listObjects().find((o: any) => o.meta.isDir === true);
    if (!obj) return null;
    const dirExiste = await navigator.storage
      .getDirectory()
      .then((r) => r.getDirectoryHandle('Nova pasta'))
      .then(() => true)
      .catch(() => false);
    return { id: obj.id, fsPath: obj.meta.fsPath, dirExiste };
  });
  expect(pasta).not.toBeNull();
  expect(pasta!.fsPath).toBe('/Nova pasta');
  expect(pasta!.dirExiste).toBe(true);

  // Cleanup: remove o objeto e a pasta do OPFS
  await page.evaluate(async (id) => {
    window.__bumptop!.world.removeObject(id!);
    await navigator.storage.getDirectory().then((r) => r.removeEntry('Nova pasta', { recursive: true }));
  }, pasta!.id);
  await page.waitForTimeout(300);
});

test('P1: soltar arquivo sobre a pasta no MEIO da sala move o arquivo (fix do drop)', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });
  await page.waitForFunction(() => {
    const w = window.__bumptop?.world;
    if (!w) return false;
    const objs = w.listObjects();
    return objs.length >= 3 && objs.slice(0, 3).every((o: any) => o.pose.position.y <= 2.0);
  }, { timeout: 15000 });

  // Cena limpa: pasta no CENTRO da sala (longe das paredes e dos objetos
  // demo) + arquivo REAL no OPFS solto ao lado — o cenário que falhava: o
  // arrastado está sob o cursor (d≈0) e "ganhava" o pick no pointerUp,
  // impedindo de detectar a pasta embaixo.
  const ids = await page.evaluate(async () => {
    const w = window.__bumptop!.world;
    for (const o of w.listObjects()) w.removeObject(o.id);
    const root = await navigator.storage.getDirectory();
    for (const n of ['__drop_pasta__', '__drop_arq__.txt']) {
      await root.removeEntry(n, { recursive: true }).catch(() => {});
    }
    await root
      .getFileHandle('__drop_arq__.txt', { create: true })
      .then((h) => h.createWritable())
      .then((s) => s.write('conteudo e2e drop').then(() => s.close()));
    const pasta = (await window.__bumptop!.files.createFolder('__drop_pasta__'))!.id;
    const arq = w.addBox(
      { x: 40, y: 1.7, z: 20 },
      { x: 7, y: 1.6, z: 7 },
      '#4f9cff',
      '__drop_arq__',
      { fsPath: '/__drop_arq__.txt', isDir: false },
    );
    return { pasta, arq };
  });

  // Assenta a física e confere que os dois estão visíveis na tela
  await page.waitForFunction(() => {
    const w = window.__bumptop!.world;
    return w.listObjects().length === 2 && w.listObjects().every((o: any) => o.pose.position.y <= 2.2);
  }, { timeout: 10000 });
  const tela = await page.evaluate((ids) => {
    const p1 = window.__bumptop!.renderer.projectToScreen(window.__bumptop!.world.getObject(ids.pasta)!.pose.position);
    const p2 = window.__bumptop!.renderer.projectToScreen(window.__bumptop!.world.getObject(ids.arq)!.pose.position);
    return { pasta: p1, arq: p2 };
  }, ids);
  expect(tela.pasta.visible).toBe(true);
  expect(tela.arq.visible).toBe(true);

  const box = (await page.locator('#scene-root canvas').boundingBox())!;
  // Drag REAL: down no arquivo → move até a pasta → espera a mola → up
  await page.mouse.move(box.x + tela.arq.x, box.y + tela.arq.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(
      box.x + tela.arq.x + ((tela.pasta.x - tela.arq.x) * i) / 12,
      box.y + tela.arq.y + ((tela.pasta.y - tela.arq.y) * i) / 12,
    );
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(2200); // mola converge
  await page.mouse.up();

  // O ícone do arquivo sai da cena E o arquivo entra na pasta no OPFS —
  // as DUAS provas (o ícone sumir sozinho pode ser o watcher removendo um
  // fsPath sem listing; o arquivo dentro da pasta só acontece com moveInto)
  await page.waitForFunction(
    (id) => window.__bumptop!.world.getObject(id) === null,
    ids.arq,
    { timeout: 8000 },
  );
  const dentro = await page.evaluate(async () =>
    navigator.storage
      .getDirectory()
      .then((r) => r.getDirectoryHandle('__drop_pasta__'))
      .then((d) => d.getFileHandle('__drop_arq__.txt'))
      .then(() => true)
      .catch(() => false),
  );
  expect(dentro).toBe(true);

  // Cleanup
  await page.evaluate(async (ids) => {
    window.__bumptop!.world.removeObject(ids.pasta);
    const root = await navigator.storage.getDirectory();
    for (const n of ['__drop_pasta__', '__drop_arq__.txt']) {
      await root.removeEntry(n, { recursive: true }).catch(() => {});
    }
  }, ids);
});

test('P1: excluir pasta remove ícone + diretório OPFS e o watcher não recria', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });
  await page.waitForFunction(() => {
    const w = window.__bumptop?.world;
    if (!w) return false;
    const objs = w.listObjects();
    return objs.length >= 3 && objs.slice(0, 3).every((o: any) => o.pose.position.y <= 2.0);
  }, { timeout: 15000 });

  // Cria a pasta pelo FileService (mesmo caminho do menu)
  const id = await page.evaluate(async () => {
    window.__bumptop!.world
      .listObjects()
      .filter((o: any) => o.label === '__del_pasta__')
      .forEach((o: any) => window.__bumptop!.world.removeObject(o.id));
    await navigator.storage.getDirectory().then((r) => r.removeEntry('__del_pasta__', { recursive: true }).catch(() => {}));
    const r = await window.__bumptop!.files.createFolder('__del_pasta__');
    return r!.id;
  });
  await page.waitForTimeout(700);

  // Exclui pelo MENU REAL do objeto (botão direito → Excluir)
  const tela = await page.evaluate((oid) => {
    const pos = window.__bumptop!.world.getObject(oid)!.pose.position;
    return window.__bumptop!.renderer.projectToScreen(pos);
  }, id);
  const box = (await page.locator('#scene-root canvas').boundingBox())!;
  await page.mouse.click(box.x + tela.x, box.y + tela.y, { button: 'right' });
  const menu = page.locator('.ctx-menu');
  await expect(menu).toBeVisible();
  const excluir = menu.locator('.radial-btn-label, .ctx-item').filter({ hasText: 'Excluir' }).first();
  await expect(excluir).toBeVisible();
  await excluir.click();

  // Ícone fora da cena
  await expect.poll(async () => page.evaluate((oid) => window.__bumptop!.world.getObject(oid) === null, id)).toBe(true);

  // Diretório apagado do OPFS (modo sandbox) — o delete é fire-and-forget
  // no handler (removeObject é sync, fs.remove é async): espera com folga
  await expect.poll(
    async () =>
      page.evaluate(async () =>
        navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('__del_pasta__')).then(() => true).catch(() => false),
      ),
    { timeout: 8000 },
  ).toBe(false);

  // O watcher (5 s) NÃO recria o ícone — antes, a pasta "ressuscitava"
  await page.waitForTimeout(6200);
  expect(await page.evaluate((oid) => window.__bumptop!.world.getObject(oid) === null, id)).toBe(true);
});

test.describe('PR8', () => {
  test('arrastar arquivo DO SO para a cena cria o objeto com conteúdo real', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });
    await page.waitForFunction(() => {
      const w = window.__bumptop?.world;
      return !!w && w.listObjects().length >= 3;
    }, { timeout: 15000 });

    // Simula o drop do SO: DataTransfer com um File real + coords do centro-baixo
    await page.evaluate(async () => {
      const w = window.__bumptop!.world;
      // limpa restos de execuções anteriores
      for (const o of w.listObjects()) {
        if (o.label === '__drop_os__.txt') w.removeObject(o.id);
      }
      await navigator.storage
        .getDirectory()
        .then((r) => r.removeEntry('__drop_os__.txt', { recursive: true }).catch(() => {}));
      const canvas = document.querySelector('#scene-root canvas')!;
      const rect = canvas.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.items.add(new File(['conteudo via arraste'], '__drop_os__.txt', { type: 'text/plain' }));
      const cx = rect.left + rect.width * 0.55;
      const cy = rect.top + rect.height * 0.6;
      canvas.dispatchEvent(
        new DragEvent('dragover', { dataTransfer: dt, clientX: cx, clientY: cy, bubbles: true }),
      );
      if (!canvas.classList.contains('drop-file')) throw new Error('sem realce de arraste');
      canvas.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, clientX: cx, clientY: cy, bubbles: true }),
      );
      if (canvas.classList.contains('drop-file')) throw new Error('realce não saiu');
    });

    // Objeto criado com fsPath do arquivo
    await page.waitForFunction(
      () => {
        const w = window.__bumptop!.world;
        return w.listObjects().some((o: any) => o.meta.fsPath === '/__drop_os__.txt');
      },
      { timeout: 8000 },
    );

    // Conteúdo REAL no OPFS (prova de que não é só ícone)
    const existe = await page.evaluate(async () =>
      navigator.storage
        .getDirectory()
        .then((r) => r.getFileHandle('__drop_os__.txt'))
        .then((h) => h.getFile())
        .then((f) => f.text())
        .catch(() => null),
    );
    expect(existe).toBe('conteudo via arraste');

    // Cleanup
    await page.evaluate(() => {
      const w = window.__bumptop!.world;
      for (const o of w.listObjects()) {
        if (o.meta.fsPath === '/__drop_os__.txt') w.removeObject(o.id);
      }
    });
    await page.evaluate(async () => {
      await navigator.storage
        .getDirectory()
        .then((r) => r.removeEntry('__drop_os__.txt', { recursive: true }).catch(() => {}));
    });
  });

  test('clique na nota lê o conteúdo completo; card mostra texto truncado', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });
    await page.waitForFunction(() => {
      const w = window.__bumptop?.world;
      return !!w && w.listObjects().length >= 3;
    }, { timeout: 15000 });

    // Nota com texto LONGO (> 40 chars — antes era cortado em 40 sem "…")
    const textoLongo =
      'Primeira linha da nota com bastante texto para estourar o tamanho do card. ' +
      'Segunda linha continua o conteudo para garantir o truncamento visual. ' +
      'Terceira linha fecha o teste com mais caracteres ainda.';
    const id = await page.evaluate((txt) => {
      const w = window.__bumptop!.world;
      for (const o of w.listObjects()) {
        if (w.isStickyNote(o.id) && (o.meta.noteText as string)?.startsWith('Primeira linha')) {
          w.removeObject(o.id);
        }
      }
      return w.addStickyNote({ x: 30, y: 6, z: 30 }, txt);
    }, textoLongo);
    await page.waitForTimeout(500);

    // PR9/PR14: nota NÃO tem mais label DOM (o texto vive na textura da face).
    // O CLIQUE abre o EDITOR RICO (sem o card escuro de leitura) — conteúdo
    // completo visível nele.
    const tela = await page.evaluate((oid) => {
      const pos = window.__bumptop!.world.getObject(oid)!.pose.position;
      return window.__bumptop!.renderer.projectToScreen(pos);
    }, id);
    const box = (await page.locator('#scene-root canvas').boundingBox())!;
    await page.mouse.click(box.x + tela.x, box.y + tela.y);
    const modal = page.locator('[data-testid="note-rich"]');
    await expect(modal).toBeVisible({ timeout: 4000 });
    // Card escuro de leitura (PR8) NÃO deve aparecer
    await expect(page.locator('[data-testid="file-preview"]')).toHaveCount(0);
    const mostrado = await page.locator('.note-rich-content').textContent();
    expect(mostrado).toContain(textoLongo); // conteúdo COMPLETO, não truncado

    // Fecha (Esc) e limpa
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await page.evaluate((oid) => window.__bumptop!.world.removeObject(oid), id);
  });
});

test.describe('PR9', () => {
  test('duplo-clique na pilha abre grade com painel de vidro + ✕; ✕ fecha a pilha', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });
    await page.waitForFunction(() => {
      const w = window.__bumptop?.world;
      return !!w && w.listObjects().length >= 3;
    }, { timeout: 15000 });

    const pastaId = await page.evaluate(async () => {
      const w = window.__bumptop!.world;
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('__p9_a__.txt', { recursive: true }).catch(() => {});
      await root
        .getFileHandle('__p9_a__.txt', { create: true })
        .then((h) => h.createWritable())
        .then((s) => s.write('a').then(() => s.close()));
      // diretório real da base (o watcher de 5s remove objetos com fsPath inexistente)
      await root.getDirectoryHandle('__p9_base__', { create: true });
      const arq = w.addBox(
        { x: 0, y: 1.7, z: 0 },
        { x: 7, y: 1.6, z: 7 },
        '#4f9cff',
        '__p9_a__',
        { fsPath: '/__p9_a__.txt', isDir: false },
      );
      const base = w.addBox(
        { x: 6, y: 1.7, z: 0 },
        { x: 7, y: 1.6, z: 7 },
        '#4f9cff',
        '__p9_base__',
        { fsPath: '/__p9_base__', isDir: true },
      );
      w.addToPile(base, arq);
      return base;
    });
    await page.waitForTimeout(600);

    const telaBase = await page.evaluate((oid) => {
      const pos = window.__bumptop!.world.getObject(oid)!.pose.position;
      return window.__bumptop!.renderer.projectToScreen(pos);
    }, pastaId);
    const box = (await page.locator('#scene-root canvas').boundingBox())!;
    await page.mouse.dblclick(box.x + telaBase.x, box.y + telaBase.y);

    await page.waitForFunction(
      (oid) => window.__bumptop!.world.isPileOpen(oid) === true,
      pastaId,
      { timeout: 8000 },
    );

    const closeBtn = page.locator('.pile-close-btn');
    await expect(closeBtn).toBeVisible({ timeout: 4000 });
    await closeBtn.click();
    await page.waitForFunction(
      (oid) => window.__bumptop!.world.isPileOpen(oid) === false,
      pastaId,
      { timeout: 8000 },
    );

    await page.evaluate((oid) => window.__bumptop!.world.removeObject(oid), pastaId);
    await page.evaluate(async () => {
      await navigator.storage
        .getDirectory()
        .then((r) => Promise.all([
          r.removeEntry('__p9_a__.txt', { recursive: true }).catch(() => {}),
          r.removeEntry('__p9_base__', { recursive: true }).catch(() => {}),
        ]));
    });
  });

  test('duplo-clique numa pasta abre o modal de vidro com o conteúdo', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });
    await page.waitForFunction(() => {
      const w = window.__bumptop?.world;
      return !!w && w.listObjects().length >= 3;
    }, { timeout: 15000 });

    const pastaId = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('__p9_pasta__', { recursive: true }).catch(() => {});
      // PRIMEIRO cria a pasta pelo FileService (senão o dedup renomeia p/ "(2)")
      const id = (await window.__bumptop!.files.createFolder('__p9_pasta__'))!.id;
      // DEPOIS cria o arquivo dentro dela
      await root
        .getDirectoryHandle('__p9_pasta__')
        .then((d) => d.getFileHandle('__p9_x__.txt', { create: true }))
        .then((h) => h.createWritable())
        .then((s) => s.write('conteudo x').then(() => s.close()));
      return id;
    });
    await page.waitForTimeout(600);

    const tela = await page.evaluate((oid) => {
      const pos = window.__bumptop!.world.getObject(oid)!.pose.position;
      return window.__bumptop!.renderer.projectToScreen(pos);
    }, pastaId);
    const box = (await page.locator('#scene-root canvas').boundingBox())!;
    await page.mouse.dblclick(box.x + tela.x, box.y + tela.y);

    const modal = page.locator('[data-testid="folder-modal"]');
    await expect(modal).toBeVisible({ timeout: 6000 });
    const nomes = await modal.locator('.folder-item-name').allTextContents();
    expect(nomes).toContain('__p9_x__.txt');

    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);

    await page.evaluate((oid) => window.__bumptop!.world.removeObject(oid), pastaId);
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('__p9_pasta__', { recursive: true }).catch(() => {});
    });
  });
});

test.describe('PR10', () => {
  test('item pregado desliza na parede (continua pregado) e desprega arrastando ao chão', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });
    await page.waitForFunction(() => {
      const w = window.__bumptop?.world;
      return !!w && w.listObjects().length >= 3;
    }, { timeout: 15000 });
    const box = (await page.locator('#scene-root canvas').boundingBox())!;

    // Objeto de teste pregado na parede norte, baixado p/ dentro do viewport
    // (a câmera corta o topo da parede: y=22 sai da tela — placeAt é private
    // do TS mas acessível em runtime).
    const itemId = await page.evaluate(() => {
      const w = window.__bumptop!.world;
      const id = w.addBox({ x: 0, y: 1.7, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#4f9cff', '__p10_parede__');
      w.pinToWall(id, 0);
      const runtime = w as unknown as {
        entries: Map<string, { data: { pose: { position: { z: number } } } }>;
        placeAt: (e: unknown, p: { x: number; y: number; z: number }) => void;
      };
      const e = runtime.entries.get(id)!;
      runtime.placeAt(e, { x: 0, y: 12, z: e.data.pose.position.z });
      return id;
    });
    await page.waitForTimeout(300);

    const telaItem = await page.evaluate((oid) => {
      const pos = window.__bumptop!.world.getObject(oid)!.pose.position;
      return window.__bumptop!.renderer.projectToScreen(pos);
    }, itemId);
    // Arrasta ao longo da parede (x deslocado p/ oeste — longe do botão
    // "reset câmera" no topo, que cobre o canto NE da tela no mobile)
    const telaAlvo = await page.evaluate((oid) => {
      const w = window.__bumptop!.world;
      const z = w.getObject(oid)!.pose.position.z;
      return window.__bumptop!.renderer.projectToScreen({ x: -30, y: 16, z });
    }, itemId);
    await page.mouse.move(box.x + telaItem.x, box.y + telaItem.y);
    await page.mouse.down();
    await page.mouse.move(box.x + telaAlvo.x, box.y + telaAlvo.y, { steps: 10 });
    await page.waitForTimeout(200);
    const pos1 = await page.evaluate((oid) => {
      const o = window.__bumptop!.world.getObject(oid)!;
      return { x: o.pose.position.x, pin: o.pinnedWall };
    }, itemId);
    expect(pos1.pin).toBe(0); // deslizou e CONTINUA pregado
    expect(Math.abs(pos1.x + 30)).toBeLessThan(6);
    // Soltar na parede mantém pregado
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await page.evaluate((oid) => window.__bumptop!.world.getObject(oid)!.pinnedWall, itemId)).toBe(0);

    // Agora arrasta apontando para o chão → desprega
    const tela2 = await page.evaluate((oid) => {
      const pos = window.__bumptop!.world.getObject(oid)!.pose.position;
      return window.__bumptop!.renderer.projectToScreen(pos);
    }, itemId);
    const telaChao = await page.evaluate(() =>
      window.__bumptop!.renderer.projectToScreen({ x: -20, y: 0, z: 20 }));
    await page.mouse.move(box.x + tela2.x, box.y + tela2.y);
    await page.mouse.down();
    await page.mouse.move(box.x + telaChao.x, box.y + telaChao.y, { steps: 12 });
    await page.waitForTimeout(250);
    const despregou = await page.evaluate((oid) => window.__bumptop!.world.getObject(oid)!.pinnedWall === null, itemId);
    await page.mouse.up();
    expect(despregou).toBe(true);

    await page.evaluate((oid) => window.__bumptop!.world.removeObject(oid), itemId);
  });

  test('imagem importada vira quadro; botão direito → Configurações da imagem → moldura on/off', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });
    await page.waitForFunction(() => {
      const w = window.__bumptop?.world;
      return !!w && w.listObjects().length >= 3;
    }, { timeout: 15000 });
    const box = (await page.locator('#scene-root canvas').boundingBox())!;

    const fotoId = await page.evaluate(async () => {
      const w = window.__bumptop!.world;
      for (const o of w.listObjects()) {
        if ((o.meta.fsPath || '').startsWith('/__p10_foto')) w.removeObject(o.id);
      }
      await navigator.storage
        .getDirectory()
        .then((r) => r.removeEntry('__p10_foto.png', { recursive: true }))
        .catch(() => {});
      const c = document.createElement('canvas');
      c.width = 40;
      c.height = 20;
      const cx = c.getContext('2d')!;
      cx.fillStyle = '#e11';
      cx.fillRect(0, 0, 40, 20);
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
      const file = new File([blob], '__p10_foto.png', { type: 'image/png' });
      await window.__bumptop!.files.importFiles([file], { x: 24, y: 2, z: 24 });
      return w.listObjects().find((o: { meta: { fsPath?: string } }) => o.meta.fsPath === '/__p10_foto.png')?.id ?? null;
    });
    // moldura composta assincronamente (spawnIcon)
    await page.waitForFunction((oid) => window.__bumptop!.world.getObject(oid)?.meta.photoFrame === true, fotoId, { timeout: 8000 });

    // Botão direito na foto → menu → "Configurações da imagem…" → secundário
    const tela = await page.evaluate((oid) => {
      const pos = window.__bumptop!.world.getObject(oid)!.pose.position;
      return window.__bumptop!.renderer.projectToScreen(pos);
    }, fotoId);
    await page.mouse.click(box.x + tela.x, box.y + tela.y, { button: 'right' });
    await page.getByRole('button', { name: /Configurações da imagem/ }).click();
    await page.getByRole('button', { name: /Moldura de quadro/ }).click(); // desliga
    await page.waitForFunction((oid) => window.__bumptop!.world.getObject(oid)?.meta.photoFrame === false, fotoId, { timeout: 5000 });

    // Liga de novo
    await page.mouse.click(box.x + tela.x, box.y + tela.y, { button: 'right' });
    await page.getByRole('button', { name: /Configurações da imagem/ }).click();
    await page.getByRole('button', { name: /Moldura de quadro/ }).click();
    await page.waitForFunction((oid) => window.__bumptop!.world.getObject(oid)?.meta.photoFrame === true, fotoId, { timeout: 5000 });

    await page.evaluate((oid) => window.__bumptop!.world.removeObject(oid), fotoId);
    await page.evaluate(async () => {
      await navigator.storage
        .getDirectory()
        .then((r) => r.removeEntry('__p10_foto.png', { recursive: true }))
        .catch(() => {});
    });
  });

  test('pasta mostra contador que muda com moveInto; modal tira (⇪) e exclui (✕)', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });
    await page.waitForFunction(() => {
      const w = window.__bumptop?.world;
      return !!w && w.listObjects().length >= 3;
    }, { timeout: 15000 });
    const box = (await page.locator('#scene-root canvas').boundingBox())!;

    const pastaId = await page.evaluate(async () => {
      const w = window.__bumptop!.world;
      for (const o of w.listObjects()) {
        if ((o.meta.fsPath || '').includes('__p10_pasta')) w.removeObject(o.id);
      }
      await navigator.storage
        .getDirectory()
        .then((r) => r.removeEntry('__p10_pasta__', { recursive: true }))
        .catch(() => {});
      const id = (await window.__bumptop!.files.createFolder('__p10_pasta__'))!.id;
      await new Promise((r) => setTimeout(r, 400)); // contador (0) é pintado assincronamente
      return id;
    });
    const thumb0 = await page.evaluate((oid) => window.__bumptop!.world.getObject(oid)?.meta.thumb ?? null, pastaId);
    expect(thumb0).toMatch(/^data:image\//);

    // moveInto: contador repinta
    await page.evaluate(async (oid) => {
      await navigator.storage
        .getDirectory()
        .then((r) => r.getFileHandle('__p10_m2__.txt', { create: true }))
        .then((h) => h.createWritable())
        .then((s) => s.write('m2').then(() => s.close()));
      const w = window.__bumptop!.world;
      const fid = w.addBox({ x: -24, y: 1.7, z: 24 }, { x: 7, y: 1.6, z: 7 }, '#4f9cff', '__p10_m2__', { fsPath: '/__p10_m2__.txt', isDir: false });
      await window.__bumptop!.files.moveInto(fid, oid);
    }, pastaId);
    await page.waitForTimeout(600);
    const thumb1 = await page.evaluate((oid) => window.__bumptop!.world.getObject(oid)?.meta.thumb ?? null, pastaId);
    expect(thumb1).not.toBe(thumb0); // contador repintou

    // Modal: ⇪ tira para a mesa (+1 objeto)
    const antes = await page.evaluate(() => window.__bumptop!.world.listObjects().length);
    const tela = await page.evaluate((oid) => {
      const pos = window.__bumptop!.world.getObject(oid)!.pose.position;
      return window.__bumptop!.renderer.projectToScreen(pos);
    }, pastaId);
    await page.mouse.dblclick(box.x + tela.x, box.y + tela.y);
    const modal = page.locator('[data-testid="folder-modal"]');
    await expect(modal).toBeVisible({ timeout: 6000 });
    const item = modal.locator('.folder-item').first();
    await item.hover();
    await page.waitForTimeout(150);
    await item.locator('.folder-item-act').first().click(); // ⇪ tirar
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => window.__bumptop!.world.listObjects().length)).toBe(antes + 1);
    // ícone extraído existe com o caminho na raiz
    expect(
      await page.evaluate(() =>
        window.__bumptop!.world.listObjects().some((o: { meta: { fsPath?: string } }) => o.meta.fsPath === '/__p10_m2__.txt')),
    ).toBe(true);

    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);

    // limpeza
    await page.evaluate(async () => {
      const w = window.__bumptop!.world;
      for (const o of w.listObjects()) {
        if ((o.meta.fsPath || '').includes('__p10_')) w.removeObject(o.id);
      }
      const root = await navigator.storage.getDirectory();
      await Promise.all([
        root.removeEntry('__p10_pasta__', { recursive: true }).catch(() => {}),
        root.removeEntry('__p10_m2__.txt', { recursive: true }).catch(() => {}),
        root.removeEntry('__p10_foto.png', { recursive: true }).catch(() => {}),
      ]);
    });
  });
});

test.describe('PR13', () => {
  test('nota abre o editor WYSIWYG GRANDE; negrito renderiza ao vivo e persiste', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });
    await page.waitForFunction(() => {
      const w = window.__bumptop?.world;
      return !!w && w.listObjects().length >= 3;
    }, { timeout: 15000 });
    const box = (await page.locator('#scene-root canvas').boundingBox())!;

    const notaId = await page.evaluate(() => {
      const w = window.__bumptop!.world;
      for (const o of w.listObjects()) {
        if ((o.meta.noteText || '').includes('__p13_e2e__')) w.removeObject(o.id);
      }
      return w.addStickyNote({ x: 40, y: 1.2, z: -40 }, 'texto p13 e2e');
    });
    await page.waitForTimeout(300);
    const tela = await page.evaluate((oid) => {
      const pos = window.__bumptop!.world.getObject(oid)!.pose.position;
      return window.__bumptop!.renderer.projectToScreen(pos);
    }, notaId);

    // Duplo-clique → modal WYSIWYG GRANDE (≥80% largura)
    await page.mouse.dblclick(box.x + tela.x, box.y + tela.y);
    const modal = page.locator('[data-testid="note-rich"]');
    await expect(modal).toBeVisible({ timeout: 5000 });
    const largura = await modal.evaluate(
      (el) => el.getBoundingClientRect().width / window.innerWidth,
    );
    expect(largura).toBeGreaterThanOrEqual(0.8);

    // WYSIWYG: seleciona "p13 e2e" e aplica B → <b> NO ATO (sem ** visível)
    const editor = page.locator('.note-rich-content');
    await expect(editor).toBeVisible();
    await editor.evaluate((el) => {
      const line = el.querySelector('.nl-line')!;
      const r = document.createRange();
      r.selectNodeContents(line);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
    await page.locator('.note-rich-tool').filter({ hasText: 'Aa ▾' }).click();
    await page.locator('.note-rich-fmt-item').filter({ hasText: /^B$/ }).click();
    await expect(editor.locator('b')).toHaveCount(1);
    // Sem marcadores visíveis no texto renderizado
    expect(await editor.textContent()).not.toContain('**');
    // H1 na linha do cursor → classe nl-h1, sem # visível
    await page.locator('.note-rich-tool').filter({ hasText: 'Aa ▾' }).click();
    await page.locator('.note-rich-fmt-item').filter({ hasText: /^H1$/ }).click();
    await expect(editor.locator('.nl-h1')).toHaveCount(1);
    expect(await editor.textContent()).not.toContain('#');

    // Cor de fundo pela paleta
    await page.locator('.note-rich-tool').filter({ hasText: '🎨' }).click();
    await page.locator('.note-rich-swatch').nth(2).click();

    // Fechar salva → meta atualizada (modelo continua markdown-lite)
    await page.locator('.note-rich-done').click();
    await expect(modal).toHaveCount(0);
    await page.waitForTimeout(600);
    const meta = await page.evaluate((oid) => {
      const o = window.__bumptop!.world.getObject(oid)!;
      return { bg: o.meta.noteBg, text: o.meta.noteText, thumb: o.meta.thumb };
    }, notaId);
    expect(meta.bg).toBe('#f28b82');
    expect(meta.text).toContain('**');
    expect((meta.thumb as string).startsWith('data:image/png')).toBe(true);

    // limpeza
    await page.evaluate((oid) => window.__bumptop!.world.removeObject(oid), notaId);
  });

  test('checkbox clicável com riscado e lembrete ⏰ funcionam no editor', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window.__bumptop, { timeout: 20000 });
    await page.waitForFunction(() => {
      const w = window.__bumptop?.world;
      return !!w && w.listObjects().length >= 3;
    }, { timeout: 15000 });
    const box = (await page.locator('#scene-root canvas').boundingBox())!;

    const notaId = await page.evaluate(() => {
      const w = window.__bumptop!.world;
      for (const o of w.listObjects()) {
        if ((o.meta.noteText || '').includes('comprar leite p13')) w.removeObject(o.id);
      }
      return w.addStickyNote({ x: -40, y: 1.2, z: -40 }, 'comprar leite p13');
    });
    await page.waitForTimeout(300);
    const tela = await page.evaluate((oid) => {
      const pos = window.__bumptop!.world.getObject(oid)!.pose.position;
      return window.__bumptop!.renderer.projectToScreen(pos);
    }, notaId);
    await page.mouse.dblclick(box.x + tela.x, box.y + tela.y);
    const modal = page.locator('[data-testid="note-rich"]');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Checklist: ☑ cria item com box clicável (precisa do cursor numa linha)
    const editor = page.locator('.note-rich-content');
    await editor.click();
    await page.locator('.note-rich-tool').filter({ hasText: '☑' }).click();
    const item = page.locator('.note-rich-content .nl-item');
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute('data-done', '0');
    // Clicar NO box marca ✓ (e o texto fica riscado)
    await item.locator('.nl-box').click();
    await expect(item).toHaveAttribute('data-done', '1');
    const riscado = await item.evaluate(
      (el) => getComputedStyle(el.querySelector('.nl-text')!).textDecorationLine,
    );
    expect(riscado).toContain('line-through');

    // Lembrete: popover ⏰ → "Amanhã 08:00" → chip aparece
    await page.locator('.note-rich-tool').filter({ hasText: '⏰' }).click();
    await page.locator('.note-rich-remind-row').filter({ hasText: 'Amanhã' }).click();
    await expect(page.locator('.note-rich-remind-info')).toContainText('⏰');

    // Fechar salva → modelo "- [x] " + meta.noteReminder amanhã 08:00
    await page.locator('.note-rich-done').click();
    await expect(modal).toHaveCount(0);
    await page.waitForTimeout(500);
    const salvo = await page.evaluate((oid) => {
      const o = window.__bumptop!.world.getObject(oid)!;
      return {
        text: o.meta.noteText as string,
        at: o.meta.noteReminder,
        fired: o.meta.noteReminderFired,
      };
    }, notaId);
    expect(salvo.text).toContain('- [x] comprar leite p13');
    expect(typeof salvo.at).toBe('number');
    expect(new Date(salvo.at as number).getHours()).toBe(8);
    expect(salvo.fired).toBe(false);

    await page.evaluate((oid) => window.__bumptop!.world.removeObject(oid), notaId);
  });
});
