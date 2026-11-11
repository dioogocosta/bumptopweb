/**
 * Ports (interfaces) — contrato entre o core puro e os adapters.
 *
 * Regra de arquitetura: `core/` importa APENAS estes tipos. Cada adapter
 * (Rapier/three/SQLite/Pointer) implementa uma porta. Isso permite trocar a
 * engine ou rodar em Tauri/Electron sem tocar na lógica de domínio.
 */
import type {
  BumpObjectData,
  CameraState,
  PhysicsConfig,
  PileLayout,
  Pose,
  RoomConfig,
  SceneSnapshot,
  Vec3,
} from '../model/types';
import type { Theme } from '../theme/theme';

// Re-exporta os tipos de domínio p/ conveniência dos adapters.
export type {
  BumpObjectData,
  CameraState,
  PhysicsConfig,
  PileLayout,
  Pose,
  RoomConfig,
  SceneSnapshot,
  Vec3,
  Quat,
} from '../model/types';
export type { Theme } from '../theme/theme';

// ---------------------------------------------------------------------------
// Física
// ---------------------------------------------------------------------------

/** Handle opaco a um corpo físico. O core não conhece a engine. */
export type BodyHandle = number & { readonly __brand: 'BodyHandle' };

export interface RayHit {
  body: BodyHandle;
  point: Vec3;
  normal: Vec3;
  distance: number;
}

/**
 * Porta de física. Implementada por Rapier.
 * O modelo do BumpTop: caixas num piso, NÃO colidem entre si, só com piso/paredes.
 */
export interface IPhysics {
  init(config: PhysicsConfig, room: RoomConfig): Promise<void>;
  /** Cria uma caixa dinâmica (um "ícone"). */
  createBox(id: string, position: Vec3, halfExtents: Vec3): BodyHandle;
  /** Cria o piso + 4 paredes estáticas. */
  createRoom(room: RoomConfig): void;
  removeBody(handle: BodyHandle): void;
  getPose(handle: BodyHandle): Pose;
  getVelocity(handle: BodyHandle): Vec3;
  setPosition(handle: BodyHandle, p: Vec3): void;
  setRotation(handle: BodyHandle, q: Pose['rotation']): void;
  setVelocity(handle: BodyHandle, v: Vec3): void;
  applyImpulse(handle: BodyHandle, impulse: Vec3): void;
  /** Congela/descongela (para drag: o item segue o mouse como kinematic). */
  setFrozen(handle: BodyHandle, frozen: boolean): void;
  /**
   * Move um corpo kinematic até `p` no próximo passo, com velocidade implícita
   * (empurra os itens dinâmicos no caminho). Usado no arraste.
   */
  moveKinematic(handle: BodyHandle, p: Vec3): void;
  /** Liga/desliga colisão item×item (nível 2 × nível 1 de física). */
  setItemCollisions(enabled: boolean): void;
  /** Raycast p/ picking do mouse/toque. */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): RayHit | null;
  /** Passo de simulação com timestep fixo. */
  step(dt: number): void;
  /** Corpo dormindo? (p/ render condicional). */
  isSleeping(handle: BodyHandle): boolean;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export type ObjectHandle = number & { readonly __brand: 'ObjectHandle' };

/**
 * Porta de render. Implementada por three.js.
 * O render do BumpTop é simples: caixas texturizadas + piso/paredes + labels.
 */
