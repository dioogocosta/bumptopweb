/**
 * Tipos de domÃ­nio do BumpTop â€” PUROS (sem DOM/WebGL/SQL).
 * Espelham o bitmask de `ObjectType` do original (`BT_Actor.h`) e o modelo
 * `VisualPhysicsActor` do port Mac: um objeto tem pose (fÃ­sica) + representaÃ§Ã£o
 * (render), desacopladas.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Pose completa de um objeto no mundo. */
export interface Pose {
  position: Vec3;
  rotation: Quat;
}

// ---------------------------------------------------------------------------
// Bitmasks â€” replica a tipagem por bitmask do original
// ---------------------------------------------------------------------------

/** Tipo primÃ¡rio (mutuamente exclusivo no original via bits altos). */
export const enum ObjectKind {
  None = 0,
  Actor = 1 << 0,
  Pile = 1 << 1,
  Widget = 1 << 2,
  Cluster = 1 << 3,
}

/** Atributos secundÃ¡rios (o original combina vÃ¡rios). */
export const enum TypeFlags {
  None = 0,
  FileSystem = 1 << 0,
  Logical = 1 << 1,
  Invisible = 1 << 2,
  Webpage = 1 << 3,
  Folder = 1 << 4,
  File = 1 << 5,
  Image = 1 << 6,
  StickyNote = 1 << 7,
  PhotoFrame = 1 << 8,
  TossTarget = 1 << 9,
}

// ---------------------------------------------------------------------------
// Modelo de objeto
// ---------------------------------------------------------------------------

/** Estado de layout de uma pilha (de `Pile::LayoutState`). */
export const enum PileLayout {
  Stack = 0,
  Grid = 1,
  Leaf = 2,
  LayingOut = 3,
}

/**
 * Dados serializÃ¡veis de um objeto. Ã‰ o que vai para o repositÃ³rio (SQLite).
 * O `meta` Ã© extensÃ­vel â€” espelha o `PbBumpObject` extensÃ­vel do `.proto`.
 */
export interface BumpObjectData {
  id: string;
  kind: ObjectKind;
  typeFlags: TypeFlags;
  /** PosiÃ§Ã£o dentro de uma pilha (null = item livre da cena). */
  parentId: string | null;
  pose: Pose;
  /** Velocidade linear (guardada p/ toss e integraÃ§Ã£o). */
  velocity: Vec3;
  scale: number;
  /** Parede em que estÃ¡ pregado (0..3) ou null. Espelha PinWall. */
  pinnedWall: number | null;
  frozen: boolean;
  label: string | null;
  /** ExtensÃ­vel â€” dimensÃµes da caixa em unidades de mundo. */
  meta: {
    /** Meia-extensÃ£o (half-extents) da caixa fÃ­sica/render. */
    halfExtents?: Vec3;
    /** Cor/hue p/ placeholder atÃ© termos thumbnails reais. */
    color?: string;
    [key: string]: unknown;
  };
}

/** Snapshot completo da cena â€” o que Ã© persistido. */
export interface SceneSnapshot {
  schemaVersion: number;
  objects: BumpObjectData[];
  /** Estado da cÃ¢mera (do `PbCamera`). */
  camera: CameraState;
  /** Pose de cada pilha Ã© derivada dos filhos; aqui guardamos layout. */
  piles: Record<string, { layout: PileLayout; page: number }>;
  /**
   * PR4a (Control Manager) â€” as CAIXAS do mundo (espaÃ§o com chÃ£o + 4 paredes
   * onde pastas/arquivos/notas acontecem). Opcional p/ compatibilidade:
   * snapshot sem `boxes` = mundo antigo â†’ vira 1 caixa padrÃ£o no centro.
   */
  boxes?: BoxEntityData[];
  /** PR4a â€” caixa ativa (onde novas pastas/notas nascem). Opcional (mundo antigo). */
  currentBoxId?: string;
}

export interface CameraState {
  /** PosiÃ§Ã£o alvo (pivot) da cÃ¢mera. */
  target: Vec3;
  /** DistÃ¢ncia da cÃ¢mera ao pivot. */
  distance: number;
  /** Azimuth (yaw) em radianos. */
  azimuth: number;
  /** Elevation (pitch) em radianos. */
  elevation: number;
  fov: number;
}

