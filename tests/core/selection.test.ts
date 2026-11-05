/**
 * Testes do P0 — operações de seleção no World (puro, com mocks dos ports):
 *  - Grid View da seleção
 *  - Sort by Size / Sort by Type
 *  - Duplicar seleção
 *  - Escala com feedback de limite + persistência da escala
 *
 * Harness próprio (espelha o do world.test.ts) p/ não acoplar aos testes M3.
 */
import { describe, it, expect, vi } from 'vitest';
import { SCALE_MAX, SCALE_MIN, World } from '../../src/core/world';
import { ObjectKind, TypeFlags } from '../../src/core/model/types';
import type {
  BodyHandle,
  IOverlay,
  IPhysics,
  IRenderer,
  ObjectHandle,
  Pose,
  SceneSnapshot,
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
  } as unknown as IPhysics;
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

/** Posição (x,z) de um objeto p/ comparações de layout. */
function xz(world: World, id: string): { x: number; z: number } {
  const p = world.getObject(id)!.pose.position;
  return { x: p.x, z: p.z };
}

describe('P0: Grid View da seleção', () => {
  it('espalha itens soltos numa grade com posições distintas e no chão', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    const c = world.addBox({ x: 80, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'c.txt');

    expect(world.gridViewSelection([a, b, c])).toBe(3);

    const poses = [a, b, c].map((id) => world.getObject(id)!.pose.position);
    // Posições (x,z) todas distintas (grade de verdade, não empilhadas)
    const keys = new Set(poses.map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`));
    expect(keys.size).toBe(3);
    // Encostadas no chão (y = meia-altura do ícone deitado)
    for (const p of poses) expect(p.y).toBeCloseTo(1.6, 5);
    // Caixa da grade centrada onde estava o conjunto original (centroide 40,0)
    const xs = poses.map((p) => p.x);
    const zs = poses.map((p) => p.z);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(40, 5);
    expect((Math.min(...zs) + Math.max(...zs)) / 2).toBeCloseTo(0, 5);
  });

  it('usa a seleção atual quando não recebe ids', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    world.select(a);
    world.toggleSelect(b);

    expect(world.gridViewSelection()).toBe(2);
  });

  it('ignora itens de pilha e pregados na parede', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    const pinned = world.addBox({ x: 80, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'c.txt');
    const d = world.addBox({ x: 120, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'd.txt');
    const e = world.addBox({ x: 160, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'e.txt');
    expect(world.createPileFrom([a, b])).toBe(a);
    world.pinToWall(pinned, 0);
    const before = { a: xz(world, a), b: xz(world, b) };

    expect(world.gridViewSelection([a, b, pinned, d, e])).toBe(2); // só d,e

    // Pilha e pregado intactos
    expect(xz(world, a)).toEqual(before.a);
    expect(xz(world, b)).toEqual(before.b);
    expect(world.getObject(pinned)!.pinnedWall).toBe(0);
    // d,e foram rearranjados (posições distintas)
    expect(xz(world, d)).not.toEqual(xz(world, e));
  });

  it('retorna 0 com menos de 2 itens elegíveis', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    expect(world.gridViewSelection([a])).toBe(0);
    expect(world.gridViewSelection([])).toBe(0);
  });
});

describe('P0: Sort by Size / Sort by Type', () => {
  it('sortBySize alinha do menor para o maior (esquerda → direita)', async () => {
    const { world } = await makeWorld();
    const small = world.addBox({ x: 0, y: 1, z: 0 }, { x: 3, y: 1, z: 3 }, '#fff', 's.txt');
    const medium = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'm.txt');
    const big = world.addBox({ x: 80, y: 2, z: 0 }, { x: 12, y: 2, z: 12 }, '#fff', 'b.txt');

    expect(world.sortSelection('size', [small, medium, big])).toBe(3);

    const xs = [small, medium, big].map((id) => world.getObject(id)!.pose.position.x);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    // Todos na mesma linha (mesmo z) e no chão
    const zs = new Set([small, medium, big].map((id) => world.getObject(id)!.pose.position.z.toFixed(3)));
    expect(zs.size).toBe(1);
    expect(world.getObject(small)!.pose.position.y).toBeCloseTo(1, 5);
  });

  it('sortByType agrupa por extensão (mesma extensão fica junto)', async () => {
    const { world } = await makeWorld();
    const p1 = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.pdf');
    const p2 = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.pdf');
    const t1 = world.addBox({ x: 80, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'c.txt');

    expect(world.sortSelection('type', [p1, t1, p2])).toBe(3);

    // Ordem por extensão: .pdf (.pdf) < .txt → x dos pdfs à esquerda
    const xOf = (id: string) => world.getObject(id)!.pose.position.x;
    expect(xOf(p1)).toBeLessThan(xOf(t1));
    expect(xOf(p2)).toBeLessThan(xOf(t1));
    expect(xOf(p1)).toBeLessThan(xOf(p2)); // estabilidade: p1 antes de p2
  });

  it('retorna 0 com menos de 2 itens elegíveis', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    expect(world.sortSelection('size', [a])).toBe(0);
    expect(world.sortSelection('type', [])).toBe(0);
  });
});

describe('P0: Duplicar seleção', () => {
  it('cria cópias deslocadas, mantendo escala/meta e selecionando as cópias', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#4f9cff', 'a.txt', {
      fsPath: '/a.txt',
    });
    const b = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#ff6b6b', 'b.pdf', {
      fsPath: '/b.pdf',
    });
    world.select(a);
    world.toggleSelect(b); // seleção = [a, b]

    expect(world.duplicateSelection()).toBe(2);
    expect(world.objectCount()).toBe(4);

    const copies = world.getSelectedIds(); // cópias ficam selecionadas
    expect(copies).toHaveLength(2);
    // Ordem criada = ordem da seleção: copy[0] de a, copy[1] de b
    const copyA = world.getObject(copies[0])!;
    expect(copyA.label).toBe('a.txt');
    expect(copyA.meta.fsPath).toBe('/a.txt');
    expect(copyA.scale).toBe(1);
    expect(copyA.parentId).toBeNull();
    // Deslocada ao lado do original (não coincide)
    expect(copyA.pose.position.x).not.toBeCloseTo(0, 5);
    // Originais intactos
    expect(world.getObject(a)!.label).toBe('a.txt');
    expect(world.objectCount()).toBe(4);
  });

  it('retorna 0 sem seleção (nada a duplicar)', async () => {
    const { world } = await makeWorld();
    expect(world.duplicateSelection()).toBe(0);
    expect(world.objectCount()).toBe(0);
  });

  it('duplicata de item escalado mantém a escala', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    world.scaleSelection(1, [a]); // → 1.25
    world.select(a);

    expect(world.duplicateSelection()).toBe(1);
    const copy = world.getObject(world.getSelectedIds()[0])!;
    expect(copy.scale).toBe(1.25);
    expect(copy.meta.halfExtents).toEqual({ x: 7, y: 1.6, z: 7 }); // base, não escalada
  });
});

describe('P0: Escala com feedback de limite', () => {
  it('aumenta em passos de 25% e reflete no render e na física', async () => {
    const { world, physics, renderer } = await makeWorld();
    const id = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');

    const r = world.scaleSelection(1, [id]);
    expect(r).toEqual({ changed: 1, limit: null, scale: 1.25 });
    expect(world.getObject(id)!.scale).toBe(1.25);

    // Render: setScale com a nova escala
    expect(renderer.setScale).toHaveBeenLastCalledWith(expect.anything(), 1.25);
    // Física: corpo recriado com base × escala (8.75, 2, 8.75 = deitado × 1.25)
    const lastBox = vi.mocked(physics.createBox).mock.calls.at(-1)!;
    expect(lastBox[0]).toBe(id);
    expect(lastBox[2].x).toBeCloseTo(8.75, 5);
    expect(lastBox[2].y).toBeCloseTo(2, 5);
    expect(lastBox[2].z).toBeCloseTo(8.75, 5);
  });

  it(`bate no limite máximo (${SCALE_MAX}×) e reporta limit=max`, async () => {
    const { world } = await makeWorld();
    const id = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');

    let last = world.scaleSelection(1, [id]);
    for (let i = 0; i < 12; i++) last = world.scaleSelection(1, [id]);

    expect(world.getObject(id)!.scale).toBe(SCALE_MAX);
    expect(last.limit).toBe('max');
    expect(last.changed).toBe(0);
    expect(last.scale).toBeNull();
  });

  it(`bate no limite mínimo (${SCALE_MIN}×) e reporta limit=min`, async () => {
    const { world } = await makeWorld();
    const id = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');

    let last = world.scaleSelection(-1, [id]);
    for (let i = 0; i < 6; i++) last = world.scaleSelection(-1, [id]);

    expect(world.getObject(id)!.scale).toBe(SCALE_MIN);
    expect(last.limit).toBe('min');
    expect(last.changed).toBe(0);
  });

  it('ignora itens de pilha e pregados (changed=0, sem limite)', async () => {
    const { world } = await makeWorld();
    const a = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    const b = world.addBox({ x: 40, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'b.txt');
    const c = world.addBox({ x: 80, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'c.txt');
    expect(world.createPileFrom([a, b])).toBe(a);
    world.pinToWall(c, 0);

    const r = world.scaleSelection(1, [a, b, c]);
    expect(r).toEqual({ changed: 0, limit: null, scale: null });
    expect(world.getObject(a)!.scale).toBe(1);
    expect(world.getObject(c)!.scale).toBe(1);
  });

  it('loadSnapshot restaura a escala (render + corpo físico)', async () => {
    const { world: w1 } = await makeWorld();
    const id = w1.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    w1.scaleSelection(1, [id]); // 1 → 1.25
    w1.scaleSelection(1, [id]); // 1.25 → 1.5
    expect(w1.getObject(id)!.scale).toBe(1.5);
    const snap: SceneSnapshot = w1.toSnapshot();

    const { world: w2, physics, renderer } = await makeWorld();
    w2.loadSnapshot(snap);

    expect(w2.getObject(id)!.scale).toBe(1.5);
    expect(renderer.setScale).toHaveBeenLastCalledWith(expect.anything(), 1.5);
    const lastBox = vi.mocked(physics.createBox).mock.calls.at(-1)!;
    expect(lastBox[2].x).toBeCloseTo(10.5, 5); // 7 × 1.5
  });

  it('pinToWall usa a meia-extensão escalada (inset maior)', async () => {
    const { world } = await makeWorld();
    const id = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'a.txt');
    for (let i = 0; i < 4; i++) world.scaleSelection(1, [id]); // → 2.0
    expect(world.getObject(id)!.scale).toBe(2);

    world.pinToWall(id, 0); // parede norte (-z)
    // inset = he.y(1.6)×2 + t/2(10/2) + 0.5 = 3.2 + 5 + 0.5 = 8.7
    expect(world.getObject(id)!.pose.position.z).toBeCloseTo(-130 + 8.7, 5);
  });

  it('snapshot de item sem scale (dado antigo) é normalizado para 1', async () => {
    const { world: w1 } = await makeWorld();
    w1.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'old.txt');
    const snap = w1.toSnapshot();
    // Simula snapshot anterior ao P0: sem campo scale
    const row = snap.objects[0] as unknown as Record<string, unknown>;
    delete row.scale;

    const { world: w2, renderer } = await makeWorld();
    w2.loadSnapshot(snap);
    expect(w2.listObjects()[0].scale).toBe(1);
    expect(renderer.setScale).toHaveBeenLastCalledWith(expect.anything(), 1);
  });
});

describe('P0: helper de tipo (typeKey comparação)', () => {
  it('objeto sem extensão cai em sem-ext e pastas/notes têm prioridade', async () => {
    const { world } = await makeWorld();
    const dir = world.addBox({ x: 0, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'docs', {
      isDir: true,
    });
    const note = world.addStickyNote({ x: 40, y: 6, z: 0 }, 'oi');
    const plain = world.addBox({ x: 80, y: 1.6, z: 0 }, { x: 7, y: 1.6, z: 7 }, '#fff', 'README');

    // Ordena: pasta (0) < nota (1) < arquivo sem ext (2:sem-ext)
    expect(world.sortSelection('type', [plain, note, dir])).toBe(3);
    const xOf = (id: string) => world.getObject(id)!.pose.position.x;
    expect(xOf(dir)).toBeLessThan(xOf(note));
    expect(xOf(note)).toBeLessThan(xOf(plain));

    // Checagem de flags usadas pelo typeKey
    expect(world.getObject(dir)!.typeFlags & TypeFlags.Folder).toBeTruthy();
    expect(world.getObject(note)!.typeFlags & TypeFlags.StickyNote).toBeTruthy();
    expect(world.getObject(plain)!.kind).toBe(ObjectKind.Actor);
  });
});
