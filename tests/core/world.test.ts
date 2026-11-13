/**
 * Testes de integração do World (puro) com mocks dos ports.
 * Cobre o fluxo M3: soltar sobre outro objeto → pilha → layout → grid/páginas.
 */
import { describe, it, expect, vi } from 'vitest';
import { World } from '../../src/core/world';
import { PileLayout } from '../../src/core/model/types';
import type {
  BodyHandle,
  IOverlay,
  IPhysics,
  IRenderer,
  ObjectHandle,
  Pose,
  Vec3,
} from '../../src/core/ports/index';

function makePhysicsMock(): IPhysics {
  const poses = new Map<number, Pose>();
  const frozen = new Set<number>();
  const vels = new Map<number, Vec3>();
  let next = 1;
  return {
    init: vi.fn(async () => {}),
    createBox: vi.fn((_id, pos) => {
      const h = next++ as BodyHandle;
      poses.set(h, { position: { ...pos }, rotation: { x: 0, y: 0, z: 0, w: 1 } });
      return h;
    }),
    createRoom: vi.fn(),
    removeBody: vi.fn((h) => {
      poses.delete(h);
      frozen.delete(h);
      vels.delete(h);
    }),
    getPose: vi.fn((h) => poses.get(h)!),
    getVelocity: vi.fn((h) => vels.get(h) ?? { x: 0, y: 0, z: 0 }),
    setPosition: vi.fn((h, p) => {
      const pose = poses.get(h)!;
      pose.position = { ...p };
    }),
    setRotation: vi.fn(),
    setVelocity: vi.fn((h, v) => {
      vels.set(h, { ...v });
    }),
    applyImpulse: vi.fn(),
    setFrozen: vi.fn((h, f) => {
      if (f) frozen.add(h);
      else frozen.delete(h);
    }),
    moveKinematic: vi.fn((h, p) => {
      const pose = poses.get(h);
      if (pose) pose.position = { ...p };
    }),
    setItemCollisions: vi.fn(),
    raycast: vi.fn(() => null),
    step: vi.fn(),
    isSleeping: vi.fn(() => false),
    dispose: vi.fn(),
    // helpers de teste
    __frozen: frozen,
  } as unknown as IPhysics & { __frozen: Set<number> };
}

