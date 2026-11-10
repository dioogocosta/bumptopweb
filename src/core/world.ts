/**
 * World — orquestrador puro da simulação.
 *
 * É o "cérebro" do BumpTop: mantém o modelo de objetos, consome AÇÕES SEMÂNTICAS
 * (do input) e coordena física + render através dos ports (IPhysics/IRenderer).
 * NÃO conhece Rapier, three.js nem SQL — só as interfaces.
 *
 * Espelha o EventManager::mainLoop + a máquina de estados de gestos do original,
 * mas em código puro e testável sem DOM/WebGL.
 */
import type {
  BumpObjectData,
  CameraState,
  PhysicsConfig,
  Pose,
  RoomConfig,
  SceneSnapshot,
  Vec3,
} from './model/types';
import { DEFAULT_PHYSICS, DEFAULT_ROOM, ObjectKind, PileLayout, TypeFlags } from './model/types';
import type { PhysicsLevel } from './model/types';
import type { BodyHandle, IOverlay, IPhysics, IRenderer, InputAction, ObjectHandle } from './ports/index';
import { t } from './i18n/i18n';
import { DampedSpringDrag, type SpringConfig } from './interaction/dampedSpringDrag';
import { OrbitCameraController } from './camera/orbitCameraController';
import { PileManager } from './piles/pileManager';
import {
  compareBySize,
  compareByType,
  rowOffsets,
  selectionGridOffsets,
  type ItemForSort,
  type SortKey,
} from './selection/selectionLayout';
import {
  computePointsAABB,
  distToSegmentSq,
  isPointInPolygon,
} from './selection/lassoGeometry';
import type { Theme } from './theme/theme';
import { clamp, identityQuat, vec3 } from './util/math';

/** Limites de escala (P0 — Scale com feedback de limite): [0.4, 3.0]. */
export const SCALE_MIN = 0.4;
export const SCALE_MAX = 3.0;
const SCALE_STEP = 0.25;
const FLICK_SPEED_PX = 1100; // px/s — limiar p/ flick folhear pilha (C)
export const LASSO_START_RADIUS = 22;
export const SHEET_HALF_THICKNESS = 0.35;

/** Itens são folhas (como no BumpTop original), não caixas: espessura ~5% da largura. */
export function asSheet(he: Vec3): Vec3 {
  const thin = Math.round(Math.max(0.2, Math.max(he.x, he.z) * 0.05) * 1000) / 1000;
  return { x: he.x, y: Math.min(he.y, thin), z: he.z };
}
export const LASSO_CROSS_RADIUS = 20;
const GROUP_CLICK_PX = 3;
const ESCAPE_MARGIN = 1;

interface GroupMember {
  id: string;
  dx: number;
  dz: number;
  y: number;
}

/** Pilha arrastada em grupo: origem no início + referência p/ medir o delta. */
interface GroupPile {
  baseId: string;
  origin: Vec3;
  refId: string;
  refStart: Vec3;
}

export type LassoMenuListener = (screen: { x: number; y: number }, ids: string[]) => void;

interface Entry {
  data: BumpObjectData;
  body: BodyHandle;
  render: ObjectHandle;
}

export interface WorldDeps {
  physics: IPhysics;
  renderer: IRenderer;
  /** Opcional: labels de arquivo projetados no DOM (M1). */
  overlay?: IOverlay;
}

