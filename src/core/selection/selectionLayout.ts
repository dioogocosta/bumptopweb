/**
 * Layouts de SELEÇÃO (Grade / Linha) e comparadores — PURO.
 *
 * Serve o P0 da análise de vídeos (`RELATORIO_ANALISE_VIDEOS.md` §6):
 *  - **Grid View** da seleção (laço/shift): espalha os itens numa grade 2D;
 *  - **Sort by Size / Sort by Type**: ordena e alinha numa linha visível.
 *
 * A matemática é a mesma ideia do `pileLayout.ts` (grade centrada no pivô),
 * mas aplicada a um conjunto livre de itens da cena (não a uma pilha).
 */
import type { Vec3 } from '../model/types';
import { TypeFlags } from '../model/types';

/**
 * Offsets de uma grade centrada no pivô, preenchida linha-a-linha.
 * `cols = ceil(√count)` — o mais compacto possível para o nº de itens.
 */
export function selectionGridOffsets(count: number, cell = 20): Vec3[] {
  if (count <= 0) return [];
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / cols);
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.push({
      x: (col - (cols - 1) / 2) * cell,
      y: 0,
      z: (row - (rows - 1) / 2) * cell,
    });
  }
  return out;
}

/** Offsets de uma linha horizontal centrada no pivô (ordem visível e→d). */
export function rowOffsets(count: number, spacing = 20): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: (i - (count - 1) / 2) * spacing, y: 0, z: 0 });
  }
  return out;
}

/** Chave de ordenação da seleção (P0). */
export type SortKey = 'size' | 'type';

/** O que o comparador precisa saber de cada item (desacoplado do World). */
export interface ItemForSort {
  halfExtents: Vec3 | undefined;
  scale: number;
  label: string | null;
  typeFlags: number;
}

/**
 * Volume relativo do item (meia-extensão × escala³) — p/ "Sort by Size".
 * `scale` inválido (0/NaN/−) é tratado como 1.
 */
export function volumeOf(halfExtents: Vec3 | undefined, scale: number): number {
  const h = halfExtents ?? { x: 7, y: 0.35, z: 7 };
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return h.x * h.y * h.z * s * s * s;
}

/** Ordena por tamanho (crescente: menor → maior). */
export function compareBySize(a: ItemForSort, b: ItemForSort): number {
  return volumeOf(a.halfExtents, a.scale) - volumeOf(b.halfExtents, b.scale);
}

/**
 * Chave de tipo p/ agrupamento: pasta (0) < nota (1) < arquivo (2:extensão).
 * Prefixos numéricos garantem a ordem desejada no sort.
 */
export function typeKey(label: string | null, typeFlags: number): string {
  if ((typeFlags & TypeFlags.Folder) !== 0) return '0:pasta';
  if ((typeFlags & TypeFlags.StickyNote) !== 0) return '1:nota';
  const ext = (label ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return `2:${ext ?? 'sem-ext'}`;
}

/** Ordena por tipo/extensão (estável entre iguais). */
export function compareByType(a: ItemForSort, b: ItemForSort): number {
  const ka = typeKey(a.label, a.typeFlags);
  const kb = typeKey(b.label, b.typeFlags);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
