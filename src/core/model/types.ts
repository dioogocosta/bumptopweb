/**
 * Tipos de domínio do BumpTop — PUROS (sem DOM/WebGL/SQL).
 * Espelham o bitmask de `ObjectType` do original (`BT_Actor.h`) e o modelo
 * `VisualPhysicsActor` do port Mac: um objeto tem pose (física) + representação
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
// Bitmasks — replica a tipagem por bitmask do original
// ---------------------------------------------------------------------------

/** Tipo primário (mutuamente exclusivo no original via bits altos). */
export const enum ObjectKind {
  None = 0,
  Actor = 1 << 0,
  Pile = 1 << 1,
  Widget = 1 << 2,
  Cluster = 1 << 3,
}

/** Atributos secundários (o original combina vários). */
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
 * Dados serializáveis de um objeto. É o que vai para o repositório (SQLite).
 * O `meta` é extensível — espelha o `PbBumpObject` extensível do `.proto`.
 */
export interface BumpObjectData {
  id: string;
  kind: ObjectKind;
  typeFlags: TypeFlags;
  /** Posição dentro de uma pilha (null = item livre da cena). */
  parentId: string | null;
  pose: Pose;
  /** Velocidade linear (guardada p/ toss e integração). */
  velocity: Vec3;
  scale: number;
  /** Parede em que está pregado (0..3) ou null. Espelha PinWall. */
  pinnedWall: number | null;
  frozen: boolean;
  label: string | null;
  /** Extensível — dimensões da caixa em unidades de mundo. */
  meta: {
    /** Meia-extensão (half-extents) da caixa física/render. */
    halfExtents?: Vec3;
    /** Cor/hue p/ placeholder até termos thumbnails reais. */
    color?: string;
    [key: string]: unknown;
  };
}

/** Snapshot completo da cena — o que é persistido. */
export interface SceneSnapshot {
  schemaVersion: number;
  objects: BumpObjectData[];
  /** Estado da câmera (do `PbCamera`). */
  camera: CameraState;
  /** Pose de cada pilha é derivada dos filhos; aqui guardamos layout. */
  piles: Record<string, { layout: PileLayout; page: number }>;
}

export interface CameraState {
  /** Posição alvo (pivot) da câmera. */
  target: Vec3;
  /** Distância da câmera ao pivot. */
  distance: number;
  /** Azimuth (yaw) em radianos. */
  azimuth: number;
  /** Elevation (pitch) em radianos. */
  elevation: number;
  fov: number;
}

/** Configuração de física do mundo — constantes *ground-truth* do original. */
export interface PhysicsConfig {
  /** Gravidade Y (original: 10 × -9.81 = -98.1). */
  gravityY: number;
  friction: number;
  restitution: number;
  /**
   * Limiar de toss: se |v|² ≥ threshold, o item é arremessado.
   * Espelha `GlobalSettings::MinStartTossVelocitySq`.
   */
  minStartTossVelocitySq: number;
  /** Fim do toss. Original: `EndTossVelocitySq = 100` (BT_Settings.cpp:52). */
  endTossVelocitySq: number;
  /**
   * Nível de física. 1 = interação visual (itens atravessam uns aos outros,
   * só piso/paredes colidem — como o BumpTop comercial). 2 = física real
   * (caixas colidem, empurram e empilham entre si — como o protótipo do vídeo).
   */
  level: PhysicsLevel;
}

export type PhysicsLevel = 1 | 2;

export const DEFAULT_PHYSICS: PhysicsConfig = {
  gravityY: -98.1, // 10× -9.81 (mundo "rápido" do original)
  friction: 0.55, // "steel on steel" (BT_Util InitNovodex)
  restitution: 0.1,
  minStartTossVelocitySq: 10000, // MinStartTossVelocitySq (BT_Settings.cpp:53)
  endTossVelocitySq: 100, // EndTossVelocitySq (BT_Settings.cpp:52)
  level: 2,
};

/** Dimensões da sala — do `CreateWalls` (BT_Util.cpp). */
export interface RoomConfig {
  /** Meia-distância do piso (original: ±150). */
  halfSize: number;
  /** Altura das paredes. */
  wallHeight: number;
  wallThickness: number;
}

export const DEFAULT_ROOM: RoomConfig = {
  halfSize: 130,
  wallHeight: 55,
  wallThickness: 10,
};