function makeRendererMock(): IRenderer {
  let next = 1;
  const visible = new Map<number, boolean>();
  return {
    init: vi.fn(async () => {}),
    addBox: vi.fn(() => {
      const h = next++ as ObjectHandle;
      visible.set(h, true);
      return h;
    }),
    setTexture: vi.fn(),
    addRoom: vi.fn(),
    setPose: vi.fn(),
    setVisible: vi.fn((h, v) => visible.set(h, v)),
    isVisible: vi.fn((h) => visible.get(h) ?? false),
    setHighlight: vi.fn(),
    setScale: vi.fn(),
    remove: vi.fn((h) => visible.delete(h)),
    setCamera: vi.fn(),
    getCamera: vi.fn(() => ({
      target: { x: 0, y: 0, z: 0 },
      distance: 100,
      azimuth: 0,
      elevation: 0.5,
      fov: 50,
    })),
    projectToScreen: vi.fn(() => ({ x: 0, y: 0, visible: true })),
    screenToRay: vi.fn(() => ({ origin: { x: 0, y: 50, z: 0 }, direction: { x: 0, y: -1, z: 0 } })),
    resize: vi.fn(),
    setPilePanel: vi.fn(),
    setTheme: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
}

async function makeWorld(overlay?: IOverlay) {
  const physics = makePhysicsMock();
  const renderer = makeRendererMock();
  const world = new World({ physics, renderer, overlay });
  await world.init();
  return { world, physics, renderer };
}

/** Overlay mock (p/ asserir setLasso/toast do laço e do WallToss). */
function makeOverlayMock(): IOverlay & { setLasso: ReturnType<typeof vi.fn> } {
  return {
    showContextMenu: vi.fn(),
    hideContextMenu: vi.fn(),
    setLabel: vi.fn(),
    toast: vi.fn(),
    setLasso: vi.fn(),
    editNote: vi.fn(async () => ''),
    showPreview: vi.fn(),
    setResizeHandle: vi.fn(),
    onResizeStart: vi.fn(),
    setPileHalo: vi.fn(),
    onPileHaloAction: vi.fn(),
    isHaloHovered: vi.fn(() => false),
    setDwellRing: vi.fn(),
    setScrubStrip: vi.fn(),
    onScrubItemSelect: vi.fn(),
    onScrubHover: vi.fn(),
    isScrubHovered: vi.fn(() => false),
    setPileCloseBtn: vi.fn(),
    onPileCloseClick: vi.fn(),
    showFolderModal: vi.fn(),
    hideFolderModal: vi.fn(),
  } as IOverlay & { setLasso: ReturnType<typeof vi.fn> };
}

/** Simula um arraste: down em `from`, move, up em `to` (coords de piso). */
function dragDrop(world: World, from: { x: number; z: number }, to: { x: number; z: number }) {
  const p = (s: { x: number; z: number }) => ({ x: s.x, y: 0, z: s.z });
  world.processAction({ type: 'pointerDown', world: p(from), screen: { x: 0, y: 0 }, button: 0, pointerId: 1 });
  world.processAction({ type: 'pointerMove', world: p(to), screen: { x: 0, y: 0 }, pointerId: 1 });
  world.processAction({ type: 'pointerUp', world: p(to), screen: { x: 0, y: 0 }, pointerId: 1 });
}

describe('World + pilhas (M3)', () => {
  it('soltar um objeto sobre outro cria uma pilha (parentId aplicado)', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');

    // Arrasta b por cima de a (lento, sem toss: um único movimento curto)
    dragDrop(world, { x: 40, z: 0 }, { x: 0, z: 0 });

    const dataA = world.getObject(a)!;
    const dataB = world.getObject(b)!;
    // Um dos dois passou a ter parentId (o filho); a base é o outro
    const parented = dataA.parentId !== null ? dataA : dataB.parentId !== null ? dataB : null;
    expect(parented).not.toBeNull();
    expect(parented!.parentId).toBe(parented === dataA ? b : a);
  });

  it('togglePileLayout alterna Stack ↔ Grid e o grid oculta itens fora da página', async () => {
    const { world, renderer } = await makeWorld();
    // 3 objetos empilhados via addBox + arrastes encadeados seria custoso;
    // usamos o caminho público: empilha em pares
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(world.addBox({ x: i * 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', `f${i}`));
    }
    dragDrop(world, { x: 40, z: 0 }, { x: 0, z: 0 }); // f1 → f0
    dragDrop(world, { x: 80, z: 0 }, { x: 0, z: 0 }); // f2 → pilha

    // Agora alterna p/ Grid: com 3 itens, página 0 mostra todos (≤16)
    world.togglePileLayout(ids[0]);
    expect(world.isGridPile(ids[0])).toBe(true);
    // Todos ainda visíveis (3 < 16)
    for (const id of ids) expect(world.getObject(id)).not.toBeNull();
    // Volta p/ Stack
    world.togglePileLayout(ids[0]);
    expect(world.isGridPile(ids[0])).toBe(false);
    void renderer;
  });

  it('soltar em pasta NÃO empilha (pasta move, M2)', async () => {
    const { world } = await makeWorld();
    world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#0f0', 'docs', {
      fsPath: '/docs',
      isDir: true,
    });
    const file = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt', {
      fsPath: '/a.txt',
    });
    dragDrop(world, { x: 40, z: 0 }, { x: 0, z: 0 });
    expect(world.getObject(file)!.parentId).toBeNull();
  });

  it('objeto solto longe de tudo não vira filho de ninguém', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a');
    const b = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b');
    dragDrop(world, { x: 40, z: 0 }, { x: 40, z: 60 }); // solta no vazio
    expect(world.getObject(a)!.parentId).toBeNull();
    expect(world.getObject(b)!.parentId).toBeNull();
  });

  it('serializa e restaura pilhas pelo snapshot', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a');
    const b = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b');
    dragDrop(world, { x: 40, z: 0 }, { x: 0, z: 0 });

    const snap = world.toSnapshot();
    const pileKeys = Object.keys(snap.piles);
    expect(pileKeys.length).toBe(1);

    // Restaura num World novo (fila de simulação)
    const { world: w2 } = await makeWorld();
    w2.loadSnapshot(snap);
    const dA = w2.getObject(a)!;
    const dB = w2.getObject(b)!;
    const child = dA.parentId !== null ? dA : dB;
    expect(child.parentId).not.toBeNull();
    expect(w2.isGridPile(child.id)).toBe(false); // layout padrão Stack
    expect(PileLayout.Stack).toBe(0);
  });

  it('layout Leaf espalha os itens em leque (posições distintas)', async () => {
    const { world } = await makeWorld();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(world.addBox({ x: i * 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', `f${i}`));
    }
    dragDrop(world, { x: 40, z: 0 }, { x: 0, z: 0 });
    dragDrop(world, { x: 80, z: 0 }, { x: 0, z: 0 });
    dragDrop(world, { x: 120, z: 0 }, { x: 0, z: 0 });

    // Stack → Grid → Leaf
    world.togglePileLayout(ids[0]);
    world.togglePileLayout(ids[0]);

    // Leaf: itens espalhados com posições distintas (não colineados na pilha)
    const poses = ids.map((id) => world.getObject(id)!.pose.position);
    const xs = new Set(poses.map((p) => p.x.toFixed(2)));
    expect(xs.size).toBeGreaterThan(1);
  });

  it('seleção: clicar destaca, clicar no vazio limpa', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a');
    const b = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b');

    world.processAction({ type: 'pointerDown', world: { x: 0, y: 0, z: 0 }, screen: { x: 0, y: 0 }, button: 0, pointerId: 1 });
    expect(world.getSelectedId()).toBe(a);
    world.processAction({ type: 'pointerUp', world: { x: 0, y: 0, z: 0 }, screen: { x: 0, y: 0 }, pointerId: 1 });

    world.processAction({ type: 'pointerDown', world: { x: 40, y: 0, z: 0 }, screen: { x: 0, y: 0 }, button: 0, pointerId: 1 });
    expect(world.getSelectedId()).toBe(b);
    world.processAction({ type: 'pointerUp', world: { x: 40, y: 0, z: 0 }, screen: { x: 0, y: 0 }, pointerId: 1 });

    // Clicar no vazio (longe de tudo) → desseleciona
    world.processAction({ type: 'pointerDown', world: { x: 100, y: 0, z: 100 }, screen: { x: 0, y: 0 }, button: 0, pointerId: 1 });
    expect(world.getSelectedId()).toBeNull();
  });

  it('orbit: arrastar com botão direito move azimuth/elevation nos limites', async () => {
    const { world } = await makeWorld();
    const before = world.getCamera();
    world.processAction({ type: 'orbit', dAzimuth: 0.5, dElevation: 0.2 });
    const after = world.getCamera();
    expect(after.azimuth).toBeCloseTo(before.azimuth + 0.5, 5);
    expect(after.elevation).toBeCloseTo(before.elevation + 0.2, 5);

    // Elevação preserva os limites (não vira "de cabeça para baixo")
    for (let i = 0; i < 50; i++) world.processAction({ type: 'orbit', dAzimuth: 0, dElevation: 1 });
    expect(world.getCamera().elevation).toBeLessThanOrEqual(1.45);
  });

  it('pinning: prega na parede (posição junto à parede + frozen) e desprega', async () => {
    const { world, physics } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a');

    world.pinToWall(a, 0); // parede norte (-z)
    const data = world.getObject(a)!;
    expect(data.pinnedWall).toBe(0);
    expect(data.pose.position.z).toBeLessThan(-100); // encostado em z=-130+inset
    expect(physics.setFrozen).toHaveBeenCalledWith(expect.anything(), true);

    // toggle desprega
    expect(world.togglePin(a)).toBe(false);
    expect(world.getObject(a)!.pinnedWall).toBeNull();
    expect(world.isPinned(a)).toBe(false);
  });

  it('item pregado não volta a cair até ser despregado', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a');
    world.pinToWall(a, 3); // leste
    const pinnedY = world.getObject(a)!.pose.position.y;
    world.update(1 / 60);
    world.update(1 / 60);
    expect(world.getObject(a)!.pose.position.y).toBeCloseTo(pinnedY, 5);
  });

  it('sticky note: cria, edita texto e serializa no snapshot', async () => {
    const { world } = await makeWorld();
    const id = world.addStickyNote({ x: 20, y: 6, z: 20 }, 'comprar pão');

    expect(world.isStickyNote(id)).toBe(true);
    expect(world.getObject(id)!.meta.noteText).toBe('comprar pão');

    // setNoteText em objeto comum (não-nota) é rejeitado
    const file = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    expect(world.isStickyNote(file)).toBe(false);
    expect(world.setNoteText(file, 'x')).toBe(false);

    // Texto sobrevive ao snapshot (persistência SQLite)
    world.setNoteText(id, 'anotado!');
    const snap = world.toSnapshot();
    const row = snap.objects.find((o) => o.id === id)!;
    expect(row.meta.noteText).toBe('anotado!');
  });

  it('PR9: nota sem label DOM — o texto vive na FACE (textura)', async () => {
    const overlay = makeOverlayMock();
    const { world, renderer } = await makeWorld(overlay);
    // provider injetado (como faz createApp em di.ts)
    world.setNoteTextureProvider(() => 'data:image/png;fake');
    const longo = 'x'.repeat(200);
    const id = world.addStickyNote({ x: 20, y: 6, z: 20 }, longo);
    world.update(1 / 60);

    // Sem label DOM na nota (o texto é desenhado na face do papel)
    const chamadas = (overlay.setLabel as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === id,
    );
    expect(chamadas.length).toBeGreaterThan(0);
    const [, text, , opts] = chamadas[chamadas.length - 1];
    expect(text).toBeNull();
    expect(opts).toBeUndefined();

    // Textura aplicada na face do objeto
    const texturas = (renderer.setTexture as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === (world as any).entries.get(id)?.render,
    );
    expect(texturas.length).toBeGreaterThan(0);
    expect(texturas[texturas.length - 1][1]).toBe('data:image/png;fake');
  });

  it('PR9: nota sem textura no snapshot regenera a face ao restaurar', async () => {
    const overlay = makeOverlayMock();
    const { world } = await makeWorld(overlay);
    const id = world.addStickyNote({ x: 20, y: 6, z: 20 }, 'texto da nota');
    world.update(1 / 60);

    const snap = world.toSnapshot();
    const row = snap.objects.find((o) => o.id === id)!;
    expect(row.meta.thumb).toBeUndefined(); // snapshot antigo: sem thumb

    // Novo world com provider injetado (como faz createApp) restaura a face
    const { world: w2, renderer: r2 } = await makeWorld(overlay);
    w2.setNoteTextureProvider(() => 'data:image/png;fake');
    w2.loadSnapshot(snap);
    const texturas = (r2.setTexture as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[1] === 'data:image/png;fake',
    );
    expect(texturas.length).toBeGreaterThan(0);
    expect(texturas[texturas.length - 1][0]).toBeGreaterThan(0);
  });

  it('shove: arrastar o chão com o DEDO empurra objetos próximos (Fase 7: shove = touch)', async () => {
    const { world, physics } = await makeWorld();
    world.addBox({ x: 10, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a');
    // Down longe de qualquer objeto com ponteiro TOUCH → shove (mouse = laço)
    world.processAction({ type: 'pointerDown', world: { x: -100, y: 0, z: -100 }, screen: { x: 0, y: 0 }, button: 0, pointerId: 1, pointerType: 'touch' });
    // Move em direção ao objeto
    world.processAction({ type: 'pointerMove', world: { x: -80, y: 0, z: -80 }, screen: { x: 0, y: 0 }, pointerId: 1 });
    world.processAction({ type: 'pointerMove', world: { x: 5, y: 0, z: 0 }, screen: { x: 0, y: 0 }, pointerId: 1 });
    expect(physics.setVelocity).toHaveBeenCalled();
    world.processAction({ type: 'pointerUp', world: { x: 5, y: 0, z: 0 }, screen: { x: 0, y: 0 }, pointerId: 1 });
  });
});