/** ConfiguraÃ§Ã£o de fÃ­sica do mundo â€” constantes *ground-truth* do original. */
export interface PhysicsConfig {
  /** Gravidade Y (original: 10 Ã— -9.81 = -98.1). */
  gravityY: number;
  friction: number;
  restitution: number;
  /**
   * Limiar de toss: se |v|Â² â‰¥ threshold, o item Ã© arremessado.
   * Espelha `GlobalSettings::MinStartTossVelocitySq`.
   */
  minStartTossVelocitySq: number;
  /** Fim do toss. Original: `EndTossVelocitySq = 100` (BT_Settings.cpp:52). */
  endTossVelocitySq: number;
  /**
   * NÃ­vel de fÃ­sica. 1 = interaÃ§Ã£o visual (itens atravessam uns aos outros,
   * sÃ³ piso/paredes colidem â€” como o BumpTop comercial). 2 = fÃ­sica real
   * (caixas colidem, empurram e empilham entre si â€” como o protÃ³tipo do vÃ­deo).
   */
  level: PhysicsLevel;
}

export type PhysicsLevel = 1 | 2;

export const DEFAULT_PHYSICS: PhysicsConfig = {
  gravityY: -98.1, // 10Ã— -9.81 (mundo "rÃ¡pido" do original)
  friction: 0.55, // "steel on steel" (BT_Util InitNovodex)
  restitution: 0.1,
  minStartTossVelocitySq: 10000, // MinStartTossVelocitySq (BT_Settings.cpp:53)
  endTossVelocitySq: 100, // EndTossVelocitySq (BT_Settings.cpp:52)
  level: 2,
};

/** DimensÃµes da sala â€” do `CreateWalls` (BT_Util.cpp). */
export interface RoomConfig {
  /** Meia-distÃ¢ncia do piso (original: Â±150). */
  halfSize: number;
  /** Altura das paredes. */
  wallHeight: number;
  wallThickness: number;
  /**
   * PR4a â€” centro da caixa no mundo (vÃ¡rios boxes lado a lado no mesmo
   * mundo 3D). Ausente = {0,0} (caixa original no centro).
   */
  origin?: { x: number; z: number };
}

export const DEFAULT_ROOM: RoomConfig = {
  halfSize: 130,
  wallHeight: 55,
  wallThickness: 10,
};

/** PR4a â€” tipos de caixa. 'root'/'kanban' no PR 4.3; 'backlog' no PR 4.5; 'sprint' no PR 4.6. */
export type BoxType = 'comum' | 'root' | 'kanban' | 'backlog' | 'sprint';

/**
 * PR4.6 â€” configuraÃ§Ã£o de uma raia Kanban (nome, cor, mapeamento de status do Taiga).
 */
export interface KanbanLane {
  /** Label exibido no topo da raia. */
  label: string;
  /** Cor hex da raia (bordas + header). */
  color: string;
  /** Status do Taiga que sÃ£o mapeados para esta raia (nomes normalizados em lowercase). */
  statusNames: string[];
}

/**
 * PR4a â€” uma CAIXA do Control Manager: o espaÃ§o (chÃ£o + 4 paredes) onde
 * tudo acontece. Pastas/arquivos/notas ficam DENTRO dela (`meta.boxId`).
 */
export interface BoxEntityData {
  id: string;
  name: string;
  type: BoxType;
  /** Centro da caixa no chÃ£o do mundo. */
  pos: { x: number; z: number };
  halfSize: number;
  wallHeight: number;
  wallThickness: number;
  /** PR4.5 â€” slug do projeto Taiga (sÃ³ em caixas 'backlog'). */
  taigaProject?: string;
  /** PR4.5 â€” contagens por status do Taiga (preenchidas no sync, p/ o dashboard). */
  taigaStats?: Array<{ name: string; color: string; count: number }>;
  /** PR4.6 â€” id da sprint do Taiga (sÃ³ em caixas 'sprint'). */
  taigaSprintId?: number;
  /** PR4.6 â€” nome da sprint (preenchido no sync). */
  taigaSprintName?: string;
  /** PR4.6 â€” raias Kanban configuradas para esta caixa (sprint ou kanban). */
  kanbanLanes?: KanbanLane[];
  /** PR4.15 - favorito do usuario (p/ filtro no painel de andares). */
  isFavorite?: boolean;
}

/** PR4.5 â€” user story do Taiga (sÃ³ leitura; chega do adapter `src/taiga/`). */
export interface TaigaStory {
  id: number;
  ref: number;
  subject: string;
  statusName: string;
  statusColor: string;
  isClosed: boolean;
}