export interface IRenderer {
  init(sceneRoot: HTMLElement, room: RoomConfig): Promise<void>;
  /** Adiciona um objeto visual (caixa). */
  addBox(id: string, halfExtents: Vec3, color: string): ObjectHandle;
  /** Aplica uma textura (thumbnail dataURL) ao objeto; remove com null. */
  setTexture(handle: ObjectHandle, dataUrl: string | null): void;
  addRoom(room: RoomConfig): void;
  setPose(handle: ObjectHandle, pose: Pose): void;
  setVisible(handle: ObjectHandle, visible: boolean): void;
  isVisible(handle: ObjectHandle): boolean;
  setHighlight(handle: ObjectHandle, highlighted: boolean): void;
  /** Escala visual da caixa (multiplica os half-extents base). P0 — Scale. */
  setScale(handle: ObjectHandle, scale: number): void;
  remove(handle: ObjectHandle): void;
  setCamera(state: CameraState): void;
  getCamera(): CameraState;
  /** Projeta um ponto 3D → coordenadas de tela (p/ labels DOM). */
  projectToScreen(p: Vec3): { x: number; y: number; visible: boolean };
  /** Raio de câmera através de um ponto de tela (p/ picking via física). */
  screenToRay(screen: { x: number; y: number }): { origin: Vec3; direction: Vec3 };
  resize(width: number, height: number): void;
  setTheme(theme: Theme): void;
  render(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Persistência (repositório)
// ---------------------------------------------------------------------------

/**
 * Porta de repositório. Implementada por SQLite (OPFS) com fallback IndexedDB.
 * O core nunca vê SQL — só este contrato.
 */
export interface FsEntryRow {
  objectId: string;
  mode: 0 | 1 | 2; // 0=virtual, 1=fs-access, 2=opfs
  path: string | null;
  name: string;
  isDir: boolean;
  size: number | null;
  mtime: number | null;
  launchCount?: number;
  /** Thumbnail em dataURL (persistida como BLOB/texto). */
  thumb?: string | null;
}
export interface IRepo {
  init(): Promise<void>;
  saveScene(snapshot: SceneSnapshot): Promise<void>;
  loadScene(): Promise<SceneSnapshot | null>;
  upsertObject(data: BumpObjectData): Promise<void>;
  deleteObject(id: string): Promise<void>;
  getSetting<T>(key: string, fallback: T): Promise<T>;
  setSetting(key: string, value: unknown): Promise<void>;
  /** Metadados de filesystem por objeto (fs_entries — M2). */
  upsertFsEntry(entry: FsEntryRow): Promise<void>;
  listFsEntries(): Promise<FsEntryRow[]>;
  /** Diagnóstico: qual backend está ativo (opfs-sqlite | idb-sqlite). */
  backend(): string;
  export(): Promise<Uint8Array>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export interface FsEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/**
 * Porta de filesystem. Dois modos: FS Access API (pasta real) ou OPFS/virtual.
 */
export interface IFileSystem {
  /** Tenta abrir um diretório real; false se indisponível (cai p/ virtual). */
  requestDirectory(): Promise<boolean>;
  mode(): 'fs-access' | 'opfs' | 'virtual';
  list(path: string): Promise<FsEntry[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  /** Cria um diretório (e os pais se preciso). Item 6 — pasta virtual na cena. */
  mkdir(path: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Input semântico
// ---------------------------------------------------------------------------

/**
 * Ações semânticas — o `core` consome ESTO, nunca eventos crus.
 * É o que unifica desktop (mouse) e mobile (toque) sem duplicar lógica.
 */
export type PointerKind = 'mouse' | 'touch' | 'pen';

export type InputAction =
  | {
      type: 'pointerDown';
      world: Vec3;
      screen: { x: number; y: number };
      button: number;
      pointerId: number;
      /** Tipo do ponteiro (Fase 7): mouse/pen no chão vazio = laço; toque = shove. */
      pointerType?: PointerKind;
      /** Shift pressionado → seleção aditiva (multi-select). */
      shift?: boolean;
    }
  | {
      type: 'pointerMove';
      world: Vec3;
      screen: { x: number; y: number };
      pointerId: number;
      /** Velocidade do ponteiro em px/s (calculada no adapter) — p/ flick. */
      speed?: number;
    }
  | { type: 'pointerUp'; world: Vec3; screen: { x: number; y: number }; pointerId: number }
  /** Hover do mouse sobre a cena (sem arrastar) — p/ halo e dwell. */
  | { type: 'hover'; world: Vec3; screen: { x: number; y: number } }
  | { type: 'tap'; world: Vec3; pointerId: number }
  | { type: 'doubleTap'; world: Vec3; pointerId: number }
  | { type: 'longPress'; world: Vec3; pointerId: number }
  /**
   * Zoom da câmera; com `world`/`screen` informados, scroll sobre pilha navega
   * a pilha. `pinch` (2 dedos) sobre pilha → fan out (gesto do original).
   */
  | { type: 'zoom'; delta: number; world?: Vec3; screen?: { x: number; y: number }; pinch?: boolean }
  | { type: 'pan'; dx: number; dy: number }
  /** Órbita da câmera (arrastar botão direito; 2 dedos no mobile). */
  | { type: 'orbit'; dAzimuth: number; dElevation: number }
  /** Scrunch (3 dedos no chão): junta os objetos próximos numa pilha. */
  | { type: 'scrunch'; world: Vec3; screen: { x: number; y: number } }
  | { type: 'context'; world: Vec3; screen: { x: number; y: number } }
  | { type: 'cancel'; pointerId: number };

export interface IInput {
  attach(target: HTMLElement): void;
  setListener(cb: (action: InputAction) => void): void;
  detach(): void;
}

// ---------------------------------------------------------------------------
// Overlay (DOM)
// ---------------------------------------------------------------------------

export interface IOverlay {
  /** Mostra um menu de contexto na posição de tela. */
  showContextMenu(screen: { x: number; y: number }, items: ContextMenuItem[]): void;
  hideContextMenu(): void;
  /** Label flutuante sobre um objeto (nome de arquivo). */
  setLabel(
    id: string,
    text: string | null,
    screen: { x: number; y: number } | null,
    opts?: { note?: boolean },
  ): void;
  toast(message: string): void;

  /**
   * Laço de seleção (retângulo ou traço livre — P1) em coordenadas de tela, ou null p/ esconder.
   * Chamado pelo World durante a seleção por laço.
   */
  setLasso(lasso: LassoData | null): void;

  /**
   * Handle de redimensionamento da seleção em coordenadas de tela
   * (canto do bbox); null esconde (A — resize por arraste).
   */
  setResizeHandle(screen: { x: number; y: number } | null): void;
  /** Registra o callback de `pointerdown` no handle de resize. */
  onResizeStart(cb: (e: PointerEvent) => void): void;

  /**
   * Abre um editor inline de nota adesiva (textarea sobre a cena).
   * Resolve com o texto final (vazio = cancelar/excluir).
   */
  editNote(
    screen: { x: number; y: number },
    initial: string,
    placeholder?: string,
  ): Promise<string>;

  /**
   * Modal de pré-visualização in-app (item 3): imagem, PDF ou texto.
   * O overlay revoga `url` ao fechar; `text` renderiza em <pre>.
   */
  showPreview(spec: { name: string; mime: string; url?: string; text?: string }): void;

  /** Anel de widgets flutuante ao redor da pilha (Pile Widget Halo). null esconde. */
  setPileHalo(halo: PileHaloData | null): void;
  /** Registra o callback de clique em ação do halo de pilha. */
  onPileHaloAction(cb: (pileId: string, action: string) => void): void;
  /** Indica se o ponteiro está sobre o elemento do halo no overlay. */
  isHaloHovered?(): boolean;

  /** Anel de dwell (P1 — Dwell & Scrub): anel verde preenchendo no hover da pilha. */
  setDwellRing(data: DwellRingData | null): void;
  /** Faixa de miniaturas de scrub (P1 — Scrub Strip): chips para folhear itens da pilha. */
  setScrubStrip(data: ScrubStripData | null): void;
  /** Callback ao selecionar/clicar em um item da faixa de scrub. */
  onScrubItemSelect(cb: (pileId: string, itemId: string) => void): void;
  /** Callback ao passar o cursor sobre um item da faixa de scrub (scrubbing). */
  onScrubHover?(cb: (pileId: string, index: number) => void): void;
  /** Indica se o cursor está sobre a faixa de scrub ou o anel de dwell. */
  isScrubHovered?(): boolean;
}

export interface DwellRingData {
  pileId: string;
  screen: { x: number; y: number };
  /** Progresso de 0 a 1 (1 = dwell completo) */
  progress: number;
  /** True quando o dwell atingiu 100% e o scrub está ativo */
  active: boolean;
}

export interface ScrubItemData {
  id: string;
  label: string;
  icon?: string;
  thumb?: string;
  color?: string;
}

export interface ScrubStripData {
  pileId: string;
  screen: { x: number; y: number };
  items: ScrubItemData[];
  activeIndex: number;
}

export interface PileHaloData {
  pileId: string;
  screen: { x: number; y: number };
  layout: PileLayout;
  messy: boolean;
  itemCount: number;
}

export interface LassoData {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Pontos do laço livre desenhados pelo usuário (P1 — Laço Livre) */
  points?: Array<{ x: number; y: number }>;
  /** Origem do traço: centro do disco azul (Lasso'n'Cross / LassoMenu). */
  start?: { x: number; y: number };
  /** Raio do disco azul; 0 enquanto o traço não saiu da origem. */
  startRadius?: number;
  /** Laço fechado (voltou ao disco): seleção congelada. */
  closed?: boolean;
  /** Alvo "cruze para empilhar" no centro da seleção (≥ 2 itens). */
  crossTarget?: { x: number; y: number } | null;
}

export interface ContextMenuItem {
  label: string;
  action: string;
  danger?: boolean;
  /** Dica curta exibida como tooltip preto ao passar o mouse (P0). */
  hint?: string;
}