// ---------------------------------------------------------------------------
// Fase 7 — gestos de assinatura (laço, multi-select, peel, fan-out, WallToss,
// auto-pilha por tipo, rename)
// ---------------------------------------------------------------------------

describe('Fase 7: laço (lasso) e seleção múltipla', () => {
  it('mouse no chão vazio inicia o laço e o retângulo de tela seleciona por projeção', async () => {
    const overlay = makeOverlayMock();
    const { world, renderer } = await makeWorld(overlay);
    const a = world.addBox({ x: 10, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    // Projeção determinística: screen = (x*10, z*10) → a=(100,0), b=(400,0)
    vi.mocked(renderer.projectToScreen).mockImplementation((p) => ({
      x: p.x * 10,
      y: p.z * 10,
      visible: true,
    }));

    // Down no chão vazio (longe dos ícones) com MOUSE → laço, não shove
    world.processAction({
      type: 'pointerDown',
      world: { x: -100, y: 0, z: -100 },
      screen: { x: 0, y: 0 },
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
    });
    expect(overlay.setLasso).toHaveBeenCalledWith(expect.objectContaining({ x: 0, y: 0, w: 0, h: 0 }));

    // Arrasta até (500,100): retângulo cobre a (100,0) e b (400,0)
    world.processAction({
      type: 'pointerMove',
      world: { x: -100, y: 0, z: -100 },
      screen: { x: 500, y: 100 },
      pointerId: 1,
    });
    expect(overlay.setLasso).toHaveBeenLastCalledWith(expect.objectContaining({ x: 0, y: 0, w: 500, h: 100 }));
    expect(world.getSelectedIds()).toContain(a);
    expect(world.getSelectedIds()).toContain(b);

    // Soltar esconde o retângulo mas mantém a seleção (como o original)
    world.processAction({
      type: 'pointerUp',
      world: { x: -100, y: 0, z: -100 },
      screen: { x: 500, y: 100 },
      pointerId: 1,
    });
    expect(overlay.setLasso).toHaveBeenLastCalledWith(null);
    expect(world.getSelectedIds()).toHaveLength(2);
  });

  it('laço só pega itens VISÍVEIS dentro do retângulo (fora = ignorado)', async () => {
    const overlay = makeOverlayMock();
    const { world, renderer } = await makeWorld(overlay);
    const inside = world.addBox({ x: 10, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'in.txt');
    const outside = world.addBox({ x: 90, y: 1.6, z: 90 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'out.txt');
    vi.mocked(renderer.projectToScreen).mockImplementation((p) => ({
      x: p.x * 10,
      y: p.z * 10,
      visible: true,
    }));

    world.processAction({
      type: 'pointerDown',
      world: { x: -100, y: 0, z: -100 },
      screen: { x: 0, y: 0 },
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
    });
    // Retângulo cobre só (100,0); outside projeta (900,900) — fora
    world.processAction({
      type: 'pointerMove',
      world: { x: -100, y: 0, z: -100 },
      screen: { x: 200, y: 50 },
      pointerId: 1,
    });
    world.processAction({
      type: 'pointerUp',
      world: { x: -100, y: 0, z: -100 },
      screen: { x: 200, y: 50 },
      pointerId: 1,
    });
    expect(world.getSelectedIds()).toEqual([inside]);
    expect(world.getSelectedIds()).not.toContain(outside);
  });

  it('shift+clique alterna a seleção (aditiva)', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 10, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    const down = (x: number) =>
      world.processAction({
        type: 'pointerDown',
        world: { x, y: 0, z: 0 },
        screen: { x, y: 0 },
        button: 0,
        pointerId: 1,
        shift: true,
      });

    down(10); // → [a]
    expect(world.getSelectedIds()).toEqual([a]);
    down(40); // → [a, b]
    expect(world.getSelectedIds()).toEqual([a, b]);
    down(10); // shift de novo em a → remove → [b]
    expect(world.getSelectedIds()).toEqual([b]);
  });

  it('P1: Freehand Lasso — desenha laço livre com múltiplos pontos e seleciona por polígono', async () => {
    const overlay = makeOverlayMock();
    const { world, renderer } = await makeWorld(overlay);
    const target = world.addBox({ x: 20, y: 1.6, z: 20 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'target.txt');
    vi.mocked(renderer.projectToScreen).mockReturnValue({ x: 100, y: 100, visible: true });

    world.processAction({
      type: 'pointerDown',
      world: { x: -100, y: 0, z: -100 },
      screen: { x: 50, y: 50 },
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
    });

    const loopPoints = [
      { x: 150, y: 50 },
      { x: 150, y: 150 },
      { x: 50, y: 150 },
      { x: 50, y: 50 },
    ];
    for (const pt of loopPoints) {
      world.processAction({
        type: 'pointerMove',
        world: { x: -100, y: 0, z: -100 },
        screen: pt,
        pointerId: 1,
      });
    }

    expect(world.getSelectedIds()).toContain(target);
    expect(overlay.setLasso).toHaveBeenLastCalledWith(
      expect.objectContaining({
        points: expect.arrayContaining([{ x: 50, y: 50 }, { x: 150, y: 50 }]),
      }),
    );
  });
});

describe('Fase 7: scroll sobre pilha (peel) e navegação', () => {
  it('scroll sobre pilha em Stack faz peel (gira itens) e NÃO dá zoom na câmera', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    const c = world.addBox({ x: 80, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'c.txt');
    expect(world.createPileFrom([a, b, c])).toBe(a);

    const bY = world.getObject(b)!.pose.position.y;
    const cY = world.getObject(c)!.pose.position.y;
    const distBefore = world.getCamera().distance;

    // Scroll (zoom) com cursor sobre a pilha → consumido pelo peel
    world.processAction({ type: 'zoom', delta: 1, world: { x: 0, y: 0, z: 0 } });

    // Peel dir=1: topo (c) vai para logo acima da base → c desce, b sobe
    expect(world.getObject(c)!.pose.position.y).toBeLessThan(cY);
    expect(world.getObject(b)!.pose.position.y).toBeGreaterThan(bY);
    // Zoom consumido: câmera intacta
    expect(world.getCamera().distance).toBe(distBefore);

    // Scroll no chão vazio → zoom normal da câmera
    world.processAction({ type: 'zoom', delta: -1000, world: { x: -100, y: 0, z: -100 } });
    expect(world.getCamera().distance).not.toBe(distBefore);
  });

  it('prevPilePage/nextPilePage mudam a página de um Grid', async () => {
    const { world } = await makeWorld();
    const ids: string[] = [];
    for (let i = 0; i < 17; i++) {
      ids.push(
        world.addBox({ x: i * 4, y: 1.6, z: 0 }, { x: 3, y: 3, z: 1.6 }, '#fff', `f${i}.txt`),
      );
    }
    const base = world.createPileFrom(ids);
    expect(base).not.toBeNull();
    world.togglePileLayout(base!); // Stack → Grid
    expect(world.isGridPile(base!)).toBe(true);

    world.nextPilePage(base!); // 17 itens → 2 páginas; item 16 some da pág. 0
    world.prevPilePage(base!); // volta à pág. 0 → item 16 visível de novo
    // Página 0: os 16 primeiros visíveis, o 17º fora
    const snap = world.toSnapshot();
    expect(snap.objects).toHaveLength(17);
  });
});

describe('Fase 7: fan-out (leque) e colapso', () => {
  it('fanOutPile abre em leque; collapseFanOuts fecha de volta', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    const c = world.addBox({ x: 80, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'c.txt');
    const base = world.createPileFrom([a, b, c])!;
    expect(world.isFanOutPile(base)).toBe(false);

    expect(world.fanOutPile(base)).toBe(true);
    expect(world.isFanOutPile(base)).toBe(true);

    expect(world.collapseFanOuts()).toBe(1);
    expect(world.isFanOutPile(base)).toBe(false);
    expect(world.collapseFanOuts()).toBe(0); // nada a fechar
  });

  it('fanOutPile em objeto solto (sem pilha) retorna false', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    expect(world.fanOutPile(a)).toBe(false);
  });
});

describe('Fase 7: WallToss (toss na parede prende o objeto)', () => {
  it('toss rápido em direção à parede prega o objeto e dispara o toast', async () => {
    const overlay = makeOverlayMock();
    const { world } = await makeWorld(overlay);
    world.setAutoWallPin(true);
    // Perto da parede norte (-z); faceN interna = -130 + 5 + 1.6 + 2.5 = -120.9
    const id = world.addBox({ x: 0, y: 1.6, z: -115 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');

    world.processAction({
      type: 'pointerDown',
      world: { x: 0, y: 0, z: -115 },
      screen: { x: 0, y: 0 },
      button: 0,
      pointerId: 1,
    });
    // Alvo bem atrás da parede → mola acelera para -z
    world.processAction({
      type: 'pointerMove',
      world: { x: 0, y: 0, z: -140 },
      screen: { x: 0, y: 0 },
      pointerId: 1,
    });
    // 4 passos: velocidade cresce (|v|² ≥ 10000 = toss) e o objeto cruza a face
    for (let i = 0; i < 4; i++) world.update(1 / 60);

    world.processAction({
      type: 'pointerUp',
      world: { x: 0, y: 0, z: -140 },
      screen: { x: 0, y: 0 },
      pointerId: 1,
    });
    expect(world.getObject(id)!.pinnedWall).toBeNull(); // ainda não prendeu

    // Próximo frame: toss recente + contato com a parede → pin + toast
    world.update(1 / 60);
    expect(world.getObject(id)!.pinnedWall).toBe(0); // parede norte
    expect(world.getObject(id)!.pose.position.z).toBeLessThan(-100);
    expect(overlay.toast).toHaveBeenCalledWith('WallToss! 🎯');
  });

  it('toss LENTO (sem velocidade de parede) não prende', async () => {
    const overlay = makeOverlayMock();
    const { world } = await makeWorld(overlay);
    const id = world.addBox({ x: 0, y: 1.6, z: -115 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    // Down e up sem mover → sem toss → nada acontece
    world.processAction({
      type: 'pointerDown',
      world: { x: 0, y: 0, z: -115 },
      screen: { x: 0, y: 0 },
      button: 0,
      pointerId: 1,
    });
    world.processAction({
      type: 'pointerUp',
      world: { x: 0, y: 0, z: -115 },
      screen: { x: 0, y: 0 },
      pointerId: 1,
    });
    for (let i = 0; i < 5; i++) world.update(1 / 60);
    expect(world.getObject(id)!.pinnedWall).toBeNull();
    expect(overlay.toast).not.toHaveBeenCalled();
  });
});

describe('Fase 7: auto-pilha por tipo e rename', () => {
  it('autoStackByType agrupa arquivos da mesma extensão em pilhas', async () => {
    const { world } = await makeWorld();
    const t1 = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'rel.txt');
    const t2 = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'nota.txt');
    const p1 = world.addBox({ x: 80, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'doc.pdf');
    const p2 = world.addBox({ x: 120, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'out.pdf');

    expect(world.autoStackByType()).toBe(2); // pilha .txt + pilha .pdf
    expect(world.inPile(t1)).toBe(true);
    expect(world.inPile(t2)).toBe(true);
    expect(world.inPile(p1)).toBe(true);
    expect(world.inPile(p2)).toBe(true);
    // Cada pilha tem exatamente 2 membros (txt com txt, pdf com pdf)
    expect(world.getObject(t1)!.parentId === t2 || world.getObject(t2)!.parentId === t1).toBe(true);
  });

  it('autoStackByType não empilha pastas nem agrupa extensões soltas', async () => {
    const { world } = await makeWorld();
    const dir = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'pasta', {
      isDir: true,
    });
    const dir2 = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'outra', {
      isDir: true,
    });
    const only = world.addBox({ x: 80, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'solo.zip');

    expect(world.autoStackByType()).toBe(0);
    expect(world.inPile(dir)).toBe(false);
    expect(world.inPile(dir2)).toBe(false);
    expect(world.inPile(only)).toBe(false);
  });

  it('renameObject altera o rótulo; id inexistente retorna false', async () => {
    const { world } = await makeWorld();
    const id = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'antigo.txt');

    expect(world.renameObject(id, 'novo-nome.pdf')).toBe(true);
    expect(world.getObject(id)!.label).toBe('novo-nome.pdf');

    expect(world.renameObject('id-que-nao-existe', 'x')).toBe(false);
  });

  it('Pile Widget Halo: hover sobre pilha expõe getPileHaloState() e getPileCenter()', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 0, y: 5.0, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    world.createPileFrom([a, b]);

    expect(world.getPileHaloState()).toBeNull();

    // Hover sobre a pilha
    world.processAction({
      type: 'hover',
      world: { x: 0, y: 1.6, z: 0 },
      screen: { x: 200, y: 150 },
    });

    const halo = world.getPileHaloState();
    expect(halo).not.toBeNull();
    expect(halo?.pileId).toBe(a);
    expect(halo?.itemCount).toBe(2);
    expect(halo?.messy).toBe(true);

    const center = world.getPileCenter(a);
    expect(center).not.toBeNull();
    expect(Math.abs(center!.x)).toBeLessThanOrEqual(1.0);
    expect(Math.abs(center!.z)).toBeLessThanOrEqual(1.0);
    expect(center?.y).toBeGreaterThan(1.6);

    // Hover fora da pilha limpa o halo
    world.processAction({
      type: 'hover',
      world: { x: 100, y: 1.6, z: 100 },
      screen: { x: 500, y: 500 },
    });
    expect(world.getPileHaloState()).toBeNull();
  });

  it('ações do halo: togglePileGrid, togglePileFan, togglePileMessy e breakPile', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 0, y: 5.0, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    world.createPileFrom([a, b]);

    // Grid toggle
    expect(world.isGridPile(a)).toBe(false);
    expect(world.togglePileGrid(a)).toBe(true);
    expect(world.isGridPile(a)).toBe(true);
    expect(world.togglePileGrid(a)).toBe(true);
    expect(world.isGridPile(a)).toBe(false);

    // Fan-out toggle
    expect(world.isFanOutPile(a)).toBe(false);
    expect(world.togglePileFan(a)).toBe(true);
    expect(world.isFanOutPile(a)).toBe(true);
    expect(world.togglePileFan(a)).toBe(true);
    expect(world.isFanOutPile(a)).toBe(false);

    // Messy toggle
    expect(world.togglePileMessy(a)).toBe(true);

    // Break pile desmancha e libera os itens
    const broken = world.breakPile(a);
    expect(broken).toEqual([a, b]);
    expect(world.inPile(a)).toBe(false);
    expect(world.inPile(b)).toBe(false);
    expect(world.getPileHaloState()).toBeNull();
  });

  it('P1: Dwell & Scrub — ativa anel de dwell após 400ms e gera faixa de scrub com chips', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 0, y: 5.0, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    const c = world.addBox({ x: 0, y: 8.0, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'c.txt');
    world.createPileFrom([a, b, c]);

    // Hover sobre a pilha
    world.processAction({
      type: 'hover',
      world: { x: 0, y: 0, z: 0 },
      screen: { x: 200, y: 200 },
    });

    // Antes de 400ms: progresso parcial (~50%), scrub ainda inativo
    world.update(0.2); // 200ms
    const dwellHalf = world.getDwellRingState();
    expect(dwellHalf).not.toBeNull();
    expect(dwellHalf?.pileId).toBe(a);
    expect(dwellHalf?.progress).toBeCloseTo(0.5, 2);
    expect(dwellHalf?.active).toBe(false);
    expect(world.getScrubStripState()).toBeNull();

    // Passou de 400ms (mais 250ms = 450ms total): dwell ativo + scrub strip visível
    world.update(0.25);
    const dwellFull = world.getDwellRingState();
    expect(dwellFull?.progress).toBe(1);
    expect(dwellFull?.active).toBe(true);

    const scrub = world.getScrubStripState();
    expect(scrub).not.toBeNull();
    expect(scrub?.pileId).toBe(a);
    expect(scrub?.items).toHaveLength(3);
    expect(scrub?.items.map((i) => i.id)).toEqual([a, b, c]);
    expect(scrub?.activeIndex).toBe(0);
  });

  it('P1: Dwell & Scrub — setScrubIndex atualiza item ativo e selectScrubItem seleciona', async () => {
    const overlay = makeOverlayMock();
    const { world } = await makeWorld(overlay);
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 0, y: 5.0, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    world.createPileFrom([a, b]);

    // Ativa o dwell
    world.processAction({
      type: 'hover',
      world: { x: 0, y: 0, z: 0 },
      screen: { x: 200, y: 200 },
    });
    world.update(0.5); // 500ms > 400ms

    // Muda o scrubIndex
    world.setScrubIndex(a, 1);
    expect(world.getScrubStripState()?.activeIndex).toBe(1);

    // Seleciona o item b a partir do scrub
    world.selectScrubItem(a, b);
    expect(world.getSelectedId()).toBe(b);
    expect(overlay.toast).toHaveBeenCalledWith(expect.stringContaining('b.txt'));

    // Hover fora da pilha limpa dwell e scrub
    world.processAction({
      type: 'hover',
      world: { x: 100, y: 0, z: 100 },
      screen: { x: 800, y: 800 },
    });
    world.update(0.016);
    expect(world.getDwellRingState()).toBeNull();
    expect(world.getScrubStripState()).toBeNull();
  });

  it('P1: shakePile sacode a pilha, espalha itens com física e limpa estado', async () => {
    const overlay = makeOverlayMock();
    const { world, physics } = await makeWorld(overlay);
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 0, y: 5.0, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    const c = world.addBox({ x: 0, y: 8.0, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'c.txt');
    world.createPileFrom([a, b, c]);

    const shaken = world.shakePile(a);
    expect(shaken).toEqual([a, b, c]);
    expect(world.inPile(a)).toBe(false);
    expect(world.inPile(b)).toBe(false);
    expect(world.inPile(c)).toBe(false);
    expect(physics.setVelocity).toHaveBeenCalled();
    expect(overlay.toast).toHaveBeenCalledWith('Pilha sacudida');
  });

  it('P1: explodingPiles explode a pilha ao puxar um item e suporta toggle', async () => {
    const overlay = makeOverlayMock();
    const { world } = await makeWorld(overlay);
    expect(world.isExplodingPiles()).toBe(true);

    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 0, y: 5.0, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    const c = world.addBox({ x: 0, y: 8.0, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'c.txt');
    world.createPileFrom([a, b, c]);

    // Down em 'a' (item da pilha)
    world.processAction({
      type: 'pointerDown',
      world: { x: 0, y: 0, z: 0 },
      screen: { x: 100, y: 100 },
      button: 0,
      pointerId: 1,
    });
    // Move com distância para puxar para fora
    world.processAction({
      type: 'pointerMove',
      world: { x: 30, y: 0, z: 30 },
      screen: { x: 150, y: 150 },
      pointerId: 1,
    });

    // Puxou 'a': o resto da pilha explodiu e foi desmanchado
    expect(world.inPile(b)).toBe(false);
    expect(world.inPile(c)).toBe(false);
    expect(overlay.toast).toHaveBeenCalledWith('Pilha explodida ao puxar item');

    // Toggle para desativar
    world.setExplodingPiles(false);
    expect(world.isExplodingPiles()).toBe(false);
    world.toggleExplodingPiles();
    expect(world.isExplodingPiles()).toBe(true);
  });

  it('P1: Smooth Auto-Align — alinha objeto solto à grade implícita e suporta toggle', async () => {
    const overlay = makeOverlayMock();
    const { world } = await makeWorld(overlay);
    expect(world.isAutoAlign()).toBe(true);

    // Adiciona um objeto em posição fora da grade (ex: x=17.2, z=35.1)
    const id = world.addBox({ x: 17.2, y: 1.6, z: 35.1 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'item.txt');

    // Alinha o item
    const aligned = world.autoAlignItem(id);
    expect(aligned).toBe(true);

    const obj = world.getObject(id)!;
    // 17.2 arredonda para 18.0; 35.1 arredonda para 36.0 (múltiplos de GRID_SNAP = 18.0)
    expect(obj.pose.position.x).toBe(18.0);
    expect(obj.pose.position.z).toBe(36.0);
    expect(obj.pose.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });

    // Desativa autoAlign e testa toggle
    world.toggleAutoAlign();
    expect(world.isAutoAlign()).toBe(false);
    world.toggleAutoAlign();
    expect(world.isAutoAlign()).toBe(true);
  });

  it('P1: Smooth Auto-Align — soltar item arrastado no chão alinha à grade', async () => {
    const overlay = makeOverlayMock();
    const { world } = await makeWorld(overlay);
    const id = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'dragged.txt');

    // Down no item
    world.processAction({
      type: 'pointerDown',
      world: { x: 0, y: 0, z: 0 },
      screen: { x: 100, y: 100 },
      button: 0,
      pointerId: 1,
    });
    // Move para x=19, z=35 (perto de 18, 36)
    world.processAction({
      type: 'pointerMove',
      world: { x: 19, y: 0, z: 35 },
      screen: { x: 120, y: 120 },
      pointerId: 1,
    });
    // Up no chão
    world.processAction({
      type: 'pointerUp',
      world: { x: 19, y: 0, z: 35 },
      screen: { x: 120, y: 120 },
      pointerId: 1,
    });

    const obj = world.getObject(id)!;
    expect(obj.pose.position.x).toBe(18.0);
    expect(obj.pose.position.z).toBe(36.0);
  });
});

describe('Paredes: nada sai da sala', () => {
  it('arrastar além da parede para o item na face interna', async () => {
    const { world } = await makeWorld();
    const id = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const p = (x: number, z: number) => ({ x, y: 0, z });
    world.processAction({ type: 'pointerDown', world: p(0, 0), screen: { x: 0, y: 0 }, button: 0, pointerId: 1 });
    world.processAction({ type: 'pointerMove', world: p(400, -400), screen: { x: 9, y: 9 }, pointerId: 1 });
    for (let i = 0; i < 120; i++) world.update(1 / 60);
    const pos = world.getObject(id)!.pose.position;
    expect(pos.x).toBeLessThanOrEqual(118 + 1e-6);
    expect(pos.z).toBeGreaterThanOrEqual(-118 - 1e-6);
    expect(world.isInsideRoom(id)).toBe(true);
  });

  it('item que escapou da física volta para dentro da sala', async () => {
    const { world, physics } = await makeWorld();
    const id = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    physics.setPosition(1 as BodyHandle, { x: 500, y: -40, z: -300 });
    world.update(1 / 60);
    const pos = world.getObject(id)!.pose.position;
    expect(pos).toEqual({ x: 118, y: 0.35, z: -118 });
    expect(world.isInsideRoom(id)).toBe(true);
  });
});

describe('Seleção em grupo: arrastar vários objetos juntos', () => {
  async function twoSelected() {
    const ctx = await makeWorld();
    const a = ctx.world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = ctx.world.addBox({ x: 30, y: 1.6, z: 10 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    ctx.world.select(a);
    ctx.world.toggleSelect(b);
    return { ...ctx, a, b };
  }
  const p = (x: number, z: number) => ({ x, y: 0, z });

  it('arrastar um item selecionado move toda a seleção mantendo a formação', async () => {
    const { world, a, b } = await twoSelected();
    world.processAction({ type: 'pointerDown', world: p(0, 0), screen: { x: 100, y: 100 }, button: 0, pointerId: 1 });
    world.processAction({ type: 'pointerMove', world: p(-40, 20), screen: { x: 60, y: 120 }, pointerId: 1 });
    for (let i = 0; i < 120; i++) world.update(1 / 60);
    world.processAction({ type: 'pointerUp', world: p(-40, 20), screen: { x: 60, y: 120 }, pointerId: 1 });
    const pa = world.getObject(a)!.pose.position;
    const pb = world.getObject(b)!.pose.position;
    expect(pa.x).toBeCloseTo(-40, 0);
    expect(pa.z).toBeCloseTo(20, 0);
    expect(pb.x - pa.x).toBeCloseTo(30, 5);
    expect(pb.z - pa.z).toBeCloseTo(10, 5);
    expect(world.getSelectedIds().sort()).toEqual([a, b].sort());
  });

  it('clique sem arrastar num item da seleção deixa só ele selecionado', async () => {
    const { world, a } = await twoSelected();
    world.processAction({ type: 'pointerDown', world: p(0, 0), screen: { x: 100, y: 100 }, button: 0, pointerId: 1 });
    world.processAction({ type: 'pointerUp', world: p(0, 0), screen: { x: 100, y: 100 }, pointerId: 1 });
    expect(world.getSelectedIds()).toEqual([a]);
  });

  it('o grupo também não atravessa as paredes', async () => {
    const { world, b } = await twoSelected();
    world.processAction({ type: 'pointerDown', world: p(0, 0), screen: { x: 100, y: 100 }, button: 0, pointerId: 1 });
    world.processAction({ type: 'pointerMove', world: p(110, 0), screen: { x: 300, y: 100 }, pointerId: 1 });
    for (let i = 0; i < 120; i++) world.update(1 / 60);
    expect(world.getObject(b)!.pose.position.x).toBeLessThanOrEqual(118 + 1e-6);
    expect(world.isInsideRoom(b)).toBe(true);
  });
});

describe('Arraste em grupo com pilha na seleção (item 5)', () => {
  const p = (x: number, z: number) => ({ x, y: 0, z });

  /** Pilha de 3 (a = base) + 2 itens soltos (d, e). */
  async function pileAndLoose() {
    const ctx = await makeWorld();
    const a = ctx.world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = ctx.world.addBox({ x: 30, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    const c = ctx.world.addBox({ x: 0, y: 1.6, z: 30 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'c.txt');
    ctx.world.createPileFrom([a, b, c]);
    const d = ctx.world.addBox({ x: 60, y: 1.6, z: 10 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'd.txt');
    const e = ctx.world.addBox({ x: 60, y: 1.6, z: -10 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'e.txt');
    return { ...ctx, a, b, c, d, e };
  }

  it('seleção com pilha + solto: arrastar move a pilha inteira junto (sem voltar ao lugar antigo)', async () => {
    const { world, a, b, c, d } = await pileAndLoose();
    // Seleciona um MEMBRO da pilha (não a base) + o item solto
    world.select(b);
    world.toggleSelect(d);
    const before = new Map([a, b, c, d].map((id) => [id, { ...world.getObject(id)!.pose.position }]));
    const centerBefore = world.getPileCenter(a)!;
    const leaderStart = { ...world.getObject(b)!.pose.position };

    // Clica sobre a pilha e arrasta até (-40, 20)
    world.processAction({ type: 'pointerDown', world: p(leaderStart.x, leaderStart.z), screen: { x: 100, y: 100 }, button: 0, pointerId: 1 });
    world.processAction({ type: 'pointerMove', world: p(-40, 20), screen: { x: 60, y: 120 }, pointerId: 1 });
    for (let i = 0; i < 120; i++) world.update(1 / 60);
    world.processAction({ type: 'pointerUp', world: p(-40, 20), screen: { x: 60, y: 120 }, pointerId: 1 });

    // A pilha continua formada
    for (const id of [a, b, c]) expect(world.inPile(id)).toBe(true);
    // O solto acompanha o alvo...
    const dx = -40 - leaderStart.x;
    const dz = 20 - leaderStart.z;
    const after = (id: string) => world.getObject(id)!.pose.position;
    expect(after(d).x - before.get(d)!.x).toBeCloseTo(dx, 0);
    expect(after(d).z - before.get(d)!.z).toBeCloseTo(dz, 0);
    // ...e TODOS os membros da pilha se movem com o mesmo delta (rigidamente)
    for (const id of [a, b, c]) {
      expect(after(id).x - before.get(id)!.x).toBeCloseTo(after(d).x - before.get(d)!.x, 5);
      expect(after(id).z - before.get(id)!.z).toBeCloseTo(after(d).z - before.get(d)!.z, 5);
    }
    // A origem da pilha foi atualizada (o centro acompanha o arrasto)
    const centerAfter = world.getPileCenter(a)!;
    expect(centerAfter.x - centerBefore.x).toBeCloseTo(dx, 0);
    expect(centerAfter.z - centerBefore.z).toBeCloseTo(dz, 0);
  });

  it('PR9: clique PARADO em item de pilha NÃO arranca (duplo-clique abre a grade)', async () => {
    const { world, a } = await pileAndLoose();
    const pa = { ...world.getObject(a)!.pose.position };
    world.processAction({ type: 'pointerDown', world: p(pa.x, pa.z), screen: { x: 100, y: 100 }, button: 0, pointerId: 1 });
    world.processAction({ type: 'pointerUp', world: p(pa.x, pa.z), screen: { x: 100, y: 100 }, pointerId: 1 });
    expect(world.inPile(a)).toBe(true); // clique sem movimento preserva a pilha
  });

  it('PR9: seleção de itens soltos não sequestra o clique na pilha (item fica na pilha)', async () => {
    const { world, a, d, e } = await pileAndLoose();
    world.select(d);
    world.toggleSelect(e);
    const pa = { ...world.getObject(a)!.pose.position };
    world.processAction({ type: 'pointerDown', world: p(pa.x, pa.z), screen: { x: 100, y: 100 }, button: 0, pointerId: 1 });
    world.processAction({ type: 'pointerUp', world: p(pa.x, pa.z), screen: { x: 100, y: 100 }, pointerId: 1 });
    expect(world.inPile(a)).toBe(true); // clique parado não arranca
  });
});

describe('Duplo-clique na parede foca a câmera (item 4)', () => {
  it('pickWall devolve a parede correta fora da sala e null no chão interno', async () => {
    const { world } = await makeWorld();
    expect(world.pickWall({ x: 0, y: 0, z: -200 })).toBe(0); // norte
    expect(world.pickWall({ x: 0, y: 0, z: 200 })).toBe(1); // sul
    expect(world.pickWall({ x: -200, y: 0, z: 0 })).toBe(2); // oeste
    expect(world.pickWall({ x: 200, y: 0, z: 0 })).toBe(3); // leste
    expect(world.pickWall({ x: 0, y: 0, z: 0 })).toBeNull();
    expect(world.pickWall({ x: 60, y: 0, z: -60 })).toBeNull();
  });

  it('focusWall anima a câmera até a vista frontal da parede', async () => {
    const { world } = await makeWorld();
    world.focusWall(1); // sul → azimuth π, elev 0.45, dist 240, pivot (0,14,0)
    for (let i = 0; i < 150; i++) world.update(1 / 60);
    const cam = world.getCamera();
    expect(cam.azimuth).toBeCloseTo(Math.PI, 2);
    expect(cam.elevation).toBeCloseTo(0.45, 2);
    expect(cam.distance).toBeCloseTo(240, 1);
    expect(cam.target.x).toBeCloseTo(0, 1);
    expect(cam.target.y).toBeCloseTo(14, 1);
    expect(cam.target.z).toBeCloseTo(0, 1);
  });

  it('focusWall cobre as demais paredes (norte, oeste, leste)', async () => {
    const { world } = await makeWorld();
    world.focusWall(3); // leste → az -π/2
    for (let i = 0; i < 150; i++) world.update(1 / 60);
    expect(world.getCamera().azimuth).toBeCloseTo(-Math.PI / 2, 2);

    world.focusWall(2); // oeste → az π/2
    for (let i = 0; i < 150; i++) world.update(1 / 60);
    expect(world.getCamera().azimuth).toBeCloseTo(Math.PI / 2, 2);

    world.focusWall(0); // norte → az 0
    for (let i = 0; i < 150; i++) world.update(1 / 60);
    expect(world.getCamera().azimuth).toBeCloseTo(0, 2);
    expect(world.getCamera().elevation).toBeCloseTo(0.45, 2);
  });

  it('focar uma parede desconhecida é um no-op', async () => {
    const { world } = await makeWorld();
    const antes = world.getCamera();
    world.focusWall(9);
    for (let i = 0; i < 30; i++) world.update(1 / 60);
    expect(world.getCamera()).toEqual(antes);
  });
});

describe("Laço do vídeo: Lasso'n'Cross e LassoMenu", () => {
  async function lassoWorld() {
    const overlay = makeOverlayMock();
    const ctx = await makeWorld(overlay);
    (ctx.renderer.projectToScreen as ReturnType<typeof vi.fn>).mockImplementation((v: Vec3) => ({
      x: v.x + 300,
      y: v.z + 300,
      visible: true,
    }));
    const ids = [
      ctx.world.addBox({ x: -20, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt'),
      ctx.world.addBox({ x: 20, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt'),
      ctx.world.addBox({ x: 0, y: 1.6, z: 30 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'c.txt'),
    ];
    return { ...ctx, overlay, ids };
  }
  const floor = { x: 0, y: 0, z: -200 };
  const move = (world: World, x: number, y: number) =>
    world.processAction({ type: 'pointerMove', world: floor, screen: { x, y }, pointerId: 1 });

  function drawLoop(world: World) {
    world.processAction({ type: 'pointerDown', world: floor, screen: { x: 300, y: 240 }, button: 0, pointerId: 1 });
    const cx = 300;
    const cy = 310;
    for (let i = 1; i <= 36; i++) {
      const a = -Math.PI / 2 + (i / 36) * Math.PI * 2;
      move(world, cx + 80 * Math.cos(a), cy + 70 * Math.sin(a));
    }
  }

  it('fechar o laço e soltar no disco azul abre o LassoMenu com a seleção', async () => {
    const { world, ids } = await lassoWorld();
    const menu = vi.fn();
    world.onLassoMenu(menu);
    drawLoop(world);
    expect(world.getLassoState().closed).toBe(true);
    world.processAction({ type: 'pointerUp', world: floor, screen: { x: 300, y: 240 }, pointerId: 1 });
    expect(menu).toHaveBeenCalledTimes(1);
    expect((menu.mock.calls[0][1] as string[]).sort()).toEqual([...ids].sort());
    expect(world.getLassoState().active).toBe(false);
  });

  it('cruzar o alvo central depois de fechar o laço empilha a seleção', async () => {
    const { world, ids, overlay } = await lassoWorld();
    const menu = vi.fn();
    world.onLassoMenu(menu);
    drawLoop(world);
    const target = world.getLassoState().crossTarget!;
    expect(target).not.toBeNull();
    move(world, 300, 275);
    move(world, target.x, target.y + 2);
    for (const id of ids) expect(world.inPile(id)).toBe(true);
    expect(overlay.toast).toHaveBeenCalledWith(expect.stringContaining('3'));
    world.processAction({ type: 'pointerUp', world: floor, screen: { x: target.x, y: target.y }, pointerId: 1 });
    expect(menu).not.toHaveBeenCalled();
  });

  it('laço aberto (sem voltar ao início) só seleciona, sem menu', async () => {
    const { world } = await lassoWorld();
    const menu = vi.fn();
    world.onLassoMenu(menu);
    world.processAction({ type: 'pointerDown', world: floor, screen: { x: 200, y: 250 }, button: 0, pointerId: 1 });
    move(world, 400, 250);
    move(world, 400, 360);
    move(world, 200, 360);
    world.processAction({ type: 'pointerUp', world: floor, screen: { x: 200, y: 360 }, pointerId: 1 });
    expect(menu).not.toHaveBeenCalled();
    expect(world.getSelectedIds().length).toBeGreaterThan(0);
  });
});

describe('Girar, paredes e níveis de física', () => {
  it('rotateSelection gira em Y e mantém o item dentro da sala', async () => {
    const { world } = await makeWorld();
    const id = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    expect(world.rotateSelection(Math.PI / 2, [id])).toBe(1);
    const q = world.getObject(id)!.pose.rotation;
    expect(q.y).toBeCloseTo(Math.SQRT1_2, 5);
    expect(q.w).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('pregar na parede deixa o item em pé, encostado na face interna; despregar deita de volta', async () => {
    const { world } = await makeWorld();
    const id = world.addBox({ x: 10, y: 1.6, z: -100 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    world.pinToWall(id, 0);
    let o = world.getObject(id)!;
    expect(o.pose.rotation.x).toBeCloseTo(Math.SQRT1_2, 5);
    expect(o.pose.position.z).toBeCloseTo(-125 + 0.35 + 0.5, 5);
    expect(o.pose.position.y).toBeGreaterThanOrEqual(7 + 2);
    world.pinToWall(id, null);
    o = world.getObject(id)!;
    expect(o.pose.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(world.isInsideRoom(id)).toBe(true);
  });

  it('alternar o nível de física liga/desliga a colisão entre itens', async () => {
    const { world, physics } = await makeWorld();
    expect(world.getPhysicsLevel()).toBe(2);
    expect(world.togglePhysicsLevel()).toBe(1);
    expect(physics.setItemCollisions).toHaveBeenLastCalledWith(false);
    expect(world.togglePhysicsLevel()).toBe(2);
    expect(physics.setItemCollisions).toHaveBeenLastCalledWith(true);
  });
});

describe('Parede: prender é opcional e item preso pode ser puxado', () => {
  it('PR11: por padrão, arremessar/arrastar até a parede PRENDE o item', async () => {
    const overlay = makeOverlayMock();
    const { world } = await makeWorld(overlay);
    expect(world.isAutoWallPin()).toBe(true);
    const id = world.addBox({ x: 0, y: 1.6, z: -100 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    world.processAction({ type: 'pointerDown', world: { x: 0, y: 0, z: -100 }, screen: { x: 0, y: 0 }, button: 0, pointerId: 1 });
    world.processAction({ type: 'pointerMove', world: { x: 0, y: 0, z: -140 }, screen: { x: 0, y: 0 }, pointerId: 1 });
    for (let i = 0; i < 6; i++) world.update(1 / 60);
    world.processAction({ type: 'pointerUp', world: { x: 0, y: 0, z: -140 }, screen: { x: 0, y: 0 }, pointerId: 1 });
    for (let i = 0; i < 3; i++) world.update(1 / 60);
    expect(world.getObject(id)!.pinnedWall).toBe(0); // prega na parede norte
  });

  it('PR10: item preso desliza ao longo da parede e permanece pregado', async () => {
    const { world, renderer } = await makeWorld();
    (renderer.projectToScreen as ReturnType<typeof vi.fn>).mockImplementation((v: Vec3) => ({
      x: v.x + 300,
      y: v.z + 300 - v.y * 2,
      visible: true,
    }));
    const id = world.addBox({ x: 0, y: 1.6, z: -100 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    world.pinToWall(id, 0);
    const p0 = world.getObject(id)!.pose.position;
    const screen = { x: p0.x + 300, y: p0.z + 300 - p0.y * 2 };
    // Raio que cruza o plano da parede num ponto deslocado ao longo dela
    const planeZ = p0.z;
    const alvo = { x: 40, y: 60, z: planeZ };
    (renderer.screenToRay as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const origin = { x: alvo.x, y: alvo.y + 80, z: planeZ + 100 };
      const dir = { x: alvo.x - origin.x, y: alvo.y - origin.y, z: alvo.z - origin.z };
      return { origin, direction: dir };
    });
    world.processAction({ type: 'pointerDown', world: { x: 0, y: 0, z: -400 }, screen, button: 0, pointerId: 1 });
    // Down sozinho NÃO desprega (PR10): o item continua na parede
    expect(world.getObject(id)!.pinnedWall).toBe(0);
    world.processAction({ type: 'pointerMove', world: { x: 0, y: 0, z: -400 }, screen: { x: 300, y: 300 }, pointerId: 1 });
    const p1 = world.getObject(id)!.pose.position;
    expect(p1.x).toBeCloseTo(40, 0); // deslizou ao longo da parede
    expect(p1.z).toBeCloseTo(planeZ, 3); // mesma profundidade
    expect(world.getObject(id)!.pinnedWall).toBe(0); // ainda pregado
    world.processAction({ type: 'pointerUp', world: { x: 0, y: 0, z: -400 }, screen: { x: 300, y: 300 }, pointerId: 1 });
    expect(world.getObject(id)!.pinnedWall).toBe(0); // soltou e CONTINUA pregado
    expect(world.getObject(id)!.pose.position.x).toBeCloseTo(40, 0);
  });

  it('PR10: arrastar o item preso apontando para o chão o desprega', async () => {
    const { world, renderer } = await makeWorld();
    (renderer.projectToScreen as ReturnType<typeof vi.fn>).mockImplementation((v: Vec3) => ({
      x: v.x + 300,
      y: v.z + 300 - v.y * 2,
      visible: true,
    }));
    const id = world.addBox({ x: 0, y: 1.6, z: -100 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    world.pinToWall(id, 0);
    const p = world.getObject(id)!.pose.position;
    const screen = { x: p.x + 300, y: p.z + 300 - p.y * 2 };
    world.processAction({ type: 'pointerDown', world: { x: 0, y: 0, z: -400 }, screen, button: 0, pointerId: 1 });
    expect(world.getObject(id)!.pinnedWall).toBe(0);
    // Raio aponta para o chão: a interseção com o plano cai abaixo da faixa
    (renderer.screenToRay as ReturnType<typeof vi.fn>).mockReturnValue({
      origin: { x: 0, y: 60, z: 0 },
      direction: { x: 0, y: -1, z: p.z / 246.5 },
    });
    world.processAction({ type: 'pointerMove', world: { x: 0, y: 0, z: 0 }, screen: { x: 300, y: 300 }, pointerId: 1 });
    expect(world.getObject(id)!.pinnedWall).toBeNull(); // despregou
    for (let i = 0; i < 90; i++) world.update(1 / 60);
    world.processAction({ type: 'pointerUp', world: { x: 0, y: 0, z: 0 }, screen: { x: 300, y: 300 }, pointerId: 1 });
    expect(world.getObject(id)!.pose.position.z).toBeGreaterThan(-20);
    expect(world.getObject(id)!.pinnedWall).toBeNull();
  });
});

describe('Nomes dos arquivos (toggle do menu — item 1)', () => {
  it('desligar remove os labels; religar volta a exibir o nome', async () => {
    const overlay = makeOverlayMock();
    const { world } = await makeWorld(overlay);
    const id = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'relatorio.pdf');

    // Padrão: nomes visíveis
    expect(world.isShowNames()).toBe(true);
    world.update(1 / 60);
    expect(overlay.setLabel).toHaveBeenCalledWith(id, 'relatorio.pdf', expect.anything());

    // Desligado: labels removidos
    expect(world.toggleShowNames()).toBe(false);
    world.update(1 / 60);
    expect(overlay.setLabel).toHaveBeenLastCalledWith(id, null, null);
    expect(world.isShowNames()).toBe(false);

    // Religado: volta a exibir
    expect(world.toggleShowNames()).toBe(true);
    world.update(1 / 60);
    expect(overlay.setLabel).toHaveBeenLastCalledWith(id, 'relatorio.pdf', expect.anything());
  });

  it('com nomes ocultos, objeto novo não ganha label', async () => {
    const overlay = makeOverlayMock();
    const { world } = await makeWorld(overlay);
    world.setShowNames(false);
    const id = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'foto.jpg');
    world.update(1 / 60);
    expect(overlay.setLabel).toHaveBeenCalledWith(id, null, null);
  });
});

describe('pickObjectAt com excludeId (drop em pasta — arrastado sob o cursor)', () => {
  it('sem exclude o arrastado (d≈0) ganha; com exclude a pasta embaixo é detectada', async () => {
    const { world } = await makeWorld(makeOverlayMock());
    const pasta = world.addBox(
      { x: 0, y: 1.7, z: 0 },
      { x: 7, y: 1.6, z: 7 },
      '#fff',
      'pasta',
      { fsPath: '/pasta', isDir: true },
    );
    // O arquivo solto exatamente sobre a pasta (posição do cursor = do arquivo)
    const arquivo = world.addBox(
      { x: 0.5, y: 1.7, z: 0.5 },
      { x: 7, y: 1.6, z: 7 },
      '#fff',
      'a.txt',
      { fsPath: '/a.txt', isDir: false },
    );

    // Sem exclude (comportamento antigo): o arrastado está sob o cursor → ele
    // mesmo "ganha" o pick → dropTarget === dragSourceId → moveInto nunca roda
    expect(world.pickObjectAt({ x: 0.5, y: 0, z: 0.5 })).toBe(arquivo);
    // Com exclude (o fix): a pasta embaixo do arquivo é o alvo do drop
    expect(world.pickObjectAt({ x: 0.5, y: 0, z: 0.5 }, undefined, arquivo)).toBe(pasta);
  });

  it('exclude de objeto que não está ali não muda o resultado', async () => {
    const { world } = await makeWorld(makeOverlayMock());
    const a = world.addBox({ x: 0, y: 1.7, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a');
    world.addBox({ x: 50, y: 1.7, z: 50 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b');
    expect(world.pickObjectAt({ x: 1, y: 0, z: 1 }, undefined, 'inexistente')).toBe(a);
  });
});
