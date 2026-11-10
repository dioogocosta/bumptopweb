/**
 * PileManager — estado e layout das pilhas (puro).
 *
 * Espelha `Pile` (BT_Pile.cpp): uma pilha tem itens ordenados e um layout
 * (Stack = altura log, Grid = 4×4 paginado). A pilha NÃO é um corpo físico —
 * é a soma dos filhos, cada um posicionado pelo layout (no original os filhos
 * de pilha são gerenciados juntos; aqui congelamos seus corpos nas posições).
 *
 * Puro: recebe entradas (ids, dimensões), devolve poses. Sem DOM/física.
 */
import type { Vec3 } from '../model/types';
import { PileLayout } from '../model/types';
import { gridOffset, gridPageCount, stackOffsets } from './pileLayout';

export interface PileState {
  /** Itens ordenados (base → topo no Stack; ordem de leitura no Grid). */
  children: string[];
  layout: PileLayout;
  /** Página atual (Grid paginado). */
  page: number;
  /** Posição-base da pilha no mundo (piso). */
  origin: Vec3;
  /** Meia-espessura dos itens (p/ cálculo de altura). */
  halfZ: number;
  /** Desarranjado (messy) vs alinhado (tidy) no Stack. Padrão true. */
  messy?: boolean;
}

export interface PileLayoutResult {
  /** id → posição mundial calculada. */
  positions: Record<string, Vec3>;
  pageCount: number;
  page: number;
}

export class PileManager {
  private piles = new Map<string, PileState>(); // key = objectId da base

  /** Cria uma pilha com base + sobreposto. */
  create(baseId: string, firstChildId: string, origin: Vec3, halfZ = 0.35, messy = true): void {
    this.piles.set(baseId, {
      children: [baseId, firstChildId],
      layout: PileLayout.Stack,
      page: 0,
      origin: { ...origin },
      halfZ,
      messy,
    });
  }

  /** Adiciona um item no topo de uma pilha existente (ou cria na base). */
  add(baseOrChildId: string, childId: string, origin: Vec3, halfZ = 0.35): boolean {
    const key = this.findKey(baseOrChildId);
    if (key === null) {
      this.create(baseOrChildId, childId, origin, halfZ);
      return true;
    }
    const p = this.piles.get(key)!;
    if (p.children.includes(childId) || childId === key) return false;
    p.children.push(childId);
    return true;
  }

  /** Remove um item de qualquer pilha; pilha com <2 itens é dissolvida. */
  remove(childId: string): { dissolved: boolean; baseId: string | null } {
    for (const [key, p] of this.piles) {
      const idx = p.children.indexOf(childId);
      if (idx === -1) continue;
      p.children.splice(idx, 1);
      if (childId === key || p.children.length < 2) {
        this.piles.delete(key);
        return { dissolved: true, baseId: key };
      }
      return { dissolved: false, baseId: key };
    }
    return { dissolved: false, baseId: null };
  }

  /** A pilha contém este id (seja base ou filho)? */
  contains(objectId: string): boolean {
    return this.findKey(objectId) !== null;
  }

  /** Chave (base) da pilha que contém o id. */
  baseOf(objectId: string): string | null {
    return this.findKey(objectId);
  }

  /**
   * Move a pilha inteira para uma nova origem (arraste em grupo — item 5).
   * Os membros são re-posicionados pelo próximo `applyPileLayout`.
   */
  setOrigin(baseId: string, origin: Vec3): void {
    const p = this.piles.get(baseId);
    if (!p) return;
    p.origin = { ...origin };
  }

  getState(baseId: string): PileState | null {
    return this.piles.get(baseId) ?? null;
  }

  allStates(): Array<[string, PileState]> {
    return [...this.piles.entries()];
  }

  setLayout(baseId: string, layout: PileLayout): void {
    const p = this.piles.get(baseId);
    if (!p) return;
    p.layout = layout;
    p.page = 0;
  }

  /** Próxima página (Grid). Retorna true se mudou. */
  nextPage(baseId: string): boolean {
    const p = this.piles.get(baseId);
    if (!p || p.layout !== PileLayout.Grid) return false;
    const pages = gridPageCount(p.children.length);
    const next = (p.page + 1) % pages;
    if (next === p.page) return false;
    p.page = next;
    return true;
  }