let idCounter = 0;
const newId = () => `obj_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

export class World {
  private deps: WorldDeps;
  private entries = new Map<string, Entry>();
  private camera: OrbitCameraController;
  private drag = new DampedSpringDrag();
  private room: RoomConfig;
  private physicsConfig: PhysicsConfig;

  private pickedId: string | null = null;
  private dragHeight = 0;
  private dirty = true;
  private piles = new PileManager();
  /** Seleção múltipla (Fase 7): conjunto de ids com highlight. */
  private selectedIds = new Set<string>();
  private shoving = false;
  private lastShovePoint: Vec3 | null = null;
  /** Laço (rubber-band / livre) ativo (P1). */
  private lassoing = false;
  private lassoStart: { x: number; y: number } | null = null;
  private lassoPoints: Array<{ x: number; y: number }> = [];
  private lassoBase = new Set<string>();
  private lassoLeftStart = false;
  private lassoClosed = false;
  private lassoCrossTarget: { x: number; y: number } | null = null;
  private lassoMenuListener: LassoMenuListener | null = null;
  private group: GroupMember[] = [];
  private groupStartScreen: { x: number; y: number } | null = null;
  private groupMoved = false;
  private groupPiles: GroupPile[] = [];
  private physicsLevel: PhysicsLevel;
  /** Prender automaticamente na parede ao arremessar/arrastar até ela (desligado: o item bate e volta). */
  private autoWallPin = false;
  /** ids lançados recentemente (TTL em s) → elegíveis a WallToss. */
  private recentToss = new Map<string, number>();

  /** Flick: aguarda o 1º move para decidir se folheia (speed) ou arranca (drag). */
  private pendingPull: { id: string; startWorld: Vec3; startScreen: { x: number; y: number } } | null = null;

  /** Scrunch ativo (3+ dedos no chão): impede pull imediato até pointerUp. */
  private scrunchActive = false;

  /** id da pilha atualmente sob hover do cursor (Pile Widget Halo). */
  private hoveredPileId: string | null = null;
  /** Dwell & Scrub (P1): temporizador de dwell em ms sobre a pilha hovered. */
  private dwellTimer = 0;
  /** True quando o cursor repousou sobre a pilha por >= 400ms. */
  private dwellActive = false;
  /** Índice do item ativo na visualização/scrub da pilha. */
  private scrubIndex = 0;
  /** Item temporariamente elevado no topo da pilha pelo scrub/peel. */
  private activePeelId: string | null = null;
  /** Exploding piles (P1): arrastar item para fora explode/dissolve a pilha. */
  private explodingPiles = true;
  /** Auto-align suave (P1 - Item 12): alinha itens soltos à grade implícita de eixos. */
  private autoAlign = true;
  /** Mostrar o nome (rótulo) dos arquivos abaixo dos ícones (toggle do menu do chão). */
  private showNames = true;

  constructor(deps: WorldDeps, opts?: { room?: RoomConfig; physics?: PhysicsConfig; spring?: Partial<SpringConfig> }) {
    this.deps = deps;
    this.room = opts?.room ?? DEFAULT_ROOM;
    this.physicsConfig = opts?.physics ?? DEFAULT_PHYSICS;
    this.physicsLevel = this.physicsConfig.level ?? 2;
    this.camera = new OrbitCameraController();
    // O limiar de toss vem das constantes reais do original (ground-truth).
    this.drag.setConfig({ minTossVelocitySq: this.physicsConfig.minStartTossVelocitySq });
    if (opts?.spring) this.drag.setConfig(opts.spring);
  }

  async init(): Promise<void> {
    await this.deps.physics.init(this.physicsConfig, this.room);
    this.deps.physics.createRoom(this.room);
    this.deps.renderer.addRoom(this.room);
    this.deps.renderer.setCamera(this.camera.getState());
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Gestão de objetos
  // -------------------------------------------------------------------------

  /** Adiciona um "ícone" (caixa) à cena. `opts` carrega metadados de FS (M2). */
  addBox(
    pos: Vec3,
    halfExtents: Vec3,
    color: string,
    label: string,
    opts?: { fsPath?: string; isDir?: boolean; thumb?: string | null },
  ): string {
    const id = newId();
    halfExtents = asSheet(halfExtents);
    const inner = this.innerWall();
    const mx = Math.max(0, inner - halfExtents.x);
    const mz = Math.max(0, inner - halfExtents.z);
    pos = { x: clamp(pos.x, -mx, mx), y: Math.max(halfExtents.y, pos.y), z: clamp(pos.z, -mz, mz) };
    const body = this.deps.physics.createBox(id, pos, halfExtents);
    const render = this.deps.renderer.addBox(id, halfExtents, color);
    this.deps.renderer.setPose(render, { position: pos, rotation: identityQuat() });
    if (opts?.thumb) this.deps.renderer.setTexture(render, opts.thumb);
    const data: BumpObjectData = {
      id,
      kind: ObjectKind.Actor,
      typeFlags: TypeFlags.File | TypeFlags.FileSystem | (opts?.isDir ? TypeFlags.Folder : 0),
      parentId: null,
      pose: { position: pos, rotation: identityQuat() },
      velocity: vec3(),
      scale: 1,
      pinnedWall: null,
      frozen: false,
      label,
      meta: {
        halfExtents,
        color,
        ...(opts?.fsPath !== undefined ? { fsPath: opts.fsPath } : {}),
        ...(opts?.isDir !== undefined ? { isDir: opts.isDir } : {}),
        ...(opts?.thumb !== undefined ? { thumb: opts.thumb } : {}),
      },
    };
    this.entries.set(id, { data, body, render });
    this.dirty = true;
    return id;
  }

  /** Aplica thumbnail a um objeto (render + meta). */
  setObjectThumb(id: string, thumb: string | null): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.data.meta.thumb = thumb;
    this.deps.renderer.setTexture(e.render, thumb);
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Sticky notes (M6)
  // -------------------------------------------------------------------------

  /**
   * Cria uma nota adesiva (caixa amarela com texto editável).
   * Espelha o StickyNote do original: objeto de cena com conteúdo próprio.
   */
  addStickyNote(pos: Vec3, text = ''): string {
    const halfExtents = vec3(6, 1.2, 6); // nota deitada no chão
    const id = this.addBox(pos, halfExtents, '#ffd43b', 'Nota');
    const e = this.entries.get(id)!;
    e.data.typeFlags |= TypeFlags.StickyNote;
    e.data.meta.noteText = text;
    return id;
  }

  /** Atualiza o texto de uma nota adesiva. */
  setNoteText(id: string, text: string): boolean {
    const e = this.entries.get(id);
    if (!e || (e.data.typeFlags & TypeFlags.StickyNote) === 0) return false;
    e.data.meta.noteText = text;
    this.dirty = true;
    return true;
  }

  isStickyNote(id: string): boolean {
    const e = this.entries.get(id);
    return !!e && (e.data.typeFlags & TypeFlags.StickyNote) !== 0;
  }

  /** Todos os objetos (p/ serviços como importação de pasta). */
  listObjects(): BumpObjectData[] {
    return [...this.entries.values()].map((e) => e.data);
  }

  removeObject(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (this.piles.contains(id)) this.piles.remove(id);
    this.selectedIds.delete(id);
    this.deps.physics.removeBody(e.body);
    this.deps.renderer.remove(e.render);
    this.deps.overlay?.setLabel(id, null, null);
    this.entries.delete(id);
    this.dirty = true;
  }

  getObject(id: string): BumpObjectData | null {
    return this.entries.get(id)?.data ?? null;
  }

  objectCount(): number {
    return this.entries.size;
  }

  // -------------------------------------------------------------------------
  // Processamento de ações semânticas
  // -------------------------------------------------------------------------

  processAction(action: InputAction): void {
    switch (action.type) {
      case 'pointerDown':
        this.onPointerDown(action);
        break;
      case 'pointerMove':
        this.onPointerMove(action);
        break;
      case 'hover':
        this.onHover(action.world, action.screen);
        break;
      case 'pointerUp':
        this.onPointerUp(action.world, action.screen);
        break;
      case 'cancel':
        this.onCancel();
        break;
      case 'zoom':
        // Pinch (2 dedos) sobre pilha → fan out (C)
        if (action.pinch && action.world) {
          const hit = this.pickAt(action.world);
          if (hit && this.piles.contains(hit)) {
            const base = this.piles.baseOf(hit);
            const state = base ? this.piles.getState(base) : null;
            if (state && state.layout !== PileLayout.Leaf) {
              this.fanOutPile(hit);
              this.deps.overlay?.toast(t('toast.pileFanned'));
              break;
            }
          }
        }
        // Scroll sobre uma pilha → navega a pilha em vez de zoom (Fase 7)
        if (action.world && this.scrollPileAt(action.world, action.delta)) break;
        this.camera.zoom(action.delta);
        this.dirty = true;
        break;
      case 'pan':
        this.camera.pan(action.dx, action.dy);
        this.dirty = true;
        break;
      case 'orbit':
        this.camera.orbit(action.dAzimuth, action.dElevation);
        this.deps.renderer.setCamera(this.camera.getState());
        this.dirty = true;
        break;
      case 'scrunch':
        // C (scrunch): 3+ dedos no chão → junta objetos soltos próximos numa pilha
        if (!this.scrunchActive && action.world) {
          this.scrunchActive = true;
          const nearby: string[] = [];
          const RADIUS = 30;
          for (const e of this.entries.values()) {
            if (this.piles.contains(e.data.id)) continue;
            if (e.data.pinnedWall != null) continue;
            const p = e.data.pose.position;
            const d = Math.hypot(p.x - action.world!.x, p.z - action.world!.z);
            if (d <= RADIUS) nearby.push(e.data.id);
          }
          if (nearby.length >= 2) {
            this.createPileFrom(nearby);
            this.deps.overlay?.toast(t('toast.scrunchPile'));
          }
        }
        break;
      case 'context':
        // M0: contexto futuro; por ora marca sujo (menu fica p/ overlay)
        break;
      default:
        break;
    }
  }

  private onPointerDown(a: Extract<InputAction, { type: 'pointerDown' }>): void {
    const worldPoint = a.world;
    // Botão direito / do meio: órbita da câmera (não arrasta objeto)
    if (a.button !== 0) return;
    const hit = this.pickAt(worldPoint, undefined, a.screen);
    const isTouch = a.pointerType === 'touch';

    // Shift+clique → seleção aditiva (multi-select, Fase 7)
    if (a.shift && hit) {
      this.toggleSelect(hit);
      return;
    }

    if (hit && this.canGroupDrag(hit)) {
      this.beginGroupDrag(hit, worldPoint, a.screen);
      return;
    }

    // Seleção (M4): clicar seleciona; clicar no vazio limpa
    this.select(hit);

    // Novo down (não-lasso/shove) limpa flag de scrunch e esconde halo/dwell
    this.scrunchActive = false;
    this.hoveredPileId = null;
    this.dwellTimer = 0;
    this.dwellActive = false;
    this.scrubIndex = 0;
    this.resetPeel();

    if (!hit) {
      // Original: LassoMenu inicia no chão vazio com MOUSE; ShoveGesture é
      // gesto de TOQUE (contato largo). Aqui: mouse/pen → laço, toque → shove.
      if (!isTouch) {
        this.lassoing = true;
        this.lassoStart = { ...a.screen };
        this.lassoPoints = [{ ...a.screen }];
        this.lassoBase = new Set(this.selectedIds);
        this.lassoLeftStart = false;
        this.lassoClosed = false;
        this.lassoCrossTarget = null;
        this.deps.overlay?.setLasso({
          x: a.screen.x,
          y: a.screen.y,
          w: 0,
          h: 0,
          points: [{ ...a.screen }],
        });
        return;
      }
      // Shove (M5): arrastar o CHÃO com o dedo empurra os objetos próximos
      this.shoving = true;
      this.lastShovePoint = worldPoint;
      return;
    }

    // Item de pilha: NÃO arranca ainda — aguarda 1º move p/ flick vs drag (C)
    if (this.piles.contains(hit)) {
      this.pendingPull = { id: hit, startWorld: worldPoint, startScreen: a.screen };
      return;
    }

    // Arrancar um item de uma pilha (drag para fora dissolve/reorganiza)
    if (this.piles.contains(hit)) this.pullFromPile(hit);
    // Item pregado na parede: arrastar desprega (volta ao dinâmico)
    if (this.entries.get(hit)?.data.pinnedWall != null) this.pinToWall(hit, null);

    this.pickedId = hit;
    const e = this.entries.get(hit)!;
    this.dragHeight = e.data.pose.position.y;
    // O corpo vira "kinematic": segue a mola, colisão desligada no drag
    this.deps.physics.setFrozen(e.body, true);
    this.drag.begin(e.data.pose.position, worldPoint);
    this.dirty = true;
  }

  private onPointerMove(action: Extract<InputAction, { type: 'pointerMove' }>): void {
    const worldPoint = action.world;
    const screen = action.screen;

    // Laço: atualiza o retângulo e a seleção ao vivo (Fase 7)
    if (this.lassoing) {
      this.updateLasso(screen);
      return;
    }
    // Shove: empurra objetos no caminho do cursor no chão
    if (this.shoving) {
      this.applyShove(worldPoint);
      this.lastShovePoint = worldPoint;
      return;
    }

    // Flick / drag em item de pilha: 1º move decide (C)
    if (this.pendingPull && !this.pickedId) {
      const speed = action.speed ?? 0;
      const dx = screen.x - this.pendingPull.startScreen.x;
      const dy = screen.y - this.pendingPull.startScreen.y;
      const dist = Math.hypot(dx, dy);
      // Flick: velocidade alta + distância mínima → folheia sem arrancar
      if (speed >= FLICK_SPEED_PX && dist >= 30) {
        this.navigatePile(this.pendingPull.id, speed > 0 ? 1 : -1);
        this.pendingPull = null;
        return;
      }
      // Drag normal: movimento suficiente → arranca da pilha e inicia drag
      if (dist >= 3) {
        const pullId = this.pendingPull.id;
        this.pullFromPile(pullId);
        this.pendingPull = null;
        this.pickedId = pullId;
        const e = this.entries.get(pullId);
        if (e) {
          this.dragHeight = e.data.pose.position.y;
          this.deps.physics.setFrozen(e.body, true);
          this.drag.begin(e.data.pose.position, worldPoint);
        }
      } else {
        return; // ainda muito curto — aguarda
      }
    }

    if (!this.pickedId || !this.drag.isDragging) return;
    if (this.groupStartScreen && !this.groupMoved) {
      const moved = Math.hypot(screen.x - this.groupStartScreen.x, screen.y - this.groupStartScreen.y);
      if (moved >= GROUP_CLICK_PX) this.groupMoved = true;
    }
    this.drag.setTarget({ x: worldPoint.x, y: this.dragHeight, z: worldPoint.z });
  }

  /** Clicar num item que já faz parte de uma seleção múltipla arrasta o grupo. */
  private canGroupDrag(hit: string): boolean {
    if (this.selectedIds.size < 2) return false;
    // Membro de pilha: a pilha conta como selecionada se QUALQUER membro
    // estiver na seleção (item 5 — arrastar a pilha junto com o grupo).
    const base = this.piles.baseOf(hit);
    if (base) {
      const st = this.piles.getState(base);
      if (!st || !st.children.some((c) => this.selectedIds.has(c))) return false;
    } else if (!this.selectedIds.has(hit)) return false;
    if (this.entries.get(hit)?.data.pinnedWall != null) return false;
    return this.groupTargets().length >= 2;
  }

  /**
   * Alvos do arraste em grupo (item 5): `layoutTargets` (itens soltos) mais as
   * pilhas representadas na seleção com TODOS os seus membros — a pilha move
   * como unidade. Diferente de `layoutTargets` (grid/sort/rotate), que segue
   * ignorando pilha.
   */
  private groupTargets(): string[] {
    const out = new Set(this.layoutTargets());
    for (const [baseId, state] of this.piles.allStates()) {
      if (!state.children.some((c) => this.selectedIds.has(c))) continue;
      out.add(baseId);
      for (const c of state.children) out.add(c);
    }
    return [...out];
  }

  /**
   * Arraste em grupo: o item clicado segue a mola e os demais selecionados
   * acompanham mantendo a distância relativa (formação), todos kinematic.
   */
  private beginGroupDrag(hit: string, worldPoint: Vec3, screen: { x: number; y: number }): void {
    this.scrunchActive = false;
    this.hoveredPileId = null;
    this.dwellTimer = 0;
    this.dwellActive = false;
    this.scrubIndex = 0;
    this.resetPeel();

    const leader = this.entries.get(hit)!;
    const lp = leader.data.pose.position;
    this.group = [];
    const targets = this.groupTargets();
    for (const id of targets) {
      if (id === hit) continue;
      const e = this.entries.get(id)!;
      const p = e.data.pose.position;
      this.group.push({ id, dx: p.x - lp.x, dz: p.z - lp.z, y: p.y });
      this.deps.physics.setFrozen(e.body, true);
    }
    // Pilhas representadas na seleção: a origem é atualizada no release para
    // os membros não voltarem às posições antigas (item 5).
    this.groupPiles = [];
    const seenPiles = new Set<string>();
    for (const id of targets) {
      const base = this.piles.baseOf(id);
      if (!base || seenPiles.has(base)) continue;
      seenPiles.add(base);
      const st = this.piles.getState(base);
      const ref = this.entries.get(id);
      if (!st || !ref) continue;
      this.groupPiles.push({
        baseId: base,
        origin: { ...st.origin },
        refId: id,
        refStart: { ...ref.data.pose.position },
      });
    }
    this.groupStartScreen = { ...screen };
    this.groupMoved = false;
    this.pickedId = hit;
    this.dragHeight = lp.y;
    this.deps.physics.setFrozen(leader.body, true);
    this.drag.begin(lp, worldPoint);
    this.dirty = true;
  }

  /** Solta os seguidores do grupo (com a mesma velocidade do líder se houve toss). */
  private releaseGroup(velocity: Vec3 | null): void {
    for (const m of this.group) {
      const e = this.entries.get(m.id);
      if (!e) continue;
      // Membro de pilha permanece congelado — a pilha é gerenciada pelo layout.
      if (this.piles.contains(m.id)) continue;
      this.deps.physics.setFrozen(e.body, false);
      if (velocity) {
        this.deps.physics.setVelocity(e.body, velocity);
        if (this.autoWallPin) this.recentToss.set(m.id, 3);
      }
    }
    // Item 5: atualiza a origem das pilhas arrastadas e reaplica o layout —
    // sem isso os membros voltariam às posições antigas no release.
    if (this.groupPiles.length > 0) {
      for (const gp of this.groupPiles) {
        const ref = this.entries.get(gp.refId);
        if (!ref) continue;
        const cur = ref.data.pose.position;
        this.piles.setOrigin(gp.baseId, {
          x: gp.origin.x + (cur.x - gp.refStart.x),
          y: gp.origin.y,
          z: gp.origin.z + (cur.z - gp.refStart.z),
        });
      }
      this.applyPileLayout();
    }
    this.groupPiles = [];
    this.group = [];
    this.groupStartScreen = null;
  }

  /**
   * Shove (M5): ao arrastar o chão, objetos dentro do raio recebem impulso
   * na direção do movimento — espelha o "empurrar" do original.
   */
  private applyShove(worldPoint: Vec3): void {
    const prev = this.lastShovePoint;
    if (!prev) return;
    const dx = worldPoint.x - prev.x;
    const dz = worldPoint.z - prev.z;
    if (dx * dx + dz * dz < 1e-6) return;
    const RADIUS = 16;
    for (const e of this.entries.values()) {
      if (this.piles.contains(e.data.id)) continue; // pilha é gerenciada
      if (e.data.pinnedWall != null) continue; // pregado não empurra
      const p = e.data.pose.position;
      const d = Math.hypot(p.x - worldPoint.x, p.z - worldPoint.z);
      if (d > RADIUS) continue;
      // Força cai com o quadrado da distância
      const falloff = 1 - d / RADIUS;
      this.deps.physics.setFrozen(e.body, false);
      this.deps.physics.setVelocity(e.body, {
        x: dx * 60 * falloff,
        y: 20 * falloff,
        z: dz * 60 * falloff,
      });
      this.dirty = true;
    }
  }

  /**
   * Hover do mouse (sem clique): ao passar sobre uma pilha, exibe o Pile Widget Halo
   * e ativa o Dwell & Scrub (P1).
   */
  private onHover(worldPoint: Vec3, _screen: { x: number; y: number }): void {
    if (this.drag.isDragging || this.lassoing || this.shoving) {
      if (this.hoveredPileId) {
        this.hoveredPileId = null;
        this.dwellTimer = 0;
        this.dwellActive = false;
        this.scrubIndex = 0;
        this.resetPeel();
        this.dirty = true;
      }
      return;
    }
    const hit = this.pickAt(worldPoint);
    if (hit && this.piles.contains(hit)) {
      const base = this.piles.baseOf(hit)!;
      if (this.hoveredPileId !== base) {
        this.hoveredPileId = base;
        this.dwellTimer = 0;
        this.dwellActive = false;
        this.scrubIndex = 0;
        this.resetPeel();
        this.dirty = true;
      } else if (this.dwellActive) {
        // Scrubbing por movimento relativo do mouse sobre a pilha (P1)
        const state = this.piles.getState(base);
        if (state && state.children.length > 1) {
          const count = state.children.length;
          const baseEntry = this.entries.get(base);
          if (baseEntry) {
            const p = baseEntry.data.pose.position;
            const dx = worldPoint.x - p.x;
            const norm = Math.max(0, Math.min(0.999, (dx + 12) / 24));
            const idx = Math.floor(norm * count);
            this.setScrubIndex(base, idx);
          }
        }
      }
      return;
    }
    // Enquanto o cursor estiver sobre o elemento DOM do halo ou da faixa de scrub, mantém
    if (this.deps.overlay?.isHaloHovered?.() || this.deps.overlay?.isScrubHovered?.()) return;

    // Se já havia uma pilha sob hover, mantém enquanto o cursor estiver dentro do raio do halo (~24 unidades)
    if (this.hoveredPileId) {
      const baseEntry = this.entries.get(this.hoveredPileId);
      if (baseEntry) {
        const p = baseEntry.data.pose.position;
        const dx = worldPoint.x - p.x;
        const dz = worldPoint.z - p.z;
        if (Math.hypot(dx, dz) <= 24) {
          return;
        }
      }
    }

    if (this.hoveredPileId) {
      this.hoveredPileId = null;
      this.dwellTimer = 0;
      this.dwellActive = false;
      this.scrubIndex = 0;
      this.resetPeel();
      this.dirty = true;
    }
  }

  private onPointerUp(worldPoint: Vec3, screen?: { x: number; y: number }): void {
    if (this.lassoing) {
      const start = this.lassoStart;
      const end = screen ?? this.lassoPoints[this.lassoPoints.length - 1] ?? null;
      const inDisc =
        start !== null &&
        end !== null &&
        Math.hypot(end.x - start.x, end.y - start.y) <= LASSO_START_RADIUS;
      const openMenu = this.lassoClosed && inDisc && this.selectedIds.size > 0;
      this.endLasso();
      if (openMenu && start) this.lassoMenuListener?.(start, [...this.selectedIds]);
      return;
    }
    if (this.shoving) {
      this.shoving = false;
      this.lastShovePoint = null;
      this.dirty = true;
      return;
    }

    // Flick/drag pendente em item de pilha: resolve no up (C)
    if (this.pendingPull) {
      this.pullFromPile(this.pendingPull.id);
      // Se houve movimento mínimo, tenta empilhar no destino (preserva clique atual)
      const moved = screen && (Math.hypot(screen.x - this.pendingPull.startScreen.x, screen.y - this.pendingPull.startScreen.y) >= 3);
      if (moved) this.tryStack(this.pendingPull.id, worldPoint);
      this.pendingPull = null;
      this.dirty = true;
      return;
    }

    if (!this.pickedId || !this.drag.isDragging) return;
    const e = this.entries.get(this.pickedId);
    this.pickedId = null;
    if (!e) return;
    if (this.groupStartScreen) {
      const { velocity, toss } = this.drag.end();
      const clicked = !this.groupMoved;
      // Líder dentro de pilha permanece congelado (o layout o reposiciona).
      const leaderInPile = this.piles.contains(e.data.id);
      if (!leaderInPile) {
        this.deps.physics.setFrozen(e.body, false);
        if (toss) {
          this.deps.physics.setVelocity(e.body, velocity);
          if (this.autoWallPin) this.recentToss.set(e.data.id, 3);
        }
      }
      this.releaseGroup(toss ? velocity : null);
      if (clicked) this.select(e.data.id);
      this.dirty = true;
      return;
    }
    const { velocity, toss } = this.drag.end();
    // Descongela e devolve ao mundo físico
    this.deps.physics.setFrozen(e.body, false);
    if (toss) {
      // TOSS: o objeto voa como projétil com a velocidade da mola
      this.deps.physics.setVelocity(e.body, velocity);
      // WallToss (Fase 7): toss recente pode pregar o objeto na parede (se ligado)
      if (this.autoWallPin) this.recentToss.set(e.data.id, 3);
    } else {
      // B: arrastar até a parede (sem toss) gruda — antes do tryStack
      const wall = this.autoWallPin ? this.wallContact(e) : null;
      if (wall !== null) {
        this.pinToWall(e.data.id, wall);
        this.deps.overlay?.toast(t('toast.pinnedToWall'));
        this.dirty = true;
        return;
      }
      // Solto sem toss perto de outro objeto → empilha (M3)
      this.tryStack(e.data.id, worldPoint);
      // Auto-align suave (P1 - Item 12): se não empilhou, alinha à grade implícita
      if (this.autoAlign && !this.piles.contains(e.data.id) && e.data.pinnedWall == null) {
        this.applyAutoAlign(e, worldPoint);
      }
    }
    this.dirty = true;
  }

  /**
   * Tenta criar/adicionar a uma pilha com o item solto sobre `worldPoint`.
   * Regras: alvo não pode ser o próprio item nem uma pasta (pasta = mover, M2).
   */
  private tryStack(draggedId: string, worldPoint: Vec3): void {
    const targetId = this.pickAt(worldPoint, draggedId);
    if (!targetId || targetId === draggedId) return;
    const target = this.entries.get(targetId);
    if (!target || target.data.meta.isDir === true) return;

    if (this.piles.contains(targetId)) {
      // Alvo já é parte de pilha → entra no topo da pilha existente
      const base = this.piles.baseOf(targetId)!;
      this.piles.add(base, draggedId, this.piles.getState(base)!.origin);
    } else if (this.piles.contains(draggedId)) {
      // O arrastado é uma pilha-base → o alvo entra nela
      this.piles.add(draggedId, targetId, this.piles.getState(draggedId)!.origin);
    } else {
      // Dois itens soltos → nova pilha (base = alvo, que já está no chão)
      const origin = target.data.pose.position;
      this.piles.create(targetId, draggedId, { x: origin.x, y: origin.y, z: origin.z });
    }
    this.applyPileLayout();
  }

  /**
   * Arranca um item da pilha: se a pilha restar com <2 itens, ela dissolve e
   * os membros voltam à dinâmica; senão só re-layouta.
   */
  private pullFromPile(objectId: string): void {
    const baseBefore = this.piles.baseOf(objectId);
    const membersBefore = baseBefore ? [...(this.piles.getState(baseBefore)?.children ?? [])] : [];
    const shouldExplode = this.explodingPiles && baseBefore !== null && membersBefore.length > 2;
    const { dissolved, baseId } = this.piles.remove(objectId);

    if (shouldExplode) {
      // Exploding piles (P1): puxar um item explode/espalha o restante da pilha
      const remaining = membersBefore.filter((id) => id !== objectId);
      for (const id of remaining) {
        this.piles.remove(id);
        const e = this.entries.get(id);
        if (e) {
          e.data.parentId = null;
          this.deps.physics.setFrozen(e.body, false);
          const angle = Math.random() * Math.PI * 2;
          const speed = 14 + Math.random() * 10;
          this.deps.physics.setVelocity(e.body, {
            x: Math.cos(angle) * speed,
            y: 8,
            z: Math.sin(angle) * speed,
          });
        }
      }
      this.applyPileLayout();
      this.deps.overlay?.toast(t('toast.pileExploded'));
      if (this.hoveredPileId === baseBefore) this.hoveredPileId = null;
    } else if (dissolved && baseId) {
      // Pilha acabou: todos os membros (inclusive o arrancado) voltam dinâmicos
      for (const id of membersBefore) {
        const e = this.entries.get(id);
        if (e) {
          this.deps.physics.setFrozen(e.body, false);
          if (id !== objectId) e.data.parentId = null;
        }
      }
      if (this.hoveredPileId === baseBefore) this.hoveredPileId = null;
    } else if (baseId) {
      this.applyPileLayout();
    }

    const e = this.entries.get(objectId);
    if (e) {
      this.deps.physics.setFrozen(e.body, false);
      e.data.parentId = null;
    }
    this.dirty = true;
  }

  /** Duplo-clique no chão vazio → fecha leques (Leaf → Stack). Retorna nº fechado. */
  collapseFanOuts(): number {
    return this.collapsePiles();
  }

  /**
   * Cria uma pilha a partir de uma lista de ids (auto-pilha por tipo, Fase 7).
   * Usa o primeiro item como base no topo do mundo. Retorna a base ou null.
   */
  createPileFrom(ids: string[]): string | null {
    const valid = ids.filter((id) => this.entries.has(id) && !this.piles.contains(id));
    if (valid.length < 2) return null;
    const base = valid[0];
    const baseEntry = this.entries.get(base)!;
    const origin = baseEntry.data.pose.position;
    const halfZ = this.scaledHalf(baseEntry).y; // espessura = eixo Y (deitado)
    this.piles.create(base, valid[1], origin, halfZ);
    for (let i = 2; i < valid.length; i++) {
      this.piles.add(base, valid[i], origin, halfZ);
    }
    this.applyPileLayout();
    return base;
  }

  /**
   * Agrupa arquivos soltos por extensão em pilhas (auto-pilha por tipo).
   * Retorna o número de pilhas criadas.
   */
  autoStackByType(): number {
    const groups = new Map<string, string[]>();
    for (const e of this.entries.values()) {
      if (this.piles.contains(e.data.id)) continue;
      if ((e.data.typeFlags & TypeFlags.StickyNote) !== 0) continue;
      if (e.data.meta.isDir === true) continue;
      const ext = (e.data.label ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? 'sem-ext';
      const list = groups.get(ext) ?? [];
      list.push(e.data.id);
      groups.set(ext, list);
    }
    let created = 0;
    for (const ids of groups.values()) {
      if (ids.length >= 2 && this.createPileFrom(ids)) created++;
    }
    return created;
  }

  /**
   * Renomeia um objeto (rótulo) — F2 / menu de contexto (Fase 7).
   * Retorna false se o id não existe.
   */
  renameObject(id: string, label: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    e.data.label = label;
    this.dirty = true;
    return true;
  }

  /** Objeto está em qualquer pilha? */
  inPile(id: string): boolean {
    return this.piles.contains(id);
  }

  /**
   * Aplica o layout de todas as pilhas: membros viram kinematic nas posições
   * calculadas; itens fora da página do Grid ficam ocultos.
   */
  private applyPileLayout(): void {
    const childToBase = new Map<string, string>();
    for (const [baseId, state] of this.piles.allStates()) {
      for (const c of state.children) childToBase.set(c, baseId);
    }
    for (const [baseId, state] of this.piles.allStates()) {
      for (const childId of state.children) {
        const e = this.entries.get(childId);
        if (!e) continue;
        const pos = this.piles.positionOf(childId);
        if (!pos) {
          // Fora da página do Grid → oculto (mas mantido na pilha)
          this.deps.renderer.setVisible(e.render, false);
          this.deps.physics.setFrozen(e.body, true);
          continue;
        }
        this.deps.renderer.setVisible(e.render, true);
        this.deps.physics.setFrozen(e.body, true);
        this.deps.physics.setPosition(e.body, pos);
        e.data.pose = { position: pos, rotation: e.data.pose.rotation };
        this.deps.renderer.setPose(e.render, e.data.pose);
        // Base da pilha mantém parentId null (é raiz); filhos apontam p/ base
        e.data.parentId = childId === baseId ? null : baseId;
      }
    }
    // Itens órfãos (saíram de pilhas) ficam visíveis de novo
    for (const e of this.entries.values()) {
      if (!childToBase.has(e.data.id)) {
        this.deps.renderer.setVisible(e.render, true);
        if (e.data.parentId !== null && !this.piles.contains(e.data.id)) {
          e.data.parentId = null;
        }
      }
    }
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // API pública de pilhas (M3)
  // -------------------------------------------------------------------------

  /** Cicla o layout de uma pilha: Stack → Grid → Leaf → Stack. */
  togglePileLayout(objectId: string): void {
    const base = this.piles.baseOf(objectId);
    if (!base) return;
    const state = this.piles.getState(base)!;
    const next =
      state.layout === PileLayout.Stack
        ? PileLayout.Grid
        : state.layout === PileLayout.Grid
          ? PileLayout.Leaf
          : PileLayout.Stack;
    this.piles.setLayout(base, next);
    this.applyPileLayout();
  }

  /** Próxima página de um Grid. */
  nextPilePage(objectId: string): void {
    const base = this.piles.baseOf(objectId);
    if (!base) return;
    if (this.piles.nextPage(base)) this.applyPileLayout();
  }

  /** Página anterior de um Grid. */
  prevPilePage(objectId: string): void {
    const base = this.piles.baseOf(objectId);
    if (!base) return;
    if (this.piles.prevPage(base)) this.applyPileLayout();
  }

  /**
   * Scroll do mouse sobre uma pilha (Fase 7 — scroll-over-pile).
   * Grid → pagina; Stack → "peel" (gira os itens, revelando o próximo).
   * Retorna true se consumiu o scroll (não deve dar zoom na câmera).
   */
  private scrollPileAt(worldPoint: Vec3, delta: number): boolean {
    const hit = this.pickAt(worldPoint);
    if (!hit) return false;
    // delta > 0 = scroll down/away = next/peel forward
    return this.navigatePile(hit, delta > 0 ? 1 : -1);
  }

  /** Duplo-clique numa pilha → abre em leque (Leaf), como o original. */
  fanOutPile(objectId: string): boolean {
    const base = this.piles.baseOf(objectId);
    if (!base) return false;
    this.piles.setLayout(base, PileLayout.Leaf);
    this.applyPileLayout();
    return true;
  }

  /**
   * Duplo-clique no chão vazio → fecha leques/voltas empilhado (Fase 7):
   * toda pilha em Leaf volta a Stack.
   */
  collapsePiles(): number {
    let n = 0;
    for (const [baseId, state] of this.piles.allStates()) {
      if (state.layout === PileLayout.Leaf) {
        this.piles.setLayout(baseId, PileLayout.Stack);
        n++;
      }
    }
    if (n > 0) this.applyPileLayout();
    return n;
  }

  /** Esta pilha está em Leaf? (p/ testes e menu) */
  isFanOutPile(objectId: string): boolean {
    const base = this.piles.baseOf(objectId);
    if (!base) return false;
    return this.piles.getState(base)!.layout === PileLayout.Leaf;
  }

  /** A pilha deste objeto está em Grid? (p/ habilitar navegação no menu) */
  isGridPile(objectId: string): boolean {
    const base = this.piles.baseOf(objectId);
    if (!base) return false;
    return this.piles.getState(base)!.layout === PileLayout.Grid;
  }

  /** Retorna o estado do halo da pilha atualmente sob hover (Pile Widget Halo). */
  getPileHaloState(): { pileId: string; layout: PileLayout; messy: boolean; itemCount: number } | null {
    if (!this.hoveredPileId) return null;
    const state = this.piles.getState(this.hoveredPileId);
    if (!state) {
      this.hoveredPileId = null;
      return null;
    }
    return {
      pileId: this.hoveredPileId,
      layout: state.layout,
      messy: state.messy !== false,
      itemCount: state.children.length,
    };
  }

  /** Retorna o estado do anel de dwell (P1 — Dwell & Scrub). */
  getDwellRingState(): { pileId: string; progress: number; active: boolean } | null {
    if (!this.hoveredPileId || this.drag.isDragging || this.lassoing || this.shoving) return null;
    return {
      pileId: this.hoveredPileId,
      progress: Math.min(1, this.dwellTimer / 400),
      active: this.dwellActive,
    };
  }

  /** Retorna o estado da faixa de miniaturas (chips) para o scrub (P1 — Dwell & Scrub). */
  getScrubStripState(): {
    pileId: string;
    items: Array<{ id: string; label: string; icon?: string; thumb?: string; color?: string }>;
    activeIndex: number;
  } | null {
    if (!this.dwellActive || !this.hoveredPileId) return null;
    const base = this.hoveredPileId;
    const state = this.piles.getState(base);
    if (!state || state.children.length <= 1) return null;
    const items = state.children.map((id) => {
      const obj = this.getObject(id);
      return {
        id,
        label: obj?.label ?? id,
        thumb: (obj?.meta.thumb as string) || undefined,
        color: (obj?.meta.color as string) || undefined,
      };
    });
    return {
      pileId: base,
      items,
      activeIndex: this.scrubIndex,
    };
  }

  /** Define o índice do item ativo na visualização scrub/peel. */
  setScrubIndex(pileId: string, index: number): void {
    const base = this.piles.baseOf(pileId) ?? pileId;
    const state = this.piles.getState(base);
    if (!state || state.children.length === 0) return;
    const clamped = Math.max(0, Math.min(index, state.children.length - 1));
    if (this.scrubIndex === clamped && this.activePeelId === state.children[clamped]) return;

    this.scrubIndex = clamped;
    const targetId = state.children[clamped];

    // Restaura o item anterior
    this.resetPeel();

    // Eleva o item ativo pelo scrub acima do resto da pilha com destaque
    const e = this.entries.get(targetId);
    if (e) {
      this.activePeelId = targetId;
      const curPos = e.data.pose.position;
      const peelPos = { x: curPos.x, y: curPos.y + 3.0, z: curPos.z };
      this.deps.renderer.setPose(e.render, { position: peelPos, rotation: e.data.pose.rotation });
      this.deps.renderer.setHighlight(e.render, true);
    }
    this.dirty = true;
  }

  /** Restaura o item em peel à pose normal calculada pelo layout da pilha. */
  private resetPeel(): void {
    if (!this.activePeelId) return;
    const e = this.entries.get(this.activePeelId);
    if (e) {
      const normalPos = this.piles.positionOf(this.activePeelId);
      if (normalPos) {
        this.deps.renderer.setPose(e.render, { position: normalPos, rotation: e.data.pose.rotation });
      }
      this.deps.renderer.setHighlight(e.render, this.selectedIds.has(this.activePeelId));
    }
    this.activePeelId = null;
  }

  /** Seleciona um item específico a partir da faixa de scrub (clique no chip). */
  selectScrubItem(pileId: string, itemId: string): void {
    const base = this.piles.baseOf(pileId) ?? pileId;
    const state = this.piles.getState(base);
    if (!state || !state.children.includes(itemId)) return;
    this.select(itemId);
    const obj = this.getObject(itemId);
    if (obj) {
      this.deps.overlay?.toast(t('toast.scrubSelected', { name: obj.label ?? itemId }));
    }
    this.dirty = true;
  }

  /** Ponto central no topo da pilha (p/ projetar a posição de tela do halo). */
  getPileCenter(pileId: string): Vec3 | null {
    const base = this.piles.baseOf(pileId) ?? pileId;
    const state = this.piles.getState(base);
    if (!state) return null;
    const baseEntry = this.entries.get(base);
    if (!baseEntry) return null;
    const count = state.children.length;
    const height = (state.halfZ ?? SHEET_HALF_THICKNESS) * 2 * Math.min(count, 5);
    const p = baseEntry.data.pose.position;
    return { x: p.x, y: p.y + height + 2, z: p.z };
  }

  /** Alterna uma pilha entre Grid e Stack (usado pelo halo e menu). */
  togglePileGrid(objectId: string): boolean {
    const base = this.piles.baseOf(objectId) ?? objectId;
    const state = this.piles.getState(base);
    if (!state) return false;
    const next = state.layout === PileLayout.Grid ? PileLayout.Stack : PileLayout.Grid;
    this.piles.setLayout(base, next);
    this.applyPileLayout();
    this.deps.overlay?.toast(next === PileLayout.Grid ? t('toast.pileGrid') : t('toast.pileStack'));
    this.dirty = true;
    return true;
  }

  /** Alterna uma pilha entre Fan-Out (Leaf) e Stack (usado pelo halo). */
  togglePileFan(objectId: string): boolean {
    const base = this.piles.baseOf(objectId) ?? objectId;
    const state = this.piles.getState(base);
    if (!state) return false;
    const next = state.layout === PileLayout.Leaf ? PileLayout.Stack : PileLayout.Leaf;
    this.piles.setLayout(base, next);
    this.applyPileLayout();
    this.deps.overlay?.toast(next === PileLayout.Leaf ? t('toast.pileFanned') : t('toast.pileStack'));
    this.dirty = true;
    return true;
  }

  /** Alterna uma pilha entre arrumado (tidy) e desarranjado (messy). */
  togglePileMessy(objectId: string): boolean {
    const base = this.piles.baseOf(objectId) ?? objectId;
    const state = this.piles.getState(base);
    if (!state) return false;
    this.piles.toggleMessy(base);
    const nowMessy = this.piles.getState(base)?.messy !== false;
    this.applyPileLayout();
    this.deps.overlay?.toast(nowMessy ? t('toast.pileMessy') : t('toast.pileTidy'));
    this.dirty = true;
    return true;
  }

  /**
   * Desmancha uma pilha (Break Pile — P1), espalhando seus itens de volta
   * ao chão com física e impulso suave.
   */
  breakPile(objectId: string): string[] {
    const base = this.piles.baseOf(objectId) ?? objectId;
    const state = this.piles.getState(base);
    if (!state) return [];
    const kids = [...state.children];
    for (const id of kids) {
      this.piles.remove(id);
      const e = this.entries.get(id);
      if (e) {
        e.data.parentId = null;
        this.deps.physics.setFrozen(e.body, false);
        const angle = Math.random() * Math.PI * 2;
        const speed = 12 + Math.random() * 8;
        this.deps.physics.setVelocity(e.body, {
          x: Math.cos(angle) * speed,
          y: 6,
          z: Math.sin(angle) * speed,
        });
      }
    }
    this.applyPileLayout();
    this.deps.overlay?.toast(t('toast.pileBroken'));
    this.hoveredPileId = null;
    this.dirty = true;
    return kids;
  }

  /** Habilita/desabilita o comportamento de Exploding Piles (P1). */
  setExplodingPiles(enabled: boolean): void {
    this.explodingPiles = enabled;
  }

  /** Exploding Piles está ativo? */
  isExplodingPiles(): boolean {
    return this.explodingPiles;
  }

  /** Alterna Exploding Piles (toggle). */
  toggleExplodingPiles(): boolean {
    this.explodingPiles = !this.explodingPiles;
    return this.explodingPiles;
  }

  /** Habilita/desabilita o Auto-Align suave (P1 - Item 12). */
  setAutoAlign(enabled: boolean): void {
    this.autoAlign = enabled;
  }

  /** Auto-Align suave está ativo? */
  isAutoAlign(): boolean {
    return this.autoAlign;
  }

  /** Alterna Auto-Align (toggle). */
  toggleAutoAlign(): boolean {
    this.autoAlign = !this.autoAlign;
    return this.autoAlign;
  }

  /** Habilita/desabilita a exibição dos nomes dos arquivos (rótulos). */
  setShowNames(enabled: boolean): void {
    this.showNames = enabled;
    this.dirty = true; // re-sincroniza (cria/remove) os labels no overlay
  }

  /** Os nomes dos arquivos estão visíveis? */
  isShowNames(): boolean {
    return this.showNames;
  }

  /** Alterna a exibição dos nomes dos arquivos (toggle). */
  toggleShowNames(): boolean {
    this.setShowNames(!this.showNames);
    return this.showNames;
  }

  /**
   * Auto-Align (P1 - Item 12): alinha suavemente o objeto solto à grade implícita
   * de eixos no chão (mesa arrumada), se a célula alvo estiver desocupada.
   */
  private applyAutoAlign(e: Entry, targetPos?: Vec3): boolean {
    const GRID_SNAP = 18.0;
    const h = this.scaledHalf(e);
    const pos = targetPos ?? e.data.pose.position;

    const targetX = Math.round(pos.x / GRID_SNAP) * GRID_SNAP;
    const targetZ = Math.round(pos.z / GRID_SNAP) * GRID_SNAP;

    const hs = this.room.halfSize;
    const thickness = this.room.wallThickness;
    const maxX = hs - thickness - h.x;
    const maxZ = hs - thickness - h.z;

    const clampedX = Math.max(-maxX, Math.min(maxX, targetX));
    const clampedZ = Math.max(-maxZ, Math.min(maxZ, targetZ));

    // Se estiver ocupado por outro item próximo, tenta células adjacentes
    const isOccupied = (x: number, z: number): boolean => {
      for (const other of this.entries.values()) {
        if (other.data.id === e.data.id) continue;
        if (other.data.pinnedWall != null) continue;
        const op = other.data.pose.position;
        if (Math.hypot(op.x - x, op.z - z) < 8.0) return true;
      }
      return false;
    };

    let finalX = clampedX;
    let finalZ = clampedZ;
    if (isOccupied(finalX, finalZ)) {
      const candidates = [
        { x: clampedX + GRID_SNAP, z: clampedZ },
        { x: clampedX - GRID_SNAP, z: clampedZ },
        { x: clampedX, z: clampedZ + GRID_SNAP },
        { x: clampedX, z: clampedZ - GRID_SNAP },
      ];
      let found = false;
      for (const c of candidates) {
        if (Math.abs(c.x) <= maxX && Math.abs(c.z) <= maxZ && !isOccupied(c.x, c.z)) {
          finalX = c.x;
          finalZ = c.z;
          found = true;
          break;
        }
      }
      if (!found) return false;
    }

    const alignedPos: Vec3 = { x: finalX, y: h.y, z: finalZ };
    this.placeAt(e, alignedPos);
    // Alinha a rotação ao plano horizontal padrão (0° yaw)
    e.data.pose.rotation = { x: 0, y: 0, z: 0, w: 1 };
    this.deps.renderer.setPose(e.render, e.data.pose);
    this.dirty = true;
    return true;
  }

  /** Alinha um item específico à grade se for solto (útil para testes e ações diretas). */
  autoAlignItem(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || this.piles.contains(id) || e.data.pinnedWall != null) return false;
    return this.applyAutoAlign(e);
  }

  /**
   * Sacode a pilha (Shake — P1), aplicando impulsos oscilantes e
   * espalhando seus itens de volta ao chão com física e animação vigorosa.
   */
  shakePile(objectId: string): string[] {
    const base = this.piles.baseOf(objectId) ?? objectId;
    const state = this.piles.getState(base);
    if (!state) return [];
    const kids = [...state.children];
    for (let i = 0; i < kids.length; i++) {
      const id = kids[i];
      this.piles.remove(id);
      const e = this.entries.get(id);
      if (e) {
        e.data.parentId = null;
        this.deps.physics.setFrozen(e.body, false);
        const angle = (i / kids.length) * Math.PI * 2 + (Math.random() - 0.5);
        const speed = 16 + Math.random() * 10;
        this.deps.physics.setVelocity(e.body, {
          x: Math.cos(angle) * speed,
          y: 9 + Math.random() * 5,
          z: Math.sin(angle) * speed,
        });
      }
    }
    this.applyPileLayout();
    this.deps.overlay?.toast(t('toast.pileShaken'));
    this.hoveredPileId = null;
    this.dirty = true;
    return kids;
  }

  // -------------------------------------------------------------------------
  // Pinning em parede (M5) — espelha PinWall do original (junta → freeze)
  // -------------------------------------------------------------------------

  /**
   * Prega/desprega um objeto numa parede (0=N/-z, 1=S/+z, 2=O/-x, 3=L/+x).
   * O objeto vira kinematic colado à parede; `null` devolve ao dinâmico.
   */
  pinToWall(objectId: string, wall: number | null): void {
    const e = this.entries.get(objectId);
    if (!e) return;
    const he = this.scaledHalf(e);
    if (wall === null) {
      if (e.data.pinnedWall == null) return;
      e.data.pinnedWall = null;
      const rot = identityQuat();
      e.data.pose = { position: e.data.pose.position, rotation: rot };
      const pos = this.clampToRoom(e, { ...e.data.pose.position, y: he.y + 0.5 });
      this.deps.physics.setFrozen(e.body, false);
      this.deps.physics.setRotation(e.body, rot);
      this.placeAt(e, pos);
      this.dirty = true;
      return;
    }
    const inner = this.innerWall();
    const lowest = he.z + 2;
    const highest = Math.max(lowest, this.room.wallHeight - he.z - 2);
    const y = clamp(Math.max(e.data.pose.position.y, this.room.wallHeight * 0.4), lowest, highest);
    const off = inner - he.y - 0.5;
    const alongX = clamp(e.data.pose.position.x, -(inner - he.x), inner - he.x);
    const alongZ = clamp(e.data.pose.position.z, -(inner - he.x), inner - he.x);
    let pos: Vec3;
    let rot: Pose['rotation'];
    switch (wall) {
      case 0:
        pos = { x: alongX, y, z: -off };
        rot = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
        break;
      case 1:
        pos = { x: alongX, y, z: off };
        rot = { x: 0, y: Math.SQRT1_2, z: -Math.SQRT1_2, w: 0 };
        break;
      case 2:
        pos = { x: -off, y, z: alongZ };
        rot = { x: 0.5, y: 0.5, z: -0.5, w: 0.5 };
        break;
      case 3:
        pos = { x: off, y, z: alongZ };
        rot = { x: 0.5, y: -0.5, z: 0.5, w: 0.5 };
        break;
      default:
        return;
    }
    e.data.pinnedWall = wall;
    this.deps.physics.setFrozen(e.body, true);
    this.deps.physics.setPosition(e.body, pos);
    this.deps.physics.setRotation(e.body, rot);
    e.data.pose = { position: pos, rotation: rot };
    this.deps.renderer.setPose(e.render, e.data.pose);
    this.dirty = true;
  }

  /** Alterna o pin na parede 0 (norte) — atalho/menu simplificado. */
  togglePin(objectId: string): boolean {
    const e = this.entries.get(objectId);
    if (!e) return false;
    const next = e.data.pinnedWall === null ? 0 : null;
    this.pinToWall(objectId, next);
    return next !== null;
  }

  isPinned(objectId: string): boolean {
    return this.entries.get(objectId)?.data.pinnedWall !== null &&
      this.entries.get(objectId)?.data.pinnedWall !== undefined;
  }

  /**
   * B (grudar na parede): detecta se o objeto solto encosta numa face interna
   * da parede. Espelha a lógica de `checkWallToss` mas sem exigir velocidade.
   * Retorna índice da parede (0=N, 1=S, 2=O, 3=L) ou null.
   */
  private wallContact(e: Entry): number | null {
    const CONTACT = 2.5;
    const inner = this.innerWall();
    const { ex, ez } = this.floorExtents(e);
    const p = e.data.pose.position;

    const faceN = -inner + ez + CONTACT;
    const faceS = inner - ez - CONTACT;
    const faceW = -inner + ex + CONTACT;
    const faceE = inner - ex - CONTACT;

    if (p.z <= faceN) return 0;
    if (p.z >= faceS) return 1;
    if (p.x <= faceW) return 2;
    if (p.x >= faceE) return 3;
    return null;
  }

  /**
   * C (flick): navega a pilha (peel no Stack, pagina no Grid) sem abrir leque.
   * `dir` > 0 = próxima / folhear frente; < 0 = anterior / folhear trás.
   */
  navigatePile(objectId: string, dir: number): boolean {
    const base = this.piles.baseOf(objectId);
    if (!base) return false;
    const state = this.piles.getState(base);
    if (!state) return false;
    if (state.layout === PileLayout.Grid) {
      if (dir > 0) this.piles.nextPage(base);
      else this.piles.prevPage(base);
      this.applyPileLayout();
      return true;
    }
    if (state.layout === PileLayout.Stack && state.children.length > 2) {
      this.piles.peel(base, dir > 0 ? 1 : -1);
      this.applyPileLayout();
      return true;
    }
    return false;
  }

  private onCancel(): void {
    // Laço ativo → esconde o laço mantendo a seleção (como o original)
    if (this.lassoing) this.endLasso();
    this.shoving = false;
    this.lastShovePoint = null;
    this.hoveredPileId = null;
    if (!this.pickedId) return;
    const e = this.entries.get(this.pickedId);
    this.pickedId = null;
    this.drag.cancel();
    if (e) this.deps.physics.setFrozen(e.body, false);
    this.releaseGroup(null);
    this.dirty = true;
  }

  /** Objeto sob um ponto de mundo (p/ duplo-clique → abrir, M2). */
  pickObjectAt(worldPoint: Vec3, screen?: { x: number; y: number }): string | null {
    return this.pickAt(worldPoint, undefined, screen);
  }

  // -------------------------------------------------------------------------
  // Seleção (M4)
  // -------------------------------------------------------------------------

  /** Seleciona apenas `id` (ou desseleciona tudo com null) e aplica highlight. */
  select(id: string | null): void {
    this.applySelection(id ? [id] : []);
  }

  /** Alterna `id` na seleção (shift+clique, Fase 7 multi-select). */
  toggleSelect(id: string): void {
    const next = new Set(this.selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.applySelection([...next]);
  }

  /** Substitui o conjunto selecionado (usado pelo laço) com highlights. */
  private applySelection(ids: string[]): void {
    const next = new Set(ids);
    let changed = next.size !== this.selectedIds.size;
    for (const id of this.selectedIds) {
      if (!next.has(id)) {
        const prev = this.entries.get(id);
        if (prev) this.deps.renderer.setHighlight(prev.render, false);
        changed = true;
      }
    }
    for (const id of next) {
      if (!this.selectedIds.has(id)) {
        const e = this.entries.get(id);
        if (e) this.deps.renderer.setHighlight(e.render, true);
        changed = true;
      }
    }
    this.selectedIds = next;
    if (changed) this.dirty = true;
  }

  /** Ids selecionados atualmente (multi-select, Fase 7). */
  getSelectedIds(): string[] {
    return [...this.selectedIds];
  }

  getSelectedId(): string | null {
    for (const id of this.selectedIds) return id;
    return null;
  }

  // -------------------------------------------------------------------------
  // Operações de seleção (P0) — Grade, Ordenar, Duplicar, Escala
  // -------------------------------------------------------------------------

  /** Meia-extensão ESCALADA do item (base × escala atual). */
  private scaledHalf(e: Entry): Vec3 {
    const b = e.data.meta.halfExtents ?? vec3(7, SHEET_HALF_THICKNESS, 7);
    const s = e.data.scale > 0 ? e.data.scale : 1;
    return { x: b.x * s, y: b.y * s, z: b.z * s };
  }

  /** Meias-extensões do item no piso (X/Z) considerando o giro em Y. */
  private floorExtents(e: Entry): { ex: number; ez: number } {
    const he = this.scaledHalf(e);
    const q = e.data.pose.rotation;
    const yaw = 2 * Math.atan2(q.y, q.w);
    const c = Math.abs(Math.cos(yaw));
    const sn = Math.abs(Math.sin(yaw));
    return { ex: c * he.x + sn * he.z, ez: sn * he.x + c * he.z };
  }

  /** Face interna das paredes (distância do centro da sala). */
  private innerWall(): number {
    return this.room.halfSize - this.room.wallThickness / 2;
  }

  /** Posição mais próxima de `p` em que o item cabe inteiro dentro da sala. */
  private clampToRoom(e: Entry, p: Vec3): Vec3 {
    const inner = this.innerWall();
    const { ex, ez } = this.floorExtents(e);
    const mx = Math.max(0, inner - ex);
    const mz = Math.max(0, inner - ez);
    return {
      x: clamp(p.x, -mx, mx),
      y: Math.max(this.scaledHalf(e).y, p.y),
      z: clamp(p.z, -mz, mz),
    };
  }

  /** True se o item está inteiro dentro da sala (com folga numérica). */
  isInsideRoom(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    const p = e.data.pose.position;
    if (e.data.pinnedWall != null) {
      const inner = this.innerWall();
      return Math.abs(p.x) <= inner && Math.abs(p.z) <= inner && p.y >= 0;
    }
    const c = this.clampToRoom(e, p);
    return (
      Math.abs(c.x - p.x) <= ESCAPE_MARGIN &&
      Math.abs(c.z - p.z) <= ESCAPE_MARGIN &&
      p.y >= -ESCAPE_MARGIN
    );
  }

  /**
   * Rede de segurança: qualquer item solto que tenha escapado da sala (por
   * erro numérico ou arremesso extremo) volta para dentro, sem velocidade.
   */
  private containEscapees(): void {
    for (const e of this.entries.values()) {
      const id = e.data.id;
      if (id === this.pickedId || this.piles.contains(id) || e.data.pinnedWall != null) continue;
      if (this.isGroupMember(id)) continue;
      if (this.deps.physics.isSleeping(e.body)) continue;
      const pose = this.deps.physics.getPose(e.body);
      const c = this.clampToRoom(e, pose.position);
      const out =
        Math.abs(c.x - pose.position.x) > ESCAPE_MARGIN ||
        Math.abs(c.z - pose.position.z) > ESCAPE_MARGIN ||
        pose.position.y < -ESCAPE_MARGIN;
      if (!out) continue;
      this.deps.physics.setPosition(e.body, c);
      this.deps.physics.setVelocity(e.body, vec3());
      this.dirty = true;
    }
  }

  private isGroupMember(id: string): boolean {
    for (const m of this.group) if (m.id === id) return true;
    return false;
  }

  /**
   * Alvos de operações de layout/escala: itens SOLTOs (não em pilha) e não
   * pregados na parede — pilha e pin são gerenciados pelos próprios gestos.
   */
  private layoutTargets(ids?: string[]): string[] {
    const src = ids ?? [...this.selectedIds];
    const out: string[] = [];
    for (const id of src) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (this.piles.contains(id)) continue;
      if (e.data.pinnedWall != null) continue;
      out.push(id);
    }
    return out;
  }

  /** Move um item para `pos` (pose + física + render), zerando a velocidade. */
  private placeAt(e: Entry, pos: Vec3): void {
    e.data.pose = { position: pos, rotation: e.data.pose.rotation };
    this.deps.physics.setPosition(e.body, pos);
    this.deps.physics.setVelocity(e.body, vec3());
    this.deps.renderer.setPose(e.render, e.data.pose);
  }

  /** Gira os itens soltos da seleção em torno do eixo vertical. */
  rotateSelection(radians: number, ids?: string[]): number {
    const targets = this.layoutTargets(ids);
    const h = radians / 2;
    const r = { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
    for (const id of targets) {
      const e = this.entries.get(id)!;
      const q = e.data.pose.rotation;
      const next = {
        x: r.w * q.x + r.x * q.w + r.y * q.z - r.z * q.y,
        y: r.w * q.y - r.x * q.z + r.y * q.w + r.z * q.x,
        z: r.w * q.z + r.x * q.y - r.y * q.x + r.z * q.w,
        w: r.w * q.w - r.x * q.x - r.y * q.y - r.z * q.z,
      };
      this.deps.physics.setRotation(e.body, next);
      e.data.pose = { position: e.data.pose.position, rotation: next };
      const inside = this.clampToRoom(e, e.data.pose.position);
      this.placeAt(e, inside);
    }
    if (targets.length > 0) this.dirty = true;
    return targets.length;
  }

  /** Nível de física: 1 = interação visual, 2 = física real (caixas colidem). */
  getPhysicsLevel(): PhysicsLevel {
    return this.physicsLevel;
  }

  setPhysicsLevel(level: PhysicsLevel): void {
    this.physicsLevel = level;
    this.deps.physics.setItemCollisions(level === 2);
    this.dirty = true;
  }

  togglePhysicsLevel(): PhysicsLevel {
    this.setPhysicsLevel(this.physicsLevel === 2 ? 1 : 2);
    return this.physicsLevel;
  }

  /**
   * Grid View da seleção (P0): espalha os itens soltos numa grade centrada
   * no centroide do conjunto, encostados no chão. Retorna nº de itens.
   */
  gridViewSelection(ids?: string[]): number {
    const targets = this.layoutTargets(ids);
    if (targets.length < 2) return 0;
    const entries = targets.map((id) => this.entries.get(id)!);
    const cx = entries.reduce((s, e) => s + e.data.pose.position.x, 0) / entries.length;
    const cz = entries.reduce((s, e) => s + e.data.pose.position.z, 0) / entries.length;
    let maxW = 0;
    for (const e of entries) {
      const h = this.scaledHalf(e);
      maxW = Math.max(maxW, h.x * 2, h.z * 2);
    }
    const cell = Math.max(18, maxW + 6);
    const offsets = selectionGridOffsets(entries.length, cell);
    entries.forEach((e, i) => {
      const h = this.scaledHalf(e);
      this.placeAt(e, { x: cx + offsets[i].x, y: h.y, z: cz + offsets[i].z });
    });
    this.dirty = true;
    return entries.length;
  }

  /**
   * Ordena a seleção (P0 — Sort by Size / Sort by Type) e alinha numa linha
   * horizontal: a ordem do sort é visível da esquerda p/ direita.
   */
  sortSelection(key: SortKey, ids?: string[]): number {
    const targets = this.layoutTargets(ids);
    if (targets.length < 2) return 0;
    const decorated = targets.map((id) => {
      const e = this.entries.get(id)!;
      const item: ItemForSort = {
        halfExtents: e.data.meta.halfExtents,
        scale: e.data.scale,
        label: e.data.label,
        typeFlags: e.data.typeFlags,
      };
      return { e, item };
    });
    // Sort estável: itens empatados mantêm a ordem relativa original
    decorated.sort((a, b) =>
      key === 'size' ? compareBySize(a.item, b.item) : compareByType(a.item, b.item),
    );
    const cx =
      decorated.reduce((s, x) => s + x.e.data.pose.position.x, 0) / decorated.length;
    const cz =
      decorated.reduce((s, x) => s + x.e.data.pose.position.z, 0) / decorated.length;
    let maxW = 0;
    for (const x of decorated) maxW = Math.max(maxW, this.scaledHalf(x.e).x * 2);
    const spacing = Math.max(18, maxW + 6);
    const offsets = rowOffsets(decorated.length, spacing);
    decorated.forEach((x, i) => {
      const h = this.scaledHalf(x.e);
      this.placeAt(x.e, { x: cx + offsets[i].x, y: h.y, z: cz });
    });
    this.dirty = true;
    return decorated.length;
  }

  /**
   * Duplicar seleção (P0): cria uma CÓPIA VISUAL de cada alvo, deslocada ao
   * lado do original (mesma escala, cor, thumb, texto e `fsPath`).
   *
   * ⚠️ NÃO copia o arquivo em disco — é um atalho visual sobre o mesmo
   * arquivo (documentado no README). As cópias ficam selecionadas.
   */
  duplicateSelection(ids?: string[]): number {
    const src = (ids ?? [...this.selectedIds]).filter((id) => this.entries.has(id));
    if (src.length === 0) return 0;
    const created: string[] = [];
    for (const id of src) {
      const s = this.entries.get(id)!;
      const base = s.data.meta.halfExtents ?? vec3(7, SHEET_HALF_THICKNESS, 7);
      const scale = s.data.scale > 0 ? s.data.scale : 1;
      const scaled = { x: base.x * scale, y: base.y * scale, z: base.z * scale };
      const pos: Vec3 = {
        x: s.data.pose.position.x + scaled.x + 4,
        y: s.data.pose.position.y,
        z: s.data.pose.position.z + scaled.z + 4,
      };
      const newObjectId = newId();
      const body = this.deps.physics.createBox(newObjectId, pos, scaled);
      const render = this.deps.renderer.addBox(
        newObjectId,
        base,
        (s.data.meta.color as string) ?? '#4f9cff',
      );
      const pose: Pose = { position: pos, rotation: { ...s.data.pose.rotation } };
      this.deps.renderer.setPose(render, pose);
      this.deps.renderer.setScale(render, scale);
      const thumb = s.data.meta.thumb as string | null | undefined;
      if (thumb) this.deps.renderer.setTexture(render, thumb);
      const data: BumpObjectData = {
        id: newObjectId,
        kind: s.data.kind,
        typeFlags: s.data.typeFlags,
        parentId: null,
        pose,
        velocity: vec3(),
        scale,
        pinnedWall: null,
        frozen: false,
        label: s.data.label,
        meta: { ...s.data.meta, halfExtents: { ...base } },
      };
      this.entries.set(newObjectId, { data, body, render });
      created.push(newObjectId);
    }
    if (created.length > 0) this.applySelection(created);
    this.dirty = true;
    return created.length;
  }

  /**
   * A (resize por arraste): calcula o AABB mundo da seleção (itens soltos).
   * Retorna { min, max, center } ou null se seleção vazia/inválida p/ resize.
   */
  getSelectionBounds(ids?: string[]): { min: Vec3; max: Vec3; center: Vec3 } | null {
    const targets = this.layoutTargets(ids);
    if (targets.length === 0) return null;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const id of targets) {
      const e = this.entries.get(id)!;
      const he = this.scaledHalf(e);
      const p = e.data.pose.position;
      minX = Math.min(minX, p.x - he.x);
      maxX = Math.max(maxX, p.x + he.x);
      minZ = Math.min(minZ, p.z - he.z);
      maxZ = Math.max(maxZ, p.z + he.z);
    }
    return {
      min: { x: minX, y: 0, z: minZ },
      max: { x: maxX, y: 0, z: maxZ },
      center: { x: (minX + maxX) / 2, y: 0, z: (minZ + maxZ) / 2 },
    };
  }

  /**
   * A (resize por arraste): define a escala da seleção para um valor alvo
   * (clamp [SCALE_MIN, SCALE_MAX], arredonda 2 casas). Retorna quantos mudaram.
   */
  setScaleSelection(targetScale: number, ids?: string[]): { changed: number; scale: number | null } {
    const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, targetScale));
    const rounded = Math.round(clamped * 100) / 100;
    const targets = this.layoutTargets(ids);
    let changed = 0;
    for (const id of targets) {
      const e = this.entries.get(id)!;
      if (Math.abs(e.data.scale - rounded) > 1e-9) {
        this.applyScale(e, rounded);
        changed++;
      }
    }
    return { changed, scale: changed > 0 ? rounded : null };
  }

  /**
   * Escala a seleção (P0 — Scale): passo de 25%, limites [SCALE_MIN, SCALE_MAX].
   * `dir` +1 aumenta / -1 diminui. O port de física não tem resize → o corpo
   * é recriado com os half-extents base × nova escala.
   *
   * Retorna quantos itens mudaram, o limite atingido (`max`/`min` — p/ o
   * feedback "não dá para aumentar mais!") e a escala resultante.
   */
  scaleSelection(
    dir: 1 | -1,
    ids?: string[],
  ): { changed: number; limit: 'max' | 'min' | null; scale: number | null } {
    const targets = this.layoutTargets(ids);
    let changed = 0;
    let limit: 'max' | 'min' | null = null;
    let lastScale: number | null = null;
    for (const id of targets) {
      const e = this.entries.get(id)!;
      const cur = e.data.scale > 0 ? e.data.scale : 1;
      const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, cur + dir * SCALE_STEP));
      if (Math.abs(next - cur) < 1e-9) {
        limit = dir > 0 ? 'max' : 'min'; // já está no limite
        continue;
      }
      const rounded = Math.round(next * 100) / 100; // evita ruído de float
      this.applyScale(e, rounded);
      changed++;
      lastScale = rounded;
    }
    return { changed, limit, scale: lastScale };
  }

  /** Aplica a escala num item: recria o corpo físico e atualiza render/modelo. */
  private applyScale(e: Entry, next: number): void {
    const base = e.data.meta.halfExtents ?? vec3(7, SHEET_HALF_THICKNESS, 7);
    const pose = this.deps.physics.getPose(e.body);
    const vel = this.deps.physics.getVelocity(e.body);
    this.deps.physics.removeBody(e.body);
    const scaled = { x: base.x * next, y: base.y * next, z: base.z * next };
    e.body = this.deps.physics.createBox(e.data.id, pose.position, scaled);
    this.deps.physics.setRotation(e.body, pose.rotation);
    this.deps.physics.setVelocity(e.body, vel);
    e.data.scale = next;
    this.deps.renderer.setScale(e.render, next);
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Laço / rubber-band (Fase 7) — espelha LassoMenu do original
  // -------------------------------------------------------------------------

  /**
   * Recalcula o laço de tela e seleciona todos os objetos visíveis cujo
   * centro projetado cai dentro do laço livre / polígono ou da caixa delimitadora (P1).
   */
  private updateLasso(screen: { x: number; y: number }): void {
    const start = this.lassoStart;
    if (!start) return;

    const last = this.lassoPoints[this.lassoPoints.length - 1];
    if (!last || Math.hypot(screen.x - last.x, screen.y - last.y) >= 3) {
      this.lassoPoints.push({ ...screen });
    }

    const fromStart = Math.hypot(screen.x - start.x, screen.y - start.y);
    if (fromStart > LASSO_START_RADIUS * 1.6) this.lassoLeftStart = true;

    if (!this.lassoClosed) {
      this.selectInsideLasso();
      if (this.lassoLeftStart && fromStart <= LASSO_START_RADIUS && this.selectedIds.size > 0) {
        this.lassoClosed = true;
        this.lassoCrossTarget = this.selectedIds.size >= 2 ? this.selectionScreenCentroid() : null;
      }
    } else if (
      this.lassoCrossTarget &&
      fromStart > LASSO_START_RADIUS &&
      last &&
      distToSegmentSq(this.lassoCrossTarget, last, screen) <= LASSO_CROSS_RADIUS * LASSO_CROSS_RADIUS
    ) {
      const ids = this.layoutTargets();
      const base = this.createPileFrom(ids);
      this.endLasso();
      if (base) this.deps.overlay?.toast(t('toast.lassoPiled', { n: ids.length }));
      return;
    }
    this.pushLassoOverlay();
  }

  /** Lasso'n'Cross / LassoMenu: callback ao fechar o laço e soltar no disco azul. */
  onLassoMenu(listener: LassoMenuListener | null): void {
    this.lassoMenuListener = listener;
  }

  /** Estado do laço (p/ testes e overlay). */
  getLassoState(): { active: boolean; closed: boolean; crossTarget: { x: number; y: number } | null } {
    return { active: this.lassoing, closed: this.lassoClosed, crossTarget: this.lassoCrossTarget };
  }

  private endLasso(): void {
    this.lassoing = false;
    this.lassoStart = null;
    this.lassoPoints = [];
    this.lassoLeftStart = false;
    this.lassoClosed = false;
    this.lassoCrossTarget = null;
    this.deps.overlay?.setLasso(null);
    this.dirty = true;
  }

  private pushLassoOverlay(): void {
    const start = this.lassoStart;
    if (!start) return;
    const aabb = computePointsAABB(this.lassoPoints);
    this.deps.overlay?.setLasso({
      ...aabb,
      points: this.lassoPoints,
      start,
      startRadius: this.lassoLeftStart ? LASSO_START_RADIUS : 0,
      closed: this.lassoClosed,
      crossTarget: this.lassoCrossTarget,
    });
  }

  private selectionScreenCentroid(): { x: number; y: number } | null {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const id of this.selectedIds) {
      const e = this.entries.get(id);
      if (!e) continue;
      const s = this.deps.renderer.projectToScreen(e.data.pose.position);
      if (!s.visible) continue;
      sx += s.x;
      sy += s.y;
      n++;
    }
    return n > 0 ? { x: sx / n, y: sy / n } : null;
  }

  /** Seleciona os objetos visíveis cujo centro projetado cai dentro do laço. */
  private selectInsideLasso(): void {
    const aabb = computePointsAABB(this.lassoPoints);
    const ids = new Set(this.lassoBase);
    if (aabb.w > 3 || aabb.h > 3) {
      for (const e of this.entries.values()) {
        if (this.deps.renderer.isVisible(e.render) === false) continue;
        const s = this.deps.renderer.projectToScreen(e.data.pose.position);
        if (!s.visible) continue;
        if (s.x < aabb.x || s.x > aabb.x + aabb.w || s.y < aabb.y || s.y > aabb.y + aabb.h) {
          continue;
        }
        let hit = false;
        if (this.lassoPoints.length >= 4) {
          hit = isPointInPolygon(s, this.lassoPoints);
          if (!hit) {
            for (let i = 0; i < this.lassoPoints.length - 1; i++) {
              if (distToSegmentSq(s, this.lassoPoints[i], this.lassoPoints[i + 1]) <= 18 * 18) {
                hit = true;
                break;
              }
            }
          }
        } else {
          hit = true;
        }
        if (hit) ids.add(e.data.id);
      }
    }
    this.applySelection([...ids]);
  }

  /**
   * Encontra o objeto mais próximo de um ponto de mundo, opcionalmente
   * excluindo um id (o próprio item arrastado).
   */
  private pickAt(
    worldPoint: Vec3,
    excludeId?: string,
    screen?: { x: number; y: number },
  ): string | null {
    if (screen) {
      const pinned = this.pickPinnedOnScreen(screen, excludeId);
      if (pinned) return pinned;
    }
    let best: string | null = null;
    let bestDist = 13.0; // raio de captura em unidades de mundo (ícone ~14 de largo)
    for (const [id, e] of this.entries) {
      if (id === excludeId) continue;
      if (this.deps.renderer.isVisible(e.render) === false) continue;
      const p = e.data.pose.position;
      const dx = p.x - worldPoint.x;
      const dz = p.z - worldPoint.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < bestDist) {
        bestDist = d;
        best = id;
      }
    }
    return best;
  }

  /**
   * Itens presos na parede ficam no alto: o ponto do chão sob o cursor cai
   * "atrás" da parede, longe deles. Por isso eles são escolhidos pela tela.
   */
  private pickPinnedOnScreen(screen: { x: number; y: number }, excludeId?: string): string | null {
    let best: string | null = null;
    let bestDist = 40;
    for (const [id, e] of this.entries) {
      if (id === excludeId || e.data.pinnedWall == null) continue;
      if (this.deps.renderer.isVisible(e.render) === false) continue;
      const s = this.deps.renderer.projectToScreen(e.data.pose.position);
      if (!s.visible) continue;
      const d = Math.hypot(s.x - screen.x, s.y - screen.y);
      if (d < bestDist) {
        bestDist = d;
        best = id;
      }
    }
    return best;
  }

  isAutoWallPin(): boolean {
    return this.autoWallPin;
  }

  setAutoWallPin(enabled: boolean): void {
    this.autoWallPin = enabled;
    if (!enabled) this.recentToss.clear();
  }

  toggleAutoWallPin(): boolean {
    this.setAutoWallPin(!this.autoWallPin);
    return this.autoWallPin;
  }

  // -------------------------------------------------------------------------
  // Atualização por frame (timestep fixo)
  // -------------------------------------------------------------------------

  update(dt: number): void {
    // Mola amortecida controla a posição durante o arraste
    if (this.pickedId && this.drag.isDragging) {
      const e = this.entries.get(this.pickedId);
      if (e) {
        const p = this.clampToRoom(e, this.drag.step(dt));
        this.deps.physics.moveKinematic(e.body, p);
        for (const m of this.group) {
          const f = this.entries.get(m.id);
          if (!f) continue;
          const fp = this.clampToRoom(f, { x: p.x + m.dx, y: m.y, z: p.z + m.dz });
          this.deps.physics.moveKinematic(f.body, fp);
        }
      }
    }

    const preStep = new Map<string, Vec3>();
    for (const id of this.recentToss.keys()) {
      const e = this.entries.get(id);
      if (e) preStep.set(id, this.deps.physics.getVelocity(e.body));
    }

    // Passo de física
    this.deps.physics.step(dt);
    this.containEscapees();

    // WallToss (Fase 7): toss recente que encosta numa parede → prega nela.
    // Usa a velocidade de ANTES do passo: o impacto com a parede a zera.
    this.checkWallToss(dt, preStep);

    // Dwell & Scrub (P1): incrementa dwellTimer quando o cursor repousa sobre a pilha
    if (this.hoveredPileId && !this.drag.isDragging && !this.lassoing && !this.shoving) {
      this.dwellTimer += dt * 1000;
      if (this.dwellTimer >= 400 && !this.dwellActive) {
        this.dwellActive = true;
        this.dirty = true;
      }
    } else if (!this.hoveredPileId && !this.deps.overlay?.isScrubHovered?.()) {
      if (this.dwellTimer > 0 || this.dwellActive) {
        this.dwellTimer = 0;
        this.dwellActive = false;
        this.scrubIndex = 0;
        this.resetPeel();
        this.dirty = true;
      }
    }

    // Sincroniza poses físico → modelo → render (só corpos acordados p/ perf)
    for (const e of this.entries.values()) {
      if (
        this.deps.physics.isSleeping(e.body) &&
        this.pickedId !== e.data.id &&
        !this.isGroupMember(e.data.id)
      ) continue;
      const pose = this.deps.physics.getPose(e.body);
      e.data.pose = pose;
      e.data.velocity = this.deps.physics.getVelocity(e.body);
      this.deps.renderer.setPose(e.render, pose);
      this.dirty = true;
    }

    // Labels de arquivo projetados (M1) — só quando a cena está suja
    if (this.dirty) this.syncLabels();
  }

  /**
   * WallToss (Fase 7): se um objeto foi lançado (toss) nos últimos 3s e sua
   * velocidade o leva até uma parede (encostou), ele prega naquela parede —
   * espelha o comportamento "jogue na parede e fica preso" do original.
   */
  private checkWallToss(dt: number, preStep: Map<string, Vec3>): void {
    if (this.recentToss.size === 0) return;
    const CONTACT = 2.5; // tolerância de contato com a face interna da parede
    const inner = this.innerWall();

    for (const [id, ttl] of [...this.recentToss]) {
      const remaining = ttl - dt; // decai com o timestep
      if (remaining <= 0) {
        this.recentToss.delete(id);
        continue;
      }
      this.recentToss.set(id, remaining);

      const e = this.entries.get(id);
      if (!e || e.data.pinnedWall != null || this.pickedId === id) {
        this.recentToss.delete(id);
        continue;
      }
      const v = preStep.get(id) ?? this.deps.physics.getVelocity(e.body);
      const speed = Math.hypot(v.x, v.z);
      if (speed < 40) continue; // devagar demais = não foi um toss em voo

      const p = this.deps.physics.getPose(e.body).position;
      const { ex, ez } = this.floorExtents(e);
      const faceN = -inner + ez + CONTACT;
      const faceS = inner - ez - CONTACT;
      const faceW = -inner + ex + CONTACT;
      const faceE = inner - ex - CONTACT;

      if (p.z <= faceN && v.z < -20) this.pinToss(id, 0);
      else if (p.z >= faceS && v.z > 20) this.pinToss(id, 1);
      else if (p.x <= faceW && v.x < -20) this.pinToss(id, 2);
      else if (p.x >= faceE && v.x > 20) this.pinToss(id, 3);
    }
  }

  /** Prega um objeto na parede e encerra o estado de toss dele. */
  private pinToss(id: string, wall: number): void {
    this.recentToss.delete(id);
    this.pinToWall(id, wall);
    this.deps.overlay?.toast('WallToss! 🎯');
  }

  /**
   * Projeta o rótulo de cada objeto no DOM (abaixo da caixa).
   * Espelha os labels QPainter→textura do original, mas em DOM (overlay port).
   */
  private syncLabels(): void {
    const overlay = this.deps.overlay;
    if (!overlay) return;
    // Nomes ocultos (toggle do menu): remove os labels existentes e não recria
    if (!this.showNames) {
      for (const e of this.entries.values()) overlay.setLabel(e.data.id, null, null);
      return;
    }
    for (const e of this.entries.values()) {
      // Nota adesiva: o label é o conteúdo (truncado), não "Nota"
      const text =
        (e.data.typeFlags & TypeFlags.StickyNote) !== 0
          ? ((e.data.meta.noteText as string) || '—').slice(0, 40)
          : e.data.label;
      if (!text) continue;
      const he = this.scaledHalf(e); // label acompanha a escala (P0)
      const p: Vec3 = {
        x: e.data.pose.position.x,
        y: e.data.pose.position.y - he.y - 3,
        z: e.data.pose.position.z,
      };
      const s = this.deps.renderer.projectToScreen(p);
      overlay.setLabel(e.data.id, s.visible ? text : null, s.visible ? s : null);
    }
  }

  /** Preset de câmera (teclas 1..4) — espelha os views do BT_Camera. */
  setCameraPreset(n: number): void {
    this.camera.preset(n);
    this.deps.renderer.setCamera(this.camera.getState());
    this.dirty = true;
  }

  /** Aplica um tema (piso/parede/fundo). */
  setTheme(theme: Theme): void {
    this.deps.renderer.setTheme(theme);
    this.dirty = true;
  }

  /** Render condicional: só re-desenha se algo mudou (sleep optimization). */
  isRenderRequired(): boolean {
    return this.dirty;
  }

  setCamera(s: CameraState): void {
    this.camera.setState(s);
    this.deps.renderer.setCamera(this.camera.getState());
    this.dirty = true;
  }

  getCamera(): CameraState {
    return this.camera.getState();
  }

  /** Consome o dirty-flag após renderizar. */
  markRendered(): void {
    this.dirty = false;
  }

  /** Serializa o estado atual (p/ repositório). */
  toSnapshot(): SceneSnapshot {
    return {
      schemaVersion: 1,
      objects: [...this.entries.values()].map((e) => ({ ...e.data, pose: { ...e.data.pose } })),
      camera: this.camera.getState(),
      piles: this.piles.serialize(),
    };
  }

  /** Restaura o estado a partir de um snapshot (após carregar do repo). */
  loadSnapshot(snap: SceneSnapshot): void {
    // Remove existentes
    for (const id of [...this.entries.keys()]) this.removeObject(id);
    for (const o of snap.objects) {
      // Normaliza metadados de snapshots antigos (sem halfExtents/scale)
      o.meta.halfExtents = asSheet(o.meta.halfExtents ?? vec3(3, 0.6, 3));
      if (!(o.scale > 0)) o.scale = 1;
      const halfExtents = o.meta.halfExtents;
      const scale = o.scale;
      const scaled = { x: halfExtents.x * scale, y: halfExtents.y * scale, z: halfExtents.z * scale };
      const color = (o.meta.color as string) ?? '#4f9cff';
      // Corpo físico usa a escala; a geometria nasce na base e o renderer
      // recebe setScale (mesmo caminho do addBox em runtime).
      const body = this.deps.physics.createBox(o.id, o.pose.position, scaled);
      const render = this.deps.renderer.addBox(o.id, halfExtents, color);
      this.deps.renderer.setPose(render, o.pose);
      this.deps.renderer.setScale(render, scale);
      const thumb = o.meta.thumb as string | null | undefined;
      if (thumb) this.deps.renderer.setTexture(render, thumb);
      this.entries.set(o.id, { data: o, body, render });
    }
    if (snap.camera) this.setCamera(snap.camera);

    // Reconstrói pilhas: filhos agrupados por parentId + layout salvo
    const childrenByBase = new Map<string, string[]>();
    for (const o of snap.objects) {
      if (o.parentId) {
        const list = childrenByBase.get(o.parentId) ?? [];
        list.push(o.id);
        childrenByBase.set(o.parentId, list);
      }
    }
    const savedPiles = snap.piles ?? {};
    for (const [baseId, meta] of Object.entries(savedPiles)) {
      const base = this.entries.get(baseId);
      if (!base) continue;
      const kids = childrenByBase.get(baseId) ?? [];
      if (kids.length === 0) continue;
      const he = this.scaledHalf(base); // espessura escalada ao reconstruir
      this.piles.create(baseId, kids[0], base.data.pose.position, he.y);
      for (let i = 1; i < kids.length; i++) {
        this.piles.add(baseId, kids[i], base.data.pose.position, he.y);
      }
      this.piles.setLayout(baseId, meta.layout);
      // reaplica página salva via layout + page
      if (meta.page > 0) {
        for (let p = 0; p < meta.page; p++) this.piles.nextPage(baseId);
      }
    }
    this.applyPileLayout();
    this.dirty = true;
  }
}
