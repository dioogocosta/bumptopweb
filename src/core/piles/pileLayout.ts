/**
 * Layouts de pilha (Stack + Grid) — matemática pura.
 *
 * Espelha `BT_Pile.cpp`:
 *  - **Stack**: altura linear até `maxLinearPileHeight` (5) itens; acima disso,
 *    altura logarítmica `pow(log(1+extra), 2.4)` distribuída igualmente
 *    (`getLogHeightSteps`, l.462-482). Evita pilhas infinitamente altas.
 *  - **Grid**: 4×4 paginado (`PILE_GRID_ROWSIZE/COLSIZE`, BT_Pile.h:32-33);
 *    acima de 16 itens, paginas com indicador.
 *
 * Constantes ground-truth: BT_Settings.cpp:51 (`maxLinearPileHeight=5`).
 */
import type { Vec3 } from '../model/types';

export const MAX_LINEAR_PILE_HEIGHT = 5; // BT_Settings.cpp:51
export const GRID_ROWS = 4; // PILE_GRID_ROWSIZE (BT_Pile.h:32)
export const GRID_COLS = 4; // PILE_GRID_COLSIZE (BT_Pile.h:33)
export const GRID_PAGE_SIZE = GRID_ROWS * GRID_COLS; // 16

/**
 * Passo de altura do stack para `count` itens de meia-altura `halfZ`
 * (dims.z no original = espessura do ícone deitado).
 *
 * fórmula original:
 *   extra = max(0, count - maxLinear)
 *   alturaTotal = pow(log(1+extra), 2.4) + Σ_{i<maxLinear} 2*dims.z[i]
 *   step = alturaTotal / count
 */
export function stackHeightStep(count: number, halfZ = 0.6): number {
  if (count <= 1) return 0;
  const thickness = 2 * halfZ;
  if (count <= MAX_LINEAR_PILE_HEIGHT) return thickness;

  const extra = count - MAX_LINEAR_PILE_HEIGHT;
  const logHeight = Math.pow(Math.log(1 + extra), 2.4);
  const linearHeight = MAX_LINEAR_PILE_HEIGHT * thickness;
  return (logHeight + linearHeight) / count;
}

/**
 * Posições de uma pilha em Stack: item i fica em `baseY + step*i`.
 * Retorna offsets relativos ao centroide da pilha.
 */
export function stackOffsets(count: number, halfZ = 0.6, messy = true): Vec3[] {
  const step = stackHeightStep(count, halfZ);
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    if (!messy) {
      out.push({ x: 0, y: step * i, z: 0 });
    } else {
      // Efeito papel BumpTop original: jitter determinístico para as bordas das fichas empilhadas ficarem visíveis
      const j = (i % 3) - 1; // -1, 0, 1
      out.push({ x: j * 0.6, y: step * i, z: ((i % 2) * 2 - 1) * 0.5 });
    }
  }
  return out;
}

/** Offset do item `index` dentro de um grid `page` (4×4), centrado no pivot. */
export function gridOffset(
  index: number,
  cell = 20,
): Vec3 {
  const col = index % GRID_COLS;
  const row = Math.floor(index / GRID_COLS) % GRID_ROWS;
  return {
    x: (col - (GRID_COLS - 1) / 2) * cell,
    y: 0,
    z: (row - (GRID_ROWS - 1) / 2) * cell,
  };
}

/** Total de páginas de um grid. */
export function gridPageCount(itemCount: number): number {
  return Math.max(1, Math.ceil(itemCount / GRID_PAGE_SIZE));
}

/** Itens visíveis de uma página. */
export function gridPageItems(itemCount: number, page: number): { start: number; end: number } {
  const start = Math.min(page * GRID_PAGE_SIZE, Math.max(0, itemCount));
  return { start, end: Math.min(start + GRID_PAGE_SIZE, itemCount) };
}