  /** Página anterior (Grid). Retorna true se mudou. */
  prevPage(baseId: string): boolean {
    const p = this.piles.get(baseId);
    if (!p || p.layout !== PileLayout.Grid) return false;
    const pages = gridPageCount(p.children.length);
    const prev = (p.page - 1 + pages) % pages;
    if (prev === p.page) return false;
    p.page = prev;
    return true;
  }

  /**
   * "Peel" (Fase 7): gira os itens de uma pilha em Stack — o topo vai para
   * trás (dir=1) ou o de trás vem para o topo (dir=-1), revelando o próximo.
   * Retorna true se mudou.
   */
  peel(baseId: string, dir: 1 | -1): boolean {
    const p = this.piles.get(baseId);
    if (!p || p.layout !== PileLayout.Stack || p.children.length < 3) return false;
    if (dir === 1) {
      const top = p.children.pop()!;
      p.children.splice(1, 0, top); // topo → logo acima da base
    } else {
      const under = p.children.splice(1, 1)[0]; // item acima da base → topo
      p.children.push(under);
    }
    return true;
  }

  /** Alterna entre pilha arrumada (tidy) e desarranjada (messy). Retorna true se mudou. */
  toggleMessy(baseId: string): boolean {
    const key = this.findKey(baseId);
    if (!key) return false;
    const p = this.piles.get(key);
    if (!p) return false;
    p.messy = p.messy === false ? true : false;
    return true;
  }

  /** Posição de um item dentro da pilha (relativa ao mundo). */
  positionOf(objectId: string): Vec3 | null {
    const key = this.findKey(objectId);
    if (key === null) return null;
    const p = this.piles.get(key)!;
    const idx = p.children.indexOf(objectId);
    if (idx === -1) return null;

    if (p.layout === PileLayout.Stack) {
      const offsets = stackOffsets(p.children.length, p.halfZ, p.messy !== false);
      const off = offsets[idx] ?? { x: 0, y: 0, z: 0 };
      return { x: p.origin.x + off.x, y: p.origin.y + off.y, z: p.origin.z + off.z };
    }

    // Leaf/Fanout: itens espalhados em leque radial ao redor da base
    if (p.layout === PileLayout.Leaf) {
      const off = this.leafOffset(idx, p.children.length, p.halfZ);
      return { x: p.origin.x + off.x, y: p.origin.y, z: p.origin.z + off.z };
    }

    // Grid: só os itens da página atual são exibidos fora da pilha base
    const pageStart = p.page * 16;
    const local = idx - pageStart;
    if (local < 0 || local >= 16) return null; // fora da página → oculto
    const off = gridOffset(local, 20);
    return { x: p.origin.x + off.x, y: p.origin.y, z: p.origin.z + off.z };
  }

  /** Recalcula todas as posições (p/ aplicar no World). */
  layoutAll(): PileLayoutResult[] {
    const out: PileLayoutResult[] = [];
    for (const [key, p] of this.piles) {
      const positions: Record<string, Vec3> = {};
      for (const child of p.children) {
        const pos = this.positionOf(child);
        if (pos) positions[child] = pos;
      }
      out.push({
        positions,
        pageCount: p.layout === PileLayout.Grid ? gridPageCount(p.children.length) : 1,
        page: p.page,
      });
      void key;
    }
    return out;
  }

  /** Serializa p/ SceneSnapshot.piles. */
  serialize(): Record<string, { layout: PileLayout; page: number }> {
    const out: Record<string, { layout: PileLayout; page: number }> = {};
    for (const [key, p] of this.piles) out[key] = { layout: p.layout, page: p.page };
    return out;
  }

  /** Offset radial do item `index` no layout Leaf (leque ao redor da base). */
  private leafOffset(index: number, count: number, halfZ: number): Vec3 {
    if (count <= 1) return { x: 0, y: 0, z: 0 };
    // Distribui ao longo de um arco de 270° virado p/ a câmera (−z)
    const arc = (Math.PI * 2 * 0.75);
    const start = -Math.PI - arc / 2;
    const angle = start + (arc * index) / (count - 1);
    const radius = 20 + 2 * halfZ + count * 0.5;
    return { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius };
  }

  private findKey(objectId: string): string | null {
    for (const [key, p] of this.piles) {
      if (key === objectId || p.children.includes(objectId)) return key;
    }
    return null;
  }
}
